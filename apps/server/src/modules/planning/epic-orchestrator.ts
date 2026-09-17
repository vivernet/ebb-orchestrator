import type { Database } from "../../platform/database/database.js";
import type { PlanningPlan, PlanningPlanInput } from "./planning-types.js";
import { PlanningService } from "./planning-service.js";
import { WorkflowEngine } from "../workflow/workflow-engine.js";
import { RuntimeEventHandlers } from "../runtime/run-event-handlers.js";
import { ApprovalService } from "../approvals/approval-service.js";
import { SchedulerService } from "../scheduler/scheduler-service.js";

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
  private readonly scheduler: SchedulerService;

  constructor(private readonly db: Database, private readonly workflow: WorkflowEngine, private readonly planning: PlanningService, private readonly runtime: EpicAgentRuntime) {
    this.handlers = new RuntimeEventHandlers(db, workflow);
    this.approvals = new ApprovalService(db);
    this.scheduler = new SchedulerService(db);
    this.db.exec(`CREATE TABLE IF NOT EXISTS epic_orchestrations (epic_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, input_json TEXT NOT NULL, stage TEXT NOT NULL, sequence_json TEXT NOT NULL DEFAULT '[]', architecture_review_authorized INTEGER NOT NULL DEFAULT 0, final_approval_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS orchestration_phase_runs (id TEXT PRIMARY KEY, epic_id TEXT, task_id TEXT, phase TEXT NOT NULL, role TEXT NOT NULL, agent_run_id TEXT NOT NULL UNIQUE, result_json TEXT NOT NULL, evidence_json TEXT NOT NULL, validated INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, UNIQUE (epic_id, task_id, phase))`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS agent_runs (id TEXT PRIMARY KEY, role TEXT NOT NULL, runtime TEXT NOT NULL, model TEXT NOT NULL, task_id TEXT, epic_id TEXT, status TEXT NOT NULL, started_at TEXT, ended_at TEXT, exit_code INTEGER, output TEXT)`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS scheduler_capacity_reservations (task_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, owner_id TEXT NOT NULL, reserved_at TEXT NOT NULL)`);
    try { this.db.exec("ALTER TABLE planning_plans ADD COLUMN epic_id TEXT"); } catch { /* already present */ }
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
    const epic = this.db.get<{ id: string }>("SELECT epic_id AS id FROM planning_plans WHERE id=$planId AND epic_id IS NOT NULL", { planId });
    if (!epic) throw new Error("Approved Epic plan did not materialize an Epic");
    const persisted = this.db.get<{ input_json: string }>("SELECT input_json FROM epic_orchestrations WHERE epic_id=$epicId AND plan_id=$planId", { epicId: epic.id, planId });
    if (!persisted) {
      const now = new Date().toISOString();
      this.db.run("INSERT INTO epic_orchestrations (epic_id,plan_id,input_json,stage,sequence_json,created_at,updated_at) VALUES ($epicId,$planId,$input,'CHILDREN',$sequence,$now,$now)", { epicId: epic.id, planId, input: JSON.stringify(input), sequence: JSON.stringify(["plan"]), now });
    } else {
      return this.execute(epic.id, JSON.parse(persisted.input_json) as EpicStartInput);
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
      await this.runPhase(epicId, undefined, "pm", "product_manager", { phase: "pm", role: "product_manager", epicId }); add("pm");
    }
    if (input.includeArchitect && !sequence.includes("architect")) {
      const architect = await this.runPhase(epicId, undefined, "architect", "architect", { phase: "architect", role: "architect", epicId });
      architectureProposalAccepted = architect.architectureChangingProposalAccepted === true;
      if (architectureProposalAccepted) this.db.run("UPDATE epic_orchestrations SET architecture_review_authorized=1,updated_at=$at WHERE epic_id=$epicId", { epicId, at: new Date().toISOString() });
      add("architect");
    }
    if (state.stage === "CHILDREN") { await this.runDependencyAwareChildren(epicId, epic.display_id, input.tasks.map((task) => task.ref)); checkpoint("EPIC_REVIEW"); state = row(); }
    const phase = async (name: string, role: string, next: Stage) => { if (row().stage !== name.toUpperCase() && !["EPIC_REVIEW","ARCHITECTURE_REVIEW","EPIC_QA","INTEGRATION"].includes(row().stage)) return; await this.runPhase(epicId, undefined, name, role, { phase: name, role, epicId }); add(name); checkpoint(next); };
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
    let result: EpicAgentResult;
    const current = this.workflow.currentStage(task.id);
    if (current === "READY") {
      this.scheduler.dispatchTask(task.id, this.workflow, () => undefined);
       result = await this.runPhase(epicId, task.id, "child_task", "developer", { phase: "child_task", role: "developer", taskId: task.id, epicId, targetBranch: branch });
    } else if (current === "DEVELOPMENT") {
      // DEVELOPMENT is the durable in-flight checkpoint after a restart.
      result = await this.runPhase(epicId, task.id, "child_task", "developer", { phase: "child_task_reconcile", role: "developer", taskId: task.id, epicId, targetBranch: branch });
    } else {
      result = this.loadPhaseResult(epicId, task.id, "child_task");
    }
    this.requirePersistedEvidence(epicId, task.id, "child_task", result);
    const stage = this.workflow.currentStage(task.id);
    if (stage === "DEVELOPMENT") this.workflow.transition(task.id, "REVIEW");
    if (this.workflow.currentStage(task.id) === "REVIEW") this.workflow.transition(task.id, "QA", { hasReviewPassed: true, hasSuccessfulIntegration: false, hasFinalMergeApproval: false, parentEpicReleased: false });
    if (this.workflow.currentStage(task.id) === "QA") this.workflow.transition(task.id, "READY_FOR_INTEGRATION");
    if (this.workflow.currentStage(task.id) === "READY_FOR_INTEGRATION") this.workflow.transition(task.id, "INTEGRATION");
    if (this.workflow.currentStage(task.id) === "INTEGRATION") this.workflow.transition(task.id, "INTEGRATED_INTO_EPIC", { hasReviewPassed: true, hasSuccessfulIntegration: true, hasFinalMergeApproval: false, parentEpicReleased: false });
    this.scheduler.releaseTask(task.id);
  }
  private result(epicId: string): EpicRunResult {
    const state = this.db.get<{ sequence_json: string; stage: Stage; final_approval_id: string | null }>("SELECT sequence_json,stage,final_approval_id FROM epic_orchestrations WHERE epic_id=$epicId", { epicId });
    if (!state) throw new Error(`Epic ${epicId} has no persisted orchestration`);
    const result: EpicRunResult = { epicId, sequence: JSON.parse(state.sequence_json) as string[], childStatuses: this.db.all<{ status: string }>("SELECT status FROM tasks WHERE epic_id=$epicId ORDER BY display_id", { epicId }).map((r) => r.status), finalApprovalRequired: true, pendingFinalApproval: state.stage !== "DONE" };
    if (state.final_approval_id) result.finalApprovalId = state.final_approval_id;
    return result;
  }
  private async runPhase(epicId: string, taskId: string | undefined, phase: string, role: string, request: EpicAgentRequest): Promise<EpicAgentResult> {
    const existing = this.db.get<{ result_json: string; validated: number }>("SELECT result_json,validated FROM orchestration_phase_runs WHERE epic_id=$epicId AND task_id IS $taskId AND phase=$phase", { epicId, taskId: taskId ?? null, phase });
    if (existing) {
      if (existing.validated !== 1) throw new Error(`Persisted ${phase} evidence is not validated`);
      return JSON.parse(existing.result_json) as EpicAgentResult;
    }
    return this.persistedPhase(epicId, taskId, phase, role, await this.runtime.run(request));
  }

  private persistedPhase(epicId: string, taskId: string | undefined, phase: string, role: string, result: EpicAgentResult): EpicAgentResult {
    const now = new Date().toISOString();
    const agentRunId = crypto.randomUUID();
    const phaseId = crypto.randomUUID();
    const evidence = { kind: "validated-orchestration-result", phase, role, accepted: result.accepted === true, recordedAt: now };
    if (!result.accepted) throw new Error(`Epic role result was not accepted`);
    this.db.transaction((tx) => {
      tx.run(`INSERT INTO agent_runs (id,role,runtime,model,task_id,epic_id,status,started_at,ended_at,exit_code,output) VALUES($id,$role,'orchestrator','persisted',$taskId,$epicId,'COMPLETED',$at,$at,0,$output)`, { id: agentRunId, role, taskId: taskId ?? null, epicId, at: now, output: JSON.stringify(result) });
      tx.run(`INSERT INTO orchestration_phase_runs(id,epic_id,task_id,phase,role,agent_run_id,result_json,evidence_json,validated,created_at) VALUES($id,$epicId,$taskId,$phase,$role,$run,$result,$evidence,1,$at)`, { id: phaseId, epicId, taskId: taskId ?? null, phase, role, run: agentRunId, result: JSON.stringify(result), evidence: JSON.stringify(evidence), at: now });
    });
    return result;
  }

  private loadPhaseResult(epicId: string, taskId: string, phase: string): EpicAgentResult {
    const row = this.db.get<{ result_json: string; validated: number }>("SELECT result_json,validated FROM orchestration_phase_runs WHERE epic_id=$epicId AND task_id=$taskId AND phase=$phase", { epicId, taskId, phase });
    if (!row || row.validated !== 1) throw new Error(`Missing validated persisted result for ${phase} ${taskId}`);
    return JSON.parse(row.result_json) as EpicAgentResult;
  }

  private requirePersistedEvidence(epicId: string, taskId: string, phase: string, result: EpicAgentResult): void {
    const persisted = this.loadPhaseResult(epicId, taskId, phase);
    if (!persisted.accepted || persisted.accepted !== result.accepted) throw new Error(`Persisted evidence for ${phase} is invalid`);
  }
}
