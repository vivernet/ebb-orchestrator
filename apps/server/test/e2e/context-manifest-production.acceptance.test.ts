import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntime } from "../../src/modules/runtime/agent-runtime.js";
import type { AgentRun } from "@ebb-orchestrator/contracts";
import type { RunOutcome } from "../../src/modules/runtime/run-types.js";
import { RunService, createRunContextInput, taskDeveloperPrompt } from "../../src/modules/runtime/run-service.js";
import { RunContextAssembler } from "../../src/modules/runtime/run-context-assembler.js";
import { digestRunPromptBytesV1 } from "../../src/modules/context/context-provenance.js";
import { createApp } from "../../src/app/create-app.js";
import { ApprovalService } from "../../src/modules/approvals/approval-service.js";
import { ProjectConfigRepository } from "../../src/modules/projects/project-config-repository.js";
import { ProjectConfigService } from "../../src/modules/projects/project-config-service.js";
import { parseProjectConfigYaml } from "../../src/platform/config/project-config.js";
import { createSqliteDatabase } from "../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../src/platform/database/migrator.js";
import type { Database } from "../../src/platform/database/database.js";
import { loadTestMigrations } from "../helpers/migrations.js";
import { createTestAuthService, TEST_COOKIE, TEST_CSRF_TOKEN } from "../helpers/auth.js";
import { WorkflowEngine } from "../../src/modules/workflow/workflow-engine.js";
import { WorkflowRegistry } from "../../src/modules/workflow/workflow-registry.js";
import { templates } from "../../src/modules/workflow/templates.js";
import { PlanningService } from "../../src/modules/planning/planning-service.js";
import { EpicOrchestrator, type IntegrationServiceFactory, type IntegrationServiceFactoryContext } from "../../src/modules/planning/epic-orchestrator.js";
import { DatabaseCompletionStore } from "../../src/modules/execution/mcp/submit-result-tool.js";
import { SchedulerService } from "../../src/modules/scheduler/scheduler-service.js";
import type { IntegrationAttempt, IntegrationService } from "../../src/modules/git/integration-service.js";
import { BackgroundJobRegistry } from "../../src/platform/jobs/background-job-registry.js";
import { JobRunner } from "../../src/platform/jobs/job-runner.js";
import { registerCoordinatorPlanningJob } from "../../src/modules/planning/coordinator-planning-job.js";
import { EpicWorkspaceProvisioner } from "../../src/modules/git/epic-workspace-provisioner.js";
import { TaskWorkspaceProvisioner } from "../../src/modules/git/task-workspace-provisioner.js";
import { WorktreeManager } from "../../src/modules/git/worktree-manager.js";
import { RuntimeEventHandlers } from "../../src/modules/runtime/run-event-handlers.js";

let runtimeStarts = 0;

