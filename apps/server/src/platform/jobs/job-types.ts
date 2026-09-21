/**
 * Определения типов фоновых задач и enum статуса.
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
  /** Ключ типа задачи для поиска handler. */
  type: string;
  /** Произвольный JSON payload, передаваемый handler. */
  payload: Record<string, unknown>;
  /** Сначала выбираются значения выше (по умолчанию 0). */
  priority?: number;
  /** Самое раннее время запуска job (по умолчанию: now). */
  runAfter?: Date;
  /** Необязательный deduplication key; только одна активная job может использовать такой ключ. */
  dedupeKey?: string;
  /** Максимальное число попыток до dead-letter (по умолчанию 5). */
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
  /** Количество job, захваченных на этом tick. */
  claimed: number;
  /** Количество job, переведённых в SUCCEEDED. */
  succeeded: number;
  /** Количество job, переведённых в FAILED или DEAD_LETTER. */
  failed: number;
}

/** Детерминированное расписание backoff в секундах. */
export const BACKOFF_SCHEDULE: readonly number[] = [60, 120, 300, 900, 1800] as const;
