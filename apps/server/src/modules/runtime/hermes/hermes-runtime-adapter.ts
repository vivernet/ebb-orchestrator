/**
 * Hermes runtime adapter - implements AgentRuntime интерфейс.
 */

import type { AgentRuntime, AgentRuntimeRun } from "../agent-runtime.js";
import type { AgentRun, RunStatus } from "@ebb-orchestrator/contracts";
import type { RunOutcome } from "../run-types.js";
import { ProcessExecutor, ExitCodeError, type ProcessOptions, type ProcessResult } from "../../../platform/process/process-executor.js";
import { HermesCliBuilder } from "./hermes-cli.js";
import { generateConfigYaml } from "./hermes-profile.js";
import { parseSessionId } from "./hermes-session-parser.js";
import { HermesStreamSessionObserver } from "./hermes-stream-session-observer.js";
import type { HermesSessionCapture, HermesSessionCaptureFailure, HermesSessionCapturePort } from "../hermes-session-capture-port.js";
import {
  createHermesLaunchTicket,
  type HermesLaunchTicketFactory,
} from "./hermes-launch-ticket.js";
import {
  buildHermesSnapshotRuntimeArgs,
  resolveHermesExecutable,
  verifyHermesProfileHomeIdentity,
  verifyHermesProfileHomePathChain,
  verifyHermesRunProfileTargetIdentities,
} from "./hermes-executable-resolver.js";
import {
  ensureHermesSourceSnapshotNativeProjection,
  isVerifiedHermesSourceSnapshot,
  materializeHermesSourceSnapshot,
  releaseHermesSourceSnapshotReferenceLease,
} from "./hermes-source-snapshot.js";
import { HERMES_PROVIDER_SELECTION_SOURCE, readHermesProviderSelection } from "./hermes-provider-selection.js";
import {
  cleanupHermesRunProfileHome,
  createHermesRunProfileHomeWithReceipt,
  writeHermesRunProfileConfig,
  type HermesRunProfileConfigWriter,
} from "../../../platform/home/hermes-profile-home.js";
import {
  deriveHermesNativeAuthRouteEvidence,
  isHermesNativeAuthRouteEvidence,
  type HermesNativeAuthRouteEvidence,
  type HermesRunSelection,
  type HermesRunSelectionPreflight,
} from "./hermes-run-selection.js";
import { validateRoleOutput } from "../output-validator.js";
import * as path from "path";
import * as fs from "fs/promises";
import * as os from "os";
import { fileURLToPath } from "node:url";
import { createSqliteDatabase } from "../../../platform/database/sqlite-database.js";
import { loadValidatedCapability } from "../../execution/capability-validation.js";
import { validatePlatform, type Platform } from "../../../platform/config/app-config.js";
import { resolveOrchestratorHome, type HomeEnv } from "../../../platform/home/orchestrator-home.js";
import { ProcessScopeLaunchNotDispatchedError, type ProcessScopeLaunchRequest, type ProcessScopeSupervisor } from "../../../platform/process/run-scope-supervisor.js";
import type { ProcessScopeIdentity, ProcessScopeObservation } from "../../../platform/process/process-inspector.js";
import { getRunProcessOwner, isAuthoritativeRunProcessStopEvidence, prepareRunProcessOwner, transitionRunProcessOwnerTx, type RunProcessOwner, type RunProcessOwnerState } from "../run-process-owner.js";

/**
 * В памяти run state tracking.
 */
interface RunState {
  run: AgentRun;
  pid: number | null;
  sessionId: string | null;
  observedSessionId?: string | null;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  startTime: Date;
  abortController: AbortController | null;
  checkpointPath: string | null;
  submittedResult: string | null;
  resultPath: string;
  usage: RunUsage | null;
}

interface RunStartControl {
  abortController: AbortController;
  cancelled: boolean;
  stopProven: boolean;
  startPromise?: Promise<void>;
}

interface RunUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  cost: number;
}

interface VerifiedHermesNativeAuthEvidence {
  readonly authRoot: string;
  readonly profileHome: string;
  readonly runId: string;
  readonly sourceVersion: string;
  readonly sourceCommit: string;
  readonly sourceSnapshotKey: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly endpointIdentity: string;
  readonly endpointRevision: string;
  readonly projectionVersion: string;
  readonly authRouteEvidence: HermesNativeAuthRouteEvidence;
}

/**
 * Artifact хранилище интерфейс.
 */
interface ArtifactStore {
  saveArtifacts(runId: string, stdout: string, stderr: string, exitCode: number): void;
  getArtifacts(runId: string): { stdout: string; stderr: string; exitCode: number } | undefined;
}

/**
 * В памяти artifact store for testing.
 */
class InMemoryArtifactStore implements ArtifactStore {
  private artifacts: Record<string, { stdout: string; stderr: string; exitCode: number }> = {};

  saveArtifacts(runId: string, stdout: string, stderr: string, exitCode: number): void {
    this.artifacts[runId] = { stdout, stderr, exitCode };
  }

  getArtifacts(runId: string): { stdout: string; stderr: string; exitCode: number } | undefined {
    return this.artifacts[runId];
  }
}

/**
 * HermesRuntimeAdapter implements Объект AgentRuntime интерфейс для Объект Hermes CLI.
 */
export class HermesRuntimeAdapter implements AgentRuntime, HermesSessionCapturePort {
  active = 0;
  maxActive = 0;
  readonly calls: Array<{ phase: string; role: string; taskId?: string; targetBranch?: string }> = [];
  private readonly runs = new Map<string, RunState>();
  private readonly cliBuilder: HermesCliBuilder;
  private readonly executor: ProcessExecutor;
  private readonly artifactStore: ArtifactStore;
  private readonly timeoutMs: number;
  private readonly roleLimit: number;
  private readonly toolsets: string[];
  private readonly ignoreRules: boolean;
  private readonly managedWorktree: string | undefined;
  private readonly managedWorktreeForRun: ((run: AgentRun) => string) | undefined;
  private readonly environment: Record<string, string> | undefined;
  private readonly resultDirectory: string;
  private readonly checkpointDirectory: string;
  private readonly exitCodes = new Map<string, number>();
  private readonly databasePath: string | undefined;
  private readonly hermesSourceCacheRoot: string;
  private readonly mayCollectHermesSourceSnapshot: ((cacheKey: string) => Promise<boolean>) | undefined;
  private readonly hasHermesSourceSnapshotReferences: ((cacheKey: string) => Promise<boolean>) | undefined;
  private readonly hermesSourceReferenceLock: ((input: { cacheRoot: string; mode: "shared" | "exclusive" }) => Promise<import("./hermes-source-reference-lock.js").HermesSourceReferenceLease>) | undefined;
  private readonly mcpCommand: string;
  private readonly mcpArgs: string[];
  private readonly processScopeSupervisor: ProcessScopeSupervisor | undefined;
  private readonly hermesLaunchTicketFactory: HermesLaunchTicketFactory | undefined;
  private readonly hermesRunProfileConfigWriter: HermesRunProfileConfigWriter | undefined;
  private readonly verifiedNativeAuthSelections = new WeakMap<HermesRunSelection, VerifiedHermesNativeAuthEvidence>();
  private readonly activeScopes = new Map<string, { owner: ProcessScopeIdentity; durable: boolean; abortController: AbortController }>();
  private readonly startingRuns = new Map<string, RunStartControl>();
  private hermesSessionCaptureHandler: ((capture: HermesSessionCapture) => Promise<void>) | undefined;

  constructor(
    executor: ProcessExecutor,
    artifactStore?: ArtifactStore,
    config?: {
      timeoutMs?: number;
      roleLimit?: number;
      toolsets?: string[];
      ignoreRules?: boolean;
      managedWorktree?: string;
      managedWorktreeForRun?: (run: AgentRun) => string;
      environment?: Record<string, string>;
      homeEnvironment?: HomeEnv;
      platform?: Platform;
      resultDirectory?: string;
      checkpointDirectory?: string;
      databasePath?: string;
      hermesSourceSnapshotCacheRoot?: string;
      mayCollectHermesSourceSnapshot?: (cacheKey: string) => Promise<boolean>;
      hasHermesSourceSnapshotReferences?: (cacheKey: string) => Promise<boolean>;
      hermesSourceReferenceLock?: (input: { cacheRoot: string; mode: "shared" | "exclusive" }) => Promise<import("./hermes-source-reference-lock.js").HermesSourceReferenceLease>;
      mcpCommand?: string;
      mcpArgs?: string[];
      /** Test seam; production defaults to pinned Hermes resolver + native profile identity check. */
      hermesLaunchTicketFactory?: HermesLaunchTicketFactory;
      /** Test seam; production defaults to the handle-bound native profile config writer. */
      hermesRunProfileConfigWriter?: HermesRunProfileConfigWriter;
    },
    processScopeSupervisor?: ProcessScopeSupervisor,
  ) {
    this.executor = executor;
    this.artifactStore = artifactStore ?? new InMemoryArtifactStore();
    this.timeoutMs = config?.timeoutMs ?? 300000; // 5 minutes default
    this.roleLimit = config?.roleLimit ?? 20;
    this.toolsets = config?.toolsets ?? ["mcp-orchestrator"];
    this.ignoreRules = config?.ignoreRules ?? true;
    this.managedWorktree = config?.managedWorktree;
    this.managedWorktreeForRun = config?.managedWorktreeForRun;
    this.environment = config?.environment ? Object.freeze({ ...config.environment }) : undefined;
    this.resultDirectory = config?.resultDirectory ?? path.join(os.tmpdir(), "orchestrator-hermes-results");
    this.checkpointDirectory = config?.checkpointDirectory ?? (() => {
      const resolvedPlatform = config?.platform ?? validatePlatform(process.platform);
      const home = resolveOrchestratorHome(config?.homeEnvironment ?? process.env, resolvedPlatform);
      const join = resolvedPlatform === "win32" ? path.win32.join : path.posix.join;
      return join(home.runtime, "checkpoints");
    })();
    this.databasePath = config?.databasePath;
    const resolvedPlatform = config?.platform ?? validatePlatform(process.platform);
    const homePaths = resolveOrchestratorHome(config?.homeEnvironment ?? process.env, resolvedPlatform);
    const platformPaths = resolvedPlatform === "win32" ? path.win32 : path.posix;
    this.hermesSourceCacheRoot = config?.hermesSourceSnapshotCacheRoot ??
      platformPaths.join(homePaths.runtime, "hermes", "source-snapshots");
    this.mayCollectHermesSourceSnapshot = config?.mayCollectHermesSourceSnapshot;
    this.hasHermesSourceSnapshotReferences = config?.hasHermesSourceSnapshotReferences;
    this.hermesSourceReferenceLock = config?.hermesSourceReferenceLock;
    this.mcpCommand = config?.mcpCommand ?? "ebb-orchestrator-mcp";
    this.mcpArgs = config?.mcpArgs ?? [];
    this.processScopeSupervisor = processScopeSupervisor;
    this.hermesLaunchTicketFactory = config?.hermesLaunchTicketFactory;
    this.hermesRunProfileConfigWriter = config?.hermesRunProfileConfigWriter;
    this.cliBuilder = new HermesCliBuilder();
  }

