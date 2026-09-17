import type { Database } from "../../platform/database/database.js";
import type { PlanningPlan, PlanningPlanInput } from "./planning-types.js";
import { PlanningService } from "./planning-service.js";
import { WorkflowEngine } from "../workflow/workflow-engine.js";
import { RuntimeEventHandlers } from "../runtime/run-event-handlers.js";
import { ApprovalService } from "../approvals/approval-service.js";

export interface EpicAgentRequest { phase: string; role: string; epicId?: string; taskId?: string; targetBranch?: string }
export interface EpicAgentResult { accepted: boolean; architectureChangingProposalAccepted?: boolean }
export interface EpicAgentRuntime { run(request: EpicAgentRequest): Promise<EpicAgentResult> }
export interface EpicStartInput extends PlanningPlanInput { includeProductManager?: boolean; includeArchitect?: boolean; architectureReviewRequired?: boolean; architecture_review_required?: boolean }
export interface EpicRunResult { epicId: string; sequence: string[]; childStatuses: string[]; finalApprovalRequired: boolean; pendingFinalApproval: boolean; finalApprovalId?: string }
type Stage = "CHILDREN" | "EPIC_REVIEW" | "ARCHITECTURE_REVIEW" | "EPIC_QA" | "INTEGRATION" | "FINAL_APPROVAL" | "DONE";
type Child = { id: string; display_id: string; status: string };

/** Owns the fixed lifecycle. All checkpoints are persisted before returning. */
export class EpicOrchestrator {
  private readonly handlers: RuntimeEventHandlers;
  private readonly approvals: ApprovalService;

