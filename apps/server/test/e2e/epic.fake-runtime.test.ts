import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSqliteDatabase } from "../../src/platform/database/sqlite-database.js";
import { runMigrations, type Migration } from "../../src/platform/database/migrator.js";
import type { Database } from "../../src/platform/database/database.js";
import { WorkflowEngine } from "../../src/modules/workflow/workflow-engine.js";
import { WorkflowRegistry } from "../../src/modules/workflow/workflow-registry.js";
import { templates } from "../../src/modules/workflow/templates.js";
import { PlanningService } from "../../src/modules/planning/planning-service.js";
import { EpicOrchestrator, type EpicAgentRuntime } from "../../src/modules/planning/epic-orchestrator.js";
import { ApprovalService } from "../../src/modules/approvals/approval-service.js";

const migrationFiles = [
  "001_system", "002_work_domain", "003_work_control", "010_planning",
];

class FakeAgentRuntime implements EpicAgentRuntime {
  readonly calls: Array<{ phase: string; role: string; taskId?: string; targetBranch?: string }> = [];
  active = 0;
  maxActive = 0;

  async run(request: { phase: string; role: string; taskId?: string; targetBranch?: string }): Promise<{ accepted: boolean; architectureChangingProposalAccepted?: boolean }> {
    this.calls.push(request);
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    await Promise.resolve();
    this.active--;
    return { accepted: true, architectureChangingProposalAccepted: request.phase === "architect" };
  }
}

describe("full epic orchestration with FakeAgentRuntime", () => {
  let db: Database | undefined;
  let directory = "";

  afterEach(async () => {
    db?.close();
    db = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("runs plan → PM → Architect → parallel children → final validation and releases children last", async () => {
    directory = await mkdtemp(join(tmpdir(), "orchestrator-epic-e2e-"));
    db = createSqliteDatabase(join(directory, "test.db"));
    const migrations: Migration[] = migrationFiles.map((name, index) => ({
      version: index === 3 ? 10 : index + 1,
      name,
      sql: readFileSync(join(import.meta.dirname, `../../src/platform/database/migrations/${name}.sql`), "utf8"),
    }));
    runMigrations(db, migrations);
    db.exec("CREATE TABLE resource_locks (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, owner_id TEXT NOT NULL, acquired_at TEXT NOT NULL, expires_at TEXT)");
    const projectId = randomUUID();
    const now = new Date().toISOString();
    db.run("INSERT INTO projects (id,name,display_name,status,created_at,updated_at) VALUES ($id,'demo','Demo','ACTIVE',$now,$now)", { id: projectId, now });
    const registry = new WorkflowRegistry();
    for (const template of Object.values(templates)) registry.register(template);
    const runtime = new FakeAgentRuntime();
    const orchestrator = new EpicOrchestrator(db, new WorkflowEngine(db, registry), new PlanningService(db), runtime);
    const plan = await orchestrator.start({
      projectId,
      requestedBy: "user",
      includeProductManager: true,
      includeArchitect: true,
      architectureReviewRequired: true,
      tasks: [
        { ref: "task_1", title: "Foundation", acceptanceCriteria: ["foundation works"], role: "developer", workflow: "standard" },
        { ref: "task_2", title: "API", acceptanceCriteria: ["api works"], dependsOn: ["task_1"], role: "developer", workflow: "standard" },
        { ref: "task_3", title: "UI", acceptanceCriteria: ["ui works"], dependsOn: ["task_1"], role: "developer", workflow: "standard" },
      ],
      epic: { title: "Demo epic", goal: "Deliver demo" },
    });
    expect(plan.status).toBe("PENDING");
    const pending = await orchestrator.approveAndRun(plan.id, "user");

    expect(pending.sequence).toEqual([
      "plan", "pm", "architect", "task_1", "task_2", "task_3", "epic_review",
      "architecture_review", "epic_qa", "integration", "final_approval",
    ]);
    expect(runtime.maxActive).toBe(2);
    expect(runtime.calls.filter((call) => call.taskId).every((call) => call.targetBranch === "epic/EPIC-1")).toBe(true);
    expect(pending.finalApprovalRequired).toBe(true);
    expect(pending.childStatuses.every((status) => status === "INTEGRATED_INTO_EPIC")).toBe(true);
    expect(db.get<{ status: string }>("SELECT status FROM epics LIMIT 1")?.status).toBe("IN_PROGRESS");
    expect(db.get<{ plan_id: string; stage: string }>("SELECT plan_id, stage FROM epic_orchestrations WHERE epic_id=$epicId", { epicId: pending.epicId })).toEqual({ plan_id: plan.id, stage: "FINAL_APPROVAL" });
    expect(db.get<{ subject_id: string; subject_type: string }>("SELECT subject_id, subject_type FROM approvals WHERE id=$id", { id: pending.finalApprovalId! })).toEqual({ subject_id: pending.epicId, subject_type: "EPIC" });
    const callsBeforeRestart = runtime.calls.length;
    const resumed = await orchestrator.approveAndRun(plan.id, "user");
    expect(resumed.finalApprovalId).toBe(pending.finalApprovalId);
    expect(runtime.calls.length).toBe(callsBeforeRestart);
    const approval = new ApprovalService(db).approve(pending.finalApprovalId!, "user");
    db.exec("CREATE TABLE git_operations (id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL, repo_path TEXT NOT NULL, branch_name TEXT, target_ref TEXT, created_at TEXT NOT NULL, verified_at TEXT, approval_id TEXT, source_sha TEXT, expected_target_sha TEXT, resulting_target_sha TEXT)");
    db.run("INSERT INTO git_operations (id,type,status,repo_path,branch_name,target_ref,created_at,verified_at,approval_id,source_sha,expected_target_sha,resulting_target_sha) VALUES ($id,'MERGE','VERIFIED','/repo','epic/EPIC-1','master',$now,$now,$approval,'source-sha','master-before','master-after')", { id: randomUUID(), approval: approval.id, now: new Date().toISOString() });
    const result = orchestrator.approveFinalMerge(pending.epicId, approval.id);
    expect(result.childStatuses.every((status) => status === "RELEASED")).toBe(true);
    expect(db.get<{ status: string }>("SELECT status FROM epics LIMIT 1")?.status).toBe("DONE");
  });
});
