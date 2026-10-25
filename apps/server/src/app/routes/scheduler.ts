import type { FastifyInstance } from "fastify";
import type { SchedulerService } from "../../modules/scheduler/scheduler-service.js";
import { dispatchStateRequestSchema } from "@ebb-orchestrator/contracts";

/**
 * Регистрирует HTTP-маршруты scheduler и передаёт изменяющие состояние действия backend policy.
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

  app.get("/api/v1/scheduler/dispatch-state", async (_request, reply) => {
    if (!scheduler) return reply.code(503).send({ error: "scheduler unavailable" });
    return scheduler.getDispatchState();
  });
  app.put<{ Body: unknown }>("/api/v1/scheduler/dispatch-state", async (request, reply) => {
    if (!scheduler) return reply.code(503).send({ error: "scheduler unavailable" });
    const parsed = dispatchStateRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_DISPATCH_STATE" } });
    try { return scheduler.setDispatchState(parsed.data); } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid dispatch state" }); }
  });
}
