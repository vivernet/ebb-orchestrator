import type { FastifyInstance } from "fastify";
import type { Database } from "../../platform/database/database.js";

export interface UsageRouteDeps { db?: Database | undefined; }

type UsageAggregation =
  | "all_records"
  | "records_with_project_id"
  | "records_with_epic_id"
  | "records_with_task_id";

interface UsageBucket {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Совместимый с текущим UI alias для totalTokens. */
  tokens: number;
  cost: number;
  /** Описывает aggregate membership; это не scoped budget identity. */
  aggregation: UsageAggregation;
}

interface UsageAggregateRow {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
}

/**
 * Регистрирует HTTP-маршруты usage и передаёт изменяющие состояние действия backend policy.
 */
export async function usageRoutes(app: FastifyInstance, deps: UsageRouteDeps = {}): Promise<void> {
  app.get("/api/v1/usage", async () => {
    if (!deps.db) {
      return {
        global: emptyUsageBucket("all_records"),
        project: emptyUsageBucket("records_with_project_id"),
        epic: emptyUsageBucket("records_with_epic_id"),
        task: emptyUsageBucket("records_with_task_id"),
        effectiveLimit: "global",
      };
    }

    const globalUsage = aggregateUsage(deps.db, "all_records");
    const projectUsage = aggregateUsage(deps.db, "records_with_project_id", "project_id IS NOT NULL");
    const epicUsage = aggregateUsage(deps.db, "records_with_epic_id", "epic_id IS NOT NULL");
    const taskUsage = aggregateUsage(deps.db, "records_with_task_id", "task_id IS NOT NULL");

    return {
      global: globalUsage,
      project: projectUsage,
      epic: epicUsage,
      task: taskUsage,
      effectiveLimit: "global",
    };
  });
}

function aggregateUsage(
  db: Database,
  aggregation: UsageAggregation,
  predicate?: string,
): UsageBucket {
  const row = db.get<UsageAggregateRow>(
    `SELECT
       COALESCE(SUM(input_tokens), 0) AS inputTokens,
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

function emptyUsageBucket(aggregation: UsageAggregation): UsageBucket {
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
