/**
 * Сервис Work предоставляет операции домена для задач и эпиков.
 */

import type { Database, DatabaseTx } from "../../platform/database/database.js";
import { WorkRepository } from "./work-repository.js";
import type { Task, Epic, TaskContract } from "./work-types.js";
import { WorkflowEngine } from "../workflow/workflow-engine.js";
import { WorkflowRegistry } from "../workflow/workflow-registry.js";
import { templates } from "../workflow/templates.js";
import type { PlanningService } from "../planning/planning-service.js";

/**
 * Предоставляет публичный контракт модуля work-service для взаимодействия слоёв приложения.
 */
export class WorkService {
  private readonly workflow: WorkflowEngine;
  private readonly planning: Pick<PlanningService, "createQueuedRequest"> | undefined;

  constructor(private readonly db: Database, workflow?: WorkflowEngine, planning?: Pick<PlanningService, "createQueuedRequest">) {
    this.planning = planning;
    if (workflow) {
      this.workflow = workflow;
    } else {
      const registry = new WorkflowRegistry();
      for (const template of Object.values(templates)) registry.register(template);
      this.workflow = new WorkflowEngine(db, registry);
    }
  }

  /**
   * Приостанавливает задачу через границу переходов состояния агрегата work.
   * Возвращает Task с дополнительным `priorStage` (последний stage до PAUSED),
   * сохранённым из workflow-события TaskStateChanged в той же транзакции.
   */
  pauseTask(taskId: string): Task & { priorStage: string } {
    return this.db.transaction((tx) => {
      this.workflow.transitionInTransaction(tx, taskId, "PAUSED");
      const now = new Date().toISOString();
      const priorStage = this.readPriorStageTx(tx, taskId) ?? "READY";
      tx.run("INSERT INTO audit_log(id,action,actor,aggregate_type,aggregate_id,details_json,created_at) VALUES($id,$action,$actor,$aggregate_type,$aggregate_id,$details,$created_at)", {
        id: crypto.randomUUID(), action: "TASK_PAUSED", actor: "local-user", aggregate_type: "Task", aggregate_id: taskId,
        details: JSON.stringify({ taskId, status: "PAUSED", priorStage }), created_at: now,
      });
      return { ...WorkRepository.getTaskById(tx, taskId)!, priorStage };
    });
  }

  /**
   * Возобновляет PAUSED-задачу в runnable состояние (READY) через workflow-машину.
   * `priorStage` сохраняется и возвращается как метаданные; приоритет stage
   * не теряется, но повторный вход в произвольный stage баншло не гарантируется
   * шаблоном (допустимый переход PAUSED → READY).
   */
  resumeTask(taskId: string): { taskId: string; state: "READY" | "IN_PROGRESS" | "PAUSED"; priorStage: string | null; updatedAt: string } {
    return this.db.transaction((tx) => {
      const task = WorkRepository.getTaskById(tx, taskId);
      if (!task) throw new Error(`Task ${taskId} not found`);
      if (task.status !== "PAUSED") throw new Error(`Task ${taskId} is not PAUSED`);
      const priorStage = this.readPriorStageTx(tx, taskId);
      const now = new Date().toISOString();
      this.workflow.transitionInTransaction(tx, taskId, "READY");
      tx.run("INSERT INTO audit_log(id,action,actor,aggregate_type,aggregate_id,details_json,created_at) VALUES($id,$action,$actor,$aggregate_type,$aggregate_id,$details,$created_at)", {
        id: crypto.randomUUID(), action: "TASK_RESUMED", actor: "local-user", aggregate_type: "Task", aggregate_id: taskId,
        details: JSON.stringify({ taskId, status: "READY", priorStage }), created_at: now,
      });
      return { taskId, state: "READY" as const, priorStage: priorStage ?? null, updatedAt: now };
    });
  }

  /**
   * Валидированный backend-команда изменения приоритета Task. Числовой приоритет
   * (1–1000) транслируется в канонический enum `priority` в contract_json и
   * фиксируется событием TaskPriorityChanged.
   */
  setTaskPriority(taskId: string, priority: number): { taskId: string; priority: number; updatedAt: string } {
    if (!Number.isInteger(priority) || priority < 1 || priority > 1000) throw new Error("TASK_PRIORITY_INVALID");
    const level = priority >= 800 ? "Critical" : priority >= 500 ? "High" : priority >= 200 ? "Normal" : "Low";
    return this.db.transaction((tx) => {
      const row = tx.get<{ contract_json: string }>("SELECT contract_json FROM tasks WHERE id=$id", { id: taskId });
      if (!row) throw new Error(`Task ${taskId} not found`);
      const contract = JSON.parse(row.contract_json) as Record<string, unknown>;
      contract.priority = level;
      const now = new Date().toISOString();
      tx.run("UPDATE tasks SET contract_json=$contract,updated_at=$now WHERE id=$id", { id: taskId, contract: JSON.stringify(contract), now });
      tx.run("INSERT INTO outbox_events(id,type,aggregate_type,aggregate_id,payload_json,created_at,available_at,attempts) VALUES($id,'TaskPriorityChanged','Task',$taskId,$payload,$now,$now,0)", {
        id: crypto.randomUUID(), taskId, payload: JSON.stringify({ taskId, priority, level }), now,
      });
      tx.run("INSERT INTO audit_log(id,action,actor,aggregate_type,aggregate_id,details_json,created_at) VALUES($id,$action,$actor,$aggregate_type,$aggregate_id,$details,$created_at)", {
        id: crypto.randomUUID(), action: "TASK_PRIORITY_CHANGED", actor: "local-user", aggregate_type: "Task", aggregate_id: taskId,
        details: JSON.stringify({ taskId, priority, level }), created_at: now,
      });
      return { taskId, priority, updatedAt: now };
    });
  }

