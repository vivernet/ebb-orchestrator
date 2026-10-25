import type {
  ActiveUsageBudgetReservationProjection,
  AvailabilityValue,
  UsageBudgetContextProjection,
  UsageBudgetLimitProjection,
  UsageBudgetScope,
  UsageSummary,
  UsageWindowProjection,
} from "@ebb-orchestrator/contracts";
import type { Database } from "../../platform/database/database.js";

interface UsageAggregateRow {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
}

interface BreakdownRow {
  key: string;
  spend: number;
  tokens: number;
  runCount: number;
}

interface ModelComparisonRow {
  role: string;
  model: string;
  runs: number;
  spend: number;
}

interface ProjectRow { id: string; }
interface EpicRow { id: string; project_id: string; }
interface TaskRow { id: string; project_id: string; epic_id: string | null; }

const UNAVAILABLE_DETERMINISTIC_CHECK: AvailabilityValue = { availability: "unavailable", reason: "NO_DURABLE_CHECK_EXECUTION_SOURCE" };
const UNAVAILABLE_NO_POLICY: AvailabilityValue = { availability: "unavailable", reason: "NO_APPROVED_POLICY" };
const UNAVAILABLE_NOT_RECORDED: AvailabilityValue = { availability: "unavailable", reason: "NOT_RECORDED" };

function availabilityFromNullableNumber(value: number | null): AvailabilityValue {
  return value === null ? UNAVAILABLE_NOT_RECORDED : { availability: "available", value };
}

/**
 * Read-only проекция страницы Usage & Budget (plan-27 Task 5).
 *
 * Все агрегаты окна выводятся только из персистентных строк (usage_records,
 * context_manifests, budget_configs, budget_reservations) в инклюзивном
 * UTC-окне [from, to]. Неподтверждённые статистики возвращают field-level
 * `unavailable` с причиной; никакие значения не выдумываются. Модель не владеет
 * budget-командой записи — политики изменяются только через Settings candidate
 * и его exact-hash approval (Task 4).
 */
export class UsageReadModel {
  constructor(private readonly db?: Database) {}

  getWindow(window: { from: string; to: string; granularity: "day" | "hour" | "month" }): UsageWindowProjection {
    if (!this.db) return emptyWindowProjection(window);
    const db = this.db;
    // Инклюзивные границы окна: persisted created_at всегда с миллисекундами,
    // а schema допускает `...:00Z` без них. Для `to` без миллисекунд берём
    // конец секунды (.999Z), чтобы весь этот интервал был включён; для `from`
    // — начало секунды (.000Z). Строковое сравнение канонических ISO-UTC
    // остаётся корректным.
    const toUpper = normalizeToBound(window.to);
    const params = { from: normalizeFromBound(window.from), to: toUpper };
    const where = "created_at >= $from AND created_at <= $to";

    const summary = aggregateUsage(db, where, params);
    const totalSpend = summary.cost;

    const dailySeries = bucketUsage(db, window.granularity, where, params);
    const byRole = breakdownUsage(db, "role", where, params, totalSpend);
    const byReason = breakdownUsage(db, "trigger_reason", where, params, totalSpend);
    const byModel = breakdownUsage(db, "model", where, params, totalSpend);

    const budgets = this.readBudgets();

    return {
      window: { from: window.from, to: window.to, granularity: window.granularity },
      summary,
      dailySeries,
      breakdowns: { byRole, byReason, byModel },
      modelComparison: modelComparison(db, where, params),
      budgets,
      efficiency: {
        cacheShare: cacheShare(summary),
        averageInitialContextTokens: averageInitialContextTokens(db, where, params),
        averageOutputTokens: averageOutputTokens(db, where, params),
        aiRunsPerTask: aiRunsPerTask(db, where, params),
        reworkCyclesPerTask: reworkCyclesPerTask(db, where, params),
        deterministicCheckCount: UNAVAILABLE_DETERMINISTIC_CHECK,
        deterministicCheckCost: UNAVAILABLE_DETERMINISTIC_CHECK,
      },
      anomaly: UNAVAILABLE_NO_POLICY,
      taskRecoveryShare: UNAVAILABLE_NO_POLICY,
    };
  }

