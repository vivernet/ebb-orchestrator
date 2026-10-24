/**
 * HTTP-контракт чата координатора (plan-25 Task 4).
 *
 * Все роуты находятся под /api/v1 и защищены глобальным auth/CSRF hook'ом
 * create-app.ts. Валидация ручная: isPlainObject/isNonEmptyString.
 * Ошибки имеют versioned контракт {contractVersion, error: {code, message}}.
 *
 * Делегирование одобрений:
 *  - approve  → EpicOrchestrator.approveAndRun (владелец approval pipeline);
 *  - reject   → PlanningService.rejectPlan — та же planning-власть, которую
 *    использует EpicOrchestrator (публичного reject-метода на фасаде нет).
 *
 * @see spec §13.2 — SSE по образцу routes/events.ts.
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import type { Database } from "../../platform/database/database.js";
import type { EventBus } from "../../platform/events/event-bus.js";
import type { DomainEvent } from "../../platform/events/domain-event.js";
import type { EpicOrchestrator } from "../../modules/planning/epic-orchestrator.js";
import { ChatRepository } from "../../modules/chat/chat-repository.js";
import { ChatService, type SendMessageInput } from "../../modules/chat/chat-service.js";
import { PlanningService } from "../../modules/planning/planning-service.js";

/** Версия публичного HTTP-контракта чата (локальная; contracts-пакет её не экспортирует). */
export const CHAT_CONTRACT_VERSION = 1 as const;

export interface ChatRouteDeps {
  db?: Database | undefined;
  /** Facade Epic orchestration: approve делегирует approveAndRun. */
  epicOrchestrator?: Pick<EpicOrchestrator, "approveAndRun"> | undefined;
  /** Источник событий для SSE-потока беседы. */
  eventBus?: EventBus | undefined;
}

interface ConversationRow {
  id: string;
  project_id: string;
  status: string;
}

interface PlanRow {
  id: string;
  project_id: string;
  status: string;
}

const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Регистрирует HTTP-контракт чата координатора (беседы, сообщения, SSE,
 * одобрение/отклонение планов).
 */
