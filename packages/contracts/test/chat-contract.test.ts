import { describe, expect, it } from "vitest";
import {
  ChatConversationSchema,
  ChatKindSchema,
  ChatMessageSchema,
  ChatMessageStatusSchema,
  ChatRoleSchema,
  MessagesPageSchema,
  SendMessageRequestSchema,
  SendMessageResponseSchema,
  chatKinds,
  chatMessageStatuses,
  chatRoles,
} from "../src/chat.js";
import { apiPaths } from "../src/api.js";

const UTC = "2026-10-24T10:00:00.000Z";

const validConversation = {
  id: "conv_1",
  projectId: "proj_1",
  title: null,
  status: "ACTIVE",
  createdAt: UTC,
  updatedAt: UTC,
};

const validMessage = {
  id: "msg_1",
  conversationId: "conv_1",
  role: "user",
  kind: "text",
  content: "Привет",
  requestId: null,
  planId: null,
  status: null,
  createdAt: UTC,
};

describe("контракт чата: схемы", () => {
  it("валидирует корректную беседу", () => {
    expect(ChatConversationSchema.parse(validConversation)).toEqual(validConversation);
  });

  it("отклоняет не-UCT timestamp", () => {
    expect(() =>
      ChatConversationSchema.parse({ ...validConversation, createdAt: "2026-10-24" }),
    ).toThrow();
  });

  it("отклоняет неизвестный статус беседы", () => {
    expect(() =>
      ChatConversationSchema.parse({ ...validConversation, status: "PAUSED" }),
    ).toThrow();
  });

  it("строго отклоняет лишние поля беседы", () => {
    expect(() =>
      ChatConversationSchema.parse({ ...validConversation, extra: 1 }),
    ).toThrow();
  });

  it("валидирует корректное сообщение", () => {
    expect(ChatMessageSchema.parse(validMessage)).toEqual(validMessage);
  });

  it("отклоняет неизвестную роль", () => {
    expect(() => ChatMessageSchema.parse({ ...validMessage, role: "admin" })).toThrow();
  });

  it("отклоняет неизвестный вид сообщения", () => {
    expect(() => ChatMessageSchema.parse({ ...validMessage, kind: "voice" })).toThrow();
  });

  it("отклоняет неизвестный статус планирования", () => {
    expect(() =>
      ChatMessageSchema.parse({ ...validMessage, status: "IN_PROGRESS" }),
    ).toThrow();
  });

  it("строго отклоняет лишние поля сообщения", () => {
    expect(() => ChatMessageSchema.parse({ ...validMessage, extra: true })).toThrow();
  });

  it("валидирует сообщение со связкой request/plan/status", () => {
    const msg = {
      ...validMessage,
      kind: "approval_request",
      requestId: "req_1",
      planId: "plan_1",
      status: "PLAN_PENDING_APPROVAL",
    };
    expect(ChatMessageSchema.parse(msg)).toEqual(msg);
  });

  it("валидирует запрос отправки сообщения", () => {
    expect(SendMessageRequestSchema.parse({ content: "создай план" })).toEqual({
      content: "создай план",
    });
    expect(
      SendMessageRequestSchema.parse({ content: "x", asPlanningRequest: true }),
    ).toEqual({ content: "x", asPlanningRequest: true });
    expect(
      SendMessageRequestSchema.parse({ content: "x", requestId: "req_1" }),
    ).toEqual({ content: "x", requestId: "req_1" });
  });

  it("отклоняет пустой контент запроса", () => {
    expect(() => SendMessageRequestSchema.parse({ content: "" })).toThrow();
  });

  it("отклоняет не-boolean asPlanningRequest", () => {
    expect(() =>
      SendMessageRequestSchema.parse({ content: "x", asPlanningRequest: "да" }),
    ).toThrow();
  });

  it("строго отклоняет лишние поля запроса", () => {
    expect(() =>
      SendMessageRequestSchema.parse({ content: "x", extra: 1 }),
    ).toThrow();
  });

  it("валидирует ответ с планированием", () => {
    const response = {
      message: validMessage,
      planning: { requestId: "req_1", status: "RECEIVED" },
    };
    expect(SendMessageResponseSchema.parse(response)).toEqual(response);
  });

  it("валидирует ответ без планирования", () => {
    expect(SendMessageResponseSchema.parse({ message: validMessage })).toEqual({
      message: validMessage,
    });
  });

  it("отклоняет неизвестный статус планирования в ответе", () => {
    expect(() =>
      SendMessageResponseSchema.parse({
        message: validMessage,
        planning: { requestId: "req_1", status: "BOGUS" },
      }),
    ).toThrow();
  });

  it("валидирует страницу сообщений", () => {
    const page = {
      items: [validMessage],
      nextCursor: "bmV4dA",
      prevCursor: null,
    };
    expect(MessagesPageSchema.parse(page)).toEqual(page);
  });

  it("отклоняет невалидные items страницы", () => {
    expect(() =>
      MessagesPageSchema.parse({
        items: [{ ...validMessage, role: "admin" }],
        nextCursor: null,
        prevCursor: null,
      }),
    ).toThrow();
  });

  it("строго отклоняет лишние поля страницы", () => {
    expect(() =>
      MessagesPageSchema.parse({
        items: [],
        nextCursor: null,
        prevCursor: null,
        extra: true,
      }),
    ).toThrow();
  });
});

describe("контракт чата: енумы", () => {
  it("покрывает все роли дизайн-контракта", () => {
    expect(chatRoles).toEqual(["user", "coordinator", "system"]);
    for (const role of chatRoles) {
      expect(ChatRoleSchema.parse(role)).toBe(role);
    }
  });

  it("покрывает все виды сообщений", () => {
    expect(chatKinds).toEqual([
      "text",
      "status_update",
      "need_input",
      "approval_request",
      "approval_result",
      "error",
    ]);
    for (const kind of chatKinds) {
      expect(ChatKindSchema.parse(kind)).toBe(kind);
    }
  });

  it("покрывает все статусы планирования", () => {
    expect(chatMessageStatuses).toEqual([
      "RECEIVED",
      "PLANNING",
      "NEEDS_INPUT",
      "PLAN_PENDING_APPROVAL",
      "MATERIALIZED",
      "REJECTED",
      "FAILED",
    ]);
    for (const status of chatMessageStatuses) {
      expect(ChatMessageStatusSchema.parse(status)).toBe(status);
    }
  });
});

describe("контракт чата: apiPaths", () => {
  it("строит пути бесед", () => {
    expect(apiPaths.conversations("proj_1")).toBe(
      "/api/v1/projects/proj_1/conversations",
    );
  });

  it("строит пути сообщений и событий", () => {
    expect(apiPaths.conversationMessages("conv_1")).toBe(
      "/api/v1/conversations/conv_1/messages",
    );
    expect(apiPaths.conversationEvents("conv_1")).toBe(
      "/api/v1/conversations/conv_1/events",
    );
  });

  it("строит пути одобрений плана", () => {
    expect(apiPaths.planApprove("conv_1", "plan_1")).toBe(
      "/api/v1/conversations/conv_1/plans/plan_1/approve",
    );
    expect(apiPaths.planReject("conv_1", "plan_1")).toBe(
      "/api/v1/conversations/conv_1/plans/plan_1/reject",
    );
  });

  it("кодирует сегменты путей", () => {
    expect(apiPaths.conversations("proj a")).toBe(
      "/api/v1/projects/proj%20a/conversations",
    );
    expect(apiPaths.planApprove("conv/1", "plan 1")).toBe(
      "/api/v1/conversations/conv%2F1/plans/plan%201/approve",
    );
  });
});
