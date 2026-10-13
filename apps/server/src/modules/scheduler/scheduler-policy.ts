/**
 * Политика планировщика, определяющая элигибельность по capacity и ограничениям.
 */

import type {
  SchedulableTask,
  Priority,
  Category,
} from "./scheduler-types.js";

/**
 * Проверяет, является ли статус задачи terminal (завершённым).
 */
/**
 * Сравнивает приоритеты и возвращает true, если a имеет более высокий приоритет, чем b.
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
 * Сравнивает категории и возвращает true, если a расположена раньше (важнее), чем b.
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
 * Сравнивает две задачи для детерминированного порядка.
 * Возвращает отрицательное число, если a должна быть раньше b, положительное — если позже, и 0 при равенстве.
 */
export function compareTasks(a: SchedulableTask, b: SchedulableTask): number {
  // Сначала сравнивает категории.
  const catDiff = getCategoryOrder(a.category) - getCategoryOrder(b.category);
  if (catDiff !== 0) return catDiff;

  // Затем сравнивает приоритет.
  const prioDiff = getPriorityOrder(a.agedPriority ?? a.priority) - getPriorityOrder(b.agedPriority ?? b.priority);
  if (prioDiff !== 0) return prioDiff;

  const pathDiff = (b.criticalPathLength ?? 0) - (a.criticalPathLength ?? 0);
  if (pathDiff !== 0) return pathDiff;

  // В конце сравнивает время создания (сначала более старые).
  const createdDiff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  return createdDiff || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

const PRIORITIES: Priority[] = ["Low", "Normal", "High", "Critical"];

/** Рассчитывает durable priority aging в полных UTC сутках; повреждённое значение fail-closed. */
export function agedPriority(priority: Priority, startedAt: string | null | undefined, now: Date): Priority {
  if (startedAt == null) return priority;
  const parsed = Date.parse(startedAt);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== startedAt) {
    throw new Error(`invalid capacity_wait_started_at timestamp: ${startedAt}`);
  }
  const rank = PRIORITIES.indexOf(priority);
  if (rank < 0) throw new Error(`invalid task priority: ${priority}`);
  const levels = Math.max(0, Math.floor((now.getTime() - parsed) / 86_400_000));
  return PRIORITIES[Math.min(3, rank + levels)]!;
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
