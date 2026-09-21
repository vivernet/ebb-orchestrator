/**
 * Поток Server-Sent Events для live-обновлений backend → browser.
 *
 * Конечная точка SSE аутентифицирована (требует корректный bearer token),
 * но поток содержит только эфемерные события UI. После переподключения клиенты
 * должны заново запросить projections для получения авторитетного состояния.
 *
 * @see spec §13.2 — SSE для live-обновлений
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { EventBus } from "../../platform/events/event-bus.js";
import type { DomainEvent } from "../../platform/events/domain-event.js";

/**
 * Регистрирует HTTP-маршруты events и передаёт изменяющие состояние действия backend policy.
 */
export async function eventRoutes(app: FastifyInstance, eventBus?: EventBus): Promise<void> {
  const activeStreams = new Set<FastifyReply["raw"]>();

  // Перехваченные SSE-ответы находятся вне обычного жизненного цикла Fastify.
  // Явно уничтожает их, чтобы app.close() не ожидал бесконечно при остановке.
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

      // Отправляет начальный комментарий, подтверждающий открытое соединение.
      reply.raw.write(":ok\n\n");
      activeStreams.add(reply.raw);

      const writeEvent = (event: DomainEvent) => {
        if (!reply.raw.destroyed) reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      };
      const unsubscribe = eventBus?.observe(writeEvent);

      // Поддерживает соединение периодическими heartbeat.
      const heartbeat = setInterval(() => {
        reply.raw.write(":heartbeat\n\n");
      }, 15_000);

      request.raw.on("close", () => {
        activeStreams.delete(reply.raw);
        clearInterval(heartbeat);
        unsubscribe?.();
      });

      // Не позволяет Fastify закрыть ответ: управляет им этот обработчик.
      reply.hijack();
    },
  );
}
