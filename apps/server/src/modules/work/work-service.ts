/**
 * Сервис Work предоставляет операции домена для задач и эпиков.
 */

import type { Database } from "../../platform/database/database.js";
import { WorkRepository } from "./work-repository.js";
import type { Task, Epic, TaskContract } from "./work-types.js";
import { WorkflowEngine } from "../workflow/workflow-engine.js";
import { WorkflowRegistry } from "../workflow/workflow-registry.js";
import { templates } from "../workflow/templates.js";

/**
 * Предоставляет публичный контракт модуля work-service для взаимодействия слоёв приложения.
 */
export class WorkService {
  private readonly workflow: WorkflowEngine;

  constructor(private readonly db: Database, workflow?: WorkflowEngine) {
    this.db.exec("CREATE TABLE IF NOT EXISTS audit_log (id TEXT PRIMARY KEY, action TEXT NOT NULL, actor TEXT NOT NULL, aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL, details_json TEXT NOT NULL, created_at TEXT NOT NULL)");
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
   */
  pauseTask(taskId: string): Task {
    return this.db.transaction((tx) => {
      this.workflow.transitionInTransaction(tx, taskId, "PAUSED");
      const now = new Date().toISOString();
      tx.run("INSERT INTO audit_log(id,action,actor,aggregate_type,aggregate_id,details_json,created_at) VALUES($id,$action,$actor,$aggregate_type,$aggregate_id,$details,$created_at)", {
        id: crypto.randomUUID(), action: "TASK_PAUSED", actor: "local-user", aggregate_type: "Task", aggregate_id: taskId,
        details: JSON.stringify({ taskId, status: "PAUSED" }), created_at: now,
      });
      return WorkRepository.getTaskById(tx, taskId)!;
    });
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

      // Verify the epic exists and is in the same project
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

      // Return the updated task
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
