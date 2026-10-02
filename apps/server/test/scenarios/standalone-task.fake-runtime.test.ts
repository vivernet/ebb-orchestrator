import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDatabase } from "../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../helpers/migrations.js";
import type { Database } from "../../src/platform/database/database.js";
import { EventBus } from "../../src/platform/events/event-bus.js";
import { EventDispatcher } from "../../src/platform/events/event-dispatcher.js";
import { DomainEvent } from "../../src/platform/events/domain-event.js";
import { WorkflowEngine } from "../../src/modules/workflow/workflow-engine.js";
import { WorkflowRegistry } from "../../src/modules/workflow/workflow-registry.js";
import { templates } from "../../src/modules/workflow/templates.js";
import { RuntimeEventHandlers } from "../../src/modules/runtime/run-event-handlers.js";
import { SchedulerService } from "../../src/modules/scheduler/scheduler-service.js";
import type { RunOutcome } from "../../src/modules/runtime/run-types.js";
import type { AgentRuntime } from "../../src/modules/runtime/agent-runtime.js";
import { RunService } from "../../src/modules/runtime/run-service.js";
import { DatabaseCompletionStore } from "../../src/modules/execution/mcp/submit-result-tool.js";
import type { TaskContract } from "../../src/modules/work/work-types.js";
import { appendOutboxEvent } from "../../src/platform/events/outbox-repository.js";
import { GitCli } from "../../src/modules/git/git-cli.js";
import { WorktreeManager } from "../../src/modules/git/worktree-manager.js";
import { seedApprovedProjectConfig } from "../helpers/approved-project-config.js";
import { markFakeRunNeverLaunched } from "../helpers/fake-run-process-owner.js";

const migrations = loadTestMigrations();

function contract(goal: string): TaskContract {
  return {
    version: 1,
    goal,
    context: `Context for ${goal}`,
    requirements: ["req-1"],
    acceptanceCriteria: ["ac-1"],
    dependencies: [],
    nonGoals: [],
    definitionOfDone: ["done-1"],
  };
}

function insertTask(
  db: Database,
  projectId: string,
  overrides: Partial<{
    id: string;
    epicId: string | null;
    status: string;
  }> = {},
): { id: string; projectId: string; epicId: string | null } {
  const id = overrides.id ?? randomUUID();
  const epicId = overrides.epicId ?? null;
  const status = overrides.status ?? "READY";
  const now = new Date().toISOString();
  const c = contract("test");

  db.transaction((tx) => {
    tx.run(
      `INSERT INTO tasks (id, project_id, epic_id, display_id, title, status, contract_json, required, created_at, updated_at)
       VALUES ($id, $project_id, $epic_id, $display_id, $title, $status, $contract_json, $required, $created_at, $updated_at)`,
      {
        id,
        project_id: projectId,
        epic_id: epicId,
        display_id: `TASK-${Math.floor(Math.random() * 100000)}`,
        title: c.goal,
        status,
        contract_json: JSON.stringify(c),
        required: 1,
        created_at: now,
        updated_at: now,
      },
    );
  });

  return { id, projectId, epicId };
}

/**
 * Координирует взаимодействие Workflow, Scheduler и Runtime.
 */
class Orchestrator {
  constructor(
    private readonly db: Database,
    private readonly bus: EventBus,
    private readonly workflowEngine: WorkflowEngine,
    private readonly handlers: RuntimeEventHandlers,
  ) {}

  /**
   * Запускает workflow run для задачи.
   */
  startWorkflowRun(taskId: string, triggerReason: string): void {
    const task = this.db.get<{ id: string; status: string; epic_id: string | null }>(
      "SELECT id, status, epic_id FROM tasks WHERE id = $id",
      { id: taskId },
    );
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

// Создаём событие AgentRunRequested.
    const _event = DomainEvent.create({
      type: "AgentRunRequested",
      aggregateType: "Task",
      aggregateId: taskId,
      payload: {
        taskId,
        status: task.status,
        triggerReason,
        role: "Developer",
        model: "test-model",
      },
    });
    appendOutboxEvent(this.db, _event);
  }