describe("production context manifest acceptance", () => {
  let db: Database | undefined;
  let app: ReturnType<typeof createApp> | undefined;
  let root = "";
  let workspace = "";
  const dispatchTask = vi.fn();

  afterEach(async () => {
    await app?.close();
    db?.close();
    app = undefined;
    db = undefined;
    if (root) rmSync(root, { recursive: true, force: true });
    if (workspace) rmSync(workspace, { recursive: true, force: true });
    root = "";
    workspace = "";
    runtimeStarts = 0;
    dispatchTask.mockReset();
  });

  it("rolls back Run, manifest and PREPARED owner for manifest or owner insert failures before Task dispatch", async () => {
    const fixture = setup();
    const triggers = [
      ["fail_context_manifest_insert", "context_manifests"],
      ["fail_run_owner_insert", "run_process_owners"],
    ] as const;

    for (const [trigger, table] of triggers) {
      db!.run(`CREATE TRIGGER ${trigger} BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'injected_${trigger}'); END`);
      const response = await fixture.app.inject({
        method: "POST", url: "/api/v1/tasks/task-acceptance/dispatch",
        headers: { cookie: TEST_COOKIE, origin: "http://127.0.0.1:3000", "x-csrf-token": TEST_CSRF_TOKEN },
      });
      expect(response.statusCode).not.toBe(202);
      expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM agent_runs")?.count).toBe(0);
      expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM context_manifests")?.count).toBe(0);
      expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM run_process_owners")?.count).toBe(0);
      expect(dispatchTask).not.toHaveBeenCalled();
      expect(runtimeStarts).toBe(0);
      db!.run(`DROP TRIGGER ${trigger}`);
    }

    expect(fixture.app).toBeDefined();
  });

  it("rejects a context projection that changes inside its preparation transaction", () => {
    setup();
    const service = new RunService(db!, makeRuntime());
    const options = taskRunOptions();
    const contextInput = createRunContextInput(options, {
      prompt: taskDeveloperPrompt(),
      roleInputs: {},
      workspaceIdentity: { repository: workspace, workspace, worktree: "task-acceptance" },
      targetHead: null,
      targetBranch: null,
    });

    expect(() => db!.transaction((tx) => {
      const prepared = new RunContextAssembler().prepare(tx, contextInput);
      tx.run("UPDATE tasks SET contract_json=$contract WHERE id='task-acceptance'", {
        contract: JSON.stringify({ version: 1, goal: "changed after assembly", context: "test", requirements: [], acceptanceCriteria: [], dependencies: [], nonGoals: [], definitionOfDone: [] }),
      });
      return service.prepareRunInTransaction(tx, { ...options, prompt: prepared.finalPrompt, contextInput }, prepared);
    })).toThrow(/PREPARED_CONTEXT_CHANGED_WITHIN_TRANSACTION/);

    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM agent_runs")?.count).toBe(0);
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM context_manifests")?.count).toBe(0);
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM run_process_owners")?.count).toBe(0);
    expect(db!.get<{ contract_json: string }>("SELECT contract_json FROM tasks WHERE id='task-acceptance'")?.contract_json)
      .toContain("persisted task contract");
    expect(runtimeStarts).toBe(0);
  });

  it("persists exact final prompt bytes, context manifest and owner before a production Task route dispatch", async () => {
    const fixture = setup();
    const expectedPrompt = taskDeveloperPrompt();
    const targetHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8", windowsHide: true }).trim();
    const targetBranch = execFileSync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: workspace, encoding: "utf8", windowsHide: true }).trim();
    const expectedOptions = {
      role: "developer", model: "default", taskId: "task-acceptance", epicId: null,
      triggerReason: "runtime-request", contextVersion: "runtime-request-v1", outputSchemaVersion: "1",
      capability: { workspace },
    } as const;
    const expectedContext = new RunContextAssembler().prepare(db!, createRunContextInput(expectedOptions, {
      prompt: expectedPrompt,
      workspaceIdentity: { repository: workspace, workspace, worktree: "task-acceptance" },
      targetHead, targetBranch,
    }));
    const response = await fixture.app.inject({
      method: "POST", url: "/api/v1/tasks/task-acceptance/dispatch",
      headers: { cookie: TEST_COOKIE, origin: "http://127.0.0.1:3000", "x-csrf-token": TEST_CSRF_TOKEN },
    });
    expect(response.statusCode, response.body).toBe(202);
    const run = db!.get<{ id: string; prompt: string }>("SELECT id,prompt FROM agent_runs WHERE task_id='task-acceptance'");
    if (!run) throw new Error("Task dispatch did not persist an agent run");
    expect(run.prompt).toBe(expectedContext.finalPrompt);
    const manifest = db!.get<{ prompt_hash: string; initial_token_size: number | null; role: string }>(
      "SELECT prompt_hash,initial_token_size,role FROM context_manifests WHERE run_id=$runId", { runId: run.id },
    );
    expect(manifest).toEqual({ prompt_hash: digestRunPromptBytesV1(new TextEncoder().encode(run.prompt)), initial_token_size: null, role: "developer" });
    expect(db!.get<{ source_tag: string; state: string }>("SELECT source_tag,state FROM run_process_owners WHERE run_id=$runId", { runId: run.id }))
      .toEqual({ source_tag: `ebb-run:${run.id}`, state: "PREPARED" });
    expect(dispatchTask).toHaveBeenCalledTimes(1);
  });

  it("persists the AgentRunRequested manifest and PREPARED owner before scheduler dispatch", async () => {
    setup();
    const eventPath = createEventPath();

    await eventPath.handlers.handleAgentRunRequested({
      type: "AgentRunRequested",
      aggregateId: "task-acceptance",
      payload: { role: "developer", model: "acceptance-model" },
    });

    expect(eventPath.dispatchSpy).toHaveBeenCalledTimes(1);
    expect(runtimeStarts).toBe(1);
    expect(db!.get<{ status: string }>("SELECT status FROM agent_runs WHERE task_id='task-acceptance'"))
      .toEqual({ status: "COMPLETED" });
  });

  it.each([
    ["context_manifests", "fail_event_manifest_insert"],
    ["run_process_owners", "fail_event_owner_insert"],
  ] as const)("rolls back AgentRunRequested preparation when %s insertion fails", async (table, trigger) => {
    setup();
    const eventPath = createEventPath();
    db!.run(`CREATE TRIGGER ${trigger} BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'injected_${trigger}'); END`);

    await expect(eventPath.handlers.handleAgentRunRequested({
      type: "AgentRunRequested",
      aggregateId: "task-acceptance",
      payload: { role: "developer", model: "acceptance-model" },
    })).rejects.toThrow();

    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM agent_runs")?.count).toBe(0);
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM context_manifests")?.count).toBe(0);
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM run_process_owners")?.count).toBe(0);
    expect(eventPath.dispatchSpy).not.toHaveBeenCalled();
    expect(runtimeStarts).toBe(0);
  });

  it("creates the full 4/6/3 subject-role matrix through production Task, Epic and Request entrypoints", async () => {
    const fixture = setup();
    const runtime = new MatrixRuntime(db!);
    const runService = new RunService(db!, runtime);
    const runtimeApp = createApp({ db: db!, scheduler: {
      assertProjectDispatchable: vi.fn(), dispatchTask: vi.fn(), releaseTask: vi.fn(),
      projectProjection: vi.fn(() => ({ global: { active: 0, max: 1 }, projects: [] })),
    } as never, runService, runtime, authService: createTestAuthService() });
    await fixture.app.close();
    app = runtimeApp;

    const taskRunIds: string[] = [];
    for (const role of ["developer", "reviewer", "qa"] as const) {
      const response = await runtimeApp.inject({
        method: "POST", url: "/api/v1/tasks/task-acceptance/dispatch",
        headers: { cookie: TEST_COOKIE, origin: "http://127.0.0.1:3000", "x-csrf-token": TEST_CSRF_TOKEN },
        payload: { role },
      });
      expect(response.statusCode, response.body).toBe(202);
      taskRunIds.push((response.json() as { runId: string }).runId);
    }

    const epic = await seedEpicMatrixFixture(db!, root);
    const integrationAttempts: IntegrationAttempt[] = [];
    const factory: IntegrationServiceFactory = (context) => createMatrixIntegrationService(db!, root, context, integrationAttempts);
    const registry = new WorkflowRegistry();
    for (const template of Object.values(templates)) registry.register(template);
    const scheduler = new SchedulerService(db!);
    const orchestrator = new EpicOrchestrator(
      db!, new WorkflowEngine(db!, registry), new PlanningService(db!), runService,
      {} as never, scheduler,
      {
        integrationServiceFactory: factory,
        integrationWorktreeRoot: join(root, "integration-worktrees"),
        epicWorkspaceProvisioner: new EpicWorkspaceProvisioner({ database: db!, worktreeDir: join(root, "epic-worktrees") }),
        taskWorkspaceProvisioner: new TaskWorkspaceProvisioner({
          database: db!, worktreeManager: new WorktreeManager({ db: db!, worktreeDir: join(root, "task-worktrees") }),
        }),
      },
    );
    const runPhase = (orchestrator as unknown as {
      runPhase(epicId: string, taskId: string | undefined, phase: string, role: string, request: unknown): Promise<{ accepted: boolean }>;
    }).runPhase.bind(orchestrator);

    const epicRoles = [
      ["epic-plan", "coordinator"], ["epic-pm", "product_manager"], ["epic-architect", "architect"],
      ["epic-review", "reviewer"], ["epic-qa", "qa"],
    ] as const;
    const epicRunIds: string[] = [];
    for (const [phase, role] of epicRoles) {
      const result = await runPhase(epic.epicId, undefined, phase, role, { phase, role, epicId: epic.epicId });
      expect(result.accepted).toBe(true);
      const row = db!.get<{ agent_run_id: string }>(
        "SELECT agent_run_id FROM orchestration_phase_runs WHERE epic_id=$epicId AND task_id IS NULL AND phase=$phase",
        { epicId: epic.epicId, phase },
      );
      expect(row?.agent_run_id).toBeTruthy();
      epicRunIds.push(row!.agent_run_id);
    }

    const taskIntegration = await runPhase(epic.epicId, epic.taskId, "integration", "integration", {
      phase: "integration", role: "integration", taskId: epic.taskId, epicId: epic.epicId,
    });
    expect(taskIntegration.accepted).toBe(true);
    const taskIntegrationRunId = db!.get<{ agent_run_id: string }>(
      "SELECT agent_run_id FROM orchestration_phase_runs WHERE epic_id=$epicId AND task_id=$taskId AND phase='integration'",
      { epicId: epic.epicId, taskId: epic.taskId },
    )?.agent_run_id;
    expect(taskIntegrationRunId).toBeTruthy();

    const epicIntegration = await runPhase(epic.epicId, undefined, "integration", "integration", {
      phase: "integration", role: "integration", epicId: epic.epicId,
    });
    expect(epicIntegration.accepted).toBe(true);
    const epicIntegrationRunId = db!.get<{ agent_run_id: string }>(
      "SELECT agent_run_id FROM orchestration_phase_runs WHERE epic_id=$epicId AND task_id IS NULL AND phase='integration'",
      { epicId: epic.epicId },
    )?.agent_run_id;
    expect(epicIntegrationRunId).toBeTruthy();
    epicRunIds.push(epicIntegrationRunId!);

    const planning = new PlanningService(db!);
    const request = planning.createQueuedRequest("project-acceptance", "Implement request-bound planning", "acceptance-user");
    const jobRegistry = new BackgroundJobRegistry();
    registerCoordinatorPlanningJob(jobRegistry, { db: db!, planning, runs: runService, scheduler });
    const jobResult = await new JobRunner(db!, jobRegistry).runOnce(new Date());
    expect(jobResult).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });

    const persisted = db!.all<{
      id: string; role: string; task_id: string | null; epic_id: string | null;
      subject_type: string; request_id: string | null; prompt: string; prompt_hash: string;
    }>(`SELECT r.id,r.role,r.task_id,r.epic_id,cm.subject_type,cm.request_id,r.prompt,cm.prompt_hash
          FROM agent_runs r JOIN context_manifests cm ON cm.run_id=r.id ORDER BY r.started_at,r.id`);
    expect(persisted).toHaveLength(13);
    expect(new Set(persisted.map((row) => row.id)).size).toBe(13);
    expect(persisted.map(({ subject_type, role }) => `${subject_type}:${role}`).sort()).toEqual([
      "EPIC:architect", "EPIC:coordinator", "EPIC:integration", "EPIC:product_manager", "EPIC:qa", "EPIC:reviewer",
      "REQUEST:architect", "REQUEST:coordinator", "REQUEST:product_manager",
      "TASK:developer", "TASK:integration", "TASK:qa", "TASK:reviewer",
    ]);
    expect(taskRunIds).toHaveLength(3);
    expect(epicRunIds).toHaveLength(6);
    expect(db!.all<{ id: string; role: string; request_id: string | null }>(
      "SELECT r.id,r.role,cm.request_id FROM agent_runs r JOIN context_manifests cm ON cm.run_id=r.id WHERE cm.subject_type='REQUEST' AND cm.request_id=$requestId",
      { requestId: request.id },
    )).toHaveLength(3);
    expect(persisted.filter((row) => row.subject_type === "TASK" && row.role === "integration"))
      .toMatchObject([{ id: taskIntegrationRunId, task_id: epic.taskId, epic_id: epic.epicId }]);
    expect(persisted.filter((row) => row.subject_type === "EPIC" && row.role === "integration"))
      .toMatchObject([{ id: epicIntegrationRunId, task_id: null, epic_id: epic.epicId }]);
    for (const row of persisted) {
      expect(row.prompt_hash).toBe(digestRunPromptBytesV1(new TextEncoder().encode(row.prompt)));
      expect(db!.get<{ source_tag: string; state: string }>(
        "SELECT source_tag,state FROM run_process_owners WHERE run_id=$runId", { runId: row.id },
      )).toEqual({ source_tag: `ebb-run:${row.id}`, state: "PREPARED" });
    }
    expect(integrationAttempts).toHaveLength(2);
  });

  function setup() {
    root = mkdtempSync(join(tmpdir(), "context-manifest-production-"));
    workspace = mkdtempSync(join(tmpdir(), "context-manifest-worktree-"));
    mkdirSync(join(workspace, ".ebb-orchestrator"), { recursive: true });
    execFileSync("git", ["init", "--quiet"], { cwd: workspace, windowsHide: true });
    execFileSync("git", ["checkout", "--quiet", "-b", "master"], { cwd: workspace, windowsHide: true });
    writeFileSync(join(workspace, "fixture.txt"), "acceptance workspace\n", "utf8");
    execFileSync("git", ["add", "fixture.txt"], { cwd: workspace, windowsHide: true });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "acceptance fixture"], { cwd: workspace, windowsHide: true });
    execFileSync("git", ["checkout", "--quiet", "-b", "task/task-acceptance"], { cwd: workspace, windowsHide: true });

    db = createSqliteDatabase(join(root, "orchestrator.sqlite"));
    runMigrations(db, loadTestMigrations());
    const now = new Date().toISOString();
    db.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES('project-acceptance','project','Project','ACTIVE',$now,$now)", { now });
    const approvalService = new ApprovalService(db);
    const onboardingApproval = approvalService.request({ type: "WORKFLOW_CHANGE", subjectId: "project-acceptance", subjectType: "PROJECT", requestedBy: "test" });
    approvalService.approve(onboardingApproval.id, "test");
    db.run("INSERT INTO onboarding_configs(project_id,repository_path,facts_json,proposed_json,status,approval_id,created_at,updated_at) VALUES('project-acceptance',$workspace,'{}',$proposed,'ACTIVE',$approvalId,$now,$now)", {
      workspace, proposed: JSON.stringify({ defaultBranch: "master" }), approvalId: onboardingApproval.id, now,
    });
    seedApprovedProjectConfig(db, "project-acceptance");
    const targetHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8", windowsHide: true }).trim();
    db.run("INSERT INTO tasks(id,project_id,display_id,title,status,contract_json,created_at,updated_at) VALUES('task-acceptance','project-acceptance','TASK-1','Acceptance Task','READY',$contract,$now,$now)", {
      contract: JSON.stringify({ version: 1, goal: "persisted task contract", context: "acceptance task context", requirements: ["manifest"], acceptanceCriteria: ["prompt is exact"], dependencies: [], nonGoals: [], definitionOfDone: ["reviewable"] }), now,
    });
    db.run("INSERT INTO worktrees(id,repo_path,path,branch,created_at) VALUES('task-acceptance',$workspace,$workspace,'task/task-acceptance',$now)", { workspace, now });
    db.run("INSERT INTO git_operations(id,type,status,repo_path,branch_name,worktree_id,target_ref,created_at,verified_at) VALUES('task-acceptance-op','CREATE_WORKTREE','VERIFIED',$workspace,'task/task-acceptance','task-acceptance','HEAD',$now,$now)", { workspace, now });
    db.run("INSERT INTO scheduler_budgets(project_id,limit_cost,spent_cost,reserved_cost) VALUES('project-acceptance',100,0,0)");

    const runtime = makeRuntime();
    const runService = new RunService(db, runtime);
    const scheduler = {
      assertProjectDispatchable: vi.fn(),
      dispatchTask,
      releaseTask: vi.fn(),
      projectProjection: vi.fn(() => ({ global: { active: 0, max: 1 }, projects: [] })),
    };
    app = createApp({ db, scheduler: scheduler as never, runService, runtime, authService: createTestAuthService() });
    expect(targetHead).toMatch(/^[a-f0-9]{40}$/i);
    return { app };
  }

  function taskRunOptions() {
    return {
      role: "developer", model: "persisted", taskId: "task-acceptance", epicId: null,
      triggerReason: "acceptance", contextVersion: "1", outputSchemaVersion: "1",
      capability: { workspace },
      prompt: taskDeveloperPrompt(),
    } as const;
  }

  function createEventPath() {
    const runtime = makeCompletionRuntime(db!);
    const runService = new RunService(db!, runtime);
    const scheduler = new SchedulerService(db!);
    const originalDispatch = scheduler.dispatchTask.bind(scheduler);
    const dispatchSpy = vi.spyOn(scheduler, "dispatchTask").mockImplementation((taskId, engine, callback, options) => {
      const runId = typeof options === "object" && options !== null ? options.runId : undefined;
      expect(runId).toBeTruthy();
      expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM agent_runs")?.count).toBe(1);
      const manifests = db!.all<{ run_id: string; subject_type: string; task_id: string | null; role: string }>(
        "SELECT run_id,subject_type,task_id,role FROM context_manifests",
      );
      expect(manifests).toEqual([{ run_id: runId, subject_type: "TASK", task_id: "task-acceptance", role: "developer" }]);
      const owners = db!.all<{ run_id: string; source_tag: string; state: string }>(
        "SELECT run_id,source_tag,state FROM run_process_owners",
      );
      expect(owners).toEqual([{ run_id: runId, source_tag: `ebb-run:${runId}`, state: "PREPARED" }]);
      expect(runtimeStarts).toBe(0);
      return originalDispatch(taskId, engine, callback, options);
    });
    const registry = new WorkflowRegistry();
    for (const template of Object.values(templates)) registry.register(template);
    const handlers = new RuntimeEventHandlers(db!, new WorkflowEngine(db!, registry), scheduler, runService);
    return { handlers, dispatchSpy };
  }
});

