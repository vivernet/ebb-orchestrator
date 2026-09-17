/**
 * Hermes runtime adapter - implements AgentRuntime interface.
 */

import type { AgentRuntime } from "../agent-runtime.js";
import type { AgentRun, RunStatus } from "@ebb-orchestrator/contracts";
import type { RunOutcome } from "../run-types.js";
import { ProcessExecutor, ExitCodeError, type ProcessOptions } from "../../../platform/process/process-executor.js";
import { HermesCliBuilder } from "./hermes-cli.js";
import { generateConfigYaml } from "./hermes-profile.js";
import { parseSessionId } from "./hermes-session-parser.js";
import { validateRoleOutput } from "../output-validator.js";
import * as path from "path";
import * as fs from "fs/promises";
import * as os from "os";
import { createSqliteDatabase } from "../../../platform/database/sqlite-database.js";

/**
 * In-memory run state tracking.
 */
interface RunState {
  run: AgentRun;
  pid: number | null;
  sessionId: string | null;
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

interface RunUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  cost: number;
}

/**
 * Artifact store interface.
 */
interface ArtifactStore {
  saveArtifacts(runId: string, stdout: string, stderr: string, exitCode: number): void;
  getArtifacts(runId: string): { stdout: string; stderr: string; exitCode: number } | undefined;
}

/**
 * In-memory artifact store for testing.
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
 * HermesRuntimeAdapter implements the AgentRuntime interface for the Hermes CLI.
 */
