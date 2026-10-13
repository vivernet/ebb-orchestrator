import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../../helpers/migrations.js";
import type { Database } from "../../../src/platform/database/database.js";
import { SchedulerSafetyWorker, SchedulerService } from "../../../src/modules/scheduler/scheduler-service.js";
import { agedPriority } from "../../../src/modules/scheduler/scheduler-policy.js";
import { WorkflowEngine } from "../../../src/modules/workflow/workflow-engine.js";
import { WorkflowRegistry } from "../../../src/modules/workflow/workflow-registry.js";
import { standard } from "../../../src/modules/workflow/templates.js";
import type { TaskContract } from "../../../src/modules/work/work-types.js";

const migrations = loadTestMigrations();

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
 * Напрямую добавляет задачу в БД для теста.
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
    for (const dependsOnTaskId of overrides.dependencies ?? []) {
      tx.run("INSERT INTO dependencies(id,task_id,depends_on_task_id,type,created_at) VALUES($id,$taskId,$dependsOnTaskId,'BLOCKING',$at)", {
        id: randomUUID(), taskId: id, dependsOnTaskId, at: now,
      });
    }
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

  it("ages only at full UTC day boundaries, clamps Critical, and rejects malformed timestamps", () => {
    const now = new Date("2026-10-14T12:00:00.000Z");
    expect(agedPriority("Low", "2026-10-13T12:00:00.001Z", now)).toBe("Low");
    expect(agedPriority("Low", "2026-10-13T12:00:00.000Z", now)).toBe("Normal");
    expect(agedPriority("Low", "2026-10-12T12:00:00.000Z", now)).toBe("High");
    expect(agedPriority("Low", "2026-10-11T12:00:00.000Z", now)).toBe("Critical");
    expect(agedPriority("Low", "2026-10-10T12:00:00.000Z", now)).toBe("Critical");
    expect(agedPriority("Critical", "2020-01-01T00:00:00.000Z", now)).toBe("Critical");
    expect(agedPriority("Low", "2026-10-15T12:00:00.000Z", now)).toBe("Low");
    expect(() => agedPriority("Low", "not-a-timestamp", now)).toThrow(/invalid capacity_wait_started_at/);
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
// Заполняем project.
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
      const approvalId = randomUUID();
      tx.run("INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,created_at) VALUES($approvalId,'WORKFLOW_CHANGE',$id,'PROJECT','APPROVED','test',$now)", { approvalId, id: projectId, now });
      tx.run("INSERT INTO onboarding_configs(project_id,repository_path,facts_json,proposed_json,status,approval_id,created_at,updated_at) VALUES($id,'/tmp','{}','{}','ACTIVE',$approvalId,$now,$now)", { id: projectId, approvalId, now });
    });
    scheduler = new SchedulerService(db);
  }

  //  Тесты capacity ��

  it("does not dispatch or reserve when onboarding_configs is absent", async () => {
    await setup();
    const task = insertTask(db!, projectId, { id: "missing-onboarding", status: "READY" });
    db!.exec("DROP TABLE onboarding_configs");

    expect(() => scheduler.dispatchTask(task.id, {} as never, vi.fn())).toThrow("ONBOARDING_NOT_ACTIVE");
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduler_reservations WHERE subject_id=$taskId", { taskId: task.id })?.count).toBe(0);
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduler_resource_locks WHERE owner_id=$ownerId", { ownerId: `task:${task.id}` })?.count).toBe(0);
  });

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
// Число доступных задач по-прежнему должно быть ограничено четырьмя.
    expect(result.runnables.length).toBeLessThanOrEqual(4);
  });

  it("respects project max of 3", async () => {
    await setup();
// Добавляем четыре задачи в один project.
    for (let i = 0; i < 4; i++) {
      insertTask(db!, projectId, { id: `task-${i}`, status: "READY" });
    }
    const result = scheduler.recalculate();
// Хотя глобальный лимит равен 4, для project разрешены только 3.
    expect(result.runnables.length).toBeLessThanOrEqual(3);
  });

  it("reports a concrete capacity reason for READY tasks beyond capacity", async () => {
    await setup();
    for (let i = 0; i < 4; i++) insertTask(db!, projectId, { id: `capacity-${i}`, status: "READY" });

    const result = scheduler.recalculate();
    expect(result.waiting.find((entry) => entry.task.id === "capacity-3")?.reason).toBe("WAITING_FOR_CAPACITY");
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

  it("uses durable capacity wait aging after category and before the critical path", async () => {
    await setup();
    const now = "2026-10-14T12:00:00.000Z";
    const schedulerWithClock = new SchedulerService(db!, () => new Date(now));
    insertTask(db!, projectId, { id: "fresh-high", status: "READY", priority: "High" });
    insertTask(db!, projectId, { id: "aged-low", status: "READY", priority: "Low" });
    db!.run("UPDATE tasks SET capacity_wait_started_at=$at WHERE id='aged-low'", { at: "2026-10-11T12:00:00.000Z" });

    expect(schedulerWithClock.recalculate().runnables.map(({ id }) => id)).toEqual(["aged-low", "fresh-high"]);
  });

  it("scores the normalized blocking graph, including the longest unfinished branch, regardless of contract_json", async () => {
    await setup();
    insertTask(db!, projectId, { id: "path-short" });
    insertTask(db!, projectId, { id: "path-root" });
    insertTask(db!, projectId, { id: "branch-a", dependencies: ["path-root"] });
    insertTask(db!, projectId, { id: "branch-b", dependencies: ["path-root"] });
    insertTask(db!, projectId, { id: "branch-b-leaf", dependencies: ["branch-b"] });
    db!.run("UPDATE tasks SET contract_json=json_set(contract_json,'$.dependencies',json('[]')) WHERE id IN ('branch-a','branch-b','branch-b-leaf')");

    const result = scheduler.recalculate();
    expect(result.runnables.map(({ id }) => id).slice(0, 2)).toEqual(["path-root", "path-short"]);
    expect(result.runnables[0]?.criticalPathLength).toBe(3);
    expect(result.runnables[1]?.criticalPathLength).toBe(1);

    insertTask(db!, projectId, { id: "terminal-root" });
    insertTask(db!, projectId, { id: "terminal-middle", status: "DONE", dependencies: ["terminal-root"] });
    insertTask(db!, projectId, { id: "unfinished-after-terminal", dependencies: ["terminal-middle"] });
    expect(scheduler.recalculate().runnables.find(({ id }) => id === "terminal-root")?.criticalPathLength).toBe(1);
  });

  it("blocks all dispatch selection on a persisted cycle, including a disconnected runnable task", async () => {
    await setup();
    insertTask(db!, projectId, { id: "cycle-a" });
    insertTask(db!, projectId, { id: "cycle-b" });
    insertTask(db!, projectId, { id: "otherwise-runnable" });
    db!.run("INSERT INTO dependencies(id,task_id,depends_on_task_id,type,created_at) VALUES('cycle-edge-a','cycle-a','cycle-b','BLOCKING',$at),('cycle-edge-b','cycle-b','cycle-a','BLOCKING',$at)", { at: new Date().toISOString() });

    expect(() => scheduler.recalculate()).toThrow(/dependency graph cycle detected/);
    expect(() => scheduler.dispatchTask("otherwise-runnable", { transitionInTransaction: () => undefined } as never, () => undefined)).toThrow(/dependency graph cycle detected/);
    expect(() => scheduler.reconcile()).toThrow(/dependency graph cycle detected/);
    expect(db!.get("SELECT COUNT(*) AS count FROM scheduler_reservations WHERE status='RESERVED'")).toEqual({ count: 0 });
    expect(db!.get("SELECT status FROM tasks WHERE id='otherwise-runnable'")).toEqual({ status: "READY" });
  });

  it("uses path only after equal aged priority and keeps category and ordinal id ahead of insertion order", async () => {
    await setup();
    const fixedClockScheduler = new SchedulerService(db!, () => new Date("2026-10-14T12:00:00.000Z"));
    insertTask(db!, projectId, { id: "z-prerequisite", priority: "Normal" });
    insertTask(db!, projectId, { id: "a-prerequisite", priority: "Low" });
    insertTask(db!, projectId, { id: "dependent-long", priority: "Normal", dependencies: ["z-prerequisite"] });
    db!.run("UPDATE tasks SET capacity_wait_started_at='2026-10-13T12:00:00.000Z' WHERE id='a-prerequisite'");
    db!.run("UPDATE tasks SET created_at='2026-10-10T00:00:00.000Z' WHERE id IN ('z-prerequisite','a-prerequisite','dependent-long')");
    const ordered = fixedClockScheduler.recalculate().runnables.map(({ id }) => id);
    expect(ordered.slice(0, 2)).toEqual(["z-prerequisite", "a-prerequisite"]);

    db!.run("UPDATE tasks SET contract_json=json_set(contract_json,'$.category','new-development','$.priority','Critical') WHERE id='dependent-long'");
    db!.run("UPDATE tasks SET contract_json=json_set(contract_json,'$.category','integration','$.priority','Low') WHERE id='z-prerequisite'");
    expect(fixedClockScheduler.recalculate().runnables[0]?.id).toBe("z-prerequisite");
  });

  it("fails closed for a malformed persisted aging timestamp", async () => {
    await setup();
    insertTask(db!, projectId, { id: "malformed-aging" });
    db!.run("UPDATE tasks SET capacity_wait_started_at='yesterday-ish' WHERE id='malformed-aging'");
    expect(() => scheduler.recalculate()).toThrow(/invalid capacity_wait_started_at/);
  });

  it("uses ordinal task id for exact ties regardless of insertion order", async () => {
    await setup();
    const insertTiedTasks = (ids: string[]) => {
      for (const id of ids) insertTask(db!, projectId, { id });
      db!.run("UPDATE tasks SET created_at='2026-10-10T00:00:00.000Z' WHERE id IN ('tie-a','tie-z')");
      return scheduler.recalculate().runnables.map(({ id }) => id);
    };
    const forward = insertTiedTasks(["tie-z", "tie-a"]);
    db!.run("DELETE FROM tasks WHERE id IN ('tie-z','tie-a')");
    const reverse = insertTiedTasks(["tie-a", "tie-z"]);
    expect(forward).toEqual(["tie-a", "tie-z"]);
    expect(reverse).toEqual(forward);
  });

  it("produces identical ordered IDs and persisted reservations in reversed independent fixtures", async () => {
    const runFixture = async (insertionOrder: string[]) => {
      await setup();
      for (const id of insertionOrder) insertTask(db!, projectId, { id });
      db!.run("UPDATE tasks SET created_at='2026-10-10T00:00:00.000Z' WHERE id IN ('fixture-a','fixture-b','fixture-c')");
      const registry = new WorkflowRegistry();
      registry.register(standard);
      const result = scheduler.startWorkflowRuns(new WorkflowEngine(db!, registry), () => undefined);
      const reservations = db!.all<{ seq: number; subject_id: string; role: string; status: string }>(
        "SELECT rowid AS seq,subject_id,role,status FROM scheduler_reservations WHERE status='RESERVED' AND kind='TASK' ORDER BY rowid",
      );
      const fixture = { startedTaskIds: result.startedTaskIds, reservations };
      const originalDb = db!;
      originalDb.close();
      db = undefined;
      await rm(tmpDir, { recursive: true, force: true });
      tmpDir = "";
      return fixture;
    };

    const first = await runFixture(["fixture-c", "fixture-a", "fixture-b"]);
    const second = await runFixture(["fixture-b", "fixture-c", "fixture-a"]);
    expect(first.startedTaskIds).toEqual(["fixture-a", "fixture-b", "fixture-c"]);
    expect(second.startedTaskIds).toEqual(first.startedTaskIds);
    expect(first.reservations.map(({ seq, subject_id, role, status }) => ({ seq, subject_id, role, status })))
      .toEqual(second.reservations.map(({ seq, subject_id, role, status }) => ({ seq, subject_id, role, status })));
  });

  it("starts capacity aging only after non-capacity gates pass and preserves the durable UTC instant", async () => {
    await setup();
    let instant = "2026-10-14T12:00:00.000Z";
    let clocked = new SchedulerService(db!, () => new Date(instant));
    const roleCapacity = Object.fromEntries(SchedulerService.ALL_ROLES.map((role) => [role, 4]));
    db!.run("UPDATE scheduler_config SET config_json=$config WHERE id=1", { config: JSON.stringify({ globalMax: 4, projectMax: 10, roleCapacity }) });
    const transition = { transitionInTransaction: () => undefined } as never;
    for (let index = 0; index < 4; index++) {
      insertTask(db!, projectId, { id: `holder-${index}`, status: "READY" });
      clocked.dispatchTask(`holder-${index}`, transition, () => undefined);
      db!.run("UPDATE tasks SET status='DEVELOPMENT' WHERE id=$id", { id: `holder-${index}` });
    }
    insertTask(db!, projectId, { id: "capacity-waiter", status: "READY" });
    db!.run("UPDATE tasks SET created_at='2020-01-01T00:00:00.000Z' WHERE id='capacity-waiter'");
    db!.run("INSERT INTO scheduler_budgets(project_id,limit_cost,spent_cost,reserved_cost) VALUES($projectId,1,1,0)", { projectId });
    clocked.reconcile();
    expect(db!.get("SELECT capacity_wait_started_at FROM tasks WHERE id='capacity-waiter'")).toEqual({ capacity_wait_started_at: null });

    db!.run("DELETE FROM scheduler_budgets WHERE project_id=$projectId", { projectId });
    instant = "2026-10-14T13:00:00.000Z";
    clocked.reconcile();
    expect(db!.get("SELECT capacity_wait_started_at FROM tasks WHERE id='capacity-waiter'")).toEqual({ capacity_wait_started_at: instant });
    db!.run("UPDATE scheduler_config SET config_json=$config WHERE id=1", { config: JSON.stringify({ globalMax: 10, projectMax: 10, roleCapacity }) });
    instant = "2026-10-14T14:00:00.000Z";
    clocked.reconcile();
    expect(db!.get("SELECT capacity_wait_started_at FROM tasks WHERE id='capacity-waiter'")).toEqual({ capacity_wait_started_at: "2026-10-14T13:00:00.000Z" });

    const databasePath = db!.get<{ file: string }>("PRAGMA database_list")?.file;
    expect(databasePath).toBeTruthy();
    db!.close();
    db = createSqliteDatabase(databasePath!);
    clocked = new SchedulerService(db!, () => new Date(instant));
    clocked.reconcile();
    expect(db!.get("SELECT capacity_wait_started_at FROM tasks WHERE id='capacity-waiter'")).toEqual({ capacity_wait_started_at: "2026-10-14T13:00:00.000Z" });
    expect(clocked.getEligibility("capacity-waiter")).toEqual({ status: "WAIT", reason: "WAITING_FOR_ROLE_CAPACITY" });
    expect(clocked.getWaitReason("capacity-waiter")).toBe("WAITING_FOR_ROLE_CAPACITY");
    expect(clocked.recalculate().waiting.some(({ task }) => task.id === "capacity-waiter")).toBe(true);
    expect(db!.get("SELECT capacity_wait_started_at FROM tasks WHERE id='capacity-waiter'")).toEqual({ capacity_wait_started_at: "2026-10-14T13:00:00.000Z" });

    clocked.releaseTask("holder-0");
    clocked.reconcile();
    expect(db!.get("SELECT capacity_wait_started_at FROM tasks WHERE id='capacity-waiter'")).toEqual({ capacity_wait_started_at: "2026-10-14T13:00:00.000Z" });
    insertTask(db!, projectId, { id: "fresh-high", priority: "High" });
    instant = "2026-10-17T13:00:00.000Z";
    clocked.reconcile();
    expect(clocked.recalculate().runnables.map(({ id }) => id).slice(0, 2)).toEqual(["capacity-waiter", "fresh-high"]);
    db!.run("DELETE FROM tasks WHERE id='fresh-high'");
    const registry = new WorkflowRegistry();
    registry.register(standard);
    const workflow = new WorkflowEngine(db!, registry);
    expect(() => clocked.dispatchTask("capacity-waiter", { transitionInTransaction: () => { throw new Error("transition rejected"); } } as never, () => undefined)).toThrow(/transition rejected/);
    expect(db!.get("SELECT capacity_wait_started_at FROM tasks WHERE id='capacity-waiter'")).toEqual({ capacity_wait_started_at: "2026-10-14T13:00:00.000Z" });
    expect(db!.get("SELECT COUNT(*) AS count FROM scheduler_reservations WHERE subject_id='capacity-waiter' AND status='RESERVED'")).toEqual({ count: 0 });
    clocked.dispatchTask("capacity-waiter", workflow, () => undefined);
    expect(db!.get("SELECT capacity_wait_started_at FROM tasks WHERE id='capacity-waiter'")).toEqual({ capacity_wait_started_at: null });
    expect(db!.get("SELECT status FROM tasks WHERE id='capacity-waiter'")).toEqual({ status: "DEVELOPMENT" });
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

  it("uses the durable resource lock in both projection and dispatch", async () => {
    await setup();
    insertTask(db!, projectId, { id: "lock-owner", status: "READY" });
    insertTask(db!, projectId, { id: "lock-waiter", status: "READY" });
    expect(scheduler.resourceLockService.acquire("lock-owner", "owner")).toBe(true);
    expect(scheduler.getEligibility("lock-waiter")).toEqual({ status: "WAIT", reason: "WAITING_FOR_RESOURCE_LOCK" });
    const registry = { transitionInTransaction: () => undefined } as never;
    expect(() => scheduler.dispatchTask("lock-waiter", registry, () => undefined)).toThrow(/WAITING_FOR_RESOURCE_LOCK/);
  });

  it("uses the durable budget in both projection and dispatch", async () => {
    await setup();
    insertTask(db!, projectId, { id: "budget-task", status: "READY" });
    db!.run("INSERT INTO scheduler_budgets (project_id,limit_cost,spent_cost,reserved_cost) VALUES ($projectId,1,1,0)", { projectId });
    expect(scheduler.getEligibility("budget-task")).toEqual({ status: "WAIT", reason: "WAITING_FOR_BUDGET" });
    const registry = { transitionInTransaction: () => undefined } as never;
    expect(() => scheduler.dispatchTask("budget-task", registry, () => undefined)).toThrow(/WAITING_FOR_BUDGET/);
  });

  it("reports a paused task as waiting with an explicit pause reason", async () => {
    await setup();
    insertTask(db!, projectId, { id: "paused-task", status: "PAUSED" });

    expect(scheduler.getEligibility("paused-task")).toEqual({ status: "WAIT", reason: "WAITING_FOR_PAUSE" });
  });

  it("reads configurable limits from persisted system state", async () => {
    await setup();
    db!.run("INSERT INTO system_state(key,value_json,updated_at) VALUES ('scheduler_limits',$value,$at)", { value: JSON.stringify({ globalMax: 2, projectMax: 1, reviewerMax: 2 }), at: new Date().toISOString() });
    insertTask(db!, projectId, { id: "limit-a", status: "READY" });
    insertTask(db!, projectId, { id: "limit-b", status: "READY" });
    expect(scheduler.getLimits(projectId)).toEqual({ globalMax: 2, projectMax: 1, reviewerMax: 2 });
    const result = scheduler.recalculate();
    expect(result.runnables).toHaveLength(1);
    expect(result.waiting[0]?.reason).toBe("WAITING_FOR_CAPACITY");
    expect(scheduler.getEligibility("limit-b")).toEqual({ status: "WAIT", reason: "WAITING_FOR_CAPACITY" });
  });

  it("runs and stops the periodic reconciliation safety tick", () => {
    vi.useFakeTimers();
    try {
      const reconcile = vi.fn();
      const worker = new SchedulerSafetyWorker({ reconcile }, 10);
      worker.start();
      vi.advanceTimersByTime(25);
      expect(reconcile).toHaveBeenCalledTimes(2);
      worker.stop();
      vi.advanceTimersByTime(25);
      expect(reconcile).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses one capacity authority for task and phase reservations", async () => {
    await setup();
    for (let i = 0; i < 3; i++) scheduler.dispatchAgentRun(`run-${i}`, projectId, "reviewer", "test");
    insertTask(db!, projectId, { id: "over-capacity", status: "READY" });
    const registry = { transitionInTransaction: () => undefined } as never;
    expect(() => scheduler.dispatchAgentRun("run-3", projectId, "qa", "test")).toThrow(/WAITING_FOR_CAPACITY/);
    expect(() => scheduler.dispatchTask("over-capacity", registry, () => undefined)).toThrow(/WAITING_FOR_CAPACITY/);
  });

  it("revalidates an exact existing recovery reservation without charging a second slot or estimate", async () => {
    await setup();
    db!.run("INSERT INTO scheduler_budgets(project_id,limit_cost,spent_cost,reserved_cost) VALUES($projectId,1,0,0)", { projectId });
    scheduler.updateConfig({ ...scheduler.getConfig(), globalMax: 1, projectMax: 1, roleCapacity: { reviewer: 1 } });
    scheduler.dispatchAgentRun("recovery-run", projectId, "reviewer", "original-model", "shared-recovery-resource");
    const reservation = db!.get<{ id: string }>("SELECT * FROM scheduler_reservations WHERE run_id='recovery-run'")!;
    const locks = db!.all("SELECT * FROM scheduler_resource_locks");
    const budget = db!.get("SELECT * FROM scheduler_budgets");

    expect(scheduler).toHaveProperty("claimRunRecoveryInTransaction", expect.any(Function));
    for (let retry = 0; retry < 2; retry++) {
      expect(db!.transaction((tx) => scheduler.claimRunRecoveryInTransaction(tx, {
        runId: "recovery-run", reservationId: reservation.id, projectId, role: "reviewer",
      }))).toBe(reservation.id);
    }
    expect(db!.get("SELECT * FROM scheduler_reservations WHERE run_id='recovery-run'")).toEqual(reservation);
    expect(db!.all("SELECT * FROM scheduler_resource_locks")).toEqual(locks);
    expect(db!.get("SELECT * FROM scheduler_budgets")).toEqual(budget);
  });

  describe("existing-reservation recovery gates", () => {
    async function recoveryFixture(approval = false) {
      await setup();
      const approvalId = approval ? randomUUID() : undefined;
      if (approvalId) db!.run("INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,created_at) VALUES($id,'WORKFLOW_CHANGE',$projectId,'PROJECT','APPROVED','test',$now)", { id: approvalId, projectId, now: new Date().toISOString() });
      db!.run("INSERT INTO scheduler_budgets(project_id,limit_cost,spent_cost,reserved_cost) VALUES($projectId,100,0,0)", { projectId });
      scheduler.dispatchAgentRun("recovery-run", projectId, "reviewer", "original-model", "recovery-resource", approvalId === undefined ? {} : { approvalId });
      const reservationId = db!.get<{ id: string }>("SELECT id FROM scheduler_reservations WHERE run_id='recovery-run'")!.id;
      return { runId: "recovery-run", reservationId, projectId, role: "reviewer" };
    }

    function snapshot() {
      return {
        reservations: db!.all("SELECT * FROM scheduler_reservations ORDER BY id"),
        locks: db!.all("SELECT * FROM scheduler_resource_locks ORDER BY resource_key"),
        budgets: db!.all("SELECT * FROM scheduler_budgets ORDER BY project_id"),
      };
    }

    async function taskRecoveryFixture() {
      await setup();
      const task = insertTask(db!, projectId, { id: "recovery-task" });
      const workflow = { transitionInTransaction: (tx: Database, id: string, status: string) => tx.run("UPDATE tasks SET status=$status WHERE id=$id", { id, status }) };
      scheduler.dispatchTask(task.id, workflow as never, vi.fn(), { runId: "recovery-run" });
      const reservationId = db!.get<{ id: string }>("SELECT id FROM scheduler_reservations WHERE run_id='recovery-run'")!.id;
      return { runId: "recovery-run", reservationId, projectId, role: "developer" };
    }

    it.each([
      ["archived project", "UPDATE projects SET status='ARCHIVED'", "PROJECT_NOT_ACTIVE"],
      ["inactive onboarding", "UPDATE onboarding_configs SET status='PROPOSED'", "ONBOARDING_NOT_ACTIVE"],
      ["revoked onboarding approval", "UPDATE approvals SET status='REJECTED'", "ONBOARDING_NOT_ACTIVE"],
      ["missing original lock", "DELETE FROM scheduler_resource_locks", "RECOVERY_RESOURCE_LOCK_MISMATCH"],
      ["foreign lock owner", "UPDATE scheduler_resource_locks SET owner_id='run:other'", "RECOVERY_RESOURCE_LOCK_MISMATCH"],
      ["foreign lock project", "UPDATE scheduler_resource_locks SET project_id='other'", "RECOVERY_RESOURCE_LOCK_MISMATCH"],
      ["released reservation", "UPDATE scheduler_reservations SET status='RELEASED'", "RECOVERY_RESERVATION_MISMATCH"],
      ["foreign reservation owner", "UPDATE scheduler_reservations SET owner_id='run:other'", "RECOVERY_RESERVATION_MISMATCH"],
      ["foreign reservation run", "UPDATE scheduler_reservations SET run_id='other'", "RECOVERY_RESERVATION_MISMATCH"],
      ["foreign reservation role", "UPDATE scheduler_reservations SET role='qa'", "RECOVERY_RESERVATION_MISMATCH"],
      ["foreign reservation project", "UPDATE scheduler_reservations SET project_id='other'", "RECOVERY_RESERVATION_MISMATCH"],
      ["exceeded reserved budget", "UPDATE scheduler_budgets SET limit_cost=0.5", "WAITING_FOR_BUDGET"],
      ["exceeded spent budget", "UPDATE scheduler_budgets SET spent_cost=100", "WAITING_FOR_BUDGET"],
    ])("rejects %s and retains scheduler state", async (_name, change, reason) => {
      const input = await recoveryFixture();
      db!.exec(change);
      const before = snapshot();
      expect(() => db!.transaction((tx) => scheduler.claimRunRecoveryInTransaction(tx, input))).toThrow(reason);
      expect(snapshot()).toEqual(before);
    });

    it("rechecks a degraded Project Config", async () => {
      const input = await recoveryFixture();
      db!.run("INSERT INTO project_config_state(project_id,config_status,updated_at) VALUES($projectId,'DEGRADED',$at)", { projectId, at: new Date().toISOString() });
      const before = snapshot();
      expect(() => db!.transaction((tx) => scheduler.claimRunRecoveryInTransaction(tx, input))).toThrow("PROJECT_CONFIG_DEGRADED");
      expect(snapshot()).toEqual(before);
    });

    it.each([
      ["PAUSED", "WAITING_FOR_PAUSE"], ["FAILED", "BLOCKED_BY_WORKFLOW"], ["BLOCKED", "BLOCKED_BY_WORKFLOW"],
      ["WAITING_FOR_DEPENDENCY", "WAITING_FOR_DEPENDENCY"], ["WAITING_FOR_APPROVAL", "WAITING_FOR_APPROVAL"],
    ])("rejects a recovering Task currently %s", async (status, reason) => {
      const input = await taskRecoveryFixture();
      db!.run("UPDATE tasks SET status=$status WHERE id='recovery-task'", { status });
      const before = snapshot();
      expect(() => db!.transaction((tx) => scheduler.claimRunRecoveryInTransaction(tx, input))).toThrow(reason);
      expect(snapshot()).toEqual(before);
    });

    it("rechecks dependencies and pending approvals of a recovering Task", async () => {
      const input = await taskRecoveryFixture();
      const dependency = insertTask(db!, projectId, { id: "dependency" });
      db!.run("UPDATE tasks SET contract_json=$contract WHERE id='recovery-task'", { contract: JSON.stringify(contract("recovery", [dependency.id])) });
      db!.run("INSERT INTO dependencies(id,task_id,depends_on_task_id,type,created_at) VALUES($id,'recovery-task',$dependencyId,'BLOCKING',$at)", { id: randomUUID(), dependencyId: dependency.id, at: new Date().toISOString() });
      const before = snapshot();
      expect(() => db!.transaction((tx) => scheduler.claimRunRecoveryInTransaction(tx, input))).toThrow("WAITING_FOR_DEPENDENCY");
      expect(snapshot()).toEqual(before);
      db!.run("UPDATE tasks SET status='DONE' WHERE id=$id", { id: dependency.id });
      const approvalId = randomUUID();
      db!.run("INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,created_at) VALUES($id,'FINAL_MERGE','recovery-task','TASK','PENDING','test',$at)", { id: approvalId, at: new Date().toISOString() });
      expect(() => db!.transaction((tx) => scheduler.claimRunRecoveryInTransaction(tx, input))).toThrow("WAITING_FOR_APPROVAL");
      db!.run("UPDATE approvals SET status='APPROVED' WHERE id=$id", { id: approvalId });
      expect(db!.transaction((tx) => scheduler.claimRunRecoveryInTransaction(tx, input))).toBe(input.reservationId);
      expect(snapshot()).toEqual(before);
    });

    it("validates a Task reservation at its current workflow phase rather than requiring READY again", async () => {
      const input = await taskRecoveryFixture();
      expect(db!.get<{ status: string }>("SELECT status FROM tasks WHERE id='recovery-task'")?.status).toBe("DEVELOPMENT");
      const before = snapshot();
      expect(db!.transaction((tx) => scheduler.claimRunRecoveryInTransaction(tx, input))).toBe(input.reservationId);
      expect(snapshot()).toEqual(before);
    });

    it("rejects a Task reservation whose durable resource key no longer identifies its subject", async () => {
      const input = await taskRecoveryFixture();
      db!.run("UPDATE scheduler_resource_locks SET resource_key='task:other'");
      const before = snapshot();
      expect(() => db!.transaction((tx) => scheduler.claimRunRecoveryInTransaction(tx, input))).toThrow("RECOVERY_RESOURCE_LOCK_MISMATCH");
      expect(snapshot()).toEqual(before);
    });

    it.each([
      "status='REJECTED'", "type='WORKFLOW_CHANGE'", "subject_type='PROJECT'", "subject_id='other-task'",
    ])("rechecks the exact persisted Task FINAL_MERGE approval when %s", async (change) => {
      const input = await taskRecoveryFixture();
      const approvalId = randomUUID();
      db!.run("INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,created_at) VALUES($id,'FINAL_MERGE','recovery-task','TASK','APPROVED','test',$at)", { id: approvalId, at: new Date().toISOString() });
      db!.run("UPDATE scheduler_reservations SET approval_id=$id WHERE run_id='recovery-run'", { id: approvalId });
      expect(db!.transaction((tx) => scheduler.claimRunRecoveryInTransaction(tx, input))).toBe(input.reservationId);
      db!.run(`UPDATE approvals SET ${change} WHERE id=$id`, { id: approvalId });
      const before = snapshot();
      expect(() => db!.transaction((tx) => scheduler.claimRunRecoveryInTransaction(tx, input))).toThrow("WAITING_FOR_APPROVAL");
      expect(snapshot()).toEqual(before);
    });

    it("preserves an IN_PROGRESS Run reservation during startup reconciliation without claiming or recreating it", async () => {
      const input = await recoveryFixture();
      db!.run("INSERT INTO agent_runs(id,role,runtime,model,status) VALUES('recovery-run','reviewer','hermes','original-model','IN_PROGRESS')");
      const before = snapshot();
      expect(scheduler.reconcile()).toEqual({ releasedReservationIds: [], blockedReservationIds: [] });
      expect(snapshot()).toEqual(before);
      expect(db!.transaction((tx) => scheduler.claimRunRecoveryInTransaction(tx, input))).toBe(input.reservationId);
      expect(snapshot()).toEqual(before);
    });

    it("exposes only the unique existing reservation through the Scheduler recovery lookup", async () => {
      const input = await recoveryFixture();
      expect(scheduler).toHaveProperty("getRunRecoveryReservationInTransaction", expect.any(Function));
      expect(db!.transaction((tx) => scheduler.getRunRecoveryReservationInTransaction(tx, input.runId))).toEqual({ reservationId: input.reservationId, projectId, role: "reviewer" });
      expect(db!.transaction((tx) => scheduler.getRunRecoveryReservationInTransaction(tx, "unknown"))).toBeUndefined();
      scheduler.releaseAgentRun(input.runId, 0);
      expect(db!.transaction((tx) => scheduler.getRunRecoveryReservationInTransaction(tx, input.runId))).toBeUndefined();
    });

    it.each(["global", "project", "role"])("rechecks reduced %s capacity including the existing slot once", async (scope) => {
      const input = await recoveryFixture();
      scheduler.dispatchAgentRun("other-run", projectId, "reviewer", "test");
      const config = scheduler.getConfig();
      scheduler.updateConfig({ ...config, ...(scope === "global" ? { globalMax: 1 } : scope === "project" ? { projectMax: 1 } : { roleCapacity: { ...config.roleCapacity, reviewer: 1 } }) });
      const before = snapshot();
      expect(() => db!.transaction((tx) => scheduler.claimRunRecoveryInTransaction(tx, input))).toThrow(scope === "role" ? "WAITING_FOR_ROLE_CAPACITY" : "WAITING_FOR_CAPACITY");
      expect(snapshot()).toEqual(before);
    });

    it("rechecks the persisted phase approval rather than accepting an already RESERVED early return", async () => {
      const input = await recoveryFixture(true);
      const reservation = db!.get<{ approval_id: string }>("SELECT approval_id FROM scheduler_reservations WHERE id=$id", { id: input.reservationId })!;
      expect(reservation.approval_id).toEqual(expect.any(String));
      db!.run("UPDATE approvals SET status='REJECTED' WHERE id=$id", { id: reservation.approval_id });
      const before = snapshot();
      expect(() => db!.transaction((tx) => scheduler.claimRunRecoveryInTransaction(tx, input))).toThrow("WAITING_FOR_APPROVAL");
      expect(snapshot()).toEqual(before);
    });

    it("rejects a persisted phase approval whose approved subject was changed", async () => {
      const input = await recoveryFixture(true);
      const approval = db!.get<{ approval_id: string }>("SELECT approval_id FROM scheduler_reservations WHERE id=$id", { id: input.reservationId })!;
      db!.run("UPDATE approvals SET subject_id='other-project' WHERE id=$id", { id: approval.approval_id });
      const before = snapshot();
      expect(() => db!.transaction((tx) => scheduler.claimRunRecoveryInTransaction(tx, input))).toThrow("WAITING_FOR_APPROVAL");
      expect(snapshot()).toEqual(before);
    });

    it("rejects a foreign global lock even when the original reservation lock is intact", async () => {
      const input = await recoveryFixture();
      db!.run("INSERT INTO scheduler_resource_locks(resource_key,reservation_id,project_id,owner_id,locked_at) VALUES('global','other',$projectId,'run:other',$at)", { projectId, at: new Date().toISOString() });
      const before = snapshot();
      expect(() => db!.transaction((tx) => scheduler.claimRunRecoveryInTransaction(tx, input))).toThrow("WAITING_FOR_RESOURCE_LOCK");
      expect(snapshot()).toEqual(before);
    });

    it("rejects two active reservations for the same Run", async () => {
      const input = await recoveryFixture();
      db!.run("INSERT INTO scheduler_reservations(id,kind,subject_id,project_id,owner_id,reserved_at,status,role,model,run_id) VALUES('duplicate','TASK','another-task',$projectId,'task:another-task',$at,'RESERVED','reviewer','test','recovery-run')", { projectId, at: new Date().toISOString() });
      const before = snapshot();
      expect(db!.transaction((tx) => scheduler.getRunRecoveryReservationInTransaction(tx, input.runId))).toBeUndefined();
      expect(() => db!.transaction((tx) => scheduler.claimRunRecoveryInTransaction(tx, input))).toThrow("RECOVERY_RESERVATION_MISMATCH");
      expect(snapshot()).toEqual(before);
    });

    it("shares the caller CAS rollback boundary and allows an idempotent retry", async () => {
      const input = await recoveryFixture();
      db!.run("INSERT INTO agent_runs(id,role,runtime,model,status,attempt) VALUES('recovery-run','reviewer','hermes','original-model','IN_PROGRESS',1)");
      const before = snapshot();
      expect(() => db!.transaction((tx) => {
        expect(scheduler.claimRunRecoveryInTransaction(tx, input)).toBe(input.reservationId);
        tx.run("UPDATE agent_runs SET attempt=attempt+1 WHERE id=$id AND attempt=1", { id: input.runId });
        throw new Error("GENERATION_PREPARE_FAILED");
      })).toThrow("GENERATION_PREPARE_FAILED");
      expect(snapshot()).toEqual(before);
      expect(db!.get<{ attempt: number }>("SELECT attempt FROM agent_runs WHERE id=$id", { id: input.runId })?.attempt).toBe(1);
      expect(db!.transaction((tx) => scheduler.claimRunRecoveryInTransaction(tx, input))).toBe(input.reservationId);
      const committed = snapshot();
      expect(db!.transaction((tx) => scheduler.claimRunRecoveryInTransaction(tx, input))).toBe(input.reservationId);
      expect(snapshot()).toEqual(committed);
    });
  });

  it("releases an AgentRun reservation idempotently", async () => {
    await setup();
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
    db!.run("INSERT INTO agent_runs (id,role,runtime,model,status,cost) VALUES ('live-run','reviewer','test','test','STARTED',0)");
    scheduler.dispatchAgentRun("live-run", projectId, "reviewer", "test");

    scheduler.resourceLockService.reconcileDeadOwners();

    expect(db!.get<{ status: string }>("SELECT status FROM scheduler_reservations WHERE subject_id='live-run'")?.status).toBe("RESERVED");
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduler_resource_locks WHERE owner_id='run:live-run'")?.count).toBe(1);
  });

  it("preserves an active task LOCK reservation across scheduler restart reconciliation", async () => {
    await setup();
    const taskId = insertTask(db!, projectId, { id: "active-locked-task", status: "DEVELOPMENT" }).id;
    expect(scheduler.resourceLockService.acquire(taskId, "owner")).toBe(true);

    scheduler.reconcile();
    scheduler.reconcile();

    expect(db!.get<{ status: string }>("SELECT status FROM scheduler_reservations WHERE subject_id=$subject", { subject: `lock:${taskId}` })?.status).toBe("RESERVED");
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduler_resource_locks WHERE owner_id=$owner", { owner: `task:${taskId}` })?.count).toBe(1);
  });

  it("preserves a run lock and reservation when the lock owner does not match", async () => {
    await setup();
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
// Заполняем projectB для ограничения FK.
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
