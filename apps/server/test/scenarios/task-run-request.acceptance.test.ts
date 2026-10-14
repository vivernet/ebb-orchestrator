import { afterEach, describe, expect, it } from "vitest";
import { createSqliteDatabase } from "../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../helpers/migrations.js";
import { createApp } from "../../src/app/create-app.js";
import { SchedulerService } from "../../src/modules/scheduler/scheduler-service.js";
import { createTestAuthService, TEST_COOKIE, TEST_CSRF_TOKEN } from "../helpers/auth.js";

describe("durable Task dispatch API", () => {
  const databases: ReturnType<typeof createSqliteDatabase>[] = [];
  afterEach(() => { for (const db of databases.splice(0)) db.close(); });

  function setup() {
    const db = createSqliteDatabase(":memory:");
    databases.push(db);
    runMigrations(db, loadTestMigrations());
    const now = "2026-10-14T00:00:00.000Z";
    db.run("INSERT INTO projects(id,name,display_name,created_at,updated_at) VALUES('project','Project','Project',$now,$now)", { now });
    db.run("INSERT INTO tasks(id,project_id,display_id,title,status,contract_json,created_at,updated_at) VALUES('task','project','T-1','Task','READY','{}',$now,$now)", { now });
    const scheduler = new SchedulerService(db);
    const app = createApp({ db, scheduler, runService: { cancelRun() {} }, authService: createTestAuthService() });
    const headers = { cookie: TEST_COOKIE, origin: "http://127.0.0.1:3000", "x-csrf-token": TEST_CSRF_TOKEN };
    return { db, scheduler, app, headers };
  }

  it("requires Idempotency-Key before creating any durable intent", async () => {
    const { app, db, headers } = setup();
    try {
      const response = await app.inject({ method: "POST", url: "/api/v1/tasks/task/dispatch", headers });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: "RUN_REQUEST_IDEMPOTENCY_KEY_REQUIRED" } });
      expect(db.get<{ count: number }>("SELECT count(*) AS count FROM scheduler_run_requests")?.count).toBe(0);
    } finally { await app.close(); }
  });

  it("accepts wait as pending, replays a lost response and reads the same durable intent", async () => {
    const { app, db, headers } = setup();
    try {
      const call = () => app.inject({ method: "POST", url: "/api/v1/tasks/task/dispatch", headers: { ...headers, "idempotency-key": "caller-key" }, payload: { role: "developer", model: "default" } });
      const first = await call();
      expect(first.statusCode).toBe(202);
      expect(first.json()).toMatchObject({ taskId: "task", status: "PENDING", runId: null });
      const replay = await call();
      expect(replay.json()).toEqual(first.json());
      const read = await app.inject({ method: "GET", url: `/api/v1/tasks/task/dispatch-requests/${first.json().requestId}`, headers });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toEqual(first.json());
      expect(db.get<{ count: number }>("SELECT count(*) AS count FROM agent_runs")?.count).toBe(0);
      const conflict = await app.inject({ method: "POST", url: "/api/v1/tasks/task/dispatch", headers: { ...headers, "idempotency-key": "caller-key" }, payload: { role: "qa", model: "default" } });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toMatchObject({ error: { code: "RUN_REQUEST_IDEMPOTENCY_CONFLICT" } });
    } finally { await app.close(); }
  });
});
