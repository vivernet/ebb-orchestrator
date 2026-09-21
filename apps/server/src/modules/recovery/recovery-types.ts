/**
 * Типы домена recovery — recovery decisions and fingerprints.
 */

/**
 * Решение recovery, определяющее the next action to take.
 */
export type RecoveryDecision =
  | "RESUME_SAME_SESSION"
  | "RETRY"
  | "ESCALATE_ROLE"
  | "COORDINATOR_DIAGNOSIS"
  | "BLOCK";

/**
 * Доказательство для конкретного stage, используемое для tracking progress and detecting loops.
 */
export interface ProgressFingerprint {
  /** этап идентификатор (e.g., "review", "qa", "integration"). */
  stage: string;
  /** Хэш или идентификатор of Объект evidence (e.g., review finding). */
  evidenceHash: string;
  /** Момент времени, когда этот evidence was recorded. */
  recordedAt: string;
}

/**
 * Конфигурация политики recovery with exact counters.
 */
export interface RecoveryPolicy {
  /** максимальный попытки allowed at middle tier перед escalation. */
  middleAttempts: number;
  /** максимальный попытки allowed at senior tier перед escalation. */
  seniorAttempts: number;
  /** Максимальное число циклов доработки для Объект тот же review finding. */
  maxReviewReworkCycles: number;
  /** Максимальное число циклов доработки для Объект тот же QОбъект finding. */
  maxQaReworkCycles: number;
  /** максимальный resolution попытки для integration failures. */
  maxIntegrationResolutionAttempts: number;
  /** Максимальное число последовательных запусков without прогресс перед escalation. */
  maxConsecutiveNoProgressRuns: number;
}

/**
 * Конфигурация политики recovery по умолчанию.
 */
export const DEFAULT_POLICY: RecoveryPolicy = {
  middleAttempts: 2,
  seniorAttempts: 2,
  maxReviewReworkCycles: 3,
  maxQaReworkCycles: 3,
  maxIntegrationResolutionAttempts: 2,
  maxConsecutiveNoProgressRuns: 2,
} as const;

/**
 * Уровень роли для выполнения задачи.
 */
export type RoleLevel = "middle" | "senior";

/**
 * Тип ошибки для классификации потребности в recovery.
 */
export type FailureType =
  | "TASK_FAILURE"
  | "TOOL_ERROR"
  | "INTEGRATION_FAILURE"
  | "REVIEW_FINDING"
  | "QA_FINDING"
  | "NO_PROGRESS";

/**
 * Запись попытки recovery.
 */
export interface RecoveryAttempt {
  /** задача ID being recovered. */
  taskId: string;
  /** Уровень роли, выполнившей Объект recovery. */
  roleLevel: RoleLevel;
  /** Тип of failure that triggered recovery. */
  failureType: FailureType;
  /** Номер попытки для этот ошибка тип и роль. */
  attemptCount: number;
  /** временная отметка of Объект попытка. */
  timestamp: string;
  /** прогресс fingerprint если applicable. */
  fingerprint?: ProgressFingerprint;
}

/**
 * Контекст, необходимый для оценки решений recovery.
 */
export interface RecoveryContext {
  /** задача ID being evaluated. */
  taskId: string;
  /** Текущий role level. */
  currentRoleLevel: RoleLevel;
  /** Список попыток восстановления для этот задача. */
  attempts: RecoveryAttempt[];
  /** Текущий failure type. */
  failureType: FailureType;
  /** Текущий stage if applicable. */
  stage?: string;
  /** evidence hash для finding tracking. */
  evidenceHash?: string;
}

/**
 * Результат оценки recovery.
 */
export interface RecoveryResult {
  /** Решение recovery, которое следует принять. */
  decision: RecoveryDecision;
  /** Рекомендуемый уровень роли для следующей попытки. */
  nextRoleLevel?: RoleLevel;
  /** Причина решения. */
  reason: string;
  /** Нужно ли создавать новый запрос планировщика. */
  createSchedulerRequest: boolean;
}
