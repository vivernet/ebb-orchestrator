import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSqliteDatabase } from "../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../helpers/migrations.js";
import type { Database } from "../../src/platform/database/database.js";
import { WorkflowEngine } from "../../src/modules/workflow/workflow-engine.js";
import { WorkflowRegistry } from "../../src/modules/workflow/workflow-registry.js";
import { templates } from "../../src/modules/workflow/templates.js";
import { PlanningService } from "../../src/modules/planning/planning-service.js";
import { EpicOrchestrator } from "../../src/modules/planning/epic-orchestrator.js";
import type { AgentRuntime } from "../../src/modules/runtime/agent-runtime.js";
import type { AgentRun } from "@ebb-orchestrator/contracts";
import type { RunOutcome } from "../../src/modules/runtime/run-types.js";
import { RunService } from "../../src/modules/runtime/run-service.js";
import { DatabaseCompletionStore } from "../../src/modules/execution/mcp/submit-result-tool.js";
import { SchedulerService } from "../../src/modules/scheduler/scheduler-service.js";
import { ApprovalService } from "../../src/modules/approvals/approval-service.js";
import { MergeService } from "../../src/modules/git/merge-service.js";
import { IntegrationService } from "../../src/modules/git/integration-service.js";
import { GitCli } from "../../src/modules/git/git-cli.js";
import { EpicWorkspaceProvisioner } from "../../src/modules/git/epic-workspace-provisioner.js";
import { TaskWorkspaceProvisioner } from "../../src/modules/git/task-workspace-provisioner.js";
import { WorktreeManager } from "../../src/modules/git/worktree-manager.js";
import { seedApprovedProjectConfig } from "../helpers/approved-project-config.js";
import { markFakeRunNeverLaunched } from "../helpers/fake-run-process-owner.js";
import { insertRunProcessOwnerTx, preflightRunProcessOwners, prepareRunProcessOwner } from "../../src/modules/runtime/run-process-owner.js";
import type { ProcessScopeSupervisor } from "../../src/platform/process/run-scope-supervisor.js";

type FakeRequest = {
  phase: string;
  role: string;
  taskId?: string;
  targetBranch?: string;
  integration?: { id: string; target_branch: string; expected_target_sha: string; source_sha: string };
};

async function commitTaskFixtureChange(database: Database, runId: string, taskId: string): Promise<void> {
  const row = database.get<{ capability_json: string | null }>("SELECT capability_json FROM agent_runs WHERE id=$runId", { runId });
  let workspace: string | undefined;
  try {
    const capability = row?.capability_json ? JSON.parse(row.capability_json) as { workspace?: unknown } : undefined;
    if (typeof capability?.workspace === "string") workspace = capability.workspace;
  } catch { /* fail closed below */ }
  if (!workspace) throw new Error(`Developer run ${runId} has no persisted workspace`);
  const file = `fixture-${taskId}.txt`;
  await writeFile(join(workspace, file), `deterministic Task commit for ${taskId}\n`);
  const git = new GitCli();
  await git.run(workspace, ["add", file]);
  const commit = await git.run(workspace, ["commit", "-m", `seed Task integration fixture ${taskId}`]);
  if (commit.exitCode !== 0) throw new Error(`Could not create Task fixture commit: ${commit.stderr}`);
}

class FakeAgentRuntime implements AgentRuntime {
  readonly calls: Array<{ phase: string; role: string; taskId?: string; targetBranch?: string }> = [];
  active = 0;
  maxActive = 0;

  private readonly runs = new Map<string, { request: FakeRequest; run: AgentRun }>();
  private activeChildDevelopers = 0;
  private readonly parallelChildWaiters: Array<() => void> = [];
  private readonly completion?: DatabaseCompletionStore;
  private readonly db: Database | undefined;

  constructor(db?: Database) {
    this.db = db;
    if (db) this.completion = new DatabaseCompletionStore(db);
  }

