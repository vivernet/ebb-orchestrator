/**
 * Hermes runtime adapter - implements AgentRuntime интерфейс.
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
import { loadValidatedCapability } from "../../execution/capability-validation.js";

/**
 * В памяти run state tracking.
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
      checkpointDirectory?: string;
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
    this.checkpointDirectory = config?.checkpointDirectory ?? path.join(os.homedir(), ".orchestrator", "checkpoints");
    this.databasePath = config?.databasePath;
    this.mcpCommand = config?.mcpCommand ?? "ebb-orchestrator-mcp";
    this.mcpArgs = config?.mcpArgs ?? [];
    this.cliBuilder = new HermesCliBuilder();
  }

  /**
   * запускать Объект новый run с Объект указанного options.
   */
  async startRun(run: AgentRun): Promise<void> {
    const abortController = new AbortController();
    const promptFile = await this.writePromptFile(run);
    let workspace = this.getManagedWorktree(run);
    // Экземпляр integration run can be authenticated before its worktree is created.
    // Wait только для callers который explicitly provide per-run workspaces; the
    // legacy/стандартный-путь remains сразу наблюдаемым для unit-test заглушек.
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
      // Экземпляр process that started and returned non-zero is a run outcome. A
      // spawn/launcher ошибка является разный: let RunService atomically fail
      // Объект сохранённый run и отзывает его capability.
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
   * Возобновление a run that was paused.
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
    const state = this.runs.get(runId);
    if (!state) {
      return;
    }

    // отправлять корректный сигнал первый
    if (state.abortController) {
      state.abortController.abort();
    }

    // Жёсткое завершение после timeout (10 seconds)
    const hardKillTimeout = setTimeout(() => {
      // Жёсткое завершение by terminating Объект процесс напрямую
      if (state.pid) {
        try {
          process.kill(state.pid, "SIGKILL");
        } catch {
          // процесс may have уже завершился
        }
      }
    }, 10000);

    // Очищает timeout когда run completes normally
    const cleanup = () => {
      clearTimeout(hardKillTimeout);
    };

    // Обновляет run status
    const updatedRun = { ...state.run, status: "CANCELLED" as RunStatus };
    state.run = updatedRun;
    state.exitCode = -1;

    // CleОбъект up on состояние changes (exit, collect, etc.)
    state.abortController?.signal.addEventListener("abort", cleanup);
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
        sessionId: state.sessionId,
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
