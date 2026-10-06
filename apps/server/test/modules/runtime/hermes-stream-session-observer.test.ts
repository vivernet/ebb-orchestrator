import { describe, expect, it } from "vitest";
import {
  HermesStreamSessionObserver,
  HERMES_STREAM_MAX_INIT_EVENT_BYTES,
  HERMES_STREAM_MAX_LINE_BYTES,
} from "../../../src/modules/runtime/hermes/hermes-stream-session-observer.js";

const encoder = new TextEncoder();

function initEvent(sessionId = "session_20261004_abc-123", extra: Record<string, unknown> = {}): Uint8Array {
  return encoder.encode(`${JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, ...extra })}\n`);
}

function feedAll(observer: HermesStreamSessionObserver, input: string): ReturnType<HermesStreamSessionObserver["push"]> {
  return observer.push(encoder.encode(input));
}

describe("Hermes live stream session observer", () => {
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
