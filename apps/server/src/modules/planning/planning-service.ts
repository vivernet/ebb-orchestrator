import type { Database, DatabaseTx } from "../../platform/database/database.js";
import { DomainEvent } from "../../platform/events/domain-event.js";
import { appendOutboxEvent } from "../../platform/events/outbox-repository.js";
import { enqueueJob } from "../../platform/jobs/job-repository.js";
import { WorkRepository } from "../work/work-repository.js";
import type { PlanningClassification, PlanningPlan, PlanningPlanInput, PlanningRequest } from "./planning-types.js";
import { planningApprovalRequired, effectivePlanningApprovalPolicy } from "./planning-policy.js";
import { validatePlan } from "./plan-validator.js";
import { DesignResultSchema, ProductDefinitionSchema } from "@ebb-orchestrator/contracts";
import type { PlanningDecisions } from "./planning-types.js";
import { parsePersistedContextJsonV1 } from "../context/context-provenance.js";
import { parseCoordinatorRequestOutput } from "./coordinator-request-output.js";
import type { DesignResult, ProductDefinition } from "@ebb-orchestrator/contracts";

interface RequestRow { project_id: string; status: string; coordinator_run_id: string | null; planning_decisions_required: number; }
export type PlanningFailureCode = "COORDINATOR_RUN_FAILED" | "COORDINATOR_OUTPUT_INVALID" | "PLANNING_DISPATCH_FAILED" | "PLANNING_INTERRUPTED" | "PLANNING_REVIEW_BLOCKED";

/** Проверенная read-only проекция Request и связанных planning результатов для подготовки Run. */
export interface ValidatedRequestRunContextV1 {
  readonly request: { id: string; projectId: string; request: string; requestedBy: string; status: string; classification: string | null; planId: string | null; planningDecisionsRequired: boolean };
  readonly coordinatorClassification: PlanningClassification | null;
  readonly coordinatorPlan: PlanningPlanInput | null;
  readonly persistedPlan: PlanningPlanInput | null;
  readonly productManager: ProductDefinition | null;
  readonly architect: DesignResult | null;
}

/** Проверенная read-only проекция существующего Epic orchestration checkpoint. */
export interface ValidatedEpicRunContextV1 {
  readonly planId: string;
  readonly plan: PlanningPlanInput;
  readonly input: PlanningPlanInput & { includeProductManager?: boolean; includeArchitect?: boolean; architectureReviewRequired?: boolean; architecture_review_required?: boolean };
}

/**
 * Загружает Request вместе с результатами только из принадлежащих ему завершённых Runs.
 * DTO вызывающего кода не является источником authority для planning plan/decisions.
 *
 * @param tx Транзакция, из которой собирается Run context.
 * @param requestId Persisted Request ID.
 * @returns Проверенные persisted Request, plan и доступные решения.
 * @throws {Error} Если связанный Run отсутствует, не завершён или содержит некорректный output.
 */
