import type { Database } from "../../platform/database/database.js";
import type { PlanningPlan, PlanningPlanInput } from "./planning-types.js";
import { PlanningService } from "./planning-service.js";
import { WorkflowEngine } from "../workflow/workflow-engine.js";
import { RuntimeEventHandlers } from "../runtime/run-event-handlers.js";

export interface EpicAgentRequest {
  phase: string;
  role: string;
  epicId?: string;
  taskId?: string;
  targetBranch?: string;
}

export interface EpicAgentResult {
  accepted: boolean;
  architectureChangingProposalAccepted?: boolean;
}

/** Testable runtime port used by the deterministic Epic coordinator. */
export interface EpicAgentRuntime {
  run(request: EpicAgentRequest): Promise<EpicAgentResult>;
}

export interface EpicStartInput extends PlanningPlanInput {
  includeProductManager?: boolean;
  includeArchitect?: boolean;
  architectureReviewRequired?: boolean;
  architecture_review_required?: boolean;
}

export interface EpicRunResult {
  epicId: string;
  sequence: string[];
  childStatuses: string[];
  finalApprovalRequired: boolean;
  pendingFinalApproval: boolean;
}

/** Owns the fixed, non-agent-controlled Epic lifecycle. */
export class EpicOrchestrator {
  private readonly pending = new Map<string, EpicStartInput>();
  private readonly runs = new Map<string, EpicRunResult>();
  private readonly handlers: RuntimeEventHandlers;

  constructor(
    private readonly db: Database,
    private readonly workflow: WorkflowEngine,
    private readonly planning: PlanningService,
    private readonly runtime: EpicAgentRuntime,
  ) {
    this.handlers = new RuntimeEventHandlers(db, workflow);
  }

  async start(input: EpicStartInput): Promise<PlanningPlan> {
    await this.runtime.run({ phase: "plan", role: "coordinator" });
    const planInput: PlanningPlanInput = {
      projectId: input.projectId,
      tasks: input.tasks,
      architectureChange: input.architectureChange ?? input.includeArchitect ?? false,
    };
    if (input.requestedBy !== undefined) planInput.requestedBy = input.requestedBy;
    if (input.epic !== undefined) planInput.epic = input.epic;
    const plan = this.planning.preparePlan(planInput);
    this.pending.set(plan.id, input);
    return plan;
  }

  async approveAndRun(planId: string, actor: string): Promise<EpicRunResult> {
    const input = this.pending.get(planId);
    if (!input) throw new Error(`Epic plan ${planId} is not pending in this orchestrator`);
    const plan = this.planning.approvePlan(planId, actor);
    return this.execute(plan, input);
  }

  /** The only path that completes the final Epic merge. */
  approveFinalMerge(epicId: string): EpicRunResult {
    const result = this.runs.get(epicId);
    if (!result || !result.pendingFinalApproval) throw new Error(`Epic ${epicId} has no pending final merge approval`);
    this.handlers.handleEpicMergeCompleted(epicId, true);
    const completed: EpicRunResult = {
      ...result,
      sequence: [...result.sequence, "final_merge"],
      childStatuses: this.db.all<{ status: string }>("SELECT status FROM tasks WHERE epic_id=$epicId ORDER BY display_id", { epicId }).map((row) => row.status),
      pendingFinalApproval: false,
    };
    this.runs.set(epicId, completed);
    return completed;
  }

  private async execute(plan: PlanningPlan, input: EpicStartInput): Promise<EpicRunResult> {
    const epic = this.db.get<{ id: string; display_id: string }>(
      "SELECT id, display_id FROM epics WHERE project_id=$projectId ORDER BY rowid DESC LIMIT 1",
      { projectId: plan.projectId },
    );
    if (!epic) throw new Error("Approved Epic plan did not materialize an Epic");
    const sequence = ["plan"];
    if (input.includeProductManager) {
      this.requireAccepted(await this.runtime.run({ phase: "pm", role: "product_manager", epicId: epic.id }));
      sequence.push("pm");
    }
    let architectureProposalAccepted = false;
    if (input.includeArchitect) {
      const result = await this.runtime.run({ phase: "architect", role: "architect", epicId: epic.id });
      this.requireAccepted(result);
      architectureProposalAccepted = result.architectureChangingProposalAccepted === true;
      sequence.push("architect");
    }

    this.db.run("UPDATE epics SET status='IN_PROGRESS', updated_at=$updatedAt WHERE id=$id", { id: epic.id, updatedAt: new Date().toISOString() });
    const branch = `epic/${epic.display_id}`;
    const tasks = this.db.all<{ id: string; display_id: string; required: number; status: string }>(
      "SELECT id, display_id, required, status FROM tasks WHERE epic_id=$epicId ORDER BY display_id", { epicId: epic.id },
    );
    const byRef = new Map(Object.entries(plan.temporaryIdMap).map(([ref, displayId]) => [displayId, ref]));
    const foundation = tasks.find((task) => byRef.get(task.display_id) === "foundation") ?? tasks[0];
    if (!foundation) throw new Error("Epic has no child Tasks");
    await this.runChild(foundation, epic.id, branch);
    sequence.push(byRef.get(foundation.display_id) ?? foundation.display_id);
    const parallel = tasks.filter((task) => task.id !== foundation.id);
    await Promise.all(parallel.map((task) => this.runChild(task, epic.id, branch)));
    for (const task of parallel) sequence.push(byRef.get(task.display_id) ?? task.display_id);

    const required = this.db.get<{ remaining: number }>(
      "SELECT COUNT(*) AS remaining FROM tasks WHERE epic_id=$epicId AND required=1 AND status <> 'INTEGRATED_INTO_EPIC'", { epicId: epic.id },
    );
    if ((required?.remaining ?? 1) !== 0) throw new Error("Final Epic checks started before required children integrated");
    await this.phase(sequence, "epic_review", "reviewer", epic.id);
    if (input.architectureReviewRequired || input.architecture_review_required || architectureProposalAccepted) await this.phase(sequence, "architecture_review", "architect", epic.id);
    await this.phase(sequence, "epic_qa", "qa", epic.id);
    await this.phase(sequence, "integration", "integration", epic.id);
    sequence.push("final_approval");
    const result: EpicRunResult = {
      epicId: epic.id, sequence, childStatuses: tasks.map(() => "INTEGRATED_INTO_EPIC"),
      finalApprovalRequired: true, pendingFinalApproval: true,
    };
    this.runs.set(epic.id, result);
    return result;
  }

  private async runChild(task: { id: string }, epicId: string, branch: string): Promise<void> {
    this.workflow.transition(task.id, "READY");
    this.workflow.transition(task.id, "DEVELOPMENT");
    this.requireAccepted(await this.runtime.run({ phase: "child_task", role: "developer", taskId: task.id, epicId, targetBranch: branch }));
    this.workflow.transition(task.id, "REVIEW");
    this.workflow.transition(task.id, "QA");
    this.workflow.transition(task.id, "READY_FOR_INTEGRATION");
    this.workflow.transition(task.id, "INTEGRATION");
    this.workflow.transition(task.id, "INTEGRATED_INTO_EPIC", { hasReviewPassed: true, hasSuccessfulIntegration: true, hasFinalMergeApproval: false, parentEpicReleased: false });
  }

  private async phase(sequence: string[], name: string, role: string, epicId: string): Promise<void> {
    this.requireAccepted(await this.runtime.run({ phase: name, role, epicId }));
    sequence.push(name);
  }

  private requireAccepted(result: EpicAgentResult): void {
    if (!result.accepted) throw new Error("Epic role result was not accepted");
  }
}
