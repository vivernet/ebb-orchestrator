import { randomUUID } from "node:crypto";
import type { Database, DatabaseTx } from "../../platform/database/database.js";

export type SchedulerRunRequestStatus = "PENDING" | "DISPATCHED" | "FAILED";
export type SchedulerRunRequestOrigin = "TASK_API" | "TASK_RECOVERY" | "TASK_STAGE";

export interface SchedulerRunRequest {
  readonly id: string;
  readonly taskId: string;
  readonly idempotencyKey: string;
  readonly role: string;
  readonly model: string;
  /** Опциональная явная привязка провайдера (plan-24 Task 5); NULL — legacy-путь. */
  readonly providerId: string | null;
  readonly authMethodId: string | null;
  readonly originType: SchedulerRunRequestOrigin;
  readonly originId: string;
  readonly status: SchedulerRunRequestStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly runId: string | null;
  readonly failureCode: string | null;
}

export interface EnqueueSchedulerRunRequest {
  readonly taskId: string;
  readonly idempotencyKey: string;
  readonly role: string;
  readonly model: string;
  readonly providerId?: string | null;
  readonly authMethodId?: string | null;
  readonly originType: SchedulerRunRequestOrigin;
  readonly originId: string;
}

interface SchedulerRunRequestRow {
  id: string; task_id: string; idempotency_key: string; role: string; model: string;
  provider_id: string | null; auth_method_id: string | null;
  origin_type: SchedulerRunRequestOrigin; origin_id: string; status: SchedulerRunRequestStatus;
  created_at: string; updated_at: string; run_id: string | null; failure_code: string | null;
}

function project(row: SchedulerRunRequestRow): SchedulerRunRequest {
  return {
    id: row.id, taskId: row.task_id, idempotencyKey: row.idempotency_key, role: row.role,
    model: row.model, providerId: row.provider_id, authMethodId: row.auth_method_id,
    originType: row.origin_type, originId: row.origin_id, status: row.status,
    createdAt: row.created_at, updatedAt: row.updated_at, runId: row.run_id, failureCode: row.failure_code,
  };
}

/** Хранит и дедуплицирует пользовательские намерения запуска Task. */
export class SchedulerRunRequestRepository {
  constructor(private readonly db: Database, private readonly clock: () => Date = () => new Date()) {}

  /** Сохраняет запрос либо возвращает исходный запрос при точном повторе ключа. */
  enqueue(input: EnqueueSchedulerRunRequest): SchedulerRunRequest {
    validateInput(input);
    return this.db.transaction((tx) => this.enqueueInTransaction(tx, input));
  }

  enqueueInTransaction(tx: DatabaseTx, input: EnqueueSchedulerRunRequest): SchedulerRunRequest {
    validateInput(input);
    const existing = tx.get<SchedulerRunRequestRow>(
      "SELECT * FROM scheduler_run_requests WHERE idempotency_key=$key", { key: input.idempotencyKey },
    );
    if (existing) {
      if (!samePayload(existing, input)) throw new Error("RUN_REQUEST_IDEMPOTENCY_CONFLICT");
      return project(existing);
    }

    const id = randomUUID();
    const now = this.clock().toISOString();
    try {
      tx.run(`INSERT INTO scheduler_run_requests
        (id,task_id,idempotency_key,role,model,provider_id,auth_method_id,origin_type,origin_id,status,created_at,updated_at)
        VALUES($id,$taskId,$key,$role,$model,$providerId,$authMethodId,$originType,$originId,'PENDING',$now,$now)`, {
        id, taskId: input.taskId, key: input.idempotencyKey, role: input.role, model: input.model,
        providerId: input.providerId ?? null, authMethodId: input.authMethodId ?? null,
        originType: input.originType, originId: input.originId, now,
      });
    } catch (error) {
      const pending = tx.get<{ id: string }>(
        "SELECT id FROM scheduler_run_requests WHERE task_id=$taskId AND status='PENDING'", { taskId: input.taskId },
      );
      if (pending) throw new Error("RUN_REQUEST_ALREADY_PENDING", { cause: error });
      throw error;
    }
    return project(tx.get<SchedulerRunRequestRow>("SELECT * FROM scheduler_run_requests WHERE id=$id", { id })!);
  }

  get(taskId: string, requestId: string): SchedulerRunRequest | undefined {
    const row = this.db.get<SchedulerRunRequestRow>(
      "SELECT * FROM scheduler_run_requests WHERE task_id=$taskId AND id=$requestId", { taskId, requestId },
    );
    return row ? project(row) : undefined;
  }

  /** Читает очередь из caller snapshot, не изменяя request lifecycle. */
  pending(source: DatabaseTx = this.db): SchedulerRunRequest[] {
    return source.all<SchedulerRunRequestRow>("SELECT * FROM scheduler_run_requests WHERE status='PENDING' ORDER BY created_at,id").map(project);
  }

  /** Завершает выбранный request вместе с Run/reservation/outbox в одной transaction. */
  dispatchInTransaction(tx: DatabaseTx, requestId: string, runId: string): void {
    tx.run("UPDATE scheduler_run_requests SET status='DISPATCHED',run_id=$runId,updated_at=$now WHERE id=$id AND status='PENDING'", {
      id: requestId, runId, now: this.clock().toISOString(),
    });
    if (tx.get<{ changes: number }>("SELECT changes() AS changes")?.changes !== 1) throw new Error("RUN_REQUEST_CLAIM_CONFLICT");
  }

  /** Терминализирует только детерминированную integrity failure; raw exception не сохраняется. */
  fail(requestId: string, failureCode: string): void {
    if (!/^RUN_REQUEST_[A-Z_]{1,80}$/.test(failureCode)) throw new Error("RUN_REQUEST_FAILURE_CODE_INVALID");
    this.db.run("UPDATE scheduler_run_requests SET status='FAILED',failure_code=$code,updated_at=$now WHERE id=$id AND status='PENDING'", {
      id: requestId, code: failureCode, now: this.clock().toISOString(),
    });
  }
}

function validateInput(input: EnqueueSchedulerRunRequest): void {
  for (const [name, value] of Object.entries({
    taskId: input.taskId, idempotencyKey: input.idempotencyKey, role: input.role, model: input.model, originId: input.originId,
  })) {
    if (typeof value !== "string" || value.trim() === "") throw new Error(`RUN_REQUEST_${name.toUpperCase()}_INVALID`);
  }
  if (input.originType !== "TASK_API" && input.originType !== "TASK_RECOVERY" && input.originType !== "TASK_STAGE") throw new Error("RUN_REQUEST_ORIGIN_INVALID");
}

function samePayload(row: SchedulerRunRequestRow, input: EnqueueSchedulerRunRequest): boolean {
  return row.task_id === input.taskId && row.role === input.role && row.model === input.model &&
    row.provider_id === (input.providerId ?? null) && row.auth_method_id === (input.authMethodId ?? null) &&
    row.origin_type === input.originType && row.origin_id === input.originId;
}
