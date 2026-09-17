/**
 * Scheduler types - eligibility, capacity constraints, and resource locks.
 */

/** Capacity constraints for scheduling. */
export const CAPACITY = {
  globalMax: 4,
  projectMax: 3,
  reviewerMax: 1,
} as const;

/**
 * Priority levels - higher priority tasks run first.
 */
export type Priority = "Critical" | "High" | "Normal" | "Low";

/**
 * Reasons a task may be waiting for resources.
 */
export type WaitReason =
  | "WAITING_FOR_DEPENDENCY"
  | "WAITING_FOR_RESOURCE_LOCK"
  | "WAITING_FOR_BUDGET"
  | "WAITING_FOR_APPROVAL"
  | "WAITING_FOR_CAPACITY"
  | "WAITING_FOR_ROLE_CAPACITY";

/**
 * Reasons a task may be blocked (hard constraints).
 */
export type BlockReason =
  | "BLOCKED_BY_WORKFLOW"
  | "BLOCKED_BY_PROJECT_STATE";

/**
 * Eligibility status of a task for scheduling.
 */
export type Eligibility =
  | { status: "RUNNABLE" }
  | { status: "WAIT"; reason: WaitReason }
  | { status: "BLOCK"; reason: BlockReason };

/**
 * Deterministic category ordering - tasks in earlier categories run first.
 */
export type Category =
  | "integration"        // integration/unblock
  | "reviewer"           // reviewer
  | "qa"                 // QA
  | "rework"             // rework
  | "new-development"    // new development
  | "optional";          // optional/docs

/**
 * Task data needed for scheduler evaluation.
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
 * Result of recalculate call.
 */
export interface RecalculateResult {
  /** Tasks that are eligible to run now. */
  runnables: SchedulableTask[];
  /** Tasks that are waiting for something. */
  waiting: { task: SchedulableTask; reason: WaitReason }[];
  /** Tasks that are blocked. */
  blocked: { task: SchedulableTask; reason: BlockReason }[];
  /** Count of currently running tasks (for capacity). */
  currentRunningCount: number;
}

/** Result of a reservation cleanup request. */
export type ReservationReleaseResult =
  | { status: "RELEASED"; reservationId: string }
  | { status: "ALREADY_RELEASED" }
  | { status: "BLOCKED_OWNERSHIP_DRIFT"; reservationId: string };

/** Durable scheduler reconciliation outcome. */
export interface SchedulerReconciliationResult {
  releasedReservationIds: string[];
  blockedReservationIds: string[];
}
