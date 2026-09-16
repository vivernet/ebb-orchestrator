/**
 * Resource lock service - manages resource locks for tasks.
 */

import type { Database } from "../../platform/database/database.js";

interface ResourceLockRow {
  id: string;
  task_id: string;
  locked_at: string;
  owner_id: string;
}

/**
 * Service for acquiring and releasing resource locks.
 */
export class ResourceLockService {
  constructor(private readonly db: Database) {}

  /**
   * Attempt to acquire a resource lock for a task.
   * Returns true if the lock was acquired, false if already held by another task.
   */
  acquire(taskId: string, ownerId: string): boolean {
    return this.db.transaction((tx) => {
      // Check if any task currently holds the lock
      const existing = tx.get<ResourceLockRow>(
        "SELECT id, task_id, locked_at, owner_id FROM resource_locks WHERE id = 'global'",
      );

      if (existing) {
        // Lock already exists - check if it's for the same task
        if (existing.task_id === taskId) {
          return true; // Same task already holds it
        }
        return false; // Another task holds it
      }

      // No lock exists - acquire it
      const now = new Date().toISOString();
      tx.run(
        "INSERT INTO resource_locks (id, task_id, locked_at, owner_id) VALUES ('global', $task_id, $locked_at, $owner_id)",
        { task_id: taskId, locked_at: now, owner_id: ownerId },
      );
      return true;
    });
  }

  /**
   * Release a resource lock held by a task.
   */
  release(taskId: string): void {
    this.db.run(
      "DELETE FROM resource_locks WHERE task_id = $task_id",
      { task_id: taskId },
    );
  }

  /**
   * Check if a task currently holds a resource lock.
   */
  isLocked(taskId: string): boolean {
    const lock = this.db.get(
      "SELECT id FROM resource_locks WHERE task_id = $task_id",
      { task_id: taskId },
    );
    return !!lock;
  }

  /**
   * Find and release locks owned by stale/dead owners.
   * Dead owners are those whose tasks have been cancelled/completed/deleted.
   */
  reconcileDeadOwners(): void {
    const locks = this.db.all<{ id: string; task_id: string; owner_id: string }>(
      "SELECT id, task_id, owner_id FROM resource_locks",
    );

    for (const lock of locks) {
      // Check if owner task still exists and is active
      const task = this.db.get(
        "SELECT id, status FROM tasks WHERE id = $id",
        { id: lock.task_id },
      );

      if (!task || task.status === "CANCELLED" || task.status === "DONE" || task.status === "FAILED") {
        // Owner task is dead - release the lock
        this.db.run(
          "DELETE FROM resource_locks WHERE id = $id",
          { id: lock.id },
        );
      }
    }
  }
}
