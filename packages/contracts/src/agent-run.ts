/**
 * Модель AgentRun, сохраняющая метаданные выполнения и результат запуска.
 */

/** Состояние выполнения агентского запуска в его сохраняемом lifecycle. */
export type RunStatus =
  | "STARTED"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

/** Причина, по которой оркестратор создал агентский запуск. */
export type RunTrigger =
  | "task-assignment"
  | "review-request"
  | "planning-request"
  | "test-assignment"
  | "custom";

/** Метаданные запуска, связывающие runtime, доменную работу и usage. */
export interface AgentRun {
  id: string;
  role: string;
  runtime: string;
  model: string;
  taskId: string | null;
  epicId: string | null;
  status: RunStatus;
  sessionId: string | null;
  attempt: number | null;
  triggerReason: RunTrigger | null;
  contextVersion: string | null;
  outputSchemaVersion: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  exitCode: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  cost: number | null;
  capabilityRef?: string;
  /** Полностью отрендеренный prompt роли, переданный оркестратором. */
  prompt?: string;
}
