/**
 * Сервис восстановления - управляет решениями восстановления и создаёт scheduler requests.
 * Никогда calls runtime directly; always creates new scheduler requests.
 */

import { createHash } from "node:crypto";
import type { Database } from "../../platform/database/database.js";
import type {
  RecoveryContext,
  RecoveryResult,
  RoleLevel,
  RecoveryPolicy,
  RecoveryAttempt,
  ProgressFingerprint,
  FailureType,
} from "./recovery-types.js";
import { evaluateRecovery, getRemainingAttempts } from "./recovery-policy.js";
import type { SchedulerService } from "../scheduler/scheduler-service.js";
import type { WorkflowEngine } from "../workflow/workflow-engine.js";
import type { SchedulerRunRequest } from "../scheduler/scheduler-run-request-repository.js";
import { getRunProcessOwner, isAuthoritativeRunProcessStopEvidence } from "../runtime/run-process-owner.js";

/**
 * Scheduler запрос для recovery работа.
 */
export interface RecoverySchedulerRequest {
  taskId: string;
  roleLevel: RoleLevel;
  failureType: string;
  attemptCount: number;
}

/**
 * Сервис восстановления для managing задача recovery decisions.
 */
export class RecoveryService {
  constructor(
    private db: Database,
    private policy: RecoveryPolicy,
  ) {}

  /**
   * Создаёт новую Task попытку только для точного failed/cancelled queue Run с STOPPED proof.
   * Source Run является постоянным attempt key; replay не создаёт новый request и не выполняет runtime.
   * Epic/Request phase Runs без пользовательского request здесь не рассматриваются.
   */
  enqueueTaskRetry(runId: string, scheduler: SchedulerService, workflow: WorkflowEngine): SchedulerRunRequest | undefined {
    return this.db.transaction((tx) => {
      const source = tx.get<{ task_id: string; role: string; model: string; status: string; task_status: string; epic_id: string | null }>(
        `SELECT r.task_id,q.role,q.model,r.status,t.status AS task_status,t.epic_id FROM agent_runs r
         JOIN scheduler_run_requests q ON q.run_id=r.id AND q.task_id=r.task_id AND q.status='DISPATCHED'
         JOIN tasks t ON t.id=r.task_id WHERE r.id=$runId`, { runId });
      if (!source || source.epic_id !== null || !["FAILED", "CANCELLED"].includes(source.status)) return undefined;
      const owner = getRunProcessOwner(tx, runId);
      if (!owner || owner.state !== "STOPPED" || !isAuthoritativeRunProcessStopEvidence(owner.stopEvidence, owner.containmentKind)) return undefined;
      const key = `task-recovery:${runId}`;
      const existing = tx.get<{ id: string }>("SELECT id FROM scheduler_run_requests WHERE idempotency_key=$key", { key });
      if (existing) return scheduler.getRunRequest(source.task_id, existing.id);
      const stageRetry = source.role === "reviewer" && source.task_status === "REVIEW" ||
        source.role === "qa" && source.task_status === "QA" ||
        source.role === "integration" && source.task_status === "INTEGRATION";
      if (!stageRetry && !["DEVELOPMENT", "BLOCKED", "READY"].includes(source.task_status)) return undefined;
      const count = tx.get<{ count: number }>("SELECT count(*) AS count FROM scheduler_run_requests WHERE task_id=$id AND origin_type='TASK_RECOVERY'", { id: source.task_id })?.count ?? 0;
      if (count >= this.policy.middleAttempts) return undefined;
      if (tx.get("SELECT id FROM scheduler_run_requests WHERE task_id=$id AND status='PENDING'", { id: source.task_id })) return undefined;
      if (!stageRetry) {
        if (source.task_status === "DEVELOPMENT") workflow.transitionInTransaction(tx, source.task_id, "BLOCKED");
        if (source.task_status !== "READY") workflow.transitionInTransaction(tx, source.task_id, "READY");
      }
      const release = scheduler.releaseTaskInTransaction(tx, source.task_id);
      if (release.status === "BLOCKED_OWNERSHIP_DRIFT") throw new Error("RUN_RECOVERY_RESERVATION_OWNERSHIP_DRIFT");
      return scheduler.enqueueRunRequestInTransaction(tx, { taskId: source.task_id, role: source.role, model: source.model,
        idempotencyKey: key, originType: "TASK_RECOVERY", originId: runId });
    });
  }

  /** Startup/safety scan ловит crash до event acknowledgement; retry source IDs читаются из durable queue bindings. */
  recoverTaskRunRequests(scheduler: SchedulerService, workflow: WorkflowEngine): void {
    const runs = this.db.all<{ id: string }>(`SELECT r.id FROM agent_runs r JOIN scheduler_run_requests q ON q.run_id=r.id
      WHERE q.status='DISPATCHED' AND r.status IN ('FAILED','CANCELLED') ORDER BY r.id`);
    for (const run of runs) this.enqueueTaskRetry(run.id, scheduler, workflow);
  }

  /**
   * Вычисляет решение восстановления для Объект задача.
   */
  evaluate(context: RecoveryContext): RecoveryResult {
    return evaluateRecovery(context, this.policy);
  }

