import type { FastifyInstance } from "fastify";
import type { Database } from "../../platform/database/database.js";
interface SchedulerConfigRow { config_json: string; }

export interface SettingsRouteDeps { db?: Database | undefined; }

/**
 * Регистрирует HTTP-маршруты settings и передаёт изменяющие состояние действия backend policy.
 */
export async function settingsRoutes(app: FastifyInstance, deps: SettingsRouteDeps = {}): Promise<void> {
  app.get("/api/v1/settings", async () => {
    if (!deps.db) {
      return {
        effectiveHierarchy: {
          global: { maxParallelAgents: 5, defaultModel: "gpt-4" },
          project: {},
          role: {},
          taskEpic: {},
        },
        securitySettings: {
          mostRestrictiveWins: true,
          localModeEnabled: false,
        },
      };
    }

    const config = deps.db.get<SchedulerConfigRow>("SELECT config_json FROM scheduler_config WHERE id = 1");
    const global = config ? parseSchedulerConfig(config.config_json) : {};

    return {
      effectiveHierarchy: {
        global,
        project: {},
        role: {},
        taskEpic: {},
      },
      securitySettings: {
        mostRestrictiveWins: true,
        localModeEnabled: false,
      },
    };
  });

}

function parseSchedulerConfig(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
