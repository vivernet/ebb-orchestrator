/**
 * Сервис чата координатора (plan-25 Task 3): отправка сообщений и интеграция
 * с планированием через существующий PlanningService (образец POST /requests).
 */

import type { Database, DatabaseTx } from "../../platform/database/database.js";
import { appendOutboxEvent } from "../../platform/events/outbox-repository.js";
import { DomainEvent } from "../../platform/events/domain-event.js";
import { enqueueJob } from "../../platform/jobs/job-repository.js";
import { PlanningService } from "../planning/planning-service.js";
import { ChatRepository } from "./chat-repository.js";
import type { ChatMessage, SendMessageResponse } from "@ebb-orchestrator/contracts";

/** Входные данные отправки сообщения (расширение контракта requestId-продолжением). */
export interface SendMessageInput {
  readonly content: string;
  readonly asPlanningRequest?: boolean;
  /** Продолжение запроса NEEDS_INPUT связывается с существующим requestId. */
  readonly requestId?: string;
}

interface PlanningRequestRow {
  id: string;
  status: string;
}

/**
 * Предоставляет публичный контракт модуля chats для взаимодействия слоёв приложения.
 */
export class ChatService {
  private readonly planning: PlanningService;

  constructor(
    private readonly db: Database,
    private readonly chat: ChatRepository,
  ) {
    this.planning = new PlanningService(this.db);
  }

  /**
   * Отправляет сообщение в беседу. При `asPlanningRequest` создаёт planning_request
   * (валидация проекта ACTIVE + активный onboarding, как POST /requests) и ставит
   * durable job `coordinator.planning` с ключом дедупликации `planning:${id}`.
   * Продолжение NEEDS_INPUT связывается с существующим `requestId` без создания
   * нового запроса.
   */
  sendMessage(conversationId: string, input: SendMessageInput): SendMessageResponse {
    const conversation = this.chat.findConversation(conversationId);
    if (!conversation) throw new Error("CHAT_CONVERSATION_NOT_FOUND");
    if (typeof input.content !== "string" || input.content.trim().length === 0) {
      throw new Error("CHAT_MESSAGE_CONTENT_INVALID");
    }

    if (input.asPlanningRequest) {
      this.assertActiveProjectWithOnboarding(conversation.projectId);
      if (input.requestId !== undefined) {
        return this.sendPlanningContinuation(conversationId, input.content, input.requestId);
      }
      return this.sendNewPlanningRequest(conversationId, conversation.projectId, input.content);
    }

    const message = this.appendUserMessage(conversationId, input.content, null);
    return { message };
  }

  /** Создаёт новый planning_request, ставит job и отражает переход в событии planning.status. */
  private sendNewPlanningRequest(conversationId: string, projectId: string, content: string): SendMessageResponse {
    const created = this.planning.createQueuedRequest(projectId, content.trim(), "local-user");
    const message = this.appendUserMessage(conversationId, content, created.id, [
      DomainEvent.create({
        type: "planning.status",
        aggregateType: "PlanningRequest",
        aggregateId: created.id,
        payload: {
          conversationId,
          projectId,
          requestId: created.id,
          status: "RECEIVED",
        },
      }),
    ]);
    return { message, planning: { requestId: created.id, status: "RECEIVED" } };
  }

  /** Связывает продолжение с существующим запросом NEEDS_INPUT того же проекта и
   * перезапускает планирование атомарно: статус → RECEIVED + durable job
   * `coordinator.planning` с ключом дедупликации `planning:${requestId}`. */
  private sendPlanningContinuation(conversationId: string, content: string, requestId: string): SendMessageResponse {
    return this.db.transaction((tx) => {
      const conversation = this.chat.findConversation(conversationId);
      const request = tx.get<PlanningRequestRow>(
        "SELECT id,status FROM planning_requests WHERE id=$id AND project_id=$projectId",
        { id: requestId, projectId: conversation!.projectId },
      );
      if (!request) throw new Error("CHAT_PLANNING_REQUEST_NOT_FOUND");
      if (request.status !== "NEEDS_INPUT") throw new Error("CHAT_PLANNING_REQUEST_NOT_AWAITING_INPUT");
      tx.run(
        "UPDATE planning_requests SET status='RECEIVED', classification=NULL, coordinator_run_id=NULL, updated_at=$now WHERE id=$id AND status='NEEDS_INPUT'",
        { id: requestId, now: new Date().toISOString() },
      );
      enqueueJob(tx, {
        type: "coordinator.planning",
        payload: { requestId, projectId: conversation!.projectId },
        dedupeKey: `planning:${requestId}`,
      });
      const message = this.appendUserMessageTx(tx, conversationId, content, requestId, [
        DomainEvent.create({
          type: "planning.status",
          aggregateType: "PlanningRequest",
          aggregateId: requestId,
          payload: {
            conversationId,
            projectId: conversation!.projectId,
            requestId,
            status: "RECEIVED",
          },
        }),
      ]);
      return { message, planning: { requestId, status: "RECEIVED" } };
    });
  }

  private appendUserMessage(
    conversationId: string,
    content: string,
    requestId: string | null,
    extraEvents: DomainEvent[] = [],
  ): ChatMessage {
    return this.db.transaction((tx) =>
      this.appendUserMessageTx(tx, conversationId, content, requestId, extraEvents),
    );
  }

  private appendUserMessageTx(
    tx: DatabaseTx,
    conversationId: string,
    content: string,
    requestId: string | null,
    extraEvents: DomainEvent[] = [],
  ): ChatMessage {
    const message = this.chat.appendMessage(
      { conversationId, role: "user", kind: "text", content, requestId },
      tx,
    );
    appendOutboxEvent(
      tx,
      DomainEvent.create({
        type: "message.created",
        aggregateType: "ChatMessage",
        aggregateId: message.id,
        payload: { messageId: message.id, conversationId, kind: message.kind, role: message.role },
      }),
    );
    appendOutboxEvent(
      tx,
      DomainEvent.create({
        type: "conversation.updated",
        aggregateType: "ChatConversation",
        aggregateId: conversationId,
        payload: { conversationId },
      }),
    );
    for (const event of extraEvents) appendOutboxEvent(tx, event);
    return message;
  }

  /** Та же валидация, что и в POST /requests: проект ACTIVE + активный onboarding. */
  private assertActiveProjectWithOnboarding(projectId: string): void {
    const project = this.db.get<{ status: string }>("SELECT status FROM projects WHERE id=$id", { id: projectId });
    if (!project) throw new Error("CHAT_PROJECT_NOT_FOUND");
    if (project.status !== "ACTIVE") throw new Error("CHAT_PROJECT_NOT_ACTIVE");
    const onboarding = this.db.get<{ id: string }>(
      `SELECT oc.project_id AS id
         FROM onboarding_configs oc
         JOIN approvals a ON a.id=oc.approval_id
        WHERE oc.project_id=$projectId AND oc.status='ACTIVE'
          AND a.subject_type='PROJECT' AND a.subject_id=oc.project_id
          AND a.type='WORKFLOW_CHANGE' AND a.status='APPROVED'`,
      { projectId },
    );
    if (!onboarding) throw new Error("CHAT_ACTIVE_ONBOARDING_REQUIRED");
  }
}
