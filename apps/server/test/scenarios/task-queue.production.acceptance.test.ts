import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDatabase } from "../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../helpers/migrations.js";
import { seedApprovedProjectConfig } from "../helpers/approved-project-config.js";
import { markFakeRunNeverLaunched } from "../helpers/fake-run-process-owner.js";
import { transitionRunProcessOwnerTx } from "../../src/modules/runtime/run-process-owner.js";
import { createProductionComposition } from "../../src/platform/home/production-composition.js";
import { resolveOrchestratorHome } from "../../src/platform/home/orchestrator-home.js";
import { StatusTracker } from "../../src/platform/process/system-lifecycle.js";
import { SchedulerService } from "../../src/modules/scheduler/scheduler-service.js";
import { ApprovalService } from "../../src/modules/approvals/approval-service.js";
import { WorkflowEngine } from "../../src/modules/workflow/workflow-engine.js";
import { WorkflowRegistry } from "../../src/modules/workflow/workflow-registry.js";
import { templates } from "../../src/modules/workflow/templates.js";
import { RunService } from "../../src/modules/runtime/run-service.js";
import { prepareTaskRunOptions } from "../../src/modules/runtime/task-run-context.js";
import { RuntimeOrchestrator } from "../../src/modules/runtime/run-orchestrator.js";
import { RuntimeEventHandlers } from "../../src/modules/runtime/run-event-handlers.js";
import { DatabaseCompletionStore } from "../../src/modules/execution/mcp/submit-result-tool.js";
import type { AgentRuntime } from "../../src/modules/runtime/agent-runtime.js";
import { EventBus } from "../../src/platform/events/event-bus.js";
import { EventDispatcher } from "../../src/platform/events/event-dispatcher.js";
import { GitCli } from "../../src/modules/git/git-cli.js";
import { WorktreeManager } from "../../src/modules/git/worktree-manager.js";
import { createApp } from "../../src/app/create-app.js";
import { createTestAuthService, TEST_COOKIE, TEST_CSRF_TOKEN } from "../helpers/auth.js";

