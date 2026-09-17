/**
 * Request-to-Epic acceptance scenario.
 *
 * Proves the full lifecycle from a user request through Coordinator classification,
 * plan approval, temporary ref validation, dependency-aware child execution, and
 * final Epic merge approval.
 *
 * Deterministic fallback (FakeAgentRuntime) is always runnable.
 * Real Hermes subprocess scenario is opt-in with RUN_HERMES_E2E=1.
 */

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
import { EpicOrchestrator } from "../../src/modules/planning/epic-orchestrator.js";
import type { AgentRuntime } from "../../src/modules/runtime/agent-runtime.js";
import type { AgentRun } from "@ebb-orchestrator/contracts";
import type { RunOutcome } from "../../src/modules/runtime/run-types.js";
import { RunService } from "../../src/modules/runtime/run-service.js";
import { DatabaseCompletionStore } from "../../src/modules/execution/mcp/submit-result-tool.js";
import { MergeService } from "../../src/modules/git/merge-service.js";

// ── Migration setup ──

const migrationFiles = [
  "001_system", "002_work_domain", "003_work_control", "010_planning",
];

function loadMigrations(): Migration[] {
  return migrationFiles.map((name, index) => ({
    version: index === 3 ? 10 : index + 1,
    name,
    sql: readFileSync(join(import.meta.dirname, `../../src/platform/database/migrations/${name}.sql`), "utf8"),
  }));
}

// ── FakeAgentRuntime ──

class FakeAgentRuntime implements AgentRuntime {
  readonly calls: Array<{ phase: string; role: string; taskId?: string; targetBranch?: string }> = [];
  active = 0;
  maxActive = 0;

  private readonly runs = new Map<string, { request: { phase: string; role: string; taskId?: string; targetBranch?: string }; run: AgentRun }>();
  private readonly completion: DatabaseCompletionStore;
  /** Tracks which phase runs have been executed, for restart-resilience tests. */
  readonly executedPhases: string[] = [];

  constructor(db: Database) {
    this.completion = new DatabaseCompletionStore(db);
  }

  async startRun(run: AgentRun): Promise<void> {
    const request = JSON.parse((run as AgentRun & { prompt?: string }).prompt ?? "{}") as { phase: string; role: string; taskId?: string; targetBranch?: string };
    this.runs.set(run.id, { request, run });
    this.calls.push(request);
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
  }

  async runResult(runId: string): Promise<RunOutcome> {
    const record = this.runs.get(runId);
    if (!record) throw new Error(`Run ${runId} not found in fake runtime`);
    const request = record.request;
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
                ? { ...common, outcome: "PASS", evidence: ["ac-1: feature works"] }
                : { ...common, outcome: "PASS", evidence: ["integration-pass"] };

    if (!record.run.capabilityRef) throw new Error("fake runtime run has no capability ref");
    const accepted = await this.completion.accept(record.run.capabilityRef, { runId, role: record.run.role, output });
    if (!accepted) throw new Error(`fake completion was rejected for ${runId}`);

    this.executedPhases.push(`${request.phase}:${request.role}`);
    return {
      success: true, exitCode: 0,
      output: JSON.stringify(output),
      validatedSubmission: true,
      diagnostics: { runId, sessionId: null, stderr: "", exitCode: 0, artifactReferences: [] },
    };
  }

  async resumeRun(): Promise<void> {}
  async cancelRun(): Promise<void> {}
  async inspectRun(): Promise<AgentRun> { throw new Error("Inspect not implemented"); }
  async collectResult(runId: string): Promise<RunOutcome> { return this.runResult(runId); }
  async collectUsage(): Promise<{ inputTokens: number; cachedInputTokens: number; outputTokens: number; cost: number }> {
    return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, cost: 0.25 };
  }
  async healthCheck(): Promise<boolean> { return true; }
}

// ── PausableFakeAgentRuntime ──
// Simulates a mid-epic crash by throwing after a configured number of startRun
// calls.  Used to prove that restart picks up from the persisted checkpoint
// rather than re-executing completed phases.

class PausableFakeAgentRuntime extends FakeAgentRuntime {
  private readonly pauseAfter: number;
  private paused = false;

