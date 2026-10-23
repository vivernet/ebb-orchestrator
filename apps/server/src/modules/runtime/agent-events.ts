/**
 * Эфемерные события наблюдаемого Run.
 *
 * События существуют только в памяти процесса, не сохраняются в SQLite/outbox
 * и не replay-ятся после перезапуска. Payload содержит только identity Run/tool,
 * terminal статус и allowlisted категорию ошибки — без prompt, tool arguments,
 * stdout или result payload. Никакое событие не запускает state transition и не
 * является authority для completion/cancellation/recovery.
 */

import type { RuntimeDiagnosticToolId, RuntimeToolErrorCategory } from "./run-types.js";

/**
 * Discriminated union эфемерных событий наблюдаемого Run.
 * - `run_started` — Run принят runtime на текущую попытку исполнения.
 * - `tool_pending` — разрешённый диагностический tool вызван агентом.
 * - `tool_result` — результат вызова разрешённого инструмента: только boolean
 *   `success` и, при ошибке, фиксированная `errorCategory`.
 * - `run_finished` — Run переведён в terminal статус после его сохранения.
 */
export type AgentEvent =
  | { readonly type: "run_started"; readonly runId: string; readonly occurredAt: string }
  | { readonly type: "tool_pending"; readonly runId: string; readonly toolId: RuntimeDiagnosticToolId }
  | {
      readonly type: "tool_result";
      readonly runId: string;
      readonly toolId: RuntimeDiagnosticToolId;
      readonly success: boolean;
      readonly errorCategory?: RuntimeToolErrorCategory;
    }
  | { readonly type: "run_finished"; readonly runId: string; readonly status: "COMPLETED" | "FAILED" | "CANCELLED" };

/** Синхронный приёмник эфемерных событий Run. */
export interface AgentEventSink {
  emit(event: AgentEvent): void;
}

/** Подписчик на эфемерные события Run. */
export type AgentEventListener = (event: AgentEvent) => void;

/**
 * Process-local шина событий Run.
 *
 * Подписчики вызываются синхронно в порядке регистрации; ошибка одного
 * подписчика не прерывает доставку остальным и не влияет на outcome Run.
 */
export class AgentEventBus implements AgentEventSink {
  private readonly listeners = new Set<AgentEventListener>();

  /**
   * Регистрирует подписчика.
   * @param listener Обработчик событий.
   * @returns Функция отписки.
   */
  addListener(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Публикует событие всем подписчикам; ошибки подписчиков поглощаются.
   * @param event Эфемерное событие Run.
   */
  emit(event: AgentEvent): void {
    if (this.listeners.size === 0) return;
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(event);
      } catch {
        // Доставка событий не является authority для Run lifecycle.
      }
    }
  }
}