  /**
   * Обрабатывает событие AgentRunRequested обработчиками runtime.
   */
  handleAgentRunRequested(event: {
    readonly type: string;
    readonly aggregateId: string | undefined;
    readonly payload: Record<string, unknown>;
  }): void | Promise<void> {
    return this.handlers.handleAgentRunRequested(event);
  }

  /**
   * Обрабатывает завершение runtime.
   */
  handleRuntimeCompletion(taskId: string, outcome: RunOutcome): void {
    const now = new Date().toISOString();
    const parsed = outcome.success ? { version: "1", outcome: "COMPLETED" } : { version: "1", outcome: "BLOCKED" };
    this.db.run(`INSERT INTO agent_runs (id, role, runtime, model, task_id, status, started_at, output)
      VALUES ($id, 'developer', 'fake', 'test', $task_id, 'COMPLETED', $now, $output)`, { id: taskId, task_id: taskId, now, output: JSON.stringify(parsed) });
    this.handlers.handleRuntimeCompletion(taskId, { ...outcome, output: JSON.stringify(parsed), validatedSubmission: true,
      diagnostics: { runId: taskId, sessionId: null, stderr: "", exitCode: outcome.exitCode, artifactReferences: [] } });
  }

  /**
   * Обрабатывает события approval.
   */
  handleApprovalApproved(event: {
    readonly type: string;
    readonly aggregateId: string | undefined;
    readonly payload: Record<string, unknown>;
  }): void {
    this.handlers.handleApprovalApproved(event);
  }

  /**
   * Отправляет ожидающие события.
   */
  async dispatchEvents(limit: number): Promise<number> {
    const dispatcher = new EventDispatcher(this.db, this.bus);
    return dispatcher.dispatchBatch(limit);
  }
}

