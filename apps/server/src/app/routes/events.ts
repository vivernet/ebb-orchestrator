/**
 * Server-Sent Events stream for live backend → browser updates.
 *
 * The SSE endpoint is authenticated (requires a valid bearer token) but
 * the stream only carries ephemeral UI events. Reconnecting clients
 * should re-fetch projections for authoritative state.
 *
 * @see spec §13.2 – SSE for live updates
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/**
 * Регистрирует HTTP-маршруты events и передаёт изменяющие состояние действия backend policy.
 */
export async function eventRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/api/v1/events",
    async (request: FastifyRequest, reply: FastifyReply) => {
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      // Send an initial comment to confirm the connection is open.
      reply.raw.write(":ok\n\n");

      // Keep the connection alive with periodic heartbeats.
      const heartbeat = setInterval(() => {
        reply.raw.write(":heartbeat\n\n");
      }, 15_000);

      request.raw.on("close", () => {
        clearInterval(heartbeat);
      });

      // Prevent Fastify from closing the response – we own it.
      reply.hijack();
    },
  );
}
