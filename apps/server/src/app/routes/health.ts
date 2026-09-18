/**
 * Health check route – no authentication required.
 */
import type { FastifyInstance } from "fastify";

/**
 * Экспортируемый компонент или контракт модуля, доступный другим слоям приложения.
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/health", async () => {
    return { status: "ok" };
  });
}
