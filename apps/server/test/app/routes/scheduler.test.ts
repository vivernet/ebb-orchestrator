import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../../../src/app/create-app.js";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { SchedulerService } from "../../../src/modules/scheduler/scheduler-service.js";
import { runMigrations, type Migration } from "../../../src/platform/database/migrator.js";
import type { AgentRuntime } from "../../../src/modules/runtime/agent-runtime.js";
import { createTestAuthService, TEST_COOKIE, TEST_CSRF_TOKEN } from "../../helpers/auth.js";
import { executionQueueProjectionSchema } from "@ebb-orchestrator/contracts";
import type { Database } from "../../../src/platform/database/database.js";

const migrationDir = fileURLToPath(new URL("../../../src/platform/database/migrations/", import.meta.url));
const migrations: Migration[] = readdirSync(migrationDir).filter((file) => file.endsWith(".sql")).map((file) => {
  const match = /^(\d+)_([^.]*)\.sql$/.exec(file);
  if (!match) throw new Error(`Invalid migration filename: ${file}`);
  return { version: Number(match[1]), name: match[2]!, sql: readFileSync(join(migrationDir, file), "utf8") };
});

const mockRuntime: AgentRuntime = {
  active: 0, maxActive: 0, calls: [],
  async startRun() {},
  async runResult() { return { version: "1.0", summary: "" } as never; },
  async resumeRun() {},
  async cancelRun() {},
  async inspectRun() { throw new Error("not implemented"); },
  async collectResult() { return { success: true, exitCode: 0, output: "", validatedSubmission: false, diagnostics: { runId: "", sessionId: null, stderr: "", exitCode: 0, artifactReferences: [] } } as never; },
  async collectUsage() { return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, cost: 0 }; },
  async healthCheck() { return true; },
};

function makeApp() {
  const db = createSqliteDatabase(":memory:");
  runMigrations(db, migrations);
  const scheduler = new SchedulerService(db);
  const app = createApp({ db, scheduler, runtime: mockRuntime, authService: createTestAuthService() });
  return { app, db, scheduler };
}

const mutationHeaders = {
  cookie: TEST_COOKIE,
  origin: "http://127.0.0.1:3000",
  "x-csrf-token": TEST_CSRF_TOKEN,
};

