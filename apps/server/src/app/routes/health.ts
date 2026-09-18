/**
 * Health check route – no authentication required.
 */
import type { FastifyInstance } from "fastify";

/**
 * Регистрирует HTTP-маршруты health и передаёт изменяющие состояние действия backend policy.
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/health", async () => {
    return { status: "ok" };
  });
}
