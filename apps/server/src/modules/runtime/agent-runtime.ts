/**
 * Порт runtime агента - интерфейс для interacting с Объект LLM runtime.
 */

import type { AgentRun } from "@ebb-orchestrator/contracts";
import type { RunOutcome } from "./run-types.js";
import type { HermesRuntimeSelection, HermesRunSelectionPreflight } from "./hermes/hermes-run-selection.js";
import type { RunProviderSelectionRecord } from "./providers/provider-settings-repository.js";

/**
 * AgentRun plus its non-persisted selection for this initial, already-preflighted launch.
 * `providerSelection` — канонический выбор провайдера для provider-рантайма
 * (потребляет Task 5); Hermes-адаптер его игнорирует.
 */
export type AgentRuntimeRun = AgentRun & {
  readonly hermesSelection?: HermesRuntimeSelection;
  readonly providerSelection?: RunProviderSelectionRecord;
};

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
   * Признак поддержки runtime-ом durable provider-привязки
   * (`AgentRuntimeRun.providerSelection`, plan-24 Task 5). Если признак не задан,
   * Run с разрешённым выбором провайдера завершается fail-closed до dispatch.
   */
  supportsProviderSelections?: boolean;

  /**
    * запускать Объект новый run с Объект указанного options.
    */
  startRun(run: AgentRuntimeRun): Promise<void>;

  /** Проверяет установленный Hermes и возвращает selection до SQLite transaction без создания внешних ресурсов. */
  prepareHermesRunSelection?(runId: string): Promise<HermesRunSelectionPreflight>;

  /**
   * Возобновление a run that was paused.
   */
  resumeRun(runId: string, options: {
    sessionId: string;
    attempt: number;
    hermesSelection?: HermesRuntimeSelection;
    /** Исходный durable выбор провайдера из run_provider_selections (загрузка при resume). */
    providerSelection?: RunProviderSelectionRecord;
  }): Promise<void>;

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
    /** NULL означает, что runtime не сообщил стоимость; не подменяется оценкой или нулём. */
    cost: number | null;
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
