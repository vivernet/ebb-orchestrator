import { describe, expect, it, vi } from "vitest";
import type { Database } from "../../../src/platform/database/database.js";
import type { WorkflowEngine } from "../../../src/modules/workflow/workflow-engine.js";
import type { SchedulerService } from "../../../src/modules/scheduler/scheduler-service.js";
import type { RunService } from "../../../src/modules/runtime/run-service.js";
import { RuntimeEventHandlers } from "../../../src/modules/runtime/run-event-handlers.js";

describe("RuntimeEventHandlers runtime dispatch", () => {
  function setup() {
    const db = {
      exec: vi.fn(),
      get: vi.fn().mockReturnValue({ id: "task-1", status: "READY" }),
    } as unknown as Database;
    const workflow = {} as WorkflowEngine;
    const scheduler = {
      dispatchTask: vi.fn(),
      releaseTask: vi.fn(),
    } as unknown as SchedulerService;
    const run = { id: "run-1" };
    const runService = {
      prepareRun: vi.fn().mockReturnValue(run),
      executePreparedRun: vi.fn().mockResolvedValue({
        run,
        outcome: { success: true, exitCode: 0, output: "accepted", diagnostics: { runId: "run-1" } },
      }),
      failPreparedRun: vi.fn(),
    } as unknown as RunService;
    const handlers = new RuntimeEventHandlers(db, workflow, scheduler, runService);
    vi.spyOn(handlers, "handleRuntimeCompletion").mockImplementation(() => undefined);
    return { db, workflow, scheduler, runService, handlers };
  }

  it("persists one run identity, binds it to the scheduler reservation, and executes it", async () => {
    const { scheduler, runService, handlers } = setup();

    await handlers.handleAgentRunRequested({
      type: "AgentRunRequested",
      aggregateId: "task-1",
      payload: { role: "Developer", model: "test-model" },
    });

    expect(runService.prepareRun).toHaveBeenCalledWith(expect.objectContaining({
      role: "Developer",
      model: "test-model",
      taskId: "task-1",
      triggerReason: "runtime-request",
    }));
    expect(scheduler.dispatchTask).toHaveBeenCalledWith(
      "task-1",
      expect.anything(),
      expect.any(Function),
      expect.objectContaining({ runId: "run-1", role: "Developer", model: "test-model" }),
    );
    expect(runService.executePreparedRun).toHaveBeenCalledWith("run-1");
    expect(runService.failPreparedRun).not.toHaveBeenCalled();
  });

  it("fails the same prepared run and releases its reservation when launch fails", async () => {
    const { scheduler, runService, handlers } = setup();
    vi.mocked(runService.executePreparedRun).mockRejectedValueOnce(new Error("launcher unavailable"));

    await expect(handlers.handleAgentRunRequested({
      type: "AgentRunRequested",
      aggregateId: "task-1",
      payload: {},
    })).rejects.toThrow("launcher unavailable");

    expect(runService.failPreparedRun).toHaveBeenCalledWith("run-1", expect.any(Error));
    expect(scheduler.releaseTask).toHaveBeenCalledWith("task-1", 0);
  });
});
