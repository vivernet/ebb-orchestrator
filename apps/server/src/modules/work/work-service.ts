/**
 * Work service – domain operations for tasks and epics.
 */

import type { Database } from "../../platform/database/database.js";
import { WorkRepository } from "./work-repository.js";
import type { Task, Epic, TaskContract } from "./work-types.js";

export class WorkService {
  constructor(private readonly db: Database) {}

  /** Pause a task through the work aggregate's state transition boundary. */
  pauseTask(taskId: string): Task {
    return this.db.transaction((tx) => {
      const existing = WorkRepository.getTaskById(tx, taskId);
      if (!existing) throw new Error(`Task ${taskId} not found`);
      return WorkRepository.setTaskStatus(tx, taskId, "PAUSED");
    });
  }

  /**
   * Create a standalone task (not in an epic) with a project-local display ID.
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
   * Create an epic with a project-local display ID.
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
   * Create a task within an epic. The project is determined from the epic.
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
   * Attach a task to an epic. Throws if the task already belongs to an epic.
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
   * Archive a task by setting its status to CANCELLED.
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