  /**
   * запускать Объект новый run с Объект указанного options.
   */
  startRun(run: AgentRuntimeRun): Promise<void> {
    if (this.startingRuns.has(run.id)) throw new Error(`RUN_START_ALREADY_IN_PROGRESS:${run.id}`);
    const control: RunStartControl = { abortController: new AbortController(), cancelled: false, stopProven: false };
    this.startingRuns.set(run.id, control);
    const startPromise = this.startRunWithControl(run, control);
    control.startPromise = startPromise;
    const clearControl = () => {
      if (this.startingRuns.get(run.id) === control) this.startingRuns.delete(run.id);
    };
    void startPromise.then(clearControl, clearControl);
    return startPromise;
  }

  /**
   * Проверяет pinned Hermes installation и non-secret selection, затем создаёт ровно один
   * пустой Hermes-native profile под auth-owning root. Credential values не читаются и не копируются.
   *
   * @param runId UUID будущего Run, уже созданный Orchestrator до внешнего/SQLite side effect.
   * @returns Bounded provider/model identity и idempotent cleanup только для rollback до записи файлов.
   * @throws {Error} Если selection неявен, endpoint не имеет stable identity или native helper отказал.
   */
  async prepareHermesRunSelection(runId: string): Promise<HermesRunSelectionPreflight> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(runId)) {
      throw new Error("HERMES_RUN_SELECTION_BINDING_MISMATCH");
    }
    const platform = currentHermesPlatform();
    const resolution = await resolveHermesExecutable({ cwd: process.cwd() });
    if (resolution.executableIdentity.platform !== platform) throw new Error("HERMES_PLATFORM_IDENTITY_MISMATCH");
    const sourceSnapshot = await materializeHermesSourceSnapshot({
      gitExecutable: resolution.gitExecutable,
      sourceRoot: resolution.hermesProjectRoot,
      cacheRoot: this.hermesSourceCacheRoot,
      hermesVersion: resolution.sourceVersion,
      commit: resolution.sourceCommit,
      tree: resolution.sourceTree,
      retainReferenceLease: true,
      ...(this.hermesSourceReferenceLock
        ? { referenceLock: this.hermesSourceReferenceLock }
        : {}),
      ...(this.mayCollectHermesSourceSnapshot
        ? { mayCollectSnapshot: this.mayCollectHermesSourceSnapshot }
        : {}),
      ...(this.hasHermesSourceSnapshotReferences
        ? { hasSnapshotReferences: this.hasHermesSourceSnapshotReferences }
        : {}),
    });
    const paths = platform === "win32" ? path.win32 : path.posix;
    const helperPath = hermesProfilePathHelperPath(platform);
    const plannedProfileHome = paths.join(resolution.hermesConfigHome, "profiles", `ebb-orchestrator-run-${runId}`);
    let createdProfileOptions: { hermesRoot: string; runId: string; helperPath: string; platform: "win32" | "linux" } | undefined;
    let profileCreated = false;
    try {
    const projected = await readHermesProviderSelection({
      hermesConfigHome: resolution.hermesConfigHome,
      hermesRunProfileHome: plannedProfileHome,
      hermesProjectRoot: resolution.hermesProjectRoot,
      runId,
      runEnvironment: this.environment ?? {},
      helperPath,
      platform,
    });
    if (!projected.endpointIdentityEligible || !projected.endpointIdentity || !projected.endpointRevision) throw new Error("HERMES_ENDPOINT_ID_UNAVAILABLE");
    const helperOptions = { hermesRoot: resolution.hermesConfigHome, runId, helperPath, platform } as const;
    createdProfileOptions = helperOptions;
    let profileHome: string;
    let profileReceipt;
    try {
    profileReceipt = await createHermesRunProfileHomeWithReceipt(helperOptions);
    profileHome = profileReceipt.profileHome;
    profileCreated = true;
    } catch {
      throw new Error("HERMES_PROFILE_PATH_CREATE_FAILED");
    }
    const profileHomePathChain = await verifyHermesProfileHomePathChain(profileHome, resolution.hermesConfigHome);
    const authRouteEvidence = deriveHermesNativeAuthRouteEvidence({
      profileReceipt,
      providerSelection: projected,
      authRoot: resolution.hermesConfigHome,
      hermesProjectRoot: resolution.hermesProjectRoot,
      sourceVersion: resolution.sourceVersion,
      sourceCommit: resolution.sourceCommit,
      environment: this.environment ?? {},
      ...(profileHomePathChain ? { profileHomePathChain } : {}),
    });
    const selection: HermesRunSelection = Object.freeze({
      runId,
      providerId: projected.providerId,
      modelId: projected.modelId,
      endpointIdentity: projected.endpointIdentity,
      endpointRevision: projected.endpointRevision,
      sourceVersion: HERMES_PROVIDER_SELECTION_SOURCE.version,
      sourceCommit: HERMES_PROVIDER_SELECTION_SOURCE.commit,
      sourceSnapshotKey: sourceSnapshot.cacheKey,
      profileHome,
      ...(profileHomePathChain ? { profileHomePathChain } : {}),
      authRouteEvidence,
    });
    this.recordVerifiedHermesNativeAuthEvidence(selection, {
      authRoot: resolution.hermesConfigHome,
      profileHome,
      runId,
      sourceVersion: resolution.sourceVersion,
      sourceCommit: resolution.sourceCommit,
      sourceSnapshotKey: sourceSnapshot.cacheKey,
      providerId: projected.providerId,
      modelId: projected.modelId,
      endpointIdentity: projected.endpointIdentity,
      endpointRevision: projected.endpointRevision,
      projectionVersion: HERMES_PROVIDER_SELECTION_SOURCE.projectionVersion,
      authRouteEvidence,
    });
    let leaseReleased = false;
    const releaseReference = async () => {
      if (leaseReleased) return;
      leaseReleased = true;
      await releaseHermesSourceSnapshotReferenceLease(sourceSnapshot);
    };
    return {
      selection,
      commit: releaseReference,
      cleanup: async () => {
        await releaseReference();
        await cleanupHermesRunProfileHome(helperOptions);
      },
    };
    } catch (error) {
      if (profileCreated && createdProfileOptions) {
        try {
          await cleanupHermesRunProfileHome(createdProfileOptions);
        } catch {
          try {
            console.error("[ebb-orchestrator] HERMES_PROFILE_PATH_CLEANUP_FAILED");
          } catch {
            // Diagnostics must not replace the primary preflight failure.
          }
        }
      }
      try {
        await releaseHermesSourceSnapshotReferenceLease(sourceSnapshot);
      } catch {
        try {
          console.error("[ebb-orchestrator] HERMES_SOURCE_SNAPSHOT_LEASE_RELEASE_FAILED");
        } catch {
          // Diagnostics must not replace the primary preflight failure.
        }
      }
      throw error;
    }
  }

  /** Удаляет только точный Run profile после отзыва capability, terminal status и освобождения
   * Scheduler reservation/locks; непосредственно перед удалением повторно проверяет STOP
   * supervisor для durable owner и принимает только нативное OS evidence. */
  async cleanupTerminalHermesProfile(runId: string): Promise<void> {
    if (!this.databasePath || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(runId)) {
      throw new Error("HERMES_PROFILE_CLEANUP_BINDING_INVALID");
    }
    const database = createSqliteDatabase(this.databasePath);
    let hermesHome: string;
    let persistedOwner: RunProcessOwner;
    try {
      const run = database.get<{ status: string; capability_ref: string | null; task_id: string | null }>(
        "SELECT status,capability_ref,task_id FROM agent_runs WHERE id=$runId", { runId },
      );
      const owner = getRunProcessOwner(database, runId);
      if (!run || !["COMPLETED", "FAILED", "CANCELLED"].includes(run.status) || run.capability_ref !== null ||
          !owner || owner.state !== "STOPPED" ||
          !isAuthoritativeRunProcessStopEvidence(owner.stopEvidence, owner.containmentKind)) {
        throw new Error("HERMES_PROFILE_CLEANUP_GATE_NOT_SATISFIED");
      }
      const reservation = database.get<{ present: number }>(
        `SELECT 1 AS present FROM scheduler_reservations
          WHERE status='RESERVED' AND (run_id=$runId OR subject_id=$runId
            OR ($taskId IS NOT NULL AND kind='TASK' AND subject_id=$taskId)) LIMIT 1`, { runId, taskId: run.task_id },
      );
      const lock = database.get<{ present: number }>(
        `SELECT 1 AS present FROM scheduler_resource_locks lock_row
          JOIN scheduler_reservations reservation ON reservation.id=lock_row.reservation_id
          WHERE reservation.run_id=$runId OR reservation.subject_id=$runId
            OR ($taskId IS NOT NULL AND reservation.kind='TASK' AND reservation.subject_id=$taskId) LIMIT 1`,
        { runId, taskId: run.task_id },
      );
      if (reservation || lock) throw new Error("HERMES_PROFILE_CLEANUP_GATE_NOT_SATISFIED");
      hermesHome = owner.hermesHome;
      persistedOwner = owner;
    } finally {
      database.close();
    }
    const platform = currentHermesPlatform();
    const paths = platform === "win32" ? path.win32 : path.posix;
    const expectedLeaf = `ebb-orchestrator-run-${runId}`;
    const profilesDirectory = paths.dirname(hermesHome);
    const authRoot = paths.dirname(profilesDirectory);
    const exactProfile = paths.join(authRoot, "profiles", expectedLeaf);
    const samePath = platform === "win32"
      ? paths.normalize(hermesHome).toLowerCase() === paths.normalize(exactProfile).toLowerCase()
      : paths.normalize(hermesHome) === paths.normalize(exactProfile);
    if (!samePath || paths.basename(profilesDirectory).toLowerCase() !== "profiles") {
      throw new Error("HERMES_PROFILE_CLEANUP_BINDING_INVALID");
    }
    const supervisor = this.processScopeSupervisor;
    if (!supervisor) throw new Error("HERMES_PROFILE_CLEANUP_STOP_UNPROVEN");
    let freshStop: ProcessScopeObservation;
    try {
      freshStop = await supervisor.waitForStopped(ownerToScopeIdentity(persistedOwner), 30_000);
    } catch {
      throw new Error("HERMES_PROFILE_CLEANUP_STOP_UNPROVEN");
    }
    const hasFreshNativeStopEvidence = freshStop && typeof freshStop === "object" && freshStop.state === "STOPPED" &&
      (persistedOwner.containmentKind === "windows-job"
        ? freshStop.evidence === "WINDOWS_JOB_EMPTY" || freshStop.evidence === "WINDOWS_JOB_AND_HELPER_ABSENT"
        : freshStop.evidence === "SYSTEMD_CGROUP_EMPTY" || freshStop.evidence === "UNIT_ABSENT_NO_PENDING_CGROUP_ABSENT");
    if (!hasFreshNativeStopEvidence) {
      throw new Error("HERMES_PROFILE_CLEANUP_STOP_UNPROVEN");
    }
    await cleanupHermesRunProfileHome({
      hermesRoot: authRoot,
      runId,
      helperPath: hermesProfilePathHelperPath(platform),
      platform,
    });
  }

  /** Подключает awaited RunService sink для allowlisted live Hermes session evidence. */
  setHermesSessionCaptureHandler(handler: (capture: HermesSessionCapture) => Promise<void>): void {
    if (this.hermesSessionCaptureHandler && this.hermesSessionCaptureHandler !== handler) {
      throw new Error("HERMES_SESSION_CAPTURE_HANDLER_ALREADY_BOUND");
    }
    this.hermesSessionCaptureHandler = handler;
  }

  private async startRunWithControl(run: AgentRuntimeRun, control: RunStartControl): Promise<void> {
    const supervisor = this.processScopeSupervisor;
    if (!supervisor) throw new Error("PROCESS_SCOPE_SUPERVISOR_REQUIRED");
    const hermesSelection = run.hermesSelection;
    if (!hermesSelection || hermesSelection.runId !== run.id || hermesSelection.modelId !== run.model ||
        !hermesSelection.sourceSnapshotKey ||
        hermesSelection.sourceVersion !== HERMES_PROVIDER_SELECTION_SOURCE.version ||
        hermesSelection.sourceCommit !== HERMES_PROVIDER_SELECTION_SOURCE.commit) {
      throw new Error("HERMES_RUN_SELECTION_UNAVAILABLE");
    }
    if (this.finishCancelledBeforeLaunch(run.id, control)) return;
    let workspace = this.getManagedWorktree(run);
    // Экземпляр integration run can be authenticated before its worktree is created.
    // Wait только для callers который explicitly provide per-run workspaces; the
    // legacy/стандартный-путь remains сразу наблюдаемым для unit-test заглушек.
    if (this.managedWorktreeForRun) {
      workspace = await this.waitForWorkspace(run);
      if (this.finishCancelledBeforeLaunch(run.id, control)) return;
    }
    const defaultProfileHome = path.join(this.resultDirectory, "profiles", `ebb-orchestrator-run-${run.id}`);
    const preparedOwner = this.loadProcessOwner(run.id, defaultProfileHome);
    this.assertNativeHermesAuthReady(run, preparedOwner);
    const abortController = control.abortController;
    const promptFile = await this.writePromptFile(run);
    if (this.finishCancelledBeforeLaunch(run.id, control)) return;
    const profileHome = preparedOwner.hermesHome;
    if (hermesSelection.profileHome !== profileHome) throw new Error("HERMES_PROFILE_HOME_MISMATCH");
    const resultPath = path.join(this.resultDirectory, `${run.id}.json`);
    const configOptions = {
      capability: { role: run.role, workspace },
      toolsetPath: "mcp-orchestrator",
      mcpCommand: this.mcpCommand,
      mcpArgs: [...this.mcpArgs, ...(this.databasePath ? ["--database", this.databasePath] : [])],
      resultFile: resultPath,
      providerSelection: { providerId: hermesSelection.providerId, modelId: hermesSelection.modelId },
      ...(run.capabilityRef ? { capabilityRef: run.capabilityRef } : {}),
    };
    const configYaml = generateConfigYaml(configOptions);
    const platform = currentHermesPlatform();
    const helperPath = hermesProfilePathHelperPath(platform);
    await (this.hermesRunProfileConfigWriter ?? writeHermesRunProfileConfig)({
      runId: run.id,
      profileHome,
      helperPath,
      platform,
      configYaml,
    });
    if (this.finishCancelledBeforeLaunch(run.id, control)) return;

    const args = this.cliBuilder.buildLaunchArgs({
      queryFile: promptFile,
      provider: hermesSelection.providerId,
      model: hermesSelection.modelId,
      toolsets: this.toolsets,
      worktree: workspace,
      ignoreRules: this.ignoreRules,
      source: preparedOwner.sourceTag,
      maxTurns: this.roleLimit,
    });
    const environment = this.buildEnvironment(run, profileHome);
    environment.HERMES_MODEL = hermesSelection.modelId;
    if (environment.HERMES_HOME !== preparedOwner.hermesHome ||
        environment.HOME !== path.join(profileHome, "home") ||
        environment.HERMES_CONFIG !== path.join(profileHome, "config.yaml") ||
        environment.HERMES_MODEL !== hermesSelection.modelId) {
      this.markNeverLaunched(preparedOwner.runId);
      control.stopProven = true;
      throw new Error("HERMES_NATIVE_AUTH_NOT_READY");
    }

    if (control.cancelled || abortController.signal.aborted) {
      this.markNeverLaunched(preparedOwner.runId);
      control.stopProven = true;
      return;
    }

    const preparedLaunch = await this.createLaunchAuthorization(run, workspace, profileHome, environment);

    let processOutput: ProcessResult;
    const sessionObserver = this.hermesSessionCaptureHandler ? new HermesStreamSessionObserver() : undefined;
    let liveCaptureOwner: ProcessScopeIdentity | undefined;
    let captureInvalidReported = false;
    const reportInvalidCapture = async (owner: ProcessScopeIdentity, reason: HermesSessionCaptureFailure): Promise<void> => {
      if (!sessionObserver || !this.hermesSessionCaptureHandler || captureInvalidReported) return;
      await this.hermesSessionCaptureHandler({
        runId: run.id, attempt: run.attempt, sourceTag: preparedOwner.sourceTag,
        hermesHome: environment.HERMES_HOME!, owner, status: "invalid", reason,
      });
      captureInvalidReported = true;
    };
    const onStdoutChunk = sessionObserver ? async (chunk: Uint8Array, owner: ProcessScopeIdentity): Promise<void> => {
      const update = sessionObserver.push(chunk);
      if (update.status === "invalid") {
        await reportInvalidCapture(owner, update.reason);
        throw new Error("HERMES_SESSION_STREAM_INVALID");
      }
      if (update.status !== "captured" || !update.projection) return;

      let observed: ProcessScopeObservation;
      try { observed = await supervisor.inspect(owner); }
      catch { observed = { state: "UNKNOWN", reason: "PROCESS_SCOPE_INSPECTION_FAILED" }; }
      if (observed.state !== "LIVE") {
        await reportInvalidCapture(owner, "PROCESS_SCOPE_NOT_LIVE");
        throw new Error("HERMES_SESSION_PROCESS_NOT_LIVE");
      }
      try { assertSameLiveProcessIdentity(owner, observed.identity); }
      catch {
        await reportInvalidCapture(owner, "OWNER_IDENTITY_MISMATCH");
        throw new Error("HERMES_SESSION_PROCESS_IDENTITY_MISMATCH");
      }
      if (!this.hermesSessionCaptureHandler) {
        await reportInvalidCapture(owner, "CAPTURE_CALLBACK_FAILED");
        throw new Error("HERMES_SESSION_CAPTURE_HANDLER_REQUIRED");
      }
      try {
        await this.hermesSessionCaptureHandler({
          runId: run.id, attempt: run.attempt, sourceTag: preparedOwner.sourceTag,
          hermesHome: environment.HERMES_HOME!, owner, status: "captured",
          sessionId: update.projection.sessionId,
        });
      } catch {
        await reportInvalidCapture(owner, "CAPTURE_CALLBACK_FAILED").catch(() => undefined);
        throw new Error("HERMES_SESSION_CAPTURE_CALLBACK_FAILED");
      }
    } : undefined;
    const settleSessionCapture = async (processFailed = false): Promise<"VALID" | "INVALID"> => {
      if (!sessionObserver || !this.hermesSessionCaptureHandler || captureInvalidReported) return "VALID";
      const owner = liveCaptureOwner ?? ownerToScopeIdentity(preparedOwner);
      const update = sessionObserver.finish();
      if (update.status === "invalid") {
        await reportInvalidCapture(owner, update.reason);
        return "INVALID";
      } else if (update.status === "captured" && update.projection) {
        // A line completed only during finish() is post-exit evidence and cannot bind a session.
        await reportInvalidCapture(owner, "STREAM_FINISHED");
        return "INVALID";
      } else if (processFailed && update.status === "captured") {
        await reportInvalidCapture(owner, "STREAM_FINISHED");
        return "INVALID";
      }
      return "VALID";
    };
    try {
      processOutput = await this.launchScopedRun(supervisor, preparedOwner, {
        executable: preparedLaunch.executablePath,
        args: [...preparedLaunch.argsPrefix, ...args],
        cwd: workspace,
        environment,
        attempt: run.attempt,
        hermesLaunchTicket: preparedLaunch.ticket,
        signal: abortController.signal,
        timeoutMs: this.timeoutMs,
        ...(this.hermesSessionCaptureHandler ? { captureOutput: false } : {}),
      }, abortController, control, onStdoutChunk, (identity) => { liveCaptureOwner = identity; });
    } catch (error) {
      if (control.cancelled && control.stopProven) {
        await settleSessionCapture();
        return;
      }
      await settleSessionCapture(true);
      throw error;
    }
    const captureSettlement = await settleSessionCapture();
    if (captureSettlement === "INVALID") throw new Error("HERMES_SESSION_STREAM_INVALID");
    if (control.cancelled) {
      this.assertStopProof(run.id, control);
      return;
    }
    this.exitCodes.set(run.id, processOutput.exitCode);

    // В production live capture handler исключает post-exit session evidence;
    // legacy diagnostic-only projection остаётся только для adapter callers без RunService sink.
    const observedSessionId = this.hermesSessionCaptureHandler ? null : parseSessionId(processOutput.stdout);
    const pid = this.extractPid(processOutput?.stdout ?? "");
    this.artifactStore.saveArtifacts(run.id, this.hermesSessionCaptureHandler ? "" : processOutput.stdout,
      this.hermesSessionCaptureHandler ? "" : processOutput.stderr, processOutput.exitCode);

    const state: RunState = {
      run: { ...run, status: "IN_PROGRESS" as RunStatus, sessionId: null },
      pid: pid || null,
      sessionId: null,
      observedSessionId: observedSessionId || null,
      stdout: this.hermesSessionCaptureHandler ? "" : processOutput.stdout,
      stderr: this.hermesSessionCaptureHandler ? "" : processOutput.stderr,
      exitCode: processOutput.exitCode,
      startTime: new Date(),
      abortController,
      checkpointPath: await this.getCheckpointPath(run.id),
      submittedResult: await this.readSubmittedResult(run.id, run.role),
      resultPath,
      usage: this.hermesSessionCaptureHandler ? null : this.parseUsage(processOutput.stdout),
    };

    this.runs.set(run.id, state);
  }

  private async createLaunchAuthorization(
    run: AgentRuntimeRun,
    cwd: string,
    profileHome: string,
    environment: Record<string, string>,
  ) {
    const selection = run.hermesSelection;
    const input = {
      runId: run.id,
      attempt: run.attempt,
      cwd,
      profileHome,
      ...(selection?.profileHomePathChain ? { profileHomePathChain: selection.profileHomePathChain } : {}),
      environment: {
        HERMES_HOME: environment.HERMES_HOME!,
        HOME: environment.HOME!,
        HERMES_CONFIG: environment.HERMES_CONFIG!,
      },
    };
    if (this.hermesLaunchTicketFactory) return this.hermesLaunchTicketFactory(input);
    if (!selection || selection.runId !== run.id || !selection.sourceSnapshotKey) {
      throw new Error("HERMES_RUN_SELECTION_UNAVAILABLE");
    }
    const platform = currentHermesPlatform();
    const resolution = await resolveHermesExecutable({ cwd });
    if (resolution.executableIdentity.platform !== platform) throw new Error("HERMES_PLATFORM_IDENTITY_MISMATCH");
    const durableOwner = this.loadProcessOwner(run.id, profileHome);
    const sourceSnapshotKey = durableOwner.hermesSourceSnapshotKey;
    if (!sourceSnapshotKey) throw new Error("HERMES_SOURCE_SNAPSHOT_KEY_REQUIRED");
    const selectedSnapshotKey = selection.sourceSnapshotKey;
    if (!selectedSnapshotKey || selectedSnapshotKey !== sourceSnapshotKey) throw new Error("HERMES_SOURCE_SNAPSHOT_KEY_MISMATCH");
    const { snapshot, projection } = await ensureHermesSourceSnapshotNativeProjection({
      cacheRoot: this.hermesSourceCacheRoot,
      cacheKey: sourceSnapshotKey,
    });
    if (snapshot.cacheKey !== sourceSnapshotKey || snapshot.manifestDigest.length !== 64) {
      throw new Error("HERMES_SOURCE_SNAPSHOT_UNAVAILABLE");
    }
    if (resolution.sourceVersion !== selection.sourceVersion || resolution.sourceCommit !== selection.sourceCommit) {
      throw new Error("HERMES_SOURCE_SNAPSHOT_KEY_MISMATCH");
    }
    const sourceSnapshotRootIdentity = await verifyHermesProfileHomeIdentity(snapshot.rootPath);
    if (!isVerifiedHermesSourceSnapshot(snapshot)) throw new Error("HERMES_SOURCE_SNAPSHOT_UNAVAILABLE");
    const executableArgsPrefix = buildHermesSnapshotRuntimeArgs({
      snapshot,
      runtimeDependencyRoot: resolution.runtimeDependencyRoot,
      runtimeExecutablePath: resolution.runtimeExecutablePath,
      sourceVersion: selection.sourceVersion,
      sourceCommit: selection.sourceCommit,
    });
    const profileHomeIdentity = await verifyHermesProfileHomeIdentity(profileHome);
    const profileHomeTargetIdentities = platform === "win32"
      ? await verifyHermesRunProfileTargetIdentities(profileHome)
      : undefined;
    const profileHomePathChain = await verifyHermesProfileHomePathChain(profileHome, resolution.hermesConfigHome);
    if (JSON.stringify(profileHomePathChain) !== JSON.stringify(selection.profileHomePathChain) ||
        JSON.stringify(profileHomePathChain) !== JSON.stringify(selection.authRouteEvidence.profileHomePathChain)) {
      throw new Error("HERMES_PROFILE_PATH_CHAIN_MISMATCH");
    }
    const ticket = createHermesLaunchTicket({
      ...input,
      platform: resolution.executableIdentity.platform,
      hermesExecutablePath: resolution.executablePath,
      hermesExecutableIdentity: resolution.executableIdentity,
      executablePath: resolution.runtimeExecutablePath,
      executableIdentity: resolution.runtimeExecutableIdentity,
      executableArgsPrefix,
      profileHomeIdentity,
      ...(profileHomeTargetIdentities ? { profileHomeTargetIdentities } : {}),
      ...(profileHomePathChain ? { profileHomePathChain } : {}),
      hermesSourceSnapshotKey: snapshot.cacheKey,
      hermesSourceSnapshotRoot: snapshot.rootPath,
      hermesSourceSnapshotRootIdentity: sourceSnapshotRootIdentity,
      hermesSourceManifestDigest: snapshot.manifestDigest,
      hermesSourceProjectionPath: projection.path,
      hermesSourceProjectionSha256: projection.sha256,
      hermesSourceProjectionSize: projection.size,
    });
    // Both production supervisors consume this one-use ticket before dispatch. Windows validates
    // and holds the snapshot handles for the Job lifetime; Linux validates the projection/tree,
    // holds the shared cache reference lease, and runs Hermes from a read-only private mount.
    return { executablePath: resolution.runtimeExecutablePath, argsPrefix: executableArgsPrefix, ticket };
  }

  private loadProcessOwner(runId: string, defaultHermesHome: string): RunProcessOwner {
    if (this.databasePath) {
      const database = createSqliteDatabase(this.databasePath);
      try {
        const owner = getRunProcessOwner(database, runId);
        if (!owner) throw new Error("RUN_PROCESS_OWNER_MISSING");
        if (owner.state !== "PREPARED") throw new Error("RUN_PROCESS_OWNER_NOT_PREPARED");
        return owner;
      } finally {
        database.close();
      }
    }
    // In-memory owner identities are used only by unit tests which explicitly inject a test supervisor.
    return prepareRunProcessOwner(runId, defaultHermesHome, currentContainmentKind());
  }

  private async launchScopedRun(
    supervisor: ProcessScopeSupervisor,
    preparedOwner: RunProcessOwner,
    request: ProcessScopeLaunchRequest,
    abortController: AbortController,
    control: RunStartControl,
    onStdoutChunk?: (chunk: Uint8Array, identity: ProcessScopeIdentity) => Promise<void>,
    onLiveIdentity?: (identity: ProcessScopeIdentity) => void,
  ): Promise<ProcessResult> {
    const durable = this.databasePath !== undefined;
    let owner = ownerToScopeIdentity(preparedOwner);
    if (control.cancelled || abortController.signal.aborted) {
      this.markNeverLaunched(preparedOwner.runId);
      control.stopProven = true;
      throw new Error("RUN_CANCELLED_BEFORE_LAUNCH");
    }
    if (durable) {
      this.transitionOwner(owner, "PREPARED", "LAUNCHING");
      owner = { ...owner, state: "LAUNCHING" };
    } else {
      owner = { ...owner, state: "LAUNCHING" };
    }

    let liveIdentity: ProcessScopeIdentity | undefined;
    try {
      const launchRequest: ProcessScopeLaunchRequest = {
        ...request,
        ...(onStdoutChunk ? {
          onStdoutChunk: async (chunk: Uint8Array) => {
            if (!liveIdentity || liveIdentity.state !== "LIVE") throw new Error("PROCESS_SCOPE_LIVE_IDENTITY_MISSING");
            await onStdoutChunk(chunk, liveIdentity);
          },
        } : {}),
      };
      const handle = await supervisor.launch(owner, launchRequest, async (identity) => {
        assertMatchingLiveIdentity(owner, identity);
        // Keep the exact OS identity available even if the durable LIVE CAS fails;
        // the failure path must still stop that exact scope before returning.
        liveIdentity = identity;
        if (control.cancelled || abortController.signal.aborted) {
          throw new Error("RUN_CANCELLED_BEFORE_LAUNCH_AUTHORIZATION");
        }
        if (durable) this.transitionOwner(owner, "LAUNCHING", "LIVE", identity);
        onLiveIdentity?.(identity);
      });
      if (!liveIdentity) throw new Error("PROCESS_SCOPE_LIVE_IDENTITY_MISSING");
      this.activeScopes.set(preparedOwner.runId, { owner: liveIdentity, durable, abortController });
      const result = await handle.completion;
      let stopped = await supervisor.waitForStopped(liveIdentity, 30_000);
      if (stopped.state !== "STOPPED") {
        const stopping = { ...liveIdentity, state: "STOPPING" as const };
        if (durable) {
          try { this.transitionOwner(liveIdentity, "LIVE", "STOPPING"); }
          catch { /* Stop the exact OS scope even when durable state cannot be updated. */ }
        }
        const stop = await supervisor.stop(stopping);
        stopped = stop.state === "STOPPED" ? stop : await supervisor.waitForStopped(stopping, 30_000);
        liveIdentity = stopping;
      }
      if (stopped.state !== "STOPPED") {
        const current = liveIdentity;
        if (durable) {
          try { this.persistUnknown(current.runId); }
          catch { /* The existing nonterminal owner remains for startup preflight. */ }
        }
        throw new Error("PROCESS_SCOPE_STOP_UNPROVEN");
      }
      control.stopProven = true;
      if (durable) this.persistStopped(liveIdentity, stopped.evidence);
      return result;
    } catch (error) {
      if (control.cancelled && error instanceof ProcessScopeLaunchNotDispatchedError) {
        if (durable) this.persistLaunchNotDispatched(owner.runId, error);
        control.stopProven = true;
        throw error;
      }
      const current = liveIdentity ?? owner;
      const observation = await supervisor.inspect(current).catch((): ProcessScopeObservation => ({
        state: "UNKNOWN", reason: "PROCESS_SCOPE_INSPECTION_FAILED",
      }));
      if (observation.state === "STOPPED") {
        control.stopProven = true;
        if (durable) this.persistStopped(current, observation.evidence);
      } else if (observation.state === "LIVE") {
        assertMatchingLiveIdentity(current, observation.identity);
        const live = { ...observation.identity, state: "STOPPING" as const };
        if (durable) {
          try { this.transitionOwner(current, "LIVE", "STOPPING"); } catch { /* Still stop the exact OS scope below. */ }
        }
        const stopped = await supervisor.stop(live);
        const final = stopped.state === "STOPPED" ? stopped : await supervisor.waitForStopped(live, 30_000);
        if (final.state === "STOPPED") {
          control.stopProven = true;
          if (durable) this.persistStopped(current, final.evidence);
        } else {
          if (durable) {
            try { this.persistUnknown(current.runId); }
            catch { /* Preserve whichever nonterminal durable state is still available. */ }
          }
          throw new Error("PROCESS_SCOPE_STOP_UNPROVEN", { cause: error });
        }
      } else {
        if (durable) {
          try { this.persistUnknown(current.runId); }
          catch { /* Preserve the current row so startup remains fail-closed. */ }
        }
        throw new Error("PROCESS_SCOPE_STATE_UNKNOWN", { cause: error });
      }
      throw error;
    } finally {
      this.activeScopes.delete(preparedOwner.runId);
    }
  }

  private transitionOwner(
    owner: Pick<ProcessScopeIdentity, "runId">,
    expectedState: RunProcessOwnerState,
    nextState: RunProcessOwnerState,
    identity?: ProcessScopeIdentity,
    evidence?: string,
  ): void {
    if (!this.databasePath) return;
    const database = createSqliteDatabase(this.databasePath);
    try {
      database.transaction((tx) => transitionRunProcessOwnerTx(tx, {
        runId: owner.runId,
        expectedState,
        nextState,
        ...(identity ? { identity: ownerTransitionIdentity(identity) } : {}),
        ...(evidence ? { evidence } : {}),
      }));
    } finally {
      database.close();
    }
  }

  private persistLaunchNotDispatched(runId: string, launchError: unknown): void {
    if (!(launchError instanceof ProcessScopeLaunchNotDispatchedError)) {
      throw new TypeError("A typed supervisor no-dispatch result is required.");
    }
    if (!this.databasePath) return;
    const database = createSqliteDatabase(this.databasePath);
    try {
      database.transaction((tx) => {
        const current = tx.get<{
          state: string; stop_evidence: string | null; systemd_invocation_id: string | null;
          systemd_control_group: string | null; supervisor_pid: number | null;
          supervisor_start_identity: string | null; pid: number | null; platform: string | null;
          process_start_identity: string | null; executable_identity: string | null;
        }>(`SELECT state,stop_evidence,systemd_invocation_id,systemd_control_group,supervisor_pid,
                   supervisor_start_identity,pid,platform,process_start_identity,executable_identity
              FROM run_process_owners WHERE run_id=$runId`, { runId });
        if (!current) throw new Error("RUN_PROCESS_OWNER_MISSING");
        if (current.state !== "LAUNCHING" || current.stop_evidence !== null ||
            current.systemd_invocation_id !== null || current.systemd_control_group !== null ||
            current.supervisor_pid !== null || current.supervisor_start_identity !== null ||
            current.pid !== null || current.platform !== null || current.process_start_identity !== null ||
            current.executable_identity !== null) {
          throw new Error("RUN_PROCESS_LAUNCH_NOT_DISPATCHED_STATE_INVALID");
        }
        tx.run(`UPDATE run_process_owners SET state='STOPPED',stop_evidence='LAUNCH_NOT_DISPATCHED',
                  updated_at=$updatedAt WHERE run_id=$runId AND state='LAUNCHING' AND stop_evidence IS NULL`, {
          runId, updatedAt: new Date().toISOString(),
        });
        if ((tx.get<{ changes: number }>("SELECT changes() AS changes")?.changes ?? 0) !== 1) {
          throw new Error("RUN_PROCESS_OWNER_STATE_CHANGED");
        }
      });
    } finally {
      database.close();
    }
  }

  private persistStopped(owner: ProcessScopeIdentity, evidence: string): void {
    if (!this.databasePath) return;
    let state = this.readPersistedOwnerState(owner.runId);
    if (!state) throw new Error("RUN_PROCESS_OWNER_MISSING");
    if (state === "STOPPED") {
      const persisted = this.readPersistedOwner(owner.runId);
      if (!persisted || !isAuthoritativeRunProcessStopEvidence(persisted.stopEvidence, persisted.containmentKind)) {
        throw new Error("RUN_PROCESS_STOP_PROOF_INVALID");
      }
      return;
    }
    if (state === "LIVE") {
      this.transitionOwner(owner, "LIVE", "STOPPING", owner);
      state = "STOPPING";
    }
    this.transitionOwner(owner, state, "STOPPED", owner, evidence);
    const persisted = this.readPersistedOwner(owner.runId);
    if (!persisted || persisted.state !== "STOPPED" || persisted.stopEvidence !== evidence ||
        !isAuthoritativeRunProcessStopEvidence(persisted.stopEvidence, persisted.containmentKind)) {
      throw new Error("RUN_PROCESS_STOP_PROOF_PERSISTENCE_FAILED");
    }
  }

  private readPersistedOwner(runId: string): RunProcessOwner | undefined {
    if (!this.databasePath) return undefined;
    const database = createSqliteDatabase(this.databasePath);
    try { return getRunProcessOwner(database, runId); }
    finally { database.close(); }
  }

  private readPersistedOwnerState(runId: string): RunProcessOwnerState | undefined {
    if (!this.databasePath) return undefined;
    const database = createSqliteDatabase(this.databasePath);
    try { return getRunProcessOwner(database, runId)?.state; }
    finally { database.close(); }
  }

  private persistUnknown(runId: string): void {
    const current = this.readPersistedOwnerState(runId);
    if (!current || current === "UNKNOWN" || current === "STOPPED" || current === "PREPARED") return;
    this.transitionOwner({ runId }, current, "UNKNOWN", undefined, "OS_STATE_UNPROVEN");
  }

  private markNeverLaunched(runId: string): void {
    if (!this.databasePath) return;
    const database = createSqliteDatabase(this.databasePath);
    try {
      const owner = getRunProcessOwner(database, runId);
      if (!owner) throw new Error("RUN_PROCESS_OWNER_MISSING");
      if (owner.state === "PREPARED") {
        database.transaction((tx) => transitionRunProcessOwnerTx(tx, {
          runId, expectedState: "PREPARED", nextState: "STOPPED", evidence: "NEVER_LAUNCHED",
        }));
      } else if (owner.state !== "STOPPED" || !isAuthoritativeRunProcessStopEvidence(owner.stopEvidence, owner.containmentKind)) {
        throw new Error("RUN_PROCESS_SCOPE_STOP_UNPROVEN");
      }
    } finally {
      database.close();
    }
  }

  private finishCancelledBeforeLaunch(runId: string, control: RunStartControl): boolean {
    if (!control.cancelled && !control.abortController.signal.aborted) return false;
    this.markNeverLaunched(runId);
    control.stopProven = true;
    return true;
  }

  private assertStopProof(runId: string, control: RunStartControl): void {
    if (!control.stopProven) throw new Error("PROCESS_SCOPE_STOP_UNPROVEN");
    if (!this.databasePath) return;
    const database = createSqliteDatabase(this.databasePath);
    try {
      const owner = getRunProcessOwner(database, runId);
      if (!owner || owner.state !== "STOPPED" || !isAuthoritativeRunProcessStopEvidence(owner.stopEvidence, owner.containmentKind)) {
        throw new Error("PROCESS_SCOPE_STOP_UNPROVEN");
      }
    } finally {
      database.close();
    }
  }

  /**
   * Возобновление a run that was paused.
   */
  async resumeRun(runId: string, options: { sessionId: string; attempt: number }): Promise<void> {
    if (this.databasePath) throw new Error("HERMES_RESUME_REQUIRES_TASK_5C");
    this.assertNativeHermesAuthReady();
    const existingState = this.runs.get(runId) ?? await this.restoreRunState(runId, options);

    const abortController = new AbortController();

    const args = this.cliBuilder.buildResumeArgs({
      sessionId: options.sessionId,
      toolsets: this.toolsets,
      worktree: this.getManagedWorktree(existingState.run),
      ignoreRules: this.ignoreRules,
      source: "tool",
      maxTurns: this.roleLimit,
    });

    const execOptions: ProcessOptions = {
      cwd: this.getManagedWorktree(existingState.run),
      env: this.buildEnvironment(existingState.run, path.join(this.resultDirectory, "profiles", runId)),
      timeout: this.timeoutMs,
      signal: abortController.signal,
    };

    let processOutput: { stdout: string; stderr: string; exitCode: number };

    try {
      const result = await this.executor.exec("hermes", args, execOptions);
      processOutput = { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    } catch (error) {
      const processError = error instanceof ExitCodeError ? error : undefined;
      if (!processError) throw error;
      processOutput = { stdout: processError?.stdout ?? "", stderr: processError?.stderr ?? (error as Error).message, exitCode: processError?.exitCode ?? -1 };
    }
    // Обновляет existing state in place
    existingState.run.sessionId = options.sessionId;
    existingState.run.attempt = options.attempt;
    existingState.run.status = "IN_PROGRESS" as RunStatus;
    existingState.pid = null;
    existingState.stdout = processOutput.stdout;
    existingState.stderr = processOutput.stderr;
    existingState.exitCode = processOutput.exitCode;
    this.artifactStore.saveArtifacts(runId, processOutput.stdout, processOutput.stderr, processOutput.exitCode);
    existingState.submittedResult = await this.readSubmittedResult(runId, existingState.run.role);
    existingState.usage = this.parseUsage(processOutput.stdout);
    existingState.startTime = new Date();
    existingState.abortController = abortController;
    this.runs.set(runId, existingState);
  }

  private async restoreRunState(runId: string, options: { sessionId: string; attempt: number }): Promise<RunState> {
    if (!this.databasePath) throw new Error(`Run ${runId} not found in persisted runtime state`);
    const db = createSqliteDatabase(this.databasePath);
    try {
      const row = db.get<Record<string, unknown>>("SELECT * FROM agent_runs WHERE id = $id", { id: runId });
      if (!row) throw new Error(`Run ${runId} not found`);
      const capability = row.capability_json ? JSON.parse(String(row.capability_json)) as { workspace?: string } : undefined;
      const run: AgentRun = {
        id: String(row.id), role: String(row.role), runtime: String(row.runtime), model: String(row.model),
        taskId: row.task_id as string | null, epicId: row.epic_id as string | null, status: "IN_PROGRESS" as RunStatus,
        sessionId: options.sessionId, attempt: options.attempt, triggerReason: row.trigger_reason as AgentRun["triggerReason"],
        contextVersion: row.context_version as string | null, outputSchemaVersion: row.output_schema_version as string | null,
        startedAt: row.started_at ? new Date(String(row.started_at)) : null, endedAt: null,
        exitCode: null, inputTokens: null, cachedInputTokens: null, outputTokens: null, cost: null,
        ...(row.capability_ref ? { capabilityRef: String(row.capability_ref) } : {}),
      };
      const workspace = capability?.workspace || this.getManagedWorktree(run);
      // сохранять Объект restored workspace доступный to Объект обычный resolver не делая
      // resume dependent on Объект процесс который created Объект исходную запись map.
      const restored = { run, pid: null, sessionId: options.sessionId, stdout: "", stderr: "", exitCode: null,
        startTime: new Date(), abortController: null, checkpointPath: await this.getCheckpointPath(runId),
        submittedResult: null, resultPath: path.join(this.resultDirectory, `${runId}.json`), usage: null } satisfies RunState;
      if (!this.managedWorktree && !this.managedWorktreeForRun) {
        (restored.run as AgentRun & { __workspace?: string }).__workspace = workspace;
      }
      return restored;
    } finally { db.close(); }
  }

  /**
   * Отмена an in-progress run.
   */
  async cancelRun(runId: string): Promise<void> {
    const starting = this.startingRuns.get(runId);
    if (starting) {
      starting.cancelled = true;
      starting.abortController.abort();
      let startFailure: unknown;
      try {
        await starting.startPromise;
      } catch (error) {
        startFailure = error;
      }
      try {
        this.assertStopProof(runId, starting);
      } catch (error) {
        if (startFailure !== undefined) throw startFailure;
        throw error;
      }
      return;
    }
    const activeScope = this.activeScopes.get(runId);
    if (activeScope) {
      const supervisor = this.processScopeSupervisor;
      if (!supervisor) throw new Error("PROCESS_SCOPE_SUPERVISOR_REQUIRED");
      let owner = activeScope.owner;
      if (owner.state === "LIVE") {
        if (activeScope.durable) this.transitionOwner(owner, "LIVE", "STOPPING");
        owner = { ...owner, state: "STOPPING" };
        activeScope.owner = owner;
      }
      activeScope.abortController.abort();
      const stopped = await supervisor.stop(owner);
      const final = stopped.state === "STOPPED" ? stopped : await supervisor.waitForStopped(owner, 30_000);
      if (final.state !== "STOPPED") {
        if (activeScope.durable && owner.state !== "UNKNOWN") {
          this.transitionOwner(owner, owner.state, "UNKNOWN", undefined, "OS_STATE_UNPROVEN");
        }
        throw new Error("PROCESS_SCOPE_STOP_UNPROVEN");
      }
      if (activeScope.durable) this.transitionOwner(owner, owner.state, "STOPPED", undefined, final.evidence);
      return;
    }
    const state = this.runs.get(runId);
    if (!state) {
      return;
    }

    // Обновляет run status
    const updatedRun = { ...state.run, status: "CANCELLED" as RunStatus };
    state.run = updatedRun;
    state.exitCode = -1;
  }

  /**
   * Inspect Объект текущее состояние of Объект run.
   */
  async inspectRun(runId: string): Promise<AgentRun> {
    const state = this.runs.get(runId);
    if (!state) {
      throw new Error(`Run ${runId} not found`);
    }
    return state.run;
  }

  /**
   * Collect Объект результат из Объект run.
   */
  async collectResult(runId: string): Promise<RunOutcome> {
    const state = this.runs.get(runId);
    if (!state) {
      throw new Error(`Run ${runId} not found`);
    }

    // Re-read Объект run-bound artifact on every collection. Этот cached значение является
    // только Объект optimization для процесс bookkeeping и является никогда не является источником истины.
    const submittedResult = await this.readSubmittedResult(runId, state.run.role);
    if (!submittedResult) {
      return {
        success: false,
        exitCode: state.exitCode ?? -1,
        output: "AGENT_OUTPUT_MISSING",
        validatedSubmission: false,
        diagnostics: {
          runId,
          sessionId: state.observedSessionId ?? state.sessionId,
          stderr: state.stderr,
          exitCode: state.exitCode ?? -1,
          artifactReferences: [state.resultPath, `run-artifacts://${runId}`],
        },
      };
    }

    return {
      success: state.exitCode === 0,
      exitCode: state.exitCode ?? -1,
      output: submittedResult,
      validatedSubmission: true,
      diagnostics: {
        runId,
        sessionId: state.observedSessionId ?? state.sessionId,
        stderr: state.stderr,
        exitCode: state.exitCode ?? -1,
        artifactReferences: [state.resultPath, `run-artifacts://${runId}`],
      },
    };
  }

  /**
   * Получает токен использование из Объект run.
   */
  async collectUsage(runId: string): Promise<{
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    cost: number;
  }> {
    const state = this.runs.get(runId);
    if (!state?.usage || (state.usage.inputTokens === 0 && state.usage.outputTokens === 0)) {
      throw new Error(`HERMES_USAGE_MISSING: no usage values were emitted for run ${runId}`);
    }
    return state.usage;
  }

  /**
    * Получает the result from a run.
    */
  async runResult(runId: string): Promise<RunOutcome> {
    const state = this.runs.get(runId);
    if (!state) {
      throw new Error(`Run ${runId} not found`);
    }
    return {
      success: state.exitCode === 0,
      exitCode: state.exitCode ?? -1,
      output: state.stdout,
      validatedSubmission: false,
      diagnostics: {
        runId,
        sessionId: state.observedSessionId ?? state.sessionId,
        stderr: state.stderr,
        exitCode: state.exitCode ?? -1,
        artifactReferences: [state.resultPath],
      },
    };
  }

  /**
    * Проверяет if the runtime is healthy.
    */
  async healthCheck(): Promise<boolean> {
    return true;
  }

  /**
   * Записывает prompt body to a temporary file.
   */
  private async writePromptFile(run: AgentRun): Promise<string> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-prompt-"));
    const promptFile = path.join(tempDir, `prompt-${run.id}.txt`);
    const body = run.prompt ?? [
      `Task: ${run.taskId ?? "N/A"}`,
      `Role: ${run.role}`,
      `Context version: ${run.contextVersion ?? ""}`,
      "Use the Orchestrator tools only.",
      "Submit exactly one valid result with submit_result before ending.",
    ].join("\n");
    await fs.writeFile(promptFile, body);
    return promptFile;
  }

  /**
   * Формирует environment variables for hermes process.
   */
  private buildEnvironment(_run: AgentRun, profileHome?: string): Record<string, string> {
    const allowed = new Set(["HOMEDRIVE", "HOMEPATH", "SYSTEMROOT", "TEMP", "TMP", "PATH", "NODE_PATH", "NODE_ENV", "HERMES_HOME", "HERMES_CONFIG", "HERMES_MODEL"]);
    const env: Record<string, string> = {};
    for (const key of allowed) {
      const value = key === "HERMES_HOME" && profileHome
        ? profileHome
        : this.environment?.[key];
      if (value !== undefined) env[key] = value;
    }
    for (const [key, value] of Object.entries(this.environment ?? {})) {
      if (key === "GITHUB_TOKEN" || key === "SSH_AUTH_SOCK" || key.endsWith("TOKEN") || key.endsWith("SECRET")) throw new Error("Forbidden credential in supplied runtime environment");
      if (!allowed.has(key)) throw new Error(`Forbidden or unknown Hermes environment variable: ${key}`);
      env[key] = value;
    }
    const home = profileHome ?? env.HERMES_HOME;
    if (!home) throw new Error("Hermes isolated profile is required");
    env.HERMES_HOME = home;
    env.HOME = path.join(home, "home");
    env.HERMES_CONFIG = path.join(home, "config.yaml");
    delete env.HERMES_PROFILE;
    return env;
  }

  /**
   * Разрешает запуск только для selection, подготовленного после проверки pinned source,
   * source snapshot, bounded projection и нового профиля под native auth root.
   * Credential values, auth files и account identifiers не читаются.
   */
  private assertNativeHermesAuthReady(run?: AgentRuntimeRun, owner?: RunProcessOwner): void {
    const selection = run?.hermesSelection;
    const evidence = selection ? this.verifiedNativeAuthSelections.get(selection) : undefined;
    if (!run || !owner || !selection || !evidence || owner.state !== "PREPARED" ||
        owner.runId !== run.id || owner.sourceTag !== `ebb-run:${run.id}` ||
        owner.hermesHome !== selection.profileHome || evidence.runId !== run.id ||
        evidence.profileHome !== selection.profileHome || evidence.sourceVersion !== HERMES_PROVIDER_SELECTION_SOURCE.version ||
        evidence.sourceCommit !== HERMES_PROVIDER_SELECTION_SOURCE.commit ||
        selection.sourceVersion !== evidence.sourceVersion || selection.sourceCommit !== evidence.sourceCommit ||
        selection.modelId !== run.model || selection.providerId !== evidence.providerId ||
        selection.modelId !== evidence.modelId || selection.endpointIdentity !== evidence.endpointIdentity ||
        selection.endpointRevision !== evidence.endpointRevision ||
        selection.endpointIdentity !== `hermes-provider:${selection.providerId.toLowerCase()}` ||
        selection.endpointRevision !== HERMES_PROVIDER_SELECTION_SOURCE.commit ||
        evidence.projectionVersion !== HERMES_PROVIDER_SELECTION_SOURCE.projectionVersion ||
        !isHermesNativeAuthRouteEvidence(selection.authRouteEvidence) ||
        evidence.authRouteEvidence !== selection.authRouteEvidence ||
        evidence.authRouteEvidence.authRoot !== evidence.authRoot ||
        evidence.authRouteEvidence.profileHome !== selection.profileHome ||
        JSON.stringify(evidence.authRouteEvidence.profileHomePathChain) !== JSON.stringify(selection.profileHomePathChain) ||
        evidence.authRouteEvidence.endpointIdentity !== selection.endpointIdentity ||
        evidence.authRouteEvidence.endpointRevision !== selection.endpointRevision ||
        !isSupportedHermesNativeAuthSnapshot(selection.sourceSnapshotKey, evidence) ||
        (this.databasePath !== undefined && owner.hermesSourceSnapshotKey !== selection.sourceSnapshotKey) ||
        !isFreshHermesNativeProfilePath(selection.profileHome, evidence.authRoot, run.id)) {
      throw new Error("HERMES_NATIVE_AUTH_NOT_READY");
    }
  }

  private recordVerifiedHermesNativeAuthEvidence(
    selection: HermesRunSelection,
    evidence: VerifiedHermesNativeAuthEvidence,
  ): void {
    if (!isSupportedHermesNativeAuthSnapshot(selection.sourceSnapshotKey, evidence) ||
        !isFreshHermesNativeProfilePath(selection.profileHome, evidence.authRoot, selection.runId) ||
        selection.profileHome !== evidence.profileHome || selection.runId !== evidence.runId ||
        selection.sourceVersion !== evidence.sourceVersion || selection.sourceCommit !== evidence.sourceCommit ||
        selection.providerId !== evidence.providerId || selection.modelId !== evidence.modelId ||
        selection.endpointIdentity !== evidence.endpointIdentity || selection.endpointRevision !== evidence.endpointRevision ||
        evidence.projectionVersion !== HERMES_PROVIDER_SELECTION_SOURCE.projectionVersion ||
        !isHermesNativeAuthRouteEvidence(evidence.authRouteEvidence) ||
        evidence.authRouteEvidence.runId !== selection.runId ||
        evidence.authRouteEvidence.authRoot !== evidence.authRoot ||
        evidence.authRouteEvidence.profileHome !== selection.profileHome ||
        JSON.stringify(evidence.authRouteEvidence.profileHomePathChain) !== JSON.stringify(selection.profileHomePathChain) ||
        evidence.authRouteEvidence.endpointIdentity !== selection.endpointIdentity ||
        evidence.authRouteEvidence.endpointRevision !== selection.endpointRevision ||
        evidence.authRouteEvidence.providerId !== selection.providerId ||
        evidence.authRouteEvidence.modelId !== selection.modelId ||
        evidence.authRouteEvidence.sourceVersion !== selection.sourceVersion ||
        evidence.authRouteEvidence.sourceCommit !== selection.sourceCommit ||
        evidence.authRouteEvidence.policyIdentity !== selection.authRouteEvidence.policyIdentity) {
      throw new Error("HERMES_NATIVE_AUTH_NOT_READY");
    }
    this.verifiedNativeAuthSelections.set(selection, Object.freeze({ ...evidence }));
  }

  /**
   * Получает the managed worktree path for a run.
   */
  private getManagedWorktree(run: AgentRun): string {
    if (this.databasePath) {
      if (!run.capabilityRef) {
        throw new Error(`Hermes workspace is unavailable for run ${run.id}: capability reference is missing`);
      }
      const database = createSqliteDatabase(this.databasePath);
      try {
        const capability = loadValidatedCapability(database, run.capabilityRef);
        const workspace = capability.capability.workspace.trim();
        if (!workspace) {
          throw new Error("authoritative capability.workspace is empty");
        }
        return capability.capability.workspace;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Hermes workspace is unavailable for run ${run.id}: ${reason}`, { cause: error });
      } finally {
        database.close();
      }
    }

    const configuredWorkspace = this.managedWorktreeForRun?.(run)
      ?? this.managedWorktree
      ?? (run as AgentRun & { __workspace?: string }).__workspace;
    if (configuredWorkspace) return configuredWorkspace;
    throw new Error(`Hermes workspace is unavailable for run ${run.id}: authoritative capability.workspace is missing`);
  }

  private async waitForWorkspace(run: AgentRun): Promise<string> {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const workspace = this.getManagedWorktree(run);
      try {
        if (workspace) {
          await fs.access(workspace);
          return workspace;
        }
      } catch {
        // Этот per-run resolver may publish the worktree asynchronously.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Hermes workspace is unavailable for run ${run.id}`);
  }

  /**
   * Получает checkpoint path for a run.
   */
  private async getCheckpointPath(runId: string): Promise<string> {
    const checkpointDir = this.checkpointDirectory;
    await fs.mkdir(checkpointDir, { recursive: true });
    return path.join(checkpointDir, `${runId}.checkpoint`);
  }

  private async readSubmittedResult(runId: string, role: string): Promise<string | null> {
    try {
      const exactPath = path.join(this.resultDirectory, `${runId}.json`);
      const raw = await fs.readFile(exactPath, "utf8");
      const value: unknown = JSON.parse(raw);
      const validated = validateRoleOutput(this.roleName(role), value);
      return validated.valid && validated.output ? JSON.stringify(validated.output) : null;
    } catch {
      // Этот file is a transport artifact, not the source of truth. A valid
      // MCP submit_result also atomically persists Объект точный JSON in SQLite;
      // этот резервный вариант является essential после Объект Windows процесс exits перед the
      // сброса файла результата completes (и после Объект перезапуска adapter).
      if (!this.databasePath) return null;
      const db = createSqliteDatabase(this.databasePath);
      try {
        const row = db.get<{ output: string | null }>(
          "SELECT output FROM agent_runs WHERE id = $id AND status = 'COMPLETING'", { id: runId });
        if (!row?.output) return null;
        const value: unknown = JSON.parse(row.output);
        const validated = validateRoleOutput(this.roleName(role), value);
        return validated.valid && validated.output ? JSON.stringify(validated.output) : null;
      } catch {
        return null;
      } finally { db.close(); }
    }
  }

  private roleName(role: string): string {
    return role.toLowerCase();
  }

  private parseUsage(stdout: string): RunUsage | null {
    const match = stdout.match(/"usage"\s*:\s*(\{[^\n]*\})/);
    if (!match?.[1]) return null;
    try {
      const value: unknown = JSON.parse(match[1]);
      if (!value || typeof value !== "object") return null;
      const record = value as Record<string, unknown>;
      const inputTokens = this.usageNumber(record.inputTokens ?? record.input_tokens);
      const cachedInputTokens = this.usageNumber(record.cachedInputTokens ?? record.cached_input_tokens);
      const outputTokens = this.usageNumber(record.outputTokens ?? record.output_tokens);
      const cost = this.usageNumber(record.cost);
      if (inputTokens === null || cachedInputTokens === null || outputTokens === null || cost === null) return null;
      return { inputTokens, cachedInputTokens, outputTokens, cost };
    } catch { return null; }
  }

  private usageNumber(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  }

  /**
   * Извлекает process ID from hermes output.
   */
  private extractPid(stdout: string): number | null {
    const pidPattern = /pid:\s*(\d+)/;
    const match = stdout.match(pidPattern);
    return match?.[1] ? parseInt(match[1], 10) : null;
  }
}

