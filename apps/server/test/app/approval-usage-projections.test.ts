import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { createApp } from "../../src/app/create-app.js";
import { approvalRoutes } from "../../src/app/routes/approvals.js";
import { usageRoutes } from "../../src/app/routes/usage.js";
import { createSqliteDatabase } from "../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../helpers/migrations.js";
import { SchedulerService } from "../../src/modules/scheduler/scheduler-service.js";
import { createTestAuthService, TEST_COOKIE } from "../helpers/auth.js";
import type { AgentRuntime } from "../../src/modules/runtime/agent-runtime.js";
import type { Database } from "../../src/platform/database/database.js";

const migrations = loadTestMigrations();

/** Фиксированные UTC-инстанты: границы дней и пограничные миллисекунды. */
const T = {
  d18: "2026-10-18T08:00:00.000Z",
  d19: "2026-10-19T08:00:00.000Z",
  d20: "2026-10-20T12:00:00.000Z",
  d21Start: "2026-10-21T00:00:00.000Z",
  d21Mid: "2026-10-21T12:00:00.000Z",
  d21End: "2026-10-21T23:59:59.999Z",
  d21EndNoMs: "2026-10-21T23:59:59Z",
  d22Start: "2026-10-22T00:00:00.000Z",
  d23: "2026-10-23T08:30:00.000Z",
  d24: "2026-10-24T00:00:00.000Z",
} as const;

function makeDb(): Database {
  const db = createSqliteDatabase(":memory:");
  runMigrations(db, migrations);
  return db;
}

function hex64(seed: string): string {
  const hex = seed.replace(/[^0-9a-f]/gi, "0");
  return hex.padEnd(64, "a").slice(0, 64);
}

/** Заполняет projects/epics/tasks для approval-фикстур. */
function seedSubjects(db: Database): void {
  const now = T.d20;
  db.run(
    "INSERT INTO projects (id,name,display_name,status,created_at,updated_at) VALUES ($id,$name,$dn,$s,$now,$now)",
    { id: "p-1", name: "alpha", dn: "Alpha", s: "ACTIVE", now },
  );
  db.run(
    "INSERT INTO epics (id,project_id,display_id,title,status,contract_json,created_at,updated_at) VALUES ($id,$pid,$did,$t,$s,'{}',$now,$now)",
    { id: "e-1", pid: "p-1", did: "E-1", t: "Epic 1", s: "OPEN", now },
  );
  db.run(
    "INSERT INTO tasks (id,project_id,epic_id,display_id,title,status,contract_json,created_at,updated_at) VALUES ($id,$pid,$eid,$did,$t,$s,'{}',$now,$now)",
    { id: "t-1", pid: "p-1", eid: "e-1", did: "T-1", t: "Task 1", s: "READY", now },
  );
}

function seedApproval(db: Database, row: {
  id: string; type: string; subjectId: string; subjectType: string; status: string;
  requestedBy: string; createdAt: string; resolvedBy?: string | null; note?: string | null; resolvedAt?: string | null;
}): void {
  db.run(
    `INSERT INTO approvals (id,type,subject_id,subject_type,status,requested_by,resolved_by,resolution_note,created_at,resolved_at)
     VALUES ($id,$type,$sid,$st,$status,$req,$rb,$note,$created,$resolved)`,
    {
      id: row.id, type: row.type, sid: row.subjectId, st: row.subjectType, status: row.status,
      req: row.requestedBy, rb: row.resolvedBy ?? null, note: row.note ?? null,
      created: row.createdAt, resolved: row.resolvedAt ?? null,
    },
  );
}

function seedApprovalMetadata(db: Database, approvalId: string, metadata: unknown): void {
  db.run(
    "INSERT INTO approval_metadata (approval_id,metadata_json) VALUES ($id,$meta)",
    { id: approvalId, meta: JSON.stringify(metadata) },
  );
}

