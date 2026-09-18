import type { FastifyInstance } from "fastify";
import type { Database } from "../../platform/database/database.js";
import { ExecutionProjection } from "../read-models/execution-projection.js";
import type { SchedulerService } from "../../modules/scheduler/scheduler-service.js";
export interface RunCommandService { cancelRun(id: string): unknown | Promise<unknown>; }
export interface RunRouteDeps { db?: Database | undefined; runService?: RunCommandService | undefined; scheduler?: SchedulerService | undefined; }
/**
 * Экспортируемый компонент или контракт модуля, доступный другим слоям приложения.
 */
export async function runRoutes(app: FastifyInstance, deps: RunRouteDeps = {}): Promise<void> {
  const projection = new ExecutionProjection(deps.db, deps.scheduler);
  app.get("/api/v1/execution", async () => projection.get());
  app.post<{ Params: { id: string } }>("/api/v1/runs/:id/cancel", async (request, reply) => {
    if (!deps.runService) return reply.code(503).send({ error: "run service unavailable" });
    await deps.runService.cancelRun(request.params.id);
    return { status: "CANCELLED", runId: request.params.id };
  });
}
