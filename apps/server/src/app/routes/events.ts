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
import type { EventBus } from "../../platform/events/event-bus.js";
import type { DomainEvent } from "../../platform/events/domain-event.js";

/**
 * Регистрирует HTTP-маршруты events и передаёт изменяющие состояние действия backend policy.
 */
export async function eventRoutes(app: FastifyInstance, eventBus?: EventBus): Promise<void> {
  const activeStreams = new Set<FastifyReply["raw"]>();

  // Hijacked SSE replies are outside Fastify's normal response lifecycle.
  // Destroy them explicitly so app.close() cannot wait forever during shutdown.
  app.addHook("preClose", async () => {
    for (const response of activeStreams) response.destroy();
    activeStreams.clear();
  });

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
      activeStreams.add(reply.raw);

      const writeEvent = (event: DomainEvent) => {
        if (!reply.raw.destroyed) reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      };
      const unsubscribe = eventBus?.observe(writeEvent);

      // Keep the connection alive with periodic heartbeats.
      const heartbeat = setInterval(() => {
        reply.raw.write(":heartbeat\n\n");
      }, 15_000);

      request.raw.on("close", () => {
        activeStreams.delete(reply.raw);
        clearInterval(heartbeat);
        unsubscribe?.();
      });

      // Prevent Fastify from closing the response – we own it.
      reply.hijack();
    },
  );
}
