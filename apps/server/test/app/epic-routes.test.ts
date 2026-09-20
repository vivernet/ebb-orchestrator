import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app/create-app.js";
import { createSqliteDatabase } from "../../src/platform/database/sqlite-database.js";
import { runMigrations, type Migration } from "../../src/platform/database/migrator.js";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EpicStartInput } from "../../src/modules/planning/epic-orchestrator.js";
import type { PlanningPlan } from "../../src/modules/planning/planning-types.js";

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
  const app = createApp({ db, scheduler: {} as never, runService: {} as never, epicOrchestrator: { start, approveAndRun } });
  return { db, app, start, approveAndRun, now };
}

function headers(app: ReturnType<typeof createApp>) {
  return { authorization: `Bearer ${app.sessionToken}`, origin: "http://127.0.0.1:3000", "x-csrf-token": app.csrfToken };
}

const validBody = {
  epic: { title: "Production Epic", goal: "Ship it" },
  tasks: [{ ref: "foundation", title: "Foundation", acceptanceCriteria: ["works"], role: "developer", workflow: "standard" }],
};

describe("epic planning routes", () => {
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
});
