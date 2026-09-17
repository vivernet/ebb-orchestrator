/**
 * Resource lock service - manages resource locks for tasks.
 */

import type { Database } from "../../platform/database/database.js";
import type { ReservationReleaseResult, SchedulerReconciliationResult } from "./scheduler-types.js";

/**
 * Service for acquiring and releasing resource locks.
 */
export class ResourceLockService {
  constructor(private readonly db: Database) {}

  /**
   * Attempt to acquire a resource lock for a task.
   * Returns true if the lock was acquired, false if already held by another task.
   */
  acquire(taskId: string, _ownerId: string): boolean {
    return this.db.transaction((tx) => {
      // Check if any task currently holds the lock
      const existing = tx.get<{ reservation_id: string; owner_id: string }>(
        "SELECT reservation_id, owner_id FROM scheduler_resource_locks WHERE resource_key = 'global'",
      );

      if (existing) {
        // Lock already exists - check if it's for the same task
        if (existing.owner_id === `task:${taskId}`) {
          return true; // Same task already holds it
        }
        return false; // Another task holds it
      }

      const now = new Date().toISOString();
      const task = tx.get<{ project_id: string }>("SELECT project_id FROM tasks WHERE id=$taskId", { taskId });
      if (!task) return false;
      const reservationId = crypto.randomUUID();
      tx.run("INSERT INTO scheduler_reservations(id,kind,subject_id,project_id,owner_id,reserved_at,estimate_cost,status,role,model) VALUES($id,'LOCK',$subject,$project,$owner,$at,0,'RESERVED','lock','lock')", { id: reservationId, subject: `lock:${taskId}`, project: task.project_id, owner: `task:${taskId}`, at: now });
      tx.run("INSERT INTO scheduler_resource_locks(resource_key,reservation_id,project_id,owner_id,locked_at) VALUES('global',$id,$project,$owner,$at)", { id: reservationId, project: task.project_id, owner: `task:${taskId}`, at: now });
      return true;
    });
  }

  /**
   * Release a resource lock held by a task.
   */
  release(taskId: string): ReservationReleaseResult {
    return this.db.transaction((tx) => {
      const reservation = tx.get<{ id: string; owner_id: string }>("SELECT id,owner_id FROM scheduler_reservations WHERE subject_id=$subject AND status='RESERVED'", { subject: `lock:${taskId}` });
      if (!reservation) return { status: "ALREADY_RELEASED" };
      const ownershipDrift = tx.get(
        "SELECT 1 FROM scheduler_resource_locks WHERE reservation_id=$id AND owner_id<>$owner LIMIT 1",
        { id: reservation.id, owner: reservation.owner_id },
      );
      if (ownershipDrift) {
        return { status: "BLOCKED_OWNERSHIP_DRIFT", reservationId: reservation.id };
      }
      tx.run("DELETE FROM scheduler_resource_locks WHERE reservation_id=$id", { id: reservation.id });
      tx.run("UPDATE scheduler_reservations SET status='RELEASED' WHERE id=$id AND status='RESERVED'", { id: reservation.id });
      return { status: "RELEASED", reservationId: reservation.id };
    });
  }

  /**
   * Check if a task currently holds a resource lock.
   */
  isLocked(taskId: string): boolean {
    const lock = this.db.get(
      "SELECT l.resource_key FROM scheduler_resource_locks l JOIN scheduler_reservations r ON r.id=l.reservation_id WHERE l.owner_id=$owner AND r.status='RESERVED'",
      { owner: `task:${taskId}` },
    );
    return !!lock;
  }

  /**
   * Find and release locks owned by stale/dead owners.
   * Dead owners are those whose tasks have been cancelled/completed/deleted.
   */
  reconcileDeadOwners(): SchedulerReconciliationResult {
    return this.db.transaction((tx) => {
      const result: SchedulerReconciliationResult = { releasedReservationIds: [], blockedReservationIds: [] };
      const reservationIds = tx.all<{ reservation_id: string }>(
        "SELECT DISTINCT reservation_id FROM scheduler_resource_locks ORDER BY reservation_id",
      );
      const hasAgentRuns = Boolean(tx.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_runs'"));

      for (const { reservation_id } of reservationIds) {
        const reservation = tx.get<{ id: string; status: string; project_id: string; estimate_cost: number; run_id: string | null; subject_id: string; kind: string; owner_id: string }>(
          "SELECT id,status,project_id,estimate_cost,run_id,subject_id,kind,owner_id FROM scheduler_reservations WHERE id=$id",
          { id: reservation_id },
        );
        if (!reservation || reservation.status !== "RESERVED") {
          // An orphaned or already-released reservation cannot establish the
          // lock's owner. Preserve it for authoritative reconciliation.
          result.blockedReservationIds.push(reservation_id);
          continue;
        }
        const ownershipDrift = tx.get(
          "SELECT 1 FROM scheduler_resource_locks WHERE reservation_id=$id AND owner_id<>$owner LIMIT 1",
          { id: reservation.id, owner: reservation.owner_id },
        );
        if (ownershipDrift) {
          result.blockedReservationIds.push(reservation.id);
          continue;
        }

        let dead: boolean;
        if (reservation.kind === "LOCK" && reservation.subject_id.startsWith("lock:")) {
          // Legacy locks retain their recorded owner, which may not be a task
          // identifier. Their authoritative task association is the subject.
          const taskId = reservation.subject_id.slice("lock:".length);
          const task = tx.get<{ status: string }>("SELECT status FROM tasks WHERE id=$id", { id: taskId });
          dead = !task || ["CANCELLED", "DONE", "FAILED", "INTEGRATED_INTO_EPIC", "RELEASED"].includes(task.status);
        } else if (reservation.owner_id.startsWith("task:")) {
          const taskId = reservation.owner_id.slice("task:".length);
          const task = tx.get<{ status: string }>("SELECT status FROM tasks WHERE id=$id", { id: taskId });
          dead = !task || ["CANCELLED", "DONE", "FAILED", "INTEGRATED_INTO_EPIC", "RELEASED"].includes(task.status);
        } else if (reservation.owner_id.startsWith("run:")) {
          if (!hasAgentRuns) continue;
          const runId = reservation.owner_id.slice("run:".length);
          // Run-owned locks are governed by the AgentRun and its reservation,
          // not by the task-shaped owner convention.
          const run = tx.get<{ status: string }>("SELECT status FROM agent_runs WHERE id=$runId", { runId });
          const ownsReservation = reservation.run_id === runId || reservation.subject_id === runId;
          if (!ownsReservation) {
            // A mismatched owner is evidence of drift, not proof that either
            // side is stale. Preserve both durable authorities until the
            // owner can be established authoritatively.
            continue;
          }
          dead = !run || ["FAILED", "CANCELLED", "COMPLETED"].includes(run.status);
        } else {
          // Unknown owner formats are not task owners. Leave them intact until
          // their reservation authority can reconcile them safely.
          continue;
        }

        if (dead) {
          tx.run("UPDATE scheduler_budgets SET reserved_cost=MAX(0,reserved_cost-$estimate) WHERE project_id=$projectId", { projectId: reservation.project_id, estimate: reservation.estimate_cost });
          tx.run("DELETE FROM scheduler_resource_locks WHERE reservation_id=$id", { id: reservation.id });
          tx.run("UPDATE scheduler_reservations SET status='RELEASED',actual_cost=0 WHERE id=$id AND status='RESERVED'", { id: reservation.id });
          result.releasedReservationIds.push(reservation.id);
        }
      }
      return result;
    });
  }
}