export async function chatRoutes(app: FastifyInstance, deps: ChatRouteDeps = {}): Promise<void> {
  const db = deps.db;
  const chat = db ? new ChatRepository(db) : undefined;
  const chatService = db && chat ? new ChatService(db, chat) : undefined;

  const activeStreams = new Set<FastifyReply["raw"]>();

  // Перехваченные SSE-ответы вне обычного жизненного цикла Fastify; уничтожаем
  // их явно, чтобы app.close() не ожидал бесконечно (как в routes/events.ts).
  app.addHook("preClose", async () => {
    for (const response of activeStreams) response.destroy();
    activeStreams.clear();
  });

  // ── Беседы проекта ────────────────────────────────────────────────
  app.get<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/conversations",
    async (request, reply) => {
      if (!db || !chat) return error(reply, 503, "CHAT_SERVICE_UNAVAILABLE", "Чат временно недоступен.");
      if (!getProject(db, request.params.projectId)) return error(reply, 404, "CHAT_PROJECT_NOT_FOUND", "Проект не найден.");
      const conversations = request.params.projectId.length > 0 ? chat.listConversations(request.params.projectId) : [];
      return { conversations };
    },
  );

  app.post<{ Params: { projectId: string }; Body: unknown }>(
    "/api/v1/projects/:projectId/conversations",
    async (request, reply) => {
      if (!db || !chat) return error(reply, 503, "CHAT_SERVICE_UNAVAILABLE", "Чат временно недоступен.");
      if (!getProject(db, request.params.projectId)) return error(reply, 404, "CHAT_PROJECT_NOT_FOUND", "Проект не найден.");
      const body = request.body;
      if (body !== undefined && (!isPlainObject(body) || Object.keys(body).some((key) => key !== "title") || (body.title !== undefined && !isNonEmptyString(body.title)))) {
        return error(reply, 400, "CHAT_INVALID_REQUEST", "Некорректный запрос.");
      }
      const conversation = chat.createConversation(request.params.projectId, body === undefined ? null : (body as { title?: unknown }).title === undefined ? null : String((body as { title?: unknown }).title));
      return reply.code(201).send({ conversation });
    },
  );

  // ── Беседа по ID ──────────────────────────────────────────────────
  app.get<{ Params: { conversationId: string } }>(
    "/api/v1/conversations/:conversationId",
    async (request, reply) => {
      if (!db || !chat) return error(reply, 503, "CHAT_SERVICE_UNAVAILABLE", "Чат временно недоступен.");
      const conversation = chat.findConversation(request.params.conversationId);
      if (!conversation) return error(reply, 404, "CHAT_CONVERSATION_NOT_FOUND", "Беседа не найдена.");
      return { conversation };
    },
  );

  // ── Сообщения ─────────────────────────────────────────────────────
  app.get<{ Params: { conversationId: string }; Querystring: { cursor?: unknown; limit?: unknown; direction?: unknown } }>(
    "/api/v1/conversations/:conversationId/messages",
    async (request, reply) => {
      if (!db || !chat) return error(reply, 503, "CHAT_SERVICE_UNAVAILABLE", "Чат временно недоступен.");
      if (!chat.findConversation(request.params.conversationId)) return error(reply, 404, "CHAT_CONVERSATION_NOT_FOUND", "Беседа не найдена.");
      const { cursor, limit, direction } = request.query;
      if (cursor !== undefined && (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 512)) {
        return error(reply, 400, "CHAT_CURSOR_INVALID", "Некорректный курсор.");
      }
      if (limit !== undefined && (typeof limit !== "string" || !/^[0-9]+$/.test(limit))) {
        return error(reply, 400, "CHAT_LIMIT_INVALID", "Некорректный лимит.");
      }
      if (direction !== undefined && direction !== "older" && direction !== "newer") {
        return error(reply, 400, "CHAT_DIRECTION_INVALID", "Некорректное направление.");
      }
      try {
        const page = chat.listMessages(request.params.conversationId, {
          ...(cursor !== undefined ? { cursor } : {}),
          ...(limit !== undefined ? { limit: Number(limit) } : {}),
          ...(direction !== undefined ? { direction } : {}),
        });
        return page;
      } catch (err) {
        return error(reply, 400, messageCodeOf(err, "CHAT_CURSOR_INVALID"), "Некорректные параметры пагинации.");
      }
    },
  );

  app.post<{ Params: { conversationId: string }; Body: unknown }>(
    "/api/v1/conversations/:conversationId/messages",
    async (request, reply) => {
      if (!db || !chat || !chatService) return error(reply, 503, "CHAT_SERVICE_UNAVAILABLE", "Чат временно недоступен.");
      const body = request.body;
      if (!isPlainObject(body) || Object.keys(body).some((key) => key !== "content" && key !== "asPlanningRequest" && key !== "requestId")) {
        return error(reply, 400, "CHAT_INVALID_REQUEST", "Некорректный запрос.");
      }
      if (!isNonEmptyString(body.content) || body.content.length > 20_000) {
        return error(reply, 400, "CHAT_MESSAGE_CONTENT_INVALID", "Сообщение не может быть пустым.");
      }
      if (body.asPlanningRequest !== undefined && typeof body.asPlanningRequest !== "boolean") {
        return error(reply, 400, "CHAT_INVALID_REQUEST", "Некорректный запрос.");
      }
      if (body.requestId !== undefined && !isNonEmptyString(body.requestId)) {
        return error(reply, 400, "CHAT_INVALID_REQUEST", "Некорректный запрос.");
      }
      const input: SendMessageInput = {
        content: body.content,
        ...(body.asPlanningRequest !== undefined ? { asPlanningRequest: body.asPlanningRequest } : {}),
        ...(body.requestId !== undefined ? { requestId: body.requestId } : {}),
      };
      try {
        const result = chatService.sendMessage(request.params.conversationId, input);
        return reply.code(202).send(result);
      } catch (err) {
        return classifyMessageError(reply, err);
      }
    },
  );

  // ── SSE-поток событий беседы (аналог routes/events.ts) ────────────
  app.get<{ Params: { conversationId: string } }>(
    "/api/v1/conversations/:conversationId/events",
    async (request, reply) => {
      if (!db || !chat) return error(reply, 503, "CHAT_SERVICE_UNAVAILABLE", "Чат временно недоступен.");
      const conversationId = request.params.conversationId;
      if (!chat.findConversation(conversationId)) return error(reply, 404, "CHAT_CONVERSATION_NOT_FOUND", "Беседа не найдена.");

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      // Стартовый комментарий подтверждает открытое соединение.
      reply.raw.write(":ok\n\n");
      activeStreams.add(reply.raw);

      const writeEvent = (event: DomainEvent) => {
        if (reply.raw.destroyed) return;
        if (!matchesConversation(event, conversationId)) return;
        reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      };
      const unsubscribe = deps.eventBus?.observe(writeEvent);

      const heartbeat = setInterval(() => {
        reply.raw.write(":heartbeat\n\n");
      }, HEARTBEAT_INTERVAL_MS);

      request.raw.on("close", () => {
        activeStreams.delete(reply.raw);
        clearInterval(heartbeat);
        unsubscribe?.();
      });

      // Не позволяем Fastify закрыть ответ: им управляет этот обработчик.
      reply.hijack();
    },
  );

  // ── Одобрение / отклонение плана из беседы ────────────────────────
  app.post<{ Params: { conversationId: string; planId: string }; Body: unknown }>(
    "/api/v1/conversations/:conversationId/plans/:planId/approve",
    async (request, reply) => {
      if (!db || !deps.epicOrchestrator) return error(reply, 503, "CHAT_ORCHESTRATION_UNAVAILABLE", "Оркестрация планов временно недоступна.");
      const conversation = getConversation(db, request.params.conversationId);
      if (!conversation) return error(reply, 404, "CHAT_CONVERSATION_NOT_FOUND", "Беседа не найдена.");
      const plan = getPlan(db, request.params.planId);
      if (!plan || plan.project_id !== conversation.project_id) return error(reply, 404, "CHAT_PLAN_NOT_FOUND", "План не найден для этой беседы.");

      const body = request.body === undefined ? {} : request.body;
      if (!isPlainObject(body) || Object.keys(body).some((key) => key !== "requestId") || (body.requestId !== undefined && !isNonEmptyString(body.requestId))) {
        return error(reply, 400, "CHAT_INVALID_REQUEST", "Некорректный запрос.");
      }
      const requestId = (body as { requestId?: unknown }).requestId === undefined ? undefined : String((body as { requestId?: unknown }).requestId);
      if (requestId !== undefined) {
        const linked = db.get<{ id: string; status: string }>(
          "SELECT id,status FROM planning_requests WHERE id=$id AND plan_id=$planId AND project_id=$projectId",
          { id: requestId, planId: plan.id, projectId: conversation.project_id },
        );
        if (!linked) return error(reply, 404, "CHAT_PLANNING_REQUEST_NOT_FOUND", "Запрос планирования не найден.");
        if (linked.status !== "PLAN_PENDING_APPROVAL") return error(reply, 409, "CHAT_PLANNING_REQUEST_NOT_AWAITING_INPUT", "Запрос не ожидает одобрения.");
      }

      try {
        const result = await deps.epicOrchestrator.approveAndRun(plan.id, "local-user", requestId);
        return { result };
      } catch (err) {
        return classifyOrchestrationError(reply, err);
      }
    },
  );

  app.post<{ Params: { conversationId: string; planId: string }; Body: unknown }>(
    "/api/v1/conversations/:conversationId/plans/:planId/reject",
    async (request, reply) => {
      if (!db) return error(reply, 503, "CHAT_SERVICE_UNAVAILABLE", "Чат временно недоступен.");
      const conversation = getConversation(db, request.params.conversationId);
      if (!conversation) return error(reply, 404, "CHAT_CONVERSATION_NOT_FOUND", "Беседа не найдена.");
      const plan = getPlan(db, request.params.planId);
      if (!plan || plan.project_id !== conversation.project_id) return error(reply, 404, "CHAT_PLAN_NOT_FOUND", "План не найден для этой беседы.");

      const body = request.body === undefined ? {} : request.body;
      if (!isPlainObject(body) || Object.keys(body).length !== 0) {
        return error(reply, 400, "CHAT_INVALID_REQUEST", "Некорректный запрос.");
      }

      try {
        const rejected = new PlanningService(db).rejectPlan(plan.id, "local-user");
        return { plan: { id: rejected.id, status: rejected.status } };
      } catch (err) {
        const code = messageCodeOf(err);
        if (code.includes("not found")) return error(reply, 404, "CHAT_PLAN_NOT_FOUND", "План не найден для этой беседы.");
        return error(reply, 409, "CHAT_PLAN_ALREADY_RESOLVED", "План уже разрешён.");
      }
    },
  );
}

