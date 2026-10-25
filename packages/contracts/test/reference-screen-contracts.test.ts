import { describe, expect, it } from "vitest";
import { apiPaths } from "../src/api.js";
import {
  approvalDetailProjectionSchema,
  approvalInboxProjectionSchema,
  approvalPolicyProjectionSchema,
  availabilityFromNullable,
  cancelAllRunsRequestSchema,
  cancelAllRunsResultSchema,
  dispatchStateRequestSchema,
  dispatchStateResponseSchema,
  epicPauseResponseSchema,
  epicReplanRequestSchema,
  epicReplanResponseSchema,
  executionQueueProjectionSchema,
  journalReconcileRequestSchema,
  journalReconcileResponseSchema,
  projectConfigCandidateEditorRequestSchema,
  projectConfigCandidateProjectionSchema,
  projectIndexPageProjectionSchema,
  projectIndexQuerySchema,
  projectPauseResponseSchema,
  runCheckpointProjectionSchema,
  runControlCommandResultSchema,
  runControlStateSchema,
  runDetailProjectionSchema,
  runEventsPageProjectionSchema,
  runEventsQuerySchema,
  runTerminalProjectionSchema,
  runUsageProjectionSchema,
  taskPriorityRequestSchema,
  taskPriorityResponseSchema,
  taskControlResponseSchema,
  usageWindowProjectionSchema,
  usageWindowQuerySchema,
} from "../src/reference-projections.js";

const UTF_TIMESTAMP = "2026-10-25T12:00:00.000Z";
const HASH64 = "a".repeat(64);

function validExecutionQueue() {
  return {
    running: [{ runId: "run-1", role: "Developer", taskId: "task-1", status: "IN_PROGRESS" }],
    waiting: [{ taskId: "task-2", reason: { code: "CAPACITY", message: "Нет свободной capacity" } }],
    blocked: [{ taskId: "task-3", reason: { code: "PROJECT_CONFIG_DEGRADED", message: "Конфигурация проекта повреждена или требует восстановления" } }],
    capacity: { configured: 4, used: 1 },
    locks: [{ id: "lock-1", resource: "runtime:hermes", runId: "run-1", kind: "exclusive", heldAt: UTF_TIMESTAMP }],
    recentEvents: [{ id: "evt-1", type: "AgentRunRequested", createdAt: UTF_TIMESTAMP }],
    dispatchState: { paused: false, updatedAt: null },
  };
}

describe("reference screen contracts: apiPaths additions", () => {
  it("строит команды scheduler и cancel-all", () => {
    expect(apiPaths.schedulerDispatchState).toBe("/api/v1/scheduler/dispatch-state");
    expect(apiPaths.runsCancelAll).toBe("/api/v1/runs/cancel-all");
  });

  it("строит пути контроля Run (checkpoint/pause/resume/terminal/events)", () => {
    expect(apiPaths.runCheckpoint("run 1")).toBe("/api/v1/runs/run%201/checkpoint");
    expect(apiPaths.runPause("run-1")).toBe("/api/v1/runs/run-1/pause");
    expect(apiPaths.runResume("run-1")).toBe("/api/v1/runs/run-1/resume");
    expect(apiPaths.runTerminal("run-1")).toBe("/api/v1/runs/run-1/terminal");
    expect(apiPaths.runEventsPage("run-1", { afterId: "evt-5", limit: 20 })).toBe(
      "/api/v1/runs/run-1/events?afterId=evt-5&limit=20",
    );
    expect(apiPaths.runEventsPage("run-1")).toBe("/api/v1/runs/run-1/events");
  });

  it("строит пути scoped-контролей проекта/epic/task", () => {
    expect(apiPaths.projectPause("p/1")).toBe("/api/v1/projects/p%2F1/pause");
    expect(apiPaths.projectResume("p-1")).toBe("/api/v1/projects/p-1/resume");
    expect(apiPaths.epicPause("e-1")).toBe("/api/v1/epics/e-1/pause");
    expect(apiPaths.epicResume("e-1")).toBe("/api/v1/epics/e-1/resume");
    expect(apiPaths.epicReplan("e-1")).toBe("/api/v1/epics/e-1/replan");
    expect(apiPaths.taskResume("t-1")).toBe("/api/v1/tasks/t-1/resume");
    expect(apiPaths.taskPause("t-1")).toBe("/api/v1/tasks/t-1/pause");
    expect(apiPaths.taskPriority("t/1")).toBe("/api/v1/tasks/t%2F1/priority");
    expect(apiPaths.githubSync("p/1")).toBe("/api/v1/projects/p%2F1/github/sync");
  });

  it("строит пути проектного индекса и config candidate/journal", () => {
    expect(apiPaths.projectIndex()).toBe("/api/v1/projects");
    expect(apiPaths.projectIndex({ cursor: "abc", limit: 25 })).toBe("/api/v1/projects?cursor=abc&limit=25");
    expect(apiPaths.projectConfigEditorCandidate("p-1")).toBe("/api/v1/projects/p-1/config/candidates/editor");
    expect(apiPaths.projectConfigJournalReconcile("p-1", "j-1")).toBe(
      "/api/v1/projects/p-1/config/journals/j-1/reconcile",
    );
  });

  it("строит пути approvals и usage window", () => {
    expect(apiPaths.approval("a-1")).toBe("/api/v1/approvals/a-1");
    expect(apiPaths.approvalPolicies).toBe("/api/v1/approvals/policies");
    expect(apiPaths.approvalsList()).toBe("/api/v1/approvals");
    expect(apiPaths.approvalsList("pending")).toBe("/api/v1/approvals?status=pending");
    expect(apiPaths.usageWindow("2026-10-01T00:00:00.000Z", "2026-10-25T00:00:00.000Z", "day")).toBe(
      "/api/v1/usage?from=2026-10-01T00%3A00%3A00.000Z&to=2026-10-25T00%3A00%3A00.000Z&granularity=day",
    );
  });
});

