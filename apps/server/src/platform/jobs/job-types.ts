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

/**
 * Контекст выполнения handler.
 * `signal` отменяется при штатном shutdown worker, чтобы handler мог завершить работу контролируемо.
 */
export interface JobExecutionContext {
  /** Сигнал отмены, который worker активирует при контролируемом shutdown. */
  signal: AbortSignal;
}

/**
 * Проверяет недоверенный JSON payload до передачи handler.
 * Реализация должна бросить исключение при несоответствии схеме; такой job получает постоянный failure.
 */
export interface JobPayloadSchema<TPayload> {
  parse(value: unknown): TPayload;
}

/**
 * Выполняет одну типизированную background job.
 * Handler получает только payload после schema validation и сигнал отмены процесса.
 */
export type JobHandler<TPayload> = (
  payload: TPayload,
  context: JobExecutionContext,
  job: BackgroundJobRow,
) => Promise<void>;

/** Внутренний erased-контракт registry после lookup по сохранённому type. */
export interface RegisteredJobHandler {
  parsePayload(value: unknown): unknown;
  execute(payload: unknown, context: JobExecutionContext, job: BackgroundJobRow): Promise<void>;
}

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
