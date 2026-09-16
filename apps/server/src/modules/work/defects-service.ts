/**
 * Defects service – stable IDs for QA defects.
 */

import type { Database } from "../../platform/database/database.js";
import type { FindingStatus } from "./findings-service.js";

export type DefectStatus = FindingStatus;

export interface Defect {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly displayId: string;
  readonly sourceRunId: string;
  readonly severity: "BLOCKING" | "HIGH" | "NORMAL" | "LOW";
  readonly blocking: boolean;
  readonly title: string;
  readonly description: string;
  readonly acceptanceCriterionRef: string | null;
  readonly evidenceSignature: string;
  readonly status: DefectStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class DefectsService {
  constructor(private readonly db: Database) {}

  /**
   * Assign and persist a stable defect ID for a QA output.
   * First call for a task creates DEFECT-1, next calls get DEFECT-2, etc.
   */
  createDefect(
    projectId: string,
    taskId: string,
    input: {
      sourceRunId: string;
      severity: "BLOCKING" | "HIGH" | "NORMAL" | "LOW";
      blocking: boolean;
      title: string;
      description: string;
      acceptanceCriterionRef: string | null;
      evidenceSignature: string;
    },
  ): Defect {
    return this.db.transaction((tx) => {
      const num = this.nextDefectNumber(tx, projectId);
      const now = new Date().toISOString();
      const id = crypto.randomUUID();

      tx.run(
        `INSERT INTO defects 
         (id, project_id, task_id, display_id, source_run_id, severity, blocking, 
          title, description, acceptance_criterion_ref, evidence_signature, status, created_at, updated_at)
         VALUES ($id, $projectId, $taskId, $displayId, $sourceRunId, $severity, $blocking, 
                 $title, $description, $acceptanceCriterionRef, $evidenceSignature, 'OPEN', $now, $now)`,
        {
          id,
          projectId,
          taskId,
          displayId: `DEFECT-${num}`,
          sourceRunId: input.sourceRunId,
          severity: input.severity,
          blocking: input.blocking ? 1 : 0,
          title: input.title,
          description: input.description,
          acceptanceCriterionRef: input.acceptanceCriterionRef,
          evidenceSignature: input.evidenceSignature,
          now,
        },
      );

      return this.getDefectById(tx, id)!;
    });
  }

  /**
   * Update an existing defect (e.g., on re-test).
   * Only updates status, evidence signature, and source run.
   */
  updateDefect(
    defectId: string,
    updates: {
      status?: DefectStatus;
      evidenceSignature?: string;
      sourceRunId?: string;
    },
  ): Defect {
    return this.db.transaction((tx) => {
      const existing = this.getDefectById(tx, defectId);
      if (!existing) {
        throw new Error(`Defect ${defectId} not found`);
      }

      const now = new Date().toISOString();

      if (updates.status !== undefined) {
        tx.run(
          "UPDATE defects SET status = $status, updated_at = $now WHERE id = $id",
          { status: updates.status, now, id: defectId },
        );
      }

      if (updates.evidenceSignature !== undefined) {
        tx.run(
          "UPDATE defects SET evidence_signature = $sig, updated_at = $now WHERE id = $id",
          { sig: updates.evidenceSignature, now, id: defectId },
        );
      }

      if (updates.sourceRunId !== undefined) {
        tx.run(
          "UPDATE defects SET source_run_id = $rid, updated_at = $now WHERE id = $id",
          { rid: updates.sourceRunId, now, id: defectId },
        );
      }

      return this.getDefectById(tx, defectId)!;
    });
  }

  /**
   * Get defect by stable display ID.
   */
  getDefectByDisplayId(tx: { get: (q: string, params?: any) => any }, projectId: string, displayId: string): Defect | null {
    const row = tx.get(
      "SELECT * FROM defects WHERE project_id = $projectId AND display_id = $displayId",
      { projectId, displayId },
    );
    return row ? this.mapDefect(row) : null;
  }

  /**
   * Get defect by internal ID.
   */
  getDefectById(tx: { get: (q: string, params?: any) => any }, id: string): Defect | null {
    const row = tx.get("SELECT * FROM defects WHERE id = $id", { id });
    return row ? this.mapDefect(row) : null;
  }

  /**
   * Get all defects for a task.
   */
  getDefectsByTaskId(tx: { all: (q: string, params?: any) => any }, taskId: string): Defect[] {
    const rows = tx.all("SELECT * FROM defects WHERE task_id = $taskId ORDER BY display_id", { taskId });
    return rows.map((r: any) => this.mapDefect(r));
  }

  /**
   * Get open defects for a task.
   */
  getOpenDefectsByTaskId(tx: { all: (q: string, params?: any) => any }, taskId: string): Defect[] {
    const rows = tx.all(
      "SELECT * FROM defects WHERE task_id = $taskId AND status = 'OPEN' ORDER BY display_id",
      { taskId },
    );
    return rows.map((r: any) => this.mapDefect(r));
  }

  private nextDefectNumber(tx: { get: (q: string, params?: any) => any }, projectId: string): number {
    // Extract the numeric part by removing "DEFECT-" prefix
    const row = tx.get(
      "SELECT MAX(CAST(REPLACE(display_id, 'DEFECT-', '') AS INTEGER)) as max_num FROM defects WHERE project_id = $projectId",
      { projectId },
    );
    return (row?.max_num ?? 0) + 1;
  }

  private mapDefect(row: any): Defect {
    return {
      id: row.id,
      projectId: row.project_id,
      taskId: row.task_id,
      displayId: row.display_id,
      sourceRunId: row.source_run_id,
      severity: row.severity,
      blocking: row.blocking === 1 || row.blocking === true,
      title: row.title,
      description: row.description,
      acceptanceCriterionRef: row.acceptance_criterion_ref,
      evidenceSignature: row.evidence_signature,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
