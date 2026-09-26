/**
 * Ограничения service – request, approve, reject, and cancel approvals
 * с single-transition enforcement и outbox события.
 */

import type { Database, DatabaseTx } from "../../platform/database/database.js";
import { DomainEvent } from "../../platform/events/domain-event.js";
import { appendOutboxEvent } from "../../platform/events/outbox-repository.js";
import type {
  Approval,
  ApprovalRequestInput,
  ApprovalType,
  ApprovalStatus,
  ApprovalSubjectType,
} from "./approval-types.js";
import type { ApproveApprovalCommand, RequestApprovalCommand } from "./approval-commands.js";
import type { ApprovalTransactionPort } from "./approval-port.js";

interface ApprovalRow {
  id: string;
  type: string;
  subject_id: string;
  subject_type: string;
  status: string;
  requested_by: string;
  resolved_by: string | null;
  resolution_note: string | null;
  created_at: string;
  resolved_at: string | null;
  metadata_json?: string | null;
}

function parseMetadata(value: string | null | undefined): Readonly<Record<string, unknown>> | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as Readonly<Record<string, unknown>>;
  } catch {
    return undefined;
  }
}

function rowToApproval(row: ApprovalRow): Approval {
  const metadata = parseMetadata(row.metadata_json);
  const approval: Approval = {
    id: row.id,
    type: row.type as ApprovalType,
    subjectId: row.subject_id,
    subjectType: row.subject_type as ApprovalSubjectType,
    status: row.status as ApprovalStatus,
    requestedBy: row.requested_by,
    resolvedBy: row.resolved_by,
    resolutionNote: row.resolution_note,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
  return metadata ? { ...approval, metadata } : approval;
}

function readMetadata(db: Database, approvalId: string): Readonly<Record<string, unknown>> | undefined {
  try {
    const row = db.get<{ metadata_json: string }>("SELECT metadata_json FROM approval_metadata WHERE approval_id=$approvalId", { approvalId });
    return parseMetadata(row?.metadata_json);
  } catch {
    // Older callers may intentionally использовать только migrations 001–003.
    return undefined;
  }
}

/**
 * Предоставляет публичный контракт модуля approval-service для взаимодействия слоёв приложения.
 */
export class ApprovalService implements ApprovalTransactionPort {
  constructor(private readonly db: Database) {}

  /**
   * запрос Объект новый approval. статус равен ожидающий. Appends ApprovalRequested to outbox.
   */
  request(input: ApprovalRequestInput): Approval {
    return this.db.transaction((tx) => this.requestInTransaction(tx, input));
  }

  requestInTransaction(tx: DatabaseTx, input: RequestApprovalCommand): Approval {
      const now = new Date().toISOString();
      const id = crypto.randomUUID();

      tx.run(
        `INSERT INTO approvals (id, type, subject_id, subject_type, status, requested_by, created_at)
         VALUES ($id, $type, $subject_id, $subject_type, $status, $requested_by, $created_at)`,
        {
          id,
          type: input.type,
          subject_id: input.subjectId,
          subject_type: input.subjectType,
          status: "PENDING",
          requested_by: input.requestedBy,
          created_at: now,
        },
      );
      if (input.metadata) {
        tx.run("INSERT OR REPLACE INTO approval_metadata(approval_id,metadata_json) VALUES($approvalId,$metadata)", { approvalId: id, metadata: JSON.stringify(input.metadata) });
      }

      const event = DomainEvent.create({
        type: "ApprovalRequested",
        aggregateType: "Approval",
        aggregateId: input.subjectId,
        payload: {
          approvalId: id,
          approvalType: input.type,
          subjectId: input.subjectId,
          subjectType: input.subjectType,
          requestedBy: input.requestedBy,
        },
      });
      appendOutboxEvent(tx, event);

      const approval: Approval = {
        id,
        type: input.type,
        subjectId: input.subjectId,
        subjectType: input.subjectType,
        status: "PENDING" as ApprovalStatus,
        requestedBy: input.requestedBy,
        resolvedBy: null,
        resolutionNote: null,
        createdAt: now,
        resolvedAt: null,
      };
      return input.metadata ? { ...approval, metadata: input.metadata } : approval;
  }

  /**
   * Approve Объект ожидающий approval. Throws если уже разрешённый.
   */
  approve(approvalId: string, actor: string, note?: string): Approval {
    const row = this.db.get<ApprovalRow>("SELECT subject_id,subject_type,type FROM approvals WHERE id=$id", { id: approvalId });
    if (!row) throw new Error(`Approval ${approvalId} not found`);
    const current = this.db.get<{ status: string }>("SELECT status FROM approvals WHERE id=$id", { id: approvalId });
    if (current?.status !== "PENDING") throw new Error(`Approval ${approvalId} is already resolved with status ${current?.status ?? "UNKNOWN"}`);
    return this.db.transaction((tx) => this.approveInTransaction(tx, { approvalId, subjectId: row.subject_id, subjectType: row.subject_type as ApprovalSubjectType, type: row.type as ApprovalType, actor, note: note ?? null }));
  }

  approveInTransaction(tx: DatabaseTx, command: ApproveApprovalCommand): Approval {
    const row = tx.get<ApprovalRow>("SELECT * FROM approvals WHERE id=$id AND subject_id=$subjectId AND subject_type=$subjectType AND type=$type AND status='PENDING'", { id: command.approvalId, subjectId: command.subjectId, subjectType: command.subjectType, type: command.type });
    if (!row) throw new Error(`Approval ${command.approvalId} is not pending for the requested subject`);
    const now = new Date().toISOString();
    tx.run("UPDATE approvals SET status='APPROVED',resolved_by=$actor,resolution_note=$note,resolved_at=$now WHERE id=$id AND subject_id=$subjectId AND subject_type=$subjectType AND type=$type AND status='PENDING'", { id: command.approvalId, subjectId: command.subjectId, subjectType: command.subjectType, type: command.type, actor: command.actor, note: command.note ?? null, now });
    if (tx.get<{ changes: number }>("SELECT changes() AS changes")?.changes !== 1) throw new Error(`Approval ${command.approvalId} is no longer pending`);
    const event = DomainEvent.create({ type: "ApprovalApproved", aggregateType: "Approval", aggregateId: command.subjectId, payload: { approvalId: command.approvalId, approvalType: command.type, subjectId: command.subjectId, subjectType: command.subjectType, status: "APPROVED", resolvedBy: command.actor, resolutionNote: command.note ?? null } });
    appendOutboxEvent(tx, event);
    tx.run("INSERT INTO audit_log(id,action,actor,aggregate_type,aggregate_id,details_json,created_at) VALUES($id,$action,$actor,$aggregate_type,$aggregate_id,$details,$created_at)", { id: crypto.randomUUID(), action: "APPROVAL_APPROVED", actor: command.actor, aggregate_type: "Approval", aggregate_id: command.approvalId, details: JSON.stringify({ approvalId: command.approvalId, approvalType: command.type, subjectId: command.subjectId, subjectType: command.subjectType, status: "APPROVED", resolvedBy: command.actor, resolutionNote: command.note ?? null }), created_at: now });
    return { id: row.id, type: row.type as ApprovalType, subjectId: row.subject_id, subjectType: row.subject_type as ApprovalSubjectType, status: "APPROVED", requestedBy: row.requested_by, resolvedBy: command.actor, resolutionNote: command.note ?? null, createdAt: row.created_at, resolvedAt: now };
  }

  /**
   * Reject Объект ожидающий approval. Throws если уже разрешённый.
   */
  reject(approvalId: string, actor: string, note?: string): Approval {
    return this.resolve(approvalId, "REJECTED", actor, note ?? null, "ApprovalRejected");
  }

  /**
   * Request changes для pending approval. Throws если уже разрешённый.
   */
  requestChanges(approvalId: string, actor: string, note?: string): Approval {
    return this.resolve(approvalId, "CHANGES_REQUESTED", actor, note ?? null, "ApprovalChangesRequested");
  }

  /**
   * Отмена a pending approval. Throws if already resolved.
   */
  cancel(approvalId: string, actor: string): Approval {
    return this.resolve(approvalId, "CANCELLED", actor, null, "ApprovalCancelled");
  }

  /**
   * Получает an approval by ID.
   */
  getById(approvalId: string): Approval | undefined {
    const row = this.db.get<ApprovalRow>(
      "SELECT * FROM approvals WHERE id = $id",
      { id: approvalId },
    );
    if (!row) return undefined;
    const approval = rowToApproval(row);
    const metadata = readMetadata(this.db, approvalId);
    return metadata ? { ...approval, metadata } : approval;
  }

  /**
   * Перечисляет ожидающие approvals для Объект указанного subject.
   */
  listPendingBySubject(subjectId: string): Approval[] {
    const rows = this.db.all<ApprovalRow>(
      "SELECT * FROM approvals WHERE subject_id = $subject_id AND status = 'PENDING'",
      { subject_id: subjectId },
    );
    return rows.map(rowToApproval);
  }

    /**
    * Основная логика разрешения – enforces single-transition, appends outbox
    * событие, и writes audit_log entry atomically.
    */
  private resolve(
    approvalId: string,
    newStatus: ApprovalStatus,
    actor: string,
    note: string | null,
    eventType: string,
  ): Approval {
    return this.db.transaction((tx) => {
      const row = tx.get<ApprovalRow>(
        "SELECT * FROM approvals WHERE id = $id",
        { id: approvalId },
      );
      if (!row) {
        throw new Error(`Approval ${approvalId} not found`);
      }
      if (row.status !== "PENDING") {
        throw new Error(`Approval ${approvalId} is already resolved with status ${row.status}`);
      }

      const now = new Date().toISOString();
      tx.run(
        `UPDATE approvals
         SET status = $status, resolved_by = $resolved_by, resolution_note = $resolution_note, resolved_at = $resolved_at
         WHERE id = $id`,
        {
          id: approvalId,
          status: newStatus,
          resolved_by: actor,
          resolution_note: note,
          resolved_at: now,
        },
      );

      const event = DomainEvent.create({
        type: eventType,
        aggregateType: "Approval",
        aggregateId: row.subject_id,
        payload: {
          approvalId,
          approvalType: row.type,
          subjectId: row.subject_id,
          subjectType: row.subject_type,
          status: newStatus,
          resolvedBy: actor,
          resolutionNote: note,
        },
      });
      appendOutboxEvent(tx, event);

      // Записывает audit_log entry atomically with state + outbox.
      tx.run(
        `INSERT INTO audit_log(id,action,actor,aggregate_type,aggregate_id,details_json,created_at) VALUES($id,$action,$actor,$aggregate_type,$aggregate_id,$details,$created_at)`,
        {
          id: crypto.randomUUID(),
          action: `APPROVAL_${newStatus}`,
          actor,
          aggregate_type: "Approval",
          aggregate_id: approvalId,
          details: JSON.stringify({ approvalId, approvalType: row.type, subjectId: row.subject_id, subjectType: row.subject_type, status: newStatus, resolvedBy: actor, resolutionNote: note }),
          created_at: now,
        },
      );

      return {
        id: row.id,
        type: row.type as ApprovalType,
        subjectId: row.subject_id,
        subjectType: row.subject_type as ApprovalSubjectType,
        status: newStatus,
        requestedBy: row.requested_by,
        resolvedBy: actor,
        resolutionNote: note,
        createdAt: row.created_at,
        resolvedAt: now,
      };
    });
  }
}
