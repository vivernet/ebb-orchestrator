/**
 * Approval service – request, approve, reject, and cancel approvals
 * with single-transition enforcement and outbox events.
 */

import type { Database } from "../../platform/database/database.js";
import { DomainEvent } from "../../platform/events/domain-event.js";
import { appendOutboxEvent } from "../../platform/events/outbox-repository.js";
import type {
  Approval,
  ApprovalRequestInput,
  ApprovalType,
  ApprovalStatus,
  ApprovalSubjectType,
} from "./approval-types.js";

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
    // Older callers may intentionally use only migrations 001–003.
    return undefined;
  }
}

/**
 * Предоставляет публичный контракт модуля approval-service для взаимодействия слоёв приложения.
 */
export class ApprovalService {
  constructor(private readonly db: Database) {}

  /**
   * Request a new approval. Status is PENDING. Appends ApprovalRequested to outbox.
   */
  request(input: ApprovalRequestInput): Approval {
    return this.db.transaction((tx) => {
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
        try {
          tx.run("INSERT OR REPLACE INTO approval_metadata(approval_id,metadata_json) VALUES($approvalId,$metadata)", { approvalId: id, metadata: JSON.stringify(input.metadata) });
        } catch {
          // Keep compatibility with pre-onboarding schemas; the approval itself remains valid.
        }
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
    });
  }

  /**
   * Approve a pending approval. Throws if already resolved.
   */
  approve(approvalId: string, actor: string, note?: string): Approval {
    return this.resolve(approvalId, "APPROVED", actor, note ?? null, "ApprovalApproved");
  }

  /**
   * Reject a pending approval. Throws if already resolved.
   */
  reject(approvalId: string, actor: string, note?: string): Approval {
    return this.resolve(approvalId, "REJECTED", actor, note ?? null, "ApprovalRejected");
  }

  /**
   * Cancel a pending approval. Throws if already resolved.
   */
  cancel(approvalId: string, actor: string): Approval {
    return this.resolve(approvalId, "CANCELLED", actor, null, "ApprovalCancelled");
  }

  /**
   * Get an approval by ID.
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
   * List pending approvals for a given subject.
   */
  listPendingBySubject(subjectId: string): Approval[] {
    const rows = this.db.all<ApprovalRow>(
      "SELECT * FROM approvals WHERE subject_id = $subject_id AND status = 'PENDING'",
      { subject_id: subjectId },
    );
    return rows.map(rowToApproval);
  }

    /**
    * Core resolution logic – enforces single-transition, appends outbox
    * event, and writes audit_log entry atomically.
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

      // Write audit_log entry atomically with state + outbox.
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
