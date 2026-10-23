import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app/create-app.js";
import { createSqliteDatabase } from "../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../helpers/migrations.js";
import { SchedulerService } from "../../src/modules/scheduler/scheduler-service.js";
import { createTestAuthService, TEST_COOKIE, TEST_CSRF_TOKEN } from "../helpers/auth.js";

describe("task dispatch route durable producer", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
  function setup() {
    const db = createSqliteDatabase(":memory:"); runMigrations(db, loadTestMigrations());
    const now = new Date().toISOString();
    db.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES('project-1','p','P','ACTIVE',$now,$now)", { now });
    db.run("INSERT INTO tasks(id,project_id,display_id,title,status,contract_json,created_at,updated_at) VALUES('task-1','project-1','T-1','Task','READY','{}',$now,$now)", { now });
    const scheduler = new SchedulerService(db);
    const runService = { cancelRun: vi.fn(), prepareRun: vi.fn(), executePreparedRun: vi.fn(), validateTaskRequestModel: vi.fn() };
    const app = createApp({ db, scheduler, runService, authService: createTestAuthService() });
    cleanups.push(async () => { await app.close(); db.close(); });
    const headers = { cookie: TEST_COOKIE, origin: "http://127.0.0.1:3000", "x-csrf-token": TEST_CSRF_TOKEN, "idempotency-key": "caller-1" };
    return { app, db, scheduler, runService, headers };
  }
  it("rejects an unsupported model selection before persistence", async () => {
    const f = setup(); f.runService.validateTaskRequestModel.mockImplementation(() => { throw new Error("RUN_REQUEST_MODEL_UNSUPPORTED"); });
    const response = await f.app.inject({ method: "POST", url: "/api/v1/tasks/task-1/dispatch", headers: f.headers, payload: { model: "explicit-model" } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "RUN_REQUEST_MODEL_UNSUPPORTED", message: "Неизвестная модель. Доступные модели указаны в настройках." } });
    expect(f.db.all("SELECT * FROM scheduler_run_requests")).toEqual([]);
    expect(f.runService.prepareRun).not.toHaveBeenCalled();
  });
  it("rejects an unknown model by name with the Russian error message", async () => {
    const f = setup(); f.runService.validateTaskRequestModel.mockImplementation(() => { throw new Error("RUN_REQUEST_MODEL_UNSUPPORTED"); });
    const response = await f.app.inject({ method: "POST", url: "/api/v1/tasks/task-1/dispatch", headers: f.headers, payload: { model: "nonexistent-model" } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: { code: "RUN_REQUEST_MODEL_UNSUPPORTED", message: "Неизвестная модель. Доступные модели указаны в настройках." } });
    expect(f.db.all("SELECT * FROM scheduler_run_requests")).toEqual([]);
  });
  it("acknowledges durable pending without preparing or launching in the route", async () => {
    const f = setup(); const response = await f.app.inject({ method: "POST", url: "/api/v1/tasks/task-1/dispatch", headers: f.headers });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ taskId: "task-1", status: "PENDING", runId: null, requestId: expect.any(String) });
    expect(f.db.all("SELECT * FROM agent_runs")).toEqual([]);
    expect(f.runService.prepareRun).not.toHaveBeenCalled(); expect(f.runService.executePreparedRun).not.toHaveBeenCalled();
  });
  it("rejects unknown fields, unsupported role and a new intent for a non-ready Task", async () => {
    const f = setup();
    for (const payload of [{ extra: true }, { role: "coordinator" }]) {
      expect((await f.app.inject({ method: "POST", url: "/api/v1/tasks/task-1/dispatch", headers: f.headers, payload })).statusCode).toBe(400);
    }
    f.db.run("UPDATE tasks SET status='DRAFT' WHERE id='task-1'");
    expect((await f.app.inject({ method: "POST", url: "/api/v1/tasks/task-1/dispatch", headers: f.headers })).statusCode).toBe(409);
    expect(f.db.all("SELECT * FROM scheduler_run_requests")).toEqual([]);
  });
  it("returns a deterministic conflict for an Epic-owned Task and creates no request", async () => {
    const f = setup();
    const now = new Date().toISOString();
    f.db.run("INSERT INTO epics(id,project_id,display_id,title,contract_json,created_at,updated_at) VALUES('epic-1','project-1','E-1','Epic','{}',$now,$now)", { now });
    f.db.run("UPDATE tasks SET epic_id='epic-1' WHERE id='task-1'");

    const response = await f.app.inject({ method: "POST", url: "/api/v1/tasks/task-1/dispatch", headers: f.headers });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "RUN_REQUEST_EPIC_TASK_UNSUPPORTED" } });
    expect(f.db.all("SELECT * FROM scheduler_run_requests")).toEqual([]);
  });
  it("retains the selected Reviewer role/model and the stable source reference", async () => {
    const f = setup(); const response = await f.app.inject({ method: "POST", url: "/api/v1/tasks/task-1/dispatch", headers: f.headers, payload: { role: "Reviewer", model: "selected-model" } });
    expect(response.statusCode).toBe(202);
    expect(f.db.get("SELECT role,model,origin_type,origin_id FROM scheduler_run_requests")).toEqual({ role: "reviewer", model: "selected-model", origin_type: "TASK_API", origin_id: "task-api:task-1" });
    expect(f.runService.prepareRun).not.toHaveBeenCalled();
  });
  it("deduplicates a lost response even after the Task left READY", async () => {
    const f = setup(); const call = () => f.app.inject({ method: "POST", url: "/api/v1/tasks/task-1/dispatch", headers: f.headers });
    const first = await call(); f.db.run("UPDATE tasks SET status='DEVELOPMENT' WHERE id='task-1'");
    const replay = await call(); expect(replay.statusCode).toBe(202); expect(replay.json()).toEqual(first.json());
  });
  it("requires Idempotency-Key and leaves the queue empty", async () => {
    const f = setup(); const { "idempotency-key": _key, ...headers } = f.headers;
    expect((await f.app.inject({ method: "POST", url: "/api/v1/tasks/task-1/dispatch", headers })).statusCode).toBe(400);
    expect(f.db.all("SELECT * FROM scheduler_run_requests")).toEqual([]);
  });
});
