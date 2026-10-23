import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  computePromptHash,
  EPIC_TRACE_PHASES,
  resolveTraceScenario,
  serializeUsageForStorage,
  TRACE_DIAGNOSTIC_CODES,
  TRACE_VERSION,
  TracingPayloadSchema,
  type TracingPayload,
} from "../../../../src/modules/runtime/tracing/tracing-payload.js";
import { digestRunPromptBytesV1 } from "../../../../src/modules/context/context-provenance.js";

function validPayload(overrides: Partial<TracingPayload> = {}): TracingPayload {
  return {
    runId: randomUUID(),
    scenario: "task-assignment",
    promptHash: "a".repeat(64),
    contextHash: "b".repeat(64),
    usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 2, cost: 0.01 },
    createdAt: "2026-10-23T12:00:00.000Z",
    version: TRACE_VERSION,
    ...overrides,
  };
}

describe("tracing payload contract", () => {
  it("accepts a complete payload", () => {
    expect(TracingPayloadSchema.safeParse(validPayload()).success).toBe(true);
  });

  it("accepts null scenario and null usage", () => {
    expect(TracingPayloadSchema.safeParse(validPayload({ scenario: null, usage: null })).success).toBe(true);
  });

  it("rejects unknown top-level fields, including runtime/model/provider labels", () => {
    for (const extra of [
      { runtime: "default" },
      { model: "claude" },
      { provider: "anthropic" },
      { labels: {} },
      { stderr: "x" },
      { rawOutput: "y" },
      { prompt: "z" },
    ]) {
      expect(TracingPayloadSchema.safeParse({ ...validPayload(), ...extra }).success).toBe(false);
    }
  });

  it("rejects nested unknown usage fields", () => {
    for (const usage of [
      { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, cost: null, model: "claude" },
      { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, cost: null, provider: "anthropic" },
      { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, cost: null, runtime: "hermes" },
    ]) {
      expect(TracingPayloadSchema.safeParse(validPayload({ usage: usage as never })).success).toBe(false);
    }
  });

  it("requires a canonical v4 UUID run id", () => {
    for (const runId of [
      "not-a-uuid",
      "00000000-0000-0000-0000-000000000000",
      randomUUID().toUpperCase(),
      `${randomUUID()}extra`,
    ]) {
      expect(TracingPayloadSchema.safeParse(validPayload({ runId })).success).toBe(false);
    }
  });

  it("requires lowercase 64-char hex hashes", () => {
    for (const hash of ["a".repeat(63), "A".repeat(64), "g".repeat(64), "", "a".repeat(65)]) {
      expect(TracingPayloadSchema.safeParse(validPayload({ promptHash: hash })).success).toBe(false);
      expect(TracingPayloadSchema.safeParse(validPayload({ contextHash: hash })).success).toBe(false);
    }
  });

  it("rejects out-of-bounds usage counts and costs", () => {
    const badUsage = [
      { inputTokens: -1, cachedInputTokens: 0, outputTokens: 0, cost: null },
      { inputTokens: 1.5, cachedInputTokens: 0, outputTokens: 0, cost: null },
      { inputTokens: Number.MAX_SAFE_INTEGER + 1, cachedInputTokens: 0, outputTokens: 0, cost: null },
      { inputTokens: Number.NaN, cachedInputTokens: 0, outputTokens: 0, cost: null },
      { inputTokens: Number.POSITIVE_INFINITY, cachedInputTokens: 0, outputTokens: 0, cost: null },
      { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, cost: -0.01 },
      { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, cost: Number.NEGATIVE_INFINITY },
    ];
    for (const usage of badUsage) {
      expect(TracingPayloadSchema.safeParse(validPayload({ usage: usage as never })).success).toBe(false);
    }
  });

  it("allows null cost while keeping token counts mandatory", () => {
    expect(TracingPayloadSchema.safeParse(validPayload({
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, cost: null },
    })).success).toBe(true);
  });

  it("rejects non-ISO created_at and unsupported version", () => {
    expect(TracingPayloadSchema.safeParse(validPayload({ createdAt: "2026-10-23" })).success).toBe(false);
    expect(TracingPayloadSchema.safeParse(validPayload({ createdAt: "2026-10-23T12:00:00Z" })).success).toBe(false);
    expect(TracingPayloadSchema.safeParse(validPayload({ version: "2.0" as never })).success).toBe(false);
    expect(TracingPayloadSchema.safeParse(validPayload({ version: "1.0" })).success).toBe(true);
  });

  it("rejects a serialized usage larger than 512 UTF-8 bytes", () => {
    const oversized = {
      inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, cost: null,
      padding: "x".repeat(600),
    } as unknown as TracingPayload["usage"];
    expect(TracingPayloadSchema.safeParse(validPayload({ usage: oversized })).success).toBe(false);
    expect(() => serializeUsageForStorage(oversized)).toThrow(/RUN_TRACE_USAGE_TOO_LARGE/);
  });

  it("serializes known usage deterministically and keeps unknown usage null", () => {
    expect(serializeUsageForStorage(null)).toBeNull();
    expect(serializeUsageForStorage({ inputTokens: 1, cachedInputTokens: 0, outputTokens: 2, cost: 0.1 }))
      .toBe('{"inputTokens":1,"cachedInputTokens":0,"outputTokens":2,"cost":0.1}');
  });

  describe("resolveTraceScenario", () => {
    it("maps null to SQL NULL without diagnostic", () => {
      expect(resolveTraceScenario(null)).toEqual({ ok: true, scenario: null });
    });

    it("maps every RunTrigger and runtime/planning triggers one-to-one", () => {
      for (const trigger of [
        "task-assignment", "review-request", "planning-request", "test-assignment", "custom",
        "runtime-request", "planning-request-role",
      ]) {
        expect(resolveTraceScenario(trigger)).toEqual({ ok: true, scenario: trigger });
      }
    });

    it("maps every fixed epic phase to the epic-phase scenario", () => {
      for (const phase of EPIC_TRACE_PHASES) {
        expect(resolveTraceScenario(`epic-${phase}`)).toEqual({ ok: true, scenario: "epic-phase" });
      }
    });

    it("skips unknown non-null triggers with only the stable diagnostic", () => {
      for (const trigger of ["unknown-trigger", "epic-bogus", "epic-phase", "Epic-plan", ""]) {
        expect(resolveTraceScenario(trigger)).toEqual({
          ok: false,
          diagnostic: TRACE_DIAGNOSTIC_CODES.SCENARIO_UNMAPPED,
        });
      }
    });
  });

  describe("computePromptHash", () => {
    it("returns a lowercase 64-char SHA-256 matching digestRunPromptBytesV1", () => {
      const bytes = new TextEncoder().encode("final prompt bytes");
      const hash = computePromptHash(bytes);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
      expect(hash).toBe(digestRunPromptBytesV1(bytes));
    });

    it("changes when prompt bytes change", () => {
      expect(computePromptHash(new TextEncoder().encode("one")))
        .not.toBe(computePromptHash(new TextEncoder().encode("two")));
    });
  });
});