  async startRun(run: AgentRun): Promise<void> {
    if (this.db) markFakeRunNeverLaunched(this.db, run.id);
    const phase = this.db?.get<{ phase: string; task_id: string | null; request_json: string | null }>(
      "SELECT phase,task_id,request_json FROM orchestration_phase_runs WHERE agent_run_id=$runId",
      { runId: run.id },
    );
    const integration = this.db?.get<{ id: string; target_branch: string; expected_target_sha: string; source_sha: string }>(
      "SELECT id,target_branch,expected_target_sha,source_sha FROM integration_attempts WHERE integration_run_id=$runId",
      { runId: run.id },
    );
    const request: FakeRequest = phase?.request_json
      ? JSON.parse(phase.request_json) as FakeRequest
      : {
          phase: phase?.phase ?? "integration",
          role: run.role.toLowerCase(),
          ...(phase?.task_id ? { taskId: phase.task_id } : {}),
        };
    if (integration) {
      request.integration = integration;
      request.targetBranch ??= integration.target_branch;
    }
    this.runs.set(run.id, { request, run });
    this.calls.push(request);
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    if (request.phase === "child_task" && request.role === "developer") {
      this.activeChildDevelopers++;
      if (this.activeChildDevelopers >= 2) this.parallelChildWaiters.splice(0).forEach((release) => release());
    }
  }
  async runResult(runId: string): Promise<RunOutcome> {
    const record = this.runs.get(runId)!;
    const request = record.request;
    if (request.phase === "child_task" && request.role === "developer" && request.taskId && this.hasRunnableSibling(request.taskId)) {
      await this.waitForParallelChild();
    }
    this.active--;
    if (request.phase === "child_task" && request.role === "developer") this.activeChildDevelopers--;
    if (request.role === "developer" && request.taskId) {
      await commitTaskFixtureChange(this.db!, runId, request.taskId);
    }
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
              : request.role === "integration"
                ? (() => {
                    const attempt = request.integration;
                    if (!attempt) throw new Error(`No persisted integration attempt for run ${runId}`);
                    return {
                      ...common,
                      outcome: "PASS",
                      baseSha: attempt.expected_target_sha,
                      sourceSha: attempt.source_sha,
                      provenance: [`integration_attempt:${attempt.id}`],
                      evidence: ["Verified the prepared source SHA in the integration worktree"],
                    };
                  })()
                : { ...common, outcome: "PASS", evidence: ["fake-integration"] };
    if (!this.completion || !record.run.capabilityRef) throw new Error("fake runtime is not connected to a database");
    const accepted = await this.completion.accept(record.run.capabilityRef, { runId, role: record.run.role, output });
    if (!accepted) throw new Error("fake completion was rejected");
    return { success: true, exitCode: 0, output: JSON.stringify(output), validatedSubmission: true, diagnostics: { runId, sessionId: null, stderr: "", exitCode: 0, artifactReferences: [] } };
  }
  async resumeRun(): Promise<void> { }
  async cancelRun(): Promise<void> { }
  async inspectRun(): Promise<AgentRun> { throw new Error("Inspect not implemented"); }
  async collectResult(runId: string): Promise<RunOutcome> { return this.runResult(runId); }
  async collectUsage(): Promise<{ inputTokens: number; cachedInputTokens: number; outputTokens: number; cost: number }> { return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, cost: 0.25 }; }
  async healthCheck(): Promise<boolean> { return true; }

  private hasRunnableSibling(taskId: string): boolean {
    const epic = this.db?.get<{ epic_id: string | null }>("SELECT epic_id FROM tasks WHERE id=$taskId", { taskId });
    if (!epic?.epic_id) return false;
    return (this.db?.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM tasks sibling
        WHERE sibling.epic_id=$epicId AND sibling.id<>$taskId AND sibling.status='READY'
          AND NOT EXISTS (
            SELECT 1 FROM dependencies d JOIN tasks blocked ON blocked.id=d.depends_on_task_id
             WHERE d.task_id=sibling.id AND d.type='BLOCKING'
               AND blocked.status NOT IN ('INTEGRATED_INTO_EPIC','RELEASED')
          )`,
      { epicId: epic.epic_id, taskId },
    )?.count ?? 0) > 0;
  }

  private waitForParallelChild(): Promise<void> {
    if (this.activeChildDevelopers >= 2) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = this.parallelChildWaiters.indexOf(release);
        if (index >= 0) this.parallelChildWaiters.splice(index, 1);
        reject(new Error("parallel Epic child Run was not dispatched while a sibling was runnable"));
      }, 5_000);
      const release = () => {
        clearTimeout(timeout);
        resolve();
      };
      this.parallelChildWaiters.push(release);
    });
  }
}

describe("full epic orchestration with FakeAgentRuntime", () => {
  let db: Database | undefined;
  let directory = "";
  let repoPath = "";

  afterEach(async () => {
    db?.close();
    db = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function initializeRepository(): Promise<{ git: GitCli; repoPath: string }> {
    repoPath = join(directory, "repository");
    await mkdir(repoPath, { recursive: true });
    await mkdir(join(repoPath, ".ebb-orchestrator"), { recursive: true });
    const git = new GitCli();
    await git.run(repoPath, ["init", "--initial-branch=master"]);
    await git.run(repoPath, ["config", "user.email", "fixture@example.invalid"]);
    await git.run(repoPath, ["config", "user.name", "E2E Fixture"]);
    await writeFile(join(repoPath, "README.md"), "base\n");
    await git.run(repoPath, ["add", "README.md"]);
    await git.run(repoPath, ["commit", "-m", "base"]);
    return { git, repoPath };
  }

  function executionDependencies(git: GitCli) {
    const epicWorktreeRoot = join(directory, "epic-worktrees");
    const taskWorktreeRoot = join(directory, "task-worktrees");
    const integrationWorktreeRoot = join(directory, "integration-worktrees");
    return {
      integrationWorktreeRoot,
      integrationServiceFactory: ({ worktreeRoot, integrationRunId }: { worktreeRoot: string; integrationRunId: string }) =>
        new IntegrationService({
          database: db!,
          worktreeDir: worktreeRoot,
          provenanceDatabasePath: join(repoPath, ".ebb-orchestrator", "provenance.db"),
          integrationRunId,
        }),
      epicWorkspaceProvisioner: new EpicWorkspaceProvisioner({ database: db!, worktreeDir: epicWorktreeRoot, git }),
      taskWorkspaceProvisioner: new TaskWorkspaceProvisioner({
        database: db!,
        worktreeManager: new WorktreeManager({ db: db!, git, worktreeDir: taskWorktreeRoot }),
      }),
    };
  }

  async function seedEpicBranch(planId: string, planning: PlanningService, dependencies: ReturnType<typeof executionDependencies>, git: GitCli): Promise<void> {
    planning.approvePlan(planId, "user");
    const epic = db!.get<{ epic_id: string }>("SELECT epic_id FROM planning_plans WHERE id=$id", { id: planId });
    if (!epic?.epic_id) throw new Error("Approved fixture plan did not materialize an Epic");
    const worktree = await dependencies.epicWorkspaceProvisioner.provisionForEpic(epic.epic_id);
    await writeFile(join(worktree.path, "epic-fixture.txt"), "deterministic Epic source commit\n");
    await git.run(worktree.path, ["add", "epic-fixture.txt"]);
    const commit = await git.run(worktree.path, ["commit", "-m", "seed Epic integration fixture"]);
    if (commit.exitCode !== 0) throw new Error(`Could not seed Epic fixture commit: ${commit.stderr}`);
  }

  it("reconciles stale orchestration runs before releasing scheduler capacity", async () => {
    directory = await mkdtemp(join(tmpdir(), "orchestrator-stale-reconcile-"));
    db = createSqliteDatabase(join(directory, "test.db"));
    runMigrations(db, loadTestMigrations());
    const projectId = randomUUID();
    const epicId = randomUUID();
    const runId = randomUUID();
    const now = new Date().toISOString();
    db.run("INSERT INTO projects (id,name,display_name,status,created_at,updated_at) VALUES ($id,'stale','Stale','ACTIVE',$now,$now)", { id: projectId, now });
    db.run("INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,created_at) VALUES($approvalId,'WORKFLOW_CHANGE',$id,'PROJECT','APPROVED','test',$now)", { approvalId: `${projectId}-onboarding`, id: projectId, now });
    db.run("INSERT INTO onboarding_configs(project_id,repository_path,facts_json,proposed_json,status,approval_id,created_at,updated_at) VALUES($id,'/repo','{}','{}','ACTIVE',$approvalId,$now,$now)", { id: projectId, approvalId: `${projectId}-onboarding`, now });
    db.run("INSERT INTO epics (id,project_id,display_id,title,status,contract_json,created_at,updated_at) VALUES ($id,$projectId,'EPIC-STALE','Stale','IN_PROGRESS','{}',$now,$now)", { id: epicId, projectId, now });
    db.exec("CREATE TABLE IF NOT EXISTS agent_runs (id TEXT PRIMARY KEY, role TEXT NOT NULL, runtime TEXT NOT NULL, model TEXT NOT NULL, task_id TEXT, epic_id TEXT, status TEXT NOT NULL, started_at TEXT, ended_at TEXT, exit_code INTEGER, output TEXT, cost REAL)");
    db.exec("CREATE TABLE IF NOT EXISTS orchestration_phase_runs (id TEXT PRIMARY KEY, epic_id TEXT, task_id TEXT, phase TEXT NOT NULL, role TEXT NOT NULL, agent_run_id TEXT NOT NULL UNIQUE, result_json TEXT NOT NULL DEFAULT '{}', evidence_json TEXT NOT NULL DEFAULT '{}', validated INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'INTENT', request_json TEXT, started_at TEXT, ended_at TEXT, created_at TEXT NOT NULL, UNIQUE (epic_id, task_id, phase))");
    db.run("INSERT INTO agent_runs (id,role,runtime,model,epic_id,status,started_at) VALUES ($id,'reviewer','test','test',$epicId,'STARTED',$now)", { id: runId, epicId, now });
    db.transaction((tx) => insertRunProcessOwnerTx(tx, prepareRunProcessOwner(
      runId,
      join(directory, "test-hermes-home", runId),
      process.platform === "win32" ? "windows-job" : "systemd-user-service",
    )));
    db.run("INSERT INTO orchestration_phase_runs (id,epic_id,phase,role,agent_run_id,status,started_at,created_at) VALUES ($id,$epicId,'epic_review','reviewer',$runId,'INTENT',$now,$now)", { id: randomUUID(), epicId, runId, now });
    ;
    ;
    ;
    db.run("INSERT INTO scheduler_budgets (project_id,limit_cost,spent_cost,reserved_cost) VALUES ($projectId,10,0,1)", { projectId });
    const reservationId = randomUUID();
    db.run("INSERT INTO scheduler_reservations (id,kind,subject_id,project_id,owner_id,reserved_at,estimate_cost,status,role,model,run_id) VALUES ($id,'PHASE',$runId,$projectId,$owner,$now,1,'RESERVED','reviewer','test',$runId)", { id: reservationId, runId, projectId, owner: `run:${runId}`, now });
    db.run("INSERT INTO scheduler_resource_locks (resource_key,reservation_id,project_id,owner_id,locked_at) VALUES ('global',$id,$projectId,$owner,$now)", { id: reservationId, projectId, owner: `run:${runId}`, now });

    const registry = new WorkflowRegistry();
    for (const template of Object.values(templates)) registry.register(template);
    const scheduler = new SchedulerService(db);
    const runService = new RunService(db, new FakeAgentRuntime(db));
    const orchestrator = new EpicOrchestrator(db, new WorkflowEngine(db, registry), new PlanningService(db), runService, {} as never, scheduler);

    expect(db.get<{ status: string }>("SELECT status FROM agent_runs WHERE id=$id", { id: runId })?.status).toBe("STARTED");
    expect(db.get<{ status: string }>("SELECT status FROM scheduler_reservations WHERE id=$id", { id: reservationId })?.status).toBe("RESERVED");

    await preflightRunProcessOwners(db, {
      launch: async () => { throw new Error("prepared owners must not launch during recovery"); },
      inspect: async () => { throw new Error("prepared owners must not require OS inspection"); },
      stop: async () => { throw new Error("prepared owners must not stop during recovery"); },
      waitForStopped: async () => { throw new Error("prepared owners must not poll during recovery"); },
    } as ProcessScopeSupervisor);
    expect(db.get<{ state: string; stop_evidence: string }>("SELECT state,stop_evidence FROM run_process_owners WHERE run_id=$id", { id: runId }))
      .toEqual({ state: "STOPPED", stop_evidence: "NEVER_LAUNCHED" });
    expect(runService.reconcileInterruptedRuns()).toBe(1);
    orchestrator.reconcileInterruptedRuns();
    expect(scheduler.reconcile().releasedReservationIds).toContain(reservationId);

    expect(db.get<{ status: string }>("SELECT status FROM agent_runs WHERE id=$id", { id: runId })?.status).toBe("FAILED");
    expect(db.get<{ status: string }>("SELECT status FROM orchestration_phase_runs WHERE agent_run_id=$runId", { runId })?.status).toBeUndefined();
    expect(db.get<{ status: string }>("SELECT status FROM scheduler_reservations WHERE id=$id", { id: reservationId })?.status).toBe("RELEASED");
    expect(db.get<{ reserved_cost: number }>("SELECT reserved_cost FROM scheduler_budgets WHERE project_id=$projectId", { projectId })?.reserved_cost).toBe(0);
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduler_resource_locks WHERE reservation_id=$id", { id: reservationId })?.count).toBe(0);

    expect(() => scheduler.dispatchAgentRun("retry-run", projectId, "reviewer", "test")).not.toThrow();
    scheduler.releaseAgentRun("retry-run", 0);
    expect(db.get<{ reserved_cost: number }>("SELECT reserved_cost FROM scheduler_budgets WHERE project_id=$projectId", { projectId })?.reserved_cost).toBe(0);
  });

  it("runs plan → PM → Architect → parallel children → final validation and releases children last", async () => {
    directory = await mkdtemp(join(tmpdir(), "orchestrator-epic-e2e-"));
    db = createSqliteDatabase(join(directory, "test.db"));
    runMigrations(db, loadTestMigrations());
    ;
    const { git, repoPath: repositoryPath } = await initializeRepository();
    const projectId = randomUUID();
    const now = new Date().toISOString();
    db.run("INSERT INTO projects (id,name,display_name,status,created_at,updated_at) VALUES ($id,'demo','Demo','ACTIVE',$now,$now)", { id: projectId, now });
    db.run("INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,created_at) VALUES($approvalId,'WORKFLOW_CHANGE',$id,'PROJECT','APPROVED','test',$now)", { approvalId: `${projectId}-onboarding`, id: projectId, now });
    db.run("INSERT INTO onboarding_configs(project_id,repository_path,facts_json,proposed_json,status,approval_id,created_at,updated_at) VALUES($id,$repoPath,$facts,$proposed,'ACTIVE',$approvalId,$now,$now)", { id: projectId, repoPath: repositoryPath, facts: JSON.stringify({ defaultBranch: "master" }), proposed: JSON.stringify({ defaultBranch: "master" }), approvalId: `${projectId}-onboarding`, now });
    seedApprovedProjectConfig(db, projectId, "master");
    const registry = new WorkflowRegistry();
    for (const template of Object.values(templates)) registry.register(template);
const runtime = new FakeAgentRuntime(db);
  // E2E использует production MergeService. IntegrationService владеет схемой
  // provenance; синтетическая запись журнала VERIFIED здесь не добавляется.
     const planning = new PlanningService(db);
     const dependencies = executionDependencies(git);
     const merge = new MergeService({ database: db, repoPath: repositoryPath, targetBranch: "master" });
     const orchestrator = new EpicOrchestrator(db, new WorkflowEngine(db, registry), planning, new RunService(db, runtime), merge, new SchedulerService(db), dependencies);
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
    await seedEpicBranch(plan.id, planning, dependencies, git);
    const pending = await orchestrator.approveAndRun(plan.id, "user");

    expect(pending.sequence).toEqual([
      "plan", "pm", "architect", "task_1", "task_2", "task_3", "epic_review",
      "architecture_review", "epic_qa", "integration", "final_approval",
    ]);
    expect(runtime.maxActive, JSON.stringify({
      calls: runtime.calls,
      runs: db.all<{ id: string; role: string; task_id: string | null; status: string }>(
        "SELECT id,role,task_id,status FROM agent_runs WHERE epic_id=$epicId ORDER BY started_at,id", { epicId: pending.epicId },
      ),
      phases: db.all<{ phase: string; role: string; task_id: string | null; status: string }>(
        `SELECT pr.phase,pr.role,pr.task_id,pr.status
           FROM orchestration_phase_runs pr WHERE pr.epic_id=$epicId ORDER BY pr.created_at,pr.id`, { epicId: pending.epicId },
      ),
      reservations: db.all<{ run_id: string | null; role: string; status: string }>(
        "SELECT run_id,role,status FROM scheduler_reservations WHERE project_id=$projectId ORDER BY reserved_at,id", { projectId },
      ),
    })).toBe(2);
    expect(runtime.calls.filter((call) => call.taskId).every((call) => call.targetBranch === "epic/EPIC-1")).toBe(true);
    expect(pending.finalApprovalRequired).toBe(true);
    expect(pending.childStatuses.every((status) => status === "INTEGRATED_INTO_EPIC")).toBe(true);
    expect(db.get<{ status: string }>("SELECT status FROM epics LIMIT 1")?.status).toBe("IN_PROGRESS");
    expect(db.get<{ plan_id: string; stage: string }>("SELECT plan_id, stage FROM epic_orchestrations WHERE epic_id=$epicId", { epicId: pending.epicId })).toEqual({ plan_id: plan.id, stage: "FINAL_APPROVAL" });
    expect(db.get<{ subject_id: string; subject_type: string }>("SELECT subject_id, subject_type FROM approvals WHERE id=$id", { id: pending.finalApprovalId! })).toEqual({ subject_id: pending.epicId, subject_type: "EPIC" });
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM orchestration_phase_runs WHERE epic_id=$epicId AND validated=1", { epicId: pending.epicId })?.count).toBe(runtime.calls.length);
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM agent_runs WHERE epic_id=$epicId", { epicId: pending.epicId })?.count).toBe(runtime.calls.length);
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM agent_runs WHERE epic_id=$epicId AND status='COMPLETED' AND output IS NOT NULL", { epicId: pending.epicId })?.count).toBe(runtime.calls.length);
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM agent_runs ar JOIN orchestration_phase_runs pr ON pr.agent_run_id=ar.id WHERE pr.epic_id=$epicId AND pr.validated=1", { epicId: pending.epicId })?.count).toBe(runtime.calls.length);
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduler_reservations WHERE run_id IS NOT NULL AND run_id NOT IN (SELECT agent_run_id FROM orchestration_phase_runs)")?.count).toBe(0);
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduler_reservations WHERE status='RESERVED'")?.count).toBe(0);
    expect(db.get<{ spent_cost: number }>("SELECT spent_cost FROM scheduler_budgets WHERE project_id=$projectId", { projectId })?.spent_cost ?? 0).toBeCloseTo(runtime.calls.length * 0.25);
    const callsBeforeRestart = runtime.calls.length;
    const resumed = await orchestrator.approveAndRun(plan.id, "user");
    expect(resumed.finalApprovalId).toBe(pending.finalApprovalId);
    expect(runtime.calls.length).toBe(callsBeforeRestart);
    await expect(orchestrator.approveFinalMergeAsync(pending.epicId, pending.finalApprovalId!)).rejects.toThrow("Invalid approval status: PENDING. Expected APPROVED.");
    expect(db.get<{ status: string }>("SELECT status FROM epics LIMIT 1")?.status).toBe("IN_PROGRESS");
  });

  it("merges an actual verified Integration attempt and releases children only after final approval", async () => {
    directory = await mkdtemp(join(tmpdir(), "orchestrator-epic-merge-e2e-"));
    db = createSqliteDatabase(join(directory, "test.db"));
    runMigrations(db, loadTestMigrations());
    const { git, repoPath: repositoryPath } = await initializeRepository();
    const masterSha = (await git.run(repositoryPath, ["rev-parse", "master"])).stdout.trim();

    const projectId = randomUUID();
    const now = new Date().toISOString();
    db.run("INSERT INTO projects (id,name,display_name,status,created_at,updated_at) VALUES ($id,'merge','Merge','ACTIVE',$now,$now)", { id: projectId, now });
    db.run("INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,created_at) VALUES($approvalId,'WORKFLOW_CHANGE',$id,'PROJECT','APPROVED','test',$now)", { approvalId: `${projectId}-onboarding`, id: projectId, now });
    db.run("INSERT INTO onboarding_configs(project_id,repository_path,facts_json,proposed_json,status,approval_id,created_at,updated_at) VALUES($id,$repoPath,$facts,$proposed,'ACTIVE',$approvalId,$now,$now)", { id: projectId, repoPath: repositoryPath, facts: JSON.stringify({ defaultBranch: "master" }), proposed: JSON.stringify({ defaultBranch: "master" }), approvalId: `${projectId}-onboarding`, now });
    seedApprovedProjectConfig(db, projectId, "master");
    const registry = new WorkflowRegistry();
    for (const template of Object.values(templates)) registry.register(template);
const runtime = new FakeAgentRuntime(db);
     const planning = new PlanningService(db);
     const merge = new MergeService({ database: db, repoPath: repositoryPath, targetBranch: "master" });
     const dependencies = executionDependencies(git);
     const orchestrator = new EpicOrchestrator(db, new WorkflowEngine(db, registry), planning, new RunService(db, runtime), merge, new SchedulerService(db), dependencies);
     db.run("INSERT INTO scheduler_budgets (project_id,limit_cost,spent_cost,reserved_cost) VALUES ($projectId,100,0,0)", { projectId });
    const plan = await orchestrator.start({ projectId, requestedBy: "user", tasks: [{ ref: "task_1", title: "Foundation", acceptanceCriteria: ["works"], role: "developer", workflow: "standard" }], epic: { title: "Merge epic", goal: "Merge" } });
    await seedEpicBranch(plan.id, planning, dependencies, git);
    const sourceSha = (await git.run(repositoryPath, ["rev-parse", "epic/EPIC-1"])).stdout.trim();

    const pending = await orchestrator.approveAndRun(plan.id, "user");
    const approval = new ApprovalService(db).approve(pending.finalApprovalId!, "user");
    const integrationRun = db.get<{ agent_run_id: string }>("SELECT agent_run_id FROM orchestration_phase_runs WHERE epic_id=$epicId AND task_id IS NULL AND phase='integration'", { epicId: pending.epicId })!;
    const integration = db.get<{ id: string; integration_run_id: string; source_sha: string; expected_target_sha: string; status: string }>("SELECT id,integration_run_id,source_sha,expected_target_sha,status FROM integration_attempts WHERE integration_run_id=$runId", { runId: integrationRun.agent_run_id });
    expect(integration).toMatchObject({ integration_run_id: integrationRun.agent_run_id, source_sha: sourceSha, expected_target_sha: masterSha, status: "MERGED" });
    const result = await orchestrator.approveFinalMergeAsync(pending.epicId, approval.id);
    expect(result.pendingFinalApproval).toBe(false);
    const operation = db.get<{ status: string; approval_id: string; source_sha: string; expected_target_sha: string; resulting_target_sha: string; target_ref: string; branch_name: string }>("SELECT status,approval_id,source_sha,expected_target_sha,resulting_target_sha,target_ref,branch_name FROM git_operations WHERE type='MERGE' ORDER BY verified_at DESC LIMIT 1");
    expect(operation).toMatchObject({ status: "VERIFIED", approval_id: approval.id, source_sha: sourceSha, expected_target_sha: masterSha, target_ref: "master", branch_name: "epic/EPIC-1" });
    expect(operation!.resulting_target_sha).toBe(await git.run(repositoryPath, ["rev-parse", "master"]).then((result) => result.stdout.trim()));
    expect(operation!.resulting_target_sha).not.toBe(masterSha);
    expect(db.get<{ integration_run_id: string; source_sha: string; expected_target_sha: string; target_branch: string }>("SELECT integration_run_id,source_sha,expected_target_sha,target_branch FROM integration_attempts WHERE integration_run_id=$runId", { runId: integrationRun.agent_run_id })).toMatchObject({ integration_run_id: integrationRun.agent_run_id, source_sha: sourceSha, expected_target_sha: masterSha, target_branch: "master" });
    expect(db.get<{ status: string }>("SELECT status FROM epics WHERE id=$id", { id: pending.epicId })?.status).toBe("DONE");
    expect(db.all<{ status: string }>("SELECT status FROM tasks WHERE epic_id=$id", { id: pending.epicId }).every((row) => row.status === "RELEASED")).toBe(true);
  });
});
