/**
 * Decision service – records decisions with rationale.
 */

import type { Database } from "../../platform/database/database.js";

export type DecisionScope = "TASK" | "EPIC" | "PROJECT" | "GLOBAL";
export type DecisionStatus = "PENDING" | "FINAL" | "SUPERSEDED";

export interface Decision {
  readonly id: string;
  readonly title: string;
  readonly rationale: string;
  readonly scope: DecisionScope;
  readonly scopeId: string | null;
  readonly status: DecisionStatus;
  readonly decidedBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface DecisionRow {
  id: string;
  title: string;
  rationale: string;
  scope: string;
  scope_id: string | null;
  status: string;
  decided_by: string;
  created_at: string;
  updated_at: string;
}

function rowToDecision(row: DecisionRow): Decision {
  return {
    id: row.id,
    title: row.title,
    rationale: row.rationale,
    scope: row.scope as DecisionScope,
    scopeId: row.scope_id,
    status: row.status as DecisionStatus,
    decidedBy: row.decided_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface DecisionCreateInput {
  readonly title: string;
  readonly rationale: string;
  readonly scope: DecisionScope;
  readonly scopeId?: string;
  readonly decidedBy: string;
}

/**
 * Экспортируемый компонент или контракт модуля, доступный другим слоям приложения.
 */
export class DecisionService {
  constructor(private readonly db: Database) {}

  /**
   * Create a new decision with FINAL status.
   */
  create(input: DecisionCreateInput): Decision {
    return this.db.transaction((tx) => {
      const now = new Date().toISOString();
      const id = crypto.randomUUID();

      tx.run(
        `INSERT INTO decisions (id, title, rationale, scope, scope_id, status, decided_by, created_at, updated_at)
         VALUES ($id, $title, $rationale, $scope, $scope_id, $status, $decided_by, $created_at, $updated_at)`,
        {
          id,
          title: input.title,
          rationale: input.rationale,
          scope: input.scope,
          scope_id: input.scopeId ?? null,
          status: "FINAL",
          decided_by: input.decidedBy,
          created_at: now,
          updated_at: now,
        },
      );

      return {
        id,
        title: input.title,
        rationale: input.rationale,
        scope: input.scope,
        scopeId: input.scopeId ?? null,
        status: "FINAL" as DecisionStatus,
        decidedBy: input.decidedBy,
        createdAt: now,
        updatedAt: now,
      };
    });
  }

  /**
   * Get a decision by ID.
   */
  getById(decisionId: string): Decision | undefined {
    const row = this.db.get<DecisionRow>(
      "SELECT * FROM decisions WHERE id = $id",
      { id: decisionId },
    );
    return row ? rowToDecision(row) : undefined;
  }

  /**
   * List decisions for a scope.
   */
  listByScope(scope: DecisionScope, scopeId?: string): Decision[] {
    const rows = this.db.all<DecisionRow>(
      scopeId
        ? "SELECT * FROM decisions WHERE scope = $scope AND scope_id = $scope_id"
        : "SELECT * FROM decisions WHERE scope = $scope AND scope_id IS NULL",
      scopeId ? { scope, scope_id: scopeId } : { scope },
    );
    return rows.map(rowToDecision);
  }

  /**
   * Supersede a FINAL decision, replacing it with a new one.
   */
  supersede(decisionId: string): Decision {
    return this.db.transaction((tx) => {
      const row = tx.get<DecisionRow>(
        "SELECT * FROM decisions WHERE id = $id",
        { id: decisionId },
      );
      if (!row) {
        throw new Error(`Decision ${decisionId} not found`);
      }
      if (row.status !== "FINAL") {
        throw new Error(`Decision ${decisionId} is not FINAL (status: ${row.status})`);
      }

      const now = new Date().toISOString();
      tx.run(
        "UPDATE decisions SET status = $status, updated_at = $updated_at WHERE id = $id",
        { id: decisionId, status: "SUPERSEDED", updated_at: now },
      );

      return { ...rowToDecision(row), status: "SUPERSEDED" as DecisionStatus, updatedAt: now };
    });
  }
}
