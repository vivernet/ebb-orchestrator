import { describe, expect, it } from "vitest";
import { UsageCounter } from "../../../src/modules/runtime/usage-counter.js";

const usage = (overrides: Partial<{
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  cost: number | null;
}> = {}) => ({
  inputTokens: 1,
  cachedInputTokens: 0,
  outputTokens: 1,
  cost: null,
  ...overrides,
});

describe("UsageCounter", () => {
  it("starts empty with zero tokens and null cost", () => {
    const counter = new UsageCounter();
    expect(counter.isEmpty).toBe(true);
    expect(counter.snapshot()).toEqual({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      cost: null,
    });
  });

  it("merges token counts from several sources", () => {
    const counter = new UsageCounter();
    counter.merge(usage({ inputTokens: 10, cachedInputTokens: 2, outputTokens: 3, cost: 0.25 }));
    counter.merge(usage({ inputTokens: 5, cachedInputTokens: 0, outputTokens: 7, cost: 0.1 }));
    expect(counter.isEmpty).toBe(false);
    expect(counter.snapshot()).toEqual({
      inputTokens: 15,
      cachedInputTokens: 2,
      outputTokens: 10,
      cost: 0.35,
    });
  });

  it("merges several sources in a single call", () => {
    const counter = new UsageCounter();
    counter.merge(
      usage({ inputTokens: 4, cachedInputTokens: 1, outputTokens: 2, cost: 0.2 }),
      usage({ inputTokens: 6, cachedInputTokens: 3, outputTokens: 8, cost: 0.3 }),
    );
    expect(counter.snapshot()).toEqual({
      inputTokens: 10,
      cachedInputTokens: 4,
      outputTokens: 10,
      cost: 0.5,
    });
  });

  it("keeps cost null while no source reports a cost", () => {
    const counter = new UsageCounter();
    counter.merge(usage({ inputTokens: 10, cachedInputTokens: 2, outputTokens: 3 }));
    counter.merge(usage({ inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }));
    expect(counter.snapshot().cost).toBeNull();
    expect(counter.snapshot().inputTokens).toBe(11);
    expect(counter.snapshot().cachedInputTokens).toBe(2);
    expect(counter.snapshot().outputTokens).toBe(4);
  });

  it("never replaces a known cost from null cost from a later source", () => {
    const counter = new UsageCounter();
    counter.merge(usage({ inputTokens: 10, outputTokens: 3, cost: 0.25 }));
    counter.merge(usage({ inputTokens: 5, outputTokens: 7 }));
    expect(counter.snapshot().cost).toBe(0.25);
    expect(counter.snapshot().inputTokens).toBe(15);
  });

  it("never replaces a known cost when the first source has null cost", () => {
    const counter = new UsageCounter();
    counter.merge(usage({ inputTokens: 10, outputTokens: 3 }));
    counter.merge(usage({ inputTokens: 5, outputTokens: 7, cost: 0.4 }));
    expect(counter.snapshot().cost).toBe(0.4);
  });

  it("returns an independent snapshot copy", () => {
    const counter = new UsageCounter();
    counter.merge(usage({ inputTokens: 10, cachedInputTokens: 2, outputTokens: 3, cost: 0.5 }));
    const snapshot = counter.snapshot();
    snapshot.inputTokens = 999;
    snapshot.cachedInputTokens = 999;
    snapshot.outputTokens = 999;
    snapshot.cost = 0;
    expect(counter.snapshot()).toEqual({
      inputTokens: 10,
      cachedInputTokens: 2,
      outputTokens: 3,
      cost: 0.5,
    });
  });

  it("merge with no sources leaves the counter empty", () => {
    const counter = new UsageCounter();
    counter.merge();
    expect(counter.isEmpty).toBe(true);
    expect(counter.snapshot()).toEqual({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      cost: null,
    });
  });

  it("rejects invalid token values", () => {
    expect(() => new UsageCounter().merge(usage({ inputTokens: -1 }))).toThrow(TypeError);
    expect(() => new UsageCounter().merge(usage({ inputTokens: Number.NaN }))).toThrow(TypeError);
    expect(() => new UsageCounter().merge(usage({ inputTokens: Number.POSITIVE_INFINITY }))).toThrow(TypeError);
    expect(() => new UsageCounter().merge(usage({ cachedInputTokens: -1 }))).toThrow(TypeError);
    expect(() => new UsageCounter().merge(usage({ outputTokens: -1 }))).toThrow(TypeError);
  });

  it("rejects invalid cost values", () => {
    expect(() => new UsageCounter().merge(usage({ cost: -0.01 }))).toThrow(TypeError);
    expect(() => new UsageCounter().merge(usage({ cost: Number.NaN }))).toThrow(TypeError);
    expect(() => new UsageCounter().merge(usage({ cost: Number.POSITIVE_INFINITY }))).toThrow(TypeError);
  });

  it("allows zero tokens and zero cost", () => {
    const counter = new UsageCounter();
    counter.merge(usage({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, cost: 0 }));
    expect(counter.isEmpty).toBe(false);
    expect(counter.snapshot()).toEqual({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      cost: 0,
    });
  });
});
