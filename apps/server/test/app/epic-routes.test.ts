import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app/create-app.js";
import { createSqliteDatabase } from "../../src/platform/database/sqlite-database.js";
import { runMigrations, type Migration } from "../../src/platform/database/migrator.js";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EpicStartInput } from "../../src/modules/planning/epic-orchestrator.js";
import type { PlanningPlan } from "../../src/modules/planning/planning-types.js";
import { createTestAuthService, TEST_COOKIE, TEST_CSRF_TOKEN } from "../helpers/auth.js";

const migrationDir = fileURLToPath(new URL("../../src/platform/database/migrations/", import.meta.url));
const migrations: Migration[] = readdirSync(migrationDir).filter((file) => file.endsWith(".sql")).map((file) => ({
  version: Number(/^([0-9]+)/.exec(file)?.[1]),
  name: file.replace(/^[0-9]+_/, "").replace(/\.sql$/, ""),
  sql: readFileSync(join(migrationDir, file), "utf8"),
}));

function setup() {
  const db = createSqliteDatabase(":memory:");
  runMigrations(db, migrations);
  const now = new Date().toISOString();
  db.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES ('project-1','p','P','ACTIVE',$now,$now)", { now });
  db.run("INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,resolved_by,resolution_note,created_at,resolved_at) VALUES ('onboarding-1','WORKFLOW_CHANGE','project-1','PROJECT','APPROVED','local-user','local-user',NULL,$now,$now)", { now });
  db.run("INSERT INTO onboarding_configs(project_id,repository_path,facts_json,proposed_json,status,approval_id,created_at,updated_at,activated_at) VALUES ('project-1','C:\\repo','{}','{\"defaultBranch\":\"master\"}','ACTIVE','onboarding-1',$now,$now,$now)", { now });
  const start = vi.fn(async (input: EpicStartInput): Promise<PlanningPlan> => ({ id: "plan-1", status: "PENDING", approvalRequired: true, temporaryIdMap: {}, createdAt: now, ...input }));
  const approveAndRun = vi.fn(async () => ({ epicId: "epic-1", sequence: ["plan"], childStatuses: ["DRAFT"], finalApprovalRequired: true, pendingFinalApproval: true, finalApprovalId: "approval-1" }));
  const app = createApp({ db, scheduler: {} as never, runService: {} as never, epicOrchestrator: { start, approveAndRun }, authService: createTestAuthService() });
  return { db, app, start, approveAndRun, now };
}

function headers(_app: ReturnType<typeof createApp>) {
  return { cookie: TEST_COOKIE, origin: "http://127.0.0.1:3000", "x-csrf-token": TEST_CSRF_TOKEN };
}

const validBody = {
  epic: { title: "Production Epic", goal: "Ship it" },
  tasks: [{ ref: "foundation", title: "Foundation", acceptanceCriteria: ["works"], role: "developer", workflow: "standard" }],
};

