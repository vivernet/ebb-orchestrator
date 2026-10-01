import type { FastifyInstance } from "fastify";
import type { SettingsProjection } from "@ebb-orchestrator/contracts";
import type { SchedulerService } from "../../modules/scheduler/scheduler-service.js";

export interface SettingsRouteDeps { scheduler?: Pick<SchedulerService, "getConfig">; }

// Эти значения — текущие архитектурные инварианты, а не редактируемые настройки.
const SECURITY_FACTS = { mostRestrictiveWins: true, localModeEnabled: true } as const;

/**
 * Регистрирует read-only Settings projection из подтверждённых Scheduler и security facts.
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
        securitySettings: SECURITY_FACTS,
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
    securitySettings: SECURITY_FACTS,
  };
}
