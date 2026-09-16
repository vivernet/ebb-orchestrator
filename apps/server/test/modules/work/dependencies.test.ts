import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations, type Migration } from "../../../src/platform/database/migrator.js";
import type { Database } from "../../../src/platform/database/database.js";
import { WorkService } from "../../../src/modules/work/work-service.js";
import { DependencyService } from "../../../src/modules/work/dependency-service.js";
import type { TaskContract } from "../../../src/modules/work/work-types.js";

const migration001 = readFileSync(
  join(import.meta.dirname, "../../../src/platform/database/migrations/001_system.sql"),
  "utf-8",
);

const migration002 = readFileSync(
  join(import.meta.dirname, "../../../src/platform/database/migrations/002_work_domain.sql"),
  "utf-8",
);

const migration003 = readFileSync(
  join(import.meta.dirname, "../../../src/platform/database/migrations/003_work_control.sql"),
  "utf-8",
);

const migrations: Migration[] = [
  { version: 1, name: "001_system", sql: migration001 },
  { version: 2, name: "002_work_domain", sql: migration002 },
  { version: 3, name: "003_work_control", sql: migration003 },
];

function contract(goal: string): TaskContract {
  return {
    version: 1,
    goal,
    context: `Context for ${goal}`,
    requirements: ["req-1"],
    acceptanceCriteria: ["ac-1"],
    dependencies: [],
    nonGoals: [],
    definitionOfDone: ["done-1"],
  };
}

describe("DependencyService", () => {
  let db: Database | undefined;
  let tmpDir: string;
  let work: WorkService;
  let deps: DependencyService;
  const projectId = randomUUID();

  beforeEach(() => {
    tmpDir = "";
  });

  afterEach(async () => {
    db?.close();
    db = undefined;
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  async function setupDb(): Promise<Database> {
    tmpDir = await mkdtemp(join(tmpdir(), "orch-dep-test-"));
    const dbPath = join(tmpDir, `test-${randomUUID()}.db`);
    const database = createSqliteDatabase(dbPath);
    runMigrations(database, migrations);
    return database;
  }

  async function setupWithProject(): Promise<void> {
    db = await setupDb();
    db.transaction((tx) => {
      const now = new Date().toISOString();
      tx.run(
        "INSERT INTO projects (id, name, display_name, status, created_at, updated_at) VALUES ($id, $name, $display_name, $status, $created_at, $updated_at)",
        {
          id: projectId,
          name: "test-project",
          display_name: "Test Project",
          status: "ACTIVE",
          created_at: now,
          updated_at: now,
        },
      );
    });
    work = new WorkService(db);
    deps = new DependencyService(db);
  }

  it("prevents a task from depending on itself", async () => {
    await setupWithProject();
    const a = work.createStandaloneTask(projectId, contract("task-a"));
    expect(() => deps.addBlockingDependency(a.id, a.id)).toThrow(/itself/i);
  });

  it("adds a blocking dependency between two tasks", async () => {
    await setupWithProject();
    const a = work.createStandaloneTask(projectId, contract("task-a"));
    const b = work.createStandaloneTask(projectId, contract("task-b"));
    const dep = deps.addBlockingDependency(b.id, a.id);
    expect(dep.taskId).toBe(b.id);
    expect(dep.dependsOnTaskId).toBe(a.id);
    expect(dep.type).toBe("BLOCKING");
    expect(dep.id).toBeDefined();
    expect(dep.createdAt).toBeDefined();
  });

  it("prevents a direct cycle (A -> B -> A)", async () => {
    await setupWithProject();
    const a = work.createStandaloneTask(projectId, contract("task-a"));
    const b = work.createStandaloneTask(projectId, contract("task-b"));
    deps.addBlockingDependency(b.id, a.id);
    expect(() => deps.addBlockingDependency(a.id, b.id)).toThrow(/cycle/i);
  });

  it("prevents an indirect cycle through multiple tasks", async () => {
    await setupWithProject();
    const a = work.createStandaloneTask(projectId, contract("task-a"));
    const b = work.createStandaloneTask(projectId, contract("task-b"));
    const c = work.createStandaloneTask(projectId, contract("task-c"));
    deps.addBlockingDependency(b.id, a.id);
    deps.addBlockingDependency(c.id, b.id);
    expect(() => deps.addBlockingDependency(a.id, c.id)).toThrow(/cycle/i);
  });

  it("lists dependencies for a task", async () => {
    await setupWithProject();
    const a = work.createStandaloneTask(projectId, contract("task-a"));
    const b = work.createStandaloneTask(projectId, contract("task-b"));
    deps.addBlockingDependency(b.id, a.id);
    const list = deps.listDependencies(b.id);
    expect(list).toHaveLength(1);
    expect(list[0]!.dependsOnTaskId).toBe(a.id);
  });

  it("lists dependents (tasks that depend on a given task)", async () => {
    await setupWithProject();
    const a = work.createStandaloneTask(projectId, contract("task-a"));
    const b = work.createStandaloneTask(projectId, contract("task-b"));
    const c = work.createStandaloneTask(projectId, contract("task-c"));
    deps.addBlockingDependency(b.id, a.id);
    deps.addBlockingDependency(c.id, a.id);
    const list = deps.listDependents(a.id);
    expect(list).toHaveLength(2);
  });

  it("removes a dependency", async () => {
    await setupWithProject();
    const a = work.createStandaloneTask(projectId, contract("task-a"));
    const b = work.createStandaloneTask(projectId, contract("task-b"));
    deps.addBlockingDependency(b.id, a.id);
    deps.removeDependency(b.id, a.id);
    expect(deps.listDependencies(b.id)).toHaveLength(0);
  });

  it("throws when adding duplicate dependency", async () => {
    await setupWithProject();
    const a = work.createStandaloneTask(projectId, contract("task-a"));
    const b = work.createStandaloneTask(projectId, contract("task-b"));
    deps.addBlockingDependency(b.id, a.id);
    expect(() => deps.addBlockingDependency(b.id, a.id)).toThrow(/already exists/i);
  });
});
