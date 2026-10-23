/**
 * Сервис восстановления - управляет решениями восстановления и создаёт scheduler requests.
 * Никогда calls runtime directly; always creates new scheduler requests.
 */

import { createHash } from "node:crypto";
import type { Database, DatabaseTx } from "../../platform/database/database.js";
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
   *
   * Решение принимается policy-движком evaluateRecovery(context, policy) и durable фиксируется
   * в recovery_attempts; RETRY/RESUME_SAME_SESSION сохраняют ту же роль и idempotency key,
   * эскалация Middle→Senior создаёт request с ролью senior_dev, а решения без нового request
   * (COORDINATOR_DIAGNOSIS/BLOCK) переводят задачу в финальное состояние.
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
      // Задачи, явно заблокированные recovery, не перепопыткиваются.
      if (tx.get("SELECT id FROM recovery_state WHERE task_id=$id AND status='BLOCKED'", { id: source.task_id })) return undefined;
      if (tx.get("SELECT id FROM scheduler_run_requests WHERE task_id=$id AND status='PENDING'", { id: source.task_id })) return undefined;

      const roleLevel = roleLevelForRequestRole(source.role);
      if (!roleLevel) return undefined;
      const context: RecoveryContext = {
        taskId: source.task_id,
        currentRoleLevel: roleLevel,
        failureType: this.resolveFailureType(runId),
        attempts: this.getHistory(source.task_id),
      };
      const decision = evaluateRecovery(context, this.policy);
      // Каждое решение durable фиксируется до любых побочных действий.
      this.recordAttemptInTransaction(tx, context);

      switch (decision.decision) {
        case "RETRY":
        case "RESUME_SAME_SESSION": {
          // RETRY/RESUME_SAME_SESSION сохраняют ту же роль и тот же idempotency key.
          if (!stageRetry) this.prepareTaskForRetryTx(tx, workflow, source);
          return this.enqueueRecoveryRequest(tx, scheduler, source, key, runId, source.role);
        }
        case "ESCALATE_ROLE": {
          const targetRole = escalatedRoleFor(source.role, decision.nextRoleLevel);
          if (targetRole) {
            if (!stageRetry) this.prepareTaskForRetryTx(tx, workflow, source);
            return this.enqueueRecoveryRequest(tx, scheduler, source, key, runId, targetRole);
          }
          // Роли без senior-варианта (reviewer/qa/integration) не эскалируются:
          // консервативно завершаем задачу без нового retry.
          this.finalizeTaskNoRetry(tx, workflow, source.task_id, "FAILED", decision.reason);
          return undefined;
        }
        case "COORDINATOR_DIAGNOSIS":
          this.finalizeTaskNoRetry(tx, workflow, source.task_id, "FAILED", decision.reason);
          return undefined;
        case "BLOCK":
          this.finalizeTaskNoRetry(tx, workflow, source.task_id, "BLOCKED", decision.reason);
          return undefined;
        default:
          return undefined;
      }
    });
  }

  /** Startup/safety scan ловит crash до event acknowledgement; retry source IDs читаются из durable queue bindings. */
  recoverTaskRunRequests(scheduler: SchedulerService, workflow: WorkflowEngine): void {
    const runs = this.db.all<{ id: string }>(`SELECT r.id FROM agent_runs r JOIN scheduler_run_requests q ON q.run_id=r.id
      WHERE q.status='DISPATCHED' AND r.status IN ('FAILED','CANCELLED') ORDER BY r.id`);
    for (const run of runs) this.enqueueTaskRetry(run.id, scheduler, workflow);
  }

  /**
   * Классифицирует тип сбоя для policy-оценки.
   * На уровне scheduler-run источник сбоя не хранит типизированный failure type,
   * поэтому по умолчанию используется TASK_FAILURE; параметр runId оставлен как
   * точка расширения для передачи реального типа из будущего источника.
   */
  private resolveFailureType(_runId: string): FailureType {
    return "TASK_FAILURE";
  }

  /** Переводит задачу в BLOCKED→READY перед новым retry-запросом разработчика. */
  private prepareTaskForRetryTx(
    tx: DatabaseTx,
    workflow: WorkflowEngine,
    source: { task_id: string; task_status: string },
  ): void {
    if (source.task_status === "DEVELOPMENT") workflow.transitionInTransaction(tx, source.task_id, "BLOCKED");
    if (source.task_status !== "READY") workflow.transitionInTransaction(tx, source.task_id, "READY");
  }

  /** Создаёт source-bound retry-запрос после освобождения резервации. */
  private enqueueRecoveryRequest(
    tx: DatabaseTx,
    scheduler: SchedulerService,
    source: { task_id: string; model: string },
    key: string,
    runId: string,
    role: string,
  ): SchedulerRunRequest {
    const release = scheduler.releaseTaskInTransaction(tx, source.task_id);
    if (release.status === "BLOCKED_OWNERSHIP_DRIFT") throw new Error("RUN_RECOVERY_RESERVATION_OWNERSHIP_DRIFT");
    return scheduler.enqueueRunRequestInTransaction(tx, { taskId: source.task_id, role, model: source.model,
      idempotencyKey: key, originType: "TASK_RECOVERY", originId: runId });
  }

  /**
   * Завершает задачу без нового retry: перевод в терминальный FAILED либо BLOCKED
   * с durable recovery_state. Если шаблон workflow не разрешает переход, задача
   * блокируется через recovery_state, чтобы повторная обработка не дублировала записи.
   */
  private finalizeTaskNoRetry(
    tx: DatabaseTx,
    workflow: WorkflowEngine,
    taskId: string,
    terminal: "FAILED" | "BLOCKED",
    reason: string,
  ): void {
    if (workflow.canTransition(taskId, terminal)) {
      workflow.transitionInTransaction(tx, taskId, terminal);
    } else {
      this.blockTaskInTransaction(tx, taskId, reason);
    }
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
    return this.db.transaction((tx) => this.recordAttemptInTransaction(tx, context, fingerprint));
  }

  /** Внутренняя реализация recordAttempt внутри активной транзакции caller. */
  private recordAttemptInTransaction(tx: DatabaseTx, context: RecoveryContext, fingerprint?: ProgressFingerprint): RecoveryAttempt {
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
    this.db.transaction((tx) => this.blockTaskInTransaction(tx, taskId, reason));
  }

  /** Внутренняя реализация blockTask внутри активной транзакции caller. */
  private blockTaskInTransaction(tx: DatabaseTx, taskId: string, reason: string): void {
    const existing = tx.get(
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

/**
 * Определяет уровень роли для policy-оценки по роли scheduler-запроса.
 * Review/QA/Integration выполняются на middle-уровне; senior_dev — на senior.
 */
function roleLevelForRequestRole(role: string): RoleLevel | undefined {
  if (role === "developer" || role === "reviewer" || role === "qa" || role === "integration") return "middle";
  if (role === "senior_dev") return "senior";
  return undefined;
}

/**
 * Возвращает роль scheduler-запроса при эскалации уровня.
 * Middle→Senior для разработчика маппится на роль senior_dev; у остальных ролей
 * senior-варианта нет, поэтому они возвращают undefined.
 */
function escalatedRoleFor(role: string, nextRoleLevel: RoleLevel | undefined): string | undefined {
  if (nextRoleLevel === "senior" && role === "developer") return "senior_dev";
  return undefined;
}
