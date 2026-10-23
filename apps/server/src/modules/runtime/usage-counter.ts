/**
 * Унифицированный аккумулятор usage/cost модели.
 *
 * Единый формат `ModelUsage` и правила слияния нескольких источников
 * usage одного запуска. Правило «NULL cost не подменяется оценкой»
 * зафиксировано: пока ни один источник не сообщил стоимость, `cost`
 * остаётся `null`; источник с `cost: null` не обнуляет и не подменяет
 * уже накопленную стоимость.
 */

/** Единый формат usage модели (токены и стоимость). */
export interface ModelUsage {
  /** Количество входных токенов. */
  inputTokens: number;
  /** Количество кэшированных входных токенов. */
  cachedInputTokens: number;
  /** Количество выходных токенов. */
  outputTokens: number;
  /**
   * Стоимость вызова в валюте провайдера.
   * `null` означает, что источник не сообщил стоимость; не подменяется
   * оценкой или нулём.
   */
  cost: number | null;
}

/**
 * Проверяет значение на конечное неотрицательное число.
 * @throws {TypeError} Если значение не является конечным неотрицательным числом.
 */
function assertNonNegativeFinite(value: number, field: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`UsageCounter: ${field} должен быть конечным неотрицательным числом, получено ${String(value)}`);
  }
}

/**
 * Аккумулятор usage нескольких источников одного запуска.
 *
 * Токены суммируются по всем объединённым источникам; стоимость
 * суммируется только из источников, сообщивших не-`null` значение.
 * Пока ни один источник не сообщил стоимость, `cost` остаётся `null`.
 */
export class UsageCounter {
  private merged = false;
  private inputTokens = 0;
  private cachedInputTokens = 0;
  private outputTokens = 0;
  private cost: number | null = null;

  /**
   * Объединяет один или несколько источников usage в счётчик.
   *
   * @param sources Источники usage в едином формате `ModelUsage`.
   * @returns {this} Тот же счётчик для цепочечных вызовов.
   * @throws {TypeError} Если любой источник содержит невалидные числа.
   */
  merge(...sources: readonly ModelUsage[]): this {
    for (const source of sources) {
      assertNonNegativeFinite(source.inputTokens, "inputTokens");
      assertNonNegativeFinite(source.cachedInputTokens, "cachedInputTokens");
      assertNonNegativeFinite(source.outputTokens, "outputTokens");
      if (source.cost !== null) {
        assertNonNegativeFinite(source.cost, "cost");
      }
      this.merged = true;
      this.inputTokens += source.inputTokens;
      this.cachedInputTokens += source.cachedInputTokens;
      this.outputTokens += source.outputTokens;
      if (source.cost !== null) {
        // NULL cost не подменяется оценкой и не обнуляет накопленную стоимость.
        this.cost = this.cost === null ? source.cost : this.cost + source.cost;
      }
    }
    return this;
  }

  /**
   * Возвращает текущий снимок накопленного usage.
   *
   * @returns {ModelUsage} Копия накопленного состояния; мутация результата
   * не влияет на счётчик.
   */
  snapshot(): ModelUsage {
    return {
      inputTokens: this.inputTokens,
      cachedInputTokens: this.cachedInputTokens,
      outputTokens: this.outputTokens,
      cost: this.cost,
    };
  }

  /**
   * `true`, если ни один источник ещё не был объединён в счётчик.
   * Когда отличить «usage отсутствует» от «usage равен нулю» нельзя,
   * вызывающий код полагается на этот признак.
   */
  get isEmpty(): boolean {
    return !this.merged;
  }
}