describe("execution queue projection", () => {
  it("принимает полную проекцию с capacity, locks, событиями и dispatch state", () => {
    const parsed = executionQueueProjectionSchema.parse(validExecutionQueue());
    expect(parsed.capacity).toEqual({ configured: 4, used: 1 });
    expect(parsed.locks[0]).toMatchObject({ id: "lock-1", runId: "run-1" });
    expect(parsed.recentEvents[0]).toMatchObject({ type: "AgentRunRequested" });
    expect(parsed.dispatchState.paused).toBe(false);
  });

  it("отвергает неизвестные поля и невалидные reasons", () => {
    expect(executionQueueProjectionSchema.safeParse({ ...validExecutionQueue(), extra: true }).success).toBe(false);
    const badReason = validExecutionQueue();
    const blockedEntry = badReason.blocked[0];
    if (blockedEntry) blockedEntry.reason = { code: "MADE_UP", message: "x" } as never;
    expect(executionQueueProjectionSchema.safeParse(badReason).success).toBe(false);
  });
});

describe("usage window projection (periodized)", () => {
  function validUsageWindow() {
    return {
      window: { from: "2026-10-01T00:00:00.000Z", to: "2026-10-25T00:00:00.000Z", granularity: "day" },
      summary: { inputTokens: 100, cachedTokens: 40, outputTokens: 30, totalTokens: 170, cost: 0.42 },
      dailySeries: [{ date: "2026-10-01", usage: { inputTokens: 10, cachedTokens: 4, outputTokens: 3, totalTokens: 17, cost: 0.04 } }],
      breakdowns: {
        byRole: [{ key: "Developer", spend: 0.42, tokens: 170, share: 1, runCount: 1 }],
        byReason: [{ key: "task-assignment", spend: 0.42, tokens: 170, share: 1, runCount: 1 }],
        byModel: [{ key: "claude-sonnet", spend: 0.42, tokens: 170, share: 1, runCount: 1 }],
      },
      modelComparison: [{ role: "Developer", model: "claude-sonnet", averageCostPerRun: 0.42, runs: 1 }],
      budgets: {
        configurations: [{ scope: "project", scopeId: "p-1", limitCost: 10, softLimitCost: 8, policy: "soft", spentCost: 0.42, reservedCost: 0 }],
        contexts: [{ scope: "project", scopeId: "p-1", projectId: "p-1", epicId: null, taskId: null, applicableLimits: [], effectiveLimit: null }],
        activeReservations: [],
      },
      efficiency: {
        cacheShare: { availability: "available", value: 0.4 },
        averageInitialContextTokens: { availability: "available", value: 2200 },
        averageOutputTokens: { availability: "available", value: 300 },
        aiRunsPerTask: { availability: "unavailable", reason: "NOT_RECORDED" },
        reworkCyclesPerTask: { availability: "unavailable", reason: "NOT_RECORDED" },
        deterministicCheckCount: { availability: "unavailable", reason: "NO_DURABLE_CHECK_EXECUTION_SOURCE" },
        deterministicCheckCost: { availability: "unavailable", reason: "NO_DURABLE_CHECK_EXECUTION_SOURCE" },
      },
      anomaly: { availability: "unavailable", reason: "NO_APPROVED_POLICY" },
      taskRecoveryShare: { availability: "unavailable", reason: "NO_APPROVED_POLICY" },
    };
  }

  it("принимает валидное окно и проекцию", () => {
    const parsed = usageWindowProjectionSchema.parse(validUsageWindow());
    expect(parsed.window.granularity).toBe("day");
    expect(parsed.anomaly).toEqual({ availability: "unavailable", reason: "NO_APPROVED_POLICY" });
  });

  it("отвергает malformed windows (не-UTC, инверсия, неизвестная granularity, лишнее поле)", () => {
    const base = validUsageWindow();
    expect(usageWindowQuerySchema.safeParse({ from: "2026-10-01T00:00:00", to: base.window.to, granularity: "day" }).success).toBe(false);
    expect(usageWindowQuerySchema.safeParse({ from: base.window.to, to: base.window.from, granularity: "day" }).success).toBe(false);
    expect(usageWindowQuerySchema.safeParse({ from: base.window.from, to: base.window.to, granularity: "week" }).success).toBe(false);
    expect(usageWindowProjectionSchema.safeParse({ ...base, window: { ...base.window, extra: true } }).success).toBe(false);
  });

  it("отвергает невалидный budget scope", () => {
    const base = validUsageWindow();
    base.budgets.configurations[0]!.scope = "department" as never;
    expect(usageWindowProjectionSchema.safeParse(base).success).toBe(false);
  });
});

