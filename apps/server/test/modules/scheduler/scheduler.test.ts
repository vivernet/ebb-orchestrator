import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations, type Migration } from "../../../src/platform/database/migrator.js";
import type { Database } from "../../../src/platform/database/database.js";
import { SchedulerService } from "../../../src/modules/scheduler/scheduler-service.js";
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

const migration005 = readFileSync(
  join(import.meta.dirname, "../../../src/platform/database/migrations/005_scheduler.sql"),
  "utf-8",
);

const migrations: Migration[] = [
  { version: 1, name: "001_system", sql: migration001 },
  { version: 2, name: "002_work_domain", sql: migration002 },
  { version: 3, name: "003_work_control", sql: migration003 },
  { version: 5, name: "005_scheduler", sql: migration005 },
];

function contract(goal: string, deps: string[] = []): TaskContract {
  return {
    version: 1,
    goal,
    context: `Context for ${goal}`,
    requirements: ["req-1"],
    acceptanceCriteria: ["ac-1"],
    dependencies: deps,
    nonGoals: [],
    definitionOfDone: ["done-1"],
  };
}

/**
 * Insert a task directly into the DB for testing.
 */
function insertTask(
  db: Database,
  projectId: string,
  overrides: Partial<{
    id: string;
    epicId: string | null;
    status: string;
    priority: string;
    category: string;
    dependencies: string[];
  }> = {},
): { id: string; projectId: string } {
  const id = overrides.id ?? randomUUID();
  const status = overrides.status ?? "READY";
  const now = new Date().toISOString();
  const c = {
    ...contract("test", overrides.dependencies ?? []),
    priority: overrides.priority ?? "Normal",
    category: overrides.category ?? "new-development",
  };

  db.transaction((tx) => {
    tx.run(
      `INSERT INTO tasks (id, project_id, epic_id, display_id, title, status, contract_json, required, created_at, updated_at, wait_reason)
       VALUES ($id, $project_id, $epic_id, $display_id, $title, $status, $contract_json, $required, $created_at, $updated_at, NULL)`,
      {
        id,
        project_id: projectId,
        epic_id: overrides.epicId ?? null,
        display_id: `TASK-${Math.floor(Math.random() * 100000)}`,
        title: c.goal,
        status,
        contract_json: JSON.stringify(c),
        required: 1,
        created_at: now,
        updated_at: now,
      },
    );
  });

  return { id, projectId };
}

