import type { FastifyInstance } from "fastify";
import type { UsagePageProjection } from "@ebb-orchestrator/contracts";
import type { Database } from "../../platform/database/database.js";
import { UsageReadModel } from "../read-models/usage-read-model.js";

export interface UsageRouteDeps { db?: Database | undefined; }

/** Регистрирует read-only HTTP-маршрут Usage. */
export async function usageRoutes(app: FastifyInstance, deps: UsageRouteDeps = {}): Promise<void> {
  const projection = new UsageReadModel(deps.db);
  app.get("/api/v1/usage", async (): Promise<UsagePageProjection> => projection.get());
}
