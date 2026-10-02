import type { Database, DatabaseTx } from "../../platform/database/database.js";
import { EPIC_RECOVERY_FAILURE_CODE, type PlanningPlan, type PlanningPlanInput } from "./planning-types.js";
import { PlanningService } from "./planning-service.js";
import { validatePlan } from "./plan-validator.js";
import { WorkflowEngine } from "../workflow/workflow-engine.js";
import { RuntimeEventHandlers } from "../runtime/run-event-handlers.js";
import { ApprovalService } from "../approvals/approval-service.js";
import { SchedulerService } from "../scheduler/scheduler-service.js";
import type { MergeService, MergeResult } from "../git/merge-service.js";
import type { IntegrationAttempt, IntegrationService } from "../git/integration-service.js";
import { validateRoleOutput } from "../runtime/output-validator.js";
import { createRunContextInput, RunService, taskDeveloperPrompt, taskQaPrompt, taskReviewerPrompt } from "../runtime/run-service.js";
import { promptBuilder } from "../runtime/prompt-builder.js";
import type { TaskContract } from "../context/context-types.js";
import { GitCli, assertSafeGitRef } from "../git/git-cli.js";

export interface EpicAgentRequest { phase: string; role: string; epicId?: string; taskId?: string; targetBranch?: string }
export interface EpicAgentResult { accepted: boolean; output: unknown; architectureChangingProposalAccepted?: boolean; usage?: { cost: number } }
export interface EpicStartInput extends PlanningPlanInput { includeProductManager?: boolean; includeArchitect?: boolean; architectureReviewRequired?: boolean; architecture_review_required?: boolean }
export interface EpicRunResult { epicId: string; sequence: string[]; childStatuses: string[]; finalApprovalRequired: boolean; pendingFinalApproval: boolean; finalApprovalId?: string }
/**
 * Контекст создаваемой интеграции. Репозиторий берётся оркестратором только
 * из durable Git/onboarding state; корень worktree предоставляет composition
 * root, чтобы runtime не мог выбрать произвольный путь.
 */
export interface IntegrationServiceFactoryContext {
  repoPath: string;
  worktreeRoot: string;
  integrationRunId: string;
  /** Runtime command that applies terminal Run failure only after durable stop proof. */
  finalizeRunFailure(runId: string, error: unknown): boolean;
  taskId?: string;
  epicId: string;
}
export type IntegrationServiceFactory = (context: IntegrationServiceFactoryContext) => IntegrationService;
export interface EpicOrchestratorOptions {
  integrationServiceFactory?: IntegrationServiceFactory;
  integrationWorktreeRoot?: string;
  taskWorkspaceProvisioner?: { provisionForEpic(epicId: string): Promise<void> };
  epicWorkspaceProvisioner?: { provisionForEpic(epicId: string): Promise<{ path: string }> };
  git?: Pick<GitCli, "run">;
}
type Stage = "CHILDREN" | "EPIC_REVIEW" | "ARCHITECTURE_REVIEW" | "EPIC_QA" | "INTEGRATION" | "FINAL_APPROVAL" | "DONE";
type Child = { id: string; display_id: string; status: string };
const EPIC_PLAN_INPUT_UNAVAILABLE = "EPIC_PLAN_INPUT_UNAVAILABLE";
const EPIC_ORCHESTRATION_STAGES: ReadonlySet<string> = new Set(["CHILDREN", "EPIC_REVIEW", "ARCHITECTURE_REVIEW", "EPIC_QA", "INTEGRATION", "FINAL_APPROVAL", "DONE"]);

/** Маркер сообщает верхнему workflow, что нельзя записывать recovery failure до доказательства остановки Run. */
class EpicRunStopUnprovenError extends Error {
  constructor(cause: unknown) {
    super("EPIC_RUN_STOP_UNPROVEN", { cause });
    this.name = "EpicRunStopUnprovenError";
  }
}

function parseIntegrationPromptContract(value: string, id: string, fallbackGoal: string): TaskContract {
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; } catch { throw new Error("EPIC_INTEGRATION_CONTRACT_INVALID"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("EPIC_INTEGRATION_CONTRACT_INVALID");
  const source = parsed as Record<string, unknown>;
  const stringField = (key: string, fallback: string): string => {
    const field = source[key];
    if (field === undefined) return fallback;
    if (typeof field !== "string") throw new Error("EPIC_INTEGRATION_CONTRACT_INVALID");
    return field;
  };
  const stringArrayField = (key: string): string[] => {
    const field = source[key];
    if (field === undefined) return [];
    if (!Array.isArray(field) || !field.every((item) => typeof item === "string")) throw new Error("EPIC_INTEGRATION_CONTRACT_INVALID");
    return field;
  };
  const priority = source.priority;
  return {
    id,
    priority: priority === "p0" || priority === "p1" || priority === "p2" || priority === "p3" ? priority : "p2",
    goal: stringField("goal", fallbackGoal),
    context: stringField("context", ""),
    requirements: stringArrayField("requirements"),
    acceptanceCriteria: stringArrayField("acceptanceCriteria"),
    dependencies: stringArrayField("dependencies"),
    nonGoals: stringArrayField("nonGoals"),
    definitionOfDone: stringArrayField("definitionOfDone"),
  };
}

function parseEpicStartInput(value: string, projectId: string): EpicStartInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    const input = parsed as Partial<EpicStartInput>;
    if (input.projectId !== projectId || !Array.isArray(input.tasks)) throw new Error();
    if (input.requestedBy !== undefined && typeof input.requestedBy !== "string") throw new Error();
    if (input.architectureChange !== undefined && typeof input.architectureChange !== "boolean") throw new Error();
    for (const flag of [input.includeProductManager, input.includeArchitect, input.architectureReviewRequired, input.architecture_review_required]) {
      if (flag !== undefined && typeof flag !== "boolean") throw new Error();
    }
    if (input.epic !== undefined && (!input.epic || typeof input.epic !== "object" || Array.isArray(input.epic) || typeof input.epic.title !== "string")) throw new Error();
    for (const task of input.tasks) {
      if (!task || typeof task !== "object" || Array.isArray(task) || typeof task.ref !== "string" || typeof task.title !== "string"
        || typeof task.role !== "string" || typeof task.workflow !== "string" || !Array.isArray(task.acceptanceCriteria)
        || !task.acceptanceCriteria.every((criterion) => typeof criterion === "string")) throw new Error();
      if (task.goal !== undefined && typeof task.goal !== "string") throw new Error();
      if (task.context !== undefined && typeof task.context !== "string") throw new Error();
      if (task.optional !== undefined && typeof task.optional !== "boolean") throw new Error();
      if (task.requirements !== undefined && (!Array.isArray(task.requirements) || !task.requirements.every((requirement) => typeof requirement === "string"))) throw new Error();
      if (task.dependsOn !== undefined && (!Array.isArray(task.dependsOn) || !task.dependsOn.every((dependency) => typeof dependency === "string"))) throw new Error();
    }
    validatePlan(input as PlanningPlanInput);
  } catch {
    throw new Error("EPIC_RECOVERY_CHECKPOINT_INVALID");
  }
  return parsed as EpicStartInput;
}