describe("production Task queue transaction and handoff", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
  async function setup() {
    const root = await mkdtemp(join(tmpdir(), "ebb-task-queue-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const dbPath = join(root, "state.sqlite");
    let db = createSqliteDatabase(dbPath);
    cleanups.push(async () => { db.close(); });
    runMigrations(db, loadTestMigrations());
    const repo = join(root, "repo");
    await mkdir(repo);
    const git = new GitCli();
    await git.run(repo, ["init", "-b", "master"]);
    await git.run(repo, ["config", "user.name", "Test"]);
    await git.run(repo, ["config", "user.email", "test@example.com"]);
    await writeFile(join(repo, "readme.md"), "test\n");
    await git.run(repo, ["add", "."]);
    await git.run(repo, ["commit", "-m", "fixture"]);
    const projectId = randomUUID();
    const now = "2026-10-14T00:00:00.000Z";
    const approval = randomUUID();
    db.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'Project','Project','ACTIVE',$now,$now)", { id: projectId, now });
    db.run("INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,created_at) VALUES($id,'WORKFLOW_CHANGE',$projectId,'PROJECT','APPROVED','test',$now)", { id: approval, projectId, now });
    db.run("INSERT INTO onboarding_configs(project_id,repository_path,facts_json,proposed_json,status,approval_id,created_at,updated_at) VALUES($projectId,$repo,'{\"defaultBranch\":\"master\"}','{\"defaultBranch\":\"master\"}','ACTIVE',$approval,$now,$now)", { projectId, repo, approval, now });
    seedApprovedProjectConfig(db, projectId);
    const scheduler = new SchedulerService(db, () => new Date(now));
    scheduler.updateConfig({ ...scheduler.getConfig(), globalMax: 1, projectMax: 1 });
    const registry = new WorkflowRegistry();
    for (const template of Object.values(templates)) registry.register(template);
    const workflow = new WorkflowEngine(db, registry);
    const status = new StatusTracker();
    await status.set("RECOVERING");
    let completion = new DatabaseCompletionStore(db);
    const starts: string[] = [];
    const runtime: AgentRuntime = {
      active: 0, maxActive: 0, calls: [],
      async startRun(run) {
        starts.push(run.id);
        markFakeRunNeverLaunched(db, run.id);
        let commitSha = "a".repeat(40);
        if (run.role === "developer") {
          const capability = db.get<{ capability_json: string }>("SELECT capability_json FROM agent_runs WHERE id=$id", { id: run.id })!;
          const workspace = (JSON.parse(capability.capability_json) as { workspace: string }).workspace;
          await writeFile(join(workspace, "task.txt"), run.id);
          await git.run(workspace, ["add", "task.txt"]);
          await git.run(workspace, ["commit", "-m", "fixture task"]);
          commitSha = (await git.run(workspace, ["rev-parse", "HEAD"])).stdout.trim();
        }
        const attempt = run.role === "integration" ? db.get<{ id: string; expected_target_sha: string; source_sha: string }>("SELECT id,expected_target_sha,source_sha FROM integration_attempts WHERE integration_run_id=$id", { id: run.id }) : undefined;
        const output = run.role === "developer" ? { version: "1", outcome: "COMPLETED", commitSha }
          : attempt ? { version: "1", outcome: "PASS", baseSha: attempt.expected_target_sha, sourceSha: attempt.source_sha, provenance: [`integration_attempt:${attempt.id}`], evidence: ["fixture integration"] }
          : { version: "1", outcome: "PASS" };
        if (!run.capabilityRef || !await completion.accept(run.capabilityRef, { runId: run.id, role: run.role, output })) throw new Error("fixture submission rejected");
      },
      async collectResult(runId) { return { success: true, exitCode: 0, output: completion.getSubmission(runId)!.output, validatedSubmission: true,
        diagnostics: { runId, sessionId: null, stderr: "", exitCode: 0, artifactReferences: [] } }; },
      async collectUsage() { return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, cost: 0 }; },
      async cancelRun() {}, async resumeRun() {}, async inspectRun() { throw new Error("unused"); },
      async runResult(runId) { return this.collectResult(runId); }, async healthCheck() { return true; },
    };
    const runs = new RunService(db, runtime);
    const bus = new EventBus();
    const dispatcher = new EventDispatcher(db, bus, () => status.get() === "READY");
    new RuntimeOrchestrator(db, workflow, bus, dispatcher, scheduler, runs, () => status.get() === "READY").initialize();
    const production = createProductionComposition({ database: db, home: resolveOrchestratorHome({ EBB_ORCHESTRATOR_HOME: root }, "win32") });
    const queue = production.createTaskRunQueue({ scheduler, runs, workflow, status, eventBus: bus });
    const app = createApp({ db, scheduler, runService: runs, status, authService: createTestAuthService() });
    cleanups.push(async () => { await queue.stop(); await app.close(); });
    async function task(category = "new-development", priority = "Normal", wait: string | null = null) {
      const id = randomUUID();
      const contract = { version: 1, goal: "test", context: "test", requirements: ["test"], acceptanceCriteria: ["test"], dependencies: [], nonGoals: [], definitionOfDone: ["test"], ...(category !== "new-development" ? { category } : {}), ...(priority !== "Normal" ? { priority } : {}) };
      db.run("INSERT INTO tasks(id,project_id,display_id,title,status,contract_json,capacity_wait_started_at,created_at,updated_at) VALUES($id,$projectId,$id,'Task','READY',$contract,$wait,$now,$now)", { id, projectId, contract: JSON.stringify(contract), wait, now });
      await new WorktreeManager({ db, worktreeDir: join(root, "worktrees") }).createTaskWorkspace(id, repo, "master");
      return id;
    }
    async function request(taskId: string, key = randomUUID(), role = "developer") {
      const response = await app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/dispatch`,
        headers: { cookie: TEST_COOKIE, origin: "http://127.0.0.1:3000", "x-csrf-token": TEST_CSRF_TOKEN, "idempotency-key": key }, payload: { role, model: "default" } });
      expect(response.statusCode).toBe(202);
      return response.json<{ requestId: string; taskId: string; status: string; runId: string | null }>();
    }
    const count = (table: string) => db.get<{ count: number }>(`SELECT count(*) AS count FROM ${table}`)?.count;
    function restart() {
      db.close(); db = createSqliteDatabase(dbPath);
      completion = new DatabaseCompletionStore(db);
      const newScheduler = new SchedulerService(db, () => new Date(now));
      const newRuns = new RunService(db, runtime);
      const newWorkflow = new WorkflowEngine(db, registry);
      const newBus = new EventBus();
      const newDispatcher = new EventDispatcher(db, newBus, () => status.get() === "READY");
      new RuntimeOrchestrator(db, newWorkflow, newBus, newDispatcher, newScheduler, newRuns, () => status.get() === "READY").initialize();
      const newComposition = createProductionComposition({ database: db, home: resolveOrchestratorHome({ EBB_ORCHESTRATOR_HOME: root }, "win32") });
      const newQueue = newComposition.createTaskRunQueue({ scheduler: newScheduler, runs: newRuns, workflow: newWorkflow, status, eventBus: newBus });
      cleanups.push(() => newQueue.stop());
      return { db, scheduler: newScheduler, runs: newRuns, dispatcher: newDispatcher, queue: newQueue };
    }
    return { db, dbPath, root, scheduler, status, runs, runtime, bus, dispatcher, queue, starts, task, request, count, restart };
  }

  it("defers RECOVERING and selects only the ordered winner at capacity one", async () => {
    const f = await setup();
    const low = await f.task("new-development", "Critical", "2026-10-01T00:00:00.000Z");
    const high = await f.task("rework", "Low");
    const lowRequest = await f.request(low);
    const highRequest = await f.request(high);
    await f.queue.tick();
    expect(f.count("agent_runs")).toBe(0);
    await f.status.set("READY");
    const candidate = f.scheduler.nextRunRequest();
    expect(candidate?.id).toBe(highRequest.requestId);
    const options = await prepareTaskRunOptions(f.db, candidate!);
    expect(() => f.runs.prepareRunContext(options)).not.toThrow();
    await Promise.all([f.queue.tick(), f.queue.tick()]);
    expect(f.count("agent_runs")).toBe(1);
    expect(f.count("context_manifests")).toBe(1);
    expect(f.count("run_process_owners")).toBe(1);
    expect(f.scheduler.getRunRequest(high, highRequest.requestId)).toMatchObject({ status: "DISPATCHED", runId: expect.any(String) });
    expect(f.scheduler.getRunRequest(low, lowRequest.requestId)).toMatchObject({ status: "PENDING", runId: null });
    await f.status.set("RECOVERING");
    const event = f.db.get("SELECT * FROM outbox_events WHERE type='AgentRunRequested'");
    await f.dispatcher.dispatchBatch(100);
    expect(f.starts).toHaveLength(0);
    expect(f.db.get("SELECT * FROM outbox_events WHERE type='AgentRunRequested'")).toEqual(event);
    await f.status.set("READY");
    await f.dispatcher.dispatchBatch(100);
    expect(f.starts).toHaveLength(1);
    await f.queue.tick();
    expect(f.scheduler.getRunRequest(low, lowRequest.requestId)?.status).toBe("PENDING");
    expect(f.db.get("SELECT id FROM scheduler_run_requests WHERE origin_type='TASK_STAGE' AND status='DISPATCHED'")).toBeTruthy();
  });

  it("rolls back every write after Run insert and retries the same pending request", async () => {
    const f = await setup();
    const taskId = await f.task();
    const request = await f.request(taskId);
    await f.status.set("READY");
    const original = f.runs.prepareRunInTransaction.bind(f.runs);
    vi.spyOn(f.runs, "prepareRunInTransaction").mockImplementation((tx, options, prepared) => {
      return original(tx, options, prepared, () => { throw new Error("injected transient failure"); });
    });
    await f.queue.tick();
    for (const table of ["agent_runs", "context_manifests", "run_process_owners", "scheduler_reservations"]) expect(f.count(table)).toBe(0);
    expect(f.db.get<{ status: string }>("SELECT status FROM tasks WHERE id=$id", { id: taskId })?.status).toBe("READY");
    expect(f.scheduler.getRunRequest(taskId, request.requestId)?.status).toBe("PENDING");
    expect(f.db.get<{ count: number }>("SELECT count(*) AS count FROM outbox_events WHERE type='AgentRunRequested'")?.count).toBe(0);
    vi.restoreAllMocks();
    await f.queue.tick();
    expect(f.count("agent_runs")).toBe(1);
  });

  it("replays duplicate deliveries and a lost ack without launching or projecting twice", async () => {
    const f = await setup();
    const taskId = await f.task();
    await f.request(taskId);
    await f.status.set("READY");
    await f.queue.tick();
    const event = f.db.get<{ id: string }>("SELECT id FROM outbox_events WHERE type='AgentRunRequested'")!;
    await Promise.all([f.dispatcher.dispatchBatch(100), f.dispatcher.dispatchBatch(100)]);
    expect(f.starts).toHaveLength(1);
    expect(f.count("run_completion_projections")).toBe(1);
    f.db.run("DELETE FROM processed_events WHERE event_id=$id", { id: event.id });
    f.db.run("UPDATE outbox_events SET processed_at=NULL,available_at='2026-01-01T00:00:00.000Z' WHERE id=$id", { id: event.id });
    await f.dispatcher.dispatchBatch(100);
    expect(f.starts).toHaveLength(1);
    expect(f.count("run_completion_projections")).toBe(1);
    expect(f.db.get<{ status: string }>("SELECT status FROM tasks WHERE id=$id", { id: taskId })?.status).toBe("REVIEW");
  });

  it("selects durable aged priority within one category", async () => {
    const f = await setup();
    const younger = await f.task("new-development", "Normal");
    const aged = await f.task("new-development", "Low", "2026-10-10T00:00:00.000Z");
    await f.request(younger); await f.request(aged);
    await f.status.set("READY"); await f.queue.tick();
    expect(f.db.get<{ task_id: string }>("SELECT task_id FROM agent_runs")?.task_id).toBe(aged);
  });

  it("recovers a stopped committed Run after crash with one new source attempt key", async () => {
    const f = await setup();
    const taskId = await f.task();
    const initial = await f.request(taskId);
    await f.status.set("READY"); await f.queue.tick();
    const oldRunId = f.scheduler.getRunRequest(taskId, initial.requestId)!.runId!;
    await f.status.set("RECOVERING");
    markFakeRunNeverLaunched(f.db, oldRunId);
    f.runs.reconcileInterruptedRuns();
    await f.status.set("READY");
    await f.queue.tick(); await f.queue.tick();
    expect(f.count("scheduler_run_requests")).toBe(2);
    expect(f.db.get<{ count: number }>("SELECT count(*) AS count FROM scheduler_run_requests WHERE origin_type='TASK_RECOVERY' AND origin_id=$id", { id: oldRunId })?.count).toBe(1);
    await f.dispatcher.dispatchBatch(100);
    expect(f.starts).not.toContain(oldRunId);
    expect(f.starts).toHaveLength(1);
  });

  it("runs all standalone roles and waits for FINAL_MERGE approval before entering MERGING", async () => {
    const f = await setup();
    const executionErrors: string[] = [];
    const execute = f.runs.executeTaskRequestRun.bind(f.runs);
    vi.spyOn(f.runs, "executeTaskRequestRun").mockImplementation(async (...args) => {
      try { return await execute(...args); } catch (error) { executionErrors.push(error instanceof Error ? error.message : "unknown"); throw error; }
    });
    const taskId = await f.task();
    await f.request(taskId); await f.status.set("READY");
    for (let iteration = 0; iteration < 8; iteration++) { await f.queue.tick(); await f.dispatcher.dispatchBatch(100); }
    expect(executionErrors).toEqual([]);
    expect(f.db.get<{ status: string }>("SELECT status FROM tasks WHERE id=$id", { id: taskId })?.status).toBe("READY_FOR_MERGE");
    expect(f.db.all<{ role: string }>("SELECT role FROM agent_runs ORDER BY started_at").map(({ role }) => role)).toEqual(["developer", "reviewer", "qa", "integration"]);
    const pendingApprovals = f.db.all<{ id: string; subject_type: string; requested_by: string }>(
      "SELECT id, subject_type, requested_by FROM approvals WHERE subject_id=$id AND type='FINAL_MERGE' AND status='PENDING'",
      { id: taskId },
    );
    expect(pendingApprovals).toHaveLength(1);
    expect(pendingApprovals[0]).toMatchObject({ subject_type: "TASK", requested_by: "runtime-orchestrator" });
    const approval = new ApprovalService(f.db).approve(pendingApprovals[0]!.id, "test-human", "acceptance approval");
    expect(approval.status).toBe("APPROVED");
    await f.dispatcher.dispatchBatch(100);
    expect(f.db.get<{ status: string }>("SELECT status FROM tasks WHERE id=$id", { id: taskId })?.status).toBe("MERGING");
    expect(f.count("run_completion_projections")).toBe(4);
    const reviewer = f.db.get<{ prompt: string }>("SELECT prompt FROM agent_runs WHERE role='reviewer'")!;
    expect(reviewer.prompt).toContain("Independently review"); expect(reviewer.prompt).toContain("task.txt");
    expect(reviewer.prompt).not.toContain("=== DEVELOPER TRANSCRIPT ===");
  });

  it("reopens a pending request after capacity wait and keeps its durable age", async () => {
    const f = await setup();
    const first = await f.task(); const waiting = await f.task();
    await f.request(first); const pending = await f.request(waiting);
    await f.status.set("READY"); await f.queue.tick();
    const winner = f.db.get<{ task_id: string; id: string }>("SELECT task_id,id FROM agent_runs")!;
    const waitingId = winner.task_id === first ? waiting : first;
    const pendingId = waitingId === waiting ? pending.requestId : f.db.get<{ id: string }>("SELECT id FROM scheduler_run_requests WHERE task_id=$id", { id: waitingId })!.id;
    f.scheduler.reconcile();
    const age = f.db.get<{ capacity_wait_started_at: string }>("SELECT capacity_wait_started_at FROM tasks WHERE id=$id", { id: waitingId })!.capacity_wait_started_at;
    await f.status.set("RECOVERING");
    const restarted = f.restart(); await restarted.queue.tick();
    expect(restarted.scheduler.getRunRequest(waitingId, pendingId)).toMatchObject({ status: "PENDING", runId: null });
    expect(restarted.db.get<{ capacity_wait_started_at: string }>("SELECT capacity_wait_started_at FROM tasks WHERE id=$id", { id: waitingId })!.capacity_wait_started_at).toBe(age);
    markFakeRunNeverLaunched(restarted.db, winner.id); restarted.runs.reconcileInterruptedRuns();
    await f.status.set("READY"); await restarted.queue.tick();
    expect(f.count("agent_runs")).toBe(2);
    expect(restarted.db.get<{ count: number }>("SELECT count(*) AS count FROM scheduler_reservations WHERE status='RESERVED'")?.count).toBe(1);
  });

  it("replays a completed stored outcome after DB restart before Workflow projection/ack", async () => {
    const f = await setup(); const taskId = await f.task(); await f.request(taskId);
    await f.status.set("READY"); await f.queue.tick();
    const project = vi.spyOn(RuntimeEventHandlers.prototype, "handleRuntimeCompletion").mockImplementationOnce(() => { throw new Error("injected crash before projection"); });
    await f.dispatcher.dispatchBatch(100);
    expect(f.count("run_completion_projections")).toBe(0);
    expect(f.db.get<{ status: string }>("SELECT status FROM agent_runs")?.status).toBe("COMPLETED");
    project.mockRestore();
    await f.status.set("RECOVERING"); const restarted = f.restart();
    restarted.db.run("UPDATE outbox_events SET available_at='2026-01-01T00:00:00.000Z' WHERE type='AgentRunRequested'");
    await restarted.dispatcher.dispatchBatch(100); expect(f.starts).toHaveLength(1);
    await f.status.set("READY"); await restarted.dispatcher.dispatchBatch(100); await restarted.dispatcher.dispatchBatch(100);
    expect(f.starts).toHaveLength(1); expect(f.count("run_completion_projections")).toBe(1);
    expect(restarted.db.get<{ status: string }>("SELECT status FROM tasks WHERE id=$id", { id: taskId })?.status).toBe("REVIEW");
    expect(restarted.db.get<{ count: number }>("SELECT count(*) AS count FROM scheduler_run_requests WHERE origin_type='TASK_STAGE'")?.count).toBe(1);
  });

  it("uses the unfinished BLOCKING forward chain to break equal priority", async () => {
    const f = await setup(); const short = await f.task(); const long = await f.task(); const child = await f.task();
    f.db.run("INSERT INTO dependencies(task_id,depends_on_task_id,type,created_at) VALUES($child,$parent,'BLOCKING','2026-10-14T00:00:00.000Z')", { child, parent: long });
    await f.request(short); await f.request(long); await f.status.set("READY"); await f.queue.tick();
    expect(f.db.get<{ task_id: string }>("SELECT task_id FROM agent_runs")?.task_id).toBe(long);
  });

  it("serializes two production workers over separate SQLite connections", async () => {
    const f = await setup(); const taskId = await f.task(); await f.request(taskId);
    const secondDb = createSqliteDatabase(f.dbPath);
    const secondScheduler = new SchedulerService(secondDb);
    const registry = new WorkflowRegistry(); for (const template of Object.values(templates)) registry.register(template);
    const secondComposition = createProductionComposition({ database: secondDb, home: resolveOrchestratorHome({ EBB_ORCHESTRATOR_HOME: f.root }, "win32") });
    const secondQueue = secondComposition.createTaskRunQueue({ scheduler: secondScheduler, runs: new RunService(secondDb, f.runtime), workflow: new WorkflowEngine(secondDb, registry), status: f.status, eventBus: new EventBus() });
    try {
      await f.status.set("READY"); await Promise.all([f.queue.tick(), secondQueue.tick()]);
      expect(f.count("agent_runs")).toBe(1); expect(f.count("context_manifests")).toBe(1);
      expect(f.count("scheduler_reservations")).toBe(1); expect(f.count("run_process_owners")).toBe(1);
    } finally { await secondQueue.stop(); secondDb.close(); }
  });

  it("retains reservation and forbids recovery when the executing owner stop is unknown", async () => {
    const f = await setup(); const taskId = await f.task(); await f.request(taskId);
    f.runtime.startRun = async (run) => {
      f.db.transaction((tx) => {
        transitionRunProcessOwnerTx(tx, { runId: run.id, expectedState: "PREPARED", nextState: "LAUNCHING" });
        transitionRunProcessOwnerTx(tx, { runId: run.id, expectedState: "LAUNCHING", nextState: "UNKNOWN", evidence: "TEST_SCOPE_UNKNOWN" });
      });
      throw new Error("scope stop unproven");
    };
    await f.status.set("READY"); await f.queue.tick(); await f.dispatcher.dispatchBatch(100);
    f.scheduler.reconcile(); await f.queue.tick();
    expect(f.db.get<{ status: string }>("SELECT status FROM agent_runs")?.status).toBe("IN_PROGRESS");
    expect(f.db.get<{ state: string }>("SELECT state FROM run_process_owners")?.state).toBe("UNKNOWN");
    expect(f.db.get<{ status: string }>("SELECT status FROM scheduler_reservations")?.status).toBe("RESERVED");
    expect(f.count("scheduler_run_requests")).toBe(1);
    await f.status.set("RECOVERING");
    const restarted = f.restart();
    expect(restarted.runs.reconcileInterruptedRuns()).toBe(0);
    expect(restarted.db.get<{ status: string }>("SELECT status FROM agent_runs")?.status).toBe("IN_PROGRESS");
    expect(restarted.db.get<{ status: string }>("SELECT status FROM scheduler_reservations")?.status).toBe("RESERVED");
    await restarted.queue.tick(); expect(f.count("agent_runs")).toBe(1);
  });

  it("recovers an in-progress fake runtime only after canonical STOPPED proof and never relaunches it", async () => {
    const f = await setup(); const taskId = await f.task(); const original = await f.request(taskId);
    await f.status.set("READY"); await f.queue.tick();
    const oldRunId = f.scheduler.getRunRequest(taskId, original.requestId)!.runId!;
    const start = f.runtime.startRun.bind(f.runtime);
    let signalStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    f.runtime.startRun = async (run) => {
      if (run.id !== oldRunId) return start(run);
      signalStarted(); await new Promise<void>(() => {});
    };
    void f.dispatcher.dispatchBatch(100);
    await started;
    expect(f.db.get<{ status: string }>("SELECT status FROM agent_runs WHERE id=$id", { id: oldRunId })?.status).toBe("IN_PROGRESS");
    await f.status.set("RECOVERING"); const restarted = f.restart();
    markFakeRunNeverLaunched(restarted.db, oldRunId); restarted.runs.reconcileInterruptedRuns();
    await f.status.set("READY"); await restarted.queue.tick(); await restarted.queue.tick();
    await restarted.dispatcher.dispatchBatch(100);
    expect(f.starts).not.toContain(oldRunId); expect(f.starts).toHaveLength(1);
    expect(restarted.db.get<{ count: number }>("SELECT count(*) AS count FROM scheduler_run_requests WHERE origin_type='TASK_RECOVERY' AND origin_id=$id", { id: oldRunId })?.count).toBe(1);
  });

  it("retains idempotency identity after dispatched and terminal failed request states", async () => {
    const f = await setup(); const taskId = await f.task(); const key = randomUUID(); const original = await f.request(taskId, key);
    await f.status.set("READY"); await f.queue.tick();
    const replay = await f.request(taskId, key);
    expect(replay).toMatchObject({ requestId: original.requestId, status: "DISPATCHED", runId: expect.any(String) });
    f.db.run("UPDATE scheduler_run_requests SET status='FAILED',failure_code='RUN_REQUEST_TEST_FAILURE' WHERE id=$id", { id: original.requestId });
    const terminal = await f.request(taskId, key);
    expect(terminal).toMatchObject({ requestId: original.requestId, status: "FAILED", runId: replay.runId });
  });

  it.each(["reviewer", "qa", "integration"])("recovers a stopped %s crash in its original stage with one source attempt", async (role) => {
    const f = await setup(); const taskId = await f.task(); await f.request(taskId);
    await f.status.set("READY");
    let oldRunId = "";
    for (let pass = 0; pass < 4; pass++) {
      await f.queue.tick();
      const candidate = f.db.get<{ id: string; role: string }>("SELECT id,role FROM agent_runs WHERE status='STARTED'");
      if (candidate?.role === role) { oldRunId = candidate.id; break; }
      await f.dispatcher.dispatchBatch(100);
    }
    expect(oldRunId).not.toBe("");
    const stage = f.db.get<{ status: string }>("SELECT status FROM tasks WHERE id=$id", { id: taskId })!.status;
    markFakeRunNeverLaunched(f.db, oldRunId); f.runs.reconcileInterruptedRuns();
    await f.status.set("RECOVERING"); const restarted = f.restart(); await restarted.queue.tick();
    expect(restarted.db.get("SELECT id FROM scheduler_run_requests WHERE origin_type='TASK_RECOVERY' AND origin_id=$id", { id: oldRunId })).toBeUndefined();
    await f.status.set("READY"); await restarted.queue.tick(); await restarted.queue.tick();
    const retry = restarted.db.get<{ id: string; run_id: string; role: string }>("SELECT id,run_id,role FROM scheduler_run_requests WHERE origin_type='TASK_RECOVERY' AND origin_id=$id", { id: oldRunId });
    expect(retry).toMatchObject({ role, run_id: expect.any(String) });
    expect(restarted.db.get<{ status: string }>("SELECT status FROM tasks WHERE id=$id", { id: taskId })!.status).toBe(stage);
    expect(restarted.db.get<{ count: number }>("SELECT count(*) AS count FROM scheduler_run_requests WHERE origin_type='TASK_RECOVERY' AND origin_id=$id", { id: oldRunId })?.count).toBe(1);
    await restarted.dispatcher.dispatchBatch(100);
    expect(f.starts).not.toContain(oldRunId);
    expect(f.starts).toContain(retry!.run_id);
    expect(restarted.db.get<{ status: string }>("SELECT status FROM agent_runs WHERE id=$id", { id: retry!.run_id })?.status).toBe("COMPLETED");
    const target = role === "reviewer" ? "QA" : role === "qa" ? "READY_FOR_INTEGRATION" : "READY_FOR_MERGE";
    expect(restarted.db.get<{ status: string }>("SELECT status FROM tasks WHERE id=$id", { id: taskId })?.status).toBe(target);
  });

  it("persists start/completion events exactly once across request replay and lost lifecycle acknowledgement", async () => {
    const f = await setup(); const taskId = await f.task(); await f.request(taskId);
    await f.status.set("READY"); await f.queue.tick(); await f.dispatcher.dispatchBatch(100);
    const runId = f.starts[0]!;
    const events = () => f.db.all<{ id: string; type: string; payload_json: string }>("SELECT id,type,payload_json FROM outbox_events WHERE aggregate_id=$id AND type IN ('AgentRunStarted','AgentRunCompleted') ORDER BY created_at", { id: runId });
    expect(events().map(({ type }) => type)).toEqual(["AgentRunStarted", "AgentRunCompleted"]);
    const observed: string[] = [];
    f.bus.subscribe("AgentRunCompleted", "acceptance-observer", (event) => { observed.push(event.id); });
    await f.dispatcher.dispatchBatch(100);
    expect(observed).toEqual([events().find(({ type }) => type === "AgentRunCompleted")!.id]);
    f.db.run("UPDATE outbox_events SET processed_at=NULL,available_at='2026-01-01T00:00:00.000Z' WHERE aggregate_id=$id", { id: runId });
    f.db.run("UPDATE outbox_events SET processed_at=NULL,available_at='2026-01-01T00:00:00.000Z' WHERE type='AgentRunRequested'");
    await f.dispatcher.dispatchBatch(100);
    expect(observed).toHaveLength(1); expect(events()).toHaveLength(2); expect(f.starts).toHaveLength(1);
    for (const event of events()) expect(JSON.parse(event.payload_json)).toMatchObject({ runId, taskId, role: "developer" });
  });

  it("persists crash/failure lifecycle evidence once and rolls back terminalization when outbox fails", async () => {
    const f = await setup(); const taskId = await f.task(); const request = await f.request(taskId);
    await f.status.set("READY"); await f.queue.tick();
    const runId = f.scheduler.getRunRequest(taskId, request.requestId)!.runId!;
    markFakeRunNeverLaunched(f.db, runId);
    f.db.run("CREATE TRIGGER fail_lifecycle BEFORE INSERT ON outbox_events WHEN NEW.type='AgentRunInterrupted' BEGIN SELECT RAISE(ABORT,'injected outbox failure'); END");
    expect(f.runs.reconcileInterruptedRuns()).toBe(0);
    expect(f.db.get<{ status: string }>("SELECT status FROM agent_runs WHERE id=$id", { id: runId })?.status).toBe("STARTED");
    f.db.run("DROP TRIGGER fail_lifecycle");
    expect(f.runs.reconcileInterruptedRuns()).toBe(1); expect(f.runs.reconcileInterruptedRuns()).toBe(0);
    expect(f.db.get<{ count: number }>("SELECT count(*) AS count FROM outbox_events WHERE type='AgentRunInterrupted' AND aggregate_id=$id", { id: runId })?.count).toBe(1);
    await f.queue.tick();
    f.runtime.startRun = async () => { throw new Error("fixture launch failure"); };
    await f.dispatcher.dispatchBatch(100);
    expect(f.db.get<{ count: number }>("SELECT count(*) AS count FROM outbox_events WHERE type='AgentRunFailed'")?.count).toBe(1);
  });

  it("commits Task interruption and its durable event atomically", async () => {
    const f = await setup(); const taskId = await f.task();
    const registry = new WorkflowRegistry(); for (const template of Object.values(templates)) registry.register(template);
    const handler = new RuntimeEventHandlers(f.db, new WorkflowEngine(f.db, registry), f.scheduler, f.runs);
    f.db.run("CREATE TRIGGER fail_interruption BEFORE INSERT ON outbox_events WHEN NEW.type='AgentRunInterrupted' BEGIN SELECT RAISE(ABORT,'injected interruption event failure'); END");
    expect(() => handler.handleRunInterrupted(taskId)).toThrow("injected interruption event failure");
    expect(f.db.get<{ status: string }>("SELECT status FROM tasks WHERE id=$id", { id: taskId })?.status).toBe("READY");
    f.db.run("DROP TRIGGER fail_interruption"); handler.handleRunInterrupted(taskId);
    expect(f.db.get<{ status: string }>("SELECT status FROM tasks WHERE id=$id", { id: taskId })?.status).toBe("CANCELLED");
    expect(f.db.get<{ count: number }>("SELECT count(*) AS count FROM outbox_events WHERE type='AgentRunInterrupted' AND aggregate_id=$id", { id: taskId })?.count).toBe(1);
  });

  it("projects a completed semantic Integration failure once and never retries it as a crash", async () => {
    const f = await setup(); const taskId = await f.task(); await f.request(taskId);
    const start = f.runtime.startRun.bind(f.runtime);
    f.runtime.startRun = async (run) => {
      if (run.role !== "integration") return start(run);
      f.starts.push(run.id); markFakeRunNeverLaunched(f.db, run.id);
      const output = { version: "1.0.0", outcome: "BLOCKED", evidence: ["fixture semantic integration failure"] };
      const accepted = await new DatabaseCompletionStore(f.db).accept(run.capabilityRef!, { runId: run.id, role: run.role, output });
      expect(accepted).toBe(true);
    };
    await f.status.set("READY");
    const projection = RuntimeEventHandlers.prototype.handleRuntimeCompletion;
    let interrupted = false;
    const interruptProjection = vi.spyOn(RuntimeEventHandlers.prototype, "handleRuntimeCompletion").mockImplementation(function (this: RuntimeEventHandlers, runId, outcome) {
      const role = f.db.get<{ role: string }>("SELECT role FROM agent_runs WHERE id=$id", { id: runId })?.role;
      if (role === "integration" && !interrupted) { interrupted = true; throw new Error("fixture crash before semantic failure projection"); }
      return projection.call(this, runId, outcome);
    });
    for (let pass = 0; pass < 8; pass++) { await f.queue.tick(); await f.dispatcher.dispatchBatch(100); }
    interruptProjection.mockRestore();
    expect(interrupted).toBe(true);
    f.db.run("UPDATE outbox_events SET available_at='2026-01-01T00:00:00.000Z' WHERE type='AgentRunRequested'");
    await f.dispatcher.dispatchBatch(100);
    expect(f.db.get<{ status: string }>("SELECT status FROM tasks WHERE id=$id", { id: taskId })?.status).toBe("FAILED");
    const run = f.db.get<{ id: string; status: string }>("SELECT id,status FROM agent_runs WHERE role='integration'")!;
    expect(run.status).toBe("COMPLETED");
    expect(f.db.get("SELECT run_id FROM run_completion_projections WHERE run_id=$id", { id: run.id })).toBeTruthy();
    expect(f.db.get<{ count: number }>("SELECT count(*) AS count FROM outbox_events WHERE type='AgentRunFailed' AND aggregate_id=$id", { id: run.id })?.count).toBe(1);
    expect(f.db.get<{ count: number }>("SELECT count(*) AS count FROM scheduler_run_requests WHERE origin_type='TASK_RECOVERY'")?.count).toBe(0);
    f.db.run("UPDATE outbox_events SET processed_at=NULL,available_at='2026-01-01T00:00:00.000Z' WHERE type='AgentRunRequested'");
    await f.dispatcher.dispatchBatch(100);
    expect(f.db.get<{ count: number }>("SELECT count(*) AS count FROM outbox_events WHERE type='AgentRunFailed' AND aggregate_id=$id", { id: run.id })?.count).toBe(1);
  });
});
