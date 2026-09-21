/**
 * Agent runtime port - interface for interacting with an LLM runtime.
 */

import type { AgentRun } from "@ebb-orchestrator/contracts";
import type { RunOutcome } from "./run-types.js";

export interface AgentRuntime {
  /**
    * Number of currently active runs.
    */
  active: number;
  /**
    * Maximum number of concurrent active runs.
    */
  maxActive: number;
  /**
    * Записывает of runtime calls.
    */
  calls: Array<{ phase: string; role: string; taskId?: string; targetBranch?: string }>;

  /**
    * Start a new run with the given options.
    */
  startRun(run: AgentRun): Promise<void>;

  /**
   * Возобновление a run that was paused.
   */
  resumeRun(runId: string, options: { sessionId: string; attempt: number }): Promise<void>;

  /**
   * Отмена an in-progress run.
   */
  cancelRun(runId: string): Promise<void>;

  /**
   * Inspect the current state of a run.
   */
  inspectRun(runId: string): Promise<AgentRun>;

  /**
   * Collect the result from a run.
   */
  collectResult(runId: string): Promise<RunOutcome>;

  /**
   * Collect token usage from a run.
   */
  collectUsage(runId: string): Promise<{
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    cost: number;
  }>;

  /**
    * Получает the result from a run.
    */
  runResult(runId: string): Promise<RunOutcome>;

  /**
    * Проверяет if the runtime is healthy.
    */
  healthCheck(): Promise<boolean>;
}
