/**
 * Сервис дефектов – stable IDs для QОбъект defects.
 */

import type { Database, DatabaseTx } from "../../platform/database/database.js";
import type { FindingStatus } from "./findings-service.js";
import { randomUUID } from "node:crypto";

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

/**
 * Предоставляет публичный контракт модуля defects-service для взаимодействия слоёв приложения.
 */
export class DefectsService {
  constructor(private readonly db: Database) {}

  /**
   * Сохраняет стабильную QA defect запись и назначает `DEFECT-n` при первом создании.
   * Для уже имеющейся пары Task+acceptance criterion возвращает запись с наименьшим display ID
   * без изменения её данных; historical duplicates не удаляет.
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
    return this.db.transaction((tx) => this.createDefectInTransaction(tx, projectId, taskId, input));
  }

  /** Создаёт defect или возвращает существующий Task+criterion defect в caller-owned transaction. */
  createDefectInTransaction(
    tx: DatabaseTx,
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
      if (input.acceptanceCriterionRef !== null) {
        const existing = this.getByAcceptanceCriterionInTransaction(tx, taskId, input.acceptanceCriterionRef);
        if (existing) return existing;
      }
      const num = this.nextDefectNumber(tx, projectId);
      const now = new Date().toISOString();
      const id = randomUUID();

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

      const defect = this.getDefectById(tx, id);
      if (!defect) {
        throw new Error(`Defect ${id} was not persisted`);
      }
      return defect;
  }

  /**
   * Обновляет an existing defect (e.g., on re-test).
   * Только updates status, evidence signature, and source run.
   */
  updateDefect(
    defectId: string,
    updates: {
      status?: DefectStatus;
      evidenceSignature?: string;
      sourceRunId?: string;
    },
  ): Defect {
    return this.db.transaction((tx) => this.updateDefectInTransaction(tx, defectId, updates));
  }

  /** Обновляет defect в уже открытой транзакции проекции Run. */
  updateDefectInTransaction(
    tx: DatabaseTx,
    defectId: string,
    updates: {
      status?: DefectStatus;
      evidenceSignature?: string;
      sourceRunId?: string;
    },
  ): Defect {
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

      const defect = this.getDefectById(tx, defectId);
      if (!defect) {
        throw new Error(`Defect ${defectId} was not persisted`);
      }
      return defect;
  }

  /** Ищет defect по ограниченному естественному ключу одной acceptance criterion в Task. */
  getByAcceptanceCriterionInTransaction(tx: DatabaseTx, taskId: string, criterionRef: string): Defect | null {
    const row = tx.get("SELECT * FROM defects WHERE task_id=$taskId AND acceptance_criterion_ref=$criterionRef ORDER BY display_id LIMIT 1", { taskId, criterionRef });
    return row ? this.mapDefect(row) : null;
  }

  /** Возвращает существующий Task+criterion defect без изменения либо создаёт первую запись; legacy duplicates остаются сохранёнными. */
  createForAcceptanceCriterionInTransaction(
    tx: DatabaseTx,
    projectId: string,
    taskId: string,
    input: {
      sourceRunId: string;
      severity: "BLOCKING" | "HIGH" | "NORMAL" | "LOW";
      blocking: boolean;
      title: string;
      description: string;
      acceptanceCriterionRef: string;
      evidenceSignature: string;
    },
  ): { defect: Defect; created: boolean } {
    const existing = this.getByAcceptanceCriterionInTransaction(tx, taskId, input.acceptanceCriterionRef);
    if (existing) return { defect: existing, created: false };
    return { defect: this.createDefectInTransaction(tx, projectId, taskId, input), created: true };
  }

  /** Проверяет владение Task и active status, затем обновляет defect по публичному display ID. */
  updateDefectByDisplayIdInTransaction(
    tx: DatabaseTx,
    projectId: string,
    taskId: string,
    displayId: string,
    sourceRunId: string,
    status: Exclude<DefectStatus, "OPEN">,
  ): Defect {
    const defect = this.getDefectByDisplayId(tx, projectId, displayId);
    if (!defect || defect.taskId !== taskId) throw new Error("QA_DEFECT_REFERENCE_NOT_OWNED");
    if (defect.status === "RESOLVED") throw new Error("QA_DEFECT_REFERENCE_NOT_ACTIVE");
    return this.updateDefectInTransaction(tx, defect.id, { status, sourceRunId });
  }

  /**
   * Получает defect by stable display ID.
   */
  getDefectByDisplayId(tx: DatabaseTx, projectId: string, displayId: string): Defect | null {
    const row = tx.get(
      "SELECT * FROM defects WHERE project_id = $projectId AND display_id = $displayId",
      { projectId, displayId },
    );
    return row ? this.mapDefect(row) : null;
  }

  /**
   * Получает defect by internal ID.
   */
  getDefectById(tx: DatabaseTx, id: string): Defect | null {
    const row = tx.get("SELECT * FROM defects WHERE id = $id", { id });
    return row ? this.mapDefect(row) : null;
  }

  /**
   * Получает all defects for a task.
   */
  getDefectsByTaskId(tx: DatabaseTx, taskId: string): Defect[] {
    const rows = tx.all("SELECT * FROM defects WHERE task_id = $taskId ORDER BY display_id", { taskId });
    return rows.map((r) => this.mapDefect(r));
  }

  /**
   * Получает open defects for a task.
   */
  getOpenDefectsByTaskId(tx: DatabaseTx, taskId: string): Defect[] {
    const rows = tx.all(
      "SELECT * FROM defects WHERE task_id = $taskId AND status = 'OPEN' ORDER BY display_id",
      { taskId },
    );
    return rows.map((r) => this.mapDefect(r));
  }

  private nextDefectNumber(tx: DatabaseTx, projectId: string): number {
    // Извлекает the numeric part by removing "DEFECT-" prefix
    const row = tx.get<{ max_num: number }>(
      "SELECT MAX(CAST(REPLACE(display_id, 'DEFECT-', '') AS INTEGER)) as max_num FROM defects WHERE project_id = $projectId",
      { projectId },
    );
    return (row?.max_num ?? 0) + 1;
  }

  private mapDefect(row: Record<string, unknown>): Defect {
    const blockingValue = row.blocking;
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      taskId: row.task_id as string,
      displayId: row.display_id as string,
      sourceRunId: row.source_run_id as string,
      severity: row.severity as Defect["severity"],
      blocking: blockingValue === 1 || blockingValue === true,
      title: row.title as string,
      description: row.description as string,
      acceptanceCriterionRef: row.acceptance_criterion_ref as string | null,
      evidenceSignature: row.evidence_signature as string,
      status: row.status as DefectStatus,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}
