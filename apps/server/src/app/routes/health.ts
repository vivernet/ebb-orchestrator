/**
 * Health check route — аутентификация не требуется.
 */
import type { FastifyInstance } from "fastify";
import type { StatusTrackerInterface } from "../../platform/process/system-lifecycle.js";

/**
 * Регистрирует HTTP-маршруты health и передаёт изменяющие состояние действия backend policy.
 */
export async function healthRoutes(app: FastifyInstance, status?: StatusTrackerInterface): Promise<void> {
  app.get("/api/v1/health", async (_request, reply) => {
    const current = status?.get() ?? "READY";
    reply.code(current === "READY" ? 200 : 503);
    return { status: current === "READY" ? "ok" : "unavailable", lifecycle: current };
  });
}