function getProject(db: Database, id: string): { id: string } | undefined {
  return db.get<{ id: string }>("SELECT id FROM projects WHERE id=$id", { id });
}

function getConversation(db: Database, id: string): ConversationRow | undefined {
  return db.get<ConversationRow>("SELECT id,project_id,status FROM chat_conversations WHERE id=$id", { id });
}

function getPlan(db: Database, id: string): PlanRow | undefined {
  return db.get<PlanRow>("SELECT id,project_id,status FROM planning_plans WHERE id=$id", { id });
}

function matchesConversation(event: DomainEvent, conversationId: string): boolean {
  const payload = event.payload as { conversationId?: unknown };
  return payload.conversationId === conversationId || event.aggregateId === conversationId;
}

function classifyMessageError(reply: FastifyReply, err: unknown): unknown {
  const code = messageCodeOf(err);
  if (code === "CHAT_CONVERSATION_NOT_FOUND") return error(reply, 404, code, "Беседа не найдена.");
  if (code === "CHAT_PROJECT_NOT_FOUND") return error(reply, 404, code, "Проект не найден.");
  if (code === "CHAT_PLANNING_REQUEST_NOT_FOUND") return error(reply, 404, code, "Запрос планирования не найден.");
  if (code === "CHAT_MESSAGE_CONTENT_INVALID") return error(reply, 400, code, "Сообщение не может быть пустым.");
  if (code === "CHAT_PROJECT_NOT_ACTIVE") return error(reply, 409, code, "Проект не активен.");
  if (code === "CHAT_ACTIVE_ONBOARDING_REQUIRED") return error(reply, 409, code, "Требуется активный онбординг.");
  if (code === "CHAT_PLANNING_REQUEST_NOT_AWAITING_INPUT") return error(reply, 409, code, "Запрос не ожидает продолжения.");
  return error(reply, 503, "CHAT_SERVICE_UNAVAILABLE", "Чат временно недоступен.");
}

function classifyOrchestrationError(reply: FastifyReply, err: unknown): unknown {
  const message = messageCodeOf(err);
  if (/not found/i.test(message)) return error(reply, 404, "CHAT_PLAN_NOT_FOUND", "План не найден для этой беседы.");
  if (/unavailable|runtime|launcher|service/i.test(message)) return error(reply, 503, "CHAT_ORCHESTRATION_UNAVAILABLE", "Оркестрация планов временно недоступна.");
  return error(reply, 409, "CHAT_PLAN_CONFLICT", "План не может быть одобрен в текущем состоянии.");
}

function messageCodeOf(err: unknown, fallback = "CHAT_SERVICE_UNAVAILABLE"): string {
  return err instanceof Error && typeof err.message === "string" && err.message.length > 0 ? err.message : fallback;
}

function error(reply: { code(status: number): { send(body: unknown): unknown } }, status: number, code: string, message: string): unknown {
  return reply.code(status).send({ contractVersion: CHAT_CONTRACT_VERSION, error: { code, message } });
}

function isPlainObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isNonEmptyString(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
