/**
 * Добавляет фоновую job в очередь с поддержкой дедупликации.
 */

import { randomUUID } from "node:crypto";
import type { Database } from "../database/database.js";
import type { EnqueueJobInput } from "./job-types.js";

/**
 * Вставляет новую фоновую job.
 *
 * Если задан `dedupeKey` и уже существует активная (QUEUED | RUNNING | RETRY_WAIT)
 * job с тем же ключом, новая job молча отбрасывается, а вызывающему коду
 * возвращается идентификатор существующей job для опроса завершения.
 *
 * Возвращает идентификатор job.
 */
export function enqueueJob(db: Database, input: EnqueueJobInput): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  const runAfter = (input.runAfter ?? new Date()).toISOString();
  const payloadJson = JSON.stringify(input.payload);
  const maxAttempts = input.maxAttempts ?? 5;

  if (input.dedupeKey) {
    const existing = db.get<{ id: string }>(
      `SELECT id FROM background_jobs
       WHERE dedupe_key = $dk
         AND status IN ('QUEUED','RUNNING','RETRY_WAIT')
       LIMIT 1`,
      { dk: input.dedupeKey },
    );

    if (existing) {
      return existing.id;
    }
  }

  db.run(
    `INSERT INTO background_jobs
       (id, type, payload_json, dedupe_key, priority, status, run_after, attempts, max_attempts, created_at, updated_at)
     VALUES
       ($id, $type, $payload_json, $dedupe_key, $priority, 'QUEUED', $run_after, 0, $max_attempts, $created_at, $updated_at)`,
    {
      id,
      type: input.type,
      payload_json: payloadJson,
      dedupe_key: input.dedupeKey ?? null,
      priority: input.priority ?? 0,
      run_after: runAfter,
      max_attempts: maxAttempts,
      created_at: now,
      updated_at: now,
    },
  );

  return id;
}
