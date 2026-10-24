/**
 * Listener чата на EventBus (plan-25 Task 3): зеркалирует переходы статусов
 * планирования в сообщения по карте и поддерживает событийную лексику чата
 * (message.created/message.delta/message.complete/conversation.updated).
 */

import type { Database } from "../../platform/database/database.js";
import { appendOutboxEvent } from "../../platform/events/outbox-repository.js";
import { DomainEvent } from "../../platform/events/domain-event.js";
import type { EventBus } from "../../platform/events/event-bus.js";
import type { ChatKind, ChatMessageStatus } from "@ebb-orchestrator/contracts";
import { ChatRepository } from "./chat-repository.js";

export const PLANNING_STATUS_EVENT = "planning.status";
export const CHAT_MESSAGE_CREATED_EVENT = "message.created";
export const CHAT_MESSAGE_DELTA_EVENT = "message.delta";
export const CHAT_MESSAGE_COMPLETE_EVENT = "message.complete";
export const CHAT_CONVERSATION_UPDATED_EVENT = "conversation.updated";

/** Карта переходов статусов планирования в виды сообщений чата. */
export const PLANNING_STATUS_MESSAGE_KIND: Readonly<Record<string, ChatKind>> = {
  RECEIVED: "text",
  PLANNING: "status_update",
  NEEDS_INPUT: "need_input",
  PLAN_PENDING_APPROVAL: "approval_request",
  MATERIALIZED: "status_update",
  REJECTED: "approval_result",
  FAILED: "error",
};

const TERMINAL_PLANNING_STATUSES: ReadonlySet<string> = new Set(["MATERIALIZED", "REJECTED", "FAILED"]);

interface PlanningStatusPayload {
  requestId: string;
  status: string;
  conversationId?: string;
  planId?: string;
  projectId?: string;
  failureCode?: string;
}

/**
 * Регистрирует listener чата на прикладном EventBus. Помимо зеркалирования
 * переходов планирования, события чата оформляются как consumers: EventDispatcher
 * доставляет их наблюдателям (SSE) и фиксирует processed_events для идемпотентности.
 */
export function registerChatEventListeners(bus: EventBus, deps: { db: Database; chat: ChatRepository }): void {
  bus.subscribe(PLANNING_STATUS_EVENT, "chat-planning-status-mirror", async (event) => {
    mirrorPlanningStatus(deps, event.payload as unknown as PlanningStatusPayload);
  });
  bus.subscribe(CHAT_MESSAGE_CREATED_EVENT, "chat-message-created-consumer", () => undefined);
  bus.subscribe(CHAT_MESSAGE_DELTA_EVENT, "chat-message-delta-consumer", () => undefined);
  bus.subscribe(CHAT_MESSAGE_COMPLETE_EVENT, "chat-message-complete-consumer", () => undefined);
  bus.subscribe(CHAT_CONVERSATION_UPDATED_EVENT, "chat-conversation-updated-consumer", () => undefined);
}

function mirrorPlanningStatus(deps: { db: Database; chat: ChatRepository }, payload: PlanningStatusPayload): void {
  const kind = PLANNING_STATUS_MESSAGE_KIND[payload.status];
  if (kind === undefined) return;

  const conversationId = payload.conversationId ?? resolveConversationForRequest(deps.db, payload.requestId);
  if (!conversationId) return;

  const planId = payload.status === "PLAN_PENDING_APPROVAL" ? (payload.planId ?? null) : null;
  const failureCode = payload.status === "FAILED" ? payload.failureCode : undefined;

  deps.db.transaction((tx) => {
    const message = deps.chat.appendMessage(
      {
        conversationId,
        role: "system",
        kind,
        content: mirrorContent(payload.status, payload.requestId, planId, failureCode),
        requestId: payload.requestId,
        planId,
        status: payload.status as ChatMessageStatus,
      },
      tx,
    );
    appendOutboxEvent(
      tx,
      DomainEvent.create({
        type: CHAT_MESSAGE_CREATED_EVENT,
        aggregateType: "ChatMessage",
        aggregateId: message.id,
        payload: { messageId: message.id, conversationId, kind, role: message.role },
      }),
    );
    appendOutboxEvent(
      tx,
      DomainEvent.create({
        type: CHAT_CONVERSATION_UPDATED_EVENT,
        aggregateType: "ChatConversation",
        aggregateId: conversationId,
        payload: { conversationId },
      }),
    );
    // Прогрессия статуса: грубый, детерминированный delta вместо токен-уровневого стриминга.
    if (payload.status === "PLANNING") {
      appendOutboxEvent(
        tx,
        DomainEvent.create({
          type: CHAT_MESSAGE_DELTA_EVENT,
          aggregateType: "PlanningRequest",
          aggregateId: payload.requestId,
          payload: { conversationId, requestId: payload.requestId, status: payload.status, progress: "coordinator_running" },
        }),
      );
    }
    if (TERMINAL_PLANNING_STATUSES.has(payload.status)) {
      appendOutboxEvent(
        tx,
        DomainEvent.create({
          type: CHAT_MESSAGE_COMPLETE_EVENT,
          aggregateType: "PlanningRequest",
          aggregateId: payload.requestId,
          payload: { conversationId, requestId: payload.requestId, status: payload.status },
        }),
      );
    }
  });
}

function resolveConversationForRequest(db: Database, requestId: string): string | undefined {
  return db.get<{ conversation_id: string }>(
    "SELECT conversation_id FROM chat_messages WHERE request_id=$requestId ORDER BY created_at DESC, id DESC LIMIT 1",
    { requestId },
  )?.conversation_id;
}

function mirrorContent(status: string, requestId: string, planId: string | null, failureCode: string | undefined): string {
  switch (status) {
    case "RECEIVED":
      return `Запрос получен и принят в планирование (${requestId}).`;
    case "PLANNING":
      return "Планирование запущено: координатор формирует план.";
    case "NEEDS_INPUT":
      return `Недостаточно данных для планирования (${requestId}). Продолжите беседу, чтобы дополнить запрос.`;
    case "PLAN_PENDING_APPROVAL":
      return planId ? `План готов к согласованию (${planId}).` : "План готов к согласованию.";
    case "MATERIALIZED":
      return "План материализован: задачи и рабочие пространства созданы.";
    case "REJECTED":
      return "План отклонён.";
    case "FAILED":
      return `Ошибка планирования (${failureCode ?? "UNKNOWN"}).`;
    default:
      return "";
  }
}