  constructor(private readonly db: Database, private readonly workflow: WorkflowEngine, private readonly planning: PlanningService, private readonly runtime: EpicAgentRuntime) {
    this.handlers = new RuntimeEventHandlers(db, workflow);
    this.approvals = new ApprovalService(db);
    this.db.exec(`CREATE TABLE IF NOT EXISTS epic_orchestrations (epic_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, input_json TEXT NOT NULL, stage TEXT NOT NULL, sequence_json TEXT NOT NULL DEFAULT '[]', architecture_review_authorized INTEGER NOT NULL DEFAULT 0, final_approval_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  }

  async start(input: EpicStartInput): Promise<PlanningPlan> {
    await this.runtime.run({ phase: "plan", role: "coordinator" });
    const planInput: PlanningPlanInput = { projectId: input.projectId, tasks: input.tasks, architectureChange: input.architectureChange ?? input.includeArchitect ?? false };
    if (input.requestedBy !== undefined) planInput.requestedBy = input.requestedBy;
    if (input.epic !== undefined) planInput.epic = input.epic;
    return this.planning.preparePlan({ ...planInput, includeProductManager: input.includeProductManager, includeArchitect: input.includeArchitect, architectureReviewRequired: input.architectureReviewRequired, architecture_review_required: input.architecture_review_required } as EpicStartInput);
  }

  async approveAndRun(planId: string, actor: string): Promise<EpicRunResult> {
    const row = this.db.get<{ project_id: string; plan_json: string; status: string }>("SELECT project_id, plan_json, status FROM planning_plans WHERE id=$id", { id: planId });
    if (!row) throw new Error(`Epic plan ${planId} not found`);
    const input = JSON.parse(row.plan_json) as EpicStartInput;
    if (row.status === "PENDING") this.planning.approvePlan(planId, actor);
    const epic = this.db.get<{ id: string }>("SELECT id FROM epics WHERE project_id=$projectId ORDER BY rowid DESC LIMIT 1", { projectId: row.project_id });
    if (!epic) throw new Error("Approved Epic plan did not materialize an Epic");
    if (!this.db.get("SELECT epic_id FROM epic_orchestrations WHERE epic_id=$epicId", { epicId: epic.id })) {
      const now = new Date().toISOString();
      this.db.run("INSERT INTO epic_orchestrations (epic_id,plan_id,input_json,stage,sequence_json,created_at,updated_at) VALUES ($epicId,$planId,$input,'CHILDREN',$sequence,$now,$now)", { epicId: epic.id, planId, input: JSON.stringify(input), sequence: JSON.stringify(["plan"]), now });
    }
    return this.execute(epic.id, input);
  }

  approveFinalMerge(epicId: string, approvalId?: string): EpicRunResult {
    if (!approvalId) throw new Error(`A persisted final approval id is required for Epic ${epicId}`);
    this.handlers.handleEpicMergeCompleted(epicId, approvalId);
    return this.result(epicId);
  }

  private async execute(epicId: string, input: EpicStartInput): Promise<EpicRunResult> {
    const epic = this.db.get<{ display_id: string }>("SELECT display_id FROM epics WHERE id=$epicId", { epicId });
    if (!epic) throw new Error(`Epic ${epicId} not found`);
    this.db.run("UPDATE epics SET status='IN_PROGRESS', updated_at=$updatedAt WHERE id=$epicId AND status='OPEN'", { epicId, updatedAt: new Date().toISOString() });
    const row = () => this.db.get<{ stage: Stage; sequence_json: string; architecture_review_authorized: number; final_approval_id: string | null }>("SELECT stage,sequence_json,architecture_review_authorized,final_approval_id FROM epic_orchestrations WHERE epic_id=$epicId", { epicId })!;
    const add = (name: string) => { const r = row(); const sequence = JSON.parse(r.sequence_json) as string[]; if (!sequence.includes(name)) sequence.push(name); this.db.run("UPDATE epic_orchestrations SET sequence_json=$sequence,updated_at=$at WHERE epic_id=$epicId", { epicId, sequence: JSON.stringify(sequence), at: new Date().toISOString() }); };
    const checkpoint = (stage: Stage) => this.db.run("UPDATE epic_orchestrations SET stage=$stage,updated_at=$at WHERE epic_id=$epicId", { epicId, stage, at: new Date().toISOString() });
    let state = row();
    const sequence = JSON.parse(state.sequence_json) as string[];
    let architectureProposalAccepted = false;
    if (input.includeProductManager && !sequence.includes("pm")) {
      this.requireAccepted(await this.runtime.run({ phase: "pm", role: "product_manager", epicId })); add("pm");
    }
    if (input.includeArchitect && !sequence.includes("architect")) {
      const architect = await this.runtime.run({ phase: "architect", role: "architect", epicId });
      this.requireAccepted(architect); architectureProposalAccepted = architect.architectureChangingProposalAccepted === true;
      if (architectureProposalAccepted) this.db.run("UPDATE epic_orchestrations SET architecture_review_authorized=1,updated_at=$at WHERE epic_id=$epicId", { epicId, at: new Date().toISOString() });
      add("architect");
    }
    if (state.stage === "CHILDREN") { await this.runDependencyAwareChildren(epicId, epic.display_id, input.tasks.map((task) => task.ref)); checkpoint("EPIC_REVIEW"); state = row(); }
    const phase = async (name: string, role: string, next: Stage) => { if (row().stage !== name.toUpperCase() && !["EPIC_REVIEW","ARCHITECTURE_REVIEW","EPIC_QA","INTEGRATION"].includes(row().stage)) return; this.requireAccepted(await this.runtime.run({ phase: name, role, epicId })); add(name); checkpoint(next); };
    if (state.stage === "EPIC_REVIEW") { await phase("epic_review", "reviewer", input.architectureReviewRequired || input.architecture_review_required || architectureProposalAccepted || row().architecture_review_authorized === 1 ? "ARCHITECTURE_REVIEW" : "EPIC_QA"); state = row(); }
    if (state.stage === "ARCHITECTURE_REVIEW") { await phase("architecture_review", "architect", "EPIC_QA"); state = row(); }
    if (state.stage === "EPIC_QA") { await phase("epic_qa", "qa", "INTEGRATION"); state = row(); }
    if (state.stage === "INTEGRATION") { await phase("integration", "integration", "FINAL_APPROVAL"); state = row(); }
    if (state.stage === "FINAL_APPROVAL" && !state.final_approval_id) {
      add("final_approval");
      const approval = this.approvals.request({ type: "FINAL_MERGE", subjectId: epicId, subjectType: "EPIC", requestedBy: input.requestedBy ?? "coordinator" });
      this.db.run("UPDATE epic_orchestrations SET final_approval_id=$approvalId,updated_at=$at WHERE epic_id=$epicId", { epicId, approvalId: approval.id, at: new Date().toISOString() });
    }
    return this.result(epicId);
  }

  private async runDependencyAwareChildren(epicId: string, displayId: string, refs: string[]): Promise<void> {
    for (;;) {
      const tasks = this.db.all<Child>("SELECT id,display_id,status FROM tasks WHERE epic_id=$epicId ORDER BY display_id", { epicId });
      const pending = tasks.filter((t) => t.status !== "INTEGRATED_INTO_EPIC" && t.status !== "RELEASED");
      if (!pending.length) return;
      const runnable = pending.filter((task) => this.db.get<{ blocked: number }>("SELECT COUNT(*) AS blocked FROM dependencies d JOIN tasks dep ON dep.id=d.depends_on_task_id WHERE d.task_id=$taskId AND d.type='BLOCKING' AND dep.status NOT IN ('INTEGRATED_INTO_EPIC','RELEASED')", { taskId: task.id })?.blocked === 0);
      if (!runnable.length) throw new Error(`Epic ${epicId} has no runnable children; dependency graph is blocked`);
      await Promise.all(runnable.map((task) => this.runChild(task, epicId, `epic/${displayId}`)));
      this.db.transaction((tx) => {
        const current = tx.get<{ sequence_json: string }>("SELECT sequence_json FROM epic_orchestrations WHERE epic_id=$epicId", { epicId });
        const sequence = JSON.parse(current?.sequence_json ?? "[]") as string[];
        for (const task of runnable) {
          const index = tasks.findIndex((candidate) => candidate.id === task.id);
          const name = refs[index] ?? task.display_id;
          if (!sequence.includes(name)) sequence.push(name);
        }
        tx.run("UPDATE epic_orchestrations SET sequence_json=$sequence,updated_at=$at WHERE epic_id=$epicId", { epicId, sequence: JSON.stringify(sequence), at: new Date().toISOString() });
      });
    }
  }
  private async runChild(task: Child, epicId: string, branch: string): Promise<void> {
    if (task.status === "INTEGRATED_INTO_EPIC" || task.status === "RELEASED") return;
    if (task.status === "DRAFT") this.workflow.transition(task.id, "READY");
    this.workflow.transition(task.id, "DEVELOPMENT");
    this.requireAccepted(await this.runtime.run({ phase: "child_task", role: "developer", taskId: task.id, epicId, targetBranch: branch }));
    this.workflow.transition(task.id, "REVIEW"); this.workflow.transition(task.id, "QA"); this.workflow.transition(task.id, "READY_FOR_INTEGRATION"); this.workflow.transition(task.id, "INTEGRATION");
    this.workflow.transition(task.id, "INTEGRATED_INTO_EPIC", { hasReviewPassed: true, hasSuccessfulIntegration: true, hasFinalMergeApproval: false, parentEpicReleased: false });
  }
  private result(epicId: string): EpicRunResult {
    const state = this.db.get<{ sequence_json: string; stage: Stage; final_approval_id: string | null }>("SELECT sequence_json,stage,final_approval_id FROM epic_orchestrations WHERE epic_id=$epicId", { epicId });
    if (!state) throw new Error(`Epic ${epicId} has no persisted orchestration`);
    const result: EpicRunResult = { epicId, sequence: JSON.parse(state.sequence_json) as string[], childStatuses: this.db.all<{ status: string }>("SELECT status FROM tasks WHERE epic_id=$epicId ORDER BY display_id", { epicId }).map((r) => r.status), finalApprovalRequired: true, pendingFinalApproval: state.stage !== "DONE" };
    if (state.final_approval_id) result.finalApprovalId = state.final_approval_id;
    return result;
  }
  private requireAccepted(result: EpicAgentResult): void { if (!result.accepted) throw new Error("Epic role result was not accepted"); }
}