export function readValidatedRequestRunContextTx(tx: DatabaseTx, requestId: string): ValidatedRequestRunContextV1 {
  const row = tx.get<{
    id: string; project_id: string; request: string; requested_by: string; status: string;
    classification: string | null; plan_id: string | null; planning_decisions_required: number; coordinator_run_id: string | null;
  }>("SELECT id,project_id,request,requested_by,status,classification,plan_id,planning_decisions_required,coordinator_run_id FROM planning_requests WHERE id=$requestId", { requestId });
  if (!row || !row.id || !row.project_id || typeof row.request !== "string" || !row.requested_by
      || !Number.isInteger(row.planning_decisions_required) || ![0, 1].includes(row.planning_decisions_required)) {
    throw new Error("Persisted planning request is missing or invalid");
  }

  let coordinatorPlan: PlanningPlanInput | null = null;
  let coordinatorClassification: PlanningClassification | null = null;
  if (row.coordinator_run_id) {
    const run = tx.get<{ id: string; role: string; task_id: string | null; epic_id: string | null; status: string; output: string | null }>(
      "SELECT id,role,task_id,epic_id,status,output FROM agent_runs WHERE id=$runId", { runId: row.coordinator_run_id });
    if (!isValidRequestPlanningRun(run, "coordinator") || run.status !== "COMPLETED" || !run.output) {
      throw new Error("Persisted Coordinator Run is not a valid Request planning run");
    }
    const output = parsePersistedContextJsonV1(run.output);
    const decision = parseCoordinatorRequestOutput(output, row.project_id, row.requested_by);
    coordinatorClassification = decision.classification;
    if (decision.classification === "EPIC") coordinatorPlan = decision.plan;
    if (row.classification !== null && decision.classification !== row.classification) {
      throw new Error("Persisted Coordinator classification does not match its Request");
    }
  }

  let persistedPlan: PlanningPlanInput | null = null;
  if (row.plan_id) {
    const planRow = tx.get<{ project_id: string; plan_json: string }>(
      "SELECT project_id,plan_json FROM planning_plans WHERE id=$planId", { planId: row.plan_id });
    if (!planRow || planRow.project_id !== row.project_id) throw new Error("Persisted Request plan is missing or cross-project");
    const parsed = parsePersistedContextJsonV1(planRow.plan_json);
    if (!isRecord(parsed) || parsed.projectId !== row.project_id || !Array.isArray(parsed.tasks)) throw new Error("Persisted Request plan is malformed");
    validatePlan(parsed as unknown as PlanningPlanInput);
    persistedPlan = parsed as unknown as PlanningPlanInput;
  }

  const planningDecisionsRequired = row.planning_decisions_required === 1;
  const readRoleOutput = (role: "product_manager" | "architect"): unknown | null => {
    const linked = tx.get<{ id: string; role: string; task_id: string | null; epic_id: string | null; status: string; output: string | null }>(
      `SELECT r.id,r.role,r.task_id,r.epic_id,r.status,r.output FROM planning_request_role_runs pr JOIN agent_runs r ON r.id=pr.run_id
        WHERE pr.request_id=$requestId AND pr.role=$role`, { requestId, role });
    if (!linked) return null;
    if (!isValidRequestPlanningRun(linked, role) || linked.status !== "COMPLETED" || !linked.output) {
      throw new Error(`Persisted ${role} Run is not a valid Request planning run`);
    }
    return parsePersistedContextJsonV1(linked.output);
  };
  const productOutput = readRoleOutput("product_manager");
  const architectOutput = readRoleOutput("architect");
  const productManager = productOutput === null ? null : ProductDefinitionSchema.parse(productOutput);
  const architect = architectOutput === null ? null : DesignResultSchema.parse(architectOutput);
  if (planningDecisionsRequired && row.status !== "RECEIVED" && (!row.coordinator_run_id || !coordinatorPlan)) {
    throw new Error("Persisted Request Coordinator plan is unavailable");
  }
  if (architect && !productManager) throw new Error("Persisted Architect result has no linked Product Manager result");

  return {
    request: {
      id: row.id, projectId: row.project_id, request: row.request, requestedBy: row.requested_by,
      status: row.status, classification: row.classification, planId: row.plan_id,
      planningDecisionsRequired,
    },
    coordinatorClassification, coordinatorPlan, persistedPlan, productManager, architect,
  };
}

/**
 * Загружает и повторно валидирует существующий Epic planning checkpoint.
 * Отсутствующий checkpoint обозначается `null`; повреждённый checkpoint отвергается.
 *
 * @param tx Транзакция подготовки Run.
 * @param epicId Persisted Epic ID.
 * @returns Проверенные plan/input/stage либо `null`, если checkpoint ещё не создан.
 * @throws {Error} Если persisted checkpoint не согласован с Epic/plan.
 */