  private readBudgets(): UsageWindowProjection["budgets"] {
    const db = this.db;
    if (!db) return { configurations: [], contexts: [], activeReservations: [] };
    const configurations = db.all<UsageBudgetLimitProjection>(
      `SELECT scope, scope_id AS scopeId, limit_cost AS limitCost,
              soft_limit_cost AS softLimitCost, policy,
              spent_cost AS spentCost, reserved_cost AS reservedCost
       FROM budget_configs
       ORDER BY CASE scope WHEN 'global' THEN 0 WHEN 'project' THEN 1 WHEN 'epic' THEN 2 ELSE 3 END, scope_id`,
    );
    const configByKey = new Map(configurations.map((config) => [configKey(config.scope, config.scopeId), config]));
    const contexts: UsageBudgetContextProjection[] = [makeContext("global", "global", null, null, null, configByKey)];
    for (const row of db.all<ProjectRow>("SELECT id FROM projects ORDER BY id")) {
      contexts.push(makeContext("project", row.id, row.id, null, null, configByKey));
    }
    for (const row of db.all<EpicRow>("SELECT id, project_id FROM epics ORDER BY id")) {
      contexts.push(makeContext("epic", row.id, row.project_id, row.id, null, configByKey));
    }
    for (const row of db.all<TaskRow>("SELECT id, project_id, epic_id FROM tasks ORDER BY id")) {
      contexts.push(makeContext("task", row.id, row.project_id, row.epic_id, row.id, configByKey));
    }
    const activeReservations = db.all<ActiveUsageBudgetReservationProjection>(
      `SELECT id, project_id AS projectId, epic_id AS epicId, task_id AS taskId,
              estimate_cost AS estimateCost, status, role, model,
              trigger_reason AS triggerReason, rework_category AS reworkCategory,
              created_at AS createdAt
       FROM budget_reservations
       WHERE status = 'RESERVED'
       ORDER BY created_at, id`,
    );
    return { configurations, contexts, activeReservations };
  }
}

function aggregateUsage(db: Database, where: string, params: Record<string, string>): UsageSummary {
  const row = db.get<UsageAggregateRow>(
    `SELECT COALESCE(SUM(input_tokens), 0) AS inputTokens,
            COALESCE(SUM(cached_tokens), 0) AS cachedTokens,
            COALESCE(SUM(output_tokens), 0) AS outputTokens,
            COALESCE(SUM(total_tokens), 0) AS totalTokens,
            COALESCE(SUM(actual_cost), 0) AS cost
     FROM usage_records WHERE ${where}`,
    params,
  );
  return {
    inputTokens: row?.inputTokens ?? 0,
    cachedTokens: row?.cachedTokens ?? 0,
    outputTokens: row?.outputTokens ?? 0,
    totalTokens: row?.totalTokens ?? 0,
    cost: row?.cost ?? 0,
  };
}

function bucketExpression(granularity: "day" | "hour" | "month"): { expression: string; label: (bucket: string) => string } {
  if (granularity === "hour") {
    return { expression: "strftime('%Y-%m-%dT%H:00:00Z', created_at)", label: (bucket) => bucket };
  }
  if (granularity === "month") {
    return { expression: "strftime('%Y-%m', created_at)", label: (bucket) => bucket };
  }
  return { expression: "strftime('%Y-%m-%d', created_at)", label: (bucket) => bucket };
}

function bucketUsage(
  db: Database,
  granularity: "day" | "hour" | "month",
  where: string,
  params: Record<string, string>,
): UsageWindowProjection["dailySeries"] {
  const { expression, label } = bucketExpression(granularity);
  const rows = db.all<{ bucket: string; inputTokens: number; cachedTokens: number; outputTokens: number; totalTokens: number; cost: number }>(
    `SELECT ${expression} AS bucket,
            COALESCE(SUM(input_tokens), 0) AS inputTokens,
            COALESCE(SUM(cached_tokens), 0) AS cachedTokens,
            COALESCE(SUM(output_tokens), 0) AS outputTokens,
            COALESCE(SUM(total_tokens), 0) AS totalTokens,
            COALESCE(SUM(actual_cost), 0) AS cost
     FROM usage_records WHERE ${where}
     GROUP BY bucket ORDER BY bucket`,
    params,
  );
  return rows.map((row) => ({
    date: label(row.bucket),
    usage: {
      inputTokens: row.inputTokens,
      cachedTokens: row.cachedTokens,
      outputTokens: row.outputTokens,
      totalTokens: row.totalTokens,
      cost: row.cost,
    },
  }));
}

function breakdownUsage(
  db: Database,
  groupColumn: string,
  where: string,
  params: Record<string, string>,
  totalSpend: number,
): UsageWindowProjection["breakdowns"]["byRole"] {
  const rows = db.all<BreakdownRow>(
    `SELECT ${groupColumn} AS key,
            SUM(actual_cost) AS spend,
            SUM(total_tokens) AS tokens,
            COUNT(*) AS runCount
     FROM usage_records WHERE ${where}
     GROUP BY key ORDER BY spend DESC, key`,
    params,
  );
  return rows.map((row) => ({
    key: row.key,
    spend: row.spend,
    tokens: row.tokens,
    share: totalSpend > 0 ? clamp01(row.spend / totalSpend) : 0,
    runCount: row.runCount,
  }));
}

function modelComparison(db: Database, where: string, params: Record<string, string>): UsageWindowProjection["modelComparison"] {
  const rows = db.all<ModelComparisonRow>(
    `SELECT role, model, COUNT(*) AS runs, SUM(actual_cost) AS spend
     FROM usage_records WHERE ${where}
     GROUP BY role, model ORDER BY role, model`,
    params,
  );
  return rows.map((row) => ({
    role: row.role,
    model: row.model,
    averageCostPerRun: row.runs > 0 ? row.spend / row.runs : 0,
    runs: row.runs,
  }));
}

