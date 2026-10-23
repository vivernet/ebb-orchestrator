import { describe, expect, it } from "vitest";
import { AgentEventBus, type AgentEvent } from "../../../src/modules/runtime/agent-events.js";

describe("AgentEvent union and process-local bus", () => {
  it("delivers events to subscribed listeners in emission order", () => {
    const bus = new AgentEventBus();
    const received: AgentEvent[] = [];
    bus.addListener((event) => received.push(event));
    const started: AgentEvent = { type: "run_started", runId: "run-1", occurredAt: "2026-01-01T00:00:00.000Z" };
    const finished: AgentEvent = { type: "run_finished", runId: "run-1", status: "COMPLETED" };
    bus.emit(started);
    bus.emit(finished);
    expect(received).toEqual([started, finished]);
  });

  it("stops delivering after unsubscribe and tolerates emitting with no listeners", () => {
    const bus = new AgentEventBus();
    const received: AgentEvent[] = [];
    const unsubscribe = bus.addListener((event) => received.push(event));
    unsubscribe();
    expect(() => bus.emit({ type: "tool_pending", runId: "run-1", toolId: "workspace.read" })).not.toThrow();
    expect(received).toEqual([]);
  });

  it("never propagates listener errors to the emitter", () => {
    const bus = new AgentEventBus();
    const received: AgentEvent[] = [];
    bus.addListener(() => {
      throw new Error("observer boom");
    });
    bus.addListener((event) => received.push(event));
    expect(() => bus.emit({ type: "run_finished", runId: "run-1", status: "FAILED" })).not.toThrow();
    expect(received).toHaveLength(1);
  });

  it("keeps tool_result payload to boolean success and optional error category only", () => {
    const withCategory: AgentEvent = {
      type: "tool_result", runId: "run-1", toolId: "git.commit", success: false, errorCategory: "PROCESS_FAILURE",
    };
    const withoutCategory: AgentEvent = { type: "tool_result", runId: "run-1", toolId: "git.commit", success: true };
    expect(Object.keys(withCategory)).toEqual(["type", "runId", "toolId", "success", "errorCategory"]);
    expect(Object.keys(withoutCategory)).toEqual(["type", "runId", "toolId", "success"]);
    expect(JSON.stringify(withCategory)).not.toContain("output");
    expect(JSON.stringify(withCategory)).not.toContain("arguments");
  });

  it("keeps run_finished to identity and terminal status only", () => {
    const event: AgentEvent = { type: "run_finished", runId: "run-1", status: "CANCELLED" };
    expect(Object.keys(event)).toEqual(["type", "runId", "status"]);
  });
});
