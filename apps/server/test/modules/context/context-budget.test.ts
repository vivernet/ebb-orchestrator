import { describe, expect, it } from "vitest";
import { ContextBudget } from "../../../src/modules/context/context-budget.js";
import { countTokens, type InputTokenBuckets } from "../../../src/modules/runtime/context/token-accounting.js";

// ---------------------------------------------------------------------------
// Триггер компрессии с учётом driftMultiplier: порог срабатывания равен
// limit × driftMultiplier; при превышении порога компрессия активируется.
// ---------------------------------------------------------------------------

describe("ContextBudget - driftMultiplier триггер компрессии", () => {
  it("по умолчанию driftMultiplier равен 1", () => {
    const budget = new ContextBudget();
    expect(budget.driftMultiplier).toBe(1);
  });

  it("при multiplier=1 компрессия срабатывает только при строгом превышении limit", () => {
    const budget = new ContextBudget();
    expect(budget.isOverBudget(1000, 1000)).toBe(false);
    expect(budget.isOverBudget(1001, 1000)).toBe(true);
  });

  it("при multiplier>1 порог срабатывания сдвигается выше", () => {
    const budget = new ContextBudget({ driftMultiplier: 1.25 });
    expect(budget.compressionThreshold(1000)).toBe(1250);
    expect(budget.isOverBudget(1250, 1000)).toBe(false);
    expect(budget.isOverBudget(1251, 1000)).toBe(true);
  });

  it("при multiplier<1 компрессия срабатывает раньше", () => {
    const budget = new ContextBudget({ driftMultiplier: 0.8 });
    expect(budget.compressionThreshold(1000)).toBe(800);
    expect(budget.isOverBudget(799, 1000)).toBe(false);
    expect(budget.isOverBudget(800, 1000)).toBe(false);
    expect(budget.isOverBudget(801, 1000)).toBe(true);
  });

  it("использует бакеты токенов для решения о компрессии", () => {
    const budget = new ContextBudget({ driftMultiplier: 1 });
    const bucketsBelow: InputTokenBuckets = {
      content: countTokens("Текст контента."),
      fileContext: 0,
      toolCalls: 0,
      thoughtSignature: 0,
      reasoning: 0,
      toolDefinition: 0,
    };
    // 1 + 10: ниже порога.
    expect(budget.isOverBudgetFromBuckets(bucketsBelow, 1000)).toBe(false);

    const bucketsAbove: InputTokenBuckets = {
      content: 500,
      fileContext: 300,
      toolCalls: 100,
      thoughtSignature: 50,
      reasoning: 49,
      toolDefinition: 2,
    };
    expect(budget.isOverBudgetFromBuckets(bucketsAbove, 1000)).toBe(true);
  });

  it("multiplier должен быть положительным конечным числом", () => {
    expect(() => new ContextBudget({ driftMultiplier: 0 })).toThrow(/driftMultiplier/i);
    expect(() => new ContextBudget({ driftMultiplier: -1 })).toThrow(/driftMultiplier/i);
    expect(() => new ContextBudget({ driftMultiplier: Number.NaN })).toThrow(/driftMultiplier/i);
  });
});