export function readValidatedEpicRunContextTx(tx: DatabaseTx, epicId: string): ValidatedEpicRunContextV1 | null {
  const row = tx.get<{ plan_id: string; input_json: string; project_id: string; plan_json: string; plan_project_id: string; epic_id: string | null }>(
    `SELECT o.plan_id,o.input_json,e.project_id,p.plan_json,p.project_id AS plan_project_id,p.epic_id
       FROM epic_orchestrations o JOIN epics e ON e.id=o.epic_id
       JOIN planning_plans p ON p.id=o.plan_id
      WHERE o.epic_id=$epicId`, { epicId });
  if (!row) return null;
  if (!row.plan_id || row.project_id !== row.plan_project_id || row.epic_id !== epicId || !row.input_json || !row.plan_json) {
    throw new Error("Persisted Epic planning checkpoint is incomplete or cross-bound");
  }
  const planValue = parsePersistedContextJsonV1(row.plan_json);
  const inputValue = parsePersistedContextJsonV1(row.input_json);
  if (!isRecord(planValue) || planValue.projectId !== row.project_id || !Array.isArray(planValue.tasks)
      || !isRecord(inputValue) || inputValue.projectId !== row.project_id || !Array.isArray(inputValue.tasks)) {
    throw new Error("Persisted Epic planning checkpoint JSON is malformed");
  }
  validatePlan(planValue as unknown as PlanningPlanInput);
  validatePlan(inputValue as unknown as PlanningPlanInput);
  for (const flag of [inputValue.includeProductManager, inputValue.includeArchitect, inputValue.architectureReviewRequired, inputValue.architecture_review_required]) {
    if (flag !== undefined && typeof flag !== "boolean") throw new Error("Persisted Epic planning flag is invalid");
  }
  return {
    planId: row.plan_id,
    plan: planValue as unknown as PlanningPlanInput,
    input: inputValue as unknown as ValidatedEpicRunContextV1["input"],
  };
}