describe("approval inbox projections", () => {
  function validInbox() {
    return {
      filter: "pending",
      summary: { totalPending: 1, totalResolved: 0, oldestPendingCreatedAt: UTF_TIMESTAMP },
      items: [{
        id: "a-1",
        category: "EPIC_PLAN_CHANGE",
        status: "PENDING",
        priority: "HIGH",
        projectId: "p-1",
        title: "EPIC-42 · Изменение плана",
        createdAt: UTF_TIMESTAMP,
        resolvedAt: null,
      }],
    };
  }

  it("принимает inbox-проекцию и детальную проекцию", () => {
    const parsed = approvalInboxProjectionSchema.parse(validInbox());
    expect(parsed.items[0]?.title).toBe("EPIC-42 · Изменение плана");
    const detail = approvalDetailProjectionSchema.parse({
      id: "a-1",
      category: "EPIC_PLAN_CHANGE",
      status: "PENDING",
      priority: "HIGH",
      project: { id: "p-1", displayName: "Ebb AI Hub" },
      proposal: { title: "Изменение плана", summary: "Перепланировать эпик" },
      rationale: "Требуется пересмотр графика",
      planDiff: { before: { title: "Старый план", scope: "epic" }, after: { title: "Новый план", scope: "epic" } },
      impacts: { scope: "epic", role: "Developer", architecture: "без изменений", delayDays: 2, budgetCost: 5 },
      evidence: [{ id: "ev-1", kind: "proposal", capturedAt: UTF_TIMESTAMP, description: "Предложение", source: "coordinator" }],
      decision: null,
    });
    expect(detail.decision).toBeNull();
    expect(approvalPolicyProjectionSchema.parse({
      defaultAction: "PENDING",
      requireExactHashForActivation: true,
      allowedOutcomes: ["APPROVED", "REJECTED", "CHANGES_REQUESTED"],
    }).requireExactHashForActivation).toBe(true);
  });

  it("отвергает неизвестные поля и невалидные исходы решения", () => {
    expect(approvalInboxProjectionSchema.safeParse({ ...validInbox(), extra: true }).success).toBe(false);
    const badDecision = approvalDetailProjectionSchema.safeParse({
      id: "a-1",
      category: "EPIC_PLAN_CHANGE",
      status: "PENDING",
      priority: "HIGH",
      project: { id: "p-1", displayName: "Ebb AI Hub" },
      proposal: { title: "x", summary: "y" },
      rationale: "r",
      planDiff: { before: { title: "a", scope: "s" }, after: { title: "b", scope: "s" } },
      impacts: { scope: "s", role: "r", architecture: "a", delayDays: null, budgetCost: null },
      evidence: [],
      decision: { actor: "admin", outcome: "PARTIAL" as never, at: UTF_TIMESTAMP, note: null },
    });
    expect(badDecision.success).toBe(false);
  });
});

