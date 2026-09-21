/**
 * Сервис использования — записывает использование для каждого AI run.
 */

import type { Database } from "../../platform/database/database.js";
import type { TriggerReason, UsageRecord } from "./usage-types.js";

/**
 * сервис для recording и querying AI run использование.
 */
export class UsageService {
  constructor(private readonly db: Database) {}

  /**
   * Создаёт a usage record for an AI Run.
   */
  create(record: {
    runId?: string;
    reservationId?: string;
    projectId: string;
    epicId?: string;
    taskId?: string;
    role: string;
    model: string;
    triggerReason: TriggerReason;
    reworkCategory?: string;
    inputTokens?: number;
    cachedTokens?: number;
    outputTokens?: number;
    runtime?: string;
    estimatedCost?: number;
    actualCost?: number;
  }): UsageRecord {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const inputTokens = record.inputTokens ?? 0;
    const cachedTokens = record.cachedTokens ?? 0;
    const outputTokens = record.outputTokens ?? 0;

    this.db.run(
      `INSERT INTO usage_records (
        id, run_id, reservation_id, project_id, epic_id, task_id,
        role, model, trigger_reason, rework_category,
        input_tokens, cached_tokens, output_tokens, total_tokens,
        runtime, estimated_cost, actual_cost, created_at
      ) VALUES (
        $id, $runId, $reservationId, $projectId, $epicId, $taskId,
        $role, $model, $triggerReason, $reworkCategory,
        $inputTokens, $cachedTokens, $outputTokens, $totalTokens,
        $runtime, $estimatedCost, $actualCost, $createdAt
      )`,
      {
        id,
        runId: record.runId ?? null,
        reservationId: record.reservationId ?? null,
        projectId: record.projectId,
        epicId: record.epicId ?? null,
        taskId: record.taskId ?? null,
        role: record.role,
        model: record.model,
        triggerReason: record.triggerReason,
        reworkCategory: record.reworkCategory ?? null,
        inputTokens,
        cachedTokens,
        outputTokens,
        totalTokens: inputTokens + cachedTokens + outputTokens,
        runtime: record.runtime ?? "",
        estimatedCost: record.estimatedCost ?? 0,
        actualCost: record.actualCost ?? 0,
        createdAt: now,
      },
    );

    return this.getById(id)!;
  }

  /**
   * Получает a usage record by ID.
   */
  getById(id: string): UsageRecord | undefined {
    const row = this.db.get<Record<string, unknown>>(
      "SELECT * FROM usage_records WHERE id = $id",
      { id },
    );
    return row ? this.mapRow(row) : undefined;
  }

  /**
   * Получает all usage records for a project.
   */
  getByProject(projectId: string): UsageRecord[] {
    const rows = this.db.all<Record<string, unknown>>(
      "SELECT * FROM usage_records WHERE project_id = $projectId ORDER BY created_at",
      { projectId },
    );
    return rows.map((r) => this.mapRow(r));
  }

  /**
   * Получает all usage records for an epic.
   */
  getByEpic(epicId: string): UsageRecord[] {
    const rows = this.db.all<Record<string, unknown>>(
      "SELECT * FROM usage_records WHERE epic_id = $epicId ORDER BY created_at",
      { epicId },
    );
    return rows.map((r) => this.mapRow(r));
  }

  /**
   * Получает all usage records for a task.
   */
  getByTask(taskId: string): UsageRecord[] {
    const rows = this.db.all<Record<string, unknown>>(
      "SELECT * FROM usage_records WHERE task_id = $taskId ORDER BY created_at",
      { taskId },
    );
    return rows.map((r) => this.mapRow(r));
  }

  /**
   * Получает historical costs by role/model for estimation.
   * возвращает стоимости sorted ascending для p90 calculation.
   */
  getHistoricalCosts(projectId: string, role: string, model: string): number[] {
    const rows = this.db.all<{ actual_cost: number }>(
      "SELECT actual_cost FROM usage_records WHERE project_id = $projectId AND role = $role AND model = $model AND actual_cost > 0 ORDER BY actual_cost",
      { projectId, role, model },
    );
    return rows.map((r) => r.actual_cost);
  }

  private mapRow(row: Record<string, unknown>): UsageRecord {
    return {
      id: row.id as string,
      runId: row.run_id as string | null,
      reservationId: row.reservation_id as string | null,
      projectId: row.project_id as string,
      epicId: row.epic_id as string | null,
      taskId: row.task_id as string | null,
      role: row.role as string,
      model: row.model as string,
      triggerReason: row.trigger_reason as TriggerReason,
      reworkCategory: row.rework_category as string | null,
      inputTokens: row.input_tokens as number,
      cachedTokens: row.cached_tokens as number,
      outputTokens: row.output_tokens as number,
      totalTokens: row.total_tokens as number,
      runtime: row.runtime as string,
      estimatedCost: row.estimated_cost as number,
      actualCost: row.actual_cost as number,
      createdAt: row.created_at as string,
    };
  }
}
