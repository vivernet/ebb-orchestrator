/**
 * Порт runtime агента - интерфейс для interacting с Объект LLM runtime.
 */

import type { AgentRun } from "@ebb-orchestrator/contracts";
import type { RunOutcome } from "./run-types.js";
import type { HermesRunSelection, HermesRunSelectionPreflight } from "./hermes/hermes-run-selection.js";

/** AgentRun plus its non-persisted selection for this initial, already-preflighted launch. */
export type AgentRuntimeRun = AgentRun & { readonly hermesSelection?: HermesRunSelection };

export interface AgentRuntime {
  /**
    * число of currently активные runs.
    */
  active: number;
  /**
    * максимальный число of concurrent активные runs.
    */
  maxActive: number;
  /**
    * Записывает of runtime calls.
    */
  calls: Array<{ phase: string; role: string; taskId?: string; targetBranch?: string }>;

  /**
    * запускать Объект новый run с Объект указанного options.
    */
  startRun(run: AgentRuntimeRun): Promise<void>;

  /** Creates and verifies the exact native Hermes profile before a SQLite transaction begins. */
  prepareHermesRunSelection?(runId: string): Promise<HermesRunSelectionPreflight>;

  /**
   * Возобновление a run that was paused.
   */
  resumeRun(runId: string, options: { sessionId: string; attempt: number }): Promise<void>;

  /**
   * Отмена an in-progress run.
   */
  cancelRun(runId: string): Promise<void>;

  /**
   * Inspect Объект текущее состояние of Объект run.
   */
  inspectRun(runId: string): Promise<AgentRun>;

  /**
   * Collect Объект результат из Объект run.
   */
  collectResult(runId: string): Promise<RunOutcome>;

  /**
   * Получает токен использование из Объект run.
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
