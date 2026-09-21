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
import type { TaskContract } from "../../../src/modules/work/work-types.js";

const migration001 = readFileSync(
  join(import.meta.dirname, "../../../src/platform/database/migrations/001_system.sql"),
  "utf-8",
);

const migration002 = readFileSync(
  join(import.meta.dirname, "../../../src/platform/database/migrations/002_work_domain.sql"),
  "utf-8",
);

const migrations: Migration[] = [
  { version: 1, name: "001_system", sql: migration001 },
  { version: 2, name: "002_work_domain", sql: migration002 },
];

function contract(goal: string): TaskContract {
  return {
    version: 1,
    goal,
    context: `Context for ${goal}`,
    requirements: ["req-1", "req-2"],
    acceptanceCriteria: ["ac-1"],
    dependencies: [],
    nonGoals: [],
    definitionOfDone: ["done-1"],
  };
}

describe("WorkService", () => {
  let db: Database | undefined;
  let tmpDir: string;
  let work: WorkService;

  const projectA = { id: randomUUID(), name: "project-a", displayName: "Project A" };
  const projectB = { id: randomUUID(), name: "project-b", displayName: "Project B" };

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
    tmpDir = await mkdtemp(join(tmpdir(), "orch-work-test-"));
    const dbPath = join(tmpDir, `test-${randomUUID()}.db`);
    const database = createSqliteDatabase(dbPath);
    runMigrations(database, migrations);
    return database;
  }

  async function setupWithProjects(): Promise<void> {
    db = await setupDb();
    // Заполняем projects начальными данными.
    db.transaction((tx) => {
      const now = new Date().toISOString();
      tx.run(
        "INSERT INTO projects (id, name, display_name, status, created_at, updated_at) VALUES ($id, $name, $display_name, $status, $created_at, $updated_at)",
        {
          id: projectA.id,
          name: projectA.name,
          display_name: projectA.displayName,
          status: "ACTIVE",
          created_at: now,
          updated_at: now,
        },
      );
      tx.run(
        "INSERT INTO projects (id, name, display_name, status, created_at, updated_at) VALUES ($id, $name, $display_name, $status, $created_at, $updated_at)",
        {
          id: projectB.id,
          name: projectB.name,
          display_name: projectB.displayName,
          status: "ACTIVE",
          created_at: now,
          updated_at: now,
        },
      );
    });
    work = new WorkService(db);
  }

  it("allocates project-local task numbers", async () => {
    await setupWithProjects();
    const a = work.createStandaloneTask(projectA.id, contract("A"));
    const b = work.createStandaloneTask(projectB.id, contract("B"));
    expect(a.displayId).toBe("TASK-1");
    expect(b.displayId).toBe("TASK-1");
  });

  it("allocates sequential task numbers within a project", async () => {
    await setupWithProjects();
    const a = work.createStandaloneTask(projectA.id, contract("A"));
    const b = work.createStandaloneTask(projectA.id, contract("B"));
    expect(a.displayId).toBe("TASK-1");
    expect(b.displayId).toBe("TASK-2");
  });

  it("creates a standalone task with DRAFT status", async () => {
    await setupWithProjects();
    const task = work.createStandaloneTask(projectA.id, contract("test"));
    expect(task.status).toBe("DRAFT");
    expect(task.epicId).toBeNull();
    expect(task.projectId).toBe(projectA.id);
  });

  it("creates a task contract with persisted JSON", async () => {
    await setupWithProjects();
    const c = contract("test-contract");
    const task = work.createStandaloneTask(projectA.id, c);
    expect(task.contract).toEqual(c);
  });

  it("creates an epic with sequential display ID", async () => {
    await setupWithProjects();
    const epic1 = work.createEpic(projectA.id, contract("epic-1"));
    const epic2 = work.createEpic(projectA.id, contract("epic-2"));
    expect(epic1.displayId).toBe("EPIC-1");
    expect(epic2.displayId).toBe("EPIC-2");
  });

  it("creates a task within an epic", async () => {
    await setupWithProjects();
    const epic = work.createEpic(projectA.id, contract("epic"));
    const task = work.createEpicTask(epic.id, contract("task-in-epic"));
    expect(task.epicId).toBe(epic.id);
    expect(task.projectId).toBe(projectA.id);
  });

  it("does not allow a task to belong to two epics", async () => {
    await setupWithProjects();
    const epic1 = work.createEpic(projectA.id, contract("epic-1"));
    const epic2 = work.createEpic(projectA.id, contract("epic-2"));
    const task = work.createEpicTask(epic1.id, contract("shared-task"));
    expect(() => work.attachTaskToEpic(task.id, epic2.id)).toThrow(/already belongs/i);
  });

  it("archives a task by setting status to CANCELLED", async () => {
    await setupWithProjects();
    const task = work.createStandaloneTask(projectA.id, contract("to-archive"));
    const archived = work.archiveTask(task.id);
    expect(archived.status).toBe("CANCELLED");
  });

  it("pauses through the workflow engine and appends a state-change event", async () => {
    await setupWithProjects();
    const task = work.createStandaloneTask(projectA.id, contract("to-pause"));
    const paused = work.pauseTask(task.id);

    expect(paused.status).toBe("PAUSED");
    const event = db!.get<{ type: string; payload_json: string }>(
      "SELECT type,payload_json FROM outbox_events WHERE aggregate_id=$taskId",
      { taskId: task.id },
    );
    expect(event?.type).toBe("TaskStateChanged");
    expect(JSON.parse(event!.payload_json)).toMatchObject({
      taskId: task.id,
      fromStatus: "DRAFT",
      toStatus: "PAUSED",
    });
  });
});
