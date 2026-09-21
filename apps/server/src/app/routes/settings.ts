import type { FastifyInstance } from "fastify";
import type { SettingsProjection } from "@ebb-orchestrator/contracts";
import type { SchedulerService } from "../../modules/scheduler/scheduler-service.js";

export interface SettingsRouteDeps { scheduler?: Pick<SchedulerService, "getConfig">; }

/**
 * Регистрирует HTTP-маршруты settings и передаёт изменяющие состояние действия backend policy.
 */
export async function settingsRoutes(app: FastifyInstance, deps: SettingsRouteDeps = {}): Promise<void> {
  app.get("/api/v1/settings", async (_request, reply): Promise<SettingsProjection | unknown> => {
    if (!deps.scheduler) return unavailableSettings();

    try {
      const config = deps.scheduler.getConfig();
      return {
        effectiveHierarchy: {
          global: config,
          project: null,
          role: null,
          taskEpic: null,
        },
        securitySettings: { mostRestrictiveWins: null, localModeEnabled: null },
      } satisfies SettingsProjection;
    } catch {
      return reply.code(503).send({ error: "scheduler configuration unavailable" });
    }
  });
}

function unavailableSettings(): SettingsProjection {
  return {
    effectiveHierarchy: {
      global: { schemaVersion: null, globalMax: null, projectMax: null, roleCapacity: null },
      project: null,
      role: null,
      taskEpic: null,
    },
    securitySettings: { mostRestrictiveWins: null, localModeEnabled: null },
  };
}
