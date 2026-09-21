/**
 * Сервис бюджетов — иерархическое разрешение budget с атомарными резервированиями.
 *
 * Иерархия budget: global → проект → epic → задача
 * Итоговый лимит = most restrictive доступный лимит.
 * мягкий лимит → ASK, жёсткий лимит → DENY.
 * Атомарные транзакции предотвращать oversubscription races.
 */

import type { Database, DatabaseTx } from "../../platform/database/database.js";
import type {
  BudgetConfig,
  BudgetDecision,
  BudgetScope,
  BudgetPolicy,
  ReconcileResult,
  ReconcileTokenDetails,
  ReserveOptions,
  ReserveResult,
} from "./usage-types.js";

/**
 * иерархическое разрешение budget сервис.
 */
export class BudgetService {
  constructor(private readonly db: Database) {}

  /**
   * Reserve budget для Объект AI run. возвращает ALLOW, ASK, или DENY.
   * Использует a database transaction to prevent oversubscription races.
   */
  reserve(options: ReserveOptions): ReserveResult {
    return this.db.transaction((tx) => {
      // Разрешает effective budget limits across all applicable scopes.
      const scopes = this.resolveScopes(tx, options);
      if (scopes.length === 0) {
        // Нет budget config at all — allow unconditionally.
        const reservationId = this.createReservation(tx, options);
        return { decision: "ALLOW" as BudgetDecision, reservationId };
      }

      // Находит most restrictive scope.
      const mostRestrictive = scopes.reduce((worst, current) => {
        if (current.limitCost < worst.limitCost) return current;
        return worst;
      });

      // Вычисляет total committed cost (spent + reserved + new estimate).
      const totalCommitted = mostRestrictive.spentCost + mostRestrictive.reservedCost + options.estimateCost;

      // Проверяет hard limit first.
      if (totalCommitted > mostRestrictive.limitCost) {
        if (mostRestrictive.policy === "hard") {
          return {
            decision: "DENY" as BudgetDecision,
            reservationId: null,
            reason: `Budget exceeded at ${mostRestrictive.scope} scope: ${totalCommitted} > ${mostRestrictive.limitCost} (hard limit)`,
          };
        }
        // Soft политика: even жёсткий лимит becomes ASK
        return {
          decision: "ASK" as BudgetDecision,
          reservationId: null,
          reason: `Budget exceeded at ${mostRestrictive.scope} scope: ${totalCommitted} > ${mostRestrictive.limitCost} (soft policy)`,
        };
      }

      // Проверяет soft limit.
      if (mostRestrictive.softLimitCost > 0 && totalCommitted > mostRestrictive.softLimitCost) {
        // Reserve anyway but сигнал ASK для approval.
        const reservationId = this.createReservation(tx, options);
        this.addToReservedCosts(tx, options, scopes);
        return {
          decision: "ASK" as BudgetDecision,
          reservationId,
          reason: `Soft budget limit breached at ${mostRestrictive.scope} scope: ${totalCommitted} > ${mostRestrictive.softLimitCost}`,
        };
      }

      // Within все лимиты — reserve и allow.
      const reservationId = this.createReservation(tx, options);
      this.addToReservedCosts(tx, options, scopes);
      return { decision: "ALLOW" as BudgetDecision, reservationId };
    });
  }

