import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDatabase } from "../../src/platform/database/sqlite-database.js";
import { runMigrations, type Migration } from "../../src/platform/database/migrator.js";
import type { Database } from "../../src/platform/database/database.js";
import { EventBus } from "../../src/platform/events/event-bus.js";
import { EventDispatcher } from "../../src/platform/events/event-dispatcher.js";
import { DomainEvent } from "../../src/platform/events/domain-event.js";
import { WorkflowEngine } from "../../src/modules/workflow/workflow-engine.js";
import { WorkflowRegistry } from "../../src/modules/workflow/workflow-registry.js";
import { templates } from "../../src/modules/workflow/templates.js";
import { RuntimeEventHandlers } from "../../src/modules/runtime/run-event-handlers.js";
import type { RunOutcome } from "../../src/modules/runtime/run-types.js";
import type { TaskContract } from "../../src/modules/work/work-types.js";
import { appendOutboxEvent } from "../../src/platform/events/outbox-repository.js";

const migration001 = readFileSync(
  join(import.meta.dirname, "../../src/platform/database/migrations/001_system.sql"),
  "utf-8",
);

const migration002 = readFileSync(
  join(import.meta.dirname, "../../src/platform/database/migrations/002_work_domain.sql"),
  "utf-8",
);

const migration003 = readFileSync(
  join(import.meta.dirname, "../../src/platform/database/migrations/003_work_control.sql"),
  "utf-8",
);
const migration004 = readFileSync(join(import.meta.dirname, "../../src/platform/database/migrations/004_agent_runs.sql"), "utf-8");

const migrations: Migration[] = [
  { version: 1, name: "001_system", sql: migration001 },
  { version: 2, name: "002_work_domain", sql: migration002 },
  { version: 3, name: "003_work_control", sql: migration003 },
  { version: 4, name: "004_agent_runs", sql: migration004 },
];

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
 * Orchestrates between Workflow, Scheduler, and Runtime.
 */
class Orchestrator {
  constructor(
    private readonly db: Database,
    private readonly bus: EventBus,
    private readonly workflowEngine: WorkflowEngine,
    private readonly handlers: RuntimeEventHandlers,
  ) {}

  /**
   * Start a workflow run for a task.
   */
  startWorkflowRun(taskId: string, triggerReason: string): void {
    const task = this.db.get<{ id: string; status: string; epic_id: string | null }>(
      "SELECT id, status, epic_id FROM tasks WHERE id = $id",
      { id: taskId },
    );
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    // Emit AgentRunRequested event
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
   * Handle AgentRunRequested event by the runtime handlers.
   */
  handleAgentRunRequested(event: {
    readonly type: string;
    readonly aggregateId: string | undefined;
    readonly payload: Record<string, unknown>;
  }): void {
    this.handlers.handleAgentRunRequested(event);
  }

  /**
   * Handle runtime completion.
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
   * Handle approval events.
   */
  handleApprovalApproved(event: {
    readonly type: string;
    readonly aggregateId: string | undefined;
    readonly payload: Record<string, unknown>;
  }): void {
    this.handlers.handleApprovalApproved(event);
  }

  /**
   * Dispatch pending events.
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
    const dbPath = join(tmpDir, `test-${randomUUID()}.db`);
    const database = createSqliteDatabase(dbPath);
    runMigrations(database, migrations);
    return database;
  }

  async function setupOrchestrator(): Promise<void> {
    db = await setupDb();
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
    });

    workflowEngine = new WorkflowEngine(db, registry);
    handlers = new RuntimeEventHandlers(db, workflowEngine);
    orchestrator = new Orchestrator(db, bus, workflowEngine, handlers);
  }

  it("should handle AgentRunRequested and transition task to DEVELOPMENT", async () => {
    await setupOrchestrator();

    // Register event handler
    bus.subscribe("AgentRunRequested", "runtime-handler", (event) => {
      const { aggregateId } = event as { readonly aggregateId: string | undefined };
      if (aggregateId) {
        orchestrator.handleAgentRunRequested(event as {
          readonly type: string;
          readonly aggregateId: string | undefined;
          readonly payload: Record<string, unknown>;
        });
      }
    });

    const { id: taskId } = insertTask(db!, projectId, { status: "READY" });
    orchestrator.startWorkflowRun(taskId, "task-assignment");

    // Dispatch events - should call handler
    await orchestrator.dispatchEvents(10);

    // Task should be transitioned to DEVELOPMENT by workflow engine
    const task = db!.get<{ status: string }>(
      "SELECT status FROM tasks WHERE id = $id",
      { id: taskId },
    );
    expect(task?.status).toBe("DEVELOPMENT");
  });

  it("should validate workflow stage before applying runtime outcome", async () => {
    await setupOrchestrator();

    const { id: taskId } = insertTask(db!, projectId, { status: "READY" });

    // First transition to DEVELOPMENT to simulate a started run
    workflowEngine.transition(taskId, "DEVELOPMENT");

    // Simulate runtime completion - should validate current stage
    const outcome: RunOutcome = { success: true, exitCode: 0, output: "Done" };

    // This should succeed because stage is DEVELOPMENT
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

    // Should throw because stage is READY, not DEVELOPMENT
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

    // First transition to DEVELOPMENT
    workflowEngine.transition(taskId, "DEVELOPMENT");

    // Simulate runtime failure
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

    // Transition through workflow stages
    workflowEngine.transition(taskId, "READY");

    // Simulate runtime start
    workflowEngine.transition(taskId, "DEVELOPMENT");

    // Simulate runtime completion
    const outcome: RunOutcome = { success: true, exitCode: 0, output: "Done" };
    orchestrator.handleRuntimeCompletion(taskId, outcome);

    expect(db!.get<{ status: string }>(
      "SELECT status FROM tasks WHERE id = $id",
      { id: taskId },
    )?.status).toBe("REVIEW");

    // Continue workflow
    workflowEngine.transition(taskId, "QA", {
      hasReviewPassed: true,
      hasSuccessfulIntegration: false,
      hasFinalMergeApproval: false,
      parentEpicReleased: false,
    });

    workflowEngine.transition(taskId, "READY_FOR_INTEGRATION");
    workflowEngine.transition(taskId, "INTEGRATION");
    workflowEngine.transition(taskId, "READY_FOR_MERGE");

    // Approve final merge
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

    // Register handler for approval
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

    // Should be in MERGING now
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

    let handlerCalls = 0;
    bus.subscribe("AgentRunRequested", "idempotent-handler", (event) => {
      handlerCalls++;
      const { aggregateId } = event as { readonly aggregateId: string | undefined };
      if (aggregateId) {
        orchestrator.handleAgentRunRequested(event as {
          readonly type: string;
          readonly aggregateId: string | undefined;
          readonly payload: Record<string, unknown>;
        });
      }
    });

    const { id: taskId } = insertTask(db!, projectId, { status: "READY" });
    orchestrator.startWorkflowRun(taskId, "task-assignment");

    // Dispatch multiple times - handler should only execute once due to idempotency
    await orchestrator.dispatchEvents(10);
    const firstDispatch = handlerCalls;

    await orchestrator.dispatchEvents(10);
    const secondDispatch = handlerCalls;

    expect(firstDispatch).toBe(1);
    expect(secondDispatch).toBe(1);
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

    expect(() => orchestrator.handleAgentRunRequested(_event)).toThrow(
      /not in READY state/i
    );
  });
});
