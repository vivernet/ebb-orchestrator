import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { connect, createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntime } from "../../src/modules/runtime/agent-runtime.js";
import type { AgentRun } from "@ebb-orchestrator/contracts";
import type { RunOutcome } from "../../src/modules/runtime/run-types.js";
import type { AgentRuntimeRun } from "../../src/modules/runtime/agent-runtime.js";
import { RunService, createRunContextInput, taskDeveloperPrompt } from "../../src/modules/runtime/run-service.js";
import { HERMES_PROVIDER_SELECTION_SOURCE } from "../../src/modules/runtime/hermes/hermes-source-identity.js";
import type { HermesManagedRunSelection } from "../../src/modules/runtime/hermes/hermes-run-selection.js";
import { createHermesManagedSelectionFixture } from "../helpers/hermes-managed-selection-fixture.js";
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
import type { RunContainmentKind } from "../../src/modules/runtime/run-process-owner.js";
import { stopEvidenceForContainmentKind } from "../helpers/run-process-owner-fixture.js";
import { createTestAuthService, TEST_COOKIE, TEST_CSRF_TOKEN } from "../helpers/auth.js";
import { WorkflowEngine } from "../../src/modules/workflow/workflow-engine.js";
import { WorkflowRegistry } from "../../src/modules/workflow/workflow-registry.js";
import { templates } from "../../src/modules/workflow/templates.js";

const hermesSourceSnapshotKey = JSON.stringify({
  formatVersion: 1,
  hermesVersion: HERMES_PROVIDER_SELECTION_SOURCE.version,
  manifestDigest: "c".repeat(64),
  ...(process.platform === "win32" ? { materializationPolicyVersion: 2 } : {}),
  sourceCommit: HERMES_PROVIDER_SELECTION_SOURCE.commit,
  sourceTree: "d".repeat(40),
});