function makeRuntime(): AgentRuntime {
  return {
    active: 0,
    maxActive: 1,
    calls: [],
    startRun: async (_run: AgentRun) => { runtimeStarts += 1; },
    resumeRun: async () => {},
    cancelRun: async () => {},
    inspectRun: async () => { throw new Error("not used"); },
    collectResult: async (runId: string): Promise<RunOutcome> => ({
      success: false, exitCode: 1, output: "", diagnostics: { runId, sessionId: null, stderr: "", exitCode: 1, artifactReferences: [] },
    }),
    collectUsage: async () => ({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, cost: 0 }),
    runResult: async () => { throw new Error("not used"); },
    healthCheck: async () => true,
  };
}

function makeCompletionRuntime(database: Database): AgentRuntime {
  const completion = new DatabaseCompletionStore(database);
  return {
    active: 0,
    maxActive: 1,
    calls: [],
    startRun: async (run: AgentRun) => {
      runtimeStarts += 1;
      if (!run.capabilityRef || !(await completion.accept(run.capabilityRef, {
        runId: run.id, role: run.role, output: { version: "1.0", outcome: "COMPLETED", commitSha: "d".repeat(40) },
      }))) throw new Error("completion submission rejected");
    },
    resumeRun: async () => {},
    cancelRun: async () => {},
    inspectRun: async () => { throw new Error("not used"); },
    collectResult: async (runId: string): Promise<RunOutcome> => {
      const submission = completion.getSubmission(runId);
      if (!submission) throw new Error("completion submission missing");
      return { success: true, exitCode: 0, output: submission.output, validatedSubmission: true,
        diagnostics: { runId, sessionId: null, stderr: "", exitCode: 0, artifactReferences: [] } };
    },
    collectUsage: async () => ({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, cost: 0 }),
    runResult: async () => { throw new Error("not used"); },
    healthCheck: async () => true,
  };
}

