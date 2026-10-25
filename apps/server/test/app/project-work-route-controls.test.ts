import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createSqliteDatabase } from "../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../helpers/migrations.js";
import { createApp } from "../../src/app/create-app.js";
import { SchedulerService } from "../../src/modules/scheduler/scheduler-service.js";
import { WorkService } from "../../src/modules/work/work-service.js";
import { PlanningService } from "../../src/modules/planning/planning-service.js";
import { WorkflowEngine } from "../../src/modules/workflow/workflow-engine.js";
import { WorkflowRegistry } from "../../src/modules/workflow/workflow-registry.js";
import { templates } from "../../src/modules/workflow/templates.js";
import { createTestAuthService, testAuthHeaders } from "../helpers/auth.js";
import { ApprovalService } from "../../src/modules/approvals/approval-service.js";
import { ProjectConfigService } from "../../src/modules/projects/project-config-service.js";

function createAppWithDb() {
  const db = createSqliteDatabase(":memory:");
  runMigrations(db, loadTestMigrations());
  const registry = new WorkflowRegistry();
  for (const template of Object.values(templates)) registry.register(template);
  const workflow = new WorkflowEngine(db, registry);
  const app = createApp({
    db,
    scheduler: new SchedulerService(db),
    runtime: {} as never,
    workService: new WorkService(db, workflow, new PlanningService(db)),
    projectConfigService: new ProjectConfigService(db, new ApprovalService(db)),
    authService: createTestAuthService(),
  });
  return { db, app };
}

describe("project index pagination", () => {
  it("requires authentication", async () => {
    const { app } = createAppWithDb();
    try {
      const response = await app.inject({ method: "GET", url: "/api/v1/projects" });
      expect(response.statusCode).toBe(401);
    } finally { await app.close(); }
  });

  it("returns a bounded page with an opaque stable cursor and distinct empty page", async () => {
    const { db, app } = createAppWithDb();
    const now = new Date().toISOString();
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const id = randomUUID();
      ids.push(id);
      const createdAt = new Date(Date.parse(now) + index).toISOString();
      db.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,$name,'P','ACTIVE',$createdAt,$createdAt)", { id, name: `project-${index}`, createdAt });
    }
    try {
      const first = await app.inject({ method: "GET", url: "/api/v1/projects?limit=2", headers: { cookie: testAuthHeaders().cookie } });
      expect(first.statusCode).toBe(200);
      const page1 = first.json();
      expect(page1.items).toHaveLength(2);
      expect(page1.nextCursor).toBeTruthy();
      expect(JSON.stringify(page1.items[0])).not.toContain("repository");
      const second = await app.inject({ method: "GET", url: `/api/v1/projects?limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`, headers: { cookie: testAuthHeaders().cookie } });
      expect(second.statusCode).toBe(200);
      const page2 = second.json();
      expect(page2.items).toHaveLength(2);
      expect(new Set([...page1.items.map((row: { id: string }) => row.id), ...page2.items.map((row: { id: string }) => row.id)]).size).toBe(4);
      const third = await app.inject({ method: "GET", url: `/api/v1/projects?limit=2&cursor=${encodeURIComponent(page2.nextCursor)}`, headers: { cookie: testAuthHeaders().cookie } });
      const page3 = third.json();
      expect(page3.items).toHaveLength(1);
      expect(page3.nextCursor).toBeNull();
      const empty = await app.inject({ method: "GET", url: "/api/v1/projects?cursor=invalid-cursor", headers: { cookie: testAuthHeaders().cookie } });
      expect(empty.statusCode).toBe(400);
      expect(empty.json().error).toBe("INVALID_CURSOR");
    } finally { await app.close(); }
  });
});

