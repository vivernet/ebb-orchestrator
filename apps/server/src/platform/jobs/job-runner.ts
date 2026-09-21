/**
 * Worker фоновых job: захватывает, выполняет и обновляет job.
 */

import { randomUUID } from "node:crypto";
import type { Database } from "../database/database.js";
import type {
  BackgroundJobRow,
  JobHandler,
  JobRunSummary,
} from "./job-types.js";
import { BACKOFF_SCHEDULE } from "./job-types.js";

/** Длительность lease в миллисекундах (5 минут). */
const LEASE_DURATION_MS = 5 * 60 * 1000;

/**
 * Предоставляет публичный контракт модуля job-runner для взаимодействия слоёв приложения.
 */
export class JobRunner {
  constructor(
    private readonly db: Database,
    private readonly handlers: Record<string, JobHandler>,
  ) {}

  /**
   * Pick up to one runnable job, execute its handler, and update status.
   *
   * Job является runnable, когда:
   * - status равен QUEUED или RETRY_WAIT
   * - run_after <= now
   *
   * The runner claims the job inside a transaction by setting lease_owner and
   * lease_expires_at, then executes the handler outside the transaction.
   */
  async runOnce(now: Date): Promise<JobRunSummary> {
    const summary: JobRunSummary = { claimed: 0, succeeded: 0, failed: 0 };

    // Try to claim one runnable job at a time – the DB transaction
    // guarantees no other worker picks the same row.
    const job = this.claimJob(now);

    if (!job) return summary;

    summary.claimed = 1;

    const handler = this.handlers[job.type];

    if (!handler) {
      // Handler не зарегистрирован — пометить как FAILED
      this.db.run(
        `UPDATE background_jobs
         SET status = $status, last_error = $error, updated_at = $updated_at
         WHERE id = $id`,
        {
          id: job.id,
          status: "FAILED",
          error: `No handler registered for type "${job.type}"`,
          updated_at: new Date().toISOString(),
        },
      );
      summary.failed = 1;
      return summary;
    }

    try {
      await handler(job);
      this.db.run(
        `UPDATE background_jobs
         SET status = 'SUCCEEDED', updated_at = $updated_at, lease_owner = NULL, lease_expires_at = NULL
         WHERE id = $id`,
        { id: job.id, updated_at: new Date().toISOString() },
      );
      summary.succeeded = 1;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const attempts = job.attempts + 1;

      if (attempts >= job.max_attempts) {
        // Переводит job в dead-letter
        this.db.run(
          `UPDATE background_jobs
           SET status = 'DEAD_LETTER', attempts = $attempts, last_error = $error,
               updated_at = $updated_at, lease_owner = NULL, lease_expires_at = NULL
           WHERE id = $id`,
          { id: job.id, attempts, error: errorMsg, updated_at: new Date().toISOString() },
        );
        summary.failed = 1;
      } else {
        // Повторяет с backoff
        const backoffIndex = Math.min(attempts - 1, BACKOFF_SCHEDULE.length - 1);
        const baseDelay = BACKOFF_SCHEDULE[backoffIndex]!;
        // Add bounded jitter: ±10% of base delay
        const jitterMs = (Math.random() * 0.2 - 0.1) * baseDelay * 1000;
        const retryAfter = new Date(now.getTime() + baseDelay * 1000 + jitterMs);

        this.db.run(
          `UPDATE background_jobs
           SET status = 'RETRY_WAIT', attempts = $attempts, last_error = $error,
               run_after = $run_after, updated_at = $updated_at,
               lease_owner = NULL, lease_expires_at = NULL
           WHERE id = $id`,
          {
            id: job.id,
            attempts,
            error: errorMsg,
            run_after: retryAfter.toISOString(),
            updated_at: new Date().toISOString(),
          },
        );
      }
    }

    return summary;
  }

  /**
   * Claim one runnable job inside a transaction.
   * Returns the claimed row or undefined if nothing is available.
   */
  private claimJob(now: Date): BackgroundJobRow | undefined {
    const leaseOwner = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + LEASE_DURATION_MS).toISOString();
    const nowIso = now.toISOString();

    return this.db.transaction<BackgroundJobRow | undefined>((tx) => {
      // Recover jobs whose lease has expired (worker crashed/hung).
      // Promote them back to QUEUED so the SELECT below can pick them up.
      tx.run(
        `UPDATE background_jobs
         SET status = 'QUEUED', lease_owner = NULL, lease_expires_at = NULL
         WHERE status = 'RUNNING' AND lease_expires_at < $now`,
        { now: nowIso },
      );

      // Find the highest-priority runnable job that hasn't been claimed
      const row = tx.get<BackgroundJobRow>(
        `SELECT * FROM background_jobs
         WHERE status IN ('QUEUED', 'RETRY_WAIT')
           AND run_after <= $now
         ORDER BY priority DESC, created_at ASC
         LIMIT 1`,
        { now: nowIso },
      );

      if (!row) return undefined;

      // Захватывает её
      tx.run(
        `UPDATE background_jobs
         SET status = 'RUNNING', lease_owner = $owner, lease_expires_at = $expires, updated_at = $updated
         WHERE id = $id`,
        {
          id: row.id,
          owner: leaseOwner,
          expires: leaseExpiresAt,
          updated: nowIso,
        },
      );

      return {
        ...row,
        status: "RUNNING",
        lease_owner: leaseOwner,
        lease_expires_at: leaseExpiresAt,
      };
    });
  }
}
