/**
 * Health check route – no authentication required.
 */
import type { FastifyInstance } from "fastify";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/health", async () => {
    return { status: "ok" };
  });
}
