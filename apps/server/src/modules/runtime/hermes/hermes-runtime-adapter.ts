/**
 * Hermes runtime adapter - implements AgentRuntime интерфейс.
 */

import type { AgentRuntime, AgentRuntimeRun } from "../agent-runtime.js";
import type { AgentRun, RunStatus } from "@ebb-orchestrator/contracts";
import type { RunOutcome } from "../run-types.js";
import { ProcessExecutor, type ProcessResult } from "../../../platform/process/process-executor.js";
import { HermesCliBuilder } from "./hermes-cli.js";
import { buildHermesMcpServer } from "./hermes-mcp-server.js";
import { parseSessionId } from "./hermes-session-parser.js";
import { HermesStreamSessionObserver } from "./hermes-stream-session-observer.js";
import type { HermesSubmitResultStreamCounts, HermesToolEventCounts } from "./hermes-stream-session-observer.js";
import type { HermesSessionCapture, HermesSessionCaptureFailure, HermesSessionCapturePort } from "../hermes-session-capture-port.js";
import {
  createHermesLaunchTicket,
  type HermesLaunchTicketFactory,
} from "./hermes-launch-ticket.js";
import {
  buildHermesInstalledRuntimeArgs,
  resolveHermesExecutable,
} from "./hermes-executable-resolver.js";
import type { HermesManagedRunSelection, HermesRunSelectionPreflight, HermesRuntimeSelection } from "./hermes-run-selection.js";
import { validateRoleOutput } from "../output-validator.js";
import * as path from "path";
import * as fs from "fs/promises";
import * as os from "os";
import { createSqliteDatabase } from "../../../platform/database/sqlite-database.js";
import { loadValidatedCapability } from "../../execution/capability-validation.js";
import { validatePlatform, type Platform } from "../../../platform/config/app-config.js";
import { resolveOrchestratorHome, type HomeEnv } from "../../../platform/home/orchestrator-home.js";
import { ProcessScopeLaunchNotDispatchedError, type ProcessScopeLaunchRequest, type ProcessScopeSupervisor } from "../../../platform/process/run-scope-supervisor.js";
import type { ProcessScopeIdentity, ProcessScopeObservation } from "../../../platform/process/process-inspector.js";
import { getRunProcessOwner, isAuthoritativeRunProcessStopEvidence, prepareRunProcessOwner, syncCurrentRunProcessGenerationTx, transitionRunProcessOwnerTx, type RunProcessOwner, type RunProcessOwnerState } from "../run-process-owner.js";

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
  stderrCategory: NonNullable<NonNullable<RunOutcome["diagnostics"]>["stderrCategory"]>;
  exitCode: number | null;
  startTime: Date;
  abortController: AbortController | null;
  checkpointPath: string | null;
  submittedResult: string | null;
  resultPath: string;
  usage: RunUsage | null;
  submitResultCounts?: HermesSubmitResultStreamCounts;
  toolEventCounts?: HermesToolEventCounts;
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
  cost: number | null;
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
  private readonly ignoreRules: boolean;
  private readonly managedWorktree: string | undefined;
  private readonly managedWorktreeForRun: ((run: AgentRun) => string) | undefined;
  private readonly environment: Record<string, string> | undefined;
  private readonly resultDirectory: string;
  private readonly checkpointDirectory: string;
  private readonly exitCodes = new Map<string, number>();
  private readonly databasePath: string | undefined;
  private readonly mcpCommand: string;
  private readonly mcpArgs: string[];
  private readonly processScopeSupervisor: ProcessScopeSupervisor | undefined;
  private readonly hermesLaunchTicketFactory: HermesLaunchTicketFactory | undefined;
  private readonly verifiedManagedSelections = new WeakSet<HermesManagedRunSelection>();
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
      mcpCommand?: string;
      mcpArgs?: string[];
      /** Test seam; production проверяет executable/source identity до запуска. */
      hermesLaunchTicketFactory?: HermesLaunchTicketFactory;
    },
    processScopeSupervisor?: ProcessScopeSupervisor,
  ) {
    this.executor = executor;
    this.artifactStore = artifactStore ?? new InMemoryArtifactStore();
    this.timeoutMs = config?.timeoutMs ?? 300000; // 5 minutes default
    this.roleLimit = config?.roleLimit ?? 500;
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
    this.mcpCommand = config?.mcpCommand ?? "ebb-orchestrator-mcp";
    this.mcpArgs = config?.mcpArgs ?? [];
    this.processScopeSupervisor = processScopeSupervisor;
    this.hermesLaunchTicketFactory = config?.hermesLaunchTicketFactory;
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
   * Находит установленный Hermes и фиксирует identity исполняемых файлов для этого Run.
   * Provider, model и auth settings читает сам Hermes из общего профиля пользователя.
   *
   * @param runId UUID будущего Run, уже созданный Orchestrator до внешнего/SQLite side effect.
   * @returns Hermes home и краткую identity установленного launcher/Python.
   * @throws {Error} Если Run UUID или установленный Hermes не разрешаются.
   */
  async prepareHermesRunSelection(runId: string): Promise<HermesRunSelectionPreflight> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(runId)) {
      throw new Error("HERMES_RUN_SELECTION_BINDING_MISMATCH");
    }
    const resolution = await resolveHermesExecutable({ cwd: process.cwd(), environment: this.configuredEnvironment() });
    const runtimeIdentity = JSON.stringify({
      platform: resolution.executableIdentity.platform,
      hermes: resolution.executableIdentity,
      python: resolution.runtimeExecutableIdentity,
    });
    const selection: HermesManagedRunSelection = Object.freeze({
      mode: "HERMES_MANAGED", runId, hermesHome: resolution.hermesConfigHome,
      runtimeIdentity,
    });
    this.verifiedManagedSelections.add(selection);
    return { selection };
  }

  /** Подключает awaited RunService sink для allowlisted live Hermes session evidence. */
  setHermesSessionCaptureHandler(handler: (capture: HermesSessionCapture) => Promise<void>): void {
    if (this.hermesSessionCaptureHandler && this.hermesSessionCaptureHandler !== handler) {
      throw new Error("HERMES_SESSION_CAPTURE_HANDLER_ALREADY_BOUND");
    }
    this.hermesSessionCaptureHandler = handler;
  }

  private async startRunWithControl(run: AgentRuntimeRun, control: RunStartControl, resumeSessionId?: string): Promise<void> {
    const supervisor = this.processScopeSupervisor;
    if (!supervisor) throw new Error("PROCESS_SCOPE_SUPERVISOR_REQUIRED");
    const hermesSelection = run.hermesSelection;
    if (!hermesSelection || !("mode" in hermesSelection) || hermesSelection.mode !== "HERMES_MANAGED" || hermesSelection.runId !== run.id ||
        !hermesSelection.runtimeIdentity) {
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
    const preparedOwner = this.loadProcessOwner(run.id, hermesSelection.hermesHome);
    this.assertManagedHermesReady(run, preparedOwner, hermesSelection);
    const abortController = control.abortController;
    const hermesHome = preparedOwner.hermesHome;
    const resultPath = path.join(this.resultDirectory, `${run.id}.json`);
    let args: string[];
    if (resumeSessionId !== undefined) {
      if (!/^[A-Za-z0-9_-]{1,256}$/.test(resumeSessionId)) throw new Error("RESUME_ORIGINAL_SESSION_UNAVAILABLE");
      if (typeof run.prompt !== "string" || !run.prompt.trim()) throw new Error("HERMES_RESUME_PROMPT_UNAVAILABLE");
      const queryFile = await this.writePromptFile(run, [
        "Resume the interrupted Orchestrator task in this existing session.",
        "First inspect the restored conversation and current workspace state, including persisted tool results, using the permitted Orchestrator tools.",
        "Continue only the remaining work. Do not repeat completed actions or a successful submit_result. The original task below is repeated to recover a possible interruption before its first delivery; it is not a new task.",
        "Use the original task's execution and output contract. If no successful result was submitted, submit one successful structured result with submit_result before ending; correct validation errors and retry, then stop submitting after success.",
        "Original persisted task and execution contract:",
        run.prompt,
      ].join("\n\n"));
      args = this.cliBuilder.buildResumeArgs({
        sessionId: resumeSessionId, queryFile, toolsets: ["mcp-ebb-orchestrator"], worktree: workspace,
        ignoreRules: this.ignoreRules, source: preparedOwner.sourceTag, maxTurns: this.roleLimit,
      });
    } else {
      const promptFile = await this.writePromptFile(run);
      args = this.cliBuilder.buildLaunchArgs({
        queryFile: promptFile, toolsets: ["mcp-ebb-orchestrator"], worktree: workspace,
        ignoreRules: this.ignoreRules, source: preparedOwner.sourceTag, maxTurns: this.roleLimit,
      });
    }
    if (this.finishCancelledBeforeLaunch(run.id, control)) return;
    const environment = this.buildEnvironment(run, hermesHome);

    if (control.cancelled || abortController.signal.aborted) {
      this.markNeverLaunched(preparedOwner.runId);
      control.stopProven = true;
      return;
    }

    const preparedLaunch = await this.createLaunchAuthorization(run, workspace, hermesHome, environment, resultPath);

    let processOutput: ProcessResult;
    const sessionObserver = this.hermesSessionCaptureHandler ? new HermesStreamSessionObserver() : undefined;
    let liveCaptureOwner: ProcessScopeIdentity | undefined;
    let captureInvalidReported = false;
    let captureInvalidReason: HermesSessionCaptureFailure | undefined;
    const reportInvalidCapture = async (owner: ProcessScopeIdentity, reason: HermesSessionCaptureFailure): Promise<void> => {
      if (!sessionObserver || !this.hermesSessionCaptureHandler || captureInvalidReported) return;
      captureInvalidReason = reason;
      await this.hermesSessionCaptureHandler({
        runId: run.id, attempt: run.attempt, sourceTag: preparedOwner.sourceTag,
        hermesHome, owner, status: "invalid", reason,
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
          hermesHome, owner, status: "captured",
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
    const startupDiagnostic = new HermesStartupStderrClassifier();
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
        ...(this.hermesSessionCaptureHandler ? { onStderrChunk: (chunk) => startupDiagnostic.write(chunk) } : {}),
      }, abortController, control, onStdoutChunk, (identity) => { liveCaptureOwner = identity; });
    } catch (error) {
      if (control.cancelled && control.stopProven) {
        await settleSessionCapture();
        return;
      }
      const captureSettlement = await settleSessionCapture(true);
      if (captureSettlement === "INVALID" && error instanceof Error &&
          error.message === "HERMES_SESSION_STREAM_INVALID" && captureInvalidReason) {
        const diagnostic = captureInvalidReason === "MISSING_INIT" ? startupDiagnostic.failure : undefined;
        if (diagnostic) throw new Error(diagnostic, { cause: error });
        const category = captureInvalidReason === "MISSING_INIT" ? `:CATEGORY_${startupDiagnostic.category}` : "";
        throw new Error(`HERMES_SESSION_STREAM_INVALID:${captureInvalidReason ?? "MISSING_INIT"}${category}`, { cause: error });
      }
      if (error instanceof Error && error.message === "WINDOWS_HELPER_PAYLOAD_CALLBACK_FAILED" &&
          captureInvalidReason && captureInvalidReason !== "MISSING_INIT") {
        throw new Error(`WINDOWS_HELPER_PAYLOAD_CALLBACK_FAILED:${captureInvalidReason}`, { cause: error });
      }
      throw error;
    }
    const captureSettlement = await settleSessionCapture();
    if (captureSettlement === "INVALID") {
      if (captureInvalidReason === "MISSING_INIT" && startupDiagnostic.failure) throw new Error(startupDiagnostic.failure);
      throw new Error(`HERMES_SESSION_STREAM_INVALID:${captureInvalidReason ?? "MISSING_INIT"}:EXIT_${processOutput.exitCode}:CATEGORY_${startupDiagnostic.category}`);
    }
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
      stderrCategory: this.hermesSessionCaptureHandler
        ? startupDiagnostic.category
        : classifyHermesStderr(processOutput.stderr),
      exitCode: processOutput.exitCode,
      startTime: new Date(),
      abortController,
      checkpointPath: await this.getCheckpointPath(run.id),
      submittedResult: await this.readSubmittedResult(run.id, run.role),
      resultPath,
      usage: this.hermesSessionCaptureHandler
        ? (sessionObserver?.usage ? { ...sessionObserver.usage, cost: null } : null)
        : this.parseUsage(processOutput.stdout),
      ...(sessionObserver ? { submitResultCounts: sessionObserver.submitResultCounts } : {}),
      ...(sessionObserver ? { toolEventCounts: sessionObserver.toolEventCountsSnapshot } : {}),
    };

    this.runs.set(run.id, state);
  }

  private async createLaunchAuthorization(
    run: AgentRuntimeRun,
    cwd: string,
    hermesHome: string,
    environment: Record<string, string>,
    resultPath: string,
  ) {
    const selection = run.hermesSelection;
    const input = {
      runId: run.id,
      attempt: run.attempt,
      cwd,
      hermesHome,
      mcpServer: buildHermesMcpServer({
        ...(run.capabilityRef ? { capabilityRef: run.capabilityRef } : {}), resultFile: resultPath,
        mcpCommand: this.mcpCommand,
        mcpArgs: [...this.mcpArgs, ...(this.databasePath ? ["--database", this.databasePath] : [])],
      }),
      environment: {
        ...(environment.HOMEDRIVE === undefined ? {} : { HOMEDRIVE: environment.HOMEDRIVE }),
        ...(environment.HOMEPATH === undefined ? {} : { HOMEPATH: environment.HOMEPATH }),
        ...(environment.USERPROFILE === undefined ? {} : { USERPROFILE: environment.USERPROFILE }),
        ...(environment.LOCALAPPDATA === undefined ? {} : { LOCALAPPDATA: environment.LOCALAPPDATA }),
        ...(environment.HERMES_HOME === undefined ? {} : { HERMES_HOME: environment.HERMES_HOME }),
        ...(environment.HERMES_PROFILE === undefined ? {} : { HERMES_PROFILE: environment.HERMES_PROFILE }),
        ...(environment.HERMES_MODEL === undefined ? {} : { HERMES_MODEL: environment.HERMES_MODEL }),
        ...(environment.HOME === undefined ? {} : { HOME: environment.HOME }),
        ...(environment.HERMES_CONFIG === undefined ? {} : { HERMES_CONFIG: environment.HERMES_CONFIG }),
        ...(environment.HERMES_DATA_DIR_SUFFIX === undefined ? {} : { HERMES_DATA_DIR_SUFFIX: environment.HERMES_DATA_DIR_SUFFIX }),
        ...(environment.HERMES_RUNTIME_DIR === undefined ? {} : { HERMES_RUNTIME_DIR: environment.HERMES_RUNTIME_DIR }),
      },
    };
    if (this.hermesLaunchTicketFactory) return this.hermesLaunchTicketFactory(input);
    if (!selection || selection.runId !== run.id || !selection.runtimeIdentity) {
      throw new Error("HERMES_RUN_SELECTION_UNAVAILABLE");
    }
    const platform = currentHermesPlatform();
    const resolution = await resolveHermesExecutable({ cwd, environment: this.configuredEnvironment() });
    if (resolution.executableIdentity.platform !== platform ||
        normalizeManagedRuntimeIdentity(selection.runtimeIdentity) !== runtimeIdentityFor(resolution)) {
      throw new Error("HERMES_RUNTIME_IDENTITY_CHANGED");
    }
    const executableArgsPrefix = buildHermesInstalledRuntimeArgs({
      hermesProjectRoot: resolution.hermesProjectRoot,
      sourceCommit: resolution.sourceCommit,
      runtimeExecutablePath: resolution.runtimeExecutablePath,
      hermesHome: resolution.hermesConfigHome,
      mcpServer: input.mcpServer,
    });
    const ticket = createHermesLaunchTicket({
      ...input,
      platform: resolution.executableIdentity.platform,
      hermesExecutablePath: resolution.executablePath,
      hermesExecutableIdentity: resolution.executableIdentity,
      sourceCommit: resolution.sourceCommit,
      executablePath: resolution.runtimeExecutablePath,
      executableIdentity: resolution.runtimeExecutableIdentity,
      executableArgsPrefix,
    });
    // Platform supervisors verify the installed entrypoints and own the complete Run process scope.
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
        syncCurrentRunProcessGenerationTx(tx, runId);
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
  async resumeRun(runId: string, options: {
    sessionId: string;
    attempt: number;
    hermesSelection?: HermesRuntimeSelection;
  }): Promise<void> {
    if (!this.databasePath || !this.processScopeSupervisor) throw new Error("HERMES_RESUME_DURABLE_RUNTIME_REQUIRED");
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(options.sessionId) || !Number.isSafeInteger(options.attempt) || options.attempt < 1) {
      throw new Error("RESUME_ORIGINAL_SESSION_UNAVAILABLE");
    }
    if (this.startingRuns.has(runId) || this.activeScopes.has(runId)) throw new Error("RUN_START_ALREADY_IN_PROGRESS");
    const selection = options.hermesSelection;
    if (!selection || !("mode" in selection) || selection.mode !== "HERMES_MANAGED" || selection.runId !== runId ||
        !selection.runtimeIdentity || !this.verifiedManagedSelections.has(selection)) {
      throw new Error("HERMES_RUN_SELECTION_UNAVAILABLE");
    }
    const database = createSqliteDatabase(this.databasePath);
    let run: AgentRuntimeRun;
    try {
      const row = database.get<Record<string, unknown>>("SELECT * FROM agent_runs WHERE id=$runId", { runId });
      const binding = database.get<{ original_session_id: string | null }>(
        "SELECT original_session_id FROM run_resume_bindings WHERE run_id=$runId", { runId });
      const owner = getRunProcessOwner(database, runId);
      if (!row || row.status !== "IN_PROGRESS" || row.attempt !== options.attempt || row.session_id !== options.sessionId ||
          binding?.original_session_id !== options.sessionId || !row.capability_ref || owner?.state !== "PREPARED" ||
          owner.hermesHome !== selection.hermesHome || row.output !== null || row.ended_at !== null) {
        throw new Error("HERMES_RESUME_BINDING_UNAVAILABLE");
      }
      run = {
        id: row.id as string,
        role: row.role as string,
        runtime: row.runtime as string,
        model: row.model as string,
        taskId: row.task_id as string | null,
        epicId: row.epic_id as string | null,
        status: row.status as RunStatus,
        sessionId: row.session_id as string | null,
        attempt: row.attempt as number | null,
        triggerReason: row.trigger_reason as AgentRun["triggerReason"],
        contextVersion: row.context_version as string | null,
        outputSchemaVersion: row.output_schema_version as string | null,
        startedAt: row.started_at ? new Date(row.started_at as string) : null,
        endedAt: row.ended_at ? new Date(row.ended_at as string) : null,
        exitCode: row.exit_code as number | null,
        inputTokens: row.input_tokens as number | null,
        cachedInputTokens: row.cached_input_tokens as number | null,
        outputTokens: row.output_tokens as number | null,
        cost: row.cost as number | null,
        ...(typeof row.prompt === "string" ? { prompt: row.prompt } : {}),
        capabilityRef: row.capability_ref as string,
        hermesSelection: selection,
      };
    } finally {
      database.close();
    }
    const control: RunStartControl = { abortController: new AbortController(), cancelled: false, stopProven: false };
    this.startingRuns.set(runId, control);
    try {
      await this.startRunWithControl(run, control, options.sessionId);
    } finally {
      if (this.startingRuns.get(runId) === control) this.startingRuns.delete(runId);
    }
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
          stderrCategory: state.stderrCategory,
          exitCode: state.exitCode ?? -1,
          artifactReferences: [state.resultPath, `run-artifacts://${runId}`],
          ...(state.submitResultCounts ? { submitResultToolUses: state.submitResultCounts.toolUses } : {}),
          ...(state.submitResultCounts ? {
            submitResultCalls: state.submitResultCounts.calls,
            submitResultErrors: state.submitResultCounts.errors,
          } : {}),
          ...(state.toolEventCounts ? { toolCounts: state.toolEventCounts } : {}),
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
        stderrCategory: state.stderrCategory,
        exitCode: state.exitCode ?? -1,
        artifactReferences: [state.resultPath, `run-artifacts://${runId}`],
        ...(state.toolEventCounts ? { toolCounts: state.toolEventCounts } : {}),
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
    cost: number | null;
  }> {
    const state = this.runs.get(runId);
    if (!state?.usage) {
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
        stderrCategory: state.stderrCategory,
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
   * Записывает initial prompt или явный continuation turn во временный файл для Hermes CLI.
   */
  private async writePromptFile(run: AgentRun, continuationQuery?: string): Promise<string> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-prompt-"));
    const promptFile = path.join(tempDir, `prompt-${run.id}.txt`);
    const body = continuationQuery ?? run.prompt ?? [
      `Task: ${run.taskId ?? "N/A"}`,
      `Role: ${run.role}`,
      `Context version: ${run.contextVersion ?? ""}`,
      "Use the Orchestrator tools only.",
      "Submit one successful structured result with submit_result before ending. If submit_result returns a validation error, correct the payload and retry; after success, do not call submit_result again.",
    ].join("\n");
    await fs.writeFile(promptFile, body);
    return promptFile;
  }

  /** Передаёт только не-secret переменные, нужные установленному Hermes и OS runtime. */
  private configuredEnvironment(): Record<string, string> {
    const allowed = ["HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "SYSTEMROOT", "TEMP", "TMP", "PATH", "NODE_PATH", "NODE_ENV", "LOCALAPPDATA", "HERMES_DATA_DIR_SUFFIX", "HERMES_RUNTIME_DIR", "HERMES_HOME", "HERMES_CONFIG", "HERMES_PROFILE", "HERMES_MODEL"];
    const environment: Record<string, string> = {};
    for (const key of allowed) {
      const value = this.environment?.[key] ?? process.env[key];
      if (value !== undefined) environment[key] = value;
    }
    for (const key of Object.keys(this.environment ?? {})) {
      if (key === "GITHUB_TOKEN" || key === "SSH_AUTH_SOCK" || key.endsWith("TOKEN") || key.endsWith("SECRET")) {
        throw new Error("Forbidden credential in supplied runtime environment");
      }
      if (!allowed.includes(key)) throw new Error(`Forbidden or unknown Hermes environment variable: ${key}`);
    }
    return environment;
  }

  private buildEnvironment(_run: AgentRun, _hermesHome: string): Record<string, string> {
    return this.configuredEnvironment();
  }

  private assertManagedHermesReady(run: AgentRuntimeRun, owner: RunProcessOwner, selection: HermesManagedRunSelection): void {
    if (!this.verifiedManagedSelections.has(selection) || owner.state !== "PREPARED" ||
        owner.runId !== run.id || owner.sourceTag !== `ebb-run:${run.id}` ||
        owner.hermesHome !== selection.hermesHome || selection.runId !== run.id ||
        !selection.runtimeIdentity) {
      throw new Error("HERMES_RUN_SELECTION_UNAVAILABLE");
    }
  }

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

/** Возвращает безопасную фиксированную категорию stderr без сохранения его текста. */
function classifyHermesStderr(stderr: string): NonNullable<NonNullable<RunOutcome["diagnostics"]>["stderrCategory"]> {
  if (!stderr) return "EMPTY";
  const text = stderr.slice(0, 8_192).toLowerCase();
  if (/\b(?:401|unauthorized|authentication failed|invalid api key)\b/u.test(text)) return "AUTH";
  if (/\b(?:429|rate limit|quota exceeded)\b/u.test(text)) return "RATE_LIMIT";
  if (/\b(?:connection error|connection refused|network unreachable|name resolution|dns error|ssl error)\b/u.test(text)) return "NETWORK";
  if (/\b(?:timeout|timed out)\b/u.test(text)) return "TIMEOUT";
  if (/\b(?:mcp|tool call)\b/u.test(text)) return "MCP";
  if (/\b(?:traceback|exception|fatal error|failed|error)\b/u.test(text)) return "PROCESS_ERROR";
  return "OTHER";
}

/** Сохраняет только фиксированный код Hermes или класс Python exception; текст ошибки не удерживается. */
class HermesStartupStderrClassifier {
  private line = "";
  private overflowed = false;
  private categoryText = "";
  private parsedFailure: string | undefined;
  private static readonly MAX_LINE_CHARACTERS = 192;
  private static readonly MAX_CATEGORY_CHARACTERS = 8_192;

  get category(): NonNullable<NonNullable<RunOutcome["diagnostics"]>["stderrCategory"]> {
    return classifyHermesStderr(this.categoryText);
  }

  get failure(): string | undefined {
    return this.parsedFailure;
  }

  write(chunk: Uint8Array): void {
    if (this.categoryText.length < HermesStartupStderrClassifier.MAX_CATEGORY_CHARACTERS) {
      this.categoryText += Buffer.from(chunk).toString("utf8").slice(0,
        HermesStartupStderrClassifier.MAX_CATEGORY_CHARACTERS - this.categoryText.length);
    }
    if (this.parsedFailure) return;
    for (const character of Buffer.from(chunk).toString("utf8")) {
      if (character === ":" && !this.overflowed &&
          /^(ModuleNotFoundError|ImportError|PermissionError|FileNotFoundError|OSError|RuntimeError|ValueError|TypeError|AttributeError|KeyError|SyntaxError|NameError|UnicodeDecodeError|UnicodeEncodeError)$/u.test(this.line)) {
        this.parsedFailure = `HERMES_PYTHON_STARTUP_EXCEPTION:${this.line}`;
        this.line = "";
        return;
      }
      if (character === "\n") {
        if (!this.overflowed) this.classify(this.line.replace(/\r$/u, ""));
        if (this.parsedFailure) {
          this.line = "";
          this.overflowed = false;
          return;
        }
        this.line = "";
        this.overflowed = false;
      } else if (!this.overflowed && this.line.length < HermesStartupStderrClassifier.MAX_LINE_CHARACTERS) {
        this.line += character;
      } else {
        this.line = "";
        this.overflowed = true;
      }
    }
  }

  private classify(line: string): void {
    if (line === "HERMES_EBB_MCP_REGISTRATION_FAILED") {
      this.parsedFailure = "HERMES_EBB_MCP_REGISTRATION_FAILED";
      return;
    }
    const refusal = /^hermes-refusal-reason: (SESSION_NOT_OWNED|MAX_CONCURRENT_SESSIONS|SESSION_COORDINATION_UNAVAILABLE)$/u.exec(line);
    if (refusal?.[1]) this.parsedFailure = `HERMES_ACTIVE_SESSION_REFUSED:${refusal[1]}`;
  }
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

function runtimeIdentityFor(resolution: Awaited<ReturnType<typeof resolveHermesExecutable>>): string {
  return JSON.stringify({
    platform: resolution.executableIdentity.platform,
    hermes: resolution.executableIdentity,
    python: resolution.runtimeExecutableIdentity,
  });
}

/** Принимает текущую identity и legacy-вариант с диагностическим sourceCommit. */
function normalizeManagedRuntimeIdentity(serialized: string): string | null {
  let value: unknown;
  try { value = JSON.parse(serialized) as unknown; } catch { return null; }
  if (!isRecord(value)) return null;
  const keys = Object.keys(value).sort();
  const expectedKeys = value.sourceCommit === undefined
    ? ["hermes", "platform", "python"]
    : ["hermes", "platform", "python", "sourceCommit"];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) return null;
  if (value.sourceCommit !== undefined && value.sourceCommit !== null &&
      (typeof value.sourceCommit !== "string" || !/^[a-f0-9]{40}$/u.test(value.sourceCommit))) return null;
  if (value.platform !== "win32" && value.platform !== "linux") return null;
  const hermes = normalizeRuntimeObjectIdentity(value.hermes, value.platform);
  const python = normalizeRuntimeObjectIdentity(value.python, value.platform);
  if (!hermes || !python) return null;
  return JSON.stringify({ platform: value.platform, hermes, python });
}

function normalizeRuntimeObjectIdentity(value: unknown, platform: "win32" | "linux"): Record<string, string> | null {
  if (!isRecord(value) || value.platform !== platform) return null;
  const keys = Object.keys(value).sort();
  if (platform === "win32") {
    if (keys.join(",") !== "fileId,platform,volumeSerial" ||
        typeof value.volumeSerial !== "string" || !/^[a-f0-9]{16}$/iu.test(value.volumeSerial) ||
        typeof value.fileId !== "string" || !/^[a-f0-9]{32}$/iu.test(value.fileId)) return null;
    return { platform, volumeSerial: value.volumeSerial, fileId: value.fileId };
  }
  if (keys.join(",") !== "device,inode,platform" ||
      typeof value.device !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value.device) ||
      typeof value.inode !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value.inode)) return null;
  return { platform, device: value.device, inode: value.inode };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
