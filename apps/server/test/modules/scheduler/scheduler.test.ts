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
    expect(scheduler.resourceLockService.release(id)).toMatchObject({ status: "RELEASED" });
    expect(scheduler.resourceLockService.release(id)).toEqual({ status: "ALREADY_RELEASED" });
    expect(scheduler.resourceLockService.isLocked(id)).toBe(false);
  });

  it("uses one capacity authority for task and phase reservations", async () => {
    await setup();
    for (let i = 0; i < 3; i++) scheduler.dispatchAgentRun(`run-${i}`, projectId, "reviewer", "test");
    insertTask(db!, projectId, { id: "over-capacity", status: "READY" });
    const registry = { transitionInTransaction: () => undefined } as never;
    expect(() => scheduler.dispatchAgentRun("run-3", projectId, "qa", "test")).toThrow(/WAITING_FOR_CAPACITY/);
    expect(() => scheduler.dispatchTask("over-capacity", registry, () => undefined)).toThrow(/WAITING_FOR_CAPACITY/);
  });

  it("releases an AgentRun reservation idempotently", async () => {
    await setup();
    db!.exec("CREATE TABLE agent_runs (id TEXT PRIMARY KEY, role TEXT NOT NULL, runtime TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL, cost REAL)");
    db!.run("INSERT INTO scheduler_budgets (project_id,limit_cost,spent_cost,reserved_cost) VALUES ($projectId,100,0,0)", { projectId });
    scheduler.dispatchAgentRun("duplicate-run", projectId, "reviewer", "test");
    db!.run("INSERT INTO agent_runs (id,role,runtime,model,status) VALUES ('duplicate-run','reviewer','test','test','STARTED')");
    expect(scheduler.releaseAgentRun("duplicate-run", 2)).toMatchObject({ status: "RELEASED" });
    expect(scheduler.releaseAgentRun("duplicate-run", 99)).toEqual({ status: "ALREADY_RELEASED" });
    expect(db!.get<{ spent_cost: number }>("SELECT spent_cost FROM scheduler_budgets WHERE project_id=$projectId", { projectId })?.spent_cost).toBe(2);
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduler_usage_history WHERE project_id=$projectId", { projectId })?.count).toBe(1);
  });

  it("fails closed when a reserved phase subject collides with another run identity", async () => {
    await setup();
    db!.run(
      "INSERT INTO scheduler_reservations(id,kind,subject_id,project_id,owner_id,reserved_at,status,role,model,run_id) VALUES('collision','PHASE','run-collision',$projectId,'run:run-collision',$at,'RESERVED','reviewer','test',$otherRun)",
      { projectId, at: new Date().toISOString(), otherRun: "other-run" },
    );

    expect(() => scheduler.dispatchAgentRun("run-collision", projectId, "reviewer", "test")).toThrow(/run identity mismatch/);
    expect(db!.get<{ run_id: string }>("SELECT run_id FROM scheduler_reservations WHERE id='collision'")?.run_id).toBe("other-run");

    db!.run("UPDATE scheduler_reservations SET run_id=NULL WHERE id='collision'");
    expect(() => scheduler.dispatchAgentRun("run-collision", projectId, "reviewer", "test")).toThrow(/found NULL/);
  });

  it("releases a task reservation when failure cleanup is addressed by AgentRun id", async () => {
    await setup();
    db!.exec("CREATE TABLE agent_runs (id TEXT PRIMARY KEY, role TEXT NOT NULL, runtime TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL, task_id TEXT, cost REAL, started_at TEXT)");
    db!.run("INSERT INTO scheduler_budgets (project_id,limit_cost,spent_cost,reserved_cost) VALUES ($projectId,100,0,0)", { projectId });
    const taskId = insertTask(db!, projectId, { id: "failed-task", status: "READY" }).id;
    db!.run("INSERT INTO agent_runs (id,role,runtime,model,status,task_id,started_at) VALUES ('failed-run','developer','test','test','STARTED',$taskId,$at)", { taskId, at: new Date().toISOString() });
    const registry = { transitionInTransaction: () => undefined } as never;
    scheduler.dispatchTask(taskId, registry, () => undefined, { runId: "failed-run" });

    scheduler.releaseAgentRun("failed-run", 0);
    scheduler.releaseAgentRun("failed-run", 99);

    expect(db!.get<{ status: string }>("SELECT status FROM scheduler_reservations WHERE subject_id=$taskId", { taskId })?.status).toBe("RELEASED");
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduler_resource_locks WHERE reservation_id IN (SELECT id FROM scheduler_reservations WHERE subject_id=$taskId)", { taskId })?.count).toBe(0);
    expect(db!.get<{ reserved_cost: number }>("SELECT reserved_cost FROM scheduler_budgets WHERE project_id=$projectId", { projectId })?.reserved_cost).toBe(0);
  });

  it("fails closed when a retry encounters a reservation owned by another AgentRun", async () => {
    await setup();
    const taskId = insertTask(db!, projectId, { id: "retry-task", status: "READY" }).id;
    const registry = { transitionInTransaction: () => undefined } as never;

    scheduler.dispatchTask(taskId, registry, () => undefined, { runId: "failed-run" });
    expect(db!.get<{ run_id: string | null }>("SELECT run_id FROM scheduler_reservations WHERE subject_id=$taskId", { taskId })?.run_id).toBe("failed-run");

    db!.run("UPDATE scheduler_reservations SET run_id=NULL WHERE subject_id=$taskId", { taskId });
    expect(() => scheduler.dispatchTask(taskId, registry, () => undefined, { runId: "retry-run" })).toThrow(/found NULL/);
    expect(db!.get<{ run_id: string | null }>("SELECT run_id FROM scheduler_reservations WHERE subject_id=$taskId", { taskId })?.run_id).toBeNull();
    db!.run("UPDATE scheduler_reservations SET run_id='failed-run' WHERE subject_id=$taskId", { taskId });

    expect(() => scheduler.dispatchTask(taskId, registry, () => undefined, { runId: "retry-run" })).toThrow(/run identity mismatch/);
    expect(db!.get<{ run_id: string | null }>("SELECT run_id FROM scheduler_reservations WHERE subject_id=$taskId", { taskId })?.run_id).toBe("failed-run");

    expect(scheduler.releaseAgentRun("failed-run", 0)).toMatchObject({ status: "RELEASED" });
    scheduler.dispatchTask(taskId, registry, () => undefined, { runId: "retry-run" });
    expect(db!.get<{ run_id: string | null }>("SELECT run_id FROM scheduler_reservations WHERE subject_id=$taskId", { taskId })?.run_id).toBe("retry-run");
    expect(scheduler.releaseAgentRun("retry-run", 0)).toMatchObject({ status: "RELEASED" });
  });

  it("applies phase locks through the same lock authority", async () => {
    await setup();
    scheduler.dispatchAgentRun("locked-1", projectId, "reviewer", "test", "shared-resource");
    expect(() => scheduler.dispatchAgentRun("locked-2", projectId, "qa", "test", "shared-resource")).toThrow(/WAITING_FOR_RESOURCE_LOCK/);
  });

  it("reconciles run-owned locks from AgentRun and reservation state", async () => {
    await setup();
    db!.exec("CREATE TABLE agent_runs (id TEXT PRIMARY KEY, role TEXT NOT NULL, runtime TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL, cost REAL)");
    db!.run("INSERT INTO scheduler_budgets (project_id,limit_cost,spent_cost,reserved_cost) VALUES ($projectId,100,0,0)", { projectId });
    db!.run("INSERT INTO agent_runs (id,role,runtime,model,status,cost) VALUES ('stale-run','reviewer','test','test','FAILED',0)");
    scheduler.dispatchAgentRun("stale-run", projectId, "reviewer", "test");
    const reservationId = db!.get<{ id: string }>("SELECT id FROM scheduler_reservations WHERE subject_id='stale-run'")!.id;
    db!.run("INSERT INTO scheduler_resource_locks(resource_key,reservation_id,project_id,owner_id,locked_at) VALUES('stale-run-secondary',$reservationId,$projectId,'run:stale-run',$at)", { reservationId, projectId, at: new Date().toISOString() });

    expect(scheduler.resourceLockService.reconcileDeadOwners()).toEqual({ releasedReservationIds: [reservationId], blockedReservationIds: [] });

    expect(db!.get<{ status: string }>("SELECT status FROM scheduler_reservations WHERE subject_id='stale-run'")?.status).toBe("RELEASED");
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduler_resource_locks WHERE owner_id='run:stale-run'")?.count).toBe(0);
    expect(db!.get<{ reserved_cost: number }>("SELECT reserved_cost FROM scheduler_budgets WHERE project_id=$projectId", { projectId })?.reserved_cost).toBe(0);
  });

  it("blocks reconciliation when the exact reserved run is missing instead of using task_id", async () => {
    await setup();
    db!.exec("CREATE TABLE agent_runs (id TEXT PRIMARY KEY, role TEXT NOT NULL, runtime TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL, task_id TEXT, cost REAL)");
    const reservationId = "identity-collision-reservation";
    db!.run(
      "INSERT INTO agent_runs (id,role,runtime,model,status,task_id,cost) VALUES ('unrelated-run','reviewer','test','test','COMPLETED','phase-subject',2)",
    );
    db!.run(
      "INSERT INTO scheduler_reservations(id,kind,subject_id,project_id,owner_id,reserved_at,status,role,model,run_id) VALUES($id,'PHASE','phase-subject',$projectId,'run:expected-run',$at,'RESERVED','reviewer','test','expected-run')",
      { id: reservationId, projectId, at: new Date().toISOString() },
    );
    db!.run(
      "INSERT INTO scheduler_resource_locks(resource_key,reservation_id,project_id,owner_id,locked_at) VALUES('phase-subject-resource',$id,$projectId,'run:expected-run',$at)",
      { id: reservationId, projectId, at: new Date().toISOString() },
    );

    expect(scheduler.reconcile()).toEqual({ releasedReservationIds: [], blockedReservationIds: [reservationId] });
    expect(db!.get<{ status: string }>("SELECT status FROM scheduler_reservations WHERE id=$id", { id: reservationId })?.status).toBe("RESERVED");
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduler_resource_locks WHERE reservation_id=$id", { id: reservationId })?.count).toBe(1);
  });

  it("blocks reconciliation when a reservation has no run identity", async () => {
    await setup();
    db!.exec("CREATE TABLE agent_runs (id TEXT PRIMARY KEY, role TEXT NOT NULL, runtime TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL, task_id TEXT, cost REAL)");
    const reservationId = "null-run-id-reservation";
    db!.run(
      "INSERT INTO scheduler_reservations(id,kind,subject_id,project_id,owner_id,reserved_at,status,role,model,run_id) VALUES($id,'PHASE','phase-without-run',$projectId,'run:phase-without-run',$at,'RESERVED','reviewer','test',NULL)",
      { id: reservationId, projectId, at: new Date().toISOString() },
    );
    db!.run(
      "INSERT INTO scheduler_resource_locks(resource_key,reservation_id,project_id,owner_id,locked_at) VALUES('phase-without-run-resource',$id,$projectId,'run:phase-without-run',$at)",
      { id: reservationId, projectId, at: new Date().toISOString() },
    );

    expect(scheduler.reconcile()).toEqual({ releasedReservationIds: [], blockedReservationIds: [reservationId] });
  });

  it("does not release a live run lock as if it were a task lock", async () => {
    await setup();
    db!.exec("CREATE TABLE agent_runs (id TEXT PRIMARY KEY, role TEXT NOT NULL, runtime TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL, cost REAL)");
    db!.run("INSERT INTO agent_runs (id,role,runtime,model,status,cost) VALUES ('live-run','reviewer','test','test','STARTED',0)");
    scheduler.dispatchAgentRun("live-run", projectId, "reviewer", "test");

    scheduler.resourceLockService.reconcileDeadOwners();

    expect(db!.get<{ status: string }>("SELECT status FROM scheduler_reservations WHERE subject_id='live-run'")?.status).toBe("RESERVED");
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduler_resource_locks WHERE owner_id='run:live-run'")?.count).toBe(1);
  });

  it("preserves an active task LOCK reservation across scheduler restart reconciliation", async () => {
    await setup();
    db!.exec("CREATE TABLE agent_runs (id TEXT PRIMARY KEY, role TEXT NOT NULL, runtime TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL, cost REAL)");
    const taskId = insertTask(db!, projectId, { id: "active-locked-task", status: "DEVELOPMENT" }).id;
    expect(scheduler.resourceLockService.acquire(taskId, "owner")).toBe(true);

    scheduler.reconcile();
    scheduler.reconcile();

    expect(db!.get<{ status: string }>("SELECT status FROM scheduler_reservations WHERE subject_id=$subject", { subject: `lock:${taskId}` })?.status).toBe("RESERVED");
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduler_resource_locks WHERE owner_id=$owner", { owner: `task:${taskId}` })?.count).toBe(1);
  });

  it("preserves a run lock and reservation when the lock owner does not match", async () => {
    await setup();
    db!.exec("CREATE TABLE agent_runs (id TEXT PRIMARY KEY, role TEXT NOT NULL, runtime TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL, cost REAL)");
    db!.run("INSERT INTO scheduler_budgets (project_id,limit_cost,spent_cost,reserved_cost) VALUES ($projectId,100,0,0)", { projectId });
    db!.run("INSERT INTO agent_runs (id,role,runtime,model,status,cost) VALUES ('authoritative-run','reviewer','test','test','STARTED',0)");
    scheduler.dispatchAgentRun("authoritative-run", projectId, "reviewer", "test", "shared-resource");
    db!.run("UPDATE scheduler_resource_locks SET owner_id='run:other-run' WHERE resource_key='shared-resource'");

    scheduler.resourceLockService.reconcileDeadOwners();
    scheduler.resourceLockService.reconcileDeadOwners();

    expect(db!.get<{ status: string }>("SELECT status FROM scheduler_reservations WHERE subject_id='authoritative-run'")?.status).toBe("RESERVED");
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduler_resource_locks WHERE resource_key='shared-resource'")?.count).toBe(1);
    expect(db!.get<{ reserved_cost: number }>("SELECT reserved_cost FROM scheduler_budgets WHERE project_id=$projectId", { projectId })?.reserved_cost).toBe(1);
  });

  it("blocks terminal-run reconciliation on durable lock ownership drift", async () => {
    await setup();
    db!.exec("CREATE TABLE agent_runs (id TEXT PRIMARY KEY, role TEXT NOT NULL, runtime TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL, task_id TEXT, cost REAL, started_at TEXT)");
    db!.run("INSERT INTO scheduler_budgets (project_id,limit_cost,spent_cost,reserved_cost) VALUES ($projectId,100,0,0)", { projectId });
    db!.run("INSERT INTO agent_runs (id,role,runtime,model,status,cost) VALUES ('run-a','reviewer','test','test','COMPLETED',2)");
    scheduler.dispatchAgentRun("run-a", projectId, "reviewer", "test", "run-a-resource");
    const reservationId = db!.get<{ id: string }>("SELECT id FROM scheduler_reservations WHERE subject_id='run-a'")!.id;
    db!.run("INSERT INTO scheduler_resource_locks(resource_key,reservation_id,project_id,owner_id,locked_at) VALUES('run-a-secondary',$reservationId,$projectId,'run:run-b',$at)", { reservationId, projectId, at: new Date().toISOString() });

    expect(scheduler.reconcile()).toEqual({ releasedReservationIds: [], blockedReservationIds: [reservationId] });
    expect(db!.get<{ status: string }>("SELECT status FROM scheduler_reservations WHERE subject_id='run-a'")?.status).toBe("RESERVED");
    expect(db!.get<{ owner_id: string }>("SELECT owner_id FROM scheduler_resource_locks WHERE resource_key='run-a-secondary'")?.owner_id).toBe("run:run-b");
    expect(db!.get<{ reserved_cost: number }>("SELECT reserved_cost FROM scheduler_budgets WHERE project_id=$projectId", { projectId })?.reserved_cost).toBe(1);
  });

  it("blocks AgentRun release on durable lock ownership drift", async () => {
    await setup();
    db!.run("INSERT INTO scheduler_budgets (project_id,limit_cost,spent_cost,reserved_cost) VALUES ($projectId,100,0,0)", { projectId });
    scheduler.dispatchAgentRun("run-a", projectId, "reviewer", "test", "run-a-resource");
    const reservationId = db!.get<{ id: string }>("SELECT id FROM scheduler_reservations WHERE subject_id='run-a'")!.id;
    db!.run("INSERT INTO scheduler_resource_locks(resource_key,reservation_id,project_id,owner_id,locked_at) VALUES('run-a-secondary',$reservationId,$projectId,'run:run-b',$at)", { reservationId, projectId, at: new Date().toISOString() });

    expect(scheduler.releaseAgentRun("run-a", 2)).toMatchObject({ status: "BLOCKED_OWNERSHIP_DRIFT" });
    expect(db!.get<{ status: string }>("SELECT status FROM scheduler_reservations WHERE subject_id='run-a'")?.status).toBe("RESERVED");
    expect(db!.get<{ reserved_cost: number }>("SELECT reserved_cost FROM scheduler_budgets WHERE project_id=$projectId", { projectId })?.reserved_cost).toBe(1);
  });

  it("blocks task release on durable lock ownership drift", async () => {
    await setup();
    db!.run("INSERT INTO scheduler_budgets (project_id,limit_cost,spent_cost,reserved_cost) VALUES ($projectId,100,0,0)", { projectId });
    const taskId = insertTask(db!, projectId, { id: "task-a", status: "READY" }).id;
    const registry = { transitionInTransaction: () => undefined } as never;
    scheduler.dispatchTask(taskId, registry, () => undefined);
    const reservationId = db!.get<{ id: string }>("SELECT id FROM scheduler_reservations WHERE subject_id=$taskId", { taskId })!.id;
    db!.run("INSERT INTO scheduler_resource_locks(resource_key,reservation_id,project_id,owner_id,locked_at) VALUES('task-a-secondary',$reservationId,$projectId,'run:run-b',$at)", { reservationId, projectId, at: new Date().toISOString() });

    expect(scheduler.releaseTask(taskId, 2)).toMatchObject({ status: "BLOCKED_OWNERSHIP_DRIFT" });
    expect(db!.get<{ status: string }>("SELECT status FROM scheduler_reservations WHERE subject_id=$taskId", { taskId })?.status).toBe("RESERVED");
    expect(db!.get<{ reserved_cost: number }>("SELECT reserved_cost FROM scheduler_budgets WHERE project_id=$projectId", { projectId })?.reserved_cost).toBe(1);
  });

  it("blocks task-lock release on durable lock ownership drift", async () => {
    await setup();
    const taskId = insertTask(db!, projectId, { id: "task-a", status: "READY" }).id;
    expect(scheduler.resourceLockService.acquire(taskId, "owner")).toBe(true);
    const reservationId = db!.get<{ id: string }>("SELECT id FROM scheduler_reservations WHERE subject_id=$subject", { subject: `lock:${taskId}` })!.id;
    db!.run("INSERT INTO scheduler_resource_locks(resource_key,reservation_id,project_id,owner_id,locked_at) VALUES('task-a-secondary',$reservationId,$projectId,'task:task-b',$at)", { reservationId, projectId, at: new Date().toISOString() });

    expect(scheduler.resourceLockService.release(taskId)).toMatchObject({ status: "BLOCKED_OWNERSHIP_DRIFT" });
    expect(db!.get<{ status: string }>("SELECT status FROM scheduler_reservations WHERE subject_id=$subject", { subject: `lock:${taskId}` })?.status).toBe("RESERVED");
    expect(db!.get<{ owner_id: string }>("SELECT owner_id FROM scheduler_resource_locks WHERE resource_key='task-a-secondary'")?.owner_id).toBe("task:task-b");
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
