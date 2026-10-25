import { describe, expect, it } from "vitest";
import type { DashboardProjection, ExecutionQueueProjection, TaskOverviewProjection } from "../src/api.js";
import { availabilityFromNullable, runUsageProjectionSchema } from "../src/reference-projections.js";

describe("scheduler projection contract", () => {
  it("serializes onboarding blocking as a hard BLOCK reason without legacy waitReason", () => {
    const reason = { code: "ONBOARDING_NOT_ACTIVE" as const, message: "Онбординг проекта не активирован" as const };
    const dashboard: DashboardProjection = {
      activeAgents: [],
      activeWork: [{ id: "task-1", title: "Task", status: "READY", eligibility: { status: "BLOCK", reason } }],
      approvals: 0,
      usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 },
      projects: [],
    };
    const task = { scheduler: { status: "BLOCK" as const, reason }, task: null, contract: null, lifecycle: { status: "READY", stage: "READY", updatedAt: null }, git: { repositoryPath: null, branch: null, defaultBranch: null, github: null, worktreePath: null }, runs: [], findings: [], defects: [], dependencies: [], approvals: [], events: [], usage: dashboard.usage } satisfies TaskOverviewProjection;
    const execution = {
      running: [],
      waiting: [],
      blocked: [{ taskId: "task-1", reason }],
      capacity: { configured: 4, used: 0 },
      locks: [],
      recentEvents: [],
      dispatchState: { paused: false, updatedAt: null },
    } satisfies ExecutionQueueProjection;

    expect(JSON.stringify(dashboard)).not.toContain("waitReason");
    expect(JSON.stringify(task)).toContain("ONBOARDING_NOT_ACTIVE");
    expect(execution.waiting).toHaveLength(0);
    expect(execution.blocked[0]?.reason).toEqual(reason);
    expect(execution.dispatchState.paused).toBe(false);
  });

  it("execution queue growth carries capacity, locks and durable dispatch state", () => {
    const execution = {
      running: [{ runId: "run-1", role: "Developer", taskId: "task-1", status: "IN_PROGRESS" }],
      waiting: [],
      blocked: [],
      capacity: { configured: 4, used: 1 },
      locks: [{ id: "lock-1", resource: "runtime:hermes", runId: "run-1", kind: "exclusive", heldAt: "2026-10-25T12:00:00.000Z" }],
      recentEvents: [{ id: "evt-1", type: "AgentRunRequested", createdAt: "2026-10-25T12:00:00.000Z" }],
      dispatchState: { paused: true, updatedAt: "2026-10-25T12:00:00.000Z" },
    } satisfies ExecutionQueueProjection;

    expect(execution.capacity).toEqual({ configured: 4, used: 1 });
    expect(execution.locks[0]?.runId).toBe("run-1");
    expect(execution.recentEvents[0]?.type).toBe("AgentRunRequested");
    expect(execution.dispatchState.paused).toBe(true);
  });

  it("run usage preserves NULL-vs-zero without a `?? 0` fallback", () => {
    expect(availabilityFromNullable(null)).toEqual({ availability: "unavailable", reason: "NOT_RECORDED" });
    expect(availabilityFromNullable(0)).toEqual({ availability: "available", value: 0 });
    expect(availabilityFromNullable(128)).toEqual({ availability: "available", value: 128 });

    const parsed = runUsageProjectionSchema.parse({
      inputTokens: { availability: "unavailable", reason: "NOT_RECORDED" },
      cachedInputTokens: { availability: "available", value: 0 },
      outputTokens: { availability: "available", value: 340 },
      effectiveCost: { availability: "available", value: 0.55 },
    });
    expect(parsed.inputTokens).toEqual({ availability: "unavailable", reason: "NOT_RECORDED" });
    expect(parsed.cachedInputTokens).toEqual({ availability: "available", value: 0 });
    expect(parsed.outputTokens).toEqual({ availability: "available", value: 340 });
  });
});