describe("scheduler routes", () => {
  let app: ReturnType<typeof makeApp>["app"] | undefined;
  let db: Database | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    db?.close();
    db = undefined;
  });

  function start(): ReturnType<typeof makeApp> {
    const ctx = makeApp();
    app = ctx.app;
    db = ctx.db;
    return ctx;
  }

  it("GET /api/v1/execution returns the full typed execution queue projection", async () => {
    const ctx = start();
    const now = new Date().toISOString();
    const projectId = "exec-project";
    ctx.db.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'p','P','ACTIVE',$now,$now)", { id: projectId, now });
    ctx.db.run("INSERT INTO agent_runs(id,role,runtime,model,status,task_id) VALUES('run-1','developer','hermes','test','IN_PROGRESS','task-1')", {});
    ctx.db.run("INSERT INTO scheduler_reservations(id,kind,subject_id,project_id,owner_id,reserved_at,estimate_cost,status,role,model,run_id) VALUES('res-1','TASK','task-1',$projectId,'task:task-1',$now,5,'RESERVED','developer','default','run-1')", { projectId, now });
    ctx.db.run("INSERT INTO scheduler_resource_locks(resource_key,reservation_id,project_id,owner_id,locked_at) VALUES('task:task-1','res-1',$projectId,'task:task-1',$now)", { projectId, now });
    ctx.db.run("INSERT INTO outbox_events(id,type,aggregate_type,aggregate_id,payload_json,created_at,available_at,attempts) VALUES('evt-1','AgentRunRequested','Task','task-1','{}',$now,$now,0)", { now });

    const response = await app!.inject({ method: "GET", url: "/api/v1/execution", headers: { cookie: TEST_COOKIE } });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    // Строгая контрактная схема Task 1: неизвестные/отсутствующие поля отклоняются.
    const parsed = executionQueueProjectionSchema.parse(body);
    expect(parsed.running).toContainEqual(expect.objectContaining({ runId: "run-1" }));
    expect(parsed.capacity).toEqual({ configured: expect.any(Number), used: 1 });
    expect(parsed.locks).toContainEqual(expect.objectContaining({ resource: "task:task-1", runId: "run-1", heldAt: now }));
    expect(parsed.recentEvents).toContainEqual(expect.objectContaining({ id: "evt-1", type: "AgentRunRequested" }));
    expect(parsed.dispatchState).toEqual({ paused: false, updatedAt: null });
  });

  it("PUT /api/v1/scheduler/dispatch-state updates dispatch state transactionally and persists it", async () => {
    start();
    const putResponse = await app!.inject({
      method: "PUT",
      url: "/api/v1/scheduler/dispatch-state",
      headers: mutationHeaders,
      payload: { paused: true },
    });
    expect(putResponse.statusCode).toBe(200);
    const putBody = JSON.parse(putResponse.body);
    expect(putBody.paused).toBe(true);
    expect(putBody.updatedAt).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(putBody.updatedAt))).toBe(false);

    // Состояние доступно через GET /execution и через прямой GET маршрут.
    const execution = await app!.inject({ method: "GET", url: "/api/v1/execution", headers: { cookie: TEST_COOKIE } });
    expect(JSON.parse(execution.body).dispatchState).toEqual({ paused: true, updatedAt: putBody.updatedAt });

    const direct = await app!.inject({ method: "GET", url: "/api/v1/scheduler/dispatch-state", headers: { cookie: TEST_COOKIE } });
    expect(JSON.parse(direct.body)).toEqual({ paused: true, updatedAt: putBody.updatedAt });

    // Idempotентный повтор и снятие паузы.
    const repeat = await app!.inject({ method: "PUT", url: "/api/v1/scheduler/dispatch-state", headers: mutationHeaders, payload: { paused: true } });
    expect(JSON.parse(repeat.body).paused).toBe(true);
    const resume = await app!.inject({ method: "PUT", url: "/api/v1/scheduler/dispatch-state", headers: mutationHeaders, payload: { paused: false } });
    expect(JSON.parse(resume.body)).toEqual({ paused: false, updatedAt: expect.any(String) });
    const after = await app!.inject({ method: "GET", url: "/api/v1/execution", headers: { cookie: TEST_COOKIE } });
    expect(JSON.parse(after.body).dispatchState.paused).toBe(false);
  });

  it("rejects malformed or unknown dispatch-state bodies with 400", async () => {
    start();
    for (const payload of [
      { paused: "yes" },
      { paused: 1 },
      { paused: true, extra: 1 },
      {},
      null,
      "paused",
    ]) {
      const response = await app!.inject({
        method: "PUT",
        url: "/api/v1/scheduler/dispatch-state",
        headers: { ...mutationHeaders, "content-type": "application/json" },
        payload: payload as never,
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it("requires authentication and origin/CSRF for dispatch-state mutation", async () => {
    start();
    const noSession = await app!.inject({ method: "PUT", url: "/api/v1/scheduler/dispatch-state", payload: { paused: true } });
    expect(noSession.statusCode).toBe(401);

    const badOrigin = await app!.inject({
      method: "PUT",
      url: "/api/v1/scheduler/dispatch-state",
      headers: { cookie: TEST_COOKIE, origin: "http://evil.example", "x-csrf-token": TEST_CSRF_TOKEN },
      payload: { paused: true },
    });
    expect(badOrigin.statusCode).toBe(403);

    const getRequiresSession = await app!.inject({ method: "GET", url: "/api/v1/scheduler/dispatch-state" });
    expect(getRequiresSession.statusCode).toBe(401);
  });

  it("serves 503 when the scheduler is unavailable", async () => {
    const dbOnly = createSqliteDatabase(":memory:");
    runMigrations(dbOnly, migrations);
    const appOnly = createApp({ db: dbOnly, runtime: mockRuntime, authService: createTestAuthService() } as never);
    try {
      const response = await appOnly.inject({ method: "PUT", url: "/api/v1/scheduler/dispatch-state", headers: mutationHeaders, payload: { paused: true } });
      expect(response.statusCode).toBe(503);
    } finally {
      await appOnly.close();
      dbOnly.close();
    }
  });
});