function isValidRequestPlanningRun(
  run: { role: string; task_id: string | null; epic_id: string | null } | undefined,
  expectedRole: "coordinator" | "product_manager" | "architect",
): run is { role: string; task_id: string | null; epic_id: string | null } {
  return run !== undefined && run.role === expectedRole && run.task_id === null && run.epic_id === null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Предоставляет публичный контракт модуля planning-service для взаимодействия слоёв приложения.
 */
export class PlanningService {
  constructor(private readonly db: Database) {}

  createRequest(projectId: string, request: string, requestedBy: string): PlanningRequest {
    return this.db.transaction((tx) => this.insertRequest(tx, projectId, request, requestedBy, false));
  }

  /** Сохраняет request и durable Coordinator job одним commit. */
  createQueuedRequest(projectId: string, request: string, requestedBy: string): PlanningRequest {
    return this.db.transaction((tx) => {
      const created = this.insertRequest(tx, projectId, request, requestedBy, true);
      enqueueJob(tx, { type: "coordinator.planning", payload: { requestId: created.id, projectId }, dedupeKey: `planning:${created.id}` });
      return created;
    });
  }

  private insertRequest(tx: DatabaseTx, projectId: string, request: string, requestedBy: string, decisionsRequired: boolean): PlanningRequest {
      const now = new Date().toISOString();
      const result: PlanningRequest = { id: crypto.randomUUID(), projectId, request, requestedBy, classification: null, planId: null, status: "RECEIVED", coordinatorRunId: null, planningDecisionsRequired: decisionsRequired, failureCode: null, createdAt: now, updatedAt: now };
      tx.run("INSERT INTO planning_requests (id, project_id, request, requested_by, status, planning_decisions_required, created_at, updated_at) VALUES ($id,$project_id,$request,$requested_by,'RECEIVED',$decisionsRequired,$created_at,$updated_at)", {
        id: result.id, project_id: projectId, request, requested_by: requestedBy, decisionsRequired: decisionsRequired ? 1 : 0, created_at: now, updated_at: now,
      });
      return result;
  }

  /** Закрепляет существующий Coordinator Run за request ровно один раз. */
  claimRequest(requestId: string, coordinatorRunId: string): boolean {
    return this.db.transaction((tx) => this.claimRequestTx(tx, requestId, coordinatorRunId));
  }

  /** CAS для совместной транзакции с подготовкой Coordinator Run. */
  claimRequestTx(tx: DatabaseTx, requestId: string, coordinatorRunId: string): boolean {
      const run = tx.get<{ id: string }>("SELECT id FROM agent_runs WHERE id=$id AND lower(role)='coordinator' AND status='STARTED' AND task_id IS NULL AND epic_id IS NULL", { id: coordinatorRunId });
      if (!run) return false;
      const result = tx.get<{ id: string }>(
        "UPDATE planning_requests SET status='PLANNING', coordinator_run_id=$runId, updated_at=$now WHERE id=$requestId AND status='RECEIVED' AND coordinator_run_id IS NULL RETURNING id",
        { requestId, runId: coordinatorRunId, now: new Date().toISOString() },
      );
      return Boolean(result);
  }

  /** Завершает классификацию без плана, сохраняя связь с исходным Run. */
  markNeedsInput(requestId: string, coordinatorRunId: string): boolean {
    const row = this.db.get<{ id: string }>(
      "UPDATE planning_requests SET status='NEEDS_INPUT',classification='NEEDS_INPUT',updated_at=$now WHERE id=$id AND status='PLANNING' AND coordinator_run_id=$runId RETURNING id",
      { id: requestId, runId: coordinatorRunId, now: new Date().toISOString() },
    );
    return Boolean(row);
  }

  /** Записывает только фиксированный безопасный код отказа. */
  failRequest(requestId: string, coordinatorRunId: string, code: PlanningFailureCode): boolean {
    if (!["COORDINATOR_RUN_FAILED", "COORDINATOR_OUTPUT_INVALID", "PLANNING_DISPATCH_FAILED", "PLANNING_INTERRUPTED", "PLANNING_REVIEW_BLOCKED"].includes(code)) throw new Error("Unknown planning failure code");
    const row = this.db.get<{ id: string }>(
      "UPDATE planning_requests SET status='FAILED',failure_code=$code,updated_at=$now WHERE id=$id AND status='PLANNING' AND coordinator_run_id=$runId RETURNING id",
      { id: requestId, runId: coordinatorRunId, code, now: new Date().toISOString() },
    );
    return Boolean(row);
  }

  /** После run reconciliation завершает PLANNING, если его Run оборван. */
  reconcileInterruptedRequests(): number {
    this.db.run(
      `UPDATE planning_requests
          SET status='FAILED',failure_code='PLANNING_INTERRUPTED',updated_at=$now
        WHERE status='PLANNING' AND
          (coordinator_run_id IS NULL OR NOT EXISTS (
            SELECT 1 FROM agent_runs r WHERE r.id=planning_requests.coordinator_run_id
              AND r.status IN ('STARTED','IN_PROGRESS','COMPLETING','COMPLETED')
          ))`,
      { now: new Date().toISOString() },
    );
    return this.db.get<{ changes: number }>("SELECT changes() AS changes")?.changes ?? 0;
  }

  /** Сохраняет проверенный план и связь с request в одной транзакции. */
  completeRequest(requestId: string, coordinatorRunId: string, classification: PlanningClassification, input: PlanningPlanInput): PlanningPlan {
    if (classification === "NEEDS_INPUT") throw new Error("A plan cannot be attached to NEEDS_INPUT");
    validatePlan(input);
    const decisions = input.planningDecisions === undefined ? undefined : validatePlanningDecisions(input.planningDecisions);
    return this.db.transaction((tx) => {
      const request = tx.get<RequestRow>("SELECT project_id,status,coordinator_run_id,planning_decisions_required FROM planning_requests WHERE id=$id", { id: requestId });
      if (!request) throw new Error(`Planning request ${requestId} not found`);
      if (request.status !== "PLANNING" || request.coordinator_run_id !== coordinatorRunId) throw new Error(`Planning request ${requestId} is already resolved or owned by another run`);
      if (request.project_id !== input.projectId) throw new Error("Planning request and plan belong to different projects");
      if (classification === "EPIC" && !input.epic) throw new Error("Epic classification requires an Epic plan");
      if (classification === "EPIC" && request.planning_decisions_required === 1 && !decisions) throw new Error("Request-bound Epic plan requires validated Product Manager and Architect decisions");
      if (classification === "EPIC" && request.planning_decisions_required === 1 && decisions) assertLinkedReviewRuns(tx, requestId, decisions);
      const planInput = decisions ? { ...input, planningDecisions: decisions } : input;
      const plan = this.insertPlan(tx, planInput, effectivePlanningApprovalPolicy());
      tx.run("UPDATE planning_requests SET classification=$classification, plan_id=$planId, status=$status, updated_at=$now WHERE id=$id", {
        classification, planId: plan.id, status: plan.status === "PENDING" ? "PLAN_PENDING_APPROVAL" : "MATERIALIZED", now: new Date().toISOString(), id: requestId,
      });
      return plan;
    });
  }

  classify(request: string | PlanningRequest): PlanningClassification {
    const text = typeof request === "string" ? request : request.request;
    if (!text.trim()) return "NEEDS_INPUT";
    return /\b(epic|feature|multiple|several|plan)\b/i.test(text) ? "EPIC" : "TASK";
  }

  preparePlan(input: PlanningPlanInput, policy: Partial<ReturnType<typeof effectivePlanningApprovalPolicy>> = {}): PlanningPlan {
    validatePlan(input);
    return this.db.transaction((tx) => this.insertPlan(tx, input, policy));
  }

  private insertPlan(tx: DatabaseTx, input: PlanningPlanInput, policy: Partial<ReturnType<typeof effectivePlanningApprovalPolicy>>): PlanningPlan {
    const now = new Date().toISOString();
    const plan: PlanningPlan = {
      ...input, id: crypto.randomUUID(), status: "PENDING",
      approvalRequired: planningApprovalRequired(input, policy), temporaryIdMap: {}, createdAt: now,
    };
      tx.run("INSERT INTO planning_plans (id, project_id, plan_json, status, approval_required, created_at) VALUES ($id,$project_id,$plan_json,$status,$approval_required,$created_at)", {
        id: plan.id, project_id: input.projectId, plan_json: JSON.stringify(input), status: plan.approvalRequired ? "PENDING" : "APPROVED", approval_required: plan.approvalRequired ? 1 : 0, created_at: now,
      });
      if (!plan.approvalRequired) return this.materialize(tx, plan, "system");
      return plan;
  }

  approvePlan(planId: string, actor: string, requestId?: string): PlanningPlan {
    return this.db.transaction((tx) => {
      const row = tx.get<{ id: string; project_id: string; plan_json: string; status: string; approval_required: number; created_at: string }>("SELECT * FROM planning_plans WHERE id=$id", { id: planId });
      if (!row) throw new Error(`Plan ${planId} not found`);
      if (row.status !== "PENDING") throw new Error(`Plan ${planId} is already resolved`);
      const linkedRequest = tx.get<{ id: string; classification: string | null; planning_decisions_required: number }>(
        "SELECT id,classification,planning_decisions_required FROM planning_requests WHERE plan_id=$planId AND project_id=$projectId",
        { planId, projectId: row.project_id },
      );
      if (requestId !== undefined && (!linkedRequest || linkedRequest.id !== requestId || linkedRequest.classification !== "EPIC")) {
        throw new Error("Planning request does not own this pending Epic plan");
      }
      if (linkedRequest && (requestId !== linkedRequest.id || linkedRequest.classification !== "EPIC")) {
        throw new Error("Request-bound Epic plan requires its linked request approval");
      }
      if (linkedRequest) {
        const pending = tx.get<{ id: string }>(
          "SELECT id FROM planning_requests WHERE id=$requestId AND project_id=$projectId AND plan_id=$planId AND classification='EPIC' AND status='PLAN_PENDING_APPROVAL'",
          { requestId: linkedRequest.id, projectId: row.project_id, planId },
        );
        if (!pending) throw new Error("Planning request is not awaiting approval for this Epic plan");
      }
      const input = JSON.parse(row.plan_json) as PlanningPlanInput;
      validatePlan(input);
      if (linkedRequest?.planning_decisions_required === 1) validatePlanningDecisions(input.planningDecisions);
      return this.materialize(tx, { ...input, id: row.id, status: "PENDING", approvalRequired: row.approval_required === 1, temporaryIdMap: {}, createdAt: row.created_at }, actor);
    });
  }

  rejectPlan(planId: string, actor: string): PlanningPlan {
    return this.db.transaction((tx) => {
      const row = tx.get<{ plan_json: string; status: string; approval_required: number; project_id: string; created_at: string }>("SELECT * FROM planning_plans WHERE id=$id", { id: planId });
      if (!row) throw new Error(`Plan ${planId} not found`);
      if (row.status !== "PENDING") throw new Error(`Plan ${planId} is already resolved`);
      tx.run("UPDATE planning_plans SET status='REJECTED', approved_by=$actor, approved_at=$at WHERE id=$id", { id: planId, actor, at: new Date().toISOString() });
      tx.run("UPDATE planning_requests SET status='REJECTED', updated_at=$at WHERE plan_id=$id AND status='PLAN_PENDING_APPROVAL'", { id: planId, at: new Date().toISOString() });
      return { ...(JSON.parse(row.plan_json) as PlanningPlanInput), id: planId, status: "REJECTED", approvalRequired: row.approval_required === 1, temporaryIdMap: {}, createdAt: row.created_at };
    });
  }

  private materialize(tx: DatabaseTx, plan: PlanningPlan, actor: string): PlanningPlan {
    const validation = validatePlan(plan);
    const map: Record<string, string> = {};
    const taskIds = new Map<string, string>();
    const taskDisplayIds = new Map<string, string>();
    let epicId: string | null = null;
    if (plan.epic) {
      const id = crypto.randomUUID(); const num = WorkRepository.nextEpicNumber(tx, plan.projectId);
      const epic = WorkRepository.insertEpic(tx, { id, projectId: plan.projectId, displayId: `EPIC-${num}`, title: plan.epic.title, status: "OPEN", contract: { version: 1, goal: plan.epic.goal ?? plan.epic.title, context: "", requirements: [], acceptanceCriteria: [], dependencies: [], nonGoals: [], definitionOfDone: [] } });
      epicId = epic.id;
      appendOutboxEvent(tx, DomainEvent.create({ type: "EpicCreated", aggregateType: "Epic", aggregateId: epic.id, payload: { epicId: epic.id, displayId: epic.displayId } }));
    }
    // Allocate every domain ID перед building contracts so temporary refs never
    // cross Объект planning/работа domain boundary.
    const firstTaskNumber = WorkRepository.nextTaskNumber(tx, plan.projectId);
    for (const [index, task] of plan.tasks.entries()) {
      const id = crypto.randomUUID(); const num = firstTaskNumber + index;
      const displayId = `TASK-${num}`;
      taskIds.set(task.ref, id);
      taskDisplayIds.set(task.ref, displayId);
      map[task.ref] = displayId;
    }
    for (const task of plan.tasks) {
      const id = taskIds.get(task.ref)!;
      const created = WorkRepository.insertTask(tx, { id, projectId: plan.projectId, epicId, displayId: taskDisplayIds.get(task.ref)!, title: task.title, status: "DRAFT", contract: { ...validation.contracts.get(task.ref)!, dependencies: [] }, required: !task.optional });
      appendOutboxEvent(tx, DomainEvent.create({ type: "TaskCreated", aggregateType: "Task", aggregateId: created.id, payload: { taskId: created.id, displayId: created.displayId, planId: plan.id } }));
    }
    for (const task of plan.tasks) {
      const taskId = taskIds.get(task.ref)!;
      WorkRepository.updateTaskContract(tx, taskId, { ...validation.contracts.get(task.ref)!, dependencies: (task.dependsOn ?? []).map((dependency) => taskIds.get(dependency)!) });
    }
    for (const task of plan.tasks) for (const dependency of task.dependsOn ?? []) {
      const taskId = taskIds.get(task.ref)!;
      const dependsOnTaskId = taskIds.get(dependency)!;
      tx.run("INSERT INTO dependencies (id, task_id, depends_on_task_id, type, created_at) VALUES ($id, $task_id, $depends_on_task_id, 'BLOCKING', $created_at)", { id: crypto.randomUUID(), task_id: taskId, depends_on_task_id: dependsOnTaskId, created_at: new Date().toISOString() });
      appendOutboxEvent(tx, DomainEvent.create({ type: "DependencyCreated", aggregateType: "Task", aggregateId: taskId, payload: { taskId, dependsOnTaskId } }));
    }
    tx.run("UPDATE planning_plans SET status='APPROVED', temporary_id_map_json=$map, approved_by=$actor, approved_at=$at, epic_id=$epicId WHERE id=$id", { id: plan.id, map: JSON.stringify(map), actor, epicId, at: new Date().toISOString() });
    tx.run("UPDATE planning_requests SET status='MATERIALIZED', updated_at=$at WHERE plan_id=$id AND status='PLAN_PENDING_APPROVAL'", { id: plan.id, at: new Date().toISOString() });
    appendOutboxEvent(tx, DomainEvent.create({ type: "PlanApproved", aggregateType: "PlanningPlan", aggregateId: plan.id, payload: { planId: plan.id, temporaryIdMap: map, approvedBy: actor } }));
    return { ...plan, status: "APPROVED", temporaryIdMap: map };
  }
}

/** Повторно проверяет сохранённые review decisions на чтении/одобрении persisted plan. */
export function validatePlanningDecisions(value: unknown): PlanningDecisions {
  const product = ProductDefinitionSchema.safeParse((value as { productManager?: unknown } | null)?.productManager);
  const architecture = DesignResultSchema.safeParse((value as { architect?: unknown } | null)?.architect);
  if (!product.success || product.data.outcome !== "PRODUCT_DEFINITION") throw new Error("Product Manager decision is missing or invalid");
  if (!architecture.success || architecture.data.outcome !== "DESIGN") throw new Error("Architect decision is missing or invalid");
  return { productManager: product.data, architect: architecture.data };
}

function assertLinkedReviewRuns(tx: DatabaseTx, requestId: string, decisions: PlanningDecisions): void {
  const rows = tx.all<{ role: string; status: string; output: string | null }>(
    `SELECT pr.role,r.status,r.output FROM planning_request_role_runs pr
       JOIN agent_runs r ON r.id=pr.run_id
      WHERE pr.request_id=$requestId ORDER BY pr.role`, { requestId });
  const stored = new Map<string, unknown>();
  for (const row of rows) {
    if (row.status !== "COMPLETED" || !row.output) throw new Error("Request-bound review Run is not durably completed");
    try { stored.set(row.role, JSON.parse(row.output) as unknown); }
    catch { throw new Error("Request-bound review Run output is malformed"); }
  }
  const validated = validatePlanningDecisions({ productManager: stored.get("product_manager"), architect: stored.get("architect") });
  if (JSON.stringify(validated) !== JSON.stringify(decisions)) throw new Error("Request-bound review decisions do not match their validated AgentRuns");
}
