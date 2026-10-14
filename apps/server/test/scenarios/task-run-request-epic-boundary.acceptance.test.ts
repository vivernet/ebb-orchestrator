import { afterEach, describe, expect, it } from "vitest";
import { createSqliteDatabase } from "../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../helpers/migrations.js";
import { SchedulerService } from "../../src/modules/scheduler/scheduler-service.js";

describe("Task RunRequest Epic boundary", () => {
  const databases: ReturnType<typeof createSqliteDatabase>[] = [];
  afterEach(() => { for (const db of databases.splice(0)) db.close(); });

  function setup() {
    const db = createSqliteDatabase(":memory:");
    databases.push(db);
    runMigrations(db, loadTestMigrations());
    const now = "2026-10-14T00:00:00.000Z";
    db.run("INSERT INTO projects(id,name,display_name,created_at,updated_at) VALUES('project','Project','Project',$now,$now)", { now });
    db.run("INSERT INTO epics(id,project_id,display_id,title,contract_json,created_at,updated_at) VALUES('epic','project','E-1','Epic','{}',$now,$now)", { now });
    db.run("INSERT INTO tasks(id,project_id,epic_id,display_id,title,status,contract_json,created_at,updated_at) VALUES('epic-task','project','epic','T-1','Epic task','READY','{}',$now,$now)", { now });
    db.run("INSERT INTO tasks(id,project_id,display_id,title,status,contract_json,created_at,updated_at) VALUES('standalone-task','project','T-2','Standalone task','READY','{}',$now,$now)", { now });
    return { db, scheduler: new SchedulerService(db) };
  }

  it.each(["TASK_API", "TASK_RECOVERY", "TASK_STAGE"] as const)("rejects %s requests for Epic-owned Tasks", (originType) => {
    const { db, scheduler } = setup();
    const enqueue = () => scheduler.enqueueRunRequest({ taskId: "epic-task", role: "developer", model: "default",
      idempotencyKey: `key-${originType}`, originType, originId: `origin-${originType}` });

    expect(enqueue).toThrow("RUN_REQUEST_EPIC_TASK_UNSUPPORTED");
    expect(db.get<{ count: number }>("SELECT count(*) AS count FROM scheduler_run_requests")?.count).toBe(0);
  });

  it.each(["TASK_API", "TASK_RECOVERY", "TASK_STAGE"] as const)("rejects transactional %s requests for Epic-owned Tasks", (originType) => {
    const { db, scheduler } = setup();
    expect(() => db.transaction((tx) => scheduler.enqueueRunRequestInTransaction(tx, {
      taskId: "epic-task", role: "developer", model: "default", idempotencyKey: `tx-${originType}`,
      originType, originId: `tx-origin-${originType}`,
    }))).toThrow("RUN_REQUEST_EPIC_TASK_UNSUPPORTED");
    expect(db.get<{ count: number }>("SELECT count(*) AS count FROM scheduler_run_requests")?.count).toBe(0);
  });

  it("continues to accept a standalone Task API request", () => {
    const { scheduler } = setup();
    expect(scheduler.enqueueRunRequest({ taskId: "standalone-task", role: "developer", model: "default",
      idempotencyKey: "standalone-key", originType: "TASK_API", originId: "standalone" })).toMatchObject({
      taskId: "standalone-task", originType: "TASK_API", status: "PENDING",
    });
  });
});