class MatrixRuntime implements AgentRuntime {
  active = 0;
  maxActive = 1;
  calls: Array<{ phase: string; role: string; taskId?: string; targetBranch?: string }> = [];
  private readonly completion: DatabaseCompletionStore;

  constructor(private readonly database: Database) {
    this.completion = new DatabaseCompletionStore(database);
  }

  async startRun(run: AgentRun): Promise<void> {
    const output = run.role.toLowerCase() === "integration"
      ? this.integrationOutput(run.id)
      : roleOutput(run.role);
    if (!run.capabilityRef || !(await this.completion.accept(run.capabilityRef, { runId: run.id, role: run.role, output }))) {
      throw new Error(`completion submission rejected for ${run.role}`);
    }
  }

  async resumeRun(): Promise<void> {}
  async cancelRun(): Promise<void> {}
  async inspectRun(): Promise<AgentRun> { throw new Error("not used"); }

  async collectResult(runId: string): Promise<RunOutcome> {
    const output = this.completion.getSubmission(runId)?.output;
    if (!output) throw new Error(`completion submission missing for ${runId}`);
    return { success: true, exitCode: 0, output, validatedSubmission: true, diagnostics: { runId, sessionId: null, stderr: "", exitCode: 0, artifactReferences: [] } };
  }