export class HermesRuntimeAdapter implements AgentRuntime {
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
  private readonly exitCodes = new Map<string, number>();
  private readonly databasePath: string | undefined;
  private readonly mcpCommand: string;
  private readonly mcpArgs: string[];

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
      resultDirectory?: string;
      databasePath?: string;
      mcpCommand?: string;
      mcpArgs?: string[];
    }
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
    this.databasePath = config?.databasePath;
    this.mcpCommand = config?.mcpCommand ?? "orchestrator-mcp";
    this.mcpArgs = config?.mcpArgs ?? [];
    this.cliBuilder = new HermesCliBuilder();
  }

  /**
   * Start a new run with the given options.
   */
  async startRun(run: AgentRun): Promise<void> {
    const abortController = new AbortController();
    const promptFile = await this.writePromptFile(run);
    let workspace = this.getManagedWorktree(run);
    // An integration run can be authenticated before its worktree is created.
    // Wait only for callers that explicitly provide per-run workspaces; the
    // legacy/default path remains immediately observable for unit-test fakes.
    if (this.managedWorktreeForRun) workspace = await this.waitForWorkspace(run);
    const profileHome = path.join(this.resultDirectory, "profiles", run.id);
    const resultPath = path.join(this.resultDirectory, `${run.id}.json`);
    await fs.mkdir(path.join(profileHome, "home"), { recursive: true });
    const configOptions = {
      capability: { role: run.role, workspace },
      toolsetPath: "mcp-orchestrator",
      mcpCommand: this.mcpCommand,
      mcpArgs: [...this.mcpArgs, ...(this.databasePath ? ["--database", this.databasePath] : [])],
      resultFile: resultPath,
      ...(run.capabilityRef ? { capabilityRef: run.capabilityRef } : {}),
    };
    await fs.writeFile(path.join(profileHome, "config.yaml"), generateConfigYaml(configOptions));

    const args = this.cliBuilder.buildLaunchArgs({
      queryFile: promptFile,
      model: run.model,
      toolsets: this.toolsets,
      worktree: workspace,
      ignoreRules: this.ignoreRules,
      source: "tool",
      maxTurns: this.roleLimit,
    });

    const options: ProcessOptions = {
      cwd: workspace,
      env: this.buildEnvironment(run, profileHome),
      timeout: this.timeoutMs,
      signal: abortController.signal,
    };

    let processOutput: { stdout: string; stderr: string; exitCode: number };

    try {
      const result = await this.executor.exec("hermes", args, options);
      processOutput = { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
      this.exitCodes.set(run.id, result.exitCode);
    } catch (error) {
      const processError = error instanceof ExitCodeError ? error : undefined;
      // A process that started and returned non-zero is a run outcome. A
      // spawn/launcher failure is different: let RunService atomically fail
      // the persisted run and revoke its capability.
      if (!processError) throw error;
      processOutput = { stdout: processError?.stdout ?? "", stderr: processError?.stderr ?? (error as Error).message, exitCode: processError?.exitCode ?? -1 };
      this.exitCodes.set(run.id, processOutput.exitCode);
    }

    const sessionId = parseSessionId(processOutput?.stdout ?? "");
    const pid = this.extractPid(processOutput?.stdout ?? "");
    this.artifactStore.saveArtifacts(run.id, processOutput.stdout, processOutput.stderr, processOutput.exitCode);

    const state: RunState = {
      run: { ...run, status: "IN_PROGRESS" as RunStatus, sessionId },
      pid: pid || null,
      sessionId: sessionId || null,
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

  /**
   * Resume a run that was paused.
   */
  async resumeRun(runId: string, options: { sessionId: string; attempt: number }): Promise<void> {
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

    // Update existing state in place
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
      // Keep the restored workspace available to the normal resolver without making
      // resume dependent on the process that created the original map entry.
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
   * Cancel an in-progress run.
   */
  async cancelRun(runId: string): Promise<void> {
    const state = this.runs.get(runId);
    if (!state) {
      return;
    }

    // Send graceful signal first
    if (state.abortController) {
      state.abortController.abort();
    }

    // Hard kill after timeout (10 seconds)
    const hardKillTimeout = setTimeout(() => {
      // Hard kill by terminating the process directly
      if (state.pid) {
        try {
          process.kill(state.pid, "SIGKILL");
        } catch {
          // Process may have already exited
        }
      }
    }, 10000);

    // Clear timeout when run completes normally
    const cleanup = () => {
      clearTimeout(hardKillTimeout);
    };

    // Update run status
    const updatedRun = { ...state.run, status: "CANCELLED" as RunStatus };
    state.run = updatedRun;
    state.exitCode = -1;

    // Clean up on state changes (exit, collect, etc.)
    state.abortController?.signal.addEventListener("abort", cleanup);
  }

  /**
   * Inspect the current state of a run.
   */
  async inspectRun(runId: string): Promise<AgentRun> {
    const state = this.runs.get(runId);
    if (!state) {
      throw new Error(`Run ${runId} not found`);
    }
    return state.run;
  }

  /**
   * Collect the result from a run.
   */
  async collectResult(runId: string): Promise<RunOutcome> {
    const state = this.runs.get(runId);
    if (!state) {
      throw new Error(`Run ${runId} not found`);
    }

    // Re-read the run-bound artifact on every collection. The cached value is
    // only an optimization for process bookkeeping and is never authoritative.
    const submittedResult = await this.readSubmittedResult(runId, state.run.role);
    if (!submittedResult) {
      return {
        success: false,
        exitCode: state.exitCode ?? -1,
        output: "AGENT_OUTPUT_MISSING",
        validatedSubmission: false,
        diagnostics: {
          runId,
          sessionId: state.sessionId,
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
        sessionId: state.sessionId,
        stderr: state.stderr,
        exitCode: state.exitCode ?? -1,
        artifactReferences: [state.resultPath, `run-artifacts://${runId}`],
      },
    };
  }

  /**
   * Collect token usage from a run.
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
   * Check if the runtime is healthy.
   */
  async healthCheck(): Promise<boolean> {
    return true;
  }

  /**
   * Write prompt body to a temporary file.
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
   * Build environment variables for hermes process.
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

  /**
   * Get the managed worktree path for a run.
   */
  private getManagedWorktree(run: AgentRun): string {
    return this.managedWorktreeForRun?.(run) ?? this.managedWorktree ?? (run as AgentRun & { __workspace?: string }).__workspace ?? path.join(os.homedir(), "worktrees", run.id);
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
        // The per-run resolver may publish the worktree asynchronously.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Hermes workspace is unavailable for run ${run.id}`);
  }

  /**
   * Get checkpoint path for a run.
   */
  private async getCheckpointPath(runId: string): Promise<string> {
    const checkpointDir = path.join(os.homedir(), ".orchestrator", "checkpoints");
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
      // The file is a transport artifact, not the source of truth. A valid
      // MCP submit_result also atomically persists the exact JSON in SQLite;
      // this fallback is essential after a Windows process exits before the
      // result-file flush completes (and after an adapter restart).
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
   * Extract process ID from hermes output.
   */
  private extractPid(stdout: string): number | null {
    const pidPattern = /pid:\s*(\d+)/;
    const match = stdout.match(pidPattern);
    return match?.[1] ? parseInt(match[1], 10) : null;
  }
}
