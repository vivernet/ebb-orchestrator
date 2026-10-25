import type { Database } from "../../platform/database/database.js";
import type { ExecutionQueueProjection } from "@ebb-orchestrator/contracts";
import { schedulerEligibility, type SchedulerTaskRow } from "./dashboard-projection.js";
import type { SchedulerService } from "../../modules/scheduler/scheduler-service.js";
import { DEFAULT_SCHEDULER_LIMITS } from "../../modules/scheduler/scheduler-types.js";
interface RunRow { id: string; role: string; task_id: string | null; status: string; }
type TaskRow = SchedulerTaskRow;

/**
 * Формирует read model execution-projection из авторитетного состояния оркестрации для API и UI.
 *
 * Полная проекция очереди выполнения (plan-27 Task 2) по контракту Task 1:
 * current counts, configured/used capacity, удерживаемые resource locks, недавние
 * durable outbox события, причина блокировки/ожидания и dispatch-состояние — все
 * значения берутся из persisted-владельцев, ничего не выдумывается.
 */
export class ExecutionProjection {
  constructor(private readonly db?: Database, private readonly scheduler?: SchedulerService) {}

  get(): ExecutionQueueProjection {
    const { waiting, blocked } = this.queueViews();
    return {
      running: this.running(),
      waiting,
      blocked,
      capacity: this.capacity(),
      locks: this.locks(),
      recentEvents: this.recentEvents(),
      dispatchState: this.scheduler?.getDispatchState() ?? { paused: false, updatedAt: null },
    };
  }

  private running(): ExecutionQueueProjection["running"] {
    if (!this.db) return [];
    return this.db.all<RunRow>("SELECT id,role,task_id,status FROM agent_runs WHERE status IN ('STARTED','IN_PROGRESS','COMPLETING') ORDER BY started_at")
      .map((r) => ({ runId: r.id, role: r.role, taskId: r.task_id, status: r.status }));
  }

  private queueViews(): { waiting: ExecutionQueueProjection["waiting"]; blocked: ExecutionQueueProjection["blocked"] } {
    if (!this.db) return { waiting: [], blocked: [] };
    const tasks = this.db.all<TaskRow>(
      "SELECT id,status,project_id,wait_reason,contract_json FROM tasks WHERE status IN ('WAITING_FOR_DEPENDENCY','WAITING_FOR_APPROVAL','BLOCKED','READY') ORDER BY updated_at",
    );
    const projected = tasks.map((t) => ({ taskId: t.id, eligibility: schedulerEligibility(this.db!, t, this.scheduler) }));
    const waiting = projected.flatMap((entry) => entry.eligibility.status === "WAIT" ? [{ taskId: entry.taskId, reason: entry.eligibility.reason }] : []);
    const blocked = projected.flatMap((entry) => entry.eligibility.status === "BLOCK" ? [{ taskId: entry.taskId, reason: entry.eligibility.reason }] : []);
    return { waiting, blocked };
  }

  private capacity(): ExecutionQueueProjection["capacity"] {
    if (!this.db) return { configured: 0, used: 0 };
    const used = this.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM scheduler_reservations WHERE status='RESERVED' AND kind <> 'LOCK'")?.count ?? 0;
    let configured: number;
    try {
      configured = this.scheduler ? this.scheduler.getLimits().globalMax : DEFAULT_SCHEDULER_LIMITS.globalMax;
    } catch {
      // Fail-closed: при проблеме конфигурации configured не заявляется.
      configured = 0;
    }
    return { configured, used };
  }

  private locks(): ExecutionQueueProjection["locks"] {
    if (!this.db) return [];
    return this.db.all<{ id: string; resource: string; run_id: string | null; subject_id: string; kind: string; locked_at: string }>(
      `SELECT l.resource_key AS id, l.resource_key AS resource, r.run_id, r.subject_id, r.kind, l.locked_at AS locked_at
         FROM scheduler_resource_locks l JOIN scheduler_reservations r ON r.id = l.reservation_id
        WHERE r.status='RESERVED' ORDER BY l.locked_at, l.resource_key`,
    ).map((row) => ({
      id: row.id,
      resource: row.resource,
      // Для TASK-lock без run используется subject_id (идентификатор владельца lock).
      runId: row.run_id ?? row.subject_id,
      kind: row.kind,
      heldAt: row.locked_at,
    }));
  }

  private recentEvents(): ExecutionQueueProjection["recentEvents"] {
    if (!this.db || !this.db.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='outbox_events'")) return [];
    return this.db.all<{ id: string; type: string; created_at: string }>(
      "SELECT id, type, created_at FROM outbox_events ORDER BY created_at DESC, id DESC LIMIT 20",
    ).map((row) => ({ id: row.id, type: row.type, createdAt: row.created_at }));
  }
}