  /**
   * Epic replan создаёт planning request под существующим coordinator/approval
   * lifecycle; не переписывает принятую работу детей напрямую.
   */
  replanEpic(epicId: string): { epicId: string; requestId: string; status: "PLANNING" | "PLAN_PENDING_APPROVAL"; createdAt: string } {
    if (!this.planning) throw new Error("EPIC_REPLAN_PLANNING_UNAVAILABLE");
    const epic = this.db.get<{ project_id: string; display_id: string; title: string; status: string }>(
      "SELECT project_id,display_id,title,status FROM epics WHERE id=$id", { id: epicId },
    );
    if (!epic) throw new Error(`Epic ${epicId} not found`);
    if (epic.status === "CANCELLED") throw new Error(`Epic ${epicId} is cancelled`);
    const request = this.planning.createQueuedRequest(epic.project_id, `Replan epic ${epic.display_id} (${epic.title}) under the existing coordinator/approval lifecycle.`, "local-user");
    return { epicId, requestId: request.id, status: "PLANNING", createdAt: request.createdAt };
  }

  private readPriorStageTx(tx: DatabaseTx, taskId: string): string | null {
    const event = tx.get<{ payload_json: string }>(
      "SELECT payload_json FROM outbox_events WHERE aggregate_id=$taskId AND type='TaskStateChanged' AND payload_json LIKE '%\"toStatus\":\"PAUSED\"%' ORDER BY created_at DESC, id DESC LIMIT 1",
      { taskId },
    );
    if (!event) return null;
    try {
      const payload = JSON.parse(event.payload_json) as { fromStatus?: string };
      return typeof payload.fromStatus === "string" ? payload.fromStatus : null;
    } catch { return null; }
  }

  /**
   * Создает отдельную задачу (не входящую в эпик) с локальным отображаемым идентификатором проекта.
   */
  createStandaloneTask(projectId: string, contract: TaskContract): Task {
    return this.db.transaction((tx) => {
      const num = WorkRepository.nextTaskNumber(tx, projectId);
      return WorkRepository.insertTask(tx, {
        id: crypto.randomUUID(),
        projectId,
        epicId: null,
        displayId: `TASK-${num}`,
        title: contract.goal,
        status: "DRAFT",
        contract,
        required: true,
      });
    });
  }

  /**
   * Создает эпик с локальным отображаемым идентификатором проекта.
   */
  createEpic(projectId: string, contract: TaskContract): Epic {
    return this.db.transaction((tx) => {
      const num = WorkRepository.nextEpicNumber(tx, projectId);
      return WorkRepository.insertEpic(tx, {
        id: crypto.randomUUID(),
        projectId,
        displayId: `EPIC-${num}`,
        title: contract.goal,
        status: "OPEN",
        contract,
      });
    });
  }

  /**
   * Создает задачу внутри эпика. Проект определяется из эпика.
   */
  createEpicTask(epicId: string, contract: TaskContract): Task {
    return this.db.transaction((tx) => {
      const epicRow = tx.get<{ project_id: string }>(
        "SELECT project_id FROM epics WHERE id = $id",
        { id: epicId },
      );
      if (!epicRow) {
        throw new Error(`Epic ${epicId} not found`);
      }
      const projectId = epicRow.project_id;
      const num = WorkRepository.nextTaskNumber(tx, projectId);
      return WorkRepository.insertTask(tx, {
        id: crypto.randomUUID(),
        projectId,
        epicId,
        displayId: `TASK-${num}`,
        title: contract.goal,
        status: "DRAFT",
        contract,
        required: true,
      });
    });
  }

  /**
   * Прикрепляет задачу к эпику. Выбрасывает ошибку, если задача уже принадлежит эпику.
   */
  attachTaskToEpic(taskId: string, epicId: string): Task {
    return this.db.transaction((tx) => {
      const existing = WorkRepository.getTaskById(tx, taskId);
      if (!existing) {
        throw new Error(`Task ${taskId} not found`);
      }
      if (existing.epicId !== null) {
        throw new Error(`Task already belongs to epic ${existing.epicId}`);
      }

      // Проверяет the epic exists and is in the same project
      const epicRow = tx.get<{ project_id: string }>(
        "SELECT project_id FROM epics WHERE id = $id",
        { id: epicId },
      );
      if (!epicRow) {
        throw new Error(`Epic ${epicId} not found`);
      }
      if (epicRow.project_id !== existing.projectId) {
        throw new Error("Task and epic must belong to the same project");
      }

      WorkRepository.setTaskEpicId(tx, taskId, epicId);

      // Возвращает the updated task
      return WorkRepository.getTaskById(tx, taskId)!;
    });
  }

  /**
   * Архивирует задачу, устанавливая её статус в CANCELLED.
   */
  archiveTask(taskId: string): Task {
    return this.db.transaction((tx) => {
      const existing = WorkRepository.getTaskById(tx, taskId);
      if (!existing) {
        throw new Error(`Task ${taskId} not found`);
      }
      return WorkRepository.setTaskStatus(tx, taskId, "CANCELLED");
    });
  }
}