describe("Standalone task fake runtime scenario", () => {
  let db: Database | undefined;
  let tmpDir: string;
  let registry: WorkflowRegistry;
  let workflowEngine: WorkflowEngine;
  let handlers: RuntimeEventHandlers;
  let bus: EventBus;
  let orchestrator: Orchestrator;
  let projectId: string;
  let repositoryPath: string;
  let runtimeCalls: Array<{ phase: string; role: string; taskId?: string }>;
  let statusAtRuntimeStart: string | null;

  beforeEach(() => {
    tmpDir = "";
    projectId = randomUUID();
    registry = new WorkflowRegistry();
    for (const tpl of Object.values(templates)) {
      registry.register(tpl);
    }
    bus = new EventBus();
  });

  afterEach(async () => {
    db?.close();
    db = undefined;
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  async function setupDb(): Promise<Database> {
    tmpDir = await mkdtemp(join(tmpdir(), "orch-standalone-test-"));
    const stateDirectory = join(tmpDir, ".ebb-orchestrator");
    await mkdir(stateDirectory, { recursive: true });
    const dbPath = join(stateDirectory, `test-${randomUUID()}.db`);
    const database = createSqliteDatabase(dbPath);
    runMigrations(database, migrations);
    return database;
  }

  async function createTaskWorkspace(taskId: string): Promise<void> {
    await new WorktreeManager({ db: db!, worktreeDir: join(tmpDir, "worktrees") })
      .createTaskWorkspace(taskId, repositoryPath, "master");
  }

  async function setupOrchestrator(): Promise<void> {
    db = await setupDb();
    repositoryPath = join(tmpDir, "repository");
    await mkdir(repositoryPath, { recursive: true });
    const git = new GitCli();
    await git.run(repositoryPath, ["init", "-b", "master"]);
    await git.run(repositoryPath, ["config", "user.email", "test@example.com"]);
    await git.run(repositoryPath, ["config", "user.name", "Test User"]);
    await writeFile(join(repositoryPath, "README.md"), "# Test repository\n", "utf8");
    await git.run(repositoryPath, ["add", "README.md"]);
    await git.run(repositoryPath, ["commit", "-m", "test repository"]);
    const now = new Date().toISOString();
    db.transaction((tx) => {
      tx.run(
        `INSERT INTO projects (id, name, display_name, status, created_at, updated_at)
         VALUES ($id, $name, $display_name, $status, $created_at, $updated_at)`,
        {
          id: projectId,
          name: "test-project",
          display_name: "Test Project",
          status: "ACTIVE",
          created_at: now,
          updated_at: now,
        },
      );
      const approvalId = randomUUID();
      tx.run("INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,created_at) VALUES($id,'WORKFLOW_CHANGE',$projectId,'PROJECT','APPROVED','test',$now)", { id: approvalId, projectId, now });
      tx.run("INSERT INTO onboarding_configs(project_id,repository_path,facts_json,proposed_json,status,approval_id,created_at,updated_at) VALUES($projectId,$repositoryPath,$facts,$proposed,'ACTIVE',$approvalId,$now,$now)", {
        projectId,
        repositoryPath,
        facts: JSON.stringify({ defaultBranch: "master" }),
        proposed: JSON.stringify({ defaultBranch: "master" }),
        approvalId,
        now,
      });
    });
    seedApprovedProjectConfig(db, projectId);

    workflowEngine = new WorkflowEngine(db, registry);
    runtimeCalls = [];
    statusAtRuntimeStart = null;
    const completion = new DatabaseCompletionStore(db);
    const runtime: AgentRuntime = {
      active: 0,
      maxActive: 0,
      calls: runtimeCalls,
      async startRun(run) {
        markFakeRunNeverLaunched(db!, run.id);
        runtimeCalls.push({ phase: "start", role: run.role, ...(run.taskId ? { taskId: run.taskId } : {}) });
        statusAtRuntimeStart = db!.get<{ status: string }>("SELECT status FROM tasks WHERE id=$id", { id: run.taskId })?.status ?? null;
        if (!run.capabilityRef || !await completion.accept(run.capabilityRef, { runId: run.id, role: run.role, output: { version: "1", outcome: "COMPLETED" } })) {
          throw new Error("test runtime could not submit a prepared run result");
        }
      },
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
    handlers = new RuntimeEventHandlers(db, workflowEngine, new SchedulerService(db), new RunService(db, runtime));
    orchestrator = new Orchestrator(db, bus, workflowEngine, handlers);
  }

  it("should handle AgentRunRequested and transition task to DEVELOPMENT", async () => {
    await setupOrchestrator();

// Регистрируем обработчик события.
    bus.subscribe("AgentRunRequested", "runtime-handler", (event) => {
      const { aggregateId } = event as { readonly aggregateId: string | undefined };
      if (aggregateId) {
        return orchestrator.handleAgentRunRequested(event as {
          readonly type: string;
          readonly aggregateId: string | undefined;
          readonly payload: Record<string, unknown>;
        });
      }
    });

    const { id: taskId } = insertTask(db!, projectId, { status: "READY" });
    await createTaskWorkspace(taskId);
    db!.run("UPDATE outbox_events SET processed_at=$now WHERE processed_at IS NULL", { now: new Date().toISOString() });
    orchestrator.startWorkflowRun(taskId, "task-assignment");

// Отправляем события — обработчик должен быть вызван.
    await orchestrator.dispatchEvents(10);

// Workflow reaches DEVELOPMENT before the runtime receives the prepared Run.
    expect(statusAtRuntimeStart).toBe("DEVELOPMENT");
    expect(runtimeCalls).toHaveLength(1);
    expect(runtimeCalls[0]).toMatchObject({ role: "developer", taskId });
    const runState = db!.get<{ id: string; status: string; output: string | null }>("SELECT id,status,output FROM agent_runs WHERE task_id=$taskId", { taskId });
    expect(runState, JSON.stringify(runState)).toMatchObject({ status: "COMPLETED" });
    const task = db!.get<{ status: string }>(
      "SELECT status FROM tasks WHERE id = $id",
      { id: taskId },
    );
    expect(task?.status).toBe("REVIEW");
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM context_manifests WHERE run_id IN (SELECT id FROM agent_runs WHERE task_id=$taskId)", { taskId })?.count).toBe(1);
  });

  it("should validate workflow stage before applying runtime outcome", async () => {
    await setupOrchestrator();

    const { id: taskId } = insertTask(db!, projectId, { status: "READY" });

// Сначала переводим в DEVELOPMENT, имитируя начатый run.
    workflowEngine.transition(taskId, "DEVELOPMENT");

// Имитируем завершение runtime — текущий этап должен быть проверен.
    const outcome: RunOutcome = { success: true, exitCode: 0, output: "Done" };

// Операция должна пройти, поскольку этап — DEVELOPMENT.
    orchestrator.handleRuntimeCompletion(taskId, outcome);

    const updatedStage = db!.get<{ status: string }>(
      "SELECT status FROM tasks WHERE id = $id",
      { id: taskId },
    );
    expect(updatedStage?.status).toBe("REVIEW");
  });

  it("should throw when runtime completion stage is invalid", async () => {
    await setupOrchestrator();

    const { id: taskId } = insertTask(db!, projectId, { status: "READY" });

    const outcome: RunOutcome = { success: true, exitCode: 0, output: "Done" };

// Должна возникнуть ошибка, поскольку этап — READY, а не DEVELOPMENT.
    expect(() =>
      orchestrator.handleRuntimeCompletion(taskId, outcome),
    ).toThrow(/Invalid workflow stage/);

    const stage = db!.get<{ status: string }>(
      "SELECT status FROM tasks WHERE id = $id",
      { id: taskId },
    );
    expect(stage?.status).toBe("READY");
  });

  it("should handle runtime failure and transition to FAILED", async () => {
    await setupOrchestrator();

    const { id: taskId } = insertTask(db!, projectId, { status: "READY" });

// Сначала переводим в DEVELOPMENT.
    workflowEngine.transition(taskId, "DEVELOPMENT");

// Имитируем ошибку runtime.
    const outcome: RunOutcome = { success: false, exitCode: 1, output: "Error" };

    orchestrator.handleRuntimeCompletion(taskId, outcome);

    const updatedStage = db!.get<{ status: string }>(
      "SELECT status FROM tasks WHERE id = $id",
      { id: taskId },
    );
    expect(updatedStage?.status).toBe("FAILED");
  });

  it("should support full standalone task workflow lifecycle", async () => {
    await setupOrchestrator();

    const { id: taskId } = insertTask(db!, projectId, { status: "DRAFT" });

// Переходим через этапы workflow.
    workflowEngine.transition(taskId, "READY");

// Имитируем запуск runtime.
    workflowEngine.transition(taskId, "DEVELOPMENT");

// Имитируем завершение runtime.
    const outcome: RunOutcome = { success: true, exitCode: 0, output: "Done" };
    orchestrator.handleRuntimeCompletion(taskId, outcome);

    expect(db!.get<{ status: string }>(
      "SELECT status FROM tasks WHERE id = $id",
      { id: taskId },
    )?.status).toBe("REVIEW");

// Продолжаем workflow.
    workflowEngine.transition(taskId, "QA", {
      hasReviewPassed: true,
      hasSuccessfulIntegration: false,
      hasFinalMergeApproval: false,
      parentEpicReleased: false,
    });

    workflowEngine.transition(taskId, "READY_FOR_INTEGRATION");
    workflowEngine.transition(taskId, "INTEGRATION");
    workflowEngine.transition(taskId, "READY_FOR_MERGE");

// Одобряем финальный merge.
    const mergeApproval = DomainEvent.create({
      type: "ApprovalApproved",
      aggregateType: "Task",
      aggregateId: taskId,
      payload: {
        taskId,
        approvalType: "FINAL_MERGE",
      },
    });
    appendOutboxEvent(db!, mergeApproval);

// Регистрируем обработчик approval.
    bus.subscribe("ApprovalApproved", "runtime-handler", (event) => {
      const { aggregateId } = event as { readonly aggregateId: string | undefined };
      if (aggregateId) {
        orchestrator.handleApprovalApproved(event as {
          readonly type: string;
          readonly aggregateId: string | undefined;
          readonly payload: Record<string, unknown>;
        });
      }
    });

    await orchestrator.dispatchEvents(10);

// Теперь должен быть этап MERGING.
    expect(db!.get<{ status: string }>(
      "SELECT status FROM tasks WHERE id = $id",
      { id: taskId },
    )?.status).toBe("MERGING");

    workflowEngine.transition(taskId, "DONE");
    workflowEngine.transition(taskId, "RELEASED");

    const finalStatus = db!.get<{ status: string }>(
      "SELECT status FROM tasks WHERE id = $id",
      { id: taskId },
    );
    expect(finalStatus?.status).toBe("RELEASED");
  });

  it("should ensure idempotency when handling events", async () => {
    await setupOrchestrator();

    const completion = new DatabaseCompletionStore(db!);
    let signalRuntimeStarted!: () => void;
    const runtimeStarted = new Promise<void>((resolve) => { signalRuntimeStarted = resolve; });
    let releaseRuntime!: () => void;
    const runtimeGate = new Promise<void>((resolve) => { releaseRuntime = resolve; });
    const runtime: AgentRuntime = {
      active: 0,
      maxActive: 1,
      calls: [],
      async startRun(run) {
        markFakeRunNeverLaunched(db!, run.id);
        runtime.calls.push({
          phase: "start",
          role: run.role,
          ...(run.taskId ? { taskId: run.taskId } : {}),
        });
        signalRuntimeStarted();
        await runtimeGate;
        const accepted = run.capabilityRef ? await completion.accept(run.capabilityRef, {
          runId: run.id,
          role: run.role,
          output: { version: "1.0.0", outcome: "COMPLETED" },
        }) : false;
        if (!accepted) throw new Error("test runtime could not submit the prepared run result");
      },
      async resumeRun() {},
      async cancelRun() {},
      async inspectRun() { throw new Error("not implemented"); },
      async collectResult(runId) {
        const output = completion.getSubmission(runId)?.output ?? "";
        return { success: true, exitCode: 0, output, validatedSubmission: true, diagnostics: { runId, sessionId: null, stderr: "", exitCode: 0, artifactReferences: [] } };
      },
      async collectUsage() { return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, cost: 0 }; },
      async runResult(runId) { return this.collectResult(runId); },
      async healthCheck() { return true; },
    };
    handlers = new RuntimeEventHandlers(db!, workflowEngine, new SchedulerService(db!), new RunService(db!, runtime));
    orchestrator = new Orchestrator(db!, bus, workflowEngine, handlers);

    let handlerCalls = 0;
    bus.subscribe("AgentRunRequested", "idempotent-handler", (event) => {
      handlerCalls++;
      const { aggregateId } = event as { readonly aggregateId: string | undefined };
      if (aggregateId) {
        return orchestrator.handleAgentRunRequested(event as {
          readonly type: string;
          readonly aggregateId: string | undefined;
          readonly payload: Record<string, unknown>;
        });
      }
    });

    const { id: taskId } = insertTask(db!, projectId, { status: "READY" });
    await createTaskWorkspace(taskId);
    db!.run("UPDATE outbox_events SET processed_at=$now WHERE processed_at IS NULL", { now: new Date().toISOString() });
    orchestrator.startWorkflowRun(taskId, "task-assignment");
    const requestedEvent = db!.get<{ id: string }>(
      "SELECT id FROM outbox_events WHERE type='AgentRunRequested' AND aggregate_id=$taskId ORDER BY created_at DESC LIMIT 1",
      { taskId },
    );
    if (!requestedEvent) throw new Error("AgentRunRequested event was not persisted");

// Отправляем несколько раз — из-за идемпотентности обработчик должен выполниться только один раз.
    const firstDispatchPromise = orchestrator.dispatchEvents(10);
    await runtimeStarted;
    const dispatchBeforeRuntimeCompletion = await Promise.race([
      firstDispatchPromise.then(() => "DISPATCHED" as const),
      new Promise<"RUNTIME_PENDING">((resolve) => setTimeout(() => resolve("RUNTIME_PENDING"), 0)),
    ]);
    try {
      expect(dispatchBeforeRuntimeCompletion).toBe("RUNTIME_PENDING");
    } finally {
      releaseRuntime();
    }
    const initialDispatchCount = await firstDispatchPromise;
    const firstDispatchHandlerCalls = handlerCalls;
    expect(initialDispatchCount).toBe(1);
    expect(firstDispatchHandlerCalls).toBe(1);
    expect(runtime.calls).toHaveLength(1);
    expect(db!.get<{ processed_at: string | null }>("SELECT processed_at FROM outbox_events WHERE id=$eventId", { eventId: requestedEvent.id })?.processed_at).toEqual(expect.any(String));
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM processed_events WHERE event_id=$eventId", { eventId: requestedEvent.id })?.count).toBe(1);

    // Изолируем исходное durable событие, чтобы следующий Dispatcher явно
    // переиграл его после подтверждённого consumer ack.
    const replayAt = new Date().toISOString();
    db!.run("UPDATE outbox_events SET processed_at=$replayAt WHERE processed_at IS NULL AND id<>$eventId", { replayAt, eventId: requestedEvent.id });
    db!.run("UPDATE outbox_events SET processed_at=NULL WHERE id=$eventId", { eventId: requestedEvent.id });
    expect(db!.all<{ id: string; type: string }>("SELECT id,type FROM outbox_events WHERE processed_at IS NULL")).toEqual([
      { id: requestedEvent.id, type: "AgentRunRequested" },
    ]);
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM processed_events WHERE event_id=$eventId", { eventId: requestedEvent.id })?.count).toBe(1);

    // dispatchEvents создаёт новый EventDispatcher поверх той же durable БД;
    // processed_events должен подавить повторный вызов уже подтверждённого consumer.
    const replayDispatchCount = await orchestrator.dispatchEvents(10);
    expect(replayDispatchCount).toBe(1);
    expect(handlerCalls).toBe(firstDispatchHandlerCalls);
    expect(runtime.calls).toHaveLength(1);
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM agent_runs WHERE task_id=$taskId", { taskId })?.count).toBe(1);
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM processed_events WHERE event_id=$eventId", { eventId: requestedEvent.id })?.count).toBe(1);
    expect(db!.get<{ processed_at: string | null }>("SELECT processed_at FROM outbox_events WHERE id=$eventId", { eventId: requestedEvent.id })?.processed_at).toEqual(expect.any(String));
  });

  it("should throw when AgentRunRequested is received for non-READY task", async () => {
    await setupOrchestrator();

    const { id: taskId } = insertTask(db!, projectId, { status: "DEVELOPMENT" });

    const _event = DomainEvent.create({
      type: "AgentRunRequested",
      aggregateType: "Task",
      aggregateId: taskId,
      payload: {
        taskId,
        status: "DEVELOPMENT",
        triggerReason: "task-assignment",
        role: "Developer",
        model: "test-model",
      },
    });

    await expect(orchestrator.handleAgentRunRequested(_event)).rejects.toThrow(/not in READY state/i);
  });
});
