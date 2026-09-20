import { describe, expect, it } from "vitest";
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
  const scheduler = { dispatchTask() {}, releaseTask() {}, projectProjection: () => ({ global: { active: 0, max: 1 }, projects: [] }) };
  const app = createApp({ db, scheduler: scheduler as never, runService: {} as never });
  const now = new Date().toISOString();
  db.run("INSERT INTO projects (id,name,display_name,status,created_at,updated_at) VALUES ('project-1','p','P','ACTIVE',$now,$now)", { now });
  for (const id of ["task-a", "task-b", "task-c"]) {
    db.run(
      "INSERT INTO tasks (id,project_id,display_id,title,status,contract_json,created_at,updated_at) VALUES ($id,'project-1',$id,$id,'DRAFT',$contract,$now,$now)",
      { id, contract: JSON.stringify({ version: 1, goal: id, context: "test", requirements: [], acceptanceCriteria: [], dependencies: [], nonGoals: [], definitionOfDone: [] }), now },
    );
  }
  return { app, db };
}

function headers(app: ReturnType<typeof createApp>) {
  return { authorization: `Bearer ${app.sessionToken}`, origin: "http://127.0.0.1:3000", "x-csrf-token": app.csrfToken };
}

describe("task dependency routes", () => {
  it("lists, creates, and removes dependencies", async () => {
    const { app, db } = setup();
    const auth = headers(app);
    const empty = await app.inject({ method: "GET", url: "/api/v1/tasks/task-b/dependencies", headers: auth });
    expect(empty.statusCode).toBe(200);
    expect(JSON.parse(empty.body).dependencies).toEqual([]);

    const created = await app.inject({ method: "POST", url: "/api/v1/tasks/task-b/dependencies", headers: auth, payload: { dependsOnTaskId: "task-a" } });
    expect(created.statusCode).toBe(201);
    expect(JSON.parse(created.body).dependency).toMatchObject({ taskId: "task-b", dependsOnTaskId: "task-a", type: "BLOCKING" });

    const listed = await app.inject({ method: "GET", url: "/api/v1/tasks/task-b/dependencies", headers: auth });
    expect(JSON.parse(listed.body).dependencies).toHaveLength(1);
    const removed = await app.inject({ method: "DELETE", url: "/api/v1/tasks/task-b/dependencies/task-a", headers: auth });
    expect(removed.statusCode).toBe(200);
    expect(JSON.parse(removed.body)).toEqual({ ok: true });
    await app.close();
    db.close();
  });

  it("validates input and maps missing tasks and conflicts to stable errors", async () => {
    const { app, db } = setup();
    const auth = headers(app);
    expect((await app.inject({ method: "POST", url: "/api/v1/tasks/task-b/dependencies", headers: auth, payload: { dependsOnTaskId: "task-a", extra: true } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/v1/tasks/missing/dependencies", headers: auth, payload: { dependsOnTaskId: "task-a" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/v1/tasks/task-b/dependencies", headers: auth, payload: { dependsOnTaskId: "missing" } })).statusCode).toBe(404);
    const duplicate = await app.inject({ method: "POST", url: "/api/v1/tasks/task-b/dependencies", headers: auth, payload: { dependsOnTaskId: "task-a" } });
    expect(duplicate.statusCode).toBe(201);
    const duplicateAgain = await app.inject({ method: "POST", url: "/api/v1/tasks/task-b/dependencies", headers: auth, payload: { dependsOnTaskId: "task-a" } });
    expect(duplicateAgain.statusCode).toBe(409);
    expect(JSON.parse(duplicateAgain.body)).toEqual({ error: "dependency already exists" });
    const cycle = await app.inject({ method: "POST", url: "/api/v1/tasks/task-a/dependencies", headers: auth, payload: { dependsOnTaskId: "task-b" } });
    expect(cycle.statusCode).toBe(409);
    expect(JSON.parse(cycle.body)).toEqual({ error: "dependency cycle detected" });
    expect(cycle.body).not.toContain("Adding this dependency would create a cycle");
    await app.close();
    db.close();
  });

  it("returns 503 when dependency storage is unavailable", async () => {
    const scheduler = { dispatchTask() {}, releaseTask() {}, projectProjection: () => ({ global: { active: 0, max: 1 }, projects: [] }) };
    const app = createApp({ scheduler: scheduler as never });
    const response = await app.inject({ method: "GET", url: "/api/v1/tasks/task-a/dependencies", headers: headers(app) });
    expect(response.statusCode).toBe(503);
    await app.close();
  });
});
