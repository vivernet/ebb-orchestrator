import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDatabase } from "../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../helpers/migrations.js";
import type { Database, DatabaseTx } from "../../src/platform/database/database.js";
import { WorkflowEngine } from "../../src/modules/workflow/workflow-engine.js";
import { WorkflowRegistry } from "../../src/modules/workflow/workflow-registry.js";
import { templates } from "../../src/modules/workflow/templates.js";
import { SchedulerService } from "../../src/modules/scheduler/scheduler-service.js";
import { SchedulerRunRequestWorker } from "../../src/modules/scheduler/scheduler-run-request-worker.js";
import { RunService, createRunContextInput } from "../../src/modules/runtime/run-service.js";
import { WorktreeManager } from "../../src/modules/git/worktree-manager.js";
import { SqliteProviderSettingsRepository } from "../../src/modules/runtime/providers/provider-settings-repository.js";
import type { AgentRuntime, AgentRuntimeRun } from "../../src/modules/runtime/agent-runtime.js";
import type { StartRunOptions } from "../../src/modules/runtime/run-types.js";
import { digestRunContextV1, digestRunPromptBytesV1 } from "../../src/modules/context/context-provenance.js";
import type { ContextFingerprintInputV1, PreparedRunContext } from "../../src/modules/context/context-types.js";
import { seedApprovedProjectConfig } from "../helpers/approved-project-config.js";

const migrations = loadTestMigrations();

function stubAssembler() {
  return {
    prepare: (_tx: DatabaseTx, input: ReturnType<typeof createRunContextInput>): PreparedRunContext => {
      const promptHash = digestRunPromptBytesV1(new TextEncoder().encode(input.prompt));
      const fingerprintInput: ContextFingerprintInputV1 = {
        promptHash, subjectType: input.subject.type, subjectId: input.subject.id,
        contractOrRequestDigest: null, items: [], contextBuilderVersion: "1.0.0",
        role: input.role, ...input.versions,
        workspaceIdentity: input.execution.workspaceIdentity,
        targetHead: input.execution.targetHead, targetBranch: input.execution.targetBranch,
        effectiveCapabilityIds: input.execution.effectiveCapabilityIds,
        projectConfigRevisionId: null, projectConfigHash: null,
        policyIdentity: input.execution.policyIdentity,
      };
      return {
        finalPrompt: input.prompt, subject: input.subject, role: input.role,
        contractDigest: null, items: [], contextBuilderVersion: "1.0.0",
        promptHash, contextHash: digestRunContextV1(fingerprintInput),
        initialTokenSize: null, workspaceFingerprint: "x".repeat(64), fingerprintInput,
      };
    },
  };
}

function seedProvider(db: Database, overrides: { enabled?: boolean; defaultModelId?: string | null; roleDefaults?: Record<string, string> } = {}) {
  const repository = new SqliteProviderSettingsRepository(db);
  db.run("INSERT OR REPLACE INTO secrets(reference_id,service,name,created_at,updated_at) VALUES('ref-prov-1','ai-provider','prov:openai:api-key',0,0)");
  repository.saveProviderConfiguration({
    providerId: "openai", enabled: overrides.enabled ?? true, selectedAuthMethod: "api-key", config: {},
    modelSelection: { defaultModelId: overrides.defaultModelId ?? "gpt-4o", roleDefaults: overrides.roleDefaults ?? {} },
  });
  repository.attachCredentialMetadata({
    providerId: "openai", authMethodId: "api-key",
    secretName: "prov:openai:api-key", referenceId: "ref-prov-1",
    status: "ACTIVE", now: new Date().toISOString(),
  });
}

