/**
 * Context Budget для Orchestrator Hermes.
 * Реализует детерминированное сокращение контекста при превышении бюджета.
 * Сначала удаляет P3, затем P2 и никогда не удаляет P0.
 */

import type { Priority } from "./context-types.js";

/** Оценка количества token для одного элемента контекста. */
const TOKENS_PER_ITEM = 100;

/**
 * Context Budget — детерминированное сокращение при превышении бюджета контекста.
 * LLM summarization не используется.
 */
export class ContextBudget {
  /**
   * Сокращает элементы под давлением бюджета.
   * Детерминированный порядок: сначала удаляет P3, затем P2; P0 не удаляет.
   *
   * @param items Элементы с необязательным приоритетом.
   * @param budgetLimit Лимит token-бюджета; меньшее значение означает более агрессивное сокращение.
   * @returns Сокращённые элементы.
   */
  pruneByBudget<T extends { priority?: Priority }>(items: T[], budgetLimit: number): T[] {
    // Давления бюджета нет — возвращает все элементы.
    if (budgetLimit >= 10000) {
      return items;
    }

    // Элементы P0 НИКОГДА не сокращаются.
    const p0 = items.filter((item) => item.priority === "p0");

    // Элементы P1 всегда включаются.
    const p1 = items.filter((item) => item.priority === "p1");

    // Элементы P2 сокращаются или удаляются при сильном давлении.
    const p2 = items.filter((item) => item.priority === "p2");

    // Уровни давления бюджета:
    // < 10000: remove P3
    // < 500: remove P3 + P2 (severe)
    // < 100:  remove P3 + P2, keep only P0 (critical)
    if (budgetLimit < 100) {
      // Критический: сохраняются только P0.
      return p0;
    }

    if (budgetLimit < 500) {
      // Сильный: только P0 + P1.
      return [...p0, ...p1];
    }

    // Умеренный: P0 + P1 + P2 (P3 удаляется).
    return [...p0, ...p1, ...p2];
  }

  /**
   * Оценивает количество token для набора элементов.
   * Упрощённая эвристика: 100 token на элемент.
   */
  estimateTokens<T>(items: T[]): number {
    return items.length * TOKENS_PER_ITEM;
  }
}
