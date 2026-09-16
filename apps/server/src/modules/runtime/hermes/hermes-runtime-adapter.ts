/**
 * Hermes runtime adapter - implements AgentRuntime interface.
 */

import type { AgentRuntime } from "../agent-runtime.js";
import type { AgentRun, RunStatus } from "@orchestrator/contracts";
import type { RunOutcome } from "../run-types.js";
import { ProcessExecutor, ExitCodeError, type ProcessOptions } from "../../../platform/process/process-executor.js";
import { HermesCliBuilder } from "./hermes-cli.js";
import { parseSessionId } from "./hermes-session-parser.js";
import { validateRoleOutput } from "../output-validator.js";
import * as path from "path";
import * as fs from "fs/promises";
import * as os from "os";

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
  private readonly environment: Record<string, string> | undefined;
  private readonly resultDirectory: string;
  private readonly exitCodes = new Map<string, number>();

  constructor(
    executor: ProcessExecutor,
    artifactStore?: ArtifactStore,
    config?: {
      timeoutMs?: number;
      roleLimit?: number;
      toolsets?: string[];
      ignoreRules?: boolean;
      managedWorktree?: string;
      environment?: Record<string, string>;
      resultDirectory?: string;
    }
  ) {
    this.executor = executor;
    this.artifactStore = artifactStore ?? new InMemoryArtifactStore();
    this.timeoutMs = config?.timeoutMs ?? 300000; // 5 minutes default
    this.roleLimit = config?.roleLimit ?? 20;
    this.toolsets = config?.toolsets ?? ["mcp-orchestrator"];
    this.ignoreRules = config?.ignoreRules ?? true;
    this.managedWorktree = config?.managedWorktree;
    this.environment = config?.environment;
    this.resultDirectory = config?.resultDirectory ?? path.join(os.tmpdir(), "orchestrator-hermes-results");
    this.cliBuilder = new HermesCliBuilder();
  }

  /**
   * Start a new run with the given options.
   */
  async startRun(run: AgentRun): Promise<void> {
    const abortController = new AbortController();
    const promptFile = await this.writePromptFile(run);

    const args = this.cliBuilder.buildLaunchArgs({
      queryFile: promptFile,
      model: run.model,
      toolsets: this.toolsets,
      worktree: this.getManagedWorktree(run),
      ignoreRules: this.ignoreRules,
      source: "tool",
      maxTurns: this.roleLimit,
    });

    const options: ProcessOptions = {
      cwd: run.taskId ? path.join(os.homedir(), "projects") : os.homedir(),
      env: this.buildEnvironment(run),
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
      resultPath: path.join(this.resultDirectory, `${run.id}.json`),
      usage: this.parseUsage(processOutput.stdout),
    };

    this.runs.set(run.id, state);
  }

  /**
   * Resume a run that was paused.
   */
  async resumeRun(runId: string, options: { sessionId: string; attempt: number }): Promise<void> {
    const existingState = this.runs.get(runId);
    if (!existingState) {
      throw new Error(`Run ${runId} not found`);
    }

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
      cwd: existingState.run.taskId ? path.join(os.homedir(), "projects") : os.homedir(),
      env: this.buildEnvironment(existingState.run),
      timeout: this.timeoutMs,
      signal: abortController.signal,
    };

    let processOutput: { stdout: string; stderr: string; exitCode: number };

    try {
      const result = await this.executor.exec("hermes", args, execOptions);
      processOutput = { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    } catch (error) {
      const processError = error instanceof ExitCodeError ? error : undefined;
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

    if (!state.submittedResult) {
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
      output: state.submittedResult,
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
    await fs.writeFile(promptFile, `Task: ${run.taskId ?? "N/A"}\nRole: ${run.role}\nContext: ${run.contextVersion ?? ""}`);
    return promptFile;
  }

  /**
   * Build environment variables for hermes process.
   */
  private buildEnvironment(_run: AgentRun): Record<string, string> {
    const env: Record<string, string> = {};
    // Copy non-undefined environment variables
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
    if (this.environment?.GITHUB_TOKEN !== undefined || this.environment?.SSH_AUTH_SOCK !== undefined) {
      throw new Error("Forbidden credential in supplied runtime environment");
    }
    Object.assign(env, this.environment);
    // Sanitize after every overlay, including caller-supplied runtime values.
    delete env.GITHUB_TOKEN;
    delete env.SSH_AUTH_SOCK;
    return env;
  }

  /**
   * Get the managed worktree path for a run.
   */
  private getManagedWorktree(run: AgentRun): string {
    return this.managedWorktree ?? path.join(os.homedir(), "worktrees", run.id);
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
      return null;
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