  async collectUsage(): Promise<{ inputTokens: number; cachedInputTokens: number; outputTokens: number; cost: number }> {
    return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, cost: 0 };
  }

  async runResult(runId: string): Promise<RunOutcome> { return this.collectResult(runId); }
  async healthCheck(): Promise<boolean> { return true; }

  private integrationOutput(runId: string): unknown {
    const attempts = this.database.all<{ id: string; expected_target_sha: string; source_sha: string }>(
      "SELECT id,expected_target_sha,source_sha FROM integration_attempts WHERE integration_run_id=$runId",
      { runId },
    );
    if (attempts.length !== 1) throw new Error("integration attempt must be persisted before runtime start");
    const attempt = attempts[0]!;
    return {
      version: "1.0", outcome: "PASS", baseSha: attempt.expected_target_sha,
      sourceSha: attempt.source_sha, provenance: [`integration_attempt:${attempt.id}`],
      evidence: ["Acceptance runtime submitted evidence for the persisted attempt"],
    };
  }
}

function roleOutput(role: string): unknown {
  switch (role.toLowerCase()) {
    case "developer": return { version: "1.0", outcome: "COMPLETED", commitSha: "e".repeat(40) };
    case "reviewer": return { version: "1.0", outcome: "PASS", independent: true };
    case "qa": return { version: "1.0", outcome: "PASS", evidence: ["Acceptance criteria verified"] };
    case "coordinator": return {
      version: "1.0.0", operation: "PLAN", classification: "EPIC",
      plan: {
        epic: { title: "Production context manifest", goal: "Bind validated context to every production Run" },
        tasks: [
          { ref: "task_base", title: "Build context", goal: "Build context", acceptanceCriteria: ["Context is persisted"], role: "developer", workflow: "standard" },
          { ref: "task_followup", title: "Verify context", goal: "Verify context", acceptanceCriteria: ["Context is verified"], dependsOn: ["task_base"], role: "reviewer", workflow: "standard" },
        ],
      },
    };
    case "product_manager": return {
      version: "1.0.0", outcome: "PRODUCT_DEFINITION", goal: "Deliver the requested user outcome",
      scope: ["Implement the approved request"], nonGoals: ["Change unrelated modules"],
      requirements: ["Preserve approval boundaries"], acceptanceCriteria: ["The request is reviewable"],
    };
    case "architect": return {
      version: "1.0.0", outcome: "DESIGN", components: ["Planning module"],
      interfaces: ["Persisted context manifest"], decisions: ["Keep changes within module boundaries"],
      proposals: [], architectureReviewRequired: false,
    };
    default: throw new Error(`No acceptance output for role ${role}`);
  }
}

