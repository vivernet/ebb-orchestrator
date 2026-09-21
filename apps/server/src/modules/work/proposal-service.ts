/**
 * Proposal service – manages change proposals.
 */

import type { Database } from "../../platform/database/database.js";

export type ProposalType =
  | "NEW_TASK" | "NEW_DEPENDENCY" | "REMOVE_DEPENDENCY" | "SCOPE_CHANGE"
  | "REQUIREMENT_CHANGE" | "ACCEPTANCE_CRITERIA_CHANGE" | "GUIDELINE_CHANGE"
  | "ARCHITECTURE_CHANGE" | "ROLE_CHANGE" | "WORKFLOW_CHANGE" | "PLAN_CHANGE";

export type ProposalStatus = "OPEN" | "ACCEPTED" | "REJECTED" | "WITHDRAWN";

export type ProposalSubjectType = "TASK" | "EPIC" | "PROJECT";

export interface Proposal {
  readonly id: string;
  readonly type: ProposalType;
  readonly subjectId: string;
  readonly subjectType: ProposalSubjectType;
  readonly proposedBy: string;
  readonly status: ProposalStatus;
  readonly details: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ProposalRow {
  id: string;
  type: string;
  subject_id: string;
  subject_type: string;
  proposed_by: string;
  status: string;
  details_json: string;
  created_at: string;
  updated_at: string;
}

function rowToProposal(row: ProposalRow): Proposal {
  return {
    id: row.id,
    type: row.type as ProposalType,
    subjectId: row.subject_id,
    subjectType: row.subject_type as ProposalSubjectType,
    proposedBy: row.proposed_by,
    status: row.status as ProposalStatus,
    details: JSON.parse(row.details_json) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface ProposalCreateInput {
  readonly type: ProposalType;
  readonly subjectId: string;
  readonly subjectType: ProposalSubjectType;
  readonly proposedBy: string;
  readonly details?: Record<string, unknown>;
}

/**
 * Предоставляет публичный контракт модуля proposal-service для взаимодействия слоёв приложения.
 */
export class ProposalService {
  constructor(private readonly db: Database) {}

  /**
   * Создаёт a new proposal with OPEN status.
   */
  create(input: ProposalCreateInput): Proposal {
    return this.db.transaction((tx) => {
      const now = new Date().toISOString();
      const id = crypto.randomUUID();

      tx.run(
        `INSERT INTO proposals (id, type, subject_id, subject_type, proposed_by, status, details_json, created_at, updated_at)
         VALUES ($id, $type, $subject_id, $subject_type, $proposed_by, $status, $details_json, $created_at, $updated_at)`,
        {
          id,
          type: input.type,
          subject_id: input.subjectId,
          subject_type: input.subjectType,
          proposed_by: input.proposedBy,
          status: "OPEN",
          details_json: JSON.stringify(input.details ?? {}),
          created_at: now,
          updated_at: now,
        },
      );

      return {
        id,
        type: input.type,
        subjectId: input.subjectId,
        subjectType: input.subjectType,
        proposedBy: input.proposedBy,
        status: "OPEN" as ProposalStatus,
        details: input.details ?? {},
        createdAt: now,
        updatedAt: now,
      };
    });
  }

  /**
   * Получает a proposal by ID.
   */
  getById(proposalId: string): Proposal | undefined {
    const row = this.db.get<ProposalRow>(
      "SELECT * FROM proposals WHERE id = $id",
      { id: proposalId },
    );
    return row ? rowToProposal(row) : undefined;
  }

  /**
   * List all proposals for a given subject.
   */
  listBySubject(subjectId: string): Proposal[] {
    const rows = this.db.all<ProposalRow>(
      "SELECT * FROM proposals WHERE subject_id = $subject_id",
      { subject_id: subjectId },
    );
    return rows.map(rowToProposal);
  }

  /**
   * Обновляет a proposal's status. Только OPEN proposals can be transitioned.
   */
  updateStatus(proposalId: string, status: ProposalStatus): Proposal {
    return this.db.transaction((tx) => {
      const row = tx.get<ProposalRow>(
        "SELECT * FROM proposals WHERE id = $id",
        { id: proposalId },
      );
      if (!row) {
        throw new Error(`Proposal ${proposalId} not found`);
      }
      if (row.status !== "OPEN") {
        throw new Error(`Proposal ${proposalId} is already ${row.status}`);
      }

      const now = new Date().toISOString();
      tx.run(
        "UPDATE proposals SET status = $status, updated_at = $updated_at WHERE id = $id",
        { id: proposalId, status, updated_at: now },
      );

      const updated = tx.get<ProposalRow>(
        "SELECT * FROM proposals WHERE id = $id",
        { id: proposalId },
      );
      return rowToProposal(updated!);
    });
  }
}
