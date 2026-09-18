import type { FastifyInstance } from "fastify";
import type { SchedulerService } from "../../modules/scheduler/scheduler-service.js";

/**
 * Экспортируемый компонент или контракт модуля, доступный другим слоям приложения.
 */
export async function schedulerRoutes(app: FastifyInstance, scheduler: SchedulerService | undefined): Promise<void> {
  app.get("/api/v1/scheduler/config", async (_request, reply) => {
    if (!scheduler) return reply.code(503).send({ error: "scheduler unavailable" });
    return scheduler.getConfig();
  });
  app.put<{ Body: unknown }>("/api/v1/scheduler/config", async (request, reply) => {
    if (!scheduler) return reply.code(503).send({ error: "scheduler unavailable" });
    try { return scheduler.updateConfig(request.body); } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid scheduler configuration" }); }
  });
}
