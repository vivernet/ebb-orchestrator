/**
 * Dependency service – manages task dependencies with cycle detection.
 */

import type { Database } from "../../platform/database/database.js";
import type { DatabaseTx } from "../../platform/database/database.js";

export interface TaskDependency {
  readonly id: string;
  readonly taskId: string;
  readonly dependsOnTaskId: string;
  readonly type: "BLOCKING";
  readonly createdAt: string;
}

interface DependencyRow {
  id: string;
  task_id: string;
  depends_on_task_id: string;
  type: string;
  created_at: string;
}

function rowToDependency(row: DependencyRow): TaskDependency {
  return {
    id: row.id,
    taskId: row.task_id,
    dependsOnTaskId: row.depends_on_task_id,
    type: row.type as "BLOCKING",
    createdAt: row.created_at,
  };
}

/**
 * Экспортируемый компонент или контракт модуля, доступный другим слоям приложения.
 */
export class DependencyService {
  constructor(private readonly db: Database) {}

  /**
   * Add a blocking dependency: `taskId` depends on `dependsOnTaskId`.
   * Throws on self-dependency, duplicates, or cycles.
   */
  addBlockingDependency(taskId: string, dependsOnTaskId: string): TaskDependency {
    return this.db.transaction((tx) => {
      if (taskId === dependsOnTaskId) {
        throw new Error("Task cannot depend on itself");
      }

      // Check for duplicate
      const existing = tx.get<{ id: string }>(
        "SELECT id FROM dependencies WHERE task_id = $task_id AND depends_on_task_id = $depends_on_task_id",
        { task_id: taskId, depends_on_task_id: dependsOnTaskId },
      );
      if (existing) {
        throw new Error("Dependency already exists");
      }

      // Check for cycle by walking the dependency graph from dependsOnTaskId
      if (this.wouldCreateCycle(tx, taskId, dependsOnTaskId)) {
        throw new Error("Adding this dependency would create a cycle");
      }

      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      tx.run(
        `INSERT INTO dependencies (id, task_id, depends_on_task_id, type, created_at)
         VALUES ($id, $task_id, $depends_on_task_id, $type, $created_at)`,
        {
          id,
          task_id: taskId,
          depends_on_task_id: dependsOnTaskId,
          type: "BLOCKING",
          created_at: now,
        },
      );

      return { id, taskId, dependsOnTaskId, type: "BLOCKING", createdAt: now };
    });
  }

  /**
   * Remove a dependency between two tasks.
   */
  removeDependency(taskId: string, dependsOnTaskId: string): void {
    this.db.transaction((tx) => {
      tx.run(
        "DELETE FROM dependencies WHERE task_id = $task_id AND depends_on_task_id = $depends_on_task_id",
        { task_id: taskId, depends_on_task_id: dependsOnTaskId },
      );
    });
  }

  /**
   * List all dependencies for a task (tasks it depends on).
   */
  listDependencies(taskId: string): TaskDependency[] {
    const rows = this.db.all<DependencyRow>(
      "SELECT * FROM dependencies WHERE task_id = $task_id",
      { task_id: taskId },
    );
    return rows.map(rowToDependency);
  }

  /**
   * List all dependents (tasks that depend on the given task).
   */
  listDependents(taskId: string): TaskDependency[] {
    const rows = this.db.all<DependencyRow>(
      "SELECT * FROM dependencies WHERE depends_on_task_id = $depends_on_task_id",
      { depends_on_task_id: taskId },
    );
    return rows.map(rowToDependency);
  }

  /**
   * Detect whether adding an edge from `newDependentId` → `dependencyId`
   * (i.e., newDependentId depends on dependencyId) would create a cycle.
   *
   * A cycle exists iff dependencyId can already reach newDependentId
   * via the existing dependency graph.
   */
  private wouldCreateCycle(
    tx: DatabaseTx,
    newDependentId: string,
    dependencyId: string,
  ): boolean {
    // BFS/DFS from dependencyId following "depends_on" edges.
    // If we reach newDependentId, adding the edge would close a cycle.
    const visited = new Set<string>();
    const stack = [dependencyId];

    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === newDependentId) {
        return true;
      }
      if (visited.has(current)) {
        continue;
      }
      visited.add(current);

      const upstream = tx.all<{ depends_on_task_id: string }>(
        "SELECT depends_on_task_id FROM dependencies WHERE task_id = $task_id",
        { task_id: current },
      );
      for (const row of upstream) {
        stack.push(row.depends_on_task_id);
      }
    }

    return false;
  }
}