async function assertLoopbackPortClosed(port: number): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Task7 acceptance backend port ${port} did not close before deadline`));
    }, 1_000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      reject(new Error(`Task7 acceptance backend port ${port} still has a listener`));
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      if ((error as NodeJS.ErrnoException).code === "ECONNREFUSED") resolvePromise();
      else reject(error);
    });
  });
}

async function allocateLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Task7 acceptance could not allocate a loopback port");
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => error ? reject(error) : resolvePromise());
  });
  return address.port;
}
import { PlanningService } from "../../src/modules/planning/planning-service.js";
import { EpicOrchestrator, type IntegrationServiceFactoryContext } from "../../src/modules/planning/epic-orchestrator.js";
import { DatabaseCompletionStore } from "../../src/modules/execution/mcp/submit-result-tool.js";
import { SchedulerService } from "../../src/modules/scheduler/scheduler-service.js";
import { SchedulerRunRequestWorker } from "../../src/modules/scheduler/scheduler-run-request-worker.js";
import type { IntegrationAttempt, IntegrationService } from "../../src/modules/git/integration-service.js";
import { BackgroundJobRegistry } from "../../src/platform/jobs/background-job-registry.js";
import { JobRunner } from "../../src/platform/jobs/job-runner.js";
import { registerCoordinatorPlanningJob } from "../../src/modules/planning/coordinator-planning-job.js";
import { EpicWorkspaceProvisioner } from "../../src/modules/git/epic-workspace-provisioner.js";
import { TaskWorkspaceProvisioner } from "../../src/modules/git/task-workspace-provisioner.js";
import { WorktreeManager } from "../../src/modules/git/worktree-manager.js";
import { transitionRunProcessOwnerTx } from "../../src/modules/runtime/run-process-owner.js";
import { EventBus } from "../../src/platform/events/event-bus.js";
import { EventDispatcher } from "../../src/platform/events/event-dispatcher.js";
import { RuntimeOrchestrator } from "../../src/modules/runtime/run-orchestrator.js";
import { createApplicationRecoveryReconcilers, createProductionComposition } from "../../src/platform/home/production-composition.js";
import { resolveOrchestratorHome } from "../../src/platform/home/orchestrator-home.js";
import { startSystem, StatusTracker, type NamedRecoveryStep } from "../../src/platform/process/system-lifecycle.js";

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
    await fixture.app.close();
    app = undefined;
    const harness = createHermesProducerHarness(new HermesSelectionMatrixRuntime(db!));
    const triggers = [
      ["fail_context_manifest_insert", "context_manifests", "task-acceptance"],
      ["fail_run_owner_insert", "run_process_owners", "task-rollback-owner"],
    ] as const;

    for (const [trigger, table, taskId] of triggers) {
      if (taskId !== "task-acceptance") addTaskFixture(db!, root, workspace, taskId);
      db!.run(`CREATE TRIGGER ${trigger} BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'injected_${trigger}'); END`);
      const response = await harness.app.inject({
        method: "POST", url: `/api/v1/tasks/${taskId}/dispatch`,
        headers: { cookie: TEST_COOKIE, origin: "http://127.0.0.1:3000", "x-csrf-token": TEST_CSRF_TOKEN, "idempotency-key": `rollback-${trigger}` },
      });
      expect(response.statusCode, response.body).toBe(202);
      const requestId = (response.json() as { requestId: string }).requestId;
      await harness.worker.tick();
      expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM agent_runs")?.count).toBe(0);
      expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM context_manifests")?.count).toBe(0);
      expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM run_process_owners")?.count).toBe(0);
      expect(harness.scheduler.getRunRequest(taskId, requestId)).toMatchObject({ status: "PENDING", runId: null });
      expect(runtimeStarts).toBe(0);
      db!.run(`DROP TRIGGER ${trigger}`);
    }

    expect(harness.app).toBeDefined();
  });

  it("rejects a context projection that changes inside its preparation transaction", () => {
    setup();
    const service = new RunService(db!, makeRuntime(db!));
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
    await fixture.app.close();
    app = undefined;
    const runtime = new HermesSelectionMatrixRuntime(db!);
    const harness = createHermesProducerHarness(runtime);
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
    const response = await harness.app.inject({
      method: "POST", url: "/api/v1/tasks/task-acceptance/dispatch",
      headers: { cookie: TEST_COOKIE, origin: "http://127.0.0.1:3000", "x-csrf-token": TEST_CSRF_TOKEN, "idempotency-key": "context-manifest-route" },
    });
    expect(response.statusCode, response.body).toBe(202);
    const requestId = (response.json() as { requestId: string }).requestId;
    await harness.worker.tick();
    const request = harness.scheduler.getRunRequest("task-acceptance", requestId);
    expect(request).toMatchObject({ status: "DISPATCHED", taskId: "task-acceptance", role: "developer", model: "default" });
    if (!request?.runId) throw new Error("Durable Task request did not persist its selected Run");
    const run = db!.get<{ id: string; prompt: string }>("SELECT id,prompt FROM agent_runs WHERE task_id='task-acceptance'");
    if (!run) throw new Error("Task dispatch did not persist an agent run");
    expect(run.id).toBe(request.runId);
    expect(run.prompt).toBe(expectedContext.finalPrompt);
    const manifest = db!.get<{ prompt_hash: string; initial_token_size: number | null; role: string }>(
      "SELECT prompt_hash,initial_token_size,role FROM context_manifests WHERE run_id=$runId", { runId: run.id },
    );
    expect(manifest).toEqual({ prompt_hash: digestRunPromptBytesV1(new TextEncoder().encode(run.prompt)), initial_token_size: null, role: "developer" });
    expect(db!.get<{ source_tag: string; state: string }>("SELECT source_tag,state FROM run_process_owners WHERE run_id=$runId", { runId: run.id }))
      .toEqual({ source_tag: `ebb-run:${run.id}`, state: "PREPARED" });
    expect(runtime.producerEvents.map(({ kind }) => kind)).toEqual(["preflight", "dispatch"]);
    expect(runtimeStarts).toBe(0);
  });

  it("dispatches three durable Task requests through AgentRunRequested consumer and RuntimeOrchestrator", async () => {
    setup();
    const cases = [
      { label: "task-event-consumer-developer", taskId: "task-event-developer", role: "developer" },
      { label: "task-event-consumer-reviewer", taskId: "task-event-reviewer", role: "reviewer" },
      { label: "task-event-consumer-qa", taskId: "task-event-qa", role: "qa" },
    ] as const;
    expect(cases.map(({ label }) => label).sort()).toEqual([
      "task-event-consumer-developer", "task-event-consumer-qa", "task-event-consumer-reviewer",
    ].sort());
    for (const item of cases) addTaskFixture(db!, root, workspace, item.taskId);

    const runtime = new MatrixRuntime(db!);
    const runService = new RunService(db!, runtime);
    const scheduler = new SchedulerService(db!);
    const workflow = createAcceptanceWorkflow(db!);
    const worker = new SchedulerRunRequestWorker({ db: db!, scheduler, runs: runService, workflow, isReady: () => true });
    db!.run("UPDATE outbox_events SET processed_at=$now WHERE processed_at IS NULL", { now: new Date().toISOString() });
    const requests = cases.map((item) => ({ item, request: scheduler.enqueueRunRequest({ taskId: item.taskId, role: item.role, model: "default",
      idempotencyKey: `context-manifest-consumer:${item.taskId}`, originType: "TASK_API", originId: `task-api:${item.taskId}` }) }));
    const eventPath = createEventPath(runtime, scheduler, runService, workflow);
    for (let pass = 0; pass < 12; pass += 1) {
      await worker.tick();
      db!.run("UPDATE outbox_events SET available_at=$now WHERE type='AgentRunRequested' AND processed_at IS NULL", {
        now: new Date(Date.now() - 1_000).toISOString(),
      });
      await eventPath.runtimeOrchestrator.dispatchPendingEvents(100);
      if (requests.every(({ item, request }) => {
        const durable = scheduler.getRunRequest(item.taskId, request.id);
        return durable?.status === "DISPATCHED" && durable.runId !== null &&
          db!.get<{ status: string }>("SELECT status FROM agent_runs WHERE id=$runId", { runId: durable.runId })?.status === "COMPLETED";
      })) break;
    }
    const intendedRunIds = requests.map(({ item, request }) => {
      const durable = scheduler.getRunRequest(item.taskId, request.id);
      expect(durable, item.label).toMatchObject({ status: "DISPATCHED", role: item.role, model: "default" });
      if (!durable?.runId) throw new Error(`${item.label} has no committed Run`);
      return durable.runId;
    });
    expect(new Set(eventPath.dispatchSpy.mock.calls.map(([run]) => run.id).filter((runId) => intendedRunIds.includes(runId))))
      .toEqual(new Set(intendedRunIds));
    for (const { item } of requests) {
      const run = db!.get<{ id: string; status: string; role: string }>(
        "SELECT id,status,role FROM agent_runs WHERE task_id=$taskId", { taskId: item.taskId },
      );
      expect(run, item.label).toMatchObject({ status: "COMPLETED", role: item.role });
      expect(db!.all<{ run_id: string; subject_type: string; task_id: string; role: string }>(
        "SELECT run_id,subject_type,task_id,role FROM context_manifests WHERE run_id=$runId", { runId: run!.id },
      ), item.label).toEqual([{ run_id: run!.id, subject_type: "TASK", task_id: item.taskId, role: item.role }]);
      expect(db!.get<{ source_tag: string; state: string }>(
        "SELECT source_tag,state FROM run_process_owners WHERE run_id=$runId", { runId: run!.id },
      ), item.label).toEqual({ source_tag: `ebb-run:${run!.id}`, state: "STOPPED" });
      expect(db!.get<{ processed_at: string | null }>(
        "SELECT processed_at FROM outbox_events WHERE aggregate_id=$taskId AND type='AgentRunRequested'", { taskId: item.taskId },
      )?.processed_at).toBeTruthy();
    }
  });

  it.each([
    ["context_manifests", "fail_event_manifest_insert"],
    ["run_process_owners", "fail_event_owner_insert"],
  ] as const)("keeps durable Task request pending when queue preparation cannot insert %s", async (table, trigger) => {
    setup();
    const runtime = new MatrixRuntime(db!);
    const runService = new RunService(db!, runtime);
    const scheduler = new SchedulerService(db!);
    const workflow = createAcceptanceWorkflow(db!);
    const worker = new SchedulerRunRequestWorker({ db: db!, scheduler, runs: runService, workflow, isReady: () => true });
    const eventPath = createEventPath(runtime, scheduler, runService, workflow);
    db!.run(`CREATE TRIGGER ${trigger} BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'injected_${trigger}'); END`);
    db!.run("UPDATE outbox_events SET processed_at=$now WHERE processed_at IS NULL", { now: new Date().toISOString() });
    const request = scheduler.enqueueRunRequest({ taskId: "task-acceptance", role: "developer", model: "default",
      idempotencyKey: `context-manifest-rollback:${table}`, originType: "TASK_API", originId: "task-api:task-acceptance" });

    await worker.tick();
    await expect(eventPath.runtimeOrchestrator.dispatchPendingEvents(3)).resolves.toBe(0);

    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM agent_runs")?.count).toBe(0);
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM context_manifests")?.count).toBe(0);
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM run_process_owners")?.count).toBe(0);
    expect(eventPath.dispatchSpy).not.toHaveBeenCalled();
    expect(runtimeStarts).toBe(0);
    expect(scheduler.getRunRequest("task-acceptance", request.id)).toMatchObject({ status: "PENDING", runId: null });
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM outbox_events WHERE type='AgentRunRequested'")?.count).toBe(0);
    db!.run(`DROP TRIGGER ${trigger}`);
  });

  it("uses a non-provider Hermes selection seam to hold Task and Epic producers before durable writes", async () => {
    const fixture = setup();
    await fixture.app.close();
    app = undefined;
    const runtime = new HermesSelectionMatrixRuntime(db!);
    const harness = createHermesProducerHarness(runtime);

    const taskGate = runtime.gateNextPreflight();
    const taskResponsePromise = harness.app.inject({
      method: "POST", url: "/api/v1/tasks/task-acceptance/dispatch",
      headers: { cookie: TEST_COOKIE, origin: "http://127.0.0.1:3000", "x-csrf-token": TEST_CSRF_TOKEN, "idempotency-key": "context-manifest-preflight-task" },
    });
    const taskResponse = await taskResponsePromise;
    expect(taskResponse.statusCode, taskResponse.body).toBe(202);
    const taskRequestId = (taskResponse.json() as { requestId: string }).requestId;
    const taskQueuePass = harness.worker.tick();
    const taskRunId = await taskGate.entered;
    assertNoRunProducerWrites(db!, runtime, taskRunId);
    taskGate.release();
    await taskQueuePass;
    const taskRequest = harness.scheduler.getRunRequest("task-acceptance", taskRequestId);
    expect(taskRequest).toMatchObject({ status: "DISPATCHED", runId: taskRunId });
    const taskEventPath = createEventPath(runtime, harness.scheduler, harness.runService, harness.workflow);
    db!.run("UPDATE outbox_events SET available_at=$now WHERE processed_at IS NULL", {
      now: new Date(Date.now() - 1_000).toISOString(),
    });
    await taskEventPath.runtimeOrchestrator.dispatchPendingEvents(100);
    await vi.waitFor(() => expect(db!.get<{ status: string }>(
      "SELECT status FROM agent_runs WHERE id=$runId", { runId: taskRunId },
    )).toEqual({ status: "COMPLETED" }));
    expect(db!.get<{ model: string }>("SELECT model FROM agent_runs WHERE id=$runId", { runId: taskRunId }))
      .toEqual({ model: "default" });

    const planResponse = await harness.app.inject({
      method: "POST", url: "/api/v1/projects/project-acceptance/epics/plans",
      headers: { cookie: TEST_COOKIE, origin: "http://127.0.0.1:3000", "x-csrf-token": TEST_CSRF_TOKEN },
      payload: {
        epic: { title: "Hermes preflight Epic", goal: "Exercise the production Epic producer" },
        tasks: [
          { ref: "task_preflight", title: "Preflight Task", goal: "Run the approved child phase", role: "developer", workflow: "standard", acceptanceCriteria: ["Run is preflight-bound"] },
          { ref: "task_preflight_followup", title: "Preflight Follow-up", goal: "Complete a valid multi-task Epic", role: "developer", workflow: "standard", dependsOn: ["task_preflight"], acceptanceCriteria: ["Follow-up is persisted"] },
        ],
      },
    });
    expect(planResponse.statusCode, planResponse.body).toBe(201);
    const planId = (planResponse.json() as { plan: { id: string } }).plan.id;
    const epicGate = runtime.gateNextPreflight();
    const approvalPromise = harness.app.inject({
      method: "POST", url: `/api/v1/projects/project-acceptance/epics/plans/${planId}/approve-run`,
      headers: { cookie: TEST_COOKIE, origin: "http://127.0.0.1:3000", "x-csrf-token": TEST_CSRF_TOKEN }, payload: {},
    });
    const epicRunId = await epicGate.entered;
    assertNoRunProducerWrites(db!, runtime, epicRunId);
    epicGate.release();
    const approvalResponse = await approvalPromise;
    expect(approvalResponse.statusCode, approvalResponse.body).toBe(200);
    expect(db!.get<{ model: string }>("SELECT model FROM agent_runs WHERE id=$runId", { runId: epicRunId }))
      .toEqual({ model: "default" });
    expect(db!.all("SELECT run_id FROM context_manifests WHERE run_id=$runId", { runId: epicRunId })).toHaveLength(1);
    expect(db!.get<{ state: string }>("SELECT state FROM run_process_owners WHERE run_id=$runId", { runId: epicRunId }))
      .toEqual({ state: "STOPPED" });
  });

  it("binds source-backed Task, approved Epic and Request producers to persisted context manifests", async () => {
    const fixture = setup();
    const runtime = new HermesSelectionMatrixRuntime(db!);
    const runService = new RunService(db!, runtime);
    await fixture.app.close();
    const scheduler = new SchedulerService(db!);
    const workflowRegistry = new WorkflowRegistry();
    for (const template of Object.values(templates)) workflowRegistry.register(template);
    const workflow = new WorkflowEngine(db!, workflowRegistry);
    addTaskFixture(db!, root, workspace, "task-http-reviewer");
    addTaskFixture(db!, root, workspace, "task-http-qa");
    const taskDispatchBarrier = vi.fn((
      requestId: string,
      engine: WorkflowEngine,
      prepare: Parameters<SchedulerService["dispatchRunRequest"]>[2],
      canDispatch: Parameters<SchedulerService["dispatchRunRequest"]>[3],
    ) => {
      const run = SchedulerService.prototype.dispatchRunRequest.call(scheduler, requestId, engine, prepare, canDispatch);
      if (run) assertHermesSelectionDurableBeforeDispatch(db!, runtime, run.id);
      return run;
    });
    vi.spyOn(scheduler, "dispatchRunRequest").mockImplementation(taskDispatchBarrier);
    const planning = new PlanningService(db!);
    vi.spyOn(scheduler, "dispatchTask").mockImplementation((taskId, engine, callback, options) => {
      const runId = typeof options === "object" && options !== null ? options.runId : undefined;
      if (typeof runId === "string") assertHermesSelectionDurableBeforeDispatch(db!, runtime, runId);
      return SchedulerService.prototype.dispatchTask.call(scheduler, taskId, engine, callback, options);
    });
    vi.spyOn(scheduler, "dispatchAgentRun").mockImplementation((runId, projectId, role, model, resourceKey, options) => {
      assertHermesSelectionDurableBeforeDispatch(db!, runtime, runId);
      expect(model).toBe("default");
      return SchedulerService.prototype.dispatchAgentRun.call(scheduler, runId, projectId, role, model, resourceKey, options);
    });
    const integrationAttempts: IntegrationAttempt[] = [];
    const epicOrchestrator = new EpicOrchestrator(
      db!, workflow, planning, runService, {} as never, scheduler,
      {
        integrationServiceFactory: (context) => createMatrixIntegrationService(db!, root, context, integrationAttempts),
        integrationWorktreeRoot: join(root, "integration-worktrees"),
        epicWorkspaceProvisioner: new EpicWorkspaceProvisioner({ database: db!, worktreeDir: join(root, "epic-worktrees") }),
        taskWorkspaceProvisioner: new TaskWorkspaceProvisioner({
          database: db!, worktreeManager: new WorktreeManager({ db: db!, worktreeDir: join(root, "task-worktrees") }),
        }),
      },
    );
    let runtimeApp = createApp({
      db: db!, scheduler, runService, runtime,
      epicOrchestrator, authService: createTestAuthService(),
    });
    app = runtimeApp;
    const headers = { cookie: TEST_COOKIE, origin: "http://127.0.0.1:3000", "x-csrf-token": TEST_CSRF_TOKEN };
    const taskRunQueue = new SchedulerRunRequestWorker({ db: db!, scheduler, runs: runService, workflow, isReady: () => true });
    const taskEventPath = createEventPath(runtime, scheduler, runService, workflow);

    const taskRunIds: Record<string, string> = {};
    const taskRequestIds: Array<{ taskId: string; label: string; requestId: string }> = [];
    for (const item of [
      { role: "developer", taskId: "task-acceptance", label: "task-http-developer" },
      { role: "reviewer", taskId: "task-http-reviewer", label: "task-http-reviewer" },
      { role: "qa", taskId: "task-http-qa", label: "task-http-qa" },
    ] as const) {
      const response = await runtimeApp.inject({
        method: "POST", url: `/api/v1/tasks/${item.taskId}/dispatch`,
        headers: { ...headers, "idempotency-key": `context-manifest-${item.taskId}-${item.role}` },
        payload: { role: item.role },
      });
      expect(response.statusCode, response.body).toBe(202);
      taskRequestIds.push({ taskId: item.taskId, label: item.label,
        requestId: (response.json() as { requestId: string }).requestId });
    }
    for (let pass = 0; pass < 12; pass += 1) {
      await taskRunQueue.tick();
      db!.run("UPDATE outbox_events SET available_at=$now WHERE type='AgentRunRequested' AND processed_at IS NULL", {
        now: new Date(Date.now() - 1_000).toISOString(),
      });
      await taskEventPath.runtimeOrchestrator.dispatchPendingEvents(100);
      if (taskRequestIds.every((request) => {
        const durable = scheduler.getRunRequest(request.taskId, request.requestId);
        return durable?.status === "DISPATCHED" && durable.runId !== null &&
          db!.get<{ status: string }>("SELECT status FROM agent_runs WHERE id=$runId", { runId: durable.runId })?.status === "COMPLETED";
      })) break;
    }
    for (const request of taskRequestIds) {
      const dispatched = scheduler.getRunRequest(request.taskId, request.requestId);
      if (!dispatched) throw new Error(`${request.label} has no durable RunRequest`);
      expect(dispatched.status, request.label).toBe("DISPATCHED");
      if (!dispatched.runId) throw new Error(`${request.label} did not receive a committed Run`);
      taskRunIds[request.label] = dispatched.runId;
    }
    for (const item of [
      { role: "developer", taskId: "task-acceptance", label: "task-http-developer" },
      { role: "reviewer", taskId: "task-http-reviewer", label: "task-http-reviewer" },
      { role: "qa", taskId: "task-http-qa", label: "task-http-qa" },
    ] as const) {
      const runId = taskRunIds[item.label]!;
      await vi.waitFor(() => {
        expect(db!.get<{ status: string }>("SELECT status FROM agent_runs WHERE id=$runId", { runId }))
          .toEqual({ status: "COMPLETED" });
        expect(db!.get<{ state: string }>("SELECT state FROM run_process_owners WHERE run_id=$runId", { runId }))
          .toEqual({ state: "STOPPED" });
      });
    }

    const epicPlanResponse = await runtimeApp.inject({
      method: "POST", url: "/api/v1/projects/project-acceptance/epics/plans", headers,
      payload: {
        epic: { title: "Acceptance Epic", goal: "Exercise every Epic context producer" },
        tasks: [
          { ref: "task_context", title: "Context Task", goal: "Exercise child producers", role: "developer", workflow: "standard", acceptanceCriteria: ["Every child phase is persisted"] },
          { ref: "task_context_followup", title: "Context Follow-up", goal: "Exercise a second approved child", role: "developer", workflow: "standard", dependsOn: ["task_context"], acceptanceCriteria: ["The approved follow-up is persisted"] },
        ],
        includeProductManager: true, includeArchitect: true,
      },
    });
    expect(epicPlanResponse.statusCode, epicPlanResponse.body).toBe(201);
    const epicPlan = epicPlanResponse.json() as { plan: { id: string } };

    const interruptedChildRun = runtime.interruptNextEpicChildDeveloper();
    const interruptedApproval = runtimeApp.inject({
      method: "POST", url: `/api/v1/projects/project-acceptance/epics/plans/${epicPlan.plan.id}/approve-run`, headers, payload: {},
    });
    const interruptedChildRunId = await interruptedChildRun;
    const interruptedResponse = await interruptedApproval;
    expect(interruptedResponse.statusCode, interruptedResponse.body).toBe(409);
    const epicId = db!.get<{ epic_id: string }>(
      "SELECT epic_id FROM planning_plans WHERE id=$planId", { planId: epicPlan.plan.id },
    )?.epic_id;
    if (!epicId) throw new Error("Public Epic approval did not persist its Epic before child execution");
    const epicTaskId = db!.get<{ id: string }>("SELECT id FROM tasks WHERE epic_id=$epicId", { epicId })?.id;
    if (!epicTaskId) throw new Error("Approved public Epic plan did not materialize its child Task");
    expect(db!.get<{ phase: string; status: string; agent_run_id: string }>(
      "SELECT phase,status,agent_run_id FROM orchestration_phase_runs WHERE agent_run_id=$runId",
      { runId: interruptedChildRunId },
    )).toMatchObject({ phase: "child_task", status: "RUNNING", agent_run_id: interruptedChildRunId });
    expect(db!.get<{ status: string }>("SELECT status FROM tasks WHERE id=$taskId", { taskId: epicTaskId }))
      .toEqual({ status: "DEVELOPMENT" });
    expect(db!.get<{ run_id: string; source_tag: string; state: string; containment_id: string; launch_nonce: string }>(
      "SELECT run_id,source_tag,state,containment_id,launch_nonce FROM run_process_owners WHERE run_id=$runId",
      { runId: interruptedChildRunId },
    )).toMatchObject({ run_id: interruptedChildRunId, source_tag: `ebb-run:${interruptedChildRunId}`, state: "LIVE" });

    // Simulate process restart using the same durable SQLite file and the shared production startup callbacks.
    await runtimeApp.close();
    app = undefined;
    db!.close();
    db = createSqliteDatabase(join(root, "orchestrator.sqlite"));
    const recoveryDb = db;
    const recoveryRuntime = new MatrixRuntime(recoveryDb!);
    const recoveryRunService = new RunService(recoveryDb!, recoveryRuntime);
    const recoveryScheduler = new SchedulerService(recoveryDb!);
    const recoveryPlanning = new PlanningService(recoveryDb!);
    const recoveryRegistry = new WorkflowRegistry();
    for (const template of Object.values(templates)) recoveryRegistry.register(template);
    const recoveryWorkflow = new WorkflowEngine(recoveryDb!, recoveryRegistry);
    const recoveryEpicOrchestrator = new EpicOrchestrator(
      recoveryDb!, recoveryWorkflow, recoveryPlanning, recoveryRunService, {} as never, recoveryScheduler,
      {
        integrationServiceFactory: (context) => createMatrixIntegrationService(recoveryDb!, root, context, integrationAttempts),
        integrationWorktreeRoot: join(root, "integration-worktrees"),
        epicWorkspaceProvisioner: new EpicWorkspaceProvisioner({ database: recoveryDb!, worktreeDir: join(root, "epic-worktrees") }),
        taskWorkspaceProvisioner: new TaskWorkspaceProvisioner({
          database: recoveryDb!, worktreeManager: new WorktreeManager({ db: recoveryDb!, worktreeDir: join(root, "task-worktrees") }),
        }),
      },
    );
    const recoveryEventBus = new EventBus();
    const recoveryEventDispatcher = new EventDispatcher(recoveryDb!, recoveryEventBus);
    new RuntimeOrchestrator(recoveryDb!, recoveryWorkflow, recoveryEventBus, recoveryEventDispatcher, recoveryScheduler, recoveryRunService).initialize();
    const recoveryStatus = new StatusTracker();
    const recoveryProjectConfig = new ProjectConfigService(recoveryDb!, new ApprovalService(recoveryDb!));
    const inspectedOwners: Array<{ runId: string; containmentId: string; launchNonce: string }> = [];
    const recoverySupervisor = {
      inspect: async (owner: { runId: string; containmentId: string; launchNonce: string; containmentKind: string }) => {
        const stored = recoveryDb!.get<{ run_id: string; source_tag: string; state: string; containment_id: string; launch_nonce: string; containment_kind: string }>(
          "SELECT run_id,source_tag,state,containment_id,launch_nonce,containment_kind FROM run_process_owners WHERE run_id=$runId",
          { runId: owner.runId },
        );
        if (!stored || stored.run_id !== owner.runId || stored.source_tag !== `ebb-run:${owner.runId}` ||
            stored.containment_id !== owner.containmentId || stored.launch_nonce !== owner.launchNonce || stored.state !== "LIVE") {
          return { state: "UNKNOWN" as const, reason: "TEST_IDENTITY_MISMATCH" };
        }
        inspectedOwners.push({ runId: owner.runId, containmentId: owner.containmentId, launchNonce: owner.launchNonce });
        return { state: "STOPPED" as const, evidence: stopEvidenceForContainmentKind(owner.containmentKind as RunContainmentKind | null | undefined) };
      },
      launch: async () => { throw new Error("restart acceptance must not launch an OS process"); },
      stop: async () => ({ state: "UNKNOWN" as const, reason: "NOT_USED" }),
      waitForStopped: async () => ({ state: "UNKNOWN" as const, reason: "NOT_USED" }),
    };
    const home = resolveOrchestratorHome({ EBB_ORCHESTRATOR_HOME: join(root, "restart-home") }, process.platform === "win32" ? "win32" : "linux");
    const production = createProductionComposition({
      database: recoveryDb!, home,
      gitReconciler: { initialize: async () => {}, reconcile: async () => ({ state: "IN_SYNC" as const }) },
      processScopeSupervisor: recoverySupervisor,
    });
    const startupReconciliation = production.createStartupReconciliation({
      runService: recoveryRunService,
      eventDispatcher: recoveryEventDispatcher,
      status: recoveryStatus,
      projectConfigService: recoveryProjectConfig,
    });
    let taskStageBeforeResume: string | undefined;
    const applicationRecoveryReconcilers: NamedRecoveryStep[] = createApplicationRecoveryReconcilers({
      epicOrchestrator: recoveryEpicOrchestrator,
      scheduler: recoveryScheduler,
      planningService: recoveryPlanning,
    }).map((reconcile, index): NamedRecoveryStep => ({
      name: reconcile.name,
      run: async () => {
        if (index === 4) {
          taskStageBeforeResume = recoveryDb!.get<{ status: string }>(
            "SELECT status FROM tasks WHERE id=$taskId", { taskId: epicTaskId },
          )?.status;
        }
        await reconcile.run();
      },
    }));
    await startSystem({
      instanceLock: { acquire: async () => ({ pid: process.pid }), release: async () => {} },
      lockAlreadyAcquired: true,
      database: { open: async () => {}, close: () => recoveryDb!.close() },
      migrator: { run: async () => {} },
      status: recoveryStatus,
      ...startupReconciliation,
      additionalReconcilers: [
        ...startupReconciliation.additionalReconcilers,
        ...applicationRecoveryReconcilers,
      ],
      workers: [],
    });
    expect(inspectedOwners).toEqual([{
      runId: interruptedChildRunId,
      containmentId: db!.get<{ containment_id: string }>("SELECT containment_id FROM run_process_owners WHERE run_id=$runId", { runId: interruptedChildRunId })!.containment_id,
      launchNonce: db!.get<{ launch_nonce: string }>("SELECT launch_nonce FROM run_process_owners WHERE run_id=$runId", { runId: interruptedChildRunId })!.launch_nonce,
    }]);
    expect(recoveryStatus.get()).toBe("READY");
    expect(db!.get<{ status: string }>("SELECT status FROM agent_runs WHERE id=$runId", { runId: interruptedChildRunId }))
      .toEqual({ status: "FAILED" });
    const stoppedOwner = db!.get<{ state: string; stop_evidence: string; containment_kind: string }>(
      "SELECT state,stop_evidence,containment_kind FROM run_process_owners WHERE run_id=$runId", { runId: interruptedChildRunId },
    );
    expect(stoppedOwner).toEqual({
      state: "STOPPED",
      stop_evidence: stoppedOwner ? stopEvidenceForContainmentKind(stoppedOwner.containment_kind as RunContainmentKind | null | undefined) : null,
      containment_kind: stoppedOwner?.containment_kind,
    });
    expect(taskStageBeforeResume).toBe("DEVELOPMENT");
    const reconciliationRunId = phaseRunId(recoveryDb!, epicId, epicTaskId, "child_task_reconcile");
    expect(reconciliationRunId).not.toBe(interruptedChildRunId);
    expect(recoveryDb!.get<{ phase: string; status: string; agent_run_id: string }>(
      "SELECT phase,status,agent_run_id FROM orchestration_phase_runs WHERE agent_run_id=$runId",
      { runId: reconciliationRunId },
    )).toEqual({ phase: "child_task_reconcile", status: "COMPLETED", agent_run_id: reconciliationRunId });
    expect(recoveryDb!.get<{ trigger_reason: string }>(
      "SELECT trigger_reason FROM agent_runs WHERE id=$runId", { runId: reconciliationRunId },
    )).toEqual({ trigger_reason: "epic-child_task_reconcile" });
    expect(recoveryDb!.get<{ architecture_review_authorized: number; stage: string }>(
      "SELECT architecture_review_authorized,stage FROM epic_orchestrations WHERE epic_id=$epicId", { epicId },
    )).toMatchObject({ architecture_review_authorized: 1, stage: "FINAL_APPROVAL" });

    const acceptancePort = await allocateLoopbackPort();
    await runtimeApp.close();
    runtimeApp = createApp({
      host: "127.0.0.1", port: acceptancePort,
      db: recoveryDb!, scheduler: recoveryScheduler as never, runService: recoveryRunService, runtime: recoveryRuntime,
      epicOrchestrator: recoveryEpicOrchestrator, authService: createTestAuthService({ strict: false }),
    });
    app = runtimeApp;
    headers.origin = `http://127.0.0.1:${acceptancePort}`;

    const requestResponse = await runtimeApp.inject({
      method: "POST", url: "/api/v1/projects/project-acceptance/requests", headers,
      payload: { request: "Create an Epic plan and preserve its request-bound role decisions." },
    });
    expect(requestResponse.statusCode, requestResponse.body).toBe(202);
    const requestId = (requestResponse.json() as { requestId: string }).requestId;
    const queuedJob = db!.get<{ id: string; type: string; payload_json: string }>(
      "SELECT id,type,payload_json FROM background_jobs WHERE type='coordinator.planning' AND payload_json LIKE $requestId LIMIT 1",
      { requestId: `%${requestId}%` },
    );
    expect(queuedJob?.type).toBe("coordinator.planning");
    expect(JSON.parse(queuedJob?.payload_json ?? "{}" )).toEqual({ requestId, projectId: "project-acceptance" });
    const jobRegistry = new BackgroundJobRegistry();
    registerCoordinatorPlanningJob(jobRegistry, { db: db!, planning: recoveryPlanning, runs: recoveryRunService, scheduler: recoveryScheduler });
    const jobRunner = new JobRunner(db!, jobRegistry);
    const requestDispatchSpy = vi.spyOn(recoveryScheduler, "dispatchAgentRun");
    const beforeRequestFailure = {
      runs: db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM agent_runs")!.count,
      manifests: db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM context_manifests")!.count,
      owners: db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM run_process_owners")!.count,
    };
    db!.run("CREATE TRIGGER fail_request_coordinator_manifest BEFORE INSERT ON context_manifests BEGIN SELECT RAISE(ABORT, 'injected_request_coordinator_manifest_failure'); END");
    const failedRequestJob = await jobRunner.runOnce(new Date());
    db!.run("DROP TRIGGER fail_request_coordinator_manifest");
    expect(failedRequestJob).toMatchObject({ claimed: 1, succeeded: 0, failed: 0 });
    expect(db!.get<{ status: string; coordinator_run_id: string | null }>(
      "SELECT status,coordinator_run_id FROM planning_requests WHERE id=$requestId", { requestId },
    )).toEqual({ status: "RECEIVED", coordinator_run_id: null });
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM agent_runs")?.count).toBe(beforeRequestFailure.runs);
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM context_manifests")?.count).toBe(beforeRequestFailure.manifests);
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM run_process_owners")?.count).toBe(beforeRequestFailure.owners);
    expect(requestDispatchSpy).not.toHaveBeenCalled();
    expect(db!.get<{ status: string; attempts: number }>(
      "SELECT status,attempts FROM background_jobs WHERE id=$id", { id: queuedJob!.id },
    )).toMatchObject({ status: "RETRY_WAIT", attempts: 1 });

    const jobResult = await jobRunner.runOnce(new Date(Date.now() + 70_000));
    expect(jobResult).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
    const request = db!.get<{ id: string; status: string; classification: string; planning_decisions_required: number; plan_id: string | null }>(
      "SELECT id,status,classification,planning_decisions_required,plan_id FROM planning_requests WHERE id=$requestId", { requestId },
    );
    if (!request?.plan_id) throw new Error("Production Request job did not persist its materialized plan");
    expect(request).toMatchObject({ id: requestId, status: "PLAN_PENDING_APPROVAL", classification: "EPIC", planning_decisions_required: 1 });
    expect(db!.all<{ role: string; run_id: string }>(
      "SELECT role,run_id FROM planning_request_role_runs WHERE request_id=$requestId ORDER BY role", { requestId },
    ).map(({ role }) => role)).toEqual(["architect", "product_manager"]);

    const persisted = db!.all<{
      id: string; role: string; task_id: string | null; epic_id: string | null;
      subject_type: string; manifest_role: string; manifest_task_id: string | null;
      manifest_epic_id: string | null; request_id: string | null; prompt: string; prompt_hash: string;
    }>(`SELECT r.id,r.role,r.task_id,r.epic_id,cm.subject_type,cm.role AS manifest_role,
              cm.task_id AS manifest_task_id,cm.epic_id AS manifest_epic_id,cm.request_id,r.prompt,cm.prompt_hash
          FROM agent_runs r JOIN context_manifests cm ON cm.run_id=r.id ORDER BY r.started_at,r.id`);
    for (const row of persisted) {
      expect(row.role, `Run/manifest role parity for ${row.id}`).toBe(row.manifest_role);
      expect(row.task_id, `Run/manifest Task subject parity for ${row.id}`).toBe(row.manifest_task_id);
      expect(row.subject_type === "EPIC" ? row.epic_id : null, `Run/manifest Epic subject parity for ${row.id}`).toBe(row.manifest_epic_id);
      if (row.subject_type === "REQUEST") {
        expect(row.request_id, `Request manifest must retain its exact request ID for ${row.id}`).toBeTruthy();
      } else {
        expect(row.request_id, `Non-Request manifest must not carry a request ID for ${row.id}`).toBeNull();
      }
    }
    expect([...new Set(persisted.map(({ subject_type, manifest_role }) => `${subject_type}:${manifest_role}`))].sort()).toEqual([
      "EPIC:architect", "EPIC:coordinator", "EPIC:integration", "EPIC:product_manager", "EPIC:qa", "EPIC:reviewer",
      "REQUEST:architect", "REQUEST:coordinator", "REQUEST:product_manager",
      "TASK:developer", "TASK:integration", "TASK:qa", "TASK:reviewer",
    ]);
    for (const row of persisted) {
      expect(row.prompt_hash).toBe(digestRunPromptBytesV1(new TextEncoder().encode(row.prompt)));
      expect(db!.get<{ source_tag: string; state: string }>(
        "SELECT source_tag,state FROM run_process_owners WHERE run_id=$runId", { runId: row.id },
      )).toEqual({ source_tag: `ebb-run:${row.id}`, state: "STOPPED" });
    }
    const producerRunIds: Record<string, string> = {
      "task-http-developer": taskRunIds["task-http-developer"]!,
      "task-http-reviewer": taskRunIds["task-http-reviewer"]!,
      "task-http-qa": taskRunIds["task-http-qa"]!,
      "epic-child-developer-task": interruptedChildRunId,
      "epic-child-developer-reconcile": reconciliationRunId,
      "epic-child-reviewer": phaseRunId(db!, epicId, epicTaskId, "review"),
      "epic-child-qa": phaseRunId(db!, epicId, epicTaskId, "qa"),
      "epic-task-integration": phaseRunId(db!, epicId, epicTaskId, "integration"),
      "epic-plan": phaseRunId(db!, epicId, null, "plan"),
      "epic-pm": phaseRunId(db!, epicId, null, "pm"),
      "epic-initial-architect": phaseRunId(db!, epicId, null, "architect"),
      "epic-review": phaseRunId(db!, epicId, null, "epic_review"),
      "epic-architecture-review": phaseRunId(db!, epicId, null, "architecture_review"),
      "epic-qa": phaseRunId(db!, epicId, null, "epic_qa"),
      "epic-final-integration": phaseRunId(db!, epicId, null, "integration"),
      "request-coordinator": db!.get<{ id: string }>("SELECT r.id FROM agent_runs r JOIN context_manifests cm ON cm.run_id=r.id WHERE cm.request_id=$requestId AND r.role='coordinator'", { requestId: request.id })!.id,
      "request-product_manager": db!.get<{ run_id: string }>("SELECT run_id FROM planning_request_role_runs WHERE request_id=$requestId AND role='product_manager'", { requestId: request.id })!.run_id,
      "request-architect": db!.get<{ run_id: string }>("SELECT run_id FROM planning_request_role_runs WHERE request_id=$requestId AND role='architect'", { requestId: request.id })!.run_id,
    };
    expect(Object.keys(producerRunIds).sort()).toEqual([
      "epic-architecture-review", "epic-child-developer-reconcile", "epic-child-developer-task",
      "epic-child-qa", "epic-child-reviewer", "epic-final-integration", "epic-initial-architect", "epic-pm", "epic-plan",
      "epic-qa", "epic-review", "epic-task-integration", "request-architect", "request-coordinator", "request-product_manager",
      "task-http-developer", "task-http-qa", "task-http-reviewer",
    ].sort());
    for (const [label, runId] of Object.entries(producerRunIds)) {
      const row = db!.get<{
        subject_type: string; role: string; task_id: string | null; epic_id: string | null; request_id: string | null;
        run_role: string; run_task_id: string | null; run_epic_id: string | null;
      }>(
        `SELECT cm.subject_type,cm.role,cm.task_id,cm.epic_id,cm.request_id,
                r.role AS run_role,r.task_id AS run_task_id,r.epic_id AS run_epic_id
           FROM context_manifests cm JOIN agent_runs r ON r.id=cm.run_id WHERE cm.run_id=$runId`, { runId },
      );
      expect(row, label).toBeTruthy();
      expect(db!.all("SELECT run_id FROM context_manifests WHERE run_id=$runId", { runId }), label).toHaveLength(1);
      const expected = producerSubjectRole(label, { epicId, epicTaskId, requestId: request.id });
      expect(row, label).toMatchObject(expected);
      expect(row!.run_role, `${label}: manifest role must equal Run role`).toBe(row!.role);
      expect(row!.run_task_id, `${label}: manifest Task ID must equal Run Task ID`).toBe(row!.task_id);
      expect(row!.subject_type === "EPIC" ? row!.run_epic_id : null, `${label}: manifest Epic subject ID must equal Run Epic ID`)
        .toBe(row!.epic_id);
      const expectedRunEpicId = row!.subject_type === "TASK"
        ? db!.get<{ epic_id: string | null }>("SELECT epic_id FROM tasks WHERE id=$taskId", { taskId: row!.task_id })?.epic_id ?? null
        : row!.subject_type === "EPIC" ? row!.epic_id : null;
      expect(row!.run_epic_id, `${label}: Run parent Epic association must match its exact subject`).toBe(expectedRunEpicId);
      if (label.startsWith("request-")) {
        expect(row!.request_id, `${label}: manifest must bind the exact Request`).toBe(request.id);
      }
      expect(db!.get<{ run_id: string; source_tag: string; state: string }>(
        "SELECT run_id,source_tag,state FROM run_process_owners WHERE run_id=$runId", { runId },
      ), label).toEqual({ run_id: runId, source_tag: `ebb-run:${runId}`, state: "STOPPED" });
    }
    for (const [label, runId] of Object.entries(producerRunIds)) {
      const response = await runtimeApp.inject({ method: "GET", url: `/api/v1/runs/${runId}/context-manifests`, headers });
      expect(response.statusCode, `${label} context manifest after restart`).toBe(200);
      const projection = response.json() as Record<string, unknown>;
      const expected = producerSubjectRole(label, { epicId, epicTaskId, requestId: request.id });
      const subjectId = expected.subject_type === "TASK" ? expected.task_id
        : expected.subject_type === "EPIC" ? expected.epic_id : expected.request_id;
      expect(projection, `${label} safe manifest projection after restart`).toMatchObject({
        availability: "available",
        runId,
        subject: { type: expected.subject_type, id: subjectId },
        role: expected.role,
      });
      const serializedProjection = JSON.stringify(projection);
      const persistedPrompt = db!.get<{ prompt: string }>("SELECT prompt FROM agent_runs WHERE id=$runId", { runId })?.prompt;
      expect(persistedPrompt, `${label} source prompt exists for privacy assertion`).toBeTruthy();
      expect(serializedProjection, `${label} response must not expose the persisted prompt`).not.toContain(persistedPrompt!);
      expect(serializedProjection, `${label} response must not expose raw context text`).not.toMatch(/persisted task contract|acceptance task context|Create an Epic plan and preserve its request-bound role decisions/i);
      expect(projection).not.toHaveProperty("prompt");
      expect(projection).not.toHaveProperty("context");
    }
    expect(taskDispatchBarrier).toHaveBeenCalledTimes(3);
    expect(integrationAttempts).toHaveLength(3);

    const failedEpicPlanResponse = await runtimeApp.inject({
      method: "POST", url: "/api/v1/projects/project-acceptance/epics/plans", headers,
      payload: {
        epic: { title: "Transaction failure Epic", goal: "Verify manifest failure rolls back the producer" },
        tasks: [{ ref: "task_failure", title: "Failure Task", goal: "Exercise rollback", role: "developer", workflow: "standard", acceptanceCriteria: ["No Run is dispatched"] }],
      },
    });
    expect(failedEpicPlanResponse.statusCode, failedEpicPlanResponse.body).toBe(201);
    const failedEpicPlan = failedEpicPlanResponse.json() as { plan: { id: string } };
    const beforeEpicFailure = {
      runs: db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM agent_runs")!.count,
      manifests: db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM context_manifests")!.count,
      owners: db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM run_process_owners")!.count,
      dispatches: vi.mocked(recoveryScheduler.dispatchAgentRun).mock.calls.length,
    };
    db!.run("CREATE TRIGGER fail_epic_context_manifest BEFORE INSERT ON context_manifests BEGIN SELECT RAISE(ABORT, 'injected_epic_context_manifest_failure'); END");
    const failedEpicApproval = await runtimeApp.inject({
      method: "POST", url: `/api/v1/projects/project-acceptance/epics/plans/${failedEpicPlan.plan.id}/approve-run`, headers, payload: {},
    });
    db!.run("DROP TRIGGER fail_epic_context_manifest");
    expect(failedEpicApproval.statusCode).not.toBe(200);
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM agent_runs")?.count).toBe(beforeEpicFailure.runs);
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM context_manifests")?.count).toBe(beforeEpicFailure.manifests);
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM run_process_owners")?.count).toBe(beforeEpicFailure.owners);
    expect(vi.mocked(recoveryScheduler.dispatchAgentRun).mock.calls).toHaveLength(beforeEpicFailure.dispatches);
    const failedEpicId = db!.get<{ epic_id: string }>(
      "SELECT epic_id FROM planning_plans WHERE id=$planId", { planId: failedEpicPlan.plan.id },
    )?.epic_id;
    if (!failedEpicId) throw new Error("Failed Epic approval did not retain its Epic identity");
    expect(db!.get<{ status: string }>(
      "SELECT status FROM orchestration_phase_runs WHERE epic_id=$epicId ORDER BY created_at DESC LIMIT 1", { epicId: failedEpicId },
    )).toEqual({ status: "FAILED" });

    const acceptanceAddress = await runtimeApp.listen({ host: "127.0.0.1", port: acceptancePort });
    const acceptanceUrl = new URL(acceptanceAddress);
    const listeningPort = Number(acceptanceUrl.port);
    expect(acceptanceUrl.hostname).toBe("127.0.0.1");
    expect(listeningPort).toBe(acceptancePort);
    const runnerPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../web/test/e2e/run-e2e.mjs");
    const webRoot = resolve(dirname(runnerPath), "../..");
    const runnerEnvironment = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/(?:password|passwd|token|secret|credential)/i.test(key)),
    );
    runnerEnvironment.EBB_E2E_ATTACH_BACKEND_URL = acceptanceAddress;
    runnerEnvironment.EBB_E2E_ACCEPTED_RUNS_JSON = JSON.stringify(producerRunIds);
    const lifecycle = await import("../../../web/test/e2e/child-lifecycle.mjs") as unknown as {
      spawnManagedChild: (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; stdio: "inherit"; windowsHide: boolean }) => import("node:child_process").ChildProcess;
      waitForChildExit: (child: import("node:child_process").ChildProcess, timeoutMs: number) => Promise<{ exited: boolean; code: number | null; signal: NodeJS.Signals | null }>;
      terminateManagedChild: (child: import("node:child_process").ChildProcess) => Promise<unknown>;
    };
    const browserRunner = lifecycle.spawnManagedChild(process.execPath, [runnerPath, "--", "test/e2e/task7-accepted-runs.spec.ts"], {
      cwd: webRoot, env: runnerEnvironment, stdio: "inherit", windowsHide: true,
    });
    console.info(`[Plan20 Task7 browser] attached runner PID=${browserRunner.pid ?? "none"}; backend=${acceptanceUrl.origin}; producer Run IDs=${Object.keys(producerRunIds).length}`);
    const runnerExit = await lifecycle.waitForChildExit(browserRunner, 240_000);
    if (!runnerExit.exited) {
      await lifecycle.terminateManagedChild(browserRunner);
      throw new Error(`Plan20 Task7 attached browser runner exceeded its 240s deadline (PID=${browserRunner.pid ?? "none"})`);
    }
    expect(runnerExit, `Plan20 Task7 attached browser runner PID=${browserRunner.pid ?? "none"}`).toEqual({ exited: true, code: 0, signal: null });
    await runtimeApp.close();
    app = undefined;
    expect(runtimeApp.server.listening, "attached acceptance backend listener must close after the browser run").toBe(false);
    await assertLoopbackPortClosed(listeningPort);
  }, 300_000);

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

    const runtime = makeRuntime(db);
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

  function createHermesProducerHarness(runtime: HermesSelectionMatrixRuntime) {
    const runService = new RunService(db!, runtime);
    const scheduler = new SchedulerService(db!);
    vi.spyOn(scheduler, "dispatchTask").mockImplementation((taskId, engine, callback, options) => {
      const runId = typeof options === "object" && options !== null ? options.runId : undefined;
      if (typeof runId === "string") assertHermesSelectionDurableBeforeDispatch(db!, runtime, runId);
      return SchedulerService.prototype.dispatchTask.call(scheduler, taskId, engine, callback, options);
    });
    vi.spyOn(scheduler, "dispatchAgentRun").mockImplementation((runId, projectId, role, model, resourceKey, options) => {
      assertHermesSelectionDurableBeforeDispatch(db!, runtime, runId);
      expect(model).toBe("default");
      return SchedulerService.prototype.dispatchAgentRun.call(scheduler, runId, projectId, role, model, resourceKey, options);
    });
    vi.spyOn(scheduler, "dispatchRunRequest").mockImplementation((requestId, engine, prepare, canDispatch) => {
      const run = SchedulerService.prototype.dispatchRunRequest.call(scheduler, requestId, engine, prepare, canDispatch);
      if (run) assertHermesSelectionDurableBeforeDispatch(db!, runtime, run.id);
      return run;
    });
    const workflow = createAcceptanceWorkflow(db!);
    const planning = new PlanningService(db!);
    const integrationAttempts: IntegrationAttempt[] = [];
    const epicOrchestrator = new EpicOrchestrator(db!, workflow, planning, runService, {} as never, scheduler, {
      integrationServiceFactory: (context) => createMatrixIntegrationService(db!, root, context, integrationAttempts),
      integrationWorktreeRoot: join(root, "integration-worktrees"),
      epicWorkspaceProvisioner: new EpicWorkspaceProvisioner({ database: db!, worktreeDir: join(root, "epic-worktrees") }),
      taskWorkspaceProvisioner: new TaskWorkspaceProvisioner({
        database: db!, worktreeManager: new WorktreeManager({ db: db!, worktreeDir: join(root, "task-worktrees") }),
      }),
    });
    const producerApp = createApp({
      db: db!, scheduler, runService, runtime, epicOrchestrator, authService: createTestAuthService(),
    });
    app = producerApp;
    const worker = new SchedulerRunRequestWorker({ db: db!, scheduler, runs: runService, workflow, isReady: () => true });
    return { app: producerApp, runService, scheduler, epicOrchestrator, workflow, worker };
  }

  function createEventPath(
    runtime: MatrixRuntime = new HermesSelectionMatrixRuntime(db!),
    scheduler: SchedulerService = new SchedulerService(db!),
    runService: RunService = new RunService(db!, runtime),
    workflow: WorkflowEngine = createAcceptanceWorkflow(db!),
  ) {
    const dispatchSpy = vi.spyOn(runtime, "startRun").mockImplementation(async (run) => {
      const manifest = db!.get<{ subject_type: string; task_id: string | null; epic_id: string | null; request_id: string | null; role: string }>(
        "SELECT subject_type,task_id,epic_id,request_id,role FROM context_manifests WHERE run_id=$runId", { runId: run.id },
      );
      const expectedSubjectType = run.taskId ? "TASK" : run.epicId ? "EPIC" : manifest?.request_id ? "REQUEST" : undefined;
      const expectedRunStatus = run.triggerReason?.startsWith("epic-") ? "STARTED" : "IN_PROGRESS";
      expect(db!.get<{ task_id: string | null; role: string; status: string }>(
        "SELECT task_id,role,status FROM agent_runs WHERE id=$runId", { runId: run.id },
      )).toMatchObject({ task_id: run.taskId, role: run.role, status: expectedRunStatus });
      expect(db!.all("SELECT run_id FROM context_manifests WHERE run_id=$runId", { runId: run.id })).toHaveLength(1);
      expect(manifest).toMatchObject({
        subject_type: expectedSubjectType,
        task_id: run.taskId,
        epic_id: expectedSubjectType === "EPIC" ? run.epicId : null,
        role: run.role,
        ...(expectedSubjectType === "REQUEST" ? { request_id: expect.any(String) } : { request_id: null }),
      });
      expect(db!.get<{ source_tag: string; state: string }>(
        "SELECT source_tag,state FROM run_process_owners WHERE run_id=$runId", { runId: run.id },
      )).toEqual({ source_tag: `ebb-run:${run.id}`, state: "PREPARED" });
      return MatrixRuntime.prototype.startRun.call(runtime, run);
    });
    const workflowRegistry = new WorkflowRegistry();
    for (const template of Object.values(templates)) workflowRegistry.register(template);
    const eventBus = new EventBus();
    const dispatcher = new EventDispatcher(db!, eventBus);
    const runtimeOrchestrator = new RuntimeOrchestrator(db!, workflow, eventBus, dispatcher, scheduler, runService);
    runtimeOrchestrator.initialize();
    return { runtimeOrchestrator, dispatchSpy };
  }
});

