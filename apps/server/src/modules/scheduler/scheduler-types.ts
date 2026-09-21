/**
 * Типы планировщика: элигибельность, ограничения capacity и resource locks.
 */

/** Безопасные значения по умолчанию, используемые только при отсутствии сохранённой конфигурации. */
export const DEFAULT_SCHEDULER_LIMITS = {
  globalMax: 4,
  projectMax: 3,
  reviewerMax: 1,
} as const;

export interface SchedulerLimits {
  globalMax: number;
  projectMax: number;
  reviewerMax: number;
}

/**
 * Уровни приоритета: задачи с более высоким приоритетом запускаются первыми.
 */
export type Priority = "Critical" | "High" | "Normal" | "Low";

/**
 * Причины, по которым задача может ожидать ресурсы.
 */
export type WaitReason =
  | "WAITING_FOR_DEPENDENCY"
  | "WAITING_FOR_RESOURCE_LOCK"
  | "WAITING_FOR_BUDGET"
  | "WAITING_FOR_APPROVAL"
  | "WAITING_FOR_CAPACITY"
  | "WAITING_FOR_ROLE_CAPACITY";

/**
 * Причины блокировки задачи (жёсткие ограничения).
 */
export type BlockReason =
  | "BLOCKED_BY_WORKFLOW"
  | "BLOCKED_BY_PROJECT_STATE";

/**
 * Статус элигибельности задачи для планирования.
 */
export type Eligibility =
  | { status: "RUNNABLE" }
  | { status: "WAIT"; reason: WaitReason }
  | { status: "BLOCK"; reason: BlockReason };

/**
 * Детерминированный порядок категорий: задачи в более ранних категориях запускаются первыми.
 */
export type Category =
  | "integration"        // integration/unblock
  | "reviewer"           // reviewer
  | "qa"                 // QA
  | "rework"             // rework
  | "new-development"    // new development
  | "optional";          // optional/docs

/**
 * Данные задачи, необходимые для оценки планировщиком.
 */
export interface SchedulableTask {
  id: string;
  projectId: string;
  epicId: string | null;
  status: string;
  priority: Priority;
  category: Category;
  createdAt: string;
  dependsOnTaskIds: string[];
  hasResourceLock: boolean;
  hasBudgetPlaceholder: boolean;
  hasPendingApproval: boolean;
}

/**
 * Результат вызова recalculate.
 */
export interface RecalculateResult {
  /** Задачи, которые можно запустить сейчас. */
  runnables: SchedulableTask[];
  /** Задачи, ожидающие внешнего условия. */
  waiting: { task: SchedulableTask; reason: WaitReason }[];
  /** Заблокированные задачи. */
  blocked: { task: SchedulableTask; reason: BlockReason }[];
  /** Количество выполняющихся задач для расчёта capacity. */
  currentRunningCount: number;
}

/** Результат запроса очистки резервирований. */
export type ReservationReleaseResult =
  | { status: "RELEASED"; reservationId: string }
  | { status: "ALREADY_RELEASED" }
  | { status: "BLOCKED_OWNERSHIP_DRIFT"; reservationId: string };

/** Результат долговечной reconciliation планировщика. */
export interface SchedulerReconciliationResult {
  releasedReservationIds: string[];
  blockedReservationIds: string[];
}