function isSupportedHermesNativeAuthSnapshot(
  sourceSnapshotKey: string,
  evidence: VerifiedHermesNativeAuthEvidence,
): boolean {
  if (typeof sourceSnapshotKey !== "string" || sourceSnapshotKey.length > 2_048) return false;
  let identity: unknown;
  try {
    identity = JSON.parse(sourceSnapshotKey) as unknown;
  } catch {
    return false;
  }
  if (typeof identity !== "object" || identity === null || Array.isArray(identity)) return false;
  const snapshot = identity as Record<string, unknown>;
  const platform = currentHermesPlatform();
  const expectedKeys = platform === "win32"
    ? ["formatVersion", "hermesVersion", "manifestDigest", "materializationPolicyVersion", "sourceCommit", "sourceTree"]
    : ["formatVersion", "hermesVersion", "manifestDigest", "sourceCommit", "sourceTree"];
  const canonicalIdentity = platform === "win32"
    ? {
      formatVersion: snapshot.formatVersion,
      hermesVersion: snapshot.hermesVersion,
      manifestDigest: snapshot.manifestDigest,
      materializationPolicyVersion: 2,
      sourceCommit: snapshot.sourceCommit,
      sourceTree: snapshot.sourceTree,
    }
    : {
      formatVersion: snapshot.formatVersion,
      hermesVersion: snapshot.hermesVersion,
      manifestDigest: snapshot.manifestDigest,
      sourceCommit: snapshot.sourceCommit,
      sourceTree: snapshot.sourceTree,
    };
  return JSON.stringify(Object.keys(snapshot)) === JSON.stringify(expectedKeys) &&
    (platform !== "win32" || snapshot.materializationPolicyVersion === 2) &&
    JSON.stringify(snapshot) === sourceSnapshotKey && snapshot.formatVersion === 1 &&
    JSON.stringify(canonicalIdentity) === sourceSnapshotKey &&
    snapshot.hermesVersion === HERMES_PROVIDER_SELECTION_SOURCE.version &&
    snapshot.sourceCommit === HERMES_PROVIDER_SELECTION_SOURCE.commit &&
    evidence.sourceVersion === snapshot.hermesVersion && evidence.sourceCommit === snapshot.sourceCommit &&
    typeof snapshot.manifestDigest === "string" && /^[a-f0-9]{64}$/u.test(snapshot.manifestDigest) &&
    typeof snapshot.sourceTree === "string" && /^[a-f0-9]{40}$/u.test(snapshot.sourceTree);
}