describe("run usage null-vs-zero", () => {
  it("availabilityFromNullable сохраняет null как unavailable и 0 как available 0", () => {
    expect(availabilityFromNullable(null)).toEqual({ availability: "unavailable", reason: "NOT_RECORDED" });
    expect(availabilityFromNullable(0)).toEqual({ availability: "available", value: 0 });
    expect(availabilityFromNullable(12)).toEqual({ availability: "available", value: 12 });
    expect(JSON.stringify(availabilityFromNullable(null))).not.toContain("value");
  });

  it("runUsageProjectionSchema принимает null-vs-zero комбинацию", () => {
    const parsed = runUsageProjectionSchema.parse({
      inputTokens: { availability: "unavailable", reason: "NOT_RECORDED" },
      cachedInputTokens: { availability: "available", value: 0 },
      outputTokens: { availability: "available", value: 120 },
      effectiveCost: { availability: "available", value: 0.42 },
    });
    expect(parsed.cachedInputTokens).toEqual({ availability: "available", value: 0 });
    expect(parsed.inputTokens).toEqual({ availability: "unavailable", reason: "NOT_RECORDED" });
  });

  it("отвергает unavailable без стабильной причины и available без value", () => {
    expect(runUsageProjectionSchema.safeParse({
      inputTokens: { availability: "unavailable", reason: "ANYTHING" },
      cachedInputTokens: { availability: "unavailable", reason: "NOT_RECORDED" },
      outputTokens: { availability: "unavailable", reason: "NOT_RECORDED" },
      effectiveCost: { availability: "unavailable", reason: "NOT_RECORDED" },
    }).success).toBe(false);
    expect(runUsageProjectionSchema.safeParse({
      inputTokens: { availability: "available" },
      cachedInputTokens: { availability: "unavailable", reason: "NOT_RECORDED" },
      outputTokens: { availability: "unavailable", reason: "NOT_RECORDED" },
      effectiveCost: { availability: "unavailable", reason: "NOT_RECORDED" },
    }).success).toBe(false);
  });
});

