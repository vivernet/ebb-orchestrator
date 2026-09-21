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
  /** Stage identifier (e.g., "review", "qa", "integration"). */
  stage: string;
  /** Hash or identifier of the evidence (e.g., review finding). */
  evidenceHash: string;
  /** Timestamp when this evidence was recorded. */
  recordedAt: string;
}

/**
 * Конфигурация политики recovery with exact counters.
 */
export interface RecoveryPolicy {
  /** Maximum attempts allowed at middle tier before escalation. */
  middleAttempts: number;
  /** Maximum attempts allowed at senior tier before escalation. */
  seniorAttempts: number;
  /** Maximum rework cycles for the same review finding. */
  maxReviewReworkCycles: number;
  /** Maximum rework cycles for the same QA finding. */
  maxQaReworkCycles: number;
  /** Maximum resolution attempts for integration failures. */
  maxIntegrationResolutionAttempts: number;
  /** Maximum consecutive runs without progress before escalation. */
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
  /** Task ID being recovered. */
  taskId: string;
  /** Role level that attempted the recovery. */
  roleLevel: RoleLevel;
  /** Тип of failure that triggered recovery. */
  failureType: FailureType;
  /** Attempt number for this failure type and role. */
  attemptCount: number;
  /** Timestamp of the attempt. */
  timestamp: string;
  /** Progress fingerprint if applicable. */
  fingerprint?: ProgressFingerprint;
}

/**
 * Контекст, необходимый для оценки решений recovery.
 */
export interface RecoveryContext {
  /** Task ID being evaluated. */
  taskId: string;
  /** Текущий role level. */
  currentRoleLevel: RoleLevel;
  /** List of recovery attempts for this task. */
  attempts: RecoveryAttempt[];
  /** Текущий failure type. */
  failureType: FailureType;
  /** Текущий stage if applicable. */
  stage?: string;
  /** Evidence hash for finding tracking. */
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