async function seedEpicMatrixFixture(database: Database, rootPath: string): Promise<{ epicId: string; taskId: string }> {
  const epicId = "epic-matrix";
  const taskId = "task-epic-integration";
  const now = new Date().toISOString();
  const contract = JSON.stringify({
    version: 1, goal: "Persist production context for this Epic", context: "Epic context marker",
    requirements: ["Persist validated context"], acceptanceCriteria: ["Manifest binds the Epic role"],
    dependencies: [], nonGoals: [], definitionOfDone: ["Prepared owner exists"],
  });
  const plan = {
    projectId: "project-acceptance",
    tasks: [{
      ref: "task_matrix", title: "Integration child", goal: "Validate child integration",
      context: "Task-bound Integration input", requirements: ["Keep attempt provenance"],
      acceptanceCriteria: ["Attempt is bound to the Task"], role: "developer", workflow: "standard",
    }],
    includeProductManager: true, includeArchitect: true,
  };
  const planId = "plan-matrix";
  database.run("INSERT INTO epics(id,project_id,display_id,title,status,contract_json,created_at,updated_at) VALUES($id,'project-acceptance','EPIC-MATRIX','Manifest Epic','IN_PROGRESS',$contract,$now,$now)", { id: epicId, contract, now });
  database.run("INSERT INTO planning_plans(id,project_id,plan_json,epic_id,status,approval_required,created_at) VALUES($id,'project-acceptance',$plan,$epicId,'APPROVED',1,$now)", { id: planId, plan: JSON.stringify(plan), epicId, now });
  database.run("INSERT INTO epic_orchestrations(epic_id,plan_id,input_json,stage,sequence_json,created_at,updated_at) VALUES($epicId,$planId,$input,'INTEGRATION','[]',$now,$now)", { epicId, planId, input: JSON.stringify(plan), now });
  database.run("INSERT INTO tasks(id,project_id,epic_id,display_id,title,status,contract_json,created_at,updated_at) VALUES($id,'project-acceptance',$epicId,'TASK-INT','Integration child','INTEGRATION',$contract,$now,$now)", { id: taskId, epicId, contract, now });
  const epicWorkspaceProvisioner = new EpicWorkspaceProvisioner({ database, worktreeDir: join(rootPath, "epic-worktrees") });
  await epicWorkspaceProvisioner.provisionForEpic(epicId);
  const taskWorkspaceProvisioner = new TaskWorkspaceProvisioner({
    database,
    worktreeManager: new WorktreeManager({ db: database, worktreeDir: join(rootPath, "task-worktrees") }),
  });
  await taskWorkspaceProvisioner.provisionForEpic(epicId);
  return { epicId, taskId };
}

