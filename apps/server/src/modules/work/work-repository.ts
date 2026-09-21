/**
 * Репозиторий работ – low-level DB access для задачи и epics.
 */

import type { DatabaseTx } from "../../platform/database/database.js";
import type { Task, Epic, TaskContract, TaskStatus, EpicStatus } from "./work-types.js";

interface TaskRow {
  id: string;
  project_id: string;
  epic_id: string | null;
  display_id: string;
  title: string;
  status: string;
  contract_json: string;
  required: number;
  created_at: string;
  updated_at: string;
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    epicId: row.epic_id,
    displayId: row.display_id,
    title: row.title,
    status: row.status as TaskStatus,
    contract: JSON.parse(row.contract_json) as TaskContract,
    required: row.required === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const WorkRepository = {
  /**
   * Получает the next task display number for a project.
   */
  nextTaskNumber(tx: DatabaseTx, projectId: string): number {
    const row = tx.get<{ max_num: number | null }>(
      `SELECT MAX(CAST(SUBSTR(display_id, 6) AS INTEGER)) AS max_num
       FROM tasks
       WHERE project_id = $projectId`,
      { projectId },
    );
    return (row?.max_num ?? 0) + 1;
  },

  /**
   * Получает the next epic display number for a project.
   */
  nextEpicNumber(tx: DatabaseTx, projectId: string): number {
    const row = tx.get<{ max_num: number | null }>(
      `SELECT MAX(CAST(SUBSTR(display_id, 6) AS INTEGER)) AS max_num
       FROM epics
       WHERE project_id = $projectId`,
      { projectId },
    );
    return (row?.max_num ?? 0) + 1;
  },

  /**
   * Insert Объект задача row.
   */
  insertTask(
    tx: DatabaseTx,
    task: {
      id: string;
      projectId: string;
      epicId: string | null;
      displayId: string;
      title: string;
      status: TaskStatus;
      contract: TaskContract;
      required: boolean;
    },
  ): Task {
    const now = new Date().toISOString();
    tx.run(
      `INSERT INTO tasks (id, project_id, epic_id, display_id, title, status, contract_json, required, created_at, updated_at)
       VALUES ($id, $project_id, $epic_id, $display_id, $title, $status, $contract_json, $required, $created_at, $updated_at)`,
      {
        id: task.id,
        project_id: task.projectId,
        epic_id: task.epicId,
        display_id: task.displayId,
        title: task.title,
        status: task.status,
        contract_json: JSON.stringify(task.contract),
        required: task.required ? 1 : 0,
        created_at: now,
        updated_at: now,
      },
    );
    return {
      id: task.id,
      projectId: task.projectId,
      epicId: task.epicId,
      displayId: task.displayId,
      title: task.title,
      status: task.status,
      contract: task.contract,
      required: task.required,
      createdAt: now,
      updatedAt: now,
    };
  },

  /**
   * Обновляет a task contract after all task IDs in a plan are known.
   */
  updateTaskContract(tx: DatabaseTx, taskId: string, contract: TaskContract): void {
    tx.run(
      "UPDATE tasks SET contract_json = $contract_json, updated_at = $updated_at WHERE id = $id",
      { id: taskId, contract_json: JSON.stringify(contract), updated_at: new Date().toISOString() },
    );
  },

  /**
   * Insert Объект epic row.
   */
  insertEpic(
    tx: DatabaseTx,
    epic: {
      id: string;
      projectId: string;
      displayId: string;
      title: string;
      status: EpicStatus;
      contract: TaskContract;
    },
  ): Epic {
    const now = new Date().toISOString();
    tx.run(
      `INSERT INTO epics (id, project_id, display_id, title, status, contract_json, created_at, updated_at)
       VALUES ($id, $project_id, $display_id, $title, $status, $contract_json, $created_at, $updated_at)`,
      {
        id: epic.id,
        project_id: epic.projectId,
        display_id: epic.displayId,
        title: epic.title,
        status: epic.status,
        contract_json: JSON.stringify(epic.contract),
        created_at: now,
        updated_at: now,
      },
    );
    return {
      id: epic.id,
      projectId: epic.projectId,
      displayId: epic.displayId,
      title: epic.title,
      status: epic.status,
      contract: epic.contract,
      createdAt: now,
      updatedAt: now,
    };
  },

  /**
   * Получает a task by ID.
   */
  getTaskById(tx: DatabaseTx, taskId: string): Task | undefined {
    const row = tx.get<TaskRow>(
      "SELECT * FROM tasks WHERE id = $id",
      { id: taskId },
    );
    return row ? rowToTask(row) : undefined;
  },

  /**
   * Обновляет a task's epic_id.
   */
  setTaskEpicId(tx: DatabaseTx, taskId: string, epicId: string | null): void {
    const now = new Date().toISOString();
    tx.run(
      "UPDATE tasks SET epic_id = $epic_id, updated_at = $updated_at WHERE id = $id",
      { id: taskId, epic_id: epicId, updated_at: now },
    );
  },

  /**
   * Обновляет a task's status.
   */
  setTaskStatus(tx: DatabaseTx, taskId: string, status: TaskStatus): Task {
    const now = new Date().toISOString();
    tx.run(
      "UPDATE tasks SET status = $status, updated_at = $updated_at WHERE id = $id",
      { id: taskId, status, updated_at: now },
    );
    const row = tx.get<TaskRow>(
      "SELECT * FROM tasks WHERE id = $id",
      { id: taskId },
    );
    return rowToTask(row!);
  },
};
