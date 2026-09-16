/**
 * Outbox repository – append domain events inside an existing transaction.
 */

import type { DatabaseTx } from "../database/database.js";
import type { DomainEvent } from "./domain-event.js";

/**
 * Write a domain event into the outbox within the given transaction.
 */
export function appendOutboxEvent(tx: DatabaseTx, event: DomainEvent): void {
  tx.run(
    `INSERT INTO outbox_events (id, type, aggregate_type, aggregate_id, payload_json, created_at, available_at, attempts)
     VALUES ($id, $type, $aggregate_type, $aggregate_id, $payload_json, $created_at, $available_at, 0)`,
    {
      id: event.id,
      type: event.type,
      aggregate_type: event.aggregateType ?? null,
      aggregate_id: event.aggregateId ?? null,
      payload_json: JSON.stringify(event.payload),
      created_at: event.createdAt,
      available_at: event.availableAt,
    },
  );
}