function parseSequence(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) throw new Error();
    return parsed;
  } catch {
    throw new Error("EPIC_RECOVERY_CHECKPOINT_INVALID");
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Owns Объект fixed lifecycle. Все checkpoints являются persisted перед returning. */
type EpicMergeAuthority = Pick<MergeService, "mergeApproved"> & Partial<Pick<MergeService, "mergeApprovedForIntegration">>;

/**
 * Предоставляет публичный контракт модуля epic-orchestrator для взаимодействия слоёв приложения.
 */
export class EpicOrchestrator {
  private readonly handlers: RuntimeEventHandlers;
  private readonly approvals: ApprovalService;
  private readonly scheduler: SchedulerService;
  private readonly runs: RunService;
  private readonly integrationServiceFactory: IntegrationServiceFactory | undefined;
  private readonly integrationWorktreeRoot: string | undefined;
  private readonly taskWorkspaceProvisioner: EpicOrchestratorOptions["taskWorkspaceProvisioner"];
  private readonly epicWorkspaceProvisioner: EpicOrchestratorOptions["epicWorkspaceProvisioner"];
  private readonly git: Pick<GitCli, "run">;

  constructor(
    private readonly db: Database,
    private readonly workflow: WorkflowEngine,
    private readonly planning: PlanningService,
    runs: RunService,
    private readonly mergeService: EpicMergeAuthority,
    scheduler: SchedulerService,
    options: EpicOrchestratorOptions = {},
  ) {
    this.handlers = new RuntimeEventHandlers(db, workflow, scheduler);
    this.approvals = new ApprovalService(db);
    this.scheduler = scheduler;
    this.runs = runs;
    this.integrationServiceFactory = options.integrationServiceFactory;
    this.integrationWorktreeRoot = options.integrationWorktreeRoot;
    this.taskWorkspaceProvisioner = options.taskWorkspaceProvisioner;
    this.epicWorkspaceProvisioner = options.epicWorkspaceProvisioner;
    this.git = options.git ?? new GitCli();
    // Reservation reconciliation runs in the startup lifecycle after process-owner preflight.
  }

  async start(input: EpicStartInput): Promise<PlanningPlan> {
    const planInput: PlanningPlanInput = { projectId: input.projectId, tasks: input.tasks, architectureChange: input.architectureChange ?? input.includeArchitect ?? false };
    if (input.requestedBy !== undefined) planInput.requestedBy = input.requestedBy;
    if (input.epic !== undefined) planInput.epic = input.epic;
    return this.planning.preparePlan({ ...planInput, includeProductManager: input.includeProductManager, includeArchitect: input.includeArchitect, architectureReviewRequired: input.architectureReviewRequired, architecture_review_required: input.architecture_review_required } as EpicStartInput);
  }

  async approveAndRun(planId: string, actor: string, requestId?: string): Promise<EpicRunResult> {
    const row = this.db.get<{ project_id: string; plan_json: string; status: string }>("SELECT project_id, plan_json, status FROM planning_plans WHERE id=$id", { id: planId });
    if (!row) throw new Error(`Epic plan ${planId} not found`);
    if (requestId !== undefined) {
      const linked = this.db.get<{ status: string; classification: string | null; failure_code: string | null }>(
        "SELECT status,classification,failure_code FROM planning_requests WHERE id=$requestId AND project_id=$projectId AND plan_id=$planId",
        { requestId, projectId: row.project_id, planId },
      );
      const expectedStatus = row.status === "PENDING" ? "PLAN_PENDING_APPROVAL" : "MATERIALIZED";
      const retryingRecoveryFailure = row.status === "APPROVED" && linked?.status === "FAILED" && linked.failure_code === EPIC_RECOVERY_FAILURE_CODE;
      if (!linked || linked.classification !== "EPIC" || (linked.status !== expectedStatus && !retryingRecoveryFailure)) throw new Error("Planning request does not own this Epic plan");
    }
    // A not-yet-approved plan must not materialize while its project is blocked.
    // For an already-approved plan, check only after acquiring the durable claim
    // so a startup recovery failure is recorded as a visible blocker.
    if (row.status === "PENDING") this.scheduler.assertProjectDispatchable(row.project_id);
    const input = row.status === "PENDING"
      ? parseEpicStartInput(row.plan_json, row.project_id)
      : (() => { try { return parseEpicStartInput(row.plan_json, row.project_id); } catch { return undefined; } })();
    if (row.status === "PENDING") this.planning.approvePlan(planId, actor, requestId);
    const epic = this.db.get<{ id: string }>("SELECT epic_id AS id FROM planning_plans WHERE id=$planId AND epic_id IS NOT NULL", { planId });
    if (!epic) throw new Error("Approved Epic plan did not materialize an Epic");
    const executionToken = this.claimExecution(epic.id, planId, input);
    if (!executionToken) throw new Error("EPIC_ORCHESTRATION_ALREADY_RUNNING");
    let releaseExecutionClaim = true;
    try {
      if (!input) throw new Error("EPIC_RECOVERY_CHECKPOINT_INVALID");
      const persisted = this.db.get<{ input_json: string }>("SELECT input_json FROM epic_orchestrations WHERE epic_id=$epicId AND plan_id=$planId", { epicId: epic.id, planId });
      if (!persisted || persisted.input_json === EPIC_PLAN_INPUT_UNAVAILABLE) throw new Error("EPIC_RECOVERY_CHECKPOINT_INVALID");
      const checkpointInput = parseEpicStartInput(persisted.input_json, row.project_id);
      if (stableJson(checkpointInput) !== stableJson(input)) throw new Error("EPIC_RECOVERY_CHECKPOINT_INVALID");
      this.validateExecutionCheckpoint(epic.id);
      this.scheduler.assertProjectDispatchable(row.project_id);
      if (!this.epicWorkspaceProvisioner || !this.taskWorkspaceProvisioner) throw new Error("EPIC_WORKSPACE_PROVISIONING_UNAVAILABLE");
      await this.epicWorkspaceProvisioner.provisionForEpic(epic.id);
      await this.taskWorkspaceProvisioner.provisionForEpic(epic.id);
      const result = await this.execute(epic.id, checkpointInput);
      this.clearRecoveryFailure(planId);
      return result;
    } catch (error) {
      if (error instanceof EpicRunStopUnprovenError) releaseExecutionClaim = false;
      else this.markRecoveryFailure(planId);
      throw error;
    } finally {
      if (releaseExecutionClaim) this.releaseExecution(epic.id, executionToken);
    }
  }

  /** Снимает оставшийся claim только после run reconciliation при старте нового процесса. */
  reconcileInterruptedExecutionClaims(): number {
    return this.db.transaction((tx) => {
      tx.run("UPDATE epic_orchestrations SET execution_token=NULL,execution_started_at=NULL WHERE execution_token IS NOT NULL");
      return tx.get<{ changes: number }>("SELECT changes() AS changes")?.changes ?? 0;
    });
  }

  /** Возобновляет одобренные Epic по сохранённым ID до перехода сервера в READY. */
  async resumeApprovedEpics(): Promise<void> {
    const rows = this.db.all<{ id: string }>(
      `SELECT p.id
         FROM planning_plans p
         LEFT JOIN epic_orchestrations o ON o.plan_id=p.id AND o.epic_id=p.epic_id
        WHERE p.status='APPROVED' AND p.epic_id IS NOT NULL
          AND (o.recovery_failure_code IS NOT NULL OR o.epic_id IS NULL OR o.stage NOT IN ('FINAL_APPROVAL','DONE')
               OR (o.stage='FINAL_APPROVAL' AND o.final_approval_id IS NULL))
        ORDER BY p.created_at,p.id`,
    );
    for (const row of rows) await this.approveAndRun(row.id, "recovery");
  }

  approveFinalMerge(epicId: string, approvalId?: string): EpicRunResult {
    void epicId; void approvalId;
    throw new Error("Final Epic approval must execute MergeService; call approveFinalMergeAsync");
  }

  /** Execute Объект real MergeService и только then atomically release children. */
  async approveFinalMergeAsync(epicId: string, approvalId: string): Promise<EpicRunResult> {
    const persisted = this.db.get<{ stage: string; final_approval_id: string | null }>("SELECT stage,final_approval_id FROM epic_orchestrations WHERE epic_id=$epicId", { epicId });
    if (!persisted || persisted.final_approval_id !== approvalId) throw new Error(`Approval ${approvalId} is not the persisted final approval for Epic ${epicId}`);
    if (persisted.stage !== "FINAL_APPROVAL") throw new Error(`Epic ${epicId} is not waiting for final approval`);
    const integrationRun = this.db.get<{ agent_run_id: string }>(
      `SELECT pr.agent_run_id FROM orchestration_phase_runs pr
         JOIN agent_runs ar ON ar.id=pr.agent_run_id
        WHERE pr.epic_id=$epicId AND pr.task_id IS NULL AND lower(pr.phase)='integration'
          AND lower(pr.role)='integration' AND pr.status='COMPLETED' AND pr.validated=1
          AND ar.epic_id=$epicId AND lower(ar.role)='integration' AND ar.status='COMPLETED'
        ORDER BY pr.ended_at DESC,pr.created_at DESC,pr.id DESC LIMIT 1`, { epicId });
    if (!integrationRun) throw new Error(`Epic ${epicId} has no validated Integration AgentRun`);
    const expectedGit = this.resolvePersistedIntegrationGit(epicId, undefined);
    const provenances = this.db.all<{ integration_run_id: string; repository_path: string; source_branch: string; source_sha: string; expected_target_sha: string; target_branch: string }>(
      "SELECT integration_run_id,repository_path,source_branch,source_sha,expected_target_sha,target_branch FROM integration_attempts WHERE integration_run_id=$runId AND status='MERGED'",
      { runId: integrationRun.agent_run_id });
    const provenance = provenances.length === 1 ? provenances[0] : undefined;
    if (!provenance || provenance.integration_run_id !== integrationRun.agent_run_id ||
        provenance.repository_path !== expectedGit.repoPath || provenance.source_branch !== expectedGit.sourceBranch ||
        provenance.target_branch !== expectedGit.targetBranch || !provenance.source_sha || !provenance.expected_target_sha) {
      throw new Error(`Epic ${epicId} has no exact verified Integration provenance`);
    }
    if (!this.mergeService.mergeApprovedForIntegration) throw new Error("MergeService must expose the provenance-bound Epic merge authority");
    const merge = await this.mergeService.mergeApprovedForIntegration(epicId, approvalId, integrationRun.agent_run_id) as MergeResult;
    if (!merge || merge.success !== true || merge.verifiedCompletion !== true || !merge.resultingTargetSha || merge.targetBranch !== provenance.target_branch) {
      throw new Error(`MergeService did not return a VERIFIED result for Epic ${epicId}`);
    }
    this.handlers.handleEpicMergeCompleted(epicId, approvalId);
    return this.result(epicId);
  }

  private async execute(epicId: string, input: EpicStartInput): Promise<EpicRunResult> {
    const project = this.db.get<{ project_id: string }>("SELECT project_id FROM epics WHERE id=$epicId", { epicId });
    if (!project) throw new Error(`Epic ${epicId} not found`);
    const epic = this.db.get<{ display_id: string }>("SELECT display_id FROM epics WHERE id=$epicId", { epicId });
    if (!epic) throw new Error(`Epic ${epicId} not found`);
    this.scheduler.assertProjectDispatchable(project.project_id);
    this.validateExecutionCheckpoint(epicId);
    this.db.run("UPDATE epics SET status='IN_PROGRESS', updated_at=$updatedAt WHERE id=$epicId AND status='OPEN'", { epicId, updatedAt: new Date().toISOString() });
    const row = () => this.db.get<{ stage: Stage; sequence_json: string; architecture_review_authorized: number; final_approval_id: string | null }>("SELECT stage,sequence_json,architecture_review_authorized,final_approval_id FROM epic_orchestrations WHERE epic_id=$epicId", { epicId })!;
    const add = (name: string) => { const r = row(); const sequence = parseSequence(r.sequence_json); if (!sequence.includes(name)) sequence.push(name); this.db.run("UPDATE epic_orchestrations SET sequence_json=$sequence,updated_at=$at WHERE epic_id=$epicId", { epicId, sequence: JSON.stringify(sequence), at: new Date().toISOString() }); };
    const checkpoint = (stage: Stage) => this.db.run("UPDATE epic_orchestrations SET stage=$stage,updated_at=$at WHERE epic_id=$epicId", { epicId, stage, at: new Date().toISOString() });
    let state = row();
    const sequence = parseSequence(state.sequence_json);
    let architectureProposalAccepted = false;
    if (!this.hasPhase(epicId, undefined, "plan")) {
      await this.runPhase(epicId, undefined, "plan", "coordinator", { phase: "plan", role: "coordinator", epicId }); add("plan");
    }
    const productManagerCompleted = this.hasPhase(epicId, undefined, "pm");
    if (input.includeProductManager && (!sequence.includes("pm") || !productManagerCompleted)) {
      await this.runPhase(epicId, undefined, "pm", "product_manager", { phase: "pm", role: "product_manager", epicId }); add("pm");
    }
    const architectCompleted = this.hasPhase(epicId, undefined, "architect");
    if (input.includeArchitect && (!sequence.includes("architect") || !architectCompleted)) {
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
      let hasFailure = false;
      let firstFailure: unknown;
      await Promise.allSettled(runnable.map(async (task) => {
        try {
          await this.runChild(task, epicId, `epic/${displayId}`);
        } catch (error) {
          if (!hasFailure) {
            hasFailure = true;
            firstFailure = error;
          }
          throw error;
        }
      }));
      if (hasFailure) throw firstFailure;
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
    const project = this.db.get<{ project_id: string }>("SELECT project_id FROM epics WHERE id=$epicId", { epicId });
    if (!project) throw new Error(`Epic ${epicId} project not found`);
    this.scheduler.assertProjectDispatchable(project.project_id);
    if (task.status === "INTEGRATED_INTO_EPIC" || task.status === "RELEASED") return;
    if (task.status === "DRAFT") this.workflow.transition(task.id, "READY");
    let result: EpicAgentResult;
    let evidencePhase = "child_task";
    const current = this.workflow.currentStage(task.id);
    if (current === "READY") {
       result = await this.runPhase(epicId, task.id, "child_task", "developer", { phase: "child_task", role: "developer", taskId: task.id, epicId, targetBranch: branch });
    } else if (current === "DEVELOPMENT") {
      // DEVELOPMENT is a durable in-flight checkpoint after process restart.
      evidencePhase = "child_task_reconcile";
      result = await this.runPhase(epicId, task.id, evidencePhase, "developer", { phase: evidencePhase, role: "developer", taskId: task.id, epicId, targetBranch: branch });
    } else {
      evidencePhase = this.hasPhase(epicId, task.id, "child_task") ? "child_task" : "child_task_reconcile";
      result = this.loadPhaseResult(epicId, task.id, evidencePhase);
    }
    this.requirePersistedEvidence(epicId, task.id, evidencePhase, result);
    const stage = this.workflow.currentStage(task.id);
    if (stage === "DEVELOPMENT") this.workflow.transition(task.id, "REVIEW");
    if (this.workflow.currentStage(task.id) === "REVIEW") {
      const review = await this.runPhase(epicId, task.id, "review", "reviewer", { phase: "review", role: "reviewer", taskId: task.id, epicId, targetBranch: branch });
      this.requirePersistedEvidence(epicId, task.id, "review", review);
      this.workflow.transition(task.id, "QA", { hasReviewPassed: true, hasSuccessfulIntegration: false, hasFinalMergeApproval: false, parentEpicReleased: false });
    }
    if (this.workflow.currentStage(task.id) === "QA") {
      const qa = await this.runPhase(epicId, task.id, "qa", "qa", { phase: "qa", role: "qa", taskId: task.id, epicId, targetBranch: branch });
      this.requirePersistedEvidence(epicId, task.id, "qa", qa);
      this.workflow.transition(task.id, "READY_FOR_INTEGRATION");
    }
    if (this.workflow.currentStage(task.id) === "READY_FOR_INTEGRATION") this.workflow.transition(task.id, "INTEGRATION");
    if (this.workflow.currentStage(task.id) === "INTEGRATION") {
      const integration = await this.runPhase(epicId, task.id, "integration", "integration", { phase: "integration", role: "integration", taskId: task.id, epicId, targetBranch: branch });
      this.requirePersistedEvidence(epicId, task.id, "integration", integration);
      this.workflow.transition(task.id, "INTEGRATED_INTO_EPIC", { hasReviewPassed: true, hasSuccessfulIntegration: true, hasFinalMergeApproval: false, parentEpicReleased: false });
    }
    this.scheduler.releaseTask(task.id);
  }
  private result(epicId: string): EpicRunResult {
    const state = this.db.get<{ sequence_json: string; stage: Stage; final_approval_id: string | null }>("SELECT sequence_json,stage,final_approval_id FROM epic_orchestrations WHERE epic_id=$epicId", { epicId });
    if (!state) throw new Error(`Epic ${epicId} has no persisted orchestration`);
    const result: EpicRunResult = { epicId, sequence: JSON.parse(state.sequence_json) as string[], childStatuses: this.db.all<{ status: string }>("SELECT status FROM tasks WHERE epic_id=$epicId ORDER BY display_id", { epicId }).map((r) => r.status), finalApprovalRequired: true, pendingFinalApproval: state.stage !== "DONE" };
    if (state.final_approval_id) result.finalApprovalId = state.final_approval_id;
    return result;
  }

  private claimExecution(epicId: string, planId: string, input: EpicStartInput | undefined): string | undefined {
    const token = crypto.randomUUID();
    return this.db.transaction((tx) => {
      const now = new Date().toISOString();
      const existing = tx.get<{ plan_id: string; input_json: string }>("SELECT plan_id,input_json FROM epic_orchestrations WHERE epic_id=$epicId", { epicId });
      if (existing && existing.plan_id !== planId) throw new Error("Epic orchestration is bound to another plan");
      if (!existing) {
        tx.run("INSERT INTO epic_orchestrations(epic_id,plan_id,input_json,stage,sequence_json,created_at,updated_at) VALUES($epicId,$planId,$input,'CHILDREN',$sequence,$now,$now)", {
          epicId, planId, input: input ? JSON.stringify(input) : EPIC_PLAN_INPUT_UNAVAILABLE, sequence: JSON.stringify(["plan"]), now,
        });
      } else if (input && existing.input_json === EPIC_PLAN_INPUT_UNAVAILABLE) {
        // Только фиксированный локальный marker от malformed approved plan может быть заменён
        // новым валидным input из authoritative approved plan при последующем retry.
        tx.run("UPDATE epic_orchestrations SET input_json=$input,updated_at=$now WHERE epic_id=$epicId AND plan_id=$planId AND input_json=$marker", {
          epicId, planId, input: JSON.stringify(input), marker: EPIC_PLAN_INPUT_UNAVAILABLE, now,
        });
      }
      tx.run("UPDATE epic_orchestrations SET execution_token=$token,execution_started_at=$now,updated_at=$now WHERE epic_id=$epicId AND plan_id=$planId AND execution_token IS NULL", { epicId, planId, token, now });
      if (tx.get<{ changes: number }>("SELECT changes() AS changes")?.changes !== 1) return undefined;
      return token;
    });
  }

  private releaseExecution(epicId: string, token: string): void {
    this.db.run("UPDATE epic_orchestrations SET execution_token=NULL,execution_started_at=NULL WHERE epic_id=$epicId AND execution_token=$token", { epicId, token });
  }

  private validateExecutionCheckpoint(epicId: string): void {
    const checkpoint = this.db.get<{ stage: string; sequence_json: string }>("SELECT stage,sequence_json FROM epic_orchestrations WHERE epic_id=$epicId", { epicId });
    if (!checkpoint || !EPIC_ORCHESTRATION_STAGES.has(checkpoint.stage)) throw new Error("EPIC_RECOVERY_CHECKPOINT_INVALID");
    parseSequence(checkpoint.sequence_json);
  }

  /** Сохраняет только фиксированный failure code и переводит связанный request в видимое FAILED. */
  private markRecoveryFailure(planId: string): void {
    this.db.transaction((tx) => {
      const now = new Date().toISOString();
      tx.run("UPDATE epic_orchestrations SET recovery_failure_code=$code,recovery_failed_at=$now,updated_at=$now WHERE plan_id=$planId", { planId, code: EPIC_RECOVERY_FAILURE_CODE, now });
      tx.run("UPDATE planning_requests SET status='FAILED',failure_code=$code,updated_at=$now WHERE plan_id=$planId AND (status='MATERIALIZED' OR (status='FAILED' AND failure_code=$code))", { planId, code: EPIC_RECOVERY_FAILURE_CODE, now });
    });
  }

  /** Убирает blocker только после успешного полного resume до следующего human gate. */
  private clearRecoveryFailure(planId: string): void {
    this.db.transaction((tx) => {
      const now = new Date().toISOString();
      tx.run("UPDATE epic_orchestrations SET recovery_failure_code=NULL,recovery_failed_at=NULL,updated_at=$now WHERE plan_id=$planId AND recovery_failure_code=$code", { planId, code: EPIC_RECOVERY_FAILURE_CODE, now });
      tx.run("UPDATE planning_requests SET status='MATERIALIZED',failure_code=NULL,updated_at=$now WHERE plan_id=$planId AND status='FAILED' AND failure_code=$code", { planId, code: EPIC_RECOVERY_FAILURE_CODE, now });
    });
  }

  private async runPhase(epicId: string, taskId: string | undefined, phase: string, role: string, request: EpicAgentRequest): Promise<EpicAgentResult> {
    const existing = this.db.get<{ id: string; agent_run_id: string; result_json: string; validated: number; status: string }>("SELECT id,agent_run_id,result_json,validated,status FROM orchestration_phase_runs WHERE epic_id=$epicId AND task_id IS $taskId AND phase=$phase", { epicId, taskId: taskId ?? null, phase });
    if (existing) {
      if (existing.validated === 1 && existing.status === "COMPLETED") return JSON.parse(existing.result_json) as EpicAgentResult;
      this.assertRetryableFailedPhase(this.db, existing, taskId);
    }
    const project = this.db.get<{ project_id: string }>("SELECT project_id FROM epics WHERE id=$epicId", { epicId });
    if (!project) throw new Error(`Epic ${epicId} project not found`);
    this.scheduler.assertProjectDispatchable(project.project_id);
    // Intent является Объект idempotency boundary.  Объект runtime является never started перед
    // этот row и its AgentRun exist durably.
    const agentRunId = crypto.randomUUID();
    const phaseId = crypto.randomUUID();
    const activePhaseId = existing?.id ?? phaseId;
    const now = new Date().toISOString();
    this.db.transaction((tx) => {
      const current = tx.get<{ id: string; agent_run_id: string; result_json: string; validated: number; status: string }>("SELECT id,agent_run_id,result_json,validated,status FROM orchestration_phase_runs WHERE epic_id=$epicId AND task_id IS $taskId AND phase=$phase", { epicId, taskId: taskId ?? null, phase });
      if (existing) {
        if (!current || current.id !== existing.id || current.agent_run_id !== existing.agent_run_id) throw new Error("Persisted Epic phase changed before retry");
        this.assertRetryableFailedPhase(tx, current, taskId);
        tx.run("UPDATE orchestration_phase_runs SET agent_run_id=$run,result_json='{}',evidence_json='{}',validated=0,status='RUNNING',request_json=$request,started_at=$at,ended_at=NULL WHERE id=$id AND agent_run_id=$oldRun AND status='FAILED' AND validated=0", { id: existing.id, oldRun: existing.agent_run_id, run: agentRunId, request: JSON.stringify(request), at: now });
        if (tx.get<{ changes: number }>("SELECT changes() AS changes")?.changes !== 1) throw new Error("Persisted Epic phase changed before retry");
      } else {
        if (current) throw new Error("Persisted Epic phase was claimed concurrently");
        tx.run("INSERT INTO orchestration_phase_runs(id,epic_id,task_id,phase,role,agent_run_id,result_json,evidence_json,validated,status,request_json,created_at) VALUES($id,$epicId,$taskId,$phase,$role,$run,'{}','{}',0,'INTENT',$request,$at)", { id: phaseId, epicId, taskId: taskId ?? null, phase, role, run: agentRunId, request: JSON.stringify(request), at: now });
      }
    });
    let integration: { service: IntegrationService; attempt: IntegrationAttempt } | undefined;
    try {
      if (phase === "integration" && !this.integrationServiceFactory) throw new Error("EPIC_INTEGRATION_SERVICE_UNAVAILABLE");
      if (phase === "integration" && this.integrationServiceFactory) {
        if (!this.integrationWorktreeRoot) throw new Error("Integration worktree root is not configured");
        const git = this.resolvePersistedIntegrationGit(epicId, taskId);
        const service = this.integrationServiceFactory({
          repoPath: git.repoPath,
          worktreeRoot: this.integrationWorktreeRoot,
          integrationRunId: agentRunId,
          finalizeRunFailure: (runId, error) => this.runs.failPreparedRun(runId, error),
          ...(taskId ? { taskId } : {}),
          epicId,
        });
        const attempt = await service.prepareIntegration(git.sourceBranch, git.targetBranch, git.repoPath);
        integration = { service, attempt };
      }
      const capabilityWorkspace = integration?.attempt.worktreePath ?? await this.provisionedWorkspace(epicId, taskId);
      let runPrompt = JSON.stringify(request);
      let roleInputs: unknown;
      let workspaceIdentity: { repository: string | null; workspace: string | null; worktree: string | null };
      let targetHead: string;
      let targetBranch: string;
      if (integration) {
        const expectedTargetSha = integration.attempt.expectedTargetSha;
        if (!expectedTargetSha) throw new Error("EPIC_INTEGRATION_TARGET_SHA_UNAVAILABLE");
        if (!integration.attempt.provenanceDatabasePath) throw new Error("EPIC_INTEGRATION_PROVENANCE_PATH_UNAVAILABLE");
        targetHead = expectedTargetSha;
        targetBranch = integration.attempt.currentTargetBranch;
        workspaceIdentity = {
          repository: integration.attempt.repoPath,
          workspace: integration.attempt.worktreePath,
          worktree: integration.attempt.id,
        };
        roleInputs = {
          sourceSha: integration.attempt.sourceSha,
          targetSha: expectedTargetSha,
          attemptId: integration.attempt.id,
          provenanceDatabasePath: integration.attempt.provenanceDatabasePath,
        };
        runPrompt = promptBuilder.buildIntegrationPrompt({
            taskContract: this.integrationPromptContract(epicId, taskId),
            workspace: integration.attempt.worktreePath,
            targetRef: integration.attempt.currentTargetBranch,
            expectedTargetSha,
            sourceSha: integration.attempt.sourceSha,
            integrationAttemptId: integration.attempt.id,
            ...(integration.attempt.provenanceDatabasePath ? { provenanceDatabasePath: integration.attempt.provenanceDatabasePath } : {}),
        });
      } else {
        const worktreeId = taskId ?? `epic:${epicId}`;
        const worktree = this.db.get<{ id: string; repo_path: string; path: string; branch: string; removed_at: string | null }>(
          "SELECT id,repo_path,path,branch,removed_at FROM worktrees WHERE id=$id", { id: worktreeId },
        );
        if (!worktree || worktree.removed_at !== null || worktree.path !== capabilityWorkspace) throw new Error("EPIC_WORKSPACE_IDENTITY_UNAVAILABLE");
        targetHead = (await this.git.run(capabilityWorkspace, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"])).stdout.trim();
        targetBranch = (await this.git.run(capabilityWorkspace, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim();
        if (!/^[a-f0-9]{40}$/i.test(targetHead) || targetBranch !== worktree.branch) throw new Error("EPIC_WORKSPACE_SNAPSHOT_UNAVAILABLE");
        workspaceIdentity = { repository: worktree.repo_path, workspace: worktree.path, worktree: worktree.id };
        if (role.toLowerCase() === "developer") runPrompt = taskDeveloperPrompt();
        if (role.toLowerCase() === "reviewer") {
          const persistedGit = this.resolvePersistedIntegrationGit(epicId, taskId);
          assertSafeGitRef(persistedGit.targetBranch);
          const gitDiff = (await this.git.run(capabilityWorkspace, [
            "diff", "--no-ext-diff", "--no-textconv", `${persistedGit.targetBranch}...HEAD`, "--",
          ])).stdout;
          roleInputs = { gitDiff, checks: [] };
          runPrompt = taskReviewerPrompt();
        }
        if (role.toLowerCase() === "qa") {
          roleInputs = { environment: `Managed worktree branch ${targetBranch} at target SHA ${targetHead} on ${process.platform}.` };
          runPrompt = taskQaPrompt();
        }
      }
      const runOptions = {
        runId: agentRunId, role, model: "persisted", taskId: taskId ?? null, epicId,
        triggerReason: `epic-${phase}`, contextVersion: "1", outputSchemaVersion: "1",
        prompt: runPrompt,
        capability: { workspace: capabilityWorkspace },
      } as const;
      this.runs.prepareRun({
        ...runOptions,
        contextInput: createRunContextInput(runOptions, {
          prompt: runPrompt,
          ...(roleInputs !== undefined ? { roleInputs } : {}),
          workspaceIdentity,
          targetHead,
          targetBranch,
        }),
      });
      this.db.run("UPDATE orchestration_phase_runs SET status='RUNNING',started_at=$at WHERE id=$id AND status='INTENT'", { id: activePhaseId, at: now });
      let execution: Awaited<ReturnType<RunService["executePreparedRun"]>>;
      if (integration) {
        const bound = integration.service.bindIntegrationRun(integration.attempt, agentRunId);
        await integration.service.mergePreparedSource(bound);
        const projectId = this.db.get<{ project_id: string }>("SELECT project_id FROM epics WHERE id=$epicId", { epicId })?.project_id;
        if (!projectId) throw new Error(`Epic ${epicId} project not found`);
        this.scheduler.dispatchAgentRun(agentRunId, projectId, role, "persisted");
        execution = await integration.service.runInIntegrationWorktree(bound, async () => this.runs.executePreparedRun(agentRunId));
      } else if (taskId && this.workflow.currentStage(taskId) === "READY") {
        this.scheduler.dispatchTask(taskId, this.workflow, () => undefined, { triggerReason: `epic-${phase}`, role, model: "persisted", runId: agentRunId });
        execution = await this.runs.executePreparedRun(agentRunId);
      }
      else {
        const projectId = this.db.get<{ project_id: string }>("SELECT project_id FROM epics WHERE id=$epicId", { epicId })?.project_id;
        if (!projectId) throw new Error(`Epic ${epicId} project not found`);
        this.scheduler.dispatchAgentRun(agentRunId, projectId, role, "persisted");
        execution = await this.runs.executePreparedRun(agentRunId);
      }
      const result: EpicAgentResult = {
        accepted: true,
        output: JSON.parse(execution.outcome.output),
        usage: { cost: execution.run.cost ?? 0 },
      };
      return this.persistedPhase(epicId, taskId, phase, role, result, agentRunId, activePhaseId);
      } catch (error) {
      if (!this.runs.failPreparedRun(agentRunId, error)) throw new EpicRunStopUnprovenError(error);
      this.db.transaction((tx) => {
        tx.run("UPDATE orchestration_phase_runs SET status='FAILED',ended_at=$at WHERE id=$id AND status IN ('INTENT','RUNNING')", { id: activePhaseId, at: new Date().toISOString() });
      });
      this.scheduler.releaseAgentRun(agentRunId, 0);
      throw error;
    }
  }

  private assertRetryableFailedPhase(
    database: Pick<DatabaseTx, "get">,
    phase: { agent_run_id: string; validated: number; status: string },
    taskId: string | undefined,
  ): void {
    if (phase.status !== "FAILED" || phase.validated !== 0) throw new Error("Persisted Epic phase is not safely retryable");
    const run = database.get<{ status: string }>("SELECT status FROM agent_runs WHERE id=$id", { id: phase.agent_run_id });
    if (!run || !["COMPLETED", "FAILED", "CANCELLED"].includes(run.status)) throw new Error("Persisted Epic phase is not safely retryable");
    const reservation = database.get<{ id: string }>(
      `SELECT id FROM scheduler_reservations
        WHERE status='RESERVED'
          AND (run_id=$runId OR subject_id=$runId OR ($taskId IS NOT NULL AND subject_id=$taskId))
        LIMIT 1`,
      { runId: phase.agent_run_id, taskId: taskId ?? null },
    );
    if (reservation) throw new Error("Persisted Epic phase is not safely retryable");
    const lock = database.get<{ resource_key: string }>(
      "SELECT resource_key FROM scheduler_resource_locks WHERE resource_key=$runKey OR ($taskKey IS NOT NULL AND resource_key=$taskKey) LIMIT 1",
      { runKey: `run:${phase.agent_run_id}`, taskKey: taskId ? `task:${taskId}` : null },
    );
    if (lock) throw new Error("Persisted Epic phase is not safely retryable");
  }

  private async provisionedWorkspace(epicId: string, taskId: string | undefined): Promise<string> {
    if (taskId) {
      const worktree = this.db.get<{ path: string; branch: string; removed_at: string | null }>(
        "SELECT path,branch,removed_at FROM worktrees WHERE id=$id AND branch=$branch AND removed_at IS NULL",
        { id: taskId, branch: `task/${taskId}` },
      );
      if (!worktree || worktree.removed_at !== null) throw new Error("TASK_WORKSPACE_NOT_PROVISIONED");
      return worktree.path;
    }
    if (!this.epicWorkspaceProvisioner) throw new Error("EPIC_WORKSPACE_PROVISIONING_UNAVAILABLE");
    return (await this.epicWorkspaceProvisioner.provisionForEpic(epicId)).path;
  }

  /**
   * Разрешает только persisted Git/onboarding facts для child integration.
   * HTTP запрос/запрос.targetBranch намеренно не участвует в выборе refs.
   */
  private resolvePersistedIntegrationGit(epicId: string, taskId: string | undefined): { repoPath: string; sourceBranch: string; targetBranch: string } {
    const epic = this.db.get<{ id: string; project_id: string; display_id: string }>("SELECT id,project_id,display_id FROM epics WHERE id=$epicId", { epicId });
    if (!epic) throw new Error(`Epic ${epicId} not found`);
    const task = taskId ? this.db.get<{ project_id: string; epic_id: string }>("SELECT project_id,epic_id FROM tasks WHERE id=$taskId AND epic_id=$epicId", { taskId, epicId }) : undefined;
    if (taskId && !task) throw new Error(`Task ${taskId} is not part of Epic ${epicId}`);
    const sourceBranch = taskId ? `task/${taskId}` : `epic/${epic.display_id}`;
    const worktreeId = taskId ?? `epic:${epicId}`;
    const onboarding = this.db.get<{ repository_path: string; facts_json: string; proposed_json: string; status: string }>(
      `SELECT oc.repository_path,oc.facts_json,oc.proposed_json,oc.status
         FROM onboarding_configs oc JOIN approvals a ON a.id=oc.approval_id JOIN projects p ON p.id=oc.project_id
        WHERE oc.project_id=$projectId AND oc.status='ACTIVE'
          AND p.status='ACTIVE'
          AND a.subject_type='PROJECT' AND a.subject_id=oc.project_id
          AND a.type='WORKFLOW_CHANGE' AND a.status='APPROVED'`,
      { projectId: epic.project_id },
    );
    if (!onboarding) throw new Error(`Onboarding for project ${epic.project_id} is not active and approved`);
    let facts: Record<string, unknown> = {};
    let proposed: Record<string, unknown> = {};
    try { facts = onboarding ? JSON.parse(onboarding.facts_json) as Record<string, unknown> : {}; } catch { /* fail closed below */ }
    try { proposed = onboarding ? JSON.parse(onboarding.proposed_json) as Record<string, unknown> : {}; } catch { /* fail closed below */ }
    const baseBranch = typeof proposed.defaultBranch === "string" ? proposed.defaultBranch : typeof facts.defaultBranch === "string" ? facts.defaultBranch : undefined;
    const expectedTarget = taskId ? `epic/${epic.display_id}` : baseBranch;
    if (!expectedTarget) throw new Error(`No persisted target branch configured for Epic ${epicId}`);
    const worktree = this.db.get<{ repo_path: string; path: string; branch: string; removed_at: string | null }>(
      "SELECT repo_path,path,branch,removed_at FROM worktrees WHERE id=$worktreeId", { worktreeId });
    const operation = this.db.get<{ type: string; status: string; repo_path: string; branch_name: string | null; worktree_id: string | null; target_ref: string | null; verified_at: string | null }>(
      "SELECT type,status,repo_path,branch_name,worktree_id,target_ref,verified_at FROM git_operations WHERE worktree_id=$worktreeId ORDER BY created_at DESC,id DESC LIMIT 1",
      { worktreeId });
    if (operation?.target_ref !== expectedTarget) {
      throw new Error(taskId ? "Task Integration must target its parent Epic branch" : "Epic final Integration must target the approved project base branch");
    }
    if (!worktree || worktree.removed_at !== null || worktree.repo_path !== onboarding.repository_path || worktree.branch !== sourceBranch ||
        operation?.type !== "CREATE_WORKTREE" || operation.status !== "VERIFIED" || !operation.verified_at ||
        operation.repo_path !== onboarding.repository_path || operation.branch_name !== sourceBranch ||
        operation.worktree_id !== worktreeId) {
      throw new Error(`Persisted ${taskId ? "task" : "Epic"} worktree journal is not verified for its exact integration target`);
    }
    const repoPath = onboarding.repository_path;
    const targetBranch = expectedTarget;
    return { repoPath, sourceBranch: operation.branch_name, targetBranch };
  }

  private integrationPromptContract(epicId: string, taskId: string | undefined): TaskContract {
    if (taskId) {
      const task = this.db.get<{ display_id: string; title: string; contract_json: string }>(
        "SELECT display_id,title,contract_json FROM tasks WHERE id=$taskId AND epic_id=$epicId", { taskId, epicId });
      if (!task) throw new Error(`Task ${taskId} is not part of Epic ${epicId}`);
      return parseIntegrationPromptContract(task.contract_json, task.display_id, task.title);
    }
    const epic = this.db.get<{ display_id: string; title: string; contract_json: string }>(
      "SELECT display_id,title,contract_json FROM epics WHERE id=$epicId", { epicId });
    if (!epic) throw new Error(`Epic ${epicId} not found`);
    const base = parseIntegrationPromptContract(epic.contract_json, epic.display_id, epic.title);
    const children = this.db.all<{ display_id: string; title: string; contract_json: string }>(
      "SELECT display_id,title,contract_json FROM tasks WHERE epic_id=$epicId ORDER BY display_id,id", { epicId });
    const childContracts = children.map((child) => ({
      child,
      contract: parseIntegrationPromptContract(child.contract_json, child.display_id, child.title),
    }));
    const unique = (values: string[]): string[] => [...new Set(values)];
    return {
      ...base,
      requirements: unique([ ...base.requirements, ...childContracts.flatMap(({ contract }) => contract.requirements) ]),
      acceptanceCriteria: unique([ ...base.acceptanceCriteria, ...childContracts.flatMap(({ contract }) => contract.acceptanceCriteria) ]),
      dependencies: unique([ ...base.dependencies, ...childContracts.flatMap(({ contract }) => contract.dependencies) ]),
      nonGoals: unique([ ...base.nonGoals, ...childContracts.flatMap(({ contract }) => contract.nonGoals) ]),
      definitionOfDone: unique([ ...base.definitionOfDone, ...childContracts.flatMap(({ contract }) => contract.definitionOfDone) ]),
      context: [base.context, ...childContracts.map(({ child, contract }) => [
        `Task ${child.display_id} (${child.title}) goal: ${contract.goal}`,
        contract.context ? `Task context: ${contract.context}` : "",
      ].filter(Boolean).join("\n"))].filter(Boolean).join("\n"),
    };
  }

  private persistedPhase(epicId: string, taskId: string | undefined, phase: string, role: string, result: EpicAgentResult, agentRunId: string, phaseId: string): EpicAgentResult {
    const now = new Date().toISOString();
    const validation = validateRoleOutput(role, result.output);
    if (!validation.valid) throw new Error(`Epic ${role} result rejected: ${validation.error}`);
    const structured = validation.output as { operation?: string; outcome?: string; baseSha?: string; sourceSha?: string; provenance?: string[]; evidence?: string[] } | undefined;
    let integrationAttemptId: string | undefined;
    if (role.toLowerCase() === "integration" && structured?.outcome === "PASS") {
      const attempts = this.db.all<{
        id: string; repository_path: string; source_branch: string; target_branch: string;
        expected_target_sha: string; source_sha: string; worktree_path: string;
        integration_run_id: string; status: string;
      }>(
        `SELECT id,repository_path,source_branch,target_branch,expected_target_sha,source_sha,worktree_path,integration_run_id,status
           FROM integration_attempts WHERE integration_run_id=$runId ORDER BY created_at,id`,
        { runId: agentRunId },
      );
      const run = this.db.get<{ role: string; capability_json: string | null }>(
        "SELECT role,capability_json FROM agent_runs WHERE id=$runId", { runId: agentRunId });
      let capabilityWorkspace: string | undefined;
      try {
        const capability = run?.capability_json ? JSON.parse(run.capability_json) as { workspace?: unknown } : undefined;
        if (typeof capability?.workspace === "string") capabilityWorkspace = capability.workspace;
      } catch { /* fail closed below */ }
      const attempt = attempts.length === 1 ? attempts[0] : undefined;
      if (!attempt || run?.role.toLowerCase() !== "integration" || attempt.integration_run_id !== agentRunId ||
          attempt.status !== "MERGED" || !attempt.expected_target_sha || !attempt.source_sha ||
          attempt.worktree_path !== capabilityWorkspace || structured.baseSha !== attempt.expected_target_sha ||
          structured.sourceSha !== attempt.source_sha ||
          !structured.provenance?.includes(`integration_attempt:${attempt.id}`) ||
          !structured.evidence?.length) {
        throw new Error("Epic Integration PASS does not bind to its exact verified persisted attempt and SHAs");
      }
      integrationAttemptId = attempt.id;
    }
    const expected = role === "coordinator" ? structured?.operation === "PLAN" :
      role === "product_manager" ? structured?.outcome === "PRODUCT_DEFINITION" :
        role === "architect" ? structured?.outcome === "DESIGN" :
          role === "developer" ? structured?.outcome === "COMPLETED" : structured?.outcome === "PASS";
    if (!expected) throw new Error(`Epic ${role} result is not valid for phase ${phase}`);
    const accepted = role === "coordinator" || ["COMPLETED", "PASS", "PRODUCT_DEFINITION", "DESIGN"].includes(validation.outcome ?? "");
    const normalized = { ...result, accepted, architectureChangingProposalAccepted: role === "architect" && Boolean((validation.output as { architectureReviewRequired?: boolean } | undefined)?.architectureReviewRequired) };
    const evidence = { kind: "validated-role-result", phase, role, outcome: validation.outcome, ...(integrationAttemptId ? { integrationAttemptId } : {}), schema: validation.output, recordedAt: now };
    if (!accepted) throw new Error(`Epic role result was not accepted`);
    this.db.transaction((tx) => {
      tx.run("UPDATE orchestration_phase_runs SET result_json=$result,evidence_json=$evidence,validated=1,status='COMPLETED',ended_at=$at WHERE id=$id AND status='RUNNING'", { id: phaseId, result: JSON.stringify(normalized), evidence: JSON.stringify(evidence), at: now });
    });
    this.scheduler.releaseAgentRun(agentRunId, result.usage?.cost ?? 0);
    if (taskId) this.scheduler.releaseTask(taskId, result.usage?.cost ?? 0);
    return normalized;
  }

  private hasPhase(epicId: string, taskId: string | undefined, phase: string): boolean {
    return Boolean(this.db.get("SELECT id FROM orchestration_phase_runs WHERE epic_id=$epicId AND task_id IS $taskId AND phase=$phase AND validated=1 AND status='COMPLETED'", { epicId, taskId: taskId ?? null, phase }));
  }

  /**
   * Завершает устаревшие Epic phases только после owner preflight.
   * @remarks Precondition: lifecycle reconciliation уже выполнил `preflightRunProcessOwners` и ещё не выполнил scheduler reconciliation.
   * Переводит доказанно остановленные Runs/phases в terminal state и удаляет безопасно повторяемые незавершённые checkpoints.
   * При отсутствии STOPPED proof оставляет фазу и её reservation для следующего recovery.
   */
  reconcileInterruptedRuns(): void {
    const stale = this.db.all<{ id: string; agent_run_id: string }>(
      "SELECT id,agent_run_id FROM orchestration_phase_runs WHERE status IN ('INTENT','RUNNING') ORDER BY id",
    );
    for (const row of stale) {
      const runFailed = this.runs.failPreparedRun(row.agent_run_id, new Error("STALE_ORCHESTRATION_RUN"));
      if (!runFailed) continue;
      this.db.run(
        "UPDATE orchestration_phase_runs SET status='FAILED',ended_at=$at WHERE id=$id AND status IN ('INTENT','RUNNING')",
        { id: row.id, at: new Date().toISOString() },
      );
    }

    // Keep an unvalidated phase until its Run has safely reached a terminal state.
    // The startup owner preflight can stop an uncertain scope; a later reconciliation
    // then retries this command and removes the phase without losing its reservation.
    const failed = this.db.all<{ id: string; agent_run_id: string }>(
      "SELECT id,agent_run_id FROM orchestration_phase_runs WHERE status='FAILED' AND validated=0 ORDER BY id",
    );
    for (const row of failed) {
      if (!this.runs.failPreparedRun(row.agent_run_id, new Error("STALE_ORCHESTRATION_RUN"))) continue;
      this.db.run("DELETE FROM orchestration_phase_runs WHERE id=$id AND status='FAILED' AND validated=0", { id: row.id });
    }
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
