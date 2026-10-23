/**
 * Контекст Budget для Orchestrator Hermes.
 * Реализует детерминированное сокращение контекста при превышении бюджета.
 * Сначала удаляет P3, затем P2 и никогда не удаляет P0.
 */

import type { Priority } from "./context-types.js";
import { countContextTokens, type InputTokenBuckets } from "../runtime/context/token-accounting.js";

/** Оценка количества token для одного элемента контекста. */
const TOKENS_PER_ITEM = 100;

/** Множитель дрейфа бюджета по умолчанию: компрессия при превышении limit. */
export const DRIFT_MULTIPLIER_DEFAULT = 1;

/** Опции конфигурации {@link ContextBudget}. */
export interface ContextBudgetOptions {
  /**
   * Множитель дрейфа бюджета: триггер компрессии срабатывает при строгом
   * превышении `limit × driftMultiplier`. Значение > 1 смягчает давление,
   * значение < 1 усиливает его. По умолчанию — 1.
   */
  readonly driftMultiplier?: number;
}

/**
 * Детерминированное сокращение элементов под давлением бюджета.
 * Чистая функция без состояния; используется как шаг конвейера контекста
 * (см. `modules/runtime/context/context-pipeline.ts`) и классом {@link ContextBudget}.
 * Детерминированный порядок: сначала удаляет P3, затем P2; P0 не удаляет.
 *
 * @param items Элементы с необязательным приоритетом.
 * @param budgetLimit Лимит token-бюджета; меньшее значение означает более агрессивное сокращение.
 * @returns Сокращённые элементы.
 */
export function pruneByBudget<T extends { priority?: Priority }>(items: T[], budgetLimit: number): T[] {
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
 * Контекст Budget — детерминированное сокращение при превышении бюджета контекста.
 * LLM summarization не используется.
 */
export class ContextBudget {
  /** Множитель дрейфа бюджета для триггера компрессии. */
  readonly driftMultiplier: number;

  /**
   * Создаёт бюджет с заданным множителем дрейфа.
   *
   * @param options Опции конфигурации; `driftMultiplier` должен быть
   *   положительным конечным числом.
   * @throws {RangeError} Если `driftMultiplier` некорректен.
   */
  constructor(options: ContextBudgetOptions = {}) {
    const multiplier = options.driftMultiplier ?? DRIFT_MULTIPLIER_DEFAULT;
    if (typeof multiplier !== "number" || !Number.isFinite(multiplier) || multiplier <= 0) {
      throw new RangeError("driftMultiplier must be a positive finite number.");
    }
    this.driftMultiplier = multiplier;
  }

  /**
   * Порог срабатывания триггера компрессии с учётом множителя дрейфа.
   *
   * @param limit Лимит token-бюджета policy.
   * @returns Порог `limit × driftMultiplier`; превышение строго больше
   *   этого значения активирует компрессию.
   */
  compressionThreshold(limit: number): number {
    return limit * this.driftMultiplier;
  }

  /**
   * Проверяет, требуется ли компрессия при измеренном потреблении.
   * Триггер срабатывает при строгом превышении {@link compressionThreshold}.
   *
   * @param tokens Измеренное число токенов (точный учёт).
   * @param limit Лимит token-бюджета policy.
   * @returns true, если `tokens` строго больше порога срабатывания.
   */
  isOverBudget(tokens: number, limit: number): boolean {
    return tokens > this.compressionThreshold(limit);
  }

  /**
   * Проверяет, требуется ли компрессия по бакетам токенов.
   * Сумма бакетов считается точным учётом {@link countContextTokens}, после
   * чего решение принимается тем же триггером {@link isOverBudget}.
   *
   * @param buckets Учёт токенов по источникам (точные значения бакетов).
   * @param limit Лимит token-бюджета policy.
   * @returns true, если сумма бакетов строго больше порога срабатывания.
   */
  isOverBudgetFromBuckets(buckets: InputTokenBuckets, limit: number): boolean {
    return this.isOverBudget(countContextTokens(buckets), limit);
  }

  /**
   * Сокращает элементы под давлением бюджета.
   * Делегирует чистой функции {@link pruneByBudget}.
   *
   * @param items Элементы с необязательным приоритетом.
   * @param budgetLimit Лимит token-бюджета; меньшее значение означает более агрессивное сокращение.
   * @returns Сокращённые элементы.
   */
  pruneByBudget<T extends { priority?: Priority }>(items: T[], budgetLimit: number): T[] {
    return pruneByBudget(items, budgetLimit);
  }

  /**
   * Оценивает количество token для набора элементов.
   * Упрощённая эвристика: 100 token на элемент.
   */
  estimateTokens<T>(items: T[]): number {
    return items.length * TOKENS_PER_ITEM;
  }
}
