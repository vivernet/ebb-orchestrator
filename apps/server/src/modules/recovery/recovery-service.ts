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