describe("run control / checkpoint / stream", () => {
  it("discriminated union: PAUSED требует checkpointId, ACTIVE требует null", () => {
    expect(runControlStateSchema.parse({ state: "ACTIVE", version: 1, updatedAt: UTF_TIMESTAMP, checkpointId: null }).state).toBe("ACTIVE");
    expect(runControlStateSchema.parse({ state: "PAUSED", version: 2, updatedAt: UTF_TIMESTAMP, checkpointId: "cp-1" }).state).toBe("PAUSED");
    expect(runControlStateSchema.safeParse({ state: "PAUSED", version: 2, updatedAt: UTF_TIMESTAMP, checkpointId: null }).success).toBe(false);
    expect(runControlStateSchema.safeParse({ state: "ACTIVE", version: 1, updatedAt: UTF_TIMESTAMP, checkpointId: "cp-1" }).success).toBe(false);
    expect(runControlStateSchema.safeParse({ state: "PAUSING", version: 1, updatedAt: UTF_TIMESTAMP, checkpointId: null }).success).toBe(false);
  });

  it("принимает checkpoint-проекцию и результат команды", () => {
    const checkpoint = runCheckpointProjectionSchema.parse({
      id: "cp-1",
      runId: "run-1",
      attempt: 1,
      sessionId: "sess-1",
      ownerGeneration: 3,
      containmentRef: "ct-1",
      launchNonceHash: HASH64,
      contextHash: HASH64,
      workspaceSnapshotHash: HASH64,
      eventCursor: "evt-9",
      checkpointHash: HASH64,
      createdAt: UTF_TIMESTAMP,
    });
    expect(checkpoint.checkpointHash).toBe(HASH64);
    const result = runControlCommandResultSchema.parse({
      command: "PAUSE",
      status: "COMPLETED",
      control: { state: "PAUSED", version: 2, updatedAt: UTF_TIMESTAMP, checkpointId: "cp-1" },
      failureCode: null,
    });
    expect(result.control.state).toBe("PAUSED");
  });

  it("принимает и отвергает query/страницу Run events", () => {
    expect(runEventsQuerySchema.parse({ afterId: "evt-5", limit: 100 })).toEqual({ afterId: "evt-5", limit: 100 });
    expect(runEventsQuerySchema.safeParse({ limit: 201 }).success).toBe(false);
    expect(runEventsQuerySchema.safeParse({ afterId: 7 as never }).success).toBe(false);
    expect(runEventsPageProjectionSchema.parse({
      items: [{ id: "evt-5", type: "AgentRunStarted", createdAt: UTF_TIMESTAMP, payload: { runId: "run-1" } }],
      nextCursor: "evt-6",
    }).items[0]?.id).toBe("evt-5");
    expect(runEventsPageProjectionSchema.safeParse({ items: [], nextCursor: null, extra: true }).success).toBe(false);
  });

  it("terminal: только явно sanitized persisted-источник", () => {
    const available = runTerminalProjectionSchema.parse({
      availability: "available",
      entries: [{ seq: 0, text: "sanitized line", at: UTF_TIMESTAMP }],
    });
    expect(available.entries[0]?.text).toBe("sanitized line");
    expect(runTerminalProjectionSchema.parse({ availability: "unavailable", reason: "NO_SANITIZED_PERSISTED_SOURCE" }).availability).toBe("unavailable");
    expect(runTerminalProjectionSchema.safeParse({ availability: "unavailable", reason: "NOT_RECORDED" }).success).toBe(false);
    expect(runTerminalProjectionSchema.safeParse({ availability: "available", entries: [] }).success).toBe(true);
  });

  it("run detail: usage null-vs-zero + nullable control", () => {
    const detail = runDetailProjectionSchema.parse({
      id: "run-1",
      role: "Senior Developer",
      runtime: "hermes",
      model: "claude-sonnet",
      taskId: "task-1",
      epicId: null,
      status: "IN_PROGRESS",
      sessionId: "sess-1",
      attempt: 1,
      triggerReason: "task-assignment",
      startedAt: UTF_TIMESTAMP,
      endedAt: null,
      exitCode: null,
      usage: {
        inputTokens: { availability: "unavailable", reason: "NOT_RECORDED" },
        cachedInputTokens: { availability: "available", value: 0 },
        outputTokens: { availability: "available", value: 120 },
        effectiveCost: { availability: "available", value: 0.42 },
      },
      control: { state: "ACTIVE", version: 1, updatedAt: UTF_TIMESTAMP, checkpointId: null },
    });
    expect(detail.usage.inputTokens.availability).toBe("unavailable");
    expect(detail.usage.cachedInputTokens).toEqual({ availability: "available", value: 0 });
    expect(detail.control).toMatchObject({ state: "ACTIVE" });
  });
});