describe("scoped work route controls", () => {
  it("project pause/resume route writes the scope pause and rejects missing projects", async () => {
    const { db, app } = createAppWithDb();
    const projectId = randomUUID();
    const now = new Date().toISOString();
    db.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'p','P','ACTIVE',$now,$now)", { id: projectId, now });
    try {
      const missing = await app.inject({ method: "POST", url: `/api/v1/projects/${randomUUID()}/pause`, headers: testAuthHeaders(), payload: {} });
      expect(missing.statusCode).toBe(404);
      const paused = await app.inject({ method: "POST", url: `/api/v1/projects/${projectId}/pause`, headers: testAuthHeaders(), payload: {} });
      expect(paused.statusCode).toBe(200);
      expect(paused.json()).toMatchObject({ projectId, state: "PAUSED" });
      const resumed = await app.inject({ method: "POST", url: `/api/v1/projects/${projectId}/resume`, headers: testAuthHeaders(), payload: {} });
      expect(resumed.json().state).toBe("ACTIVE");
    } finally { await app.close(); }
  });

  it("task priority route validates and persists", async () => {
    const { db, app } = createAppWithDb();
    const projectId = randomUUID();
    const taskId = randomUUID();
    const now = new Date().toISOString();
    db.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'p','P','ACTIVE',$now,$now)", { id: projectId, now });
    const contract = JSON.stringify({ version: 1, goal: "G", context: "", requirements: [], acceptanceCriteria: [], dependencies: [], nonGoals: [], definitionOfDone: [] });
    db.run("INSERT INTO tasks(id,project_id,display_id,title,status,contract_json,created_at,updated_at) VALUES($id,$projectId,'T-1','T','READY',$contract,$now,$now)", { id: taskId, projectId, contract, now });
    try {
      const bad = await app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/priority`, headers: testAuthHeaders(), payload: { priority: 1001 } });
      expect(bad.statusCode).toBe(400);
      const good = await app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/priority`, headers: testAuthHeaders(), payload: { priority: 850 } });
      expect(good.statusCode).toBe(200);
      expect(good.json().priority).toBe(850);
    } finally { await app.close(); }
  });

  it("epic replan creates a planning request", async () => {
    const { db, app } = createAppWithDb();
    const projectId = randomUUID();
    const epicId = randomUUID();
    const now = new Date().toISOString();
    db.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'p','P','ACTIVE',$now,$now)", { id: projectId, now });
    db.run("INSERT INTO epics(id,project_id,display_id,title,status,contract_json,created_at,updated_at) VALUES($id,$projectId,'E','E','OPEN','{}',$now,$now)", { id: epicId, projectId, now });
    try {
      const response = await app.inject({ method: "POST", url: `/api/v1/epics/${epicId}/replan`, headers: testAuthHeaders(), payload: {} });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ epicId, status: "PLANNING" });
      expect(response.json().requestId).toBeTruthy();
    } finally { await app.close(); }
  });
});

describe("project config editor route controls", () => {
  it("rejects unauthenticated editor candidate save and invalid bodies", async () => {
    const { db, app } = createAppWithDb();
    const projectId = randomUUID();
    const now = new Date().toISOString();
    db.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'p','P','ACTIVE',$now,$now)", { id: projectId, now });
    try {
      const denied = await app.inject({ method: "POST", url: `/api/v1/projects/${projectId}/config/candidates/editor`, payload: {} });
      expect(denied.statusCode).toBe(401);
      const malformed = await app.inject({ method: "POST", url: `/api/v1/projects/${projectId}/config/candidates/editor`, headers: testAuthHeaders(), payload: { expectedManifestHash: "short", settings: {} } });
      expect(malformed.statusCode).toBe(400);
    } finally { await app.close(); }
  });

  it("enforces auth and CAS on the reconcile route", async () => {
    const { db, app } = createAppWithDb();
    const projectId = randomUUID();
    const journalId = randomUUID();
    const now = new Date().toISOString();
    db.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'p','P','ACTIVE',$now,$now)", { id: projectId, now });
    const approvalId = randomUUID();
    db.run("INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,created_at) VALUES($id,'WORKFLOW_CHANGE',$projectId,'PROJECT','APPROVED','t',$now)", { id: approvalId, projectId, now });
    const candidateId = randomUUID();
    const hashA = "a".repeat(64);
    db.run(
      `INSERT INTO project_config_candidates(candidate_id,project_id,source_head,manifest_json,manifest_hash,source_files_json,normalized_payload_json,schema_version,status,created_at)
       VALUES($id,$projectId,'head','{}',$hashA,'{}','{}',1,'PENDING_REVIEW',$now)`,
      { id: candidateId, projectId, hashA, now },
    );
    db.run(
      `INSERT INTO project_config_write_journal(id,project_id,candidate_id,approval_id,expected_manifest_hash,old_files_json,new_files_json,phase,created_at,updated_at)
       VALUES($id,$projectId,$candidateId,$approvalId,$hashA,'{}','{}','DEGRADED',$now,$now)`,
      { id: journalId, projectId, candidateId, approvalId, hashA, now },
    );
    try {
      const denied = await app.inject({ method: "POST", url: `/api/v1/projects/${projectId}/config/journals/${journalId}/reconcile`, payload: {} });
      expect(denied.statusCode).toBe(401);
      const wrongPhase = await app.inject({
        method: "POST", url: `/api/v1/projects/${projectId}/config/journals/${journalId}/reconcile`, headers: testAuthHeaders(),
        payload: { expectedPhase: "PREPARED", observedManifestHash: "a".repeat(64), resolution: "ACCEPT_EXTERNAL" },
      });
      expect(wrongPhase.statusCode).toBe(400);
    } finally { await app.close(); }
  });
});
