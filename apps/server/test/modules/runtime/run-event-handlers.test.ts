import { describe, expect, it, vi } from "vitest";
import type { Database } from "../../../src/platform/database/database.js";
import type { WorkflowEngine } from "../../../src/modules/workflow/workflow-engine.js";
import type { SchedulerService } from "../../../src/modules/scheduler/scheduler-service.js";
import type { RunService } from "../../../src/modules/runtime/run-service.js";
import { RuntimeEventHandlers } from "../../../src/modules/runtime/run-event-handlers.js";

describe("RuntimeEventHandlers committed Task handoff", () => {
  function setup(role = "developer", status = "STARTED") {
    const record = { task_id: "task-1", role, status, output: status === "COMPLETED" ? "stored-outcome" : null };
    const db = { get: vi.fn(() => record) } as unknown as Database;
    const workflow = {} as WorkflowEngine;
    const scheduler = { getRunRequest: vi.fn((taskId: string, requestId: string) => taskId === "task-1" && requestId === "request-1"
      ? { id: requestId, taskId, role, status: "DISPATCHED", runId: "run-1" } : undefined), dispatchTask: vi.fn() } as unknown as SchedulerService;
    const runService = { executeTaskRequestRun: vi.fn().mockResolvedValue({ run: { id: "run-1" }, outcome: { diagnostics: { runId: "run-1" } } }),
      prepareRun: vi.fn(), reconcileTaskIntegrationOutcome: vi.fn() } as unknown as RunService;
    const handlers = new RuntimeEventHandlers(db, workflow, scheduler, runService);
    const project = vi.spyOn(handlers, "handleRuntimeCompletion").mockImplementation(() => undefined);
    const event = { type: "AgentRunRequested", aggregateId: "task-1", payload: { requestId: "request-1", runId: "run-1" } };
    return { db, scheduler, runService, handlers, project, event, record, workflow };
  }

  it("executes only the exact committed Run without preparing or direct dispatch", async () => {
    const f = setup(); await f.handlers.handleAgentRunRequested(f.event);
    expect(f.runService.executeTaskRequestRun).toHaveBeenCalledWith("request-1", "run-1", "task-1", expect.any(Function));
    expect(f.runService.prepareRun).not.toHaveBeenCalled();
    expect(f.scheduler.dispatchTask).not.toHaveBeenCalled();
    expect(f.project).toHaveBeenCalledTimes(1);
  });
  it("propagates infrastructure failure for durable recovery", async () => {
    const f = setup(); vi.mocked(f.runService.executeTaskRequestRun).mockRejectedValue(new Error("launcher unavailable"));
    await expect(f.handlers.handleAgentRunRequested(f.event)).rejects.toThrow("launcher unavailable");
    expect(f.project).not.toHaveBeenCalled();
  });
  it("rejects legacy events without committed request/run identities", async () => {
    const f = setup(); await expect(f.handlers.handleAgentRunRequested({ ...f.event, payload: { role: "developer" } })).rejects.toThrow("RUN_REQUEST_COMMITTED_IDENTITY_REQUIRED");
    expect(f.runService.executeTaskRequestRun).not.toHaveBeenCalled();
  });
  it.each(["request-foreign", "run-foreign", "task-foreign", "role-foreign"])("rejects %s identity", async (kind) => {
    const f = setup();
    if (kind === "role-foreign") f.record.role = "qa";
    const event = { ...f.event, aggregateId: kind === "task-foreign" ? "other-task" : f.event.aggregateId,
      payload: { requestId: kind === "request-foreign" ? "other-request" : "request-1", runId: kind === "run-foreign" ? "other-run" : "run-1" } };
    await expect(f.handlers.handleAgentRunRequested(event)).rejects.toThrow("RUN_REQUEST_COMMITTED_IDENTITY_MISMATCH");
    expect(f.runService.executeTaskRequestRun).not.toHaveBeenCalled();
  });
  it("projects stored completed output without invoking runtime", async () => {
    const f = setup("developer", "COMPLETED"); await f.handlers.handleAgentRunRequested(f.event);
    expect(f.project).toHaveBeenCalledWith("run-1", expect.objectContaining({ output: "stored-outcome" }));
    expect(f.runService.executeTaskRequestRun).not.toHaveBeenCalled();
  });
  it.each(["FAILED", "CANCELLED"])("never relaunches terminal %s Run", async (status) => {
    const f = setup("developer", status); await f.handlers.handleAgentRunRequested(f.event);
    expect(f.runService.executeTaskRequestRun).not.toHaveBeenCalled();
  });
  it("retains a selected Reviewer role through matching committed handoff", async () => {
    const f = setup("reviewer"); await f.handlers.handleAgentRunRequested(f.event);
    expect(f.runService.executeTaskRequestRun).toHaveBeenCalledTimes(1);
  });
  it("fails closed before reading mutable state when lifecycle is not READY", async () => {
    const f = setup(); const handlers = new RuntimeEventHandlers(f.db, f.workflow, f.scheduler, f.runService, undefined, () => false);
    await expect(handlers.handleAgentRunRequested(f.event)).resolves.toBe("deferred");
    expect(f.db.get).not.toHaveBeenCalled();
    expect(f.runService.executeTaskRequestRun).not.toHaveBeenCalled();
  });
});
