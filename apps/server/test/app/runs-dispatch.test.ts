import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app/create-app.js";
import { createSqliteDatabase } from "../../src/platform/database/sqlite-database.js";
import { runMigrations, type Migration } from "../../src/platform/database/migrator.js";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationDir = fileURLToPath(new URL("../../src/platform/database/migrations/", import.meta.url));
const migrations: Migration[] = readdirSync(migrationDir).filter((file) => file.endsWith(".sql")).map((file) => ({
  version: Number(/^([0-9]+)/.exec(file)?.[1]),
  name: file.replace(/^[0-9]+_/, "").replace(/\.sql$/, ""),
  sql: readFileSync(join(migrationDir, file), "utf8"),
}));

function setup() {
  const db = createSqliteDatabase(":memory:");
  runMigrations(db, migrations);
  const run = {
    id: "run-1", role: "developer", runtime: "hermes", model: "default", taskId: "task-1", epicId: null,
    status: "STARTED", sessionId: null, attempt: null, triggerReason: "runtime-request", contextVersion: "runtime-request-v1",
    outputSchemaVersion: "1", startedAt: new Date(), endedAt: null, exitCode: null, inputTokens: null,
    cachedInputTokens: null, outputTokens: null, cost: null,
  } as never;
  const runService = {
    cancelRun: vi.fn(),
    prepareRun: vi.fn(() => run),
    executePreparedRun: vi.fn(async () => ({ run, outcome: { success: true } })),
    failPreparedRun: vi.fn(),
  };
  const scheduler = {
    dispatchTask: vi.fn(),
    releaseTask: vi.fn(),
    projectProjection: vi.fn(() => ({ global: { active: 0, max: 1 }, projects: [] })),
  };
  const app = createApp({ db, scheduler: scheduler as never, runService });
  const now = new Date().toISOString();
  db.run("INSERT INTO projects (id,name,display_name,status,created_at,updated_at) VALUES ('project-1','p','P','ACTIVE',$now,$now)", { now });
  db.run(
    `INSERT INTO tasks (id,project_id,display_id,title,status,contract_json,created_at,updated_at)
     VALUES ('task-1','project-1','T-1','Task','READY',$contract,$now,$now)`,
    { contract: JSON.stringify({ version: 1, goal: "run", context: "test", requirements: [], acceptanceCriteria: [], dependencies: [], nonGoals: [], definitionOfDone: [] }), now },
  );
  return { app, db, runService, scheduler };
}

function headers(app: ReturnType<typeof createApp>) {
  return { authorization: `Bearer ${app.sessionToken}`, origin: "http://127.0.0.1:3000", "x-csrf-token": app.csrfToken };
}

describe("task dispatch route", () => {
  it("prepares one durable run, binds it to scheduler, and acknowledges asynchronously", async () => {
    const { app, db, runService, scheduler } = setup();
    const response = await app.inject({ method: "POST", url: "/api/v1/tasks/task-1/dispatch", headers: headers(app) });
    expect(response.statusCode).toBe(202);
    expect(JSON.parse(response.body)).toMatchObject({ runId: "run-1", taskId: "task-1", status: "STARTED" });
    expect(runService.prepareRun).toHaveBeenCalledWith(expect.objectContaining({ role: "developer", model: "default", taskId: "task-1" }));
    expect(scheduler.dispatchTask).toHaveBeenCalledWith("task-1", expect.anything(), expect.any(Function), expect.objectContaining({ runId: "run-1" }));
    await Promise.resolve();
    expect(runService.executePreparedRun).toHaveBeenCalledWith("run-1");
    await app.close();
    db.close();
  });

  it("rejects unknown fields and non-ready tasks", async () => {
    const { app, db } = setup();
    const invalid = await app.inject({ method: "POST", url: "/api/v1/tasks/task-1/dispatch", headers: headers(app), payload: { role: "developer", extra: true } });
    expect(invalid.statusCode).toBe(400);
    db.run("UPDATE tasks SET status='DRAFT' WHERE id='task-1'");
    const notReady = await app.inject({ method: "POST", url: "/api/v1/tasks/task-1/dispatch", headers: headers(app), payload: {} });
    expect(notReady.statusCode).toBe(409);
    await app.close();
    db.close();
  });
});
