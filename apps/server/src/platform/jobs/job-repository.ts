/**
 * Добавляет фоновую job в очередь с поддержкой дедупликации.
 */

import { randomUUID } from "node:crypto";
import type { Database, DatabaseTx } from "../database/database.js";
import { BACKOFF_SCHEDULE, type BackgroundJobRow, type EnqueueJobInput } from "./job-types.js";

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

/**
 * Учитывает истёкшие leases как неуспешные попытки и применяет bounded backoff.
 * Вызывается внутри startup или claim transaction; сверх max_attempts задача уходит в DEAD_LETTER.
 */
export function recoverExpiredJobs(tx: DatabaseTx, now: Date): number {
  const nowIso = now.toISOString();
  const expired = tx.all<BackgroundJobRow>(
    `SELECT * FROM background_jobs
      WHERE status = 'RUNNING' AND lease_expires_at < $now`,
    { now: nowIso },
  );

  for (const job of expired) {
    const attempts = job.attempts + 1;
    const exhausted = attempts >= job.max_attempts;
    const baseDelaySeconds = BACKOFF_SCHEDULE[Math.min(attempts - 1, BACKOFF_SCHEDULE.length - 1)]!;
    const jitterMs = (Math.random() * 0.2 - 0.1) * baseDelaySeconds * 1_000;
    const retryAfter = new Date(now.getTime() + baseDelaySeconds * 1_000 + jitterMs).toISOString();
    tx.run(
      `UPDATE background_jobs
          SET status = $status, attempts = $attempts, last_error = $error,
              run_after = $run_after, lease_owner = NULL, lease_expires_at = NULL,
              updated_at = $updated_at
        WHERE id = $id AND status = 'RUNNING' AND lease_expires_at < $now`,
      {
        id: job.id,
        status: exhausted ? "DEAD_LETTER" : "RETRY_WAIT",
        attempts,
        error: "JOB_LEASE_EXPIRED",
        run_after: retryAfter,
        updated_at: nowIso,
        now: nowIso,
      },
    );
  }
  return expired.length;
}