function cacheShare(summary: UsageSummary): AvailabilityValue {
  if (summary.totalTokens > 0) {
    return { availability: "available", value: clamp01(summary.cachedTokens / summary.totalTokens) };
  }
  return UNAVAILABLE_NOT_RECORDED;
}

function averageInitialContextTokens(db: Database, where: string, params: Record<string, string>): AvailabilityValue {
  const row = db.get<{ avg: number | null }>(
    `SELECT AVG(initial_token_size) AS avg
     FROM context_manifests
     WHERE ${where} AND initial_token_size IS NOT NULL`,
    params,
  );
  return availabilityFromNullableNumber(row?.avg ?? null);
}

function averageOutputTokens(db: Database, where: string, params: Record<string, string>): AvailabilityValue {
  const row = db.get<{ avg: number | null }>(
    `SELECT AVG(output_tokens) AS avg FROM usage_records WHERE ${where}`,
    params,
  );
  return availabilityFromNullableNumber(row?.avg ?? null);
}

function aiRunsPerTask(db: Database, where: string, params: Record<string, string>): AvailabilityValue {
  const row = db.get<{ runs: number; tasks: number }>(
    `SELECT COUNT(*) AS runs, COUNT(DISTINCT task_id) AS tasks
     FROM usage_records WHERE ${where} AND task_id IS NOT NULL`,
    params,
  );
  const tasks = row?.tasks ?? 0;
  return tasks > 0 ? { availability: "available", value: (row?.runs ?? 0) / tasks } : UNAVAILABLE_NOT_RECORDED;
}

function reworkCyclesPerTask(db: Database, where: string, params: Record<string, string>): AvailabilityValue {
  const row = db.get<{ rework: number; tasks: number }>(
    `SELECT COALESCE(SUM(CASE WHEN rework_category IS NOT NULL THEN 1 ELSE 0 END), 0) AS rework,
            COUNT(DISTINCT task_id) AS tasks
     FROM usage_records WHERE ${where} AND task_id IS NOT NULL`,
    params,
  );
  const tasks = row?.tasks ?? 0;
  return tasks > 0 ? { availability: "available", value: (row?.rework ?? 0) / tasks } : UNAVAILABLE_NOT_RECORDED;
}

function makeContext(
  scope: UsageBudgetScope,
  scopeId: string,
  projectId: string | null,
  epicId: string | null,
  taskId: string | null,
  configByKey: Map<string, UsageBudgetLimitProjection>,
): UsageBudgetContextProjection {
  const candidates = [
    configByKey.get(configKey("global", "global")),
    projectId ? configByKey.get(configKey("project", projectId)) : undefined,
    epicId ? configByKey.get(configKey("epic", epicId)) : undefined,
    taskId ? configByKey.get(configKey("task", taskId)) : undefined,
  ].filter((candidate): candidate is UsageBudgetLimitProjection => candidate !== undefined);
  const effectiveLimit = candidates.reduce<UsageBudgetLimitProjection | null>(
    (mostRestrictive, candidate) => !mostRestrictive || candidate.limitCost < mostRestrictive.limitCost ? candidate : mostRestrictive,
    null,
  );
  return { scope, scopeId, projectId, epicId, taskId, applicableLimits: candidates, effectiveLimit };
}

function configKey(scope: UsageBudgetScope, scopeId: string): string {
  return JSON.stringify([scope, scopeId]);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function normalizeFromBound(from: string): string {
  return /\.\d{3}Z$/.test(from) ? from : from.replace(/Z$/, ".000Z");
}

function normalizeToBound(to: string): string {
  return /\.\d{3}Z$/.test(to) ? to : to.replace(/Z$/, ".999Z");
}

function emptyWindowProjection(window: { from: string; to: string; granularity: "day" | "hour" | "month" }): UsageWindowProjection {
  const emptySummary: UsageSummary = { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 };
  return {
    window: { from: window.from, to: window.to, granularity: window.granularity },
    summary: emptySummary,
    dailySeries: [],
    breakdowns: { byRole: [], byReason: [], byModel: [] },
    modelComparison: [],
    budgets: { configurations: [], contexts: [], activeReservations: [] },
    efficiency: {
      cacheShare: UNAVAILABLE_NOT_RECORDED,
      averageInitialContextTokens: UNAVAILABLE_NOT_RECORDED,
      averageOutputTokens: UNAVAILABLE_NOT_RECORDED,
      aiRunsPerTask: UNAVAILABLE_NOT_RECORDED,
      reworkCyclesPerTask: UNAVAILABLE_NOT_RECORDED,
      deterministicCheckCount: UNAVAILABLE_DETERMINISTIC_CHECK,
      deterministicCheckCost: UNAVAILABLE_DETERMINISTIC_CHECK,
    },
    anomaly: UNAVAILABLE_NO_POLICY,
    taskRecoveryShare: UNAVAILABLE_NO_POLICY,
  };
}