  /**
   * Reconcile Объект резервирование с фактическую стоимость после run completes.
   */
  reconcile(
    reservationId: string,
    actualCost: number,
    tokens?: ReconcileTokenDetails,
  ): ReconcileResult {
    return this.db.transaction((tx) => {
      const reservation = tx.get<{
        id: string;
        project_id: string;
        epic_id: string | null;
        task_id: string | null;
        estimate_cost: number;
        role: string;
        model: string;
        trigger_reason: string;
        rework_category: string | null;
        status: string;
      }>(
        "SELECT id, project_id, epic_id, task_id, estimate_cost, role, model, trigger_reason, rework_category, status FROM budget_reservations WHERE id = $id",
        { id: reservationId },
      );

      if (!reservation || reservation.status !== "RESERVED") {
        return { status: "ALREADY_RECONCILED" as const, actualCost: 0, reservationId };
      }

      const actual = Math.max(0, actualCost);

      // Обновляет reservation status.
      tx.run(
        "UPDATE budget_reservations SET status = 'RECONCILED', actual_cost = $actual, reconciled_at = $at WHERE id = $id AND status = 'RESERVED'",
        { id: reservationId, actual, at: new Date().toISOString() },
      );

      // Обновляет budget config: subtract reserved, add spent.
      // Include epic/задача configs если эти ID доступны.
      const configs = this.getApplicableConfigs(tx, reservation.project_id, reservation.epic_id, reservation.task_id);
      for (const config of configs) {
        tx.run(
          "UPDATE budget_configs SET reserved_cost = MAX(0, reserved_cost - $estimate), spent_cost = spent_cost + $actual, updated_at = $at WHERE id = $configId",
          { configId: config.id, estimate: reservation.estimate_cost, actual, at: new Date().toISOString() },
        );
      }

      // Создаёт usage record if token details provided.
      if (tokens) {
        const usageId = crypto.randomUUID();
        const inputTokens = tokens.inputTokens ?? 0;
        const cachedTokens = tokens.cachedTokens ?? 0;
        const outputTokens = tokens.outputTokens ?? 0;
        const runtime = tokens.runtime ?? "";
        tx.run(
          `INSERT INTO usage_records (
            id, reservation_id, project_id, role, model, trigger_reason, rework_category,
            input_tokens, cached_tokens, output_tokens, total_tokens,
            runtime, estimated_cost, actual_cost, created_at
          ) VALUES (
            $id, $reservationId, $projectId, $role, $model, $triggerReason, $reworkCategory,
            $inputTokens, $cachedTokens, $outputTokens, $totalTokens,
            $runtime, $estimatedCost, $actualCost, $createdAt
          )`,
          {
            id: usageId,
            reservationId,
            projectId: reservation.project_id,
            role: reservation.role,
            model: reservation.model,
            triggerReason: reservation.trigger_reason,
            reworkCategory: reservation.rework_category,
            inputTokens,
            cachedTokens,
            outputTokens,
            totalTokens: inputTokens + cachedTokens + outputTokens,
            runtime,
            estimatedCost: reservation.estimate_cost,
            actualCost: actual,
            createdAt: new Date().toISOString(),
          },
        );
      }

      return { status: "RECONCILED" as const, actualCost: actual, reservationId };
    });
  }

  /**
   * Release stale RESERVED резервирования который являются не in Объект set of активный резервирование IDs.
   * Для each stale reservation, decrements reserved_cost on all applicable budget configs.
   */
  cleanupStaleReservations(activeReservationIds: string[]): { released: number } {
    return this.db.transaction((tx) => {
      // Находит all RESERVED reservations not in the active set.
      let staleRows: { id: string; project_id: string; epic_id: string | null; task_id: string | null; estimate_cost: number }[];
      if (activeReservationIds.length > 0) {
        const placeholders = activeReservationIds.map((_, i) => `$active${i}`).join(", ");
        const params: Record<string, string> = {};
        activeReservationIds.forEach((id, i) => { params[`active${i}`] = id; });
        staleRows = tx.all<{ id: string; project_id: string; epic_id: string | null; task_id: string | null; estimate_cost: number }>(
          `SELECT id, project_id, epic_id, task_id, estimate_cost FROM budget_reservations WHERE status = 'RESERVED' AND id NOT IN (${placeholders})`,
          params,
        );
      } else {
        staleRows = tx.all<{ id: string; project_id: string; epic_id: string | null; task_id: string | null; estimate_cost: number }>(
          "SELECT id, project_id, epic_id, task_id, estimate_cost FROM budget_reservations WHERE status = 'RESERVED'",
        );
      }

      for (const row of staleRows) {
        // Release Объект резервирование.
        tx.run(
          "UPDATE budget_reservations SET status = 'RELEASED' WHERE id = $id AND status = 'RESERVED'",
          { id: row.id },
        );

        // Decrement reserved_cost on все применимые configs.
        const configs = this.getApplicableConfigs(tx, row.project_id, row.epic_id, row.task_id);
        for (const config of configs) {
          tx.run(
            "UPDATE budget_configs SET reserved_cost = MAX(0, reserved_cost - $estimate), updated_at = $at WHERE id = $configId",
            { configId: config.id, estimate: row.estimate_cost, at: new Date().toISOString() },
          );
        }
      }

      return { released: staleRows.length };
    });
  }

  /**
   * Estimate стоимость из скользящий исторический p90 by роль/модель с безопасным нижним пределом.
   */
  estimateCost(projectId: string, role: string, model: string): number {
    const values = this.db.all<{ actual_cost: number }>(
      "SELECT actual_cost FROM usage_records WHERE project_id = $projectId AND role = $role AND model = $model AND actual_cost > 0 ORDER BY actual_cost",
      { projectId, role, model },
    );
    if (!values.length) return 1; // default floor
    // p90: индекс at ceil(n * 0.9) - 1
    const index = Math.min(values.length - 1, Math.ceil(values.length * 0.9) - 1);
    return Math.max(0, values[index]!.actual_cost * 1.25);
  }