function createMatrixIntegrationService(
  database: Database,
  rootPath: string,
  context: IntegrationServiceFactoryContext,
  attempts: IntegrationAttempt[],
): IntegrationService {
  const service = {
    prepareIntegration: async (sourceBranch: string, targetBranch: string, repoPath: string) => {
      const worktreePath = join(rootPath, `integration-attempt-${attempts.length}`);
      mkdirSync(worktreePath, { recursive: true });
      const attempt: IntegrationAttempt = {
        id: randomUUID(), sourceBranch, currentTargetBranch: targetBranch, expectedTargetBranch: targetBranch,
        expectedTargetSha: "b".repeat(40), sourceSha: "c".repeat(40), worktreePath, repoPath,
        provenanceDatabasePath: join(repoPath, ".ebb-orchestrator", "integration-provenance.sqlite"),
        status: "PREPARED", createdAt: new Date().toISOString(), integrationRunId: context.integrationRunId,
      };
      database.run("INSERT INTO integration_attempts(id,repository_path,source_branch,target_branch,expected_target_sha,source_sha,worktree_path,integration_run_id,status,created_at) VALUES($id,$repo,$source,$target,$expected,$sourceSha,$path,$run,'PREPARED',$now)", {
        id: attempt.id, repo: repoPath, source: sourceBranch, target: targetBranch, expected: attempt.expectedTargetSha,
        sourceSha: attempt.sourceSha, path: worktreePath, run: context.integrationRunId, now: attempt.createdAt,
      });
      attempts.push(attempt);
      return attempt;
    },
    bindIntegrationRun: (attempt: IntegrationAttempt, runId: string) => {
      if (attempt.integrationRunId !== runId) throw new Error("integration run ID mismatch");
      return attempt;
    },
    mergePreparedSource: async () => {},
    runInIntegrationWorktree: async (attempt: IntegrationAttempt, run: (path: string, value: Readonly<IntegrationAttempt>) => Promise<unknown>) => {
      database.run("UPDATE integration_attempts SET status='MERGING' WHERE id=$id", { id: attempt.id });
      const result = await run(attempt.worktreePath, attempt);
      database.run("UPDATE integration_attempts SET status='MERGED' WHERE id=$id", { id: attempt.id });
      return result;
    },
  };
  return service as unknown as IntegrationService;
}