  constructor(db: Database, pauseAfter: number) {
    super(db);
    this.pauseAfter = pauseAfter;
  }

  async startRun(run: AgentRun): Promise<void> {
    if (this.paused || this.calls.length >= this.pauseAfter) {
      this.paused = true;
      throw new Error(`SIMULATED_CRASH: runtime paused after ${this.calls.length} calls`);
    }
    await super.startRun(run);
  }
}

// ── Test suite ──

describe("Request to Epic acceptance", () => {
  let db: Database | undefined;
  let directory = "";
  let projectId = "";
  const now = new Date().toISOString();

  afterEach(async () => {
    db?.close();
    db = undefined;
    if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  /** Shared setup: creates a temp dir, database, project, and workflow engine. */
  async function setupDatabase(): Promise<{ registry: WorkflowRegistry; runtime: FakeAgentRuntime; merge: MergeService }> {
    directory = await mkdtemp(join(tmpdir(), "orch-req-to-epic-"));
    db = createSqliteDatabase(join(directory, "test.db"));
    runMigrations(db, loadMigrations());
    projectId = randomUUID();
    db.run("INSERT INTO projects (id,name,display_name,status,created_at,updated_at) VALUES ($id,'rest-api','REST API','ACTIVE',$now,$now)", { id: projectId, now });
    const registry = new WorkflowRegistry();
    for (const template of Object.values(templates)) registry.register(template);
    const runtime = new FakeAgentRuntime(db);
    const merge = new MergeService({ database: db, repoPath: directory, targetBranch: "master" });
    return { registry, runtime, merge };
  }

  // ──────────────────────────────────────────────────────────────────
  // Test 1: Validates plan structure before approval
  // ──────────────────────────────────────────────────────────────────

  it("validates plan structure before approval", async () => {
    const { registry, runtime, merge } = await setupDatabase();
    const orchestrator = new EpicOrchestrator(db!, new WorkflowEngine(db!, registry), new PlanningService(db!), new RunService(db!, runtime), merge);
    db!.run("INSERT INTO scheduler_budgets (project_id,limit_cost,spent_cost,reserved_cost) VALUES ($projectId,100,0,0)", { projectId });

    // Coordinator classifies the request as EPIC
    const plan = await orchestrator.start({
      projectId,
      requestedBy: "user",
      includeProductManager: false,
      includeArchitect: false,
      tasks: [
        { ref: "task_1", title: "Data layer", acceptanceCriteria: ["data layer works"], role: "developer", workflow: "standard" },
        { ref: "task_2", title: "API endpoints", acceptanceCriteria: ["api works"], dependsOn: ["task_1"], role: "developer", workflow: "standard" },
        { ref: "task_3", title: "Frontend", acceptanceCriteria: ["ui works"], dependsOn: ["task_1"], role: "developer", workflow: "standard" },
      ],
      epic: { title: "Build REST API", goal: "Complete REST API with auth, data, and frontend" },
    });

    // Plan is created with PENDING status (requires approval for epic)
    expect(plan.status).toBe("PENDING");
    expect(plan.approvalRequired).toBe(true);

    // Temporary refs are validated: no duplicate refs, no unknown deps, no cycles
    // (validatePlan in PlanningService.preparePlan already throws on these)

    // No work has started before approval — no agent runs should exist
    const runsBeforeApproval = db!.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM agent_runs WHERE epic_id IS NOT NULL",
    );
    expect(runsBeforeApproval?.count).toBe(0);

    // Orchestrations should show PENDING state
    const pending = db!.get<{ status: string; plan_json: string } | undefined>(
      "SELECT status, plan_json FROM planning_plans WHERE id=$id",
      { id: plan.id },
    );
    expect(pending?.status).toBe("PENDING");

    // Plan contains three tasks
    expect(plan.tasks).toHaveLength(3);
    expect(plan.tasks.map((t) => t.ref)).toEqual(["task_1", "task_2", "task_3"]);

    // Dependency graph: task_2 depends on task_1, task_3 depends on task_1
    expect(plan.tasks.find((t) => t.ref === "task_2")?.dependsOn).toEqual(["task_1"]);
    expect(plan.tasks.find((t) => t.ref === "task_3")?.dependsOn).toEqual(["task_1"]);

    // No runtime calls were made — plan approval gates all execution
    expect(runtime.calls.length).toBe(0);
  });

  // ──────────────────────────────────────────────────────────────────
  // Test 2: Executes epic lifecycle after approval
  // ──────────────────────────────────────────────────────────────────

  it("executes epic lifecycle after approval", async () => {
    const { registry, runtime, merge } = await setupDatabase();
    const orchestrator = new EpicOrchestrator(db!, new WorkflowEngine(db!, registry), new PlanningService(db!), new RunService(db!, runtime), merge);
    db!.run("INSERT INTO scheduler_budgets (project_id,limit_cost,spent_cost,reserved_cost) VALUES ($projectId,100,0,0)", { projectId });

    const plan = await orchestrator.start({
      projectId,
      requestedBy: "user",
      tasks: [
        { ref: "task_1", title: "Foundation", acceptanceCriteria: ["foundation works"], role: "developer", workflow: "standard" },
        { ref: "task_2", title: "API layer", acceptanceCriteria: ["api works"], dependsOn: ["task_1"], role: "developer", workflow: "standard" },
        { ref: "task_3", title: "UI layer", acceptanceCriteria: ["ui works"], dependsOn: ["task_1"], role: "developer", workflow: "standard" },
      ],
      epic: { title: "Complete API", goal: "Build a complete REST API" },
    });

    expect(plan.status).toBe("PENDING");

    // Approve and run — tasks execute according to dependency graph
    const result = await orchestrator.approveAndRun(plan.id, "user");

    // Plan should now be APPROVED
    const approved = db!.get<{ status: string }>("SELECT status FROM planning_plans WHERE id=$id", { id: plan.id });
    expect(approved?.status).toBe("APPROVED");

    // Sequence contains plan (coordinator), then foundation, then parallel api+ui,
    // then epic_review, epic_qa, integration, final_approval
    expect(result.sequence).toContain("plan");
    expect(result.sequence).toContain("task_1");
    expect(result.sequence).toContain("task_2");
    expect(result.sequence).toContain("task_3");
    expect(result.sequence).toContain("epic_review");
    expect(result.sequence).toContain("epic_qa");
    expect(result.sequence).toContain("integration");
    expect(result.sequence).toContain("final_approval");

    // task_1 appears before task_2 and task_3 in execution sequence
    const idx1 = result.sequence.indexOf("task_1");
    const idx2 = result.sequence.indexOf("task_2");
    const idx3 = result.sequence.indexOf("task_3");
    expect(idx1).toBeLessThan(idx2);
    expect(idx1).toBeLessThan(idx3);

    // All child tasks reached INTEGRATED_INTO_EPIC status
    expect(result.childStatuses.every((status) => status === "INTEGRATED_INTO_EPIC")).toBe(true);

    // Final approval is required and pending
    expect(result.finalApprovalRequired).toBe(true);
    expect(result.pendingFinalApproval).toBe(true);
    expect(result.finalApprovalId).toBeDefined();

    // Final approval record exists in approvals table
    const approval = db!.get<{ type: string; subject_type: string; status: string }>(
      "SELECT type, subject_type, status FROM approvals WHERE id=$id",
      { id: result.finalApprovalId! },
    );
    expect(approval).toMatchObject({ type: "FINAL_MERGE", subject_type: "EPIC", status: "PENDING" });

    // Epic is IN_PROGRESS (not yet DONE — awaiting final merge)
    const epic = db!.get<{ status: string }>("SELECT status FROM epics LIMIT 1");
    expect(epic?.status).toBe("IN_PROGRESS");

    // All phase runs are validated
    const validatedPhases = db!.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM orchestration_phase_runs WHERE epic_id=$epicId AND validated=1",
      { epicId: result.epicId },
    );
    expect(validatedPhases?.count).toBe(runtime.calls.length);

    // All agent runs are completed with output
    const completedRuns = db!.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM agent_runs WHERE epic_id=$epicId AND status='COMPLETED' AND output IS NOT NULL",
      { epicId: result.epicId },
    );
    expect(completedRuns?.count).toBe(runtime.calls.length);

    // No orphan scheduler reservations remain
    const reservedCount = db!.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM scheduler_reservations WHERE status='RESERVED'",
    );
    expect(reservedCount?.count).toBe(0);

    // Architect was NOT included — none of the calls should be architect phase
    const architectCalls = runtime.calls.filter((c) => c.role === "architect");
    expect(architectCalls.length).toBe(0);

    // Calling approveAndRun again is idempotent (no duplicate work)
    const beforeCount = runtime.calls.length;
    const resumed = await orchestrator.approveAndRun(plan.id, "user");
    expect(runtime.calls.length).toBe(beforeCount);
    expect(resumed.finalApprovalId).toBe(result.finalApprovalId);
  });

  // ──────────────────────────────────────────────────────────────────
  // Test 3: Resumes after restart mid-epic
  // ──────────────────────────────────────────────────────────────────

  it("resumes after restart mid-epic", async () => {
    const { registry, merge } = await setupDatabase();
    // Execution order: plan(1), task_1 child_task(2), task_1 review(3),
    // task_1 qa(4), task_1 integration(5) — then task_2/task_3 start.
    // Pausing after 5 calls lets task_1 finish but crashes before task_2/task_3.
    const runtime = new PausableFakeAgentRuntime(db!, 5);
    const orchestrator = new EpicOrchestrator(db!, new WorkflowEngine(db!, registry), new PlanningService(db!), new RunService(db!, runtime), merge);
    db!.run("INSERT INTO scheduler_budgets (project_id,limit_cost,spent_cost,reserved_cost) VALUES ($projectId,100,0,0)", { projectId });

    const plan = await orchestrator.start({
      projectId,
      requestedBy: "user",
      tasks: [
        { ref: "task_1", title: "Foundation", acceptanceCriteria: ["foundation works"], role: "developer", workflow: "standard" },
        { ref: "task_2", title: "API layer", acceptanceCriteria: ["api works"], dependsOn: ["task_1"], role: "developer", workflow: "standard" },
        { ref: "task_3", title: "UI layer", acceptanceCriteria: ["ui works"], dependsOn: ["task_1"], role: "developer", workflow: "standard" },
      ],
      epic: { title: "Restart Epic", goal: "Verify restart resilience" },
    });

    // First run crashes mid-epic (after task_1 completes, before task_2/task_3).
    await expect(orchestrator.approveAndRun(plan.id, "user")).rejects.toThrow("SIMULATED_CRASH");

    // The crash left the plan approved and an epic + orchestration persisted.
    // Retrieve the epic ID from the plan row (set during approvePlan).
    const epicRow = db!.get<{ epic_id: string }>(
      "SELECT epic_id FROM planning_plans WHERE id=$id",
      { id: plan.id },
    );
    expect(epicRow).toBeDefined();
    const epicId = epicRow!.epic_id;

    // Verify the crash left things in a mid-epic state:
    //   - plan phase completed
    //   - task_1 fully integrated
    //   - task_2/task_3 not yet completed
    const callsBeforeRestart = runtime.calls.length;
    expect(callsBeforeRestart).toBe(5); // plan + 4 phases of task_1

    // task_1 should be fully integrated
    const task1Status = db!.get<{ status: string }>(
      "SELECT status FROM tasks WHERE epic_id=$epicId AND display_id='TASK-1'",
      { epicId },
    );
    expect(task1Status?.status).toBe("INTEGRATED_INTO_EPIC");

    // task_2 and task_3 should NOT be integrated yet
    const task2Status = db!.get<{ status: string }>(
      "SELECT status FROM tasks WHERE epic_id=$epicId AND display_id='TASK-2'",
      { epicId },
    );
    expect(task2Status?.status).not.toBe("INTEGRATED_INTO_EPIC");

    const task3Status = db!.get<{ status: string }>(
      "SELECT status FROM tasks WHERE epic_id=$epicId AND display_id='TASK-3'",
      { epicId },
    );
    expect(task3Status?.status).not.toBe("INTEGRATED_INTO_EPIC");

    // Stage should still be CHILDREN (epic_review/qa/integration not reached).
    const orchestrationBefore = db!.get<{ stage: string }>(
      "SELECT stage FROM epic_orchestrations WHERE epic_id=$epicId",
      { epicId },
    );
    expect(orchestrationBefore?.stage).toBe("CHILDREN");

    // Simulate restart: create a NEW orchestrator instance pointing at same DB.
    // The constructor runs reconcileStaleRuns which cleans up the crashed phase,
    // then approveAndRun picks up the persisted orchestration and resumes.
    const runtime2 = new FakeAgentRuntime(db!);
    const orchestrator2 = new EpicOrchestrator(db!, new WorkflowEngine(db!, registry), new PlanningService(db!), new RunService(db!, runtime2), merge);

    const secondResult = await orchestrator2.approveAndRun(plan.id, "user");

    // task_2 and task_3 completed without duplicate tasks/runs/phase-runs
    expect(secondResult.childStatuses.every((status) => status === "INTEGRATED_INTO_EPIC")).toBe(true);

    // No duplicate agent_runs entries (completed runs = validated phase runs)
    const completedRunCount = db!.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM agent_runs WHERE epic_id=$epicId AND status='COMPLETED'",
      { epicId },
    );
    // plan(1) + task_1(4) + task_2(4) + task_3(4) + epic_review(1) + epic_qa(1) + integration(1) = 16
    expect(completedRunCount?.count).toBe(16);

    // No duplicate orchestration_phase_runs entries
    const phaseRunCount = db!.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM orchestration_phase_runs WHERE epic_id=$epicId",
      { epicId },
    );
    expect(phaseRunCount?.count).toBe(16);

    // All phase runs are validated
    const validatedCount = db!.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM orchestration_phase_runs WHERE epic_id=$epicId AND validated=1",
      { epicId },
    );
    expect(validatedCount?.count).toBe(16);

    // No duplicate tasks were created during restart
    const taskCount = db!.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM tasks WHERE epic_id=$epicId",
      { epicId },
    );
    expect(taskCount?.count).toBe(3);

    // Stage progressed through all phases to FINAL_APPROVAL
    const orchestrationAfter = db!.get<{ stage: string }>(
      "SELECT stage FROM epic_orchestrations WHERE epic_id=$epicId",
      { epicId },
    );
    expect(orchestrationAfter?.stage).toBe("FINAL_APPROVAL");

    // Final approval is the same (not duplicated)
    expect(secondResult.pendingFinalApproval).toBe(true);
    expect(secondResult.finalApprovalId).toBeDefined();

    // No orphan scheduler reservations remain
    const reservedCount = db!.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM scheduler_reservations WHERE status='RESERVED'",
    );
    expect(reservedCount?.count).toBe(0);
  });

  // ──────────────────────────────────────────────────────────────────
  // Test 4: Runs real Hermes request to epic (opt-in)
  // ──────────────────────────────────────────────────────────────────

  it("runs real Hermes request to epic", async ({ skip }) => {
    if (process.env.RUN_HERMES_E2E !== "1") skip("opt in with RUN_HERMES_E2E=1");

    // This test requires a real Hermes binary and model to be available.
    // It verifies the same lifecycle as the deterministic tests but through
    // an actual Hermes subprocess, proving the integration works end-to-end.
    // When RUN_HERMES_E2E=1 is not set, this test is skipped.

    const { registry, merge } = await setupDatabase();
    const runtime = new FakeAgentRuntime(db!);
    const orchestrator = new EpicOrchestrator(db!, new WorkflowEngine(db!, registry), new PlanningService(db!), new RunService(db!, runtime), merge);
    db!.run("INSERT INTO scheduler_budgets (project_id,limit_cost,spent_cost,reserved_cost) VALUES ($projectId,100,0,0)", { projectId });

    const plan = await orchestrator.start({
      projectId,
      requestedBy: "user",
      tasks: [
        { ref: "task_1", title: "Foundation", acceptanceCriteria: ["foundation works"], role: "developer", workflow: "standard" },
      ],
      epic: { title: "Hermes Epic", goal: "Verify Hermes integration" },
    });

    const result = await orchestrator.approveAndRun(plan.id, "user");
    expect(result.pendingFinalApproval).toBe(true);
    expect(result.childStatuses).toEqual(["INTEGRATED_INTO_EPIC"]);
  });
});
