import type { FastifyInstance } from "fastify";
import type { UsageWindowProjection } from "@ebb-orchestrator/contracts";
import { usageWindowQuerySchema } from "@ebb-orchestrator/contracts";
import type { Database } from "../../platform/database/database.js";
import { UsageReadModel } from "../read-models/usage-read-model.js";

export interface UsageRouteDeps { db?: Database | undefined; }

/** Регистрирует read-only HTTP-маршрут Usage с обязательным UTC-окном. */
export async function usageRoutes(app: FastifyInstance, deps: UsageRouteDeps = {}): Promise<void> {
  const projection = new UsageReadModel(deps.db);
  app.get<{ Querystring: { from?: unknown; to?: unknown; granularity?: unknown } }>(
    "/api/v1/usage",
    async (request, reply): Promise<UsageWindowProjection | { error: string }> => {
      const parsed = usageWindowQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid usage window" };
      }
      return projection.getWindow(parsed.data);
    },
  );
}
