/**
 * Background job type definitions and status enum.
 */

export type JobStatus =
  | "QUEUED"
  | "RUNNING"
  | "RETRY_WAIT"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"
  | "DEAD_LETTER";

export interface EnqueueJobInput {
  /** The job type key used to look up the handler. */
  type: string;
  /** Arbitrary JSON payload passed to the handler. */
  payload: Record<string, unknown>;
  /** Higher values are picked up first (default 0). */
  priority?: number;
  /** Earliest time the job should run (default: now). */
  runAfter?: Date;
  /** Optional deduplication key – only one active job may share a key. */
  dedupeKey?: string;
  /** Maximum attempts before dead-letter (default 5). */
  maxAttempts?: number;
}

export interface BackgroundJobRow {
  id: string;
  type: string;
  payload_json: string;
  dedupe_key: string | null;
  priority: number;
  status: JobStatus;
  run_after: string;
  attempts: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export type JobHandler = (job: BackgroundJobRow) => Promise<void>;

export interface JobRunSummary {
  /** Number of jobs that were claimed this tick. */
  claimed: number;
  /** Number of jobs that transitioned to SUCCEEDED. */
  succeeded: number;
  /** Number of jobs that transitioned to FAILED or DEAD_LETTER. */
  failed: number;
}

/** Deterministic backoff schedule in seconds. */
export const BACKOFF_SCHEDULE: readonly number[] = [60, 120, 300, 900, 1800] as const;