function isFreshHermesNativeProfilePath(profileHome: string, authRoot: string, runId: string): boolean {
  if (typeof profileHome !== "string" || typeof authRoot !== "string" ||
      containsControlCharacter(profileHome) || containsControlCharacter(authRoot)) return false;
  const paths = currentHermesPlatform() === "win32" ? path.win32 : path.posix;
  if (!paths.isAbsolute(profileHome) || !paths.isAbsolute(authRoot)) return false;
  const expected = paths.join(authRoot, "profiles", `ebb-orchestrator-run-${runId}`);
  const normalize = (value: string) => paths.normalize(value);
  return currentHermesPlatform() === "win32"
    ? normalize(profileHome).toLocaleLowerCase("en-US") === normalize(expected).toLocaleLowerCase("en-US")
    : normalize(profileHome) === normalize(expected);
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function ownerToScopeIdentity(owner: RunProcessOwner): ProcessScopeIdentity {
  return {
    runId: owner.runId,
    containmentKind: owner.containmentKind,
    containmentId: owner.containmentId,
    launchNonce: owner.launchNonce,
    systemdInvocationId: owner.systemdInvocationId,
    systemdControlGroup: owner.systemdControlGroup,
    supervisorPid: owner.supervisorPid,
    supervisorStartIdentity: owner.supervisorStartIdentity,
    pid: owner.pid,
    platform: owner.platform,
    processStartIdentity: owner.processStartIdentity,
    executableIdentity: owner.executableIdentity,
    state: owner.state,
  };
}

function assertMatchingLiveIdentity(owner: ProcessScopeIdentity, identity: ProcessScopeIdentity): void {
  if (identity.state !== "LIVE" || identity.runId !== owner.runId ||
      identity.containmentKind !== owner.containmentKind || identity.containmentId !== owner.containmentId ||
      identity.launchNonce !== owner.launchNonce) {
    throw new Error("PROCESS_SCOPE_IDENTITY_MISMATCH");
  }
}

function assertSameLiveProcessIdentity(expected: ProcessScopeIdentity, actual: ProcessScopeIdentity): void {
  assertMatchingLiveIdentity(expected, actual);
  if (expected.systemdInvocationId !== actual.systemdInvocationId ||
      expected.systemdControlGroup !== actual.systemdControlGroup ||
      expected.supervisorPid !== actual.supervisorPid ||
      expected.supervisorStartIdentity !== actual.supervisorStartIdentity ||
      expected.pid !== actual.pid || expected.platform !== actual.platform ||
      expected.processStartIdentity !== actual.processStartIdentity ||
      expected.executableIdentity !== actual.executableIdentity) {
    throw new Error("PROCESS_SCOPE_IDENTITY_MISMATCH");
  }
}

function ownerTransitionIdentity(identity: ProcessScopeIdentity) {
  return {
    systemdInvocationId: identity.systemdInvocationId,
    systemdControlGroup: identity.systemdControlGroup,
    supervisorPid: identity.supervisorPid,
    supervisorStartIdentity: identity.supervisorStartIdentity,
    pid: identity.pid,
    platform: identity.platform,
    processStartIdentity: identity.processStartIdentity,
    executableIdentity: identity.executableIdentity,
  };
}

function currentContainmentKind(): RunProcessOwner["containmentKind"] {
  if (process.platform === "win32") return "windows-job";
  if (process.platform === "linux") return "systemd-user-service";
  throw new Error(`RUN_PROCESS_CONTAINMENT_UNSUPPORTED:${process.platform}`);
}

function currentHermesPlatform(): "win32" | "linux" {
  const platform = validatePlatform(process.platform);
  if (platform !== "win32" && platform !== "linux") throw new Error("HERMES_PLATFORM_UNSUPPORTED");
  return platform;
}

function hermesProfilePathHelperPath(platform: "win32" | "linux"): string {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const filename = platform === "win32" ? "ebb-hermes-profile-path.exe" : "ebb-hermes-profile-path";
  return paths.resolve(
    paths.dirname(fileURLToPath(import.meta.url)),
    "../../../../dist/native/hermes-profile-path",
    filename,
  );
}