  /**
   * Разрешает all applicable budget configs for the given scopes.
   */
  private resolveScopes(tx: DatabaseTx, options: ReserveOptions): BudgetConfig[] {
    const configs: BudgetConfig[] = [];

    // Глобальная область
    const global = tx.get<Record<string, unknown>>(
      "SELECT * FROM budget_configs WHERE scope = 'global' AND scope_id = 'global'",
    );
    if (global) configs.push(this.mapConfig(global));

    // Область проекта
    const project = tx.get<Record<string, unknown>>(
      "SELECT * FROM budget_configs WHERE scope = 'project' AND scope_id = $scopeId",
      { scopeId: options.projectId },
    );
    if (project) configs.push(this.mapConfig(project));

    // Область Epic
    if (options.epicId) {
      const epic = tx.get<Record<string, unknown>>(
        "SELECT * FROM budget_configs WHERE scope = 'epic' AND scope_id = $scopeId",
        { scopeId: options.epicId },
      );
      if (epic) configs.push(this.mapConfig(epic));
    }

    // Область задачи
    if (options.taskId) {
      const task = tx.get<Record<string, unknown>>(
        "SELECT * FROM budget_configs WHERE scope = 'task' AND scope_id = $scopeId",
        { scopeId: options.taskId },
      );
      if (task) configs.push(this.mapConfig(task));
    }

    return configs;
  }

  /**
   * Получает all applicable configs for reconciliation.
   * Включает epic/task configs when those IDs are available.
   */
  private getApplicableConfigs(
    tx: DatabaseTx,
    projectId: string,
    epicId?: string | null,
    taskId?: string | null,
  ): BudgetConfig[] {
    const configs: BudgetConfig[] = [];
    const global = tx.get<Record<string, unknown>>(
      "SELECT * FROM budget_configs WHERE scope = 'global' AND scope_id = 'global'",
    );
    if (global) configs.push(this.mapConfig(global));
    const project = tx.get<Record<string, unknown>>(
      "SELECT * FROM budget_configs WHERE scope = 'project' AND scope_id = $scopeId",
      { scopeId: projectId },
    );
    if (project) configs.push(this.mapConfig(project));
    if (epicId) {
      const epic = tx.get<Record<string, unknown>>(
        "SELECT * FROM budget_configs WHERE scope = 'epic' AND scope_id = $scopeId",
        { scopeId: epicId },
      );
      if (epic) configs.push(this.mapConfig(epic));
    }
    if (taskId) {
      const task = tx.get<Record<string, unknown>>(
        "SELECT * FROM budget_configs WHERE scope = 'task' AND scope_id = $scopeId",
        { scopeId: taskId },
      );
      if (task) configs.push(this.mapConfig(task));
    }
    return configs;
  }

  private createReservation(tx: DatabaseTx, options: ReserveOptions): string {
    const id = crypto.randomUUID();
    tx.run(
      `INSERT INTO budget_reservations (
        id, project_id, epic_id, task_id, estimate_cost,
        status, role, model, trigger_reason, rework_category, created_at
      ) VALUES (
        $id, $projectId, $epicId, $taskId, $estimateCost,
        'RESERVED', $role, $model, $triggerReason, $reworkCategory, $createdAt
      )`,
      {
        id,
        projectId: options.projectId,
        epicId: options.epicId ?? null,
        taskId: options.taskId ?? null,
        estimateCost: options.estimateCost,
        role: options.role,
        model: options.model,
        triggerReason: options.triggerReason,
        reworkCategory: options.reworkCategory ?? null,
        createdAt: new Date().toISOString(),
      },
    );
    return id;
  }

  private addToReservedCosts(tx: DatabaseTx, options: ReserveOptions, scopes: BudgetConfig[]): void {
    for (const scope of scopes) {
      tx.run(
        "UPDATE budget_configs SET reserved_cost = reserved_cost + $estimate, updated_at = $at WHERE id = $configId",
        { configId: scope.id, estimate: options.estimateCost, at: new Date().toISOString() },
      );
    }
  }

  private mapConfig(row: Record<string, unknown>): BudgetConfig {
    return {
      id: row.id as string,
      scope: row.scope as BudgetScope,
      scopeId: row.scope_id as string,
      limitCost: row.limit_cost as number,
      softLimitCost: row.soft_limit_cost as number,
      policy: row.policy as BudgetPolicy,
      spentCost: row.spent_cost as number,
      reservedCost: row.reserved_cost as number,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}