describe("SchedulerService", () => {
  let db: Database | undefined;
  let tmpDir: string;
  let scheduler: SchedulerService;
  let projectId: string;

  beforeEach(() => {
    tmpDir = "";
    projectId = randomUUID();
  });

  afterEach(async () => {
    db?.close();
    db = undefined;
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  async function setupDb(): Promise<Database> {
    tmpDir = await mkdtemp(join(tmpdir(), "orch-scheduler-test-"));
    const dbPath = join(tmpDir, `test-${randomUUID()}.db`);
    const database = createSqliteDatabase(dbPath);
    runMigrations(database, migrations);
    return database;
  }

  async function setup(): Promise<void> {
    db = await setupDb();
    // Seed project
    const now = new Date().toISOString();
    db.transaction((tx) => {
      tx.run(
        `INSERT INTO projects (id, name, display_name, status, created_at, updated_at)
         VALUES ($id, $name, $display_name, $status, $created_at, $updated_at)`,
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
    scheduler = new SchedulerService(db);
  }

  //  Capacity tests ��

  it("allows up to 3 project concurrent tasks", async () => {
    await setup();
    for (let i = 0; i < 3; i++) {
      insertTask(db!, projectId, { id: `task-${i}`, status: "READY" });
    }
    const result = scheduler.recalculate();
    expect(result.runnables.length).toBe(3);
  });

  it("blocks 5th task due to global capacity", async () => {
    await setup();
    for (let i = 0; i < 5; i++) {
      insertTask(db!, projectId, { id: `task-${i}`, status: "READY" });
    }
    const result = scheduler.recalculate();
    // Should still be limited to 4 runnables
    expect(result.runnables.length).toBeLessThanOrEqual(4);
  });

  it("respects project max of 3", async () => {
    await setup();
    // Add 4 tasks to same project
    for (let i = 0; i < 4; i++) {
      insertTask(db!, projectId, { id: `task-${i}`, status: "READY" });
    }
    const result = scheduler.recalculate();
    // Even though global allows 4, project allows only 3
    expect(result.runnables.length).toBeLessThanOrEqual(3);
  });

  // �� Dependency tests ��

  it("waits for unresolved dependencies", async () => {
    await setup();
    const parent = insertTask(db!, projectId, { id: "parent", status: "READY" });
    const child = insertTask(db!, projectId, {
      id: "child",
      status: "READY",
      dependencies: [parent.id],
    });
    const result = scheduler.recalculate();
    const childTask = result.runnables.find((t) => t.id === child.id);
    expect(childTask).toBeUndefined();
    const childWaiting = result.waiting.find((w) => w.task.id === child.id);
    expect(childWaiting).toBeDefined();
    expect(childWaiting?.reason).toBe("WAITING_FOR_DEPENDENCY");
  });

  it("allows task when all dependencies are completed", async () => {
    await setup();
    const parent = insertTask(db!, projectId, { id: "parent", status: "DONE" });
    const child = insertTask(db!, projectId, {
      id: "child",
      status: "READY",
      dependencies: [parent.id],
    });
    const result = scheduler.recalculate();
    const childTask = result.runnables.find((t) => t.id === child.id);
    expect(childTask).toBeDefined();
  });

  // �� Deterministic ordering tests ��

  it("orders by category first (integration before new-development)", async () => {
    await setup();
    const _integrationTask = insertTask(db!, projectId, {
      id: "integration",
      status: "READY",
      priority: "Low",
      category: "integration",
    });
    const _newDevTask = insertTask(db!, projectId, {
      id: "newdev",
      status: "READY",
      priority: "Critical",
      category: "new-development",
    });
    const result = scheduler.recalculate();
    expect(result.runnables[0]!.id).toBe("integration");
    expect(result.runnables[1]!.id).toBe("newdev");
  });

  it("orders by priority when category is same", async () => {
    await setup();
    const _lowTask = insertTask(db!, projectId, {
      id: "low",
      status: "READY",
      priority: "Low",
    });
    const _highTask = insertTask(db!, projectId, {
      id: "high",
      status: "READY",
      priority: "High",
    });
    const result = scheduler.recalculate();
    expect(result.runnables[0]!.id).toBe("high");
    expect(result.runnables[1]!.id).toBe("low");
  });

  it("orders by creation time when category and priority match", async () => {
    await setup();
    const _olderTask = insertTask(db!, projectId, {
      id: "older",
      status: "READY",
    });
    const _newerTask = insertTask(db!, projectId, {
      id: "newer",
      status: "READY",
    });
    const result = scheduler.recalculate();
    expect(result.runnables[0]!.id).toBe("older");
    expect(result.runnables[1]!.id).toBe("newer");
  });

  it("produces deterministic ordering across multiple calls", async () => {
    await setup();
    insertTask(db!, projectId, { id: "task-a", status: "READY", priority: "Normal" });
    insertTask(db!, projectId, { id: "task-b", status: "READY", priority: "Critical" });
    insertTask(db!, projectId, { id: "task-c", status: "READY", priority: "High" });

    const result1 = scheduler.recalculate();
    const result2 = scheduler.recalculate();
    const result3 = scheduler.recalculate();

    expect(result1.runnables.map((t) => t.id)).toEqual(result2.runnables.map((t) => t.id));
    expect(result2.runnables.map((t) => t.id)).toEqual(result3.runnables.map((t) => t.id));
  });

  // �� Resource lock tests ��

  it("tracks resource lock status", async () => {
    await setup();
    const { id } = insertTask(db!, projectId, { status: "READY" });
    const locked = scheduler.resourceLockService.acquire(id, "owner");
    expect(locked).toBe(true);
    expect(scheduler.resourceLockService.isLocked(id)).toBe(true);
    scheduler.resourceLockService.release(id);
    expect(scheduler.resourceLockService.isLocked(id)).toBe(false);
  });

  // �� Scope tests ��

  it("filters by project scope", async () => {
    await setup();
    const projectB = randomUUID();
    // Seed projectB for FK constraint
    db!.transaction((tx) => {
      const now = new Date().toISOString();
      tx.run(
        "INSERT INTO projects (id, name, display_name, status, created_at, updated_at) VALUES ($id, $name, $display_name, $status, $created_at, $updated_at)",
        {
          id: projectB,
          name: "test-project-b",
          display_name: "Test Project B",
          status: "ACTIVE",
          created_at: now,
          updated_at: now,
        },
      );
    });
    insertTask(db!, projectId, { id: "task-a", status: "READY" });
    insertTask(db!, projectId, { id: "task-b", status: "READY" });
    insertTask(db!, projectB, { id: "task-c", status: "READY" });

    const scoped = scheduler.recalculate({ projectId });
    expect(scoped.runnables.length).toBe(2);
    expect(scoped.runnables.some((t) => t.id === "task-c")).toBe(false);
  });
});
