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
  const prioDiff = getPriorityOrder(a.priority) - getPriorityOrder(b.priority);
  if (prioDiff !== 0) return prioDiff;

  // В конце сравнивает время создания (сначала более старые).
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
