import type { FastifyInstance } from "fastify";
import type { Database } from "../../platform/database/database.js";

export interface SettingsRouteDeps { db?: Database | undefined; }

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

    const globalConfig = deps.db.get("SELECT * FROM config WHERE level = 'global'");
    const projectConfig = deps.db.get("SELECT * FROM config WHERE level = 'project'");
    const roleConfig = deps.db.all("SELECT * FROM config WHERE level = 'role'");
    const taskEpicConfig = deps.db.all("SELECT * FROM config WHERE level IN ('task', 'epic')");
    const securitySettings = deps.db.get("SELECT * FROM security_settings LIMIT 1");

    return {
      effectiveHierarchy: {
        global: globalConfig?.data || {},
        project: projectConfig?.data || {},
        role: roleConfig.reduce((acc, row) => {
          acc[row.role] = row.data || {};
          return acc;
        }, {} as Record<string, Record<string, unknown>>),
        taskEpic: taskEpicConfig.reduce((acc, row) => {
          acc[row.subject_type] = row.data || {};
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
      "INSERT OR REPLACE INTO config (level, key, value) VALUES (?, ?, ?)",
      body.level, body.key, JSON.stringify(body.value)
    );

    return { success: true };
  });
}
