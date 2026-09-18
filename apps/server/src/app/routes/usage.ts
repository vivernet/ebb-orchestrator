import type { FastifyInstance } from "fastify";
import type { Database } from "../../platform/database/database.js";

export interface UsageRouteDeps { db?: Database | undefined; }

/**
 * Экспортируемый компонент или контракт модуля, доступный другим слоям приложения.
 */
export async function usageRoutes(app: FastifyInstance, deps: UsageRouteDeps = {}): Promise<void> {
  app.get("/api/v1/usage", async () => {
    if (!deps.db) {
      return {
        global: { tokens: 0, cost: 0 },
        project: { tokens: 0, cost: 0 },
        epic: { tokens: 0, cost: 0 },
        task: { tokens: 0, cost: 0 },
        effectiveLimit: "global",
      };
    }

    const globalUsage = deps.db.get("SELECT SUM(input_tokens + output_tokens) as tokens, SUM(cost) as cost FROM usage_records");
    const projectUsage = deps.db.get("SELECT SUM(input_tokens + output_tokens) as tokens, SUM(cost) as cost FROM usage_records WHERE project_id IS NOT NULL");
    const epicUsage = deps.db.get("SELECT SUM(input_tokens + output_tokens) as tokens, SUM(cost) as cost FROM usage_records WHERE epic_id IS NOT NULL");
    const taskUsage = deps.db.get("SELECT SUM(input_tokens + output_tokens) as tokens, SUM(cost) as cost FROM usage_records WHERE task_id IS NOT NULL");

    return {
      global: {
        tokens: globalUsage?.tokens ?? 0,
        cost: globalUsage?.cost ?? 0,
      },
      project: {
        tokens: projectUsage?.tokens ?? 0,
        cost: projectUsage?.cost ?? 0,
      },
      epic: {
        tokens: epicUsage?.tokens ?? 0,
        cost: epicUsage?.cost ?? 0,
      },
      task: {
        tokens: taskUsage?.tokens ?? 0,
        cost: taskUsage?.cost ?? 0,
      },
      effectiveLimit: "global",
    };
  });
}
