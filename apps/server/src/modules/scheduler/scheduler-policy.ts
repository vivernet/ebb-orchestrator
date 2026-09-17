/**
 * Scheduler policy - determines eligibility based on capacity and constraints.
 */

import type {
  SchedulableTask,
  Priority,
  Category,
} from "./scheduler-types.js";

/**
 * Check if a task status is terminal (completed).
 */
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
