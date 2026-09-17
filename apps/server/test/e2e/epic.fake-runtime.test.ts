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
import { SchedulerService } from "../../src/modules/scheduler/scheduler-service.js";
import { ApprovalService } from "../../src/modules/approvals/approval-service.js";
import { MergeService } from "../../src/modules/git/merge-service.js";
import { IntegrationService } from "../../src/modules/git/integration-service.js";
import { GitCli } from "../../src/modules/git/git-cli.js";
import { writeFile } from "node:fs/promises";

const migrationFiles = [
  "001_system", "002_work_domain", "003_work_control", "010_planning",
];

class FakeAgentRuntime implements EpicAgentRuntime {
  readonly calls: Array<{ phase: string; role: string; taskId?: string; targetBranch?: string }> = [];
  active = 0;
  maxActive = 0;

  async run(request: { phase: string; role: string; taskId?: string; targetBranch?: string }): Promise<{ accepted: boolean; output: unknown; architectureChangingProposalAccepted?: boolean; usage: { cost: number } }> {
    this.calls.push(request);
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    await Promise.resolve();
    this.active--;
    const common = { version: "1.0", summary: request.phase };
    const output = request.role === "coordinator"
      ? { ...common, operation: "PLAN", classification: "EPIC" }
      : request.role === "product_manager"
        ? { ...common, outcome: "PRODUCT_DEFINITION", goal: "Deliver demo" }
        : request.role === "architect"
          ? { ...common, outcome: "DESIGN", architectureReviewRequired: true }
          : request.role === "developer"
            ? { ...common, outcome: "COMPLETED" }
            : request.role === "reviewer"
              ? { ...common, outcome: "PASS", independent: true }
              : request.role === "qa"
                ? { ...common, outcome: "PASS", evidence: ["fake-qa"] }
                : { ...common, outcome: "PASS", evidence: ["fake-integration"] };
    return { accepted: true, output, architectureChangingProposalAccepted: request.phase === "architect", usage: { cost: 0.25 } };
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

  it("reconciles stale orchestration runs before releasing scheduler capacity", async () => {
    directory = await mkdtemp(join(tmpdir(), "orchestrator-stale-reconcile-"));
    db = createSqliteDatabase(join(directory, "test.db"));
    const migrations: Migration[] = migrationFiles.map((name, index) => ({
      version: index === 3 ? 10 : index + 1,
      name,
      sql: readFileSync(join(import.meta.dirname, `../../src/platform/database/migrations/${name}.sql`), "utf8"),
    }));
    runMigrations(db, migrations);
    const projectId = randomUUID();
    const epicId = randomUUID();
    const runId = randomUUID();
    const now = new Date().toISOString();
    db.run("INSERT INTO projects (id,name,display_name,status,created_at,updated_at) VALUES ($id,'stale','Stale','ACTIVE',$now,$now)", { id: projectId, now });
    db.run("INSERT INTO epics (id,project_id,display_id,title,status,contract_json,created_at,updated_at) VALUES ($id,$projectId,'EPIC-STALE','Stale','IN_PROGRESS','{}',$now,$now)", { id: epicId, projectId, now });
    db.exec("CREATE TABLE agent_runs (id TEXT PRIMARY KEY, role TEXT NOT NULL, runtime TEXT NOT NULL, model TEXT NOT NULL, task_id TEXT, epic_id TEXT, status TEXT NOT NULL, started_at TEXT, ended_at TEXT, exit_code INTEGER, output TEXT, cost REAL)");
    db.exec("CREATE TABLE orchestration_phase_runs (id TEXT PRIMARY KEY, epic_id TEXT, task_id TEXT, phase TEXT NOT NULL, role TEXT NOT NULL, agent_run_id TEXT NOT NULL UNIQUE, result_json TEXT NOT NULL DEFAULT '{}', evidence_json TEXT NOT NULL DEFAULT '{}', validated INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'INTENT', request_json TEXT, started_at TEXT, ended_at TEXT, created_at TEXT NOT NULL, UNIQUE (epic_id, task_id, phase))");
    db.run("INSERT INTO agent_runs (id,role,runtime,model,epic_id,status,started_at) VALUES ($id,'reviewer','test','test',$epicId,'STARTED',$now)", { id: runId, epicId, now });
    db.run("INSERT INTO orchestration_phase_runs (id,epic_id,phase,role,agent_run_id,status,started_at,created_at) VALUES ($id,$epicId,'epic_review','reviewer',$runId,'RUNNING',$now,$now)", { id: randomUUID(), epicId, runId, now });
    db.exec("CREATE TABLE scheduler_budgets (project_id TEXT PRIMARY KEY, limit_cost REAL NOT NULL, spent_cost REAL NOT NULL DEFAULT 0, reserved_cost REAL NOT NULL DEFAULT 0)");
    db.exec("CREATE TABLE scheduler_reservations (id TEXT PRIMARY KEY, kind TEXT NOT NULL, subject_id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL, owner_id TEXT NOT NULL, reserved_at TEXT NOT NULL, estimate_cost REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'RESERVED', actual_cost REAL, role TEXT NOT NULL, model TEXT NOT NULL, approval_id TEXT, run_id TEXT)");
    db.exec("CREATE TABLE scheduler_resource_locks (resource_key TEXT PRIMARY KEY, reservation_id TEXT NOT NULL, project_id TEXT NOT NULL, owner_id TEXT NOT NULL, locked_at TEXT NOT NULL)");
    db.run("INSERT INTO scheduler_budgets (project_id,limit_cost,spent_cost,reserved_cost) VALUES ($projectId,10,0,1)", { projectId });
    const reservationId = randomUUID();
    db.run("INSERT INTO scheduler_reservations (id,kind,subject_id,project_id,owner_id,reserved_at,estimate_cost,status,role,model,run_id) VALUES ($id,'PHASE',$runId,$projectId,$owner,$now,1,'RESERVED','reviewer','test',$runId)", { id: reservationId, runId, projectId, owner: `run:${runId}`, now });
    db.run("INSERT INTO scheduler_resource_locks (resource_key,reservation_id,project_id,owner_id,locked_at) VALUES ('global',$id,$projectId,$owner,$now)", { id: reservationId, projectId, owner: `run:${runId}`, now });

    const registry = new WorkflowRegistry();
    for (const template of Object.values(templates)) registry.register(template);
    new EpicOrchestrator(db, new WorkflowEngine(db, registry), new PlanningService(db), new FakeAgentRuntime(), {} as never);

    expect(db.get<{ status: string }>("SELECT status FROM agent_runs WHERE id=$id", { id: runId })?.status).toBe("FAILED");
    expect(db.get<{ status: string }>("SELECT status FROM scheduler_reservations WHERE id=$id", { id: reservationId })?.status).toBe("RELEASED");
    expect(db.get<{ reserved_cost: number }>("SELECT reserved_cost FROM scheduler_budgets WHERE project_id=$projectId", { projectId })?.reserved_cost).toBe(0);
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduler_resource_locks WHERE reservation_id=$id", { id: reservationId })?.count).toBe(0);

    const scheduler = new SchedulerService(db);
    expect(() => scheduler.dispatchAgentRun("retry-run", projectId, "reviewer", "test")).not.toThrow();
    scheduler.releaseAgentRun("retry-run", 0);
    expect(db.get<{ reserved_cost: number }>("SELECT reserved_cost FROM scheduler_budgets WHERE project_id=$projectId", { projectId })?.reserved_cost).toBe(0);
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
    // The E2E uses the production MergeService.  IntegrationService owns the
    // provenance schema; no synthetic VERIFIED journal row is inserted here.
    new IntegrationService({ database: db, worktreeDir: directory });
    const merge = new MergeService({ database: db, repoPath: directory, targetBranch: "master" });
    const orchestrator = new EpicOrchestrator(db, new WorkflowEngine(db, registry), new PlanningService(db), runtime, merge);
    db.run("INSERT INTO scheduler_budgets (project_id,limit_cost,spent_cost,reserved_cost) VALUES ($projectId,100,0,0)", { projectId });
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
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM orchestration_phase_runs WHERE epic_id=$epicId AND validated=1", { epicId: pending.epicId })?.count).toBe(runtime.calls.length);
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduler_reservations WHERE status='RESERVED'")?.count).toBe(0);
    expect(db.get<{ spent_cost: number }>("SELECT spent_cost FROM scheduler_budgets WHERE project_id=$projectId", { projectId })?.spent_cost ?? 0).toBeCloseTo(runtime.calls.length * 0.25);
    const callsBeforeRestart = runtime.calls.length;
    const resumed = await orchestrator.approveAndRun(plan.id, "user");
    expect(resumed.finalApprovalId).toBe(pending.finalApprovalId);
    expect(runtime.calls.length).toBe(callsBeforeRestart);
    const approval = new ApprovalService(db).approve(pending.finalApprovalId!, "user");
    await expect(orchestrator.approveFinalMergeAsync(pending.epicId, approval.id)).rejects.toThrow(/exact verified Integration provenance/);
    expect(db.get<{ status: string }>("SELECT status FROM epics LIMIT 1")?.status).toBe("IN_PROGRESS");
  });

  it("merges an actual verified Integration attempt and releases children only after final approval", async () => {
    directory = await mkdtemp(join(tmpdir(), "orchestrator-epic-merge-e2e-"));
    db = createSqliteDatabase(join(directory, "test.db"));
    const migrations: Migration[] = migrationFiles.map((name, index) => ({
      version: index === 3 ? 10 : index + 1, name,
      sql: readFileSync(join(import.meta.dirname, `../../src/platform/database/migrations/${name}.sql`), "utf8"),
    }));
    runMigrations(db, migrations);
    const git = new GitCli();
    await git.run(directory, ["init", "-b", "master"]);
    await git.run(directory, ["config", "user.email", "test@example.invalid"]);
    await git.run(directory, ["config", "user.name", "Test"]);
    await writeFile(join(directory, "README.md"), "base\n");
    await git.run(directory, ["add", "README.md"]);
    await git.run(directory, ["commit", "-m", "base"]);
    const masterSha = (await git.run(directory, ["rev-parse", "master"])).stdout.trim();
    await git.run(directory, ["checkout", "-b", "epic/EPIC-1"]);
    await writeFile(join(directory, "feature.txt"), "feature\n");
    await git.run(directory, ["add", "feature.txt"]);
    await git.run(directory, ["commit", "-m", "feature"]);
    const sourceSha = (await git.run(directory, ["rev-parse", "epic/EPIC-1"])).stdout.trim();
    await git.run(directory, ["checkout", "master"]);

    const projectId = randomUUID();
    const now = new Date().toISOString();
    db.run("INSERT INTO projects (id,name,display_name,status,created_at,updated_at) VALUES ($id,'merge','Merge','ACTIVE',$now,$now)", { id: projectId, now });
    const registry = new WorkflowRegistry();
    for (const template of Object.values(templates)) registry.register(template);
    const runtime = new FakeAgentRuntime();
    const merge = new MergeService({ database: db, repoPath: directory, targetBranch: "master" });
    const orchestrator = new EpicOrchestrator(db, new WorkflowEngine(db, registry), new PlanningService(db), runtime, merge);
    db.run("INSERT INTO scheduler_budgets (project_id,limit_cost,spent_cost,reserved_cost) VALUES ($projectId,100,0,0)", { projectId });
    const plan = await orchestrator.start({ projectId, requestedBy: "user", tasks: [{ ref: "task_1", title: "Foundation", acceptanceCriteria: ["works"], role: "developer", workflow: "standard" }], epic: { title: "Merge epic", goal: "Merge" } });
    const pending = await orchestrator.approveAndRun(plan.id, "user");
    const approval = new ApprovalService(db).approve(pending.finalApprovalId!, "user");
    const integrationRun = db.get<{ agent_run_id: string }>("SELECT agent_run_id FROM orchestration_phase_runs WHERE epic_id=$epicId AND phase='integration'", { epicId: pending.epicId })!;
    const integration = new IntegrationService({ database: db, worktreeDir: directory, integrationRunId: integrationRun.agent_run_id });
    const attempt = await integration.prepareIntegration("epic/EPIC-1", "master", directory);
    db.run("UPDATE agent_runs SET status='STARTED' WHERE id=$id", { id: integrationRun.agent_run_id });
    await integration.runInIntegrationWorktree(attempt, async (worktree) => {
      await git.run(worktree, ["merge", "--no-edit", "epic/EPIC-1"]);
    });
    const validated = JSON.stringify({ version: "1.0", outcome: "PASS", evidence: ["real-integration"] });
    db.run("UPDATE agent_runs SET status='COMPLETED',ended_at=$at,exit_code=0,output=$output WHERE id=$id", { id: integrationRun.agent_run_id, at: new Date().toISOString(), output: validated });
    const result = await orchestrator.approveFinalMergeAsync(pending.epicId, approval.id);
    expect(result.pendingFinalApproval).toBe(false);
    const operation = db.get<{ status: string; approval_id: string; source_sha: string; expected_target_sha: string; resulting_target_sha: string; target_ref: string; branch_name: string }>("SELECT status,approval_id,source_sha,expected_target_sha,resulting_target_sha,target_ref,branch_name FROM git_operations WHERE type='MERGE' ORDER BY verified_at DESC LIMIT 1");
    expect(operation).toMatchObject({ status: "VERIFIED", approval_id: approval.id, source_sha: sourceSha, expected_target_sha: masterSha, target_ref: "master", branch_name: "epic/EPIC-1" });
    expect(operation!.resulting_target_sha).toBe(await git.run(directory, ["rev-parse", "master"]).then((result) => result.stdout.trim()));
    expect(operation!.resulting_target_sha).not.toBe(masterSha);
    expect(db.get<{ integration_run_id: string; source_sha: string; expected_target_sha: string; target_branch: string }>("SELECT integration_run_id,source_sha,expected_target_sha,target_branch FROM integration_attempts WHERE integration_run_id=$runId", { runId: integrationRun.agent_run_id })).toMatchObject({ integration_run_id: integrationRun.agent_run_id, source_sha: sourceSha, expected_target_sha: masterSha, target_branch: "master" });
    expect(db.get<{ status: string }>("SELECT status FROM epics WHERE id=$id", { id: pending.epicId })?.status).toBe("DONE");
    expect(db.all<{ status: string }>("SELECT status FROM tasks WHERE epic_id=$id", { id: pending.epicId }).every((row) => row.status === "RELEASED")).toBe(true);
  });
});