/** Возвращает metadata для детальной проекции (все поля присутствуют). */
function fullMetadata(): Record<string, unknown> {
  return {
    proposal: { title: "Переопределение бюджета задачи", summary: "Продлить лимит на восстановительный запуск" },
    rationale: "QA выявил дефект, требующий дорогого запуска",
    planDiff: {
      before: { title: "TASK-508", scope: "task" },
      after: { title: "TASK-508", scope: "task" },
    },
    impacts: {
      scope: "task",
      role: "senior",
      architecture: "no public api change",
      delayDays: 1,
      budgetCost: 0.8,
    },
    evidence: [
      { id: "ev-1", kind: "qa-finding", capturedAt: T.d20, description: "дефект воспроизведён", source: "qa-report" },
    ],
  };
}

const mockRuntime: AgentRuntime = {
  active: 0,
  maxActive: 0,
  calls: [],
  async startRun() {},
  async runResult() { return { version: "1", summary: "" } as never; },
  async resumeRun() {},
  async cancelRun() {},
  async inspectRun() { throw new Error("unused"); },
  async collectResult() { return {} as never; },
  async collectUsage() { return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, cost: 0 }; },
  async healthCheck() { return true; },
};

describe("approval projections", () => {
  it("honors status=pending filter and reconciles summary counters against rows", async () => {
    const db = makeDb();
    seedSubjects(db);
    seedApproval(db, { id: "a-pending", type: "WORKFLOW_CHANGE", subjectId: "p-1", subjectType: "PROJECT", status: "PENDING", requestedBy: "coordinator", createdAt: T.d20 });
    seedApproval(db, { id: "a-approved", type: "FINAL_MERGE", subjectId: "t-1", subjectType: "TASK", status: "APPROVED", requestedBy: "runtime", resolvedBy: "reviewer-1", note: "ok", createdAt: T.d18, resolvedAt: T.d19 });
    seedApproval(db, { id: "a-rejected", type: "ARCHITECTURE_CHANGE", subjectId: "e-1", subjectType: "EPIC", status: "REJECTED", requestedBy: "coordinator", resolvedBy: "architect", note: "no", createdAt: T.d19, resolvedAt: T.d20 });

    const app = Fastify();
    await approvalRoutes(app, { db });
    const response = await app.inject({ method: "GET", url: "/api/v1/approvals?status=pending" });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.filter).toBe("pending");
    expect(body.summary).toEqual({ totalPending: 1, totalResolved: 2, oldestPendingCreatedAt: T.d20 });
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toEqual({
      id: "a-pending",
      category: "WORKFLOW_CHANGE",
      status: "PENDING",
      priority: "MEDIUM",
      projectId: "p-1",
      title: "",
      createdAt: T.d20,
      resolvedAt: null,
    });
    await app.close();
    db.close();
  });

  it("honors status=resolved filter and never leaks pending rows", async () => {
    const db = makeDb();
    seedSubjects(db);
    seedApproval(db, { id: "a-pending", type: "WORKFLOW_CHANGE", subjectId: "p-1", subjectType: "PROJECT", status: "PENDING", requestedBy: "c", createdAt: T.d20 });
    seedApproval(db, { id: "a-approved", type: "FINAL_MERGE", subjectId: "t-1", subjectType: "TASK", status: "APPROVED", requestedBy: "r", resolvedBy: "reviewer-1", createdAt: T.d18, resolvedAt: T.d19 });
    seedApproval(db, { id: "a-changes", type: "SCOPE_CHANGE", subjectId: "t-1", subjectType: "TASK", status: "CHANGES_REQUESTED", requestedBy: "r", resolvedBy: "pm", createdAt: T.d19, resolvedAt: T.d20 });
    seedApproval(db, { id: "a-cancelled", type: "ROLE_CHANGE", subjectId: "p-1", subjectType: "PROJECT", status: "CANCELLED", requestedBy: "c", resolvedBy: "user-1", createdAt: T.d18, resolvedAt: T.d19 });

    const app = Fastify();
    await approvalRoutes(app, { db });
    const response = await app.inject({ method: "GET", url: "/api/v1/approvals?status=resolved" });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.filter).toBe("resolved");
    expect(body.summary).toEqual({ totalPending: 1, totalResolved: 3, oldestPendingCreatedAt: T.d20 });
    expect(body.items).toHaveLength(3);
    expect(body.items.every((item: { status: string }) => item.status === "RESOLVED")).toBe(true);
    // Стабильная сортировка: newest first по created_at.
    expect(body.items.map((item: { id: string }) => item.id)).toEqual(["a-changes", "a-cancelled", "a-approved"]);
    expect(body.items.map((item: { projectId: string }) => item.projectId)).toEqual(["p-1", "p-1", "p-1"]);
    await app.close();
    db.close();
  });

  it("validates the status filter", async () => {
    const db = makeDb();
    const app = Fastify();
    await approvalRoutes(app, { db });
    const response = await app.inject({ method: "GET", url: "/api/v1/approvals?status=nonsense" });
    expect(response.statusCode).toBe(400);
    await app.close();
    db.close();
  });

  it("returns an empty inbox without a database", async () => {
    const app = Fastify();
    await approvalRoutes(app, {});
    const response = await app.inject({ method: "GET", url: "/api/v1/approvals?status=pending" });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      filter: "pending",
      summary: { totalPending: 0, totalResolved: 0, oldestPendingCreatedAt: null },
      items: [],
    });
    await app.close();
  });

  it("projects approval detail with proposal/rationale/plan/impact/evidence/decision and never raw rows", async () => {
    const db = makeDb();
    seedSubjects(db);
    seedApproval(db, { id: "a-approved", type: "FINAL_MERGE", subjectId: "t-1", subjectType: "TASK", status: "APPROVED", requestedBy: "runtime-orchestrator", resolvedBy: "reviewer-1", note: "Согласовано", createdAt: T.d18, resolvedAt: T.d19 });
    seedApprovalMetadata(db, "a-approved", fullMetadata());

    const app = Fastify();
    await approvalRoutes(app, { db });
    const response = await app.inject({ method: "GET", url: "/api/v1/approvals/a-approved" });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body).toEqual({
      id: "a-approved",
      category: "FINAL_MERGE",
      status: "RESOLVED",
      priority: "CRITICAL",
      project: { id: "p-1", displayName: "Alpha" },
      proposal: { title: "Переопределение бюджета задачи", summary: "Продлить лимит на восстановительный запуск" },
      rationale: "QA выявил дефект, требующий дорогого запуска",
      planDiff: {
        before: { title: "TASK-508", scope: "task" },
        after: { title: "TASK-508", scope: "task" },
      },
      impacts: { scope: "task", role: "senior", architecture: "no public api change", delayDays: 1, budgetCost: 0.8 },
      evidence: [
        { id: "ev-1", kind: "qa-finding", capturedAt: T.d20, description: "дефект воспроизведён", source: "qa-report" },
      ],
      decision: { actor: "reviewer-1", outcome: "APPROVED", at: T.d19, note: "Согласовано" },
    });
    // Никогда не сериализуем сырые внутренние колонки approval-строки.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("subject_type");
    expect(serialized).not.toContain("subject_id");
    expect(serialized).not.toContain("requested_by");
    expect(serialized).not.toContain("resolution_note");
    expect(serialized).not.toContain("metadata_json");
    await app.close();
    db.close();
  });

  it("returns null decision for pending approvals", async () => {
    const db = makeDb();
    seedSubjects(db);
    seedApproval(db, { id: "a-pending", type: "WORKFLOW_CHANGE", subjectId: "p-1", subjectType: "PROJECT", status: "PENDING", requestedBy: "coordinator", createdAt: T.d20 });
    seedApprovalMetadata(db, "a-pending", { proposal: { title: "X", summary: "Y" }, rationale: "r" });

    const app = Fastify();
    await approvalRoutes(app, { db });
    const response = await app.inject({ method: "GET", url: "/api/v1/approvals/a-pending" });
    const body = JSON.parse(response.body);
    expect(response.statusCode).toBe(200);
    expect(body.status).toBe("PENDING");
    expect(body.decision).toBeNull();
    expect(body.proposal).toEqual({ title: "X", summary: "Y" });
    expect(body.rationale).toBe("r");
    await app.close();
    db.close();
  });

  it("returns 404 for an unknown approval id", async () => {
    const db = makeDb();
    const app = Fastify();
    await approvalRoutes(app, { db });
    const response = await app.inject({ method: "GET", url: "/api/v1/approvals/does-not-exist" });
    expect(response.statusCode).toBe(404);
    await app.close();
    db.close();
  });

  it("exposes the backend-owned effective approval policy", async () => {
    const db = makeDb();
    const app = Fastify();
    await approvalRoutes(app, { db });
    const response = await app.inject({ method: "GET", url: "/api/v1/approvals/policies" });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      defaultAction: "PENDING",
      requireExactHashForActivation: true,
      allowedOutcomes: ["APPROVED", "REJECTED", "CHANGES_REQUESTED"],
    });
    await app.close();
    db.close();
  });

  it("requires an authenticated session for approval routes", async () => {
    const db = makeDb();
    const app = createApp({ db, scheduler: new SchedulerService(db), runtime: mockRuntime, authService: createTestAuthService() });
    const unauth = await app.inject({ method: "GET", url: "/api/v1/approvals?status=pending" });
    expect(unauth.statusCode).toBe(401);
    const auth = await app.inject({ method: "GET", url: "/api/v1/approvals?status=pending", headers: { cookie: TEST_COOKIE } });
    expect(auth.statusCode).toBe(200);
    await app.close();
    db.close();
  });
});

