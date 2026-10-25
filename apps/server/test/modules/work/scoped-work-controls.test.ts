import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../../helpers/migrations.js";
import { SchedulerService } from "../../../src/modules/scheduler/scheduler-service.js";
import { dispatchPauseEligibilityTx } from "../../../src/modules/scheduler/project-dispatch-guard.js";
import { WorkService } from "../../../src/modules/work/work-service.js";
import { PlanningService } from "../../../src/modules/planning/planning-service.js";
import { WorkflowEngine } from "../../../src/modules/workflow/workflow-engine.js";
import { WorkflowRegistry } from "../../../src/modules/workflow/workflow-registry.js";
import { templates } from "../../../src/modules/workflow/templates.js";

function createDb() {
  const db = createSqliteDatabase(":memory:");
  runMigrations(db, loadTestMigrations());
  return db;
}

function insertProject(db: ReturnType<typeof createDb>, id: string = randomUUID(), now = new Date().toISOString()) {
  db.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'p','P','ACTIVE',$now,$now)", { id, now });
  return id;
}

function insertTask(db: ReturnType<typeof createDb>, projectId: string, status = "READY", contractOverrides: Record<string, unknown> = {}) {
  const id = randomUUID();
  const contract = JSON.stringify({ version: 1, goal: "G", context: "", requirements: [], acceptanceCriteria: [], dependencies: [], nonGoals: [], definitionOfDone: [], ...contractOverrides });
  const now = new Date().toISOString();
  db.run("INSERT INTO tasks(id,project_id,display_id,title,status,contract_json,created_at,updated_at) VALUES($id,$projectId,'T-1','T',$status,$contract,$now,$now)", { id, projectId, status, contract, now });
  return id;
}

function workflow(db: ReturnType<typeof createDb>) {
  const registry = new WorkflowRegistry();
  for (const template of Object.values(templates)) registry.register(template);
  return new WorkflowEngine(db, registry);
}

describe("scoped project/epic pause controls", () => {
  it("pause blocks new descendant admissions while current reservations keep running", () => {
    const db = createDb();
    const scheduler = new SchedulerService(db);
    const projectId = insertProject(db);
    const paused = scheduler.pauseScope("PROJECT", projectId, "local-user");
    expect(paused.state).toBe("PAUSED");
    expect(db.get<{ paused_at: string }>("SELECT paused_at FROM scheduler_scope_pauses WHERE scope='PROJECT' AND scope_id=$id", { id: projectId })).toBeTruthy();
    expect(db.transaction((tx) => dispatchPauseEligibilityTx(tx, { projectId }))).toEqual({ allowed: false, reason: "DISPATCH_PAUSED_PROJECT" });
    // Текущие reservation продолжаются: пауза не трогает scheduler_reservations.
    const epicId = randomUUID();
    const now = new Date().toISOString();
    db.run("INSERT INTO epics(id,project_id,display_id,title,status,contract_json,created_at,updated_at) VALUES($id,$projectId,'E','E','OPEN','{}',$now,$now)", { id: epicId, projectId, now });
    db.run("INSERT INTO scheduler_reservations(id,kind,subject_id,project_id,owner_id,reserved_at,estimate_cost,status,role,model) VALUES($id,'PHASE',$epicId,$projectId,'run:1',$now,1,'RESERVED','developer','default')", { id: randomUUID(), epicId, projectId, now });
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduler_reservations WHERE status='RESERVED'")?.count).toBe(1);
    const resumed = scheduler.pauseScope("PROJECT", projectId, "local-user", false);
    expect(resumed.state).toBe("ACTIVE");
    expect(db.get("SELECT 1 FROM scheduler_scope_pauses WHERE scope='PROJECT' AND scope_id=$id", { id: projectId })).toBeUndefined();
    expect(db.transaction((tx) => dispatchPauseEligibilityTx(tx, { projectId }))).toEqual({ allowed: true });
    db.close();
  });

  it("epic pause blocks only descendants of that epic and never leaks across projects", () => {
    const db = createDb();
    const scheduler = new SchedulerService(db);
    const projectId = insertProject(db);
    const epicA = randomUUID();
    const epicB = randomUUID();
    const now = new Date().toISOString();
    for (const epicId of [epicA, epicB]) {
      db.run("INSERT INTO epics(id,project_id,display_id,title,status,contract_json,created_at,updated_at) VALUES($id,$projectId,'E','E','OPEN','{}',$now,$now)", { id: epicId, projectId, now });
    }
    scheduler.pauseScope("EPIC", epicA, "local-user");
    expect(db.transaction((tx) => dispatchPauseEligibilityTx(tx, { projectId, epicId: epicA }))).toEqual({ allowed: false, reason: "DISPATCH_PAUSED_EPIC" });
    expect(db.transaction((tx) => dispatchPauseEligibilityTx(tx, { projectId, epicId: epicB }))).toEqual({ allowed: true });
    expect(db.transaction((tx) => dispatchPauseEligibilityTx(tx, { projectId }))).toEqual({ allowed: true });
    db.close();
  });
});