function seedApprovedProjectConfig(database: Database, projectId: string): void {
  const projectYaml = "schema_version: 1\nproject:\n  name: sample\n  default_branch: master\n";
  const sourceFiles = { ".ebb-orchestrator/project.yaml": Buffer.from(projectYaml, "utf8").toString("base64") };
  const manifestJson = JSON.stringify({ files: [{ path: ".ebb-orchestrator/project.yaml", state: "present", sha256: createHash("sha256").update(projectYaml, "utf8").digest("hex") }] });
  const hashDomain = (domain: string, value: string) => createHash("sha256").update(domain, "utf8").update(value, "utf8").digest("hex");
  const sortValue = (value: unknown): unknown => Array.isArray(value) ? value.map(sortValue) : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b, "en")).map(([key, entry]) => [key, sortValue(entry)]))
    : value;
  const payload = { project: parseProjectConfigYaml(projectYaml), files: sourceFiles };
  const candidate = new ProjectConfigRepository(database).capture({
    projectId, sourceHead: "a".repeat(40), manifestJson,
    manifestHash: hashDomain("ebb-project-config-manifest-v1\0", manifestJson),
    sourceFilesJson: JSON.stringify(sourceFiles), normalizedPayloadJson: JSON.stringify(sortValue(payload)), schemaVersion: 1,
  });
  new ProjectConfigService(database, new ApprovalService(database)).approve(projectId, candidate.candidate_id, candidate.manifest_hash);
}
