import type { FastifyInstance } from "fastify";
import type { SettingsProjection } from "@ebb-orchestrator/contracts";
import type { SchedulerService } from "../../modules/scheduler/scheduler-service.js";
import { listSupportedModels } from "../../modules/runtime/hermes/hermes-provider-registry.js";
import { loadOrchestratorEnv } from "../../platform/config/orchestrator-env-loader.js";

export interface SettingsRouteDeps { scheduler?: Pick<SchedulerService, "getConfig">; }

// Эти значения — текущие архитектурные инварианты, а не редактируемые настройки.
const SECURITY_FACTS = { mostRestrictiveWins: true, localModeEnabled: true } as const;

/**
 * Строит read-only проекцию выбора ИИ-провайдера/модели из статического реестра
 * built-in моделей и признака настроенности ключа. Значения ключей наружу не
 * попадают: `keyConfigured` — только булев признак.
 */
function buildProviderSelection(): SettingsProjection["providerSelection"] {
  return {
    defaultModel: "default",
    models: listSupportedModels().map((entry) => ({
      model: entry.model,
      provider: entry.provider,
      keyConfigured: Boolean(loadOrchestratorEnv([entry.envKey])[entry.envKey]),
    })),
  };
}

/**
 * Регистрирует read-only Settings projection из подтверждённых Scheduler, security
 * facts и статуса ИИ-провайдеров (реестр built-in моделей Hermes, без значений ключей).
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
        providerSelection: buildProviderSelection(),
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
    providerSelection: buildProviderSelection(),
  };
}
