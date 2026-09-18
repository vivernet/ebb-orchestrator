import type { FastifyInstance } from "fastify";
import type { Database } from "../../platform/database/database.js";
type ConfigRow = Record<string, unknown>;

export interface SettingsRouteDeps { db?: Database | undefined; }

/**
 * Экспортируемый компонент или контракт модуля, доступный другим слоям приложения.
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

    const globalConfig = deps.db.get<ConfigRow>("SELECT * FROM config WHERE level = 'global'");
    const projectConfig = deps.db.get<ConfigRow>("SELECT * FROM config WHERE level = 'project'");
    const roleConfig = deps.db.all<ConfigRow>("SELECT * FROM config WHERE level = 'role'");
    const taskEpicConfig = deps.db.all<ConfigRow>("SELECT * FROM config WHERE level IN ('task', 'epic')");
    const securitySettings = deps.db.get<ConfigRow>("SELECT * FROM security_settings LIMIT 1");

    return {
      effectiveHierarchy: {
        global: globalConfig?.data || {},
        project: projectConfig?.data || {},
        role: roleConfig.reduce((acc, row) => {
          acc[String(row.role)] = row.data || {};
          return acc;
        }, {} as Record<string, Record<string, unknown>>),
        taskEpic: taskEpicConfig.reduce((acc, row) => {
          acc[String(row.subject_type)] = row.data || {};
          return acc;
        }, {} as Record<string, Record<string, unknown>>),
      },
      securitySettings: {
        mostRestrictiveWins: securitySettings?.most_restrictive_wins ?? true,
        localModeEnabled: securitySettings?.local_mode_enabled ?? false,
      },
    };
  });

  app.post("/api/v1/settings", async (request, reply) => {
    if (!deps.db) {
      return reply.code(503).send({ error: "database unavailable" });
    }

    const body = request.body as { level: string; key: string; value: unknown } | undefined;
    if (!body) {
      return reply.code(400).send({ error: "request body required" });
    }

    deps.db.run(
      "INSERT OR REPLACE INTO config (level, key, value) VALUES ($level, $key, $value)",
      { level: body.level, key: body.key, value: JSON.stringify(body.value) }
    );

    return { success: true };
  });
}
