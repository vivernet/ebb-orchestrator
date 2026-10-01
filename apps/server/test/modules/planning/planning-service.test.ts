import { describe, expect, it, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations, type Migration } from "../../../src/platform/database/migrator.js";
import type { Database } from "../../../src/platform/database/database.js";
import { PlanningService } from "../../../src/modules/planning/planning-service.js";
import { DEFAULT_PLANNING_APPROVAL_POLICY } from "../../../src/modules/planning/planning-policy.js";

describe("PlanningService", () => {
  let db: Database | undefined;
  let dir = "";
  afterEach(async () => { db?.close(); db = undefined; if (dir) await rm(dir, { recursive: true, force: true }); });

  async function setup(): Promise<{ service: PlanningService; projectId: string }> {
    dir = await mkdtemp(join(tmpdir(), "orch-planning-test-"));
    db = createSqliteDatabase(join(dir, "test.db"));
    const names = ["001_system", "002_work_domain", "003_work_control", "004_agent_runs", "010_planning", "031_planning_request_linkage", "036_planning_request_role_runs"];
    const migrations: Migration[] = names.map((name) => ({ version: Number(name.slice(0, 3)), name, sql: readFileSync(join(import.meta.dirname, `../../../src/platform/database/migrations/${name}.sql`), "utf8") }));
    runMigrations(db, migrations);
    const projectId = randomUUID();
    db.run("INSERT INTO projects (id,name,display_name,status,created_at,updated_at) VALUES ($id,'p','P','ACTIVE',$now,$now)", { id: projectId, now: new Date().toISOString() });
    return { service: new PlanningService(db), projectId };
  }

  it("uses the required approval defaults", () => {
    expect(DEFAULT_PLANNING_APPROVAL_POLICY).toEqual({ standalone_task: false, multi_task_plan: true, epic: true, architecture_change: true });
  });

  it("creates a durable received request with its lifecycle identity", async () => {
    const { service, projectId } = await setup();
    const request = service.createRequest(projectId, "Build a feature", "local-user");
    expect(request).toMatchObject({ projectId, status: "RECEIVED", coordinatorRunId: null, planId: null, failureCode: null });
    expect(db?.get<{ status: string; updated_at: string }>("SELECT status,updated_at FROM planning_requests WHERE id=$id", { id: request.id }))
      .toEqual({ status: "RECEIVED", updated_at: request.createdAt });
  });

  it("atomically queues a Coordinator job with the new PlanningRequest", async () => {
    const { service, projectId } = await setup();
    const request = service.createQueuedRequest(projectId, "Build a feature", "local-user");
    const job = db?.get<{ type: string; payload_json: string; status: string; dedupe_key: string }>("SELECT type,payload_json,status,dedupe_key FROM background_jobs");
    expect(job).toEqual({ type: "coordinator.planning", payload_json: JSON.stringify({ requestId: request.id, projectId }), status: "QUEUED", dedupe_key: `planning:${request.id}` });
    expect(request.planningDecisionsRequired).toBe(true);
    expect(db?.get<{ planning_decisions_required: number }>("SELECT planning_decisions_required FROM planning_requests WHERE id=$id", { id: request.id })?.planning_decisions_required).toBe(1);
  });

  it("does not persist a request-bound Epic plan without both validated pre-approval decisions", async () => {
    const { service, projectId } = await setup();
    const request = service.createQueuedRequest(projectId, "Build an Epic", "local-user");
    const runId = randomUUID();
    db?.run("INSERT INTO agent_runs (id,role,runtime,model,status,started_at) VALUES ($id,'coordinator','hermes','test','STARTED',$now)", { id: runId, now: new Date().toISOString() });
    service.claimRequest(request.id, runId);

    expect(() => service.completeRequest(request.id, runId, "EPIC", { projectId, epic: { title: "Feature" }, tasks: [
      { ref: "task_first", title: "Foundation", acceptanceCriteria: ["done"], role: "developer", workflow: "standard" },
      { ref: "task_second", title: "Follow-up", acceptanceCriteria: ["done"], role: "developer", workflow: "standard", dependsOn: ["task_first"] },
    ] })).toThrow(/requires validated Product Manager and Architect decisions/i);
    expect(db?.get<{ count: number }>("SELECT COUNT(*) AS count FROM planning_plans")?.count).toBe(0);
    expect(db?.get<{ count: number }>("SELECT COUNT(*) AS count FROM epics")?.count).toBe(0);
    expect(db?.get<{ count: number }>("SELECT COUNT(*) AS count FROM tasks")?.count).toBe(0);
  });

  it("claims one Coordinator attempt and links one pending Epic plan atomically", async () => {
    const { service, projectId } = await setup();
    const request = service.createRequest(projectId, "Build an Epic", "local-user");
    const runId = randomUUID();
    db?.run("INSERT INTO agent_runs (id,role,runtime,model,status,started_at) VALUES ($id,'coordinator','hermes','test','STARTED',$now)", { id: runId, now: new Date().toISOString() });
    expect(service.claimRequest(request.id, runId)).toBe(true);
    expect(service.claimRequest(request.id, randomUUID())).toBe(false);
    const plan = service.completeRequest(request.id, runId, "EPIC", { projectId, epic: { title: "Feature" }, tasks: [
      { ref: "task_first", title: "Foundation", acceptanceCriteria: ["done"], role: "developer", workflow: "standard" },
      { ref: "task_second", title: "Follow-up", acceptanceCriteria: ["done"], role: "developer", workflow: "standard", dependsOn: ["task_first"] },
    ] });
    expect(plan.status).toBe("PENDING");
    expect(db?.get<{ status: string; plan_id: string; coordinator_run_id: string }>("SELECT status,plan_id,coordinator_run_id FROM planning_requests WHERE id=$id", { id: request.id }))
      .toEqual({ status: "PLAN_PENDING_APPROVAL", plan_id: plan.id, coordinator_run_id: runId });
    expect(db?.get<{ count: number }>("SELECT COUNT(*) AS count FROM epics")?.count).toBe(0);
    expect(() => service.completeRequest(request.id, runId, "EPIC", { projectId, epic: { title: "duplicate" }, tasks: [
      { ref: "task_only", title: "Duplicate", acceptanceCriteria: ["done"], role: "developer", workflow: "standard" },
    ] })).toThrow(/already resolved/i);
    expect(db?.get<{ count: number }>("SELECT COUNT(*) AS count FROM planning_plans")?.count).toBe(1);
    service.approvePlan(plan.id, "local-user", request.id);
    expect(db?.get<{ status: string }>("SELECT status FROM planning_requests WHERE id=$id", { id: request.id })?.status).toBe("MATERIALIZED");
  });

  it("rolls back a Coordinator plan when its project differs from the request", async () => {
    const { service, projectId } = await setup();
    const request = service.createRequest(projectId, "Build an Epic", "local-user");
    const runId = randomUUID();
    db?.run("INSERT INTO agent_runs (id,role,runtime,model,status,started_at) VALUES ($id,'coordinator','hermes','test','STARTED',$now)", { id: runId, now: new Date().toISOString() });
    expect(service.claimRequest(request.id, runId)).toBe(true);
    expect(() => service.completeRequest(request.id, runId, "EPIC", { projectId: randomUUID(), epic: { title: "Other" }, tasks: [
      { ref: "task_one", title: "Other", acceptanceCriteria: ["done"], role: "developer", workflow: "standard" },
    ] })).toThrow(/different projects/);
    expect(db?.get<{ count: number }>("SELECT COUNT(*) AS count FROM planning_plans")?.count).toBe(0);
    expect(db?.get<{ status: string }>("SELECT status FROM planning_requests WHERE id=$id", { id: request.id })?.status).toBe("PLANNING");
  });

  it("requires the exact linked request to approve its Epic plan", async () => {
    const { service, projectId } = await setup();
    const request = service.createRequest(projectId, "Build an Epic", "local-user");
    const runId = randomUUID();
    db?.run("INSERT INTO agent_runs (id,role,runtime,model,status,started_at) VALUES ($id,'coordinator','hermes','test','STARTED',$now)", { id: runId, now: new Date().toISOString() });
    service.claimRequest(request.id, runId);
    const plan = service.completeRequest(request.id, runId, "EPIC", { projectId, epic: { title: "Feature" }, tasks: [
      { ref: "task_first", title: "Foundation", acceptanceCriteria: ["done"], role: "developer", workflow: "standard" },
      { ref: "task_second", title: "Follow-up", acceptanceCriteria: ["done"], role: "developer", workflow: "standard", dependsOn: ["task_first"] },
    ] });

    expect(() => service.approvePlan(plan.id, "local-user")).toThrow(/linked request approval/i);
    expect(() => service.approvePlan(plan.id, "local-user", randomUUID())).toThrow(/does not own/i);
    expect(db?.get<{ status: string }>("SELECT status FROM planning_plans WHERE id=$id", { id: plan.id })?.status).toBe("PENDING");
    expect(db?.get<{ status: string }>("SELECT status FROM planning_requests WHERE id=$id", { id: request.id })?.status).toBe("PLAN_PENDING_APPROVAL");

    service.approvePlan(plan.id, "local-user", request.id);
    expect(db?.get<{ status: string }>("SELECT status FROM planning_requests WHERE id=$id", { id: request.id })?.status).toBe("MATERIALIZED");
    expect(db?.get<{ count: number }>("SELECT COUNT(*) AS count FROM epics")?.count).toBe(1);
  });

  it("records NEEDS_INPUT without creating a plan and refuses a second terminal transition", async () => {
    const { service, projectId } = await setup();
    const request = service.createRequest(projectId, "Clarify requirements", "local-user");
    const runId = randomUUID();
    db?.run("INSERT INTO agent_runs (id,role,runtime,model,status,started_at) VALUES ($id,'coordinator','hermes','test','STARTED',$now)", { id: runId, now: new Date().toISOString() });
    expect(service.claimRequest(request.id, runId)).toBe(true);
    expect(service.markNeedsInput(request.id, runId)).toBe(true);
    expect(service.markNeedsInput(request.id, runId)).toBe(false);
    expect(db?.get<{ status: string; classification: string; plan_id: string | null }>("SELECT status,classification,plan_id FROM planning_requests WHERE id=$id", { id: request.id }))
      .toEqual({ status: "NEEDS_INPUT", classification: "NEEDS_INPUT", plan_id: null });
  });

  it("stores only a controlled failure code after a failed Coordinator attempt", async () => {
    const { service, projectId } = await setup();
    const request = service.createRequest(projectId, "Build a feature", "local-user");
    const runId = randomUUID();
    db?.run("INSERT INTO agent_runs (id,role,runtime,model,status,started_at) VALUES ($id,'coordinator','hermes','test','STARTED',$now)", { id: runId, now: new Date().toISOString() });
    expect(service.claimRequest(request.id, runId)).toBe(true);
    expect(service.failRequest(request.id, runId, "COORDINATOR_RUN_FAILED")).toBe(true);
    expect(db?.get<{ status: string; failure_code: string }>("SELECT status,failure_code FROM planning_requests WHERE id=$id", { id: request.id }))
      .toEqual({ status: "FAILED", failure_code: "COORDINATOR_RUN_FAILED" });
  });

  it("marks a request linked to an interrupted Coordinator Run failed on startup", async () => {
    const { service, projectId } = await setup();
    const request = service.createRequest(projectId, "Build a feature", "local-user");
    const runId = randomUUID();
    db?.run("INSERT INTO agent_runs (id,role,runtime,model,status,started_at) VALUES ($id,'coordinator','hermes','test','STARTED',$now)", { id: runId, now: new Date().toISOString() });
    expect(service.claimRequest(request.id, runId)).toBe(true);
    db?.run("UPDATE agent_runs SET status='FAILED' WHERE id=$id", { id: runId });
    expect(service.reconcileInterruptedRequests()).toBe(1);
    expect(service.reconcileInterruptedRequests()).toBe(0);
    expect(db?.get<{ status: string; failure_code: string }>("SELECT status,failure_code FROM planning_requests WHERE id=$id", { id: request.id }))
      .toEqual({ status: "FAILED", failure_code: "PLANNING_INTERRUPTED" });
  });

  it("materializes a simple standalone task without approval", async () => {
    const { service, projectId } = await setup();
    const plan = service.preparePlan({ projectId, tasks: [{ ref: "task_1", title: "Small task", acceptanceCriteria: ["works"], role: "developer", workflow: "standard" }] });
    expect(plan.status).toBe("APPROVED");
    expect(plan.approvalRequired).toBe(false);
    expect(plan.temporaryIdMap.task_1).toBe("TASK-1");
  });

  it("keeps an Epic pending and materializes all refs atomically on approval", async () => {
    const { service, projectId } = await setup();
    const plan = service.preparePlan({ projectId, epic: { title: "Feature" }, tasks: [
      { ref: "task_1", title: "Foundation", acceptanceCriteria: ["done"], role: "developer", workflow: "standard" },
      { ref: "task_2", title: "Follow-up", acceptanceCriteria: ["done"], role: "developer", workflow: "standard", dependsOn: ["task_1"] },
    ] });
    expect(plan.status).toBe("PENDING");
    const approved = service.approvePlan(plan.id, "user");
    expect(approved.temporaryIdMap).toEqual({ task_1: "TASK-1", task_2: "TASK-2" });
    expect(db?.get<{ count: number }>("SELECT COUNT(*) AS count FROM dependencies")?.count).toBe(1);
    expect(db?.get<{ count: number }>("SELECT COUNT(*) AS count FROM outbox_events WHERE type='PlanApproved'")?.count).toBe(1);

    const tasks = db?.all<{ id: string; display_id: string; contract_json: string }>("SELECT id, display_id, contract_json FROM tasks ORDER BY display_id");
    expect(JSON.parse(tasks![1]!.contract_json).dependencies).toEqual([tasks![0]!.id]);
    const dependency = db?.get<{ task_id: string; depends_on_task_id: string }>("SELECT task_id, depends_on_task_id FROM dependencies");
    expect(dependency).toEqual({ task_id: tasks![1]!.id, depends_on_task_id: tasks![0]!.id });
    const event = db?.get<{ aggregate_id: string; payload_json: string }>("SELECT aggregate_id, payload_json FROM outbox_events WHERE type='DependencyCreated'");
    expect(event?.aggregate_id).toBe(tasks![1]!.id);
    expect(JSON.parse(event!.payload_json)).toEqual({ taskId: tasks![1]!.id, dependsOnTaskId: tasks![0]!.id });
  });

  it("rolls back work and outbox state when materialization fails", async () => {
    const { service, projectId } = await setup();
    const plan = service.preparePlan({ projectId, epic: { title: "Feature" }, tasks: [
      { ref: "task_1", title: "Foundation", acceptanceCriteria: ["done"], role: "developer", workflow: "standard" },
      { ref: "task_2", title: "Follow-up", acceptanceCriteria: ["done"], role: "developer", workflow: "standard", dependsOn: ["task_1"] },
    ] });
    db?.exec("CREATE TRIGGER fail_task_materialization BEFORE INSERT ON tasks WHEN NEW.title = 'Follow-up' BEGIN SELECT RAISE(ABORT, 'forced materialization failure'); END");

    expect(() => service.approvePlan(plan.id, "user")).toThrow(/forced materialization failure/);
    expect(db?.get<{ count: number }>("SELECT COUNT(*) AS count FROM epics")?.count).toBe(0);
    expect(db?.get<{ count: number }>("SELECT COUNT(*) AS count FROM tasks")?.count).toBe(0);
    expect(db?.get<{ count: number }>("SELECT COUNT(*) AS count FROM dependencies")?.count).toBe(0);
    expect(db?.get<{ count: number }>("SELECT COUNT(*) AS count FROM outbox_events")?.count).toBe(0);
    expect(db?.get<{ status: string }>("SELECT status FROM planning_plans WHERE id=$id", { id: plan.id })?.status).toBe("PENDING");
  });

  it("rejects invalid plans before creating any work", async () => {
    const { service, projectId } = await setup();
    expect(() => service.preparePlan({ projectId, tasks: [
      { ref: "task_1", title: "bad", acceptanceCriteria: ["done"], role: "developer", workflow: "standard", dependsOn: ["task_2"] },
      { ref: "task_2", title: "bad", acceptanceCriteria: ["done"], role: "developer", workflow: "standard", dependsOn: ["task_1"] },
    ], epic: { title: "bad" } })).toThrow(/cyclic/i);
    expect(db?.get<{ count: number }>("SELECT COUNT(*) AS count FROM tasks")?.count).toBe(0);
  });
});
