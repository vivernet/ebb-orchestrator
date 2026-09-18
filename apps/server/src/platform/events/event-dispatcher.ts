/**
 * Dispatches pending outbox events to subscribers via the EventBus.
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
}

interface ProcessedRow {
  event_id: string;
}

/**
 * Предоставляет публичный контракт модуля event-dispatcher для взаимодействия слоёв приложения.
 */
export class EventDispatcher {
  constructor(
    private readonly db: Database,
    private readonly bus: EventBus,
  ) {}

  /**
   * Dispatch up to `limit` pending events to their subscribers.
   * Returns the number of successfully dispatched events.
   */
  async dispatchBatch(limit: number): Promise<number> {
    const pendingEvents = this.db.all<PendingEventRow>(
      "SELECT id, type, aggregate_type, aggregate_id, payload_json, created_at, available_at FROM outbox_events WHERE processed_at IS NULL AND available_at <= $now ORDER BY created_at LIMIT $limit",
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
        // Check idempotency
        const alreadyProcessed = this.db.get<ProcessedRow>(
          "SELECT event_id FROM processed_events WHERE consumer_name = $consumer AND event_id = $event_id",
          { consumer: subscription.name, event_id: event.id },
        );

        if (alreadyProcessed) continue;

        try {
          await subscription.handler(event);
          // Record idempotency
          this.db.run(
            "INSERT INTO processed_events (consumer_name, event_id, processed_at) VALUES ($consumer, $event_id, $processed_at)",
            { consumer: subscription.name, event_id: event.id, processed_at: new Date().toISOString() },
          );
        } catch {
          // Handler failed – leave event pending, increment attempts
          allConsumersHandled = false;
          this.db.run(
            "UPDATE outbox_events SET attempts = attempts + 1, last_error = $error WHERE id = $id",
            { id: event.id, error: "handler failed" },
          );
          // Do not mark other consumers as unprocessed – break out of the subscription loop
          break;
        }
      }

      if (allConsumersHandled && subscriptions.length > 0) {
        // Mark event as processed
        this.db.run(
          "UPDATE outbox_events SET processed_at = $now WHERE id = $id",
          { now: new Date().toISOString(), id: event.id },
        );
        dispatchedCount++;
      } else if (subscriptions.length === 0) {
        // No subscribers – mark as processed
        this.db.run(
          "UPDATE outbox_events SET processed_at = $now WHERE id = $id",
          { now: new Date().toISOString(), id: event.id },
        );
        dispatchedCount++;
      }
    }

    return dispatchedCount;
  }
}
