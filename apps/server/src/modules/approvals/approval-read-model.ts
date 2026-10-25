/**
 * Read-only read model согласований (plan-27 Task 5).
 *
 * Проецирует approval-строки в typed screen projection: никогда не сериализует
 * сырые внутренние колонки (subject_id/subject_type/requested_by/resolution_note)
 * и секреты. Деталь собирается из approval_metadata (proposal/rationale/planDiff/
 * impacts/evidence) плюс решение из approval-строки. Политика — backend-owned
 * эффективная константа домена, а не выдуманная статистика.
 */

import type { Database } from "../../platform/database/database.js";
import type {
  ApprovalDetailProjection,
  ApprovalEvidenceEntryProjection,
  ApprovalInboxItemProjection,
  ApprovalInboxProjection,
  ApprovalPolicyProjection,
} from "@ebb-orchestrator/contracts";

type ApprovalPriority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
type ApprovalFilter = "pending" | "resolved";
type DecisionOutcome = "APPROVED" | "REJECTED" | "CHANGES_REQUESTED";

interface ApprovalRow {
  id: string;
  type: string;
  status: string;
  subject_type: string;
  subject_id: string;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
  project_id: string | null;
  project_display_name: string | null;
}

/**
 * Стабильная backend-конвенция приоритета согласования, выводимая только из
 * персистентного типа approval (не статистическая эвристика и не метрика).
 * Обновляется в будущей policy без изменения схемы.
 */
const PRIORITY_BY_TYPE: Readonly<Record<string, ApprovalPriority>> = {
  FINAL_MERGE: "CRITICAL",
  ARCHITECTURE_CHANGE: "HIGH",
  SCOPE_CHANGE: "HIGH",
  ROLE_CHANGE: "MEDIUM",
  WORKFLOW_CHANGE: "MEDIUM",
};

const RESOLVED_OUTCOME: Readonly<Record<string, DecisionOutcome>> = {
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  CHANGES_REQUESTED: "CHANGES_REQUESTED",
};

