import type {
  ActiveUsageBudgetReservationProjection,
  UsageBudgetContextProjection,
  UsageBudgetLimitProjection,
  UsageBudgetScope,
  UsageMetricBucketProjection,
  UsagePageProjection,
} from "@ebb-orchestrator/contracts";
import type { Database } from "../../platform/database/database.js";

type UsageAggregation = UsageMetricBucketProjection["aggregation"];

interface UsageAggregateRow {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
}

interface ProjectRow { id: string; }
interface EpicRow { id: string; project_id: string; }
interface TaskRow { id: string; project_id: string; epic_id: string | null; }

/** Собирает read-only сводку Usage, лимитов и текущих резервирований из Usage-owned таблиц. */
export class UsageReadModel {
  constructor(private readonly db?: Database) {}

  get(): UsagePageProjection {
    if (!this.db) return emptyUsageProjection();

    const db = this.db;
    const configurations = db.all<UsageBudgetLimitProjection>(
      `SELECT scope, scope_id AS scopeId, limit_cost AS limitCost,
              soft_limit_cost AS softLimitCost, policy,
              spent_cost AS spentCost, reserved_cost AS reservedCost
       FROM budget_configs
       ORDER BY CASE scope WHEN 'global' THEN 0 WHEN 'project' THEN 1 WHEN 'epic' THEN 2 ELSE 3 END, scope_id`,
    );
    const configByKey = new Map(configurations.map((config) => [configKey(config.scope, config.scopeId), config]));
    const global = aggregateUsage(db, "all_records");
    const project = aggregateUsage(db, "records_with_project_id", "project_id IS NOT NULL");
    const epic = aggregateUsage(db, "records_with_epic_id", "epic_id IS NOT NULL");
    const task = aggregateUsage(db, "records_with_task_id", "task_id IS NOT NULL");

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

    return {
      global,
      project,
      epic,
      task,
      budget: { configurations, contexts, activeReservations },
    };
  }
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

function aggregateUsage(db: Database, aggregation: UsageAggregation, predicate?: string): UsageMetricBucketProjection {
  const row = db.get<UsageAggregateRow>(
    `SELECT COALESCE(SUM(input_tokens), 0) AS inputTokens,
            COALESCE(SUM(cached_tokens), 0) AS cachedTokens,
            COALESCE(SUM(output_tokens), 0) AS outputTokens,
            COALESCE(SUM(total_tokens), 0) AS totalTokens,
            COALESCE(SUM(actual_cost), 0) AS cost
     FROM usage_records${predicate ? ` WHERE ${predicate}` : ""}`,
  );
  const totalTokens = row?.totalTokens ?? 0;
  return {
    inputTokens: row?.inputTokens ?? 0,
    cachedTokens: row?.cachedTokens ?? 0,
    outputTokens: row?.outputTokens ?? 0,
    totalTokens,
    tokens: totalTokens,
    cost: row?.cost ?? 0,
    aggregation,
  };
}

function emptyUsageProjection(): UsagePageProjection {
  return {
    global: emptyUsageBucket("all_records"),
    project: emptyUsageBucket("records_with_project_id"),
    epic: emptyUsageBucket("records_with_epic_id"),
    task: emptyUsageBucket("records_with_task_id"),
    budget: { configurations: [], contexts: [], activeReservations: [] },
  };
}

function emptyUsageBucket(aggregation: UsageAggregation): UsageMetricBucketProjection {
  return {
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    tokens: 0,
    cost: 0,
    aggregation,
  };
}
