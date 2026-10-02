/**
 * Hermes runtime adapter - implements AgentRuntime интерфейс.
 */

import type { AgentRuntime } from "../agent-runtime.js";
import type { AgentRun, RunStatus } from "@ebb-orchestrator/contracts";
import type { RunOutcome } from "../run-types.js";
import { ProcessExecutor, ExitCodeError, type ProcessOptions, type ProcessResult } from "../../../platform/process/process-executor.js";
import { HermesCliBuilder } from "./hermes-cli.js";
import { generateConfigYaml } from "./hermes-profile.js";
import { parseSessionId } from "./hermes-session-parser.js";
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
import { getRunProcessOwner, isCanonicalRunProcessStopEvidence, prepareRunProcessOwner, transitionRunProcessOwnerTx, type RunProcessOwner, type RunProcessOwnerState } from "../run-process-owner.js";

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
export class HermesRuntimeAdapter implements AgentRuntime {
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
  private readonly mcpCommand: string;
  private readonly mcpArgs: string[];
  private readonly processScopeSupervisor: ProcessScopeSupervisor | undefined;
  private readonly activeScopes = new Map<string, { owner: ProcessScopeIdentity; durable: boolean; abortController: AbortController }>();
  private readonly startingRuns = new Map<string, RunStartControl>();

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
    this.environment = config?.environment;
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
    this.cliBuilder = new HermesCliBuilder();
  }

  /**
   * запускать Объект новый run с Объект указанного options.
   */
  startRun(run: AgentRun): Promise<void> {
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

  private async startRunWithControl(run: AgentRun, control: RunStartControl): Promise<void> {
    const supervisor = this.processScopeSupervisor;
    if (!supervisor) throw new Error("PROCESS_SCOPE_SUPERVISOR_REQUIRED");
    this.assertNativeHermesAuthReady();
    if (this.finishCancelledBeforeLaunch(run.id, control)) return;
    const abortController = control.abortController;
    const promptFile = await this.writePromptFile(run);
    if (this.finishCancelledBeforeLaunch(run.id, control)) return;
    let workspace = this.getManagedWorktree(run);
    // Экземпляр integration run can be authenticated before its worktree is created.
    // Wait только для callers который explicitly provide per-run workspaces; the
    // legacy/стандартный-путь remains сразу наблюдаемым для unit-test заглушек.
    if (this.managedWorktreeForRun) {
      workspace = await this.waitForWorkspace(run);
      if (this.finishCancelledBeforeLaunch(run.id, control)) return;
    }
    const defaultProfileHome = path.join(this.resultDirectory, "profiles", run.id);
    const preparedOwner = this.loadProcessOwner(run.id, defaultProfileHome);
    const profileHome = preparedOwner.hermesHome;
    const resultPath = path.join(this.resultDirectory, `${run.id}.json`);
    await fs.mkdir(path.join(profileHome, "home"), { recursive: true });
    if (this.finishCancelledBeforeLaunch(run.id, control)) return;
    const configOptions = {
      capability: { role: run.role, workspace },
      toolsetPath: "mcp-orchestrator",
      mcpCommand: this.mcpCommand,
      mcpArgs: [...this.mcpArgs, ...(this.databasePath ? ["--database", this.databasePath] : [])],
      resultFile: resultPath,
      ...(run.capabilityRef ? { capabilityRef: run.capabilityRef } : {}),
    };
    await fs.writeFile(path.join(profileHome, "config.yaml"), generateConfigYaml(configOptions));
    if (this.finishCancelledBeforeLaunch(run.id, control)) return;

    const args = this.cliBuilder.buildLaunchArgs({
      queryFile: promptFile,
      model: run.model,
      toolsets: this.toolsets,
      worktree: workspace,
      ignoreRules: this.ignoreRules,
      source: preparedOwner.sourceTag,
      maxTurns: this.roleLimit,
    });

    if (control.cancelled || abortController.signal.aborted) {
      this.markNeverLaunched(preparedOwner.runId);
      control.stopProven = true;
      return;
    }

    let processOutput: ProcessResult;
    try {
      processOutput = await this.launchScopedRun(supervisor, preparedOwner, {
        executable: "hermes",
        args,
        cwd: workspace,
        environment: this.buildEnvironment(run, profileHome),
        signal: abortController.signal,
        timeoutMs: this.timeoutMs,
      }, abortController, control);
    } catch (error) {
      if (control.cancelled && control.stopProven) return;
      throw error;
    }
    if (control.cancelled) {
      this.assertStopProof(run.id, control);
      return;
    }
    this.exitCodes.set(run.id, processOutput.exitCode);

    const observedSessionId = parseSessionId(processOutput?.stdout ?? "");
    const pid = this.extractPid(processOutput?.stdout ?? "");
    this.artifactStore.saveArtifacts(run.id, processOutput.stdout, processOutput.stderr, processOutput.exitCode);

    const state: RunState = {
      run: { ...run, status: "IN_PROGRESS" as RunStatus, sessionId: null },
      pid: pid || null,
      sessionId: null,
      observedSessionId: observedSessionId || null,
      stdout: processOutput.stdout,
      stderr: processOutput.stderr,
      exitCode: processOutput.exitCode,
      startTime: new Date(),
      abortController,
      checkpointPath: await this.getCheckpointPath(run.id),
      submittedResult: await this.readSubmittedResult(run.id, run.role),
      resultPath,
      usage: this.parseUsage(processOutput.stdout),
    };

    this.runs.set(run.id, state);
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
      const handle = await supervisor.launch(owner, request, async (identity) => {
        assertMatchingLiveIdentity(owner, identity);
        // Keep the exact OS identity available even if the durable LIVE CAS fails;
        // the failure path must still stop that exact scope before returning.
        liveIdentity = identity;
        if (control.cancelled || abortController.signal.aborted) {
          throw new Error("RUN_CANCELLED_BEFORE_LAUNCH_AUTHORIZATION");
        }
        if (durable) this.transitionOwner(owner, "LAUNCHING", "LIVE", identity);
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
        if (durable) this.transitionOwner(owner, "LAUNCHING", "STOPPED", undefined, "NEVER_LAUNCHED");
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

  private persistStopped(owner: ProcessScopeIdentity, evidence: string): void {
    if (!this.databasePath) return;
    let state = this.readPersistedOwnerState(owner.runId);
    if (!state) throw new Error("RUN_PROCESS_OWNER_MISSING");
    if (state === "STOPPED") {
      const persisted = this.readPersistedOwner(owner.runId);
      if (!persisted || !isCanonicalRunProcessStopEvidence(persisted.stopEvidence)) {
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
        !isCanonicalRunProcessStopEvidence(persisted.stopEvidence)) {
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
      } else if (owner.state !== "STOPPED" || !isCanonicalRunProcessStopEvidence(owner.stopEvidence)) {
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
      if (!owner || owner.state !== "STOPPED" || !isCanonicalRunProcessStopEvidence(owner.stopEvidence)) {
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
      const value = this.environment?.[key] ?? (key === "HERMES_HOME" && profileHome ? profileHome : undefined);
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

  /** Fail closed until Task5B verifies the configured Hermes-native auth path through the isolated profile. */
  private assertNativeHermesAuthReady(): void {
    throw new Error("HERMES_NATIVE_AUTH_NOT_READY");
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