describe("task pause/resume and priority controls", () => {
  it("task pause preserves the prior stage and resume returns to a runnable state", () => {
    const db = createDb();
    const service = new WorkService(db, workflow(db));
    const projectId = insertProject(db);
    const taskId = insertTask(db, projectId, "DEVELOPMENT");
    const paused = service.pauseTask(taskId);
    expect(paused.status).toBe("PAUSED");
    expect(paused.priorStage).toBe("DEVELOPMENT");
    expect(db.get<{ status: string }>("SELECT status FROM tasks WHERE id=$id", { id: taskId })?.status).toBe("PAUSED");
    const resumed = service.resumeTask(taskId);
    expect(resumed.state).toBe("READY");
    expect(db.get<{ status: string }>("SELECT status FROM tasks WHERE id=$id", { id: taskId })?.status).toBe("READY");
    db.close();
  });

  it("task priority is a validated backend command on the canonical priority field and records an event", () => {
    const db = createDb();
    const service = new WorkService(db, workflow(db));
    const projectId = insertProject(db);
    const taskId = insertTask(db, projectId, "READY");
    expect(() => service.setTaskPriority(taskId, 0)).toThrow(/priority/i);
    expect(() => service.setTaskPriority(taskId, 1001)).toThrow(/priority/i);
    const result = service.setTaskPriority(taskId, 850);
    expect(result.priority).toBe(850);
    const contract = JSON.parse(db.get<{ contract_json: string }>("SELECT contract_json FROM tasks WHERE id=$id", { id: taskId })!.contract_json);
    expect(contract.priority).toBe("Critical");
    expect(db.get("SELECT 1 FROM outbox_events WHERE aggregate_id=$id AND type='TaskPriorityChanged'", { id: taskId })).toBeTruthy();
    db.close();
  });
});

describe("epic replan", () => {
  it("creates a planning request under the coordinator/approval lifecycle", () => {
    const db = createDb();
    const service = new WorkService(db, workflow(db), new PlanningService(db));
    const projectId = insertProject(db);
    const epicId = randomUUID();
    const now = new Date().toISOString();
    db.run("INSERT INTO epics(id,project_id,display_id,title,status,contract_json,created_at,updated_at) VALUES($id,$projectId,'E','E','OPEN','{}',$now,$now)", { id: epicId, projectId, now });
    const result = service.replanEpic(epicId);
    expect(result.epicId).toBe(epicId);
    expect(result.requestId).toBeTruthy();
    expect(["PLANNING", "PLAN_PENDING_APPROVAL"]).toContain(result.status);
    const row = db.get<{ project_id: string; status: string }>("SELECT project_id,status FROM planning_requests WHERE id=$id", { id: result.requestId });
    expect(row?.project_id).toBe(projectId);
    expect(row?.status).toBeTruthy();
    db.close();
  });
});