describe("cancel-all", () => {
  it("принимает непустой уникальный набор и упорядоченные исходы", () => {
    expect(cancelAllRunsRequestSchema.parse({ expectedRunIds: ["run-1", "run-2"] }).expectedRunIds).toEqual(["run-1", "run-2"]);
    const result = cancelAllRunsResultSchema.parse({
      results: [
        { runId: "run-1", outcome: "CANCELLED" },
        { runId: "run-2", outcome: "NOT_ACTIVE" },
      ],
    });
    expect(result.results.map((entry) => entry.outcome)).toEqual(["CANCELLED", "NOT_ACTIVE"]);
    expect(cancelAllRunsResultSchema.safeParse({ results: [{ runId: "run-1", outcome: "CANCELLED" }], extra: true }).success).toBe(false);
  });

  it("отвергает пустой и дублирующий наборы, а также неизвестный исход", () => {
    expect(cancelAllRunsRequestSchema.safeParse({ expectedRunIds: [] }).success).toBe(false);
    expect(cancelAllRunsRequestSchema.safeParse({ expectedRunIds: ["run-1", "run-1"] }).success).toBe(false);
    expect(cancelAllRunsRequestSchema.safeParse({ expectedRunIds: ["run-1"], extra: true }).success).toBe(false);
    expect(cancelAllRunsResultSchema.safeParse({ results: [{ runId: "run-1", outcome: "PARTIALLY_CANCELLED" }] }).success).toBe(false);
  });
});

