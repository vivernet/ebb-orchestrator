import { describe, expect, it } from "vitest";
import type { DashboardProjection, ExecutionQueueProjection, TaskOverviewProjection } from "../src/api.js";

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
    const execution = { running: [], waiting: [], blocked: [{ taskId: "task-1", reason }] } satisfies ExecutionQueueProjection;

    expect(JSON.stringify(dashboard)).not.toContain("waitReason");
    expect(JSON.stringify(task)).toContain("ONBOARDING_NOT_ACTIVE");
    expect(execution.waiting).toHaveLength(0);
    expect(execution.blocked[0]?.reason).toEqual(reason);
  });
});
