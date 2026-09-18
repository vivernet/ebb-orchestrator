import type { Database, DatabaseTx } from "../../platform/database/database.js";
import { DomainEvent } from "../../platform/events/domain-event.js";
import { appendOutboxEvent } from "../../platform/events/outbox-repository.js";
import { WorkRepository } from "../work/work-repository.js";
import type { PlanningClassification, PlanningPlan, PlanningPlanInput, PlanningRequest } from "./planning-types.js";
import { planningApprovalRequired, effectivePlanningApprovalPolicy } from "./planning-policy.js";
import { validatePlan } from "./plan-validator.js";

/**
 * Предоставляет публичный контракт модуля planning-service для взаимодействия слоёв приложения.
 */
export class PlanningService {
  constructor(private readonly db: Database) {}

  createRequest(projectId: string, request: string, requestedBy: string): PlanningRequest {
    return this.db.transaction((tx) => {
      const result = { id: crypto.randomUUID(), projectId, request, requestedBy, classification: null, planId: null, createdAt: new Date().toISOString() };
      tx.run("INSERT INTO planning_requests (id, project_id, request, requested_by, created_at) VALUES ($id,$project_id,$request,$requested_by,$created_at)", {
        id: result.id, project_id: projectId, request, requested_by: requestedBy, created_at: result.createdAt,
      });
      return result;
    });
  }

  classify(request: string | PlanningRequest): PlanningClassification {
    const text = typeof request === "string" ? request : request.request;
    if (!text.trim()) return "NEEDS_INPUT";
    return /\b(epic|feature|multiple|several|plan)\b/i.test(text) ? "EPIC" : "TASK";
  }

  preparePlan(input: PlanningPlanInput, policy: Partial<ReturnType<typeof effectivePlanningApprovalPolicy>> = {}): PlanningPlan {
    validatePlan(input);
    const now = new Date().toISOString();
    const plan: PlanningPlan = {
      ...input, id: crypto.randomUUID(), status: "PENDING",
      approvalRequired: planningApprovalRequired(input, policy), temporaryIdMap: {}, createdAt: now,
    };
    return this.db.transaction((tx) => {
      tx.run("INSERT INTO planning_plans (id, project_id, plan_json, status, approval_required, created_at) VALUES ($id,$project_id,$plan_json,$status,$approval_required,$created_at)", {
        id: plan.id, project_id: input.projectId, plan_json: JSON.stringify(input), status: plan.approvalRequired ? "PENDING" : "APPROVED", approval_required: plan.approvalRequired ? 1 : 0, created_at: now,
      });
      if (!plan.approvalRequired) return this.materialize(tx, plan, "system");
      return plan;
    });
  }

  approvePlan(planId: string, actor: string): PlanningPlan {
    return this.db.transaction((tx) => {
      const row = tx.get<{ id: string; project_id: string; plan_json: string; status: string; approval_required: number; created_at: string }>("SELECT * FROM planning_plans WHERE id=$id", { id: planId });
      if (!row) throw new Error(`Plan ${planId} not found`);
      if (row.status !== "PENDING") throw new Error(`Plan ${planId} is already resolved`);
      const input = JSON.parse(row.plan_json) as PlanningPlanInput;
      validatePlan(input);
      return this.materialize(tx, { ...input, id: row.id, status: "PENDING", approvalRequired: row.approval_required === 1, temporaryIdMap: {}, createdAt: row.created_at }, actor);
    });
  }

  rejectPlan(planId: string, actor: string): PlanningPlan {
    return this.db.transaction((tx) => {
      const row = tx.get<{ plan_json: string; status: string; approval_required: number; project_id: string; created_at: string }>("SELECT * FROM planning_plans WHERE id=$id", { id: planId });
      if (!row) throw new Error(`Plan ${planId} not found`);
      if (row.status !== "PENDING") throw new Error(`Plan ${planId} is already resolved`);
      tx.run("UPDATE planning_plans SET status='REJECTED', approved_by=$actor, approved_at=$at WHERE id=$id", { id: planId, actor, at: new Date().toISOString() });
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
    // Allocate every domain ID before building contracts so temporary refs never
    // cross the planning/work domain boundary.
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
    appendOutboxEvent(tx, DomainEvent.create({ type: "PlanApproved", aggregateType: "PlanningPlan", aggregateId: plan.id, payload: { planId: plan.id, temporaryIdMap: map, approvedBy: actor } }));
    return { ...plan, status: "APPROVED", temporaryIdMap: map };
  }
}