function makeRuntime(database: Database): AgentRuntime {
  return {
    active: 0,
    maxActive: 1,
    calls: [],
    startRun: async (run: AgentRun) => {
      runtimeStarts += 1;
      assertFakeRuntimeNeverLaunched(database, run.id);
    },
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

function createAcceptanceWorkflow(database: Database): WorkflowEngine {
  const registry = new WorkflowRegistry();
  for (const template of Object.values(templates)) registry.register(template);
  return new WorkflowEngine(database, registry);
}

class MatrixRuntime implements AgentRuntime {
  active = 0;
  maxActive = 1;
  calls: Array<{ phase: string; role: string; taskId?: string; targetBranch?: string }> = [];
  private readonly completion: DatabaseCompletionStore;
  private interruptChildDeveloper = false;
  private interruptionResolver?: (runId: string) => void;

  constructor(private readonly database: Database) {
    this.completion = new DatabaseCompletionStore(database);
  }

  interruptNextEpicChildDeveloper(): Promise<string> {
    this.interruptChildDeveloper = true;
    return new Promise((resolve) => { this.interruptionResolver = resolve; });
  }

  async startRun(run: AgentRun): Promise<void> {
    const phase = this.database.get<{ phase: string; task_id: string | null }>(
      "SELECT phase,task_id FROM orchestration_phase_runs WHERE agent_run_id=$runId", { runId: run.id },
    );
    this.calls.push({ phase: phase?.phase ?? "unbound", role: run.role, ...(phase?.task_id ? { taskId: phase.task_id } : {}) });
    if (this.interruptChildDeveloper && run.role.toLowerCase() === "developer" && phase?.phase === "child_task" && phase.task_id) {
      this.interruptChildDeveloper = false;
      const identity = fakeLiveProcessIdentity(run.id);
      this.database.transaction((tx) => {
        transitionRunProcessOwnerTx(tx, { runId: run.id, expectedState: "PREPARED", nextState: "LAUNCHING" });
        transitionRunProcessOwnerTx(tx, { runId: run.id, expectedState: "LAUNCHING", nextState: "LIVE", identity });
      });
      this.interruptionResolver?.(run.id);
      throw new Error("TEST_SIMULATED_PROCESS_INTERRUPTION");
    }
    // This fake has no child process: establish its bounded no-launch terminal evidence before accepting fixture output.
    assertFakeRuntimeNeverLaunched(this.database, run.id);
    const output = run.role.toLowerCase() === "integration"
      ? this.integrationOutput(run.id)
      : run.role.toLowerCase() === "coordinator" && run.epicId
        ? approvedEpicCoordinatorOutput(this.database, run.epicId)
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

/** Test-only preflight seam; it does not exercise provider acceptance, read credentials, create a profile, or launch an OS process. */
class HermesSelectionMatrixRuntime extends MatrixRuntime {
  readonly producerEvents: Array<{ kind: "preflight" | "dispatch" | "launch"; runId: string }> = [];
  private readonly selections = new Map<string, HermesManagedRunSelection>();
  private nextPreflightGate: {
    entered(runId: string): void;
    wait: Promise<void>;
  } | undefined;

  constructor(private readonly selectionDatabase: Database) {
    super(selectionDatabase);
  }

  gateNextPreflight(): { entered: Promise<string>; release(): void } {
    let notifyEntered!: (runId: string) => void;
    let release!: () => void;
    const entered = new Promise<string>((resolve) => { notifyEntered = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    this.nextPreflightGate = { entered: notifyEntered, wait };
    return { entered, release };
  }

  async prepareHermesRunSelection(runId: string) {
    expect(this.selectionDatabase.get("SELECT id FROM agent_runs WHERE id=$runId", { runId })).toBeUndefined();
    expect(this.selectionDatabase.get("SELECT run_id FROM context_manifests WHERE run_id=$runId", { runId })).toBeUndefined();
    expect(this.selectionDatabase.get("SELECT run_id FROM run_process_owners WHERE run_id=$runId", { runId })).toBeUndefined();
    const selection = Object.freeze(createHermesManagedSelectionFixture(runId, hermesSourceSnapshotKey));
    this.selections.set(runId, selection);
    this.producerEvents.push({ kind: "preflight", runId });
    const gate = this.nextPreflightGate;
    this.nextPreflightGate = undefined;
    if (gate) {
      gate.entered(runId);
      await gate.wait;
    }
    return { selection };
  }

  selectionFor(runId: string): HermesManagedRunSelection {
    const selection = this.selections.get(runId);
    if (!selection) throw new Error(`Hermes selection was not prepared for ${runId}`);
    return selection;
  }

  recordDispatch(runId: string): void {
    this.producerEvents.push({ kind: "dispatch", runId });
  }

  override async startRun(run: AgentRuntimeRun): Promise<void> {
    const selection = this.selectionFor(run.id);
    expect(run.hermesSelection).toEqual(selection);
    const preflightIndex = this.producerEvents.findIndex((event) => event.kind === "preflight" && event.runId === run.id);
    const dispatchIndex = this.producerEvents.findIndex((event) => event.kind === "dispatch" && event.runId === run.id);
    expect(preflightIndex, `Hermes preflight must precede launch for ${run.id}`).toBeGreaterThanOrEqual(0);
    expect(dispatchIndex, `scheduler dispatch must precede launch for ${run.id}`).toBeGreaterThanOrEqual(0);
    expect(preflightIndex).toBeLessThan(dispatchIndex);
    expect(this.selectionDatabase.get<{ model: string }>("SELECT model FROM agent_runs WHERE id=$runId", { runId: run.id }))
      .toEqual({ model: "default" });
    expect(this.selectionDatabase.get("SELECT run_id FROM context_manifests WHERE run_id=$runId", { runId: run.id })).toBeDefined();
    expect(this.selectionDatabase.get<{ state: string }>("SELECT state FROM run_process_owners WHERE run_id=$runId", { runId: run.id }))
      .toEqual({ state: "PREPARED" });
    this.producerEvents.push({ kind: "launch", runId: run.id });
    await super.startRun(run);
  }
}

function assertHermesSelectionDurableBeforeDispatch(
  database: Database,
  runtime: HermesSelectionMatrixRuntime,
  runId: string,
): void {
  const preflightIndex = runtime.producerEvents.findIndex((event) => event.kind === "preflight" && event.runId === runId);
  expect(preflightIndex, `Hermes selection preflight must precede dispatch for ${runId}`).toBeGreaterThanOrEqual(0);
  const run = database.get<{ model: string }>("SELECT model FROM agent_runs WHERE id=$runId", { runId });
  expect(run).toEqual({ model: "default" });
  expect(database.all("SELECT run_id FROM context_manifests WHERE run_id=$runId", { runId })).toHaveLength(1);
  expect(database.get<{ state: string }>("SELECT state FROM run_process_owners WHERE run_id=$runId", { runId }))
    .toEqual({ state: "PREPARED" });
  runtime.recordDispatch(runId);
  const dispatchIndex = runtime.producerEvents.findIndex((event) => event.kind === "dispatch" && event.runId === runId);
  expect(preflightIndex).toBeLessThan(dispatchIndex);
}

function assertNoRunProducerWrites(database: Database, runtime: HermesSelectionMatrixRuntime, runId: string): void {
  expect(database.get("SELECT id FROM agent_runs WHERE id=$runId", { runId })).toBeUndefined();
  expect(database.get("SELECT run_id FROM context_manifests WHERE run_id=$runId", { runId })).toBeUndefined();
  expect(database.get("SELECT run_id FROM run_process_owners WHERE run_id=$runId", { runId })).toBeUndefined();
  expect(runtime.producerEvents.filter((event) => event.runId === runId).map((event) => event.kind)).toEqual(["preflight"]);
}

/** Test runtime starts no OS process; explicit fake-supervisor evidence closes PREPARED as never launched. */
function assertFakeRuntimeNeverLaunched(database: Database, runId: string): void {
  const owner = database.get<{ run_id: string; source_tag: string; state: string }>(
    "SELECT run_id,source_tag,state FROM run_process_owners WHERE run_id=$runId", { runId },
  );
  if (owner?.run_id !== runId || owner.source_tag !== `ebb-run:${runId}` || owner.state !== "PREPARED") {
    throw new Error(`Fake supervisor cannot prove never-launched scope for ${runId}`);
  }
  database.transaction((tx) => transitionRunProcessOwnerTx(tx, {
    runId, expectedState: "PREPARED", nextState: "STOPPED", evidence: "NEVER_LAUNCHED",
  }));
}

/** Persisted only as a test restart checkpoint; it does not represent a native or provider-backed process. */
function fakeLiveProcessIdentity(runId: string) {
  if (process.platform === "win32") {
    return {
      platform: "win32",
      supervisorPid: process.pid,
      supervisorStartIdentity: "acceptance-test-supervisor",
      pid: process.pid,
      processStartIdentity: `acceptance-test-process:${runId}`,
      executableIdentity: "acceptance-test-runtime",
    };
  }
  return {
    platform: "linux",
    systemdInvocationId: runId.replace(/-/g, ""),
    systemdControlGroup: `/user.slice/ebb-acceptance-${runId}.scope`,
    pid: process.pid,
  };
}

function roleOutput(role: string): unknown {
  switch (role.toLowerCase()) {
    case "developer": return { version: "1.0", outcome: "COMPLETED", commitSha: "e".repeat(40) };
    case "reviewer": return { version: "1.0", outcome: "PASS", independent: true };
    case "qa": return { version: "1.0", outcome: "PASS", evidence: ["Acceptance criteria verified"] };
    case "coordinator": return {
      version: "1", operation: "PLAN", classification: "EPIC",
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
      proposals: [], architectureReviewRequired: true,
    };
    default: throw new Error(`No acceptance output for role ${role}`);
  }
}

function approvedEpicCoordinatorOutput(database: Database, epicId: string): unknown {
  const row = database.get<{ plan_json: string }>(
    "SELECT plan_json FROM planning_plans WHERE epic_id=$epicId AND status='APPROVED'",
    { epicId },
  );
  if (!row) throw new Error(`Approved plan is missing for Epic ${epicId}`);
  const approved = JSON.parse(row.plan_json) as { epic?: unknown; tasks?: unknown };
  if (!approved.epic || !Array.isArray(approved.tasks)) throw new Error(`Approved Epic plan is malformed for ${epicId}`);
  return { version: "1", operation: "PLAN", classification: "EPIC", plan: { epic: approved.epic, tasks: approved.tasks } };
}

function phaseRunId(database: Database, epicId: string, taskId: string | null, phase: string): string {
  const row = database.get<{ agent_run_id: string }>(
    "SELECT agent_run_id FROM orchestration_phase_runs WHERE epic_id=$epicId AND task_id IS $taskId AND phase=$phase AND status='COMPLETED' AND validated=1",
    { epicId, taskId, phase },
  );
  if (!row?.agent_run_id) throw new Error(`Production phase did not persist a completed Run: ${epicId}:${taskId ?? "epic"}:${phase}`);
  return row.agent_run_id;
}

function producerSubjectRole(
  label: string,
  ids: { epicId: string; epicTaskId: string; requestId: string },
): { subject_type: string; role: string; task_id: string | null; epic_id: string | null; request_id: string | null } {
  const taskRoles: Record<string, string> = {
    "task-http-developer": "developer",
    "task-http-reviewer": "reviewer",
    "task-http-qa": "qa",
    "epic-child-developer-task": "developer",
    "epic-child-developer-reconcile": "developer",
    "epic-child-reviewer": "reviewer",
    "epic-child-qa": "qa",
    "epic-task-integration": "integration",
  };
  const epicRoles: Record<string, string> = {
    "epic-plan": "coordinator",
    "epic-pm": "product_manager",
    "epic-initial-architect": "architect",
    "epic-review": "reviewer",
    "epic-architecture-review": "architect",
    "epic-qa": "qa",
    "epic-final-integration": "integration",
  };
  const requestRoles: Record<string, string> = {
    "request-coordinator": "coordinator",
    "request-product_manager": "product_manager",
    "request-architect": "architect",
  };
  if (taskRoles[label]) {
    const taskId = label.startsWith("task-http-")
      ? ({
          "task-http-developer": "task-acceptance",
          "task-http-reviewer": "task-http-reviewer",
          "task-http-qa": "task-http-qa",
        } as const)[label as "task-http-developer" | "task-http-reviewer" | "task-http-qa"]
      : ids.epicTaskId;
    return { subject_type: "TASK", role: taskRoles[label]!, task_id: taskId, epic_id: null, request_id: null };
  }
  if (epicRoles[label]) return { subject_type: "EPIC", role: epicRoles[label]!, task_id: null, epic_id: ids.epicId, request_id: null };
  if (requestRoles[label]) return { subject_type: "REQUEST", role: requestRoles[label]!, task_id: null, epic_id: null, request_id: ids.requestId };
  throw new Error(`Unknown context-manifest producer label: ${label}`);
}

function addTaskFixture(database: Database, rootPath: string, repositoryPath: string, taskId: string): void {
  const path = join(rootPath, taskId);
  const branch = `task/${taskId}`;
  execFileSync("git", ["worktree", "add", "--quiet", "-b", branch, path, "HEAD"], {
    cwd: repositoryPath, windowsHide: true,
  });
  const now = new Date().toISOString();
  database.run("INSERT INTO tasks(id,project_id,display_id,title,status,contract_json,created_at,updated_at) VALUES($id,'project-acceptance',$displayId,$title,'READY',$contract,$now,$now)", {
    id: taskId,
    displayId: taskId.toUpperCase(),
    title: `Acceptance ${taskId}`,
    contract: JSON.stringify({ version: 1, goal: "persisted task contract", context: "acceptance task context", requirements: ["manifest"], acceptanceCriteria: ["prompt is exact"], dependencies: [], nonGoals: [], definitionOfDone: ["reviewable"] }),
    now,
  });
  database.run("INSERT INTO worktrees(id,repo_path,path,branch,created_at) VALUES($id,$repositoryPath,$path,$branch,$now)", {
    id: taskId, repositoryPath, path, branch, now,
  });
  database.run("INSERT INTO git_operations(id,type,status,repo_path,branch_name,worktree_id,target_ref,created_at,verified_at) VALUES($operationId,'CREATE_WORKTREE','VERIFIED',$repositoryPath,$branch,$taskId,'HEAD',$now,$now)", {
    operationId: `${taskId}-create-worktree`, repositoryPath, branch, taskId, now,
  });
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