  /**
   * записи Объект recovery попытка.
   */
  recordAttempt(context: RecoveryContext, fingerprint?: ProgressFingerprint): RecoveryAttempt {
    const failureType = context.failureType;
    const roleLevel = context.currentRoleLevel;

    // Подсчитывает existing attempts for this role/failure combo
    const existingAttempts = context.attempts.filter(
      (a) => a.roleLevel === roleLevel && a.failureType === failureType,
    ).length;

    const attempt: RecoveryAttempt = {
      taskId: context.taskId,
      roleLevel,
      failureType,
      attemptCount: existingAttempts + 1,
      timestamp: new Date().toISOString(),
      ...(fingerprint !== undefined && { fingerprint }),
    };

    // Persist to база данных
    this.db.transaction((tx) => {
      tx.run(
        `INSERT INTO recovery_attempts (id, task_id, role_level, failure_type, attempt_count, recorded_at, fingerprint)
         VALUES ($id, $task_id, $role_level, $failure_type, $attempt_count, $recorded_at, $fingerprint)`,
        {
          id: this.generateId(),
          task_id: context.taskId,
          role_level: roleLevel,
          failure_type: failureType,
          attempt_count: attempt.attemptCount,
          recorded_at: attempt.timestamp,
          fingerprint: fingerprint ? JSON.stringify(fingerprint) : null,
        },
      );
    });

    return attempt;
  }

  /**
   * создаёт Объект scheduler запрос для recovery.
   * Никогда calls runtime directly.
   */
  createSchedulerRequest(
    taskId: string,
    roleLevel: RoleLevel,
    failureType: string,
  ): RecoverySchedulerRequest {
    // Подсчитывает existing recovery requests for this task
    const existingCount = this.db.get(
      `SELECT COUNT(*) as count FROM recovery_scheduler_requests 
       WHERE task_id = $task_id AND resolved_at IS NULL`,
      { task_id: taskId },
    ) as { count: number } | undefined;

    const request: RecoverySchedulerRequest = {
      taskId,
      roleLevel,
      failureType,
      attemptCount: (existingCount?.count ?? 0) + 1,
    };

    // Persist to база данных
    this.db.transaction((tx) => {
      tx.run(
        `INSERT INTO recovery_scheduler_requests (id, task_id, role_level, failure_type, attempt_count, created_at)
         VALUES ($id, $task_id, $role_level, $failure_type, $attempt_count, $created_at)`,
        {
          id: this.generateId(),
          task_id: taskId,
          role_level: roleLevel,
          failure_type: failureType,
          attempt_count: request.attemptCount,
          created_at: new Date().toISOString(),
        },
      );
    });

    return request;
  }

  /**
   * Получает историю восстановления для Объект задача.
   */
  getHistory(taskId: string): RecoveryAttempt[] {
    const rows = this.db.all(
      `SELECT * FROM recovery_attempts WHERE task_id = $task_id ORDER BY recorded_at DESC`,
      { task_id: taskId },
    ) as Array<{
      id: string;
      task_id: string;
      role_level: RoleLevel;
      failure_type: string;
      attempt_count: number;
      recorded_at: string;
      fingerprint: string | null;
    }>;

    return rows.map((row) => ({
      taskId: row.task_id,
      roleLevel: row.role_level,
      failureType: row.failure_type as FailureType,
      attemptCount: row.attempt_count,
      timestamp: row.recorded_at,
      ...(row.fingerprint !== null && {
        fingerprint: JSON.parse(row.fingerprint) as ProgressFingerprint,
      }),
    }));
  }

  /**
   * Получает оставшиеся попытки для Объект задача at Объект указанного роль уровень.
   */
  getRemainingAttempts(
    taskId: string,
    roleLevel: RoleLevel,
    failureType: string,
  ): number {
    const attempts = this.getHistory(taskId);
    return getRemainingAttempts(attempts, roleLevel, failureType as FailureType, this.policy);
  }

  /**
   * Проверяет, Объект задача является blocked из recovery.
   */
  isBlocked(taskId: string): boolean {
    const row = this.db.get(
      `SELECT status FROM recovery_state WHERE task_id = $task_id`,
      { task_id: taskId },
    ) as { status: string } | undefined;

    return row?.status === "BLOCKED";
  }

  /**
   * Blocks Объект задача из дальнейших recovery попытки.
   */
  blockTask(taskId: string, reason: string): void {
    this.db.transaction((tx) => {
      const existing = this.db.get(
        `SELECT * FROM recovery_state WHERE task_id = $task_id`,
        { task_id: taskId },
      );

      if (existing) {
        tx.run(
          `UPDATE recovery_state SET status = 'BLOCKED', reason = $reason, updated_at = $updated_at WHERE task_id = $task_id`,
          {
            reason,
            updated_at: new Date().toISOString(),
            task_id: taskId,
          },
        );
      } else {
        tx.run(
          `INSERT INTO recovery_state (id, task_id, status, reason, created_at, updated_at)
           VALUES ($id, $task_id, $status, $reason, $created_at, $updated_at)`,
          {
            id: this.generateId(),
            task_id: taskId,
            status: "BLOCKED",
            reason,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        );
      }
    });
  }

  /**
   * Generates Объект unique ID.
   */
  private generateId(): string {
    return createHash("sha256")
      .update(`${Date.now()}-${Math.random()}`)
      .digest("hex")
      .slice(0, 32);
  }
}
