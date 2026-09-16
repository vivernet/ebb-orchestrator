/**
 * Scheduler policy - determines eligibility based on capacity and constraints.
 */

import { CAPACITY } from "./scheduler-types.js";
import type {
  SchedulableTask,
  Eligibility,
  WaitReason,
  BlockReason,
  Priority,
  Category,
} from "./scheduler-types.js";

/**
 * Determine eligibility of a task for scheduling.
 */
export function determineEligibility(
  task: SchedulableTask,
  activeTasks: SchedulableTask[],
): Eligibility {
  // Check hard blocks first
  const blockReason = getBlockReason(task);
  if (blockReason) {
    return { status: "BLOCK", reason: blockReason };
  }

  // Check if task can run based on dependencies and resources
  const waitReason = getWaitReason(task, activeTasks);
  if (waitReason) {
    return { status: "WAIT", reason: waitReason };
  }

  // Check capacity constraints
  if (!canRunWithinCapacity(task, activeTasks)) {
    // Treat capacity overflow as a wait (will be handled by ordering)
    return { status: "RUNNABLE" };
  }

  return { status: "RUNNABLE" };
}

/**
 * Get block reason if task is hard-blocked.
 */
function getBlockReason(task: SchedulableTask): BlockReason | null {
  // Workflow state blocks
  const terminalStates = ["DONE", "CANCELLED", "FAILED"];
  if (terminalStates.includes(task.status)) {
    return "BLOCKED_BY_WORKFLOW";
  }

  // Project state blocks
  if (task.status === "DRAFT") {
    return "BLOCKED_BY_PROJECT_STATE";
  }

  return null;
}

/**
 * Get wait reason if task is waiting for something.
 */
function getWaitReason(
  task: SchedulableTask,
  activeTasks: SchedulableTask[],
): WaitReason | null {
  // Check dependencies first
  if (task.dependsOnTaskIds.length > 0) {
    // Check if all dependencies are completed
    const incompleteDeps = task.dependsOnTaskIds.filter((depId) => {
      const dep = activeTasks.find((t) => t.id === depId);
      return dep && !isTaskCompleted(dep.status);
    });
    if (incompleteDeps.length > 0) {
      return "WAITING_FOR_DEPENDENCY";
    }
  }

  // Check resource lock
  if (task.hasResourceLock && !resourceLockAvailable(task)) {
    return "WAITING_FOR_RESOURCE_LOCK";
  }

  // Check budget placeholder
  if (task.hasBudgetPlaceholder && !budgetAvailable()) {
    return "WAITING_FOR_BUDGET";
  }

  // Check approval
  if (task.hasPendingApproval && !approvalGranted(task)) {
    return "WAITING_FOR_APPROVAL";
  }

  return null;
}

/**
 * Check if task's resource lock is available.
 */
function resourceLockAvailable(task: SchedulableTask): boolean {
  // In a real implementation, this would check if the lock is currently held
  // For now, we assume the task can proceed if it holds the lock
  return true;
}

/**
 * Placeholder for budget availability check.
 */
function budgetAvailable(): boolean {
  // In a real implementation, this would check budget constraints
  return true;
}

/**
 * Placeholder for approval check.
 */
function approvalGranted(task: SchedulableTask): boolean {
  // In a real implementation, this would check approval status
  return true;
}

/**
 * Check if task can run within capacity constraints.
 */
function canRunWithinCapacity(
  task: SchedulableTask,
  activeTasks: SchedulableTask[],
): boolean {
  const runningCount = activeTasks.length;

  // Global capacity check
  if (runningCount >= CAPACITY.globalMax) {
    return false;
  }

  // Project capacity check
  const projectCount = activeTasks.filter((t) => t.projectId === task.projectId).length;
  if (projectCount >= CAPACITY.projectMax) {
    return false;
  }

  // Reviewer capacity check (assuming REVIEW status tasks need a reviewer)
  const reviewerCount = activeTasks.filter((t) => t.status === "REVIEW").length;
  if (task.status === "REVIEW" && reviewerCount >= CAPACITY.reviewerMax) {
    return false;
  }

  return true;
}

/**
 * Check if a task status is terminal (completed).
 */
function isTaskCompleted(status: string): boolean {
  return status === "DONE" || status === "CANCELLED" || status === "FAILED";
}

/**
 * Compare priorities - returns true if a has higher priority than b.
 */
export function hasHigherPriority(a: Priority, b: Priority): boolean {
  const order: Record<Priority, number> = {
    Critical: 0,
    High: 1,
    Normal: 2,
    Low: 3,
  };
  return order[a] < order[b];
}

/**
 * Compare categories - returns true if a is earlier (more important) than b.
 */
export function hasHigherCategory(a: Category, b: Category): boolean {
  const order: Record<Category, number> = {
    integration: 0,
    reviewer: 1,
    qa: 2,
    rework: 3,
    "new-development": 4,
    optional: 5,
  };
  return order[a] < order[b];
}

/**
 * Compare two tasks for deterministic ordering.
 * Returns negative if a should come before b, positive if after, 0 if equal.
 */
export function compareTasks(a: SchedulableTask, b: SchedulableTask): number {
  // First, compare by category
  const catDiff = getCategoryOrder(a.category) - getCategoryOrder(b.category);
  if (catDiff !== 0) return catDiff;

  // Then by priority
  const prioDiff = getPriorityOrder(a.priority) - getPriorityOrder(b.priority);
  if (prioDiff !== 0) return prioDiff;

  // Finally by creation time (older first)
  return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
}

function getCategoryOrder(category: Category): number {
  const order: Record<Category, number> = {
    integration: 0,
    reviewer: 1,
    qa: 2,
    rework: 3,
    "new-development": 4,
    optional: 5,
  };
  return order[category];
}

function getPriorityOrder(priority: Priority): number {
  const order: Record<Priority, number> = {
    Critical: 0,
    High: 1,
    Normal: 2,
    Low: 3,
  };
  return order[priority];
}