describe("project index pagination", () => {
  it("принимает query и страницу с opaque курсором", () => {
    expect(projectIndexQuerySchema.parse({ cursor: "abc", limit: 50 })).toEqual({ cursor: "abc", limit: 50 });
    expect(projectIndexQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    const page = projectIndexPageProjectionSchema.parse({
      items: [{ id: "p-1", name: "p-1", displayName: "Ebb AI Hub", status: "ACTIVE", updatedAt: UTF_TIMESTAMP }],
      nextCursor: "opaque-cursor",
    });
    expect(page.items[0]?.displayName).toBe("Ebb AI Hub");
    expect(page.nextCursor).toBe("opaque-cursor");
    expect(projectIndexPageProjectionSchema.safeParse({ items: [], nextCursor: null, extra: true }).success).toBe(false);
  });
});

describe("settings candidate editor and reconcile", () => {
  function validCandidateRequest() {
    return {
      expectedManifestHash: HASH64,
      settings: {
        projectDisplayName: "Ebb AI Hub",
        defaultBranch: "develop",
        roles: [{ role: "Developer", provider: "anthropic", model: "claude-sonnet" }],
        scheduler: { concurrency: 4, enablePriorityAging: true, criticalPathBoost: true },
        recovery: { resumeSessions: true, maxAttempts: 3, recoveryCycleMinutes: 60, abortOnNoProgressDays: 7 },
        github: { syncEnabled: true, issueLinking: true, pullRequestSync: false },
        budgets: [{ scope: "project", scopeId: "p-1", limitCost: 10, softLimitCost: 8, policy: "soft", spentCost: 2, reservedCost: 1 }],
      },
    };
  }

  it("принимает валидный editor-кандидат и проекцию кандидата", () => {
    const parsed = projectConfigCandidateEditorRequestSchema.parse(validCandidateRequest());
    expect(parsed.settings.projectDisplayName).toBe("Ebb AI Hub");
    const projection = projectConfigCandidateProjectionSchema.parse({
      candidateId: "cand-1",
      projectId: "p-1",
      manifestHash: HASH64,
      expectedManifestHash: HASH64,
      diff: { added: [".ebb-orchestrator/config.json"], removed: [], modified: [] },
      status: "PENDING_REVIEW",
      createdAt: UTF_TIMESTAMP,
    });
    expect(projection.status).toBe("PENDING_REVIEW");
  });

  it("отвергает stale-hash формы и неизвестные поля settings", () => {
    const base = validCandidateRequest();
    expect(projectConfigCandidateEditorRequestSchema.safeParse({ ...base, expectedManifestHash: "not-hex" }).success).toBe(false);
    expect(projectConfigCandidateEditorRequestSchema.safeParse({ ...base, expectedManifestHash: "a".repeat(63) }).success).toBe(false);
    const withUnknown = { ...base, settings: { ...base.settings, unknownSection: true } };
    expect(projectConfigCandidateEditorRequestSchema.safeParse(withUnknown).success).toBe(false);
  });

  it("отвергает секретные значения в settings-кандидате", () => {
    const base = validCandidateRequest();
    const secrets = [
      { ...base, settings: { ...base.settings, roles: [{ role: "Developer", provider: "sk-test-secret-value-5678", model: null }] } },
      { ...base, settings: { ...base.settings, roles: [{ role: "Developer", provider: "anthropic", model: "Bearer abcdefghijklmnop" }] } },
      { ...base, settings: { ...base.settings, projectDisplayName: "api_key = AKIAIOSFODNN7EXAMPLE" } },
    ];
    for (const payload of secrets) {
      expect(projectConfigCandidateEditorRequestSchema.safeParse(payload).success).toBe(false);
    }
    expect(projectConfigCandidateEditorRequestSchema.safeParse(validCandidateRequest()).success).toBe(true);
  });

  it("reconcile: только DEGRADED phase, hex-hash и явная resolution", () => {
    expect(journalReconcileRequestSchema.parse({
      expectedPhase: "DEGRADED",
      observedManifestHash: HASH64,
      resolution: "ACCEPT_EXTERNAL",
    }).resolution).toBe("ACCEPT_EXTERNAL");
    expect(journalReconcileRequestSchema.safeParse({ expectedPhase: "APPLIED", observedManifestHash: HASH64, resolution: "ACCEPT_EXTERNAL" }).success).toBe(false);
    expect(journalReconcileRequestSchema.safeParse({ expectedPhase: "DEGRADED", observedManifestHash: "short", resolution: "RESTORE_APPROVED" }).success).toBe(false);
    expect(journalReconcileRequestSchema.safeParse({ expectedPhase: "DEGRADED", observedManifestHash: HASH64, resolution: "DELETE_EVERYTHING" }).success).toBe(false);
    expect(journalReconcileRequestSchema.safeParse({ expectedPhase: "DEGRADED", observedManifestHash: HASH64, resolution: "ACCEPT_EXTERNAL", extra: true }).success).toBe(false);
    const response = journalReconcileResponseSchema.parse({
      journalId: "j-1",
      projectId: "p-1",
      phase: "RECONCILED_EXTERNAL",
      configStatus: "READY",
      currentCandidateId: "cand-2",
      activeRevisionId: "rev-1",
      resolution: "ACCEPT_EXTERNAL",
      resolvedBy: "operator",
      resolvedManifestHash: HASH64,
      resolvedAt: UTF_TIMESTAMP,
    });
    expect(response.phase).toBe("RECONCILED_EXTERNAL");
  });
});

describe("scoped work controls", () => {
  it("принимает подтверждения pause/resume и ответы команд", () => {
    expect(projectPauseResponseSchema.parse({ projectId: "p-1", state: "PAUSED", updatedAt: UTF_TIMESTAMP }).state).toBe("PAUSED");
    expect(epicPauseResponseSchema.parse({ epicId: "e-1", state: "PAUSED", updatedAt: UTF_TIMESTAMP }).state).toBe("PAUSED");
    expect(epicReplanRequestSchema.parse({})).toEqual({});
    expect(epicReplanResponseSchema.parse({
      epicId: "e-1",
      requestId: "req-1",
      status: "PLAN_PENDING_APPROVAL",
      createdAt: UTF_TIMESTAMP,
    }).status).toBe("PLAN_PENDING_APPROVAL");
    expect(taskPriorityRequestSchema.parse({ priority: 42 }).priority).toBe(42);
    expect(taskPriorityRequestSchema.safeParse({ priority: 0 }).success).toBe(false);
    expect(taskPriorityResponseSchema.parse({ taskId: "t-1", priority: 42, updatedAt: UTF_TIMESTAMP }).priority).toBe(42);
    expect(taskControlResponseSchema.parse({ taskId: "t-1", state: "PAUSED", priorStage: "READY", updatedAt: UTF_TIMESTAMP }).priorStage).toBe("READY");
  });

  it("отвергает неизвестные поля и лишние payload'ы", () => {
    expect(projectPauseResponseSchema.safeParse({ projectId: "p-1", state: "PAUSED", updatedAt: UTF_TIMESTAMP, extra: true }).success).toBe(false);
    expect(taskPriorityRequestSchema.safeParse({ priority: 42, note: "x" }).success).toBe(false);
    expect(dispatchStateRequestSchema.parse({ paused: true }).paused).toBe(true);
    expect(dispatchStateRequestSchema.safeParse({ paused: true, extra: true }).success).toBe(false);
    expect(dispatchStateResponseSchema.parse({ paused: true, updatedAt: UTF_TIMESTAMP }).paused).toBe(true);
  });
});
