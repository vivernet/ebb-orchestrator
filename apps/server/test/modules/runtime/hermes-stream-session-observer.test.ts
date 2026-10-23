import { describe, expect, it } from "vitest";
import {
  HermesStreamSessionObserver,
  HERMES_STREAM_MAX_INIT_EVENT_BYTES,
  HERMES_STREAM_MAX_LINE_BYTES,
} from "../../../src/modules/runtime/hermes/hermes-stream-session-observer.js";
import type { AgentEvent } from "../../../src/modules/runtime/agent-events.js";

const encoder = new TextEncoder();

function initEvent(sessionId = "session_20261004_abc-123", extra: Record<string, unknown> = {}): Uint8Array {
  return encoder.encode(`${JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, ...extra })}\n`);
}

function feedAll(observer: HermesStreamSessionObserver, input: string): ReturnType<HermesStreamSessionObserver["push"]> {
  return observer.push(encoder.encode(input));
}

describe("Hermes live stream session observer", () => {
  it("retains only numeric usage from a correlated terminal result across split chunks", () => {
    const observer = new HermesStreamSessionObserver();
    observer.push(initEvent("usage-session"));
    const result = `${JSON.stringify({ type: "result", session_id: "usage-session",
      tokens: { input: 123, output: 45, total: 168, cache_read: 10, cache_write: 2 },
      text: "secret-answer", error: "secret-error", unrelated: { secret: "private-detail" } })}\n`;
    feedAll(observer, result.slice(0, 52));
    expect(observer.usage).toBeNull();
    feedAll(observer, result.slice(52));
    expect(observer.finish()).toEqual({ status: "captured" });
    expect(observer.usage).toEqual({ inputTokens: 123, outputTokens: 45, cachedInputTokens: 10 });
    expect(JSON.stringify(observer.usage)).not.toContain("secret");
    expect(JSON.stringify(observer.usage)).not.toContain("private-detail");
  });

  it("counts only submit_result calls and error results without retaining event content", () => {
    const observer = new HermesStreamSessionObserver();
    const secretMarker = "never-retain-submit-payload";
    observer.push(initEvent("counts-session"));
    feedAll(observer, [
      { type: "tool_use", name: "mcp__ebb_orchestrator__submit_result", input: { secret: secretMarker } },
      { type: "tool_result", name: "mcp__ebb_orchestrator__submit_result", is_error: true, output: secretMarker },
      { type: "tool_use", name: "submit_result", input: secretMarker },
      { type: "tool_result", name: "submit_result", is_error: false, output: secretMarker },
      { type: "tool_use", name: "submit_result_extra", input: secretMarker },
      { type: "tool_result", name: "other_tool", is_error: true, output: secretMarker },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n");

    expect(observer.submitResultCounts).toEqual({ toolUses: 2, calls: 2, errors: 1 });
    expect(JSON.stringify(observer.submitResultCounts)).not.toContain(secretMarker);
    expect(JSON.stringify(observer.submitResultCounts)).not.toContain("input");
    expect(JSON.stringify(observer.submitResultCounts)).not.toContain("output");
  });

  it("counts only the fixed Ebb tool IDs and retains no event payload", () => {
    const observer = new HermesStreamSessionObserver();
    const secretMarker = "must-not-escape-stream-observer";
    observer.push(initEvent("tool-summary-session"));
    const events = [
      ["workspace.read", true], ["workspace.patch", true], ["workspace.search", false], ["project.test", true],
      ["git.add", false], ["git.commit", true], ["git.head", false], ["submit_result", true],
    ].flatMap(([name, failed]) => [
      { type: "tool_use", name: `mcp__ebb_orchestrator__${String(name).replaceAll(".", "_")}`, input: { secret: secretMarker } },
      { type: "tool_result", name: `mcp__ebb_orchestrator__${String(name).replaceAll(".", "_")}`, is_error: failed, output: secretMarker },
    ]);
    events.push(
      { type: "tool_use", name: "mcp__untrusted__secret_tool", input: { secret: secretMarker } },
      { type: "tool_result", name: "mcp__untrusted__secret_tool", is_error: true, output: secretMarker },
    );
    feedAll(observer, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);

    expect(observer.toolEventCountsSnapshot).toEqual({
      "workspace.read": { uses: 1, results: 1, successes: 0, errors: 1, errorCategories: { INVALID_ARGUMENTS: 0, PERMISSION_DENIED: 0, NOT_AVAILABLE: 0, PROCESS_FAILURE: 0, OTHER: 1 } },
      "workspace.patch": { uses: 1, results: 1, successes: 0, errors: 1, errorCategories: { INVALID_ARGUMENTS: 0, PERMISSION_DENIED: 0, NOT_AVAILABLE: 0, PROCESS_FAILURE: 0, OTHER: 1 } },
      "workspace.search": { uses: 1, results: 1, successes: 1, errors: 0, errorCategories: { INVALID_ARGUMENTS: 0, PERMISSION_DENIED: 0, NOT_AVAILABLE: 0, PROCESS_FAILURE: 0, OTHER: 0 } },
      "project.test": { uses: 1, results: 1, successes: 0, errors: 1, errorCategories: { INVALID_ARGUMENTS: 0, PERMISSION_DENIED: 0, NOT_AVAILABLE: 0, PROCESS_FAILURE: 0, OTHER: 1 } },
      "git.add": { uses: 1, results: 1, successes: 1, errors: 0, errorCategories: { INVALID_ARGUMENTS: 0, PERMISSION_DENIED: 0, NOT_AVAILABLE: 0, PROCESS_FAILURE: 0, OTHER: 0 } },
      "git.commit": { uses: 1, results: 1, successes: 0, errors: 1, errorCategories: { INVALID_ARGUMENTS: 0, PERMISSION_DENIED: 0, NOT_AVAILABLE: 0, PROCESS_FAILURE: 0, OTHER: 1 } },
      "git.head": { uses: 1, results: 1, successes: 1, errors: 0, errorCategories: { INVALID_ARGUMENTS: 0, PERMISSION_DENIED: 0, NOT_AVAILABLE: 0, PROCESS_FAILURE: 0, OTHER: 0 } },
      submit_result: { uses: 1, results: 1, successes: 0, errors: 1, errorCategories: { INVALID_ARGUMENTS: 0, PERMISSION_DENIED: 0, NOT_AVAILABLE: 0, PROCESS_FAILURE: 0, OTHER: 1 } },
    });
    expect(JSON.stringify(observer.toolEventCountsSnapshot)).not.toContain(secretMarker);
    expect(JSON.stringify(observer.toolEventCountsSnapshot)).not.toContain("untrusted");
  });

  it("classifies allowlisted tool errors into fixed categories without retaining their output", () => {
    const observer = new HermesStreamSessionObserver();
    const secretMarker = "private-error-detail-must-not-escape";
    observer.push(initEvent("error-category-session"));
    const tool = "mcp__ebb_orchestrator__workspace_patch";
    const outputs = [
      [true, { error: `INVALID_TOOL_ARGS: ${secretMarker}` }],
      [true, { output: JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ error: `schema validation failed: ${secretMarker}` }) }] }) }],
      [true, { error: `CAPABILITY_REVOKED: ${secretMarker}` }],
      [true, { error: `git not available: ${secretMarker}` }],
      [true, { error: `PROCESS_FAILURE: command exited with code 7: ${secretMarker}` }],
      [true, { error: secretMarker }],
      [false, { error: `PERMISSION_DENIED: ${secretMarker}` }],
    ] as const;
    feedAll(observer, `${outputs.map(([isError, output]) => JSON.stringify({
      type: "tool_result", name: tool, is_error: isError, output,
    })).join("\n")}\n${JSON.stringify({
      type: "tool_result", name: "mcp__untrusted__secret_tool", is_error: true,
      output: { error: `PERMISSION_DENIED: ${secretMarker}` },
    })}\n`);

    expect(observer.toolEventCountsSnapshot["workspace.patch"]).toMatchObject({
      errors: 6,
      errorCategories: {
        INVALID_ARGUMENTS: 2,
        PERMISSION_DENIED: 1,
        NOT_AVAILABLE: 1,
        PROCESS_FAILURE: 1,
        OTHER: 1,
      },
    });
    expect(JSON.stringify(observer.toolEventCountsSnapshot)).not.toContain(secretMarker);
    expect(JSON.stringify(observer.toolEventCountsSnapshot)).not.toContain("CAPABILITY_REVOKED");
  });

  it("does not count tool_use as a successful result when no tool_result arrives", () => {
    const observer = new HermesStreamSessionObserver();
    observer.push(initEvent("missing-tool-result-session"));
    feedAll(observer, `${JSON.stringify({ type: "tool_use", name: "mcp__ebb_orchestrator__project_test", input: {} })}\n`);

    expect(observer.toolEventCountsSnapshot["project.test"]).toMatchObject({
      uses: 1,
      results: 0,
      successes: 0,
      errors: 0,
    });
  });

  it.each([
    { session_id: "another-session", tokens: { input: 1, output: 2, total: 3, cache_read: 0, cache_write: 0 } },
    { session_id: "usage-session" },
    { session_id: "usage-session", tokens: { input: -1, output: 2, total: 1, cache_read: 0, cache_write: 0 } },
    { session_id: "usage-session", tokens: { input: "1", output: 2, total: 3, cache_read: 0, cache_write: 0 } },
    { session_id: "usage-session", tokens: { input: 1, output: 2, total: 3, cache_read: 0.5, cache_write: 0 } },
    { session_id: "usage-session", tokens: { input: 1, output: 2, total: 3, cache_read: 0, cache_write: Number.MAX_SAFE_INTEGER + 1 } },
  ])("leaves malformed or uncorrelated result usage unavailable: %j", (result) => {
    const observer = new HermesStreamSessionObserver();
    observer.push(initEvent("usage-session"));
    feedAll(observer, `${JSON.stringify({ type: "result", ...result })}\n`);
    expect(observer.finish()).toEqual({ status: "captured" });
    expect(observer.usage).toBeNull();
  });

  it("discards usage after duplicate result or protocol invalidation", () => {
    const observer = new HermesStreamSessionObserver();
    observer.push(initEvent("usage-session"));
    const result = `${JSON.stringify({ type: "result", session_id: "usage-session",
      tokens: { input: 1, output: 2, total: 3, cache_read: 0, cache_write: 0 } })}\n`;
    feedAll(observer, result);
    expect(observer.usage).not.toBeNull();
    feedAll(observer, result);
    expect(observer.usage).toBeNull();
    observer.push(initEvent("usage-session"));
    expect(observer.usage).toBeNull();
  });

  it("incrementally accepts one init event when a multibyte UTF-8 character is split across chunks", () => {
    const observer = new HermesStreamSessionObserver();
    const bytes = initEvent("session_abc", { label: "café" });
    const splitAt = bytes.indexOf(0xc3) + 1;

    expect(observer.push(bytes.slice(0, splitAt))).toEqual({ status: "pending" });
    expect(observer.push(bytes.slice(splitAt))).toEqual({
      status: "captured",
      projection: { type: "system", subtype: "init", sessionId: "session_abc" },
    });
    expect(observer.finish()).toEqual({ status: "captured" });
  });

  it("holds partial JSONL lines until newline and handles multiple chunks", () => {
    const observer = new HermesStreamSessionObserver();
    const event = JSON.stringify({ type: "system", subtype: "init", session_id: "session_partial" });

    expect(feedAll(observer, event.slice(0, 15))).toEqual({ status: "pending" });
    expect(feedAll(observer, event.slice(15))).toEqual({ status: "pending" });
    expect(observer.push(encoder.encode("\n"))).toEqual({
      status: "captured",
      projection: { type: "system", subtype: "init", sessionId: "session_partial" },
    });
  });

  it("accepts a complete final JSONL record on finish when the newline is absent", () => {
    const observer = new HermesStreamSessionObserver();
    const event = JSON.stringify({ type: "system", subtype: "init", session_id: "session_eof" });

    expect(feedAll(observer, event)).toEqual({ status: "pending" });
    expect(observer.finish()).toEqual({
      status: "captured",
      projection: { type: "system", subtype: "init", sessionId: "session_eof" },
    });
    expect(observer.finish()).toEqual({ status: "captured" });
  });

  it("fails closed when a line exceeds the bounded line limit", () => {
    const observer = new HermesStreamSessionObserver();
    const result = observer.push(new Uint8Array(HERMES_STREAM_MAX_LINE_BYTES + 1).fill(0x61));

    expect(result).toEqual({ status: "invalid", reason: "LINE_TOO_LARGE" });
    expect(JSON.stringify(result)).not.toContain("a".repeat(32));
  });

  it("rejects an oversized init event even when it is within the general line limit", () => {
    const observer = new HermesStreamSessionObserver();
    const extraBytes = HERMES_STREAM_MAX_INIT_EVENT_BYTES + 1;
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "session_oversized",
      padding: "x".repeat(extraBytes),
    });

    expect(encoder.encode(line).byteLength).toBeLessThanOrEqual(HERMES_STREAM_MAX_LINE_BYTES);
    expect(feedAll(observer, `${line}\n`)).toEqual({ status: "invalid", reason: "INIT_EVENT_TOO_LARGE" });
  });

  it("requires the first JSONL event to be the one allowlisted system/init event", () => {
    const observer = new HermesStreamSessionObserver();

    expect(feedAll(observer, `${JSON.stringify({ type: "text", text: "secret output" })}\n`)).toEqual({
      status: "invalid",
      reason: "UNEXPECTED_INITIAL_EVENT",
    });
    expect(JSON.stringify(observer.finish())).not.toContain("secret output");
  });

  it("rejects malformed JSON without including its contents in the failure projection", () => {
    const observer = new HermesStreamSessionObserver();
    const raw = '{"type":"system","subtype":"init","session_id":"secret-session-value"';

    const result = feedAll(observer, `${raw}\n`);
    expect(result).toEqual({ status: "invalid", reason: "MALFORMED_JSON" });
    expect(JSON.stringify(result)).not.toContain("secret-session-value");
  });

  it("rejects a system event with the wrong subtype", () => {
    const observer = new HermesStreamSessionObserver();

    expect(feedAll(observer, `${JSON.stringify({ type: "system", subtype: "ready", session_id: "session_wrong" })}\n`)).toEqual({
      status: "invalid",
      reason: "UNEXPECTED_INITIAL_EVENT",
    });
  });

  it("rejects invalid session ID values without echoing them", () => {
    const observer = new HermesStreamSessionObserver();
    const invalidId = "session-value-with-secret/and spaces";

    const result = feedAll(observer, `${JSON.stringify({ type: "system", subtype: "init", session_id: invalidId })}\n`);
    expect(result).toEqual({ status: "invalid", reason: "INVALID_SESSION_ID" });
    expect(JSON.stringify(result)).not.toContain(invalidId);
  });

  it("rejects a second init event even when the first init was already projected", () => {
    const observer = new HermesStreamSessionObserver();

    expect(observer.push(initEvent("session_first"))).toMatchObject({ status: "captured" });
    const result = observer.push(initEvent("session_second"));
    expect(result).toEqual({ status: "invalid", reason: "DUPLICATE_INIT" });
    expect(JSON.stringify(result)).not.toContain("session_second");
  });

  it("ignores later result session IDs instead of treating them as capture authority", () => {
    const observer = new HermesStreamSessionObserver();
    expect(observer.push(initEvent("session_authoritative"))).toMatchObject({ status: "captured" });

    const laterResult = feedAll(observer, `${JSON.stringify({ type: "result", session_id: "session_untrusted" })}\n`);
    expect(laterResult).toEqual({ status: "captured" });
    expect(JSON.stringify(laterResult)).not.toContain("session_untrusted");
  });

  it("rejects a malformed line after capture so later stream violations can invalidate the binding", () => {
    const observer = new HermesStreamSessionObserver();

    expect(observer.push(initEvent("session_first"))).toMatchObject({ status: "captured" });
    expect(feedAll(observer, '{"type":\n')).toEqual({ status: "invalid", reason: "MALFORMED_JSON" });
  });

  it("rejects a non-init first event and reports an empty stream as missing at finish", () => {
    const observer = new HermesStreamSessionObserver();

    expect(feedAll(observer, `${JSON.stringify({ type: "text", text: "not init" })}\n`)).toEqual({
      status: "invalid",
      reason: "UNEXPECTED_INITIAL_EVENT",
    });
    expect(new HermesStreamSessionObserver().finish()).toEqual({ status: "invalid", reason: "MISSING_INIT" });
  });

  it("rejects invalid UTF-8 and partial malformed JSON at finish using bounded reasons", () => {
    const invalidUtf8 = new HermesStreamSessionObserver();
    expect(invalidUtf8.push(Uint8Array.of(0xc3, 0x28, 0x0a))).toEqual({ status: "invalid", reason: "INVALID_UTF8" });

    const partialJson = new HermesStreamSessionObserver();
    expect(feedAll(partialJson, '{"type":"system"')).toEqual({ status: "pending" });
    expect(partialJson.finish()).toEqual({ status: "invalid", reason: "MALFORMED_JSON" });
  });

  it("never returns raw event fields and exposes only the bounded session projection", () => {
    const observer = new HermesStreamSessionObserver();
    const secretMarker = "do-not-expose-provider-output";
    const result = observer.push(initEvent("session_safe", { text: secretMarker, tool_input: { secret: secretMarker } }));

    expect(result).toEqual({
      status: "captured",
      projection: { type: "system", subtype: "init", sessionId: "session_safe" },
    });
    expect(JSON.stringify(result)).not.toContain(secretMarker);
  });

  it("does not allow input after finish to revive a captured observer", () => {
    const observer = new HermesStreamSessionObserver();
    expect(observer.push(initEvent("session_finished"))).toMatchObject({ status: "captured" });
    expect(observer.finish()).toEqual({ status: "captured" });
    expect(observer.push(initEvent("session_late"))).toEqual({ status: "invalid", reason: "STREAM_FINISHED" });
  });
});

