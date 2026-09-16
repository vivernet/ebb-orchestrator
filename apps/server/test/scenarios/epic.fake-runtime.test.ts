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
import type { TaskContract, EpicStatus } from "../../src/modules/work/work-types.js";
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
    required: boolean;
  }> = {},
): { id: string; projectId: string; epicId: string | null } {
  const id = overrides.id ?? randomUUID();
  const epicId = overrides.epicId ?? null;
  const status = overrides.status ?? "READY";
  const required = overrides.required ?? true;
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
        required: required ? 1 : 0,
        created_at: now,
        updated_at: now,
      },
    );
  });

  return { id, projectId, epicId };
}

function insertEpic(
  db: Database,
  projectId: string,
  overrides: Partial<{
    id: string;
    status: EpicStatus;
  }> = {},
): { id: string; projectId: string } {
  const id = overrides.id ?? randomUUID();
  const status = overrides.status ?? "OPEN";
  const now = new Date().toISOString();

  db.transaction((tx) => {
    tx.run(
      `INSERT INTO epics (id, project_id, display_id, title, status, contract_json, created_at, updated_at)
       VALUES ($id, $project_id, $display_id, $title, $status, $contract_json, $created_at, $updated_at)`,
      {
        id,
        project_id: projectId,
        display_id: `EPIC-${Math.floor(Math.random() * 100000)}`,
        title: "Test Epic",
        status,
        contract_json: JSON.stringify(contract("epic goal")),
        created_at: now,
        updated_at: now,
      },
    );
  });

  return { id, projectId };
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
    const event = DomainEvent.create({
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
    appendOutboxEvent(this.db, event);
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
    const output = JSON.stringify({ version: "1", outcome: outcome.success ? "COMPLETED" : "BLOCKED" });
    this.db.run(`INSERT INTO agent_runs (id, role, runtime, model, task_id, status, started_at, output)
      VALUES ($id, 'developer', 'fake', 'test', $task_id, 'COMPLETED', $now, $output)`, { id: taskId, task_id: taskId, now, output });
    this.handlers.handleRuntimeCompletion(taskId, { ...outcome,
      output,
      validatedSubmission: true,
      diagnostics: { runId: taskId, sessionId: null, stderr: "", exitCode: outcome.exitCode, artifactReferences: [] },
    });
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

describe("Epic child lifecycle fake runtime scenario", () => {
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
    tmpDir = await mkdtemp(join(tmpdir(), "orch-epic-test-"));
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

  it("should simulate epic child lifecycle: child integration → epic review → epic qa → epic done → child released", async () => {
    await setupOrchestrator();

    // Create Epic and child tasks
    const epic = insertEpic(db!, projectId, { status: "OPEN" });
    const childTask1 = insertTask(db!, projectId, { epicId: epic.id, status: "READY" });
    const childTask2 = insertTask(db!, projectId, { epicId: epic.id, status: "READY" });

    // Simulate development and completion of both child tasks
    // Task 1: DEVELOPMENT → REVIEW → QA → INTEGRATION → INTEGRATED_INTO_EPIC
    workflowEngine.transition(childTask1.id, "DEVELOPMENT");
    const outcome1: RunOutcome = { success: true, exitCode: 0, output: "Done" };
    orchestrator.handleRuntimeCompletion(childTask1.id, outcome1); // → REVIEW

    workflowEngine.transition(childTask1.id, "QA", {
      hasReviewPassed: true,
      hasSuccessfulIntegration: false,
      hasFinalMergeApproval: false,
      parentEpicReleased: false,
    });

    workflowEngine.transition(childTask1.id, "READY_FOR_INTEGRATION");
    workflowEngine.transition(childTask1.id, "INTEGRATION");
    workflowEngine.transition(childTask1.id, "INTEGRATED_INTO_EPIC", {
      hasSuccessfulIntegration: true,
      hasReviewPassed: false,
      hasFinalMergeApproval: false,
      parentEpicReleased: false,
    });

    // Task 2: Same lifecycle
    workflowEngine.transition(childTask2.id, "DEVELOPMENT");
    const outcome2: RunOutcome = { success: true, exitCode: 0, output: "Done" };
    orchestrator.handleRuntimeCompletion(childTask2.id, outcome2); // → REVIEW

    workflowEngine.transition(childTask2.id, "QA", {
      hasReviewPassed: true,
      hasSuccessfulIntegration: false,
      hasFinalMergeApproval: false,
      parentEpicReleased: false,
    });

    workflowEngine.transition(childTask2.id, "READY_FOR_INTEGRATION");
    workflowEngine.transition(childTask2.id, "INTEGRATION");
    workflowEngine.transition(childTask2.id, "INTEGRATED_INTO_EPIC", {
      hasSuccessfulIntegration: true,
      hasReviewPassed: false,
      hasFinalMergeApproval: false,
      parentEpicReleased: false,
    });

    // All required child tasks are now INTEGRATED_INTO_EPIC
    // Epic Review/QA: simulate as scripted run types using direct status updates
    // (Epics are not managed by WorkflowEngine, they use their own status lifecycle)

    // Epic moves through IN_PROGRESS as tasks complete integration
    db!.run(
      "UPDATE epics SET status = $status, updated_at = $updated_at WHERE id = $id",
      {
        id: epic.id,
        status: "IN_PROGRESS",
        updated_at: new Date().toISOString(),
      },
    );

    // Epic Review/QA simulation - treat as scripted runtime completion
    // Epic reaches DONE after all children are integrated and reviewed
    db!.run(
      "UPDATE epics SET status = $status, updated_at = $updated_at WHERE id = $id",
      {
        id: epic.id,
        status: "DONE",
        updated_at: new Date().toISOString(),
      },
    );

    // Epic DONE acts as the release marker
    // This enables child tasks to be RELEASED (parentEpicReleased = true)

    workflowEngine.transition(childTask1.id, "READY_FOR_MERGE", {
      hasReviewPassed: true,
      hasSuccessfulIntegration: true,
      hasFinalMergeApproval: true,
      parentEpicReleased: true,
    });

    workflowEngine.transition(childTask1.id, "MERGING", {
      hasReviewPassed: true,
      hasSuccessfulIntegration: true,
      hasFinalMergeApproval: true,
      parentEpicReleased: true,
    });

    workflowEngine.transition(childTask1.id, "DONE", {
      hasReviewPassed: true,
      hasSuccessfulIntegration: true,
      hasFinalMergeApproval: true,
      parentEpicReleased: true,
    });

    workflowEngine.transition(childTask1.id, "RELEASED", {
      hasReviewPassed: true,
      hasSuccessfulIntegration: true,
      hasFinalMergeApproval: true,
      parentEpicReleased: true,
    });

    workflowEngine.transition(childTask2.id, "READY_FOR_MERGE", {
      hasReviewPassed: true,
      hasSuccessfulIntegration: true,
      hasFinalMergeApproval: true,
      parentEpicReleased: true,
    });

    workflowEngine.transition(childTask2.id, "MERGING", {
      hasReviewPassed: true,
      hasSuccessfulIntegration: true,
      hasFinalMergeApproval: true,
      parentEpicReleased: true,
    });

    workflowEngine.transition(childTask2.id, "DONE", {
      hasReviewPassed: true,
      hasSuccessfulIntegration: true,
      hasFinalMergeApproval: true,
      parentEpicReleased: true,
    });

    workflowEngine.transition(childTask2.id, "RELEASED", {
      hasReviewPassed: true,
      hasSuccessfulIntegration: true,
      hasFinalMergeApproval: true,
      parentEpicReleased: true,
    });

    // Verify final states
    const finalChild1 = db!.get<{ status: string }>(
      "SELECT status FROM tasks WHERE id = $id",
      { id: childTask1.id },
    );
    expect(finalChild1?.status).toBe("RELEASED");

    const finalChild2 = db!.get<{ status: string }>(
      "SELECT status FROM tasks WHERE id = $id",
      { id: childTask2.id },
    );
    expect(finalChild2?.status).toBe("RELEASED");

    const finalEpic = db!.get<{ status: string }>(
      "SELECT status FROM epics WHERE id = $id",
      { id: epic.id },
    );
    expect(finalEpic?.status).toBe("DONE");
  });

  it("should not allow child task RELEASED before epic is released", async () => {
    await setupOrchestrator();

    const epic = insertEpic(db!, projectId, { status: "OPEN" });
    const childTask = insertTask(db!, projectId, { epicId: epic.id, status: "READY" });

    // Complete child task lifecycle up to DONE
    workflowEngine.transition(childTask.id, "DEVELOPMENT");
    workflowEngine.transition(childTask.id, "REVIEW");
    workflowEngine.transition(childTask.id, "QA", {
      hasReviewPassed: true,
      hasSuccessfulIntegration: false,
      hasFinalMergeApproval: false,
      parentEpicReleased: false,
    });
    workflowEngine.transition(childTask.id, "READY_FOR_INTEGRATION");
    workflowEngine.transition(childTask.id, "INTEGRATION");
    workflowEngine.transition(childTask.id, "INTEGRATED_INTO_EPIC", {
      hasSuccessfulIntegration: true,
      hasReviewPassed: false,
      hasFinalMergeApproval: false,
      parentEpicReleased: false,
    });
    workflowEngine.transition(childTask.id, "READY_FOR_MERGE");
    workflowEngine.transition(childTask.id, "MERGING", {
      hasReviewPassed: true,
      hasSuccessfulIntegration: true,
      hasFinalMergeApproval: true,
      parentEpicReleased: false,
    });
    workflowEngine.transition(childTask.id, "DONE");

    // Should fail to transition to RELEASED without parentEpicReleased
    expect(() =>
      workflowEngine.transition(childTask.id, "RELEASED", {
        hasReviewPassed: true,
        hasSuccessfulIntegration: true,
        hasFinalMergeApproval: true,
        parentEpicReleased: false,
      }),
    ).toThrow(/not allowed by template/);

    const child = db!.get<{ status: string }>(
      "SELECT status FROM tasks WHERE id = $id",
      { id: childTask.id },
    );
    expect(child?.status).toBe("DONE");
  });
});
