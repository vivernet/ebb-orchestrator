/**
 * Findings service – stable IDs for Reviewer findings.
 */

import type { Database, DatabaseTx } from "../../platform/database/database.js";
import { randomUUID } from "node:crypto";

export type FindingStatus = "OPEN" | "RESOLVED" | "STILL_PRESENT";

export interface Finding {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly displayId: string;
  readonly sourceRunId: string;
  readonly severity: "BLOCKING" | "HIGH" | "NORMAL" | "LOW";
  readonly blocking: boolean;
  readonly title: string;
  readonly description: string;
  readonly guidelineRef: string | null;
  readonly evidenceSignature: string;
  readonly status: FindingStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Предоставляет публичный контракт модуля findings-service для взаимодействия слоёв приложения.
 */
export class FindingsService {
  constructor(private readonly db: Database) {}

  /**
   * Assign and persist a stable finding ID for a review output.
   * First call for a task creates FINDING-1, next calls get FINDING-2, etc.
   */
  createFinding(
    projectId: string,
    taskId: string,
    input: {
      sourceRunId: string;
      severity: "BLOCKING" | "HIGH" | "NORMAL" | "LOW";
      blocking: boolean;
      title: string;
      description: string;
      guidelineRef: string | null;
      evidenceSignature: string;
    },
  ): Finding {
    return this.db.transaction((tx) => {
      const num = this.nextFindingNumber(tx, projectId);
      const now = new Date().toISOString();
      const id = randomUUID();

      tx.run(
        `INSERT INTO findings 
         (id, project_id, task_id, display_id, source_run_id, severity, blocking, 
          title, description, guideline_ref, evidence_signature, status, created_at, updated_at)
         VALUES ($id, $projectId, $taskId, $displayId, $sourceRunId, $severity, $blocking, 
                 $title, $description, $guidelineRef, $evidenceSignature, 'OPEN', $now, $now)`,
        {
          id,
          projectId,
          taskId,
          displayId: `FINDING-${num}`,
          sourceRunId: input.sourceRunId,
          severity: input.severity,
          blocking: input.blocking ? 1 : 0,
          title: input.title,
          description: input.description,
          guidelineRef: input.guidelineRef,
          evidenceSignature: input.evidenceSignature,
          now,
        },
      );

      const finding = this.getFindingById(tx, id);
      if (!finding) {
        throw new Error(`Finding ${id} was not persisted`);
      }
      return finding;
    });
  }

  /**
   * Update an existing finding (e.g., on re-review).
   * Only updates status, evidence signature, and source run.
   */
  updateFinding(
    findingId: string,
    updates: {
      status?: FindingStatus;
      evidenceSignature?: string;
      sourceRunId?: string;
    },
  ): Finding {
    return this.db.transaction((tx) => {
      const existing = this.getFindingById(tx, findingId);
      if (!existing) {
        throw new Error(`Finding ${findingId} not found`);
      }

      const now = new Date().toISOString();

      if (updates.status !== undefined) {
        tx.run(
          "UPDATE findings SET status = $status, updated_at = $now WHERE id = $id",
          { status: updates.status, now, id: findingId },
        );
      }

      if (updates.evidenceSignature !== undefined) {
        tx.run(
          "UPDATE findings SET evidence_signature = $sig, updated_at = $now WHERE id = $id",
          { sig: updates.evidenceSignature, now, id: findingId },
        );
      }

      if (updates.sourceRunId !== undefined) {
        tx.run(
          "UPDATE findings SET source_run_id = $rid, updated_at = $now WHERE id = $id",
          { rid: updates.sourceRunId, now, id: findingId },
        );
      }

      const finding = this.getFindingById(tx, findingId);
      if (!finding) {
        throw new Error(`Finding ${findingId} was not persisted`);
      }
      return finding;
    });
  }

  /**
   * Get finding by stable display ID.
   */
  getFindingByDisplayId(tx: DatabaseTx, projectId: string, displayId: string): Finding | null {
    const row = tx.get(
      "SELECT * FROM findings WHERE project_id = $projectId AND display_id = $displayId",
      { projectId, displayId },
    );
    return row ? this.mapFinding(row) : null;
  }

  /**
   * Get finding by internal ID.
   */
  getFindingById(tx: DatabaseTx, id: string): Finding | null {
    const row = tx.get("SELECT * FROM findings WHERE id = $id", { id });
    return row ? this.mapFinding(row) : null;
  }

  /**
   * Get all findings for a task.
   */
  getFindingsByTaskId(tx: DatabaseTx, taskId: string): Finding[] {
    const rows = tx.all("SELECT * FROM findings WHERE task_id = $taskId ORDER BY display_id", { taskId });
    return rows.map((r) => this.mapFinding(r));
  }

  /**
   * Get open findings for a task.
   */
  getOpenFindingsByTaskId(tx: DatabaseTx, taskId: string): Finding[] {
    const rows = tx.all(
      "SELECT * FROM findings WHERE task_id = $taskId AND status = 'OPEN' ORDER BY display_id",
      { taskId },
    );
    return rows.map((r) => this.mapFinding(r));
  }

  private nextFindingNumber(tx: DatabaseTx, projectId: string): number {
    // Extract the numeric part by removing "FINDING-" prefix
    const row = tx.get<{ max_num: number }>(
      "SELECT MAX(CAST(REPLACE(display_id, 'FINDING-', '') AS INTEGER)) as max_num FROM findings WHERE project_id = $projectId",
      { projectId },
    );
    return (row?.max_num ?? 0) + 1;
  }

  private mapFinding(row: Record<string, unknown>): Finding {
    const blockingValue = row.blocking;
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      taskId: row.task_id as string,
      displayId: row.display_id as string,
      sourceRunId: row.source_run_id as string,
      severity: row.severity as Finding["severity"],
      blocking: blockingValue === 1 || blockingValue === true,
      title: row.title as string,
      description: row.description as string,
      guidelineRef: row.guideline_ref as string | null,
      evidenceSignature: row.evidence_signature as string,
      status: row.status as FindingStatus,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}
