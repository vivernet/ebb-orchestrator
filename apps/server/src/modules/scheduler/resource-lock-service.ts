/**
 * Сервис resource locks, управляющий блокировками ресурсов задач.
 */

import type { Database } from "../../platform/database/database.js";
import type { ReservationReleaseResult, SchedulerReconciliationResult } from "./scheduler-types.js";

/**
 * Сервис захвата и освобождения resource locks.
 */
export class ResourceLockService {
  constructor(private readonly db: Database) {}

  /**
   * Пытается захватить resource lock для задачи.
   * Возвращает true при успешном захвате и false, если lock уже удерживает другая задача.
   */
  acquire(taskId: string, _ownerId: string): boolean {
    return this.db.transaction((tx) => {
      // Проверяет, удерживает ли какая-либо задача lock.
      const existing = tx.get<{ reservation_id: string; owner_id: string }>(
        "SELECT reservation_id, owner_id FROM scheduler_resource_locks WHERE resource_key = 'global'",
      );

      if (existing) {
        // Lock уже существует — проверяет, принадлежит ли он той же задаче.
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
   * Освобождает resource lock, удерживаемый задачей.
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
   * Проверяет, удерживает ли задача resource lock.
   */
  isLocked(taskId: string): boolean {
    const lock = this.db.get(
      "SELECT l.resource_key FROM scheduler_resource_locks l JOIN scheduler_reservations r ON r.id=l.reservation_id WHERE l.owner_id=$owner AND r.status='RESERVED'",
      { owner: `task:${taskId}` },
    );
    return !!lock;
  }

  /**
   * Находит и освобождает locks устаревших или завершившихся владельцев.
   * Завершившимися считаются владельцы, чьи задачи отменены, завершены или удалены.
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
          // Осиротевшее или уже освобождённое резервирование не может определить
          // владельца lock. Сохраняет его для authoritative reconciliation.
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
          // Legacy locks сохраняют записанного владельца, который может не быть
          // идентификатором задачи. Их authoritative-связь с задачей — это subject.
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
          // Locks, принадлежащие run, определяются AgentRun и его резервированием,
          // а не соглашением о владельце в форме task.
          const run = tx.get<{ status: string }>("SELECT status FROM agent_runs WHERE id=$runId", { runId });
          const ownsReservation = reservation.run_id === runId || reservation.subject_id === runId;
          if (!ownsReservation) {
            // Несовпадение владельца — свидетельство расхождения, но не доказательство,
            // что одна из сторон устарела. Сохраняет обе долговечные authority,
            // пока владелец не будет определён авторитетно.
            continue;
          }
          dead = !run || ["FAILED", "CANCELLED", "COMPLETED"].includes(run.status);
        } else {
          // Неизвестные форматы владельца не являются владельцами задач. Оставляет их без изменений до
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