function derivePriority(type: string): ApprovalPriority {
  return PRIORITY_BY_TYPE[type] ?? "MEDIUM";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readMetadata(db: Database, approvalId: string): Record<string, unknown> | undefined {
  const row = db.get<{ metadata_json: string }>("SELECT metadata_json FROM approval_metadata WHERE approval_id=$approvalId", { approvalId });
  return asRecord(row?.metadata_json !== undefined ? safeParseJson(row.metadata_json) : undefined);
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

const APPROVAL_SELECT = `
  SELECT a.id, a.type, a.status, a.subject_type, a.subject_id, a.created_at, a.resolved_at,
         a.resolved_by, a.resolution_note,
         p.id AS project_id, p.display_name AS project_display_name
  FROM approvals a
  LEFT JOIN tasks t ON a.subject_type = 'TASK' AND t.id = a.subject_id
  LEFT JOIN epics e ON a.subject_type = 'EPIC' AND e.id = a.subject_id
  LEFT JOIN projects p ON p.id = CASE a.subject_type
      WHEN 'PROJECT' THEN a.subject_id
      WHEN 'EPIC' THEN e.project_id
      ELSE t.project_id END
`;

/** Read-only read model согласований; проекции не содержат сырых внутренних строк. */
export class ApprovalReadModel {
  constructor(private readonly db?: Database) {}

  /** Список требова (pending/resolved) со стабильной сортировкой и счётчиками. */
  listInbox(filter: ApprovalFilter): ApprovalInboxProjection {
    if (!this.db) return emptyInbox(filter);
    const db = this.db;
    const statusWhere = filter === "pending" ? "a.status = 'PENDING'" : "a.status != 'PENDING'";
    const rows = db.all<ApprovalRow>(
      `${APPROVAL_SELECT} WHERE ${statusWhere} ORDER BY a.created_at DESC, a.id DESC`,
    );
    const totalPending = Number(db.get<{ c: number }>("SELECT COUNT(*) AS c FROM approvals WHERE status='PENDING'")?.c ?? 0);
    const totalResolved = Number(db.get<{ c: number }>("SELECT COUNT(*) AS c FROM approvals WHERE status!='PENDING'")?.c ?? 0);
    const oldestPendingCreatedAt = db.get<{ m: string | null }>("SELECT MIN(created_at) AS m FROM approvals WHERE status='PENDING'")?.m ?? null;
    return {
      filter,
      summary: { totalPending, totalResolved, oldestPendingCreatedAt },
      items: rows.map(rowToItemRow),
    };
  }

  /** Детальная проекция одного согласования; undefined для неизвестного id. */
  getDetail(id: string): ApprovalDetailProjection | undefined {
    if (!this.db) return undefined;
    const row = this.db.get<ApprovalRow>(`${APPROVAL_SELECT} WHERE a.id = $id`, { id });
    if (!row) return undefined;
    return rowToDetail(row, readMetadata(this.db, row.id));
  }

  /** Эффективная policy согласований, принадлежащая backend (read-only). */
  getPolicy(): ApprovalPolicyProjection {
    return {
      defaultAction: "PENDING",
      requireExactHashForActivation: true,
      allowedOutcomes: ["APPROVED", "REJECTED", "CHANGES_REQUESTED"],
    };
  }
}

function rowToItemRow(row: ApprovalRow): ApprovalInboxItemProjection {
  return {
    id: row.id,
    category: row.type,
    status: row.status === "PENDING" ? "PENDING" : "RESOLVED",
    priority: derivePriority(row.type),
    projectId: row.project_id,
    title: "",
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

function rowToDetail(row: ApprovalRow, metadata: Record<string, unknown> | undefined): ApprovalDetailProjection {
  const proposal = asRecord(metadata?.proposal);
  const planDiff = asRecord(metadata?.planDiff);
  const impacts = asRecord(metadata?.impacts);
  const outcome = RESOLVED_OUTCOME[row.status];
  const decision = row.status !== "PENDING" && outcome
    ? {
        actor: row.resolved_by ?? "",
        outcome,
        at: row.resolved_at ?? row.created_at,
        note: row.resolution_note,
      }
    : null;
  return {
    id: row.id,
    category: row.type,
    status: row.status === "PENDING" ? "PENDING" : "RESOLVED",
    priority: derivePriority(row.type),
    project: { id: row.project_id ?? "", displayName: row.project_display_name ?? "" },
    proposal: { title: asString(proposal?.title), summary: asString(proposal?.summary) },
    rationale: asString(metadata?.rationale),
    planDiff: {
      before: {
        title: asString(asRecord(planDiff?.before)?.title),
        scope: asString(asRecord(planDiff?.before)?.scope),
      },
      after: {
        title: asString(asRecord(planDiff?.after)?.title),
        scope: asString(asRecord(planDiff?.after)?.scope),
      },
    },
    impacts: {
      scope: asString(impacts?.scope),
      role: asString(impacts?.role),
      architecture: asString(impacts?.architecture),
      delayDays: asNullableNumber(impacts?.delayDays),
      budgetCost: asNullableNumber(impacts?.budgetCost),
    },
    evidence: Array.isArray(metadata?.evidence) ? metadata.evidence.flatMap(evidenceEntry) : [],
    decision,
  };
}

function evidenceEntry(value: unknown): ApprovalEvidenceEntryProjection[] {
  const entry = asRecord(value);
  if (!entry) return [];
  const capturedAt = asString(entry.capturedAt);
  if (!capturedAt || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(capturedAt)) return [];
  return [
    {
      id: asString(entry.id),
      kind: asString(entry.kind),
      capturedAt,
      description: asString(entry.description),
      source: asString(entry.source),
    },
  ];
}

function emptyInbox(filter: ApprovalFilter): ApprovalInboxProjection {
  return {
    filter,
    summary: { totalPending: 0, totalResolved: 0, oldestPendingCreatedAt: null },
    items: [],
  };
}
