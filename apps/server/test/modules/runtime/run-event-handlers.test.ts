import { describe, expect, it, vi } from "vitest";
import type { Database } from "../../../src/platform/database/database.js";
import type { WorkflowEngine } from "../../../src/modules/workflow/workflow-engine.js";
import type { SchedulerService } from "../../../src/modules/scheduler/scheduler-service.js";
import type { RunService } from "../../../src/modules/runtime/run-service.js";
import { RuntimeEventHandlers } from "../../../src/modules/runtime/run-event-handlers.js";

describe("RuntimeEventHandlers runtime dispatch", () => {
  function setup() {
    const worktree = { id: "task-1", repo_path: "C:/repo", path: "C:/worktree/task-1", branch: "task/task-1", created_at: "now", removed_at: null };
    const db = {
      exec: vi.fn(),
      get: vi.fn((sql: string) => sql.includes("FROM tasks")
        ? { id: "task-1", status: "READY", project_id: "project-1", epic_id: null }
        : sql.includes("FROM worktrees") ? worktree
          : sql.includes("FROM git_operations") ? { target_ref: "HEAD" } : undefined),
    } as unknown as Database;
    const workflow = {} as WorkflowEngine;
    const releaseTaskMock = vi.fn();
    const scheduler = {
      assertProjectDispatchable: vi.fn(),
      dispatchTask: vi.fn(),
      releaseTask: releaseTaskMock,
    } as unknown as SchedulerService;
    const run = { id: "run-1", model: "test-model" };
    const runService = {
      prepareRun: vi.fn().mockReturnValue(run),
      prepareRunWithHermesPreflight: vi.fn().mockResolvedValue(run),
      executePreparedRun: vi.fn().mockResolvedValue({
        run,
        outcome: { success: true, exitCode: 0, output: "accepted", diagnostics: { runId: "run-1" } },
      }),
      failPreparedRun: vi.fn().mockReturnValue(true),
      cleanupTerminalHermesProfile: vi.fn().mockResolvedValue(undefined),
    } as unknown as RunService;
    const git = { run: vi.fn(async (_path: string, args: string[]) => ({
      exitCode: 0, stdout: args[0] === "symbolic-ref" ? worktree.branch : args[0] === "diff" ? "fixture diff" : "a".repeat(40), stderr: "",
    })) };
    const handlers = new RuntimeEventHandlers(db, workflow, scheduler, runService, git);
    vi.spyOn(handlers, "handleRuntimeCompletion").mockImplementation(() => undefined);
    return { db, workflow, scheduler, runService, handlers, git, releaseTaskMock };
  }

  it("persists one run identity, binds it to the scheduler reservation, and executes it", async () => {
    const { scheduler, runService, handlers } = setup();

    await handlers.handleAgentRunRequested({
      type: "AgentRunRequested",
      aggregateId: "task-1",
      payload: { role: "Developer", model: "test-model" },
    });

    expect(runService.prepareRunWithHermesPreflight).toHaveBeenCalledWith(expect.objectContaining({
      role: "developer",
      model: "test-model",
      taskId: "task-1",
      epicId: null,
      contextInput: expect.objectContaining({
        role: "developer", subject: { type: "TASK", id: "task-1" },
        execution: expect.objectContaining({ targetHead: "a".repeat(40), targetBranch: "task/task-1" }),
      }),
      triggerReason: "runtime-request",
    }));
    expect(scheduler.dispatchTask).toHaveBeenCalledWith(
      "task-1",
      expect.anything(),
      expect.any(Function),
      expect.objectContaining({ runId: "run-1", role: "developer", model: "test-model" }),
    );
    expect(runService.executePreparedRun).toHaveBeenCalledWith("run-1");
    expect(runService.failPreparedRun).not.toHaveBeenCalled();
  });

  it("fails the same prepared run and releases its reservation when launch fails", async () => {
    const { scheduler, runService, handlers, releaseTaskMock } = setup();
    vi.mocked(runService.executePreparedRun).mockRejectedValueOnce(new Error("launcher unavailable"));

    await expect(handlers.handleAgentRunRequested({
      type: "AgentRunRequested",
      aggregateId: "task-1",
      payload: {},
    })).rejects.toThrow("launcher unavailable");

    expect(runService.failPreparedRun).toHaveBeenCalledWith("run-1", expect.any(Error));
    expect(scheduler.releaseTask).toHaveBeenCalledWith("task-1", 0);
    expect(runService.cleanupTerminalHermesProfile).toHaveBeenCalledWith("run-1");
    expect(releaseTaskMock.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(runService.cleanupTerminalHermesProfile).mock.invocationCallOrder[0]!,
    );
  });

  it("retains task reservation when launch failure has no persisted stop proof", async () => {
    const { scheduler, runService, handlers } = setup();
    vi.mocked(runService.executePreparedRun).mockRejectedValueOnce(new Error("launcher unavailable"));
    vi.mocked(runService.failPreparedRun).mockReturnValueOnce(false);

    await expect(handlers.handleAgentRunRequested({
      type: "AgentRunRequested", aggregateId: "task-1", payload: {},
    })).rejects.toThrow("launcher unavailable");

    expect(runService.failPreparedRun).toHaveBeenCalledWith("run-1", expect.any(Error));
    expect(scheduler.releaseTask).not.toHaveBeenCalled();
    expect(runService.cleanupTerminalHermesProfile).not.toHaveBeenCalled();
  });

  it("rejects unsupported Task roles before scheduler or Run preparation", async () => {
    const { scheduler, runService, handlers } = setup();

    await expect(handlers.handleAgentRunRequested({
      type: "AgentRunRequested", aggregateId: "task-1", payload: { role: "coordinator" },
    })).rejects.toThrow("TASK_RUN_ROLE_UNSUPPORTED");

    expect(runService.prepareRunWithHermesPreflight).not.toHaveBeenCalled();
    expect(scheduler.assertProjectDispatchable).not.toHaveBeenCalled();
    expect(scheduler.dispatchTask).not.toHaveBeenCalled();
  });

  it("keeps Reviewer as a supported Task role without using Developer transcript", async () => {
    const { scheduler, runService, handlers } = setup();

    await handlers.handleAgentRunRequested({
      type: "AgentRunRequested", aggregateId: "task-1", payload: { role: "reviewer", model: "test-model" },
    });

    const options = vi.mocked(runService.prepareRunWithHermesPreflight).mock.calls[0]?.[0];
    expect(options).toMatchObject({ role: "reviewer", contextInput: { role: "reviewer", roleInputs: { gitDiff: "fixture diff", checks: [] } } });
    expect(options?.contextInput?.prompt).toContain("Independently review");
    expect(options?.contextInput?.prompt).not.toContain("=== DEVELOPER TRANSCRIPT ===");
    expect(scheduler.dispatchTask).toHaveBeenCalledWith("task-1", expect.anything(), expect.any(Function), expect.objectContaining({ role: "reviewer" }));
  });

  it("fails closed without RunService instead of dispatching a legacy unmanifested Run", async () => {
    const { db, workflow, scheduler } = setup();
    const handlers = new RuntimeEventHandlers(db, workflow, scheduler);

    await expect(handlers.handleAgentRunRequested({
      type: "AgentRunRequested", aggregateId: "task-1", payload: { role: "Developer" },
    })).rejects.toThrow("RUN_PREPARATION_SERVICE_UNAVAILABLE");

    expect(scheduler.assertProjectDispatchable).not.toHaveBeenCalled();
    expect(scheduler.dispatchTask).not.toHaveBeenCalled();
  });
});