describe("production producer matrix: durable provider selection binding (plan-24 Task 5)", () => {
  let db: Database | undefined;
  let tmpDir: string;
  let projectId: string;
  let taskId: string;
  let workspace: string;
  let startCalls: AgentRuntimeRun[];

  afterEach(async () => {
    db?.close();
    db = undefined;
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  async function setup(): Promise<{ scheduler: SchedulerService; workflow: WorkflowEngine; runs: RunService; runtime: AgentRuntime }> {
    tmpDir = await mkdtemp(join(tmpdir(), "orch-provider-matrix-"));
    db = createSqliteDatabase(join(tmpDir, `${randomUUID()}.db`));
    runMigrations(db, migrations);
    projectId = randomUUID();
    taskId = randomUUID();
    workspace = join(tmpDir, "repository");
    await mkdir(workspace);
    const git = (args: string[]) => execFileSync("git", args, { cwd: workspace, stdio: "pipe", windowsHide: true });
    git(["init", "-b", "master"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test User"]);
    await writeFile(join(workspace, "README.md"), "# Test\n", "utf8");
    git(["add", "README.md"]);
    git(["commit", "-m", "init"]);
    const now = new Date().toISOString();
    db.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'p','P','ACTIVE',$now,$now)", { id: projectId, now });
    db.run("INSERT INTO tasks(id,project_id,display_id,title,status,contract_json,created_at,updated_at) VALUES($id,$projectId,'T-1','Task','READY','{}',$now,$now)", { id: taskId, projectId, now });
    const approvalId = randomUUID();
    db.run("INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,created_at) VALUES($id,'WORKFLOW_CHANGE',$projectId,'PROJECT','APPROVED','test',$now)", { id: approvalId, projectId, now });
    db.run("INSERT INTO onboarding_configs(project_id,repository_path,facts_json,proposed_json,status,approval_id,created_at,updated_at) VALUES($projectId,$workspace,$facts,'{}','ACTIVE',$approvalId,$now,$now)", { projectId, workspace, approvalId, now, facts: JSON.stringify({ defaultBranch: "master" }) });
    await new WorktreeManager({ db, worktreeDir: join(tmpDir, "worktrees") }).createTaskWorkspace(taskId, workspace, "master");
    seedApprovedProjectConfig(db, projectId);
    const registry = new WorkflowRegistry();
    for (const tpl of Object.values(templates)) registry.register(tpl);
    const workflow = new WorkflowEngine(db, registry);
    const scheduler = new SchedulerService(db);
    startCalls = [];
    const completion = new (await import("../../src/modules/execution/mcp/submit-result-tool.js")).DatabaseCompletionStore(db);
    const runtime: AgentRuntime = {
      active: 0, maxActive: 0, calls: [], supportsProviderSelections: true,
      async startRun(run) { startCalls.push(run); },
      async resumeRun() {},
      async cancelRun() {},
      async inspectRun() { throw new Error("not implemented"); },
      async collectResult(runId) {
        const output = completion.getSubmission(runId)?.output;
        if (!output) throw new Error(`No submitted result for ${runId}`);
        return { success: true, exitCode: 0, output, validatedSubmission: true, diagnostics: { runId, sessionId: null, stderr: "", exitCode: 0, artifactReferences: [] } };
      },
      async collectUsage() { return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, cost: 0 }; },
      async runResult(runId) { return this.collectResult(runId); },
      async healthCheck() { return true; },
    };
    const runs = new RunService(db, runtime, stubAssembler() as never);
    return { scheduler, workflow, runs, runtime };
  }

  function worker(scheduler: SchedulerService, workflow: WorkflowEngine, runs: RunService): SchedulerRunRequestWorker {
    return new SchedulerRunRequestWorker({ db: db!, scheduler, runs, workflow, isReady: () => true });
  }

  it("TASK_API producer: explicit provider request is bound before dispatch and delivered to the runtime", async () => {
    const { scheduler, workflow, runs } = await setup();
    seedProvider(db!);
    const request = scheduler.enqueueRunRequest({
      taskId, role: "developer", model: "default", providerId: "openai",
      idempotencyKey: randomUUID(), originType: "TASK_API", originId: `task-api:${taskId}`,
    });
    await worker(scheduler, workflow, runs).tick();
    const runRow = db!.get<{ id: string; status: string }>("SELECT id,status FROM agent_runs WHERE task_id=$taskId", { taskId });
    expect(runRow).toBeDefined();
    expect(db!.get("SELECT provider_id,model_id,auth_method_id,config_revision FROM run_provider_selections WHERE run_id=$id", { id: runRow!.id }))
      .toEqual({ provider_id: "openai", model_id: "gpt-4o", auth_method_id: "api-key", config_revision: 1 });
    expect(db!.get("SELECT status,run_id FROM scheduler_run_requests WHERE id=$id", { id: request.id }))
      .toMatchObject({ status: "DISPATCHED", run_id: runRow!.id });
    await expect(runs.executePreparedRun(runRow!.id)).rejects.toThrow(/No submitted result/);
    expect(startCalls).toHaveLength(1);
    expect(startCalls[0]!.providerSelection).toMatchObject({ providerId: "openai", modelId: "gpt-4o" });
  });

  it("TASK_API producer: default resolution binds the global default without an explicit provider", async () => {
    const { scheduler, workflow, runs } = await setup();
    seedProvider(db!);
    scheduler.enqueueRunRequest({
      taskId, role: "developer", model: "default",
      idempotencyKey: randomUUID(), originType: "TASK_API", originId: `task-api:${taskId}`,
    });
    await worker(scheduler, workflow, runs).tick();
    const runRow = db!.get<{ id: string }>("SELECT id FROM agent_runs WHERE task_id=$taskId", { taskId });
    expect(db!.get("SELECT provider_id,model_id FROM run_provider_selections WHERE run_id=$id", { id: runRow!.id }))
      .toEqual({ provider_id: "openai", model_id: "gpt-4o" });
    await expect(runs.executePreparedRun(runRow!.id)).rejects.toThrow(/No submitted result/);
    expect(startCalls).toHaveLength(1);
    expect(startCalls[0]!.providerSelection).toMatchObject({ providerId: "openai" });
  });

  it("TASK_API producer: fail-closed provider error terminates the request as FAILED without a Run", async () => {
    const { scheduler, workflow, runs } = await setup();
    seedProvider(db!, { enabled: false });
    scheduler.enqueueRunRequest({
      taskId, role: "developer", model: "default", providerId: "openai",
      idempotencyKey: randomUUID(), originType: "TASK_API", originId: `task-api:${taskId}`,
    });
    await worker(scheduler, workflow, runs).tick();
    expect(db!.get("SELECT status,failure_code FROM scheduler_run_requests WHERE task_id=$taskId", { taskId }))
      .toEqual({ status: "FAILED", failure_code: "RUN_REQUEST_PROVIDER_DISABLED" });
    expect(db!.all("SELECT * FROM agent_runs")).toEqual([]);
    expect(db!.all("SELECT * FROM run_provider_selections")).toEqual([]);
  });

  it("planning coordinator producer: withHermesRunPreflight + prepareRunInTransaction binds the role default", async () => {
    const { runs } = await setup();
    seedProvider(db!, { roleDefaults: { coordinator: "gpt-4o-mini" } });
    const requestId = randomUUID();
    const now = new Date().toISOString();
    db!.run("INSERT INTO planning_requests(id,project_id,request,requested_by,status,planning_decisions_required,created_at,updated_at) VALUES($id,$projectId,'text','user','RECEIVED',0,$now,$now)", { id: requestId, projectId, now });
    const runOptions: StartRunOptions = {
      role: "coordinator", model: "default", taskId: null, requestId, projectId,
      epicId: null, triggerReason: "planning-request", contextVersion: "1", outputSchemaVersion: "1",
      capability: { workspace, allowedTools: ["workspace.read", "workspace.search", "git.status", "git.diff", "submit_result"] },
    };
    const run = await runs.withHermesRunPreflight(runOptions, async (preflight) => {
      const bound = preflight.bind({ ...preflight.options, contextInput: createRunContextInput(runOptions, {
        prompt: "planner prompt", roleInputs: {}, workspaceIdentity: { repository: workspace, workspace, worktree: null },
        targetHead: null, targetBranch: null,
      }) });
      const prepared = runs.prepareRunContext(bound);
      return db!.transaction((tx) => runs.prepareRunInTransaction(
        tx,
        { ...bound, prompt: prepared.finalPrompt },
        prepared,
        (runId) => tx.run("UPDATE planning_requests SET status='PLANNING',coordinator_run_id=$runId WHERE id=$requestId", { runId, requestId }),
      ));
    });
    expect(db!.get("SELECT provider_id,model_id FROM run_provider_selections WHERE run_id=$id", { id: run.id }))
      .toEqual({ provider_id: "openai", model_id: "gpt-4o-mini" });
    expect(db!.get("SELECT status,coordinator_run_id FROM planning_requests WHERE id=$requestId", { requestId }))
      .toEqual({ status: "PLANNING", coordinator_run_id: run.id });
  });

  it("epic producer: beginHermesRunPreflight + bindHermesRunSelection + prepareRun binds the global default", async () => {
    const { runs } = await setup();
    seedProvider(db!);
    const epicId = randomUUID();
    const now = new Date().toISOString();
    db!.run("INSERT INTO epics(id,project_id,display_id,title,status,contract_json,created_at,updated_at) VALUES($id,$projectId,'E-1','Epic','OPEN','{}',$now,$now)", { id: epicId, projectId, now });
    db!.run("INSERT INTO worktrees(id,repo_path,path,branch,created_at) VALUES($id,$workspace,$workspace,$branch,$now)", { id: `epic:${epicId}`, workspace, branch: "epic/E-1", now });
    db!.run("INSERT INTO git_operations(id,type,status,repo_path,branch_name,worktree_id,target_ref,created_at,verified_at) VALUES($id,'CREATE_WORKTREE','VERIFIED',$workspace,$branch,$wtId,'master',$now,$now)", { id: randomUUID(), workspace, branch: "epic/E-1", wtId: `epic:${epicId}`, now });
    const runOptions: StartRunOptions = {
      role: "developer", model: "default", taskId: null, epicId,
      triggerReason: "epic-implementation", contextVersion: "1", outputSchemaVersion: "1",
      capability: { workspace },
    };
    const preflight = await runs.beginHermesRunPreflight(runOptions);
    const bound = runs.bindHermesRunSelection({
      ...runOptions,
      contextInput: createRunContextInput(runOptions, { prompt: "epic prompt", roleInputs: {},
        workspaceIdentity: { repository: workspace, workspace, worktree: `epic:${epicId}` }, targetHead: null, targetBranch: null }),
    }, preflight);
    const prepared = runs.prepareRunContext(bound);
    const run = runs.prepareRun({ ...bound, prompt: prepared.finalPrompt });
    await preflight.commit();
    expect(db!.get("SELECT provider_id,model_id FROM run_provider_selections WHERE run_id=$id", { id: run.id }))
      .toEqual({ provider_id: "openai", model_id: "gpt-4o" });
  });
});