describe("epic planning routes", () => {
  it("accepts a project request and exposes its durable status without materializing work", async () => {
    const { db, app } = setup();
    const created = await app.inject({ method: "POST", url: "/api/v1/projects/project-1/requests", headers: headers(app), payload: { request: "Build a feature" } });
    expect(created.statusCode).toBe(202);
    const body = created.json() as { requestId: string; status: string };
    expect(body.status).toBe("RECEIVED");
    expect(db.get<{ requested_by: string }>("SELECT requested_by FROM planning_requests WHERE id=$id", { id: body.requestId })?.requested_by).toBe("local-user");
    expect(db.get<{ type: string }>("SELECT type FROM background_jobs WHERE dedupe_key=$key", { key: `planning:${body.requestId}` })?.type).toBe("coordinator.planning");
    const status = await app.inject({ method: "GET", url: `/api/v1/projects/project-1/requests/${body.requestId}`, headers: headers(app) });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ requestId: body.requestId, status: "RECEIVED", planId: null });
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM epics")?.count).toBe(0);
    await app.close(); db.close();
  });

  it("returns validated Product Manager and Architect decisions in the request approval summary and hides proposal payload", async () => {
    const { db, app, now } = setup();
    const created = await app.inject({ method: "POST", url: "/api/v1/projects/project-1/requests", headers: headers(app), payload: { request: "Build an Epic" } });
    const requestId = (created.json() as { requestId: string }).requestId;
    const plan = {
      projectId: "project-1", requestedBy: "local-user", epic: { title: "Release", goal: "Prepare release" },
      tasks: [{ ref: "task_build", title: "Build", acceptanceCriteria: ["artifact exists"], dependsOn: [], role: "developer", workflow: "standard" }],
      planningDecisions: {
        productManager: { version: "1.0.0", outcome: "PRODUCT_DEFINITION", goal: "Ship safely", scope: ["Build release"], nonGoals: ["Rewrite billing"] },
        architect: { version: "1.0.0", outcome: "DESIGN", components: ["Build service"], decisions: ["Use the existing module"], proposals: [{ type: "SCOPE_CHANGE", title: "Maybe later", rationale: "Not required", payload: { secret: "must not reach the UI" } }] },
      },
    };
    db.run("INSERT INTO planning_plans(id,project_id,plan_json,status,approval_required,created_at) VALUES('plan-review','project-1',$json,'PENDING',1,$now)", { json: JSON.stringify(plan), now });
    db.run("UPDATE planning_requests SET status='PLAN_PENDING_APPROVAL',classification='EPIC',plan_id='plan-review' WHERE id=$requestId", { requestId });

    const response = await app.inject({ method: "GET", url: `/api/v1/projects/project-1/requests/${requestId}`, headers: headers(app) });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "PLAN_PENDING_APPROVAL",
      plan: { planningDecisions: {
        productManager: { goal: "Ship safely", scope: ["Build release"] },
        architect: { decisions: ["Use the existing module"], proposals: [{ type: "SCOPE_CHANGE", title: "Maybe later", rationale: "Not required" }] },
      } },
    });
    expect(response.body).not.toContain("must not reach the UI");
    db.run("UPDATE planning_plans SET plan_json=$json WHERE id='plan-review'", { json: JSON.stringify({ ...plan, planningDecisions: undefined }) });
    const incomplete = await app.inject({ method: "GET", url: `/api/v1/projects/project-1/requests/${requestId}`, headers: headers(app) });
    expect(incomplete.statusCode).toBe(503);
    await app.close(); db.close();
  });

  it("rejects invalid request input and cross-project status lookup", async () => {
    const { db, app } = setup();
    const invalid = await app.inject({ method: "POST", url: "/api/v1/projects/project-1/requests", headers: headers(app), payload: { request: " " } });
    expect(invalid.statusCode).toBe(400);
    const created = await app.inject({ method: "POST", url: "/api/v1/projects/project-1/requests", headers: headers(app), payload: { request: "Build a feature" } });
    const requestId = (created.json() as { requestId: string }).requestId;
    const denied = await app.inject({ method: "GET", url: `/api/v1/projects/other-project/requests/${requestId}`, headers: headers(app) });
    expect(denied.statusCode).toBe(404);
    await app.close(); db.close();
  });
  it("creates a plan from project ownership and active onboarding", async () => {
    const { db, app, start } = setup();
    const response = await app.inject({ method: "POST", url: "/api/v1/projects/project-1/epics/plans", headers: headers(app), payload: validBody });
    expect(response.statusCode).toBe(201);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ projectId: "project-1", requestedBy: "local-user" }));
    await app.close(); db.close();
  });

  it("rejects a repository/ref authority smuggling attempt", async () => {
    const { db, app, start } = setup();
    const response = await app.inject({ method: "POST", url: "/api/v1/projects/project-1/epics/plans", headers: headers(app), payload: { ...validBody, repoPath: "C:\\attacker", targetBranch: "attacker" } });
    expect(response.statusCode).toBe(400);
    expect(start).not.toHaveBeenCalled();
    await app.close(); db.close();
  });

  it("enforces persisted plan ownership and approval execution", async () => {
    const { db, app, approveAndRun } = setup();
    db.run("INSERT INTO planning_plans(id,project_id,plan_json,status,approval_required,created_at) VALUES ('plan-1','project-1','{}','PENDING',1,$now)", { now: new Date().toISOString() });
    const missing = await app.inject({ method: "POST", url: "/api/v1/projects/missing/epics/plans/plan-1/approve-run", headers: headers(app), payload: {} });
    expect(missing.statusCode).toBe(404);
    const response = await app.inject({ method: "POST", url: "/api/v1/projects/project-1/epics/plans/plan-1/approve-run", headers: headers(app), payload: {} });
    expect(response.statusCode).toBe(200);
    expect(approveAndRun).toHaveBeenCalledWith("plan-1", "local-user");
    await app.close(); db.close();
  });

  it("approves request-linked plans through the exact request and preserves detached structured plans", async () => {
    const { db, app, approveAndRun } = setup();
    const now = new Date().toISOString();
    db.run("INSERT INTO planning_plans(id,project_id,plan_json,status,approval_required,created_at) VALUES ('plan-request','project-1','{}','PENDING',1,$now)", { now });
    db.run("INSERT INTO planning_requests(id,project_id,request,requested_by,classification,plan_id,status,created_at,updated_at) VALUES ('request-1','project-1','Build Epic','local-user','EPIC','plan-request','PLAN_PENDING_APPROVAL',$now,$now)", { now });

    const missingRequest = await app.inject({ method: "POST", url: "/api/v1/projects/project-1/epics/plans/plan-request/approve-run", headers: headers(app), payload: {} });
    expect(missingRequest.statusCode).toBe(409);
    const wrongRequest = await app.inject({ method: "POST", url: "/api/v1/projects/project-1/epics/plans/plan-request/approve-run", headers: headers(app), payload: { requestId: "other-request" } });
    expect(wrongRequest.statusCode).toBe(404);
    const linked = await app.inject({ method: "POST", url: "/api/v1/projects/project-1/epics/plans/plan-request/approve-run", headers: headers(app), payload: { requestId: "request-1" } });
    expect(linked.statusCode).toBe(200);
    expect(approveAndRun).toHaveBeenCalledWith("plan-request", "local-user", "request-1");
    await app.close(); db.close();
  });

  it("allows retry only for an Epic request blocked by recovery", async () => {
    const { db, app, approveAndRun } = setup();
    const now = new Date().toISOString();
    db.run("INSERT INTO epics(id,project_id,display_id,title,status,contract_json,created_at,updated_at) VALUES ('epic-1','project-1','EPIC-1','Epic','IN_PROGRESS','{}',$now,$now)", { now });
    db.run("INSERT INTO planning_plans(id,project_id,plan_json,epic_id,status,approval_required,created_at) VALUES ('plan-retry','project-1','{}','epic-1','APPROVED',1,$now)", { now });
    db.run("INSERT INTO planning_requests(id,project_id,request,requested_by,classification,plan_id,status,failure_code,created_at,updated_at) VALUES ('request-retry','project-1','Build Epic','local-user','EPIC','plan-retry','FAILED','EPIC_RECOVERY_FAILED',$now,$now)", { now });

    const retry = await app.inject({ method: "POST", url: "/api/v1/projects/project-1/epics/plans/plan-retry/approve-run", headers: headers(app), payload: { requestId: "request-retry" } });
    expect(retry.statusCode).toBe(200);
    expect(approveAndRun).toHaveBeenCalledWith("plan-retry", "local-user", "request-retry");

    db.run("UPDATE planning_requests SET failure_code='COORDINATOR_RUN_FAILED' WHERE id='request-retry'");
    const unrelatedFailure = await app.inject({ method: "POST", url: "/api/v1/projects/project-1/epics/plans/plan-retry/approve-run", headers: headers(app), payload: { requestId: "request-retry" } });
    expect(unrelatedFailure.statusCode).toBe(409);
    expect(approveAndRun).toHaveBeenCalledTimes(1);
    await app.close(); db.close();
  });
});