describe("usage window projections", () => {
  interface UsageSeedRow {
    id: string;
    createdAt: string;
    role: string;
    model: string;
    trigger: string;
    rework: string | null;
    input: number;
    cached: number;
    output: number;
    cost: number;
    taskId: string | null;
  }

  function seedUsage(db: Database, rows: UsageSeedRow[]): void {
    for (const row of rows) {
      db.run(
        `INSERT INTO usage_records
          (id,project_id,epic_id,task_id,input_tokens,cached_tokens,output_tokens,total_tokens,actual_cost,role,model,trigger_reason,rework_category,created_at)
         VALUES ($id,'p-1','e-1',$task,$input,$cached,$output,$total,$cost,$role,$model,$trigger,$rework,$created)`,
        {
          id: row.id, task: row.taskId, input: row.input, cached: row.cached, output: row.output,
          total: row.input + row.cached + row.output, cost: row.cost, role: row.role, model: row.model,
          trigger: row.trigger, rework: row.rework, created: row.createdAt,
        },
      );
    }
  }

  /** Заполняет все агент-ранны и usage-записи, используемые окнами ниже. */
  function seedFullUsage(db: Database): void {
    seedSubjects(db);
    db.run(
      `INSERT INTO agent_runs (id,role,runtime,model,status,task_id,epic_id,trigger_reason,started_at,ended_at)
       VALUES ($id,$role,'hermes',$model,$status,$task,$epic,$trigger,$started,$ended)`,
      { id: "r-1", role: "developer", model: "model-a", status: "COMPLETED", task: "t-1", epic: "e-1", trigger: "DEVELOPMENT", started: T.d21Start, ended: T.d21Mid },
    );
    db.run(
      `INSERT INTO agent_runs (id,role,runtime,model,status,task_id,epic_id,trigger_reason,started_at,ended_at)
       VALUES ($id,$role,'hermes',$model,$status,$task,$epic,$trigger,$started,$ended)`,
      { id: "r-2", role: "reviewer", model: "model-b", status: "COMPLETED", task: "t-1", epic: "e-1", trigger: "CODE_REVIEW", started: T.d21Mid, ended: T.d21End },
    );
    db.run(
      `INSERT INTO context_manifests
        (id,run_id,subject_type,task_id,role,items_json,prompt_hash,context_hash,context_builder_version,initial_token_size,created_at)
       VALUES ($id,$run,'TASK',$task,$role,'[]',$prompt,$ctx,'v1',$initial,$created)`,
      { id: "m-1", run: "r-1", task: "t-1", role: "developer", prompt: hex64("p1"), ctx: hex64("c1"), initial: 6000, created: T.d21Start },
    );
    db.run(
      `INSERT INTO context_manifests
        (id,run_id,subject_type,task_id,role,items_json,prompt_hash,context_hash,context_builder_version,initial_token_size,created_at)
       VALUES ($id,$run,'TASK',$task,$role,'[]',$prompt,$ctx,'v1',$initial,$created)`,
      { id: "m-2", run: "r-2", task: "t-1", role: "reviewer", prompt: hex64("p2"), ctx: hex64("c2"), initial: 8000, created: T.d21Mid },
    );
    seedUsage(db, [
      { id: "u-1", createdAt: T.d20, role: "developer", model: "model-a", trigger: "DEVELOPMENT", rework: null, input: 100, cached: 50, output: 40, cost: 0.5, taskId: "t-1" },
      { id: "u-2", createdAt: T.d21Start, role: "reviewer", model: "model-b", trigger: "CODE_REVIEW", rework: "REWORK", input: 200, cached: 100, output: 80, cost: 1.0, taskId: "t-1" },
      { id: "u-3", createdAt: T.d21End, role: "developer", model: "model-a", trigger: "DEVELOPMENT", rework: null, input: 300, cached: 150, output: 120, cost: 1.5, taskId: "t-1" },
      { id: "u-4", createdAt: T.d22Start, role: "qa", model: "model-a", trigger: "QA_VALIDATION", rework: "REWORK", input: 400, cached: 200, output: 160, cost: 2.0, taskId: "t-1" },
      { id: "u-5", createdAt: T.d23, role: "developer", model: "model-a", trigger: "DEVELOPMENT", rework: null, input: 500, cached: 250, output: 200, cost: 2.5, taskId: "t-1" },
    ]);
  }

  function windowUrl(from: string, to: string, granularity = "day"): string {
    return `/api/v1/usage?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&granularity=${granularity}`;
  }

  it("honors the UTC window inclusively and reconciles aggregates to source rows", async () => {
    const db = makeDb();
    seedFullUsage(db);
    const app = Fastify();
    await usageRoutes(app, { db });

    // Окно [d21Start, d21End] включает обе граничные записи u-2 и u-3.
    const response = await app.inject({ method: "GET", url: windowUrl(T.d21Start, T.d21End) });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    expect(body.window).toEqual({ from: T.d21Start, to: T.d21End, granularity: "day" });
    expect(body.summary).toEqual({
      inputTokens: 500,
      cachedTokens: 250,
      outputTokens: 200,
      totalTokens: 950,
      cost: 2.5,
    });
    expect(body.dailySeries).toEqual([
      { date: "2026-10-21", usage: { inputTokens: 500, cachedTokens: 250, outputTokens: 200, totalTokens: 950, cost: 2.5 } },
    ]);
    expect(body.breakdowns.byRole).toEqual([
      { key: "developer", spend: 1.5, tokens: 570, share: 0.6, runCount: 1 },
      { key: "reviewer", spend: 1.0, tokens: 380, share: 0.4, runCount: 1 },
    ]);
    expect(body.breakdowns.byReason).toEqual([
      { key: "DEVELOPMENT", spend: 1.5, tokens: 570, share: 0.6, runCount: 1 },
      { key: "CODE_REVIEW", spend: 1.0, tokens: 380, share: 0.4, runCount: 1 },
    ]);
    expect(body.breakdowns.byModel).toEqual([
      { key: "model-a", spend: 1.5, tokens: 570, share: 0.6, runCount: 1 },
      { key: "model-b", spend: 1.0, tokens: 380, share: 0.4, runCount: 1 },
    ]);
    expect(body.modelComparison).toEqual([
      { role: "developer", model: "model-a", averageCostPerRun: 1.5, runs: 1 },
      { role: "reviewer", model: "model-b", averageCostPerRun: 1.0, runs: 1 },
    ]);
    expect(body.efficiency.averageInitialContextTokens).toEqual({ availability: "available", value: 7000 });
    expect(body.efficiency.averageOutputTokens).toEqual({ availability: "available", value: 100 });
    expect(body.efficiency.aiRunsPerTask).toEqual({ availability: "available", value: 2 });
    expect(body.efficiency.reworkCyclesPerTask).toEqual({ availability: "available", value: 1 });
    expect(body.efficiency.cacheShare.availability).toBe("available");
    expect(body.efficiency.cacheShare.value).toBeCloseTo(250 / 950, 10);
    await app.close();
    db.close();
  });

  it("treats the UTC window boundaries as inclusive (to-bound without milliseconds)", async () => {
    const db = makeDb();
    seedFullUsage(db);
    const app = Fastify();
    await usageRoutes(app, { db });

    // to без миллисекунд: запись ровно в эту секунду (u-3 = d21End = 23:59:59.999) должна быть включена,
    // а u-4 (d22Start) — нет.
    const response = await app.inject({ method: "GET", url: windowUrl(T.d21Start, T.d21EndNoMs) });
    const body = JSON.parse(response.body);
    expect(response.statusCode).toBe(200);
    expect(body.summary.cost).toBeCloseTo(2.5, 10);
    expect(body.summary.totalTokens).toBe(950);
    await app.close();
    db.close();
  });

  it("buckets daily series across UTC day boundaries", async () => {
    const db = makeDb();
    seedFullUsage(db);
    const app = Fastify();
    await usageRoutes(app, { db });

    const response = await app.inject({ method: "GET", url: windowUrl(T.d20, T.d22Start) });
    const body = JSON.parse(response.body);
    expect(response.statusCode).toBe(200);
    // u-1 (d20), u-2/u-3 (d21), u-4 (d22Start — включена, т.к. to=d22Start).
    expect(body.dailySeries).toEqual([
      { date: "2026-10-20", usage: { inputTokens: 100, cachedTokens: 50, outputTokens: 40, totalTokens: 190, cost: 0.5 } },
      { date: "2026-10-21", usage: { inputTokens: 500, cachedTokens: 250, outputTokens: 200, totalTokens: 950, cost: 2.5 } },
      { date: "2026-10-22", usage: { inputTokens: 400, cachedTokens: 200, outputTokens: 160, totalTokens: 760, cost: 2.0 } },
    ]);
    expect(body.summary.cost).toBeCloseTo(5.0, 10);
    await app.close();
    db.close();
  });

  it("marks unsupported statistics unavailable and handles empty datasets", async () => {
    const db = makeDb();
    seedFullUsage(db);
    const app = Fastify();
    await usageRoutes(app, { db });

    const response = await app.inject({ method: "GET", url: windowUrl(T.d24, T.d24) });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    expect(body.summary).toEqual({ inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 });
    expect(body.dailySeries).toEqual([]);
    expect(body.breakdowns.byRole).toEqual([]);
    expect(body.breakdowns.byReason).toEqual([]);
    expect(body.breakdowns.byModel).toEqual([]);
    expect(body.modelComparison).toEqual([]);
    // Пустое окно: нет базы для долей/средних — всё явно unavailable.
    expect(body.efficiency.cacheShare).toEqual({ availability: "unavailable", reason: "NOT_RECORDED" });
    expect(body.efficiency.averageInitialContextTokens).toEqual({ availability: "unavailable", reason: "NOT_RECORDED" });
    expect(body.efficiency.averageOutputTokens).toEqual({ availability: "unavailable", reason: "NOT_RECORDED" });
    expect(body.efficiency.aiRunsPerTask).toEqual({ availability: "unavailable", reason: "NOT_RECORDED" });
    expect(body.efficiency.reworkCyclesPerTask).toEqual({ availability: "unavailable", reason: "NOT_RECORDED" });
    expect(body.efficiency.deterministicCheckCount).toEqual({ availability: "unavailable", reason: "NO_DURABLE_CHECK_EXECUTION_SOURCE" });
    expect(body.efficiency.deterministicCheckCost).toEqual({ availability: "unavailable", reason: "NO_DURABLE_CHECK_EXECUTION_SOURCE" });
    expect(body.anomaly).toEqual({ availability: "unavailable", reason: "NO_APPROVED_POLICY" });
    expect(body.taskRecoveryShare).toEqual({ availability: "unavailable", reason: "NO_APPROVED_POLICY" });
    await app.close();
    db.close();
  });

  it("keeps persisted zero values available as 0 when a denominator exists", async () => {
    const db = makeDb();
    seedFullUsage(db);
    const app = Fastify();
    await usageRoutes(app, { db });

    // Окно только u-1: задача одна, rework-классификаций нет → reworkCyclesPerTask = 0 (available), не unavailable.
    const response = await app.inject({ method: "GET", url: windowUrl(T.d20, T.d20) });
    const body = JSON.parse(response.body);
    expect(response.statusCode).toBe(200);
    expect(body.efficiency.reworkCyclesPerTask).toEqual({ availability: "available", value: 0 });
    expect(body.efficiency.aiRunsPerTask).toEqual({ availability: "available", value: 1 });
    await app.close();
    db.close();
  });

  it("rejects malformed windows and invalid granularity", async () => {
    const db = makeDb();
    const app = Fastify();
    await usageRoutes(app, { db });

    const cases = [
      "/api/v1/usage?from=2026-10-21T00:00:00.000Z&granularity=day",
      "/api/v1/usage?to=2026-10-21T00:00:00.000Z&granularity=day",
      `${windowUrl(T.d21Start, T.d21End)}&extra=1`,
      windowUrl("not-a-date", T.d21End),
      windowUrl(T.d21End, T.d21Start),
      windowUrl(T.d21Start, T.d21End, "week"),
    ] as const;
    for (const url of cases) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(400);
    }
    await app.close();
    db.close();
  });

  it("keeps budget projections alongside the window analytics", async () => {
    const db = makeDb();
    seedFullUsage(db);
    const now = T.d20;
    db.run(
      `INSERT INTO budget_configs (id,scope,scope_id,limit_cost,soft_limit_cost,policy,spent_cost,reserved_cost,created_at,updated_at)
       VALUES ($id,$scope,$scopeId,$limit,$soft,$policy,$spent,$reserved,$now,$now)`,
      { id: "config-0", scope: "project", scopeId: "p-1", limit: 80, soft: 60, policy: "soft", spent: 20, reserved: 3, now },
    );
    db.run(
      `INSERT INTO budget_reservations (id,project_id,epic_id,task_id,estimate_cost,status,role,model,trigger_reason,created_at)
       VALUES ('reservation-active','p-1','e-1','t-1',1.5,'RESERVED','developer','model-a','DEVELOPMENT',$now)`,
      { now },
    );

    const app = Fastify();
    await usageRoutes(app, { db });
    const response = await app.inject({ method: "GET", url: windowUrl(T.d21Start, T.d21End) });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    expect(body.budgets.configurations).toEqual([
      { scope: "project", scopeId: "p-1", limitCost: 80, softLimitCost: 60, policy: "soft", spentCost: 20, reservedCost: 3 },
    ]);
    expect(body.budgets.contexts).toEqual([
      expect.objectContaining({ scope: "global", effectiveLimit: null }),
      expect.objectContaining({ scope: "project", scopeId: "p-1", effectiveLimit: body.budgets.configurations[0] }),
      expect.objectContaining({ scope: "epic", scopeId: "e-1" }),
      expect.objectContaining({ scope: "task", scopeId: "t-1" }),
    ]);
    expect(body.budgets.activeReservations).toEqual([
      {
        id: "reservation-active",
        projectId: "p-1",
        epicId: "e-1",
        taskId: "t-1",
        estimateCost: 1.5,
        status: "RESERVED",
        role: "developer",
        model: "model-a",
        triggerReason: "DEVELOPMENT",
        reworkCategory: null,
        createdAt: now,
      },
    ]);
    await app.close();
    db.close();
  });

  it("requires an authenticated session for the usage route", async () => {
    const db = makeDb();
    const app = createApp({ db, scheduler: new SchedulerService(db), runtime: mockRuntime, authService: createTestAuthService() });
    const url = windowUrl(T.d21Start, T.d21End);
    const unauth = await app.inject({ method: "GET", url });
    expect(unauth.statusCode).toBe(401);
    const auth = await app.inject({ method: "GET", url, headers: { cookie: TEST_COOKIE } });
    expect(auth.statusCode).toBe(200);
    await app.close();
    db.close();
  });
});