describe("Hermes stream observer allowlisted tool events", () => {
  it("emits tool_pending and tool_result for an allowlisted tool without any payload", () => {
    const events: AgentEvent[] = [];
    const secretMarker = "must-not-escape-tool-event";
    const observer = new HermesStreamSessionObserver("run-123", { emit: (event) => events.push(event) });
    observer.push(initEvent("tool-event-session"));
    feedAll(observer, [
      { type: "tool_use", name: "mcp__ebb_orchestrator__workspace_read", input: { secret: secretMarker } },
      { type: "tool_result", name: "mcp__ebb_orchestrator__workspace_read", is_error: true, output: { error: `INVALID_TOOL_ARGS: ${secretMarker}` } },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n");

    expect(events).toEqual([
      { type: "tool_pending", runId: "run-123", toolId: "workspace.read" },
      { type: "tool_result", runId: "run-123", toolId: "workspace.read", success: false, errorCategory: "INVALID_ARGUMENTS" },
    ]);
    expect(JSON.stringify(events)).not.toContain(secretMarker);
    expect(JSON.stringify(events)).not.toContain("input");
    expect(JSON.stringify(events)).not.toContain("output");
  });

  it("emits success tool_result without errorCategory and emits nothing for untrusted tools", () => {
    const events: AgentEvent[] = [];
    const observer = new HermesStreamSessionObserver("run-123", { emit: (event) => events.push(event) });
    observer.push(initEvent("tool-event-session"));
    feedAll(observer, [
      { type: "tool_use", name: "submit_result", input: {} },
      { type: "tool_result", name: "submit_result", is_error: false, output: { ok: true } },
      { type: "tool_use", name: "mcp__untrusted__secret_tool", input: { secret: "x" } },
      { type: "tool_result", name: "mcp__untrusted__secret_tool", is_error: true, output: { secret: "x" } },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n");

    expect(events).toEqual([
      { type: "tool_pending", runId: "run-123", toolId: "submit_result" },
      { type: "tool_result", runId: "run-123", toolId: "submit_result", success: true },
    ]);
  });

  it("does not emit tool events without a bound runId and tolerates a throwing sink", () => {
    const unbounded = new HermesStreamSessionObserver();
    unbounded.push(initEvent("no-events-session"));
    feedAll(unbounded, `${JSON.stringify({ type: "tool_use", name: "mcp__ebb_orchestrator__project_test", input: {} })}\n`);
    expect(unbounded.toolEventCountsSnapshot["project.test"].uses).toBe(1);

    const throwing = new HermesStreamSessionObserver("run-123", { emit: () => { throw new Error("observer boom"); } });
    throwing.push(initEvent("no-events-session"));
    expect(() => feedAll(throwing, `${JSON.stringify({ type: "tool_use", name: "mcp__ebb_orchestrator__project_test", input: {} })}\n`)).not.toThrow();
    expect(throwing.toolEventCountsSnapshot["project.test"].uses).toBe(1);
  });
});
