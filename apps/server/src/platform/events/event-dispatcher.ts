/**
 * Передаёт ожидающие события outbox подписчикам через EventBus.
 */

import type { Database } from "../database/database.js";
import type { DomainEvent } from "./domain-event.js";
import { EventBus } from "./event-bus.js";

interface PendingEventRow {
  id: string;
  type: string;
  aggregate_type: string | null;
  aggregate_id: string | null;
  payload_json: string;
  created_at: string;
  available_at: string;
  attempts: number;
}

const DEFAULT_MAX_ATTEMPTS = 5;

interface ProcessedRow {
  event_id: string;
}

/**
 * Предоставляет публичный контракт модуля event-dispatcher для взаимодействия слоёв приложения.
 */
export class EventDispatcher {
  private readonly supportsDeadLetterColumns: boolean;

  constructor(
    private readonly db: Database,
    private readonly bus: EventBus,
  ) {
    // Некоторые встраиваемые сценарии всё ещё открывают базу только со схемой v1
    // в тестах и recovery-инструментах. Production-миграции всегда добавляют эти
    // столбцы, но совместимость dispatcher со старой схемой сохраняет безопасность перезапуска.
    this.supportsDeadLetterColumns = this.db
      .all<{ name: string }>("PRAGMA table_info(outbox_events)")
      .some((column) => column.name === "dead_lettered_at");
  }

  /**
   * Передаёт подписчикам не более `limit` ожидающих событий.
   * Возвращает количество успешно переданных событий.
   */
  async dispatchBatch(limit: number): Promise<number> {
    const pendingEvents = this.db.all<PendingEventRow>(
      `SELECT id, type, aggregate_type, aggregate_id, payload_json, created_at, available_at, attempts FROM outbox_events
       WHERE processed_at IS NULL${this.supportsDeadLetterColumns ? " AND dead_lettered_at IS NULL" : ""}
         AND available_at <= $now ORDER BY created_at LIMIT $limit`,
      { now: new Date().toISOString(), limit },
    );

    let dispatchedCount = 0;

    for (const row of pendingEvents) {
      const event: DomainEvent = {
        id: row.id,
        type: row.type,
        aggregateType: row.aggregate_type ?? undefined,
        aggregateId: row.aggregate_id ?? undefined,
        payload: JSON.parse(row.payload_json),
        createdAt: row.created_at,
        availableAt: row.available_at,
      };

      const subscriptions = this.bus.subscriptionsFor(event.type);
      let allConsumersHandled = true;

      for (const subscription of subscriptions) {
        // Проверяет idempotency.
        const alreadyProcessed = this.db.get<ProcessedRow>(
          "SELECT event_id FROM processed_events WHERE consumer_name = $consumer AND event_id = $event_id",
          { consumer: subscription.name, event_id: event.id },
        );

        if (alreadyProcessed) continue;

        try {
          await subscription.handler(event);
          // Фиксирует idempotency.
          this.db.run(
            "INSERT INTO processed_events (consumer_name, event_id, processed_at) VALUES ($consumer, $event_id, $processed_at)",
            { consumer: subscription.name, event_id: event.id, processed_at: new Date().toISOString() },
          );
        } catch {
          // Handler завершился ошибкой: оставляет событие ожидающим и применяет ограниченный backoff.
          allConsumersHandled = false;
          const nextAttempts = row.attempts + 1;
          if (this.supportsDeadLetterColumns && nextAttempts >= DEFAULT_MAX_ATTEMPTS) {
            this.db.run(
              "UPDATE outbox_events SET attempts = $attempts, dead_lettered_at = $dead_lettered_at, dead_letter_reason = $reason, last_error = $error WHERE id = $id",
              { id: event.id, attempts: nextAttempts, dead_lettered_at: new Date().toISOString(), reason: "maximum delivery attempts exceeded", error: "handler failed" },
            );
          } else {
            const retryAt = new Date(Date.now() + Math.min(30_000, 250 * 2 ** Math.min(7, row.attempts))).toISOString();
            this.db.run(
              "UPDATE outbox_events SET attempts = $attempts, available_at = $available_at, last_error = $error WHERE id = $id",
              { id: event.id, attempts: nextAttempts, available_at: retryAt, error: "handler failed" },
            );
          }
          // Не помечает других consumers как необработанных — выходит из цикла подписок.
          break;
        }
      }

      if (allConsumersHandled && subscriptions.length > 0) {
        // Помечает событие обработанным.
        this.db.run(
          "UPDATE outbox_events SET processed_at = $now WHERE id = $id",
          { now: new Date().toISOString(), id: event.id },
        );
        dispatchedCount++;
      } else if (subscriptions.length === 0) {
        // Подписчиков нет — помечает событие обработанным.
        this.db.run(
          "UPDATE outbox_events SET processed_at = $now WHERE id = $id",
          { now: new Date().toISOString(), id: event.id },
        );
        dispatchedCount++;
      }
      if (allConsumersHandled) this.bus.emitObserved(event);
    }

    return dispatchedCount;
  }
}
