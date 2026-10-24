/**
 * Контракт чата координатора (plan-25 Task 1).
 *
 * Схемы и типы бесед/сообщений, а также константы допустимых
 * ролей, видов сообщений и статусов планирования.
 */

import { z } from "zod";
import { utcTimestampSchema } from "./api.js";

/** Роль отправителя сообщения чата. */
export const chatRoles = ["user", "coordinator", "system"] as const;
export type ChatRole = (typeof chatRoles)[number];

/** Вид сообщения чата (разметка/семантика рендера). */
export const chatKinds = [
  "text",
  "status_update",
  "need_input",
  "approval_request",
  "approval_result",
  "error",
] as const;
export type ChatKind = (typeof chatKinds)[number];

/** Статус планирования, зеркалируемый в сообщениях чата. */
export const chatMessageStatuses = [
  "RECEIVED",
  "PLANNING",
  "NEEDS_INPUT",
  "PLAN_PENDING_APPROVAL",
  "MATERIALIZED",
  "REJECTED",
  "FAILED",
] as const;
export type ChatMessageStatus = (typeof chatMessageStatuses)[number];

/** Статус беседы. */
export const chatConversationStatuses = ["ACTIVE"] as const;
export type ChatConversationStatus = (typeof chatConversationStatuses)[number];

export const ChatRoleSchema = z.enum(chatRoles);
export const ChatKindSchema = z.enum(chatKinds);
export const ChatMessageStatusSchema = z.enum(chatMessageStatuses);
export const ChatConversationStatusSchema = z.enum(chatConversationStatuses);

export const ChatConversationSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string().nullable(),
  status: ChatConversationStatusSchema,
  createdAt: utcTimestampSchema,
  updatedAt: utcTimestampSchema,
}).strict();
export type ChatConversation = z.infer<typeof ChatConversationSchema>;

export const ChatMessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  role: ChatRoleSchema,
  kind: ChatKindSchema,
  content: z.string(),
  requestId: z.string().nullable(),
  planId: z.string().nullable(),
  status: ChatMessageStatusSchema.nullable(),
  createdAt: utcTimestampSchema,
}).strict();
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const MessagesPageSchema = z.object({
  items: z.array(ChatMessageSchema),
  nextCursor: z.string().nullable(),
  prevCursor: z.string().nullable(),
}).strict();
export type MessagesPage = z.infer<typeof MessagesPageSchema>;

export const SendMessageRequestSchema = z.object({
  content: z.string().min(1).max(20_000),
  asPlanningRequest: z.boolean().optional(),
  requestId: z.string().optional(),
}).strict();
export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;

export const ChatPlanningStateSchema = z.object({
  requestId: z.string(),
  status: ChatMessageStatusSchema,
}).strict();
export type ChatPlanningState = z.infer<typeof ChatPlanningStateSchema>;

export const SendMessageResponseSchema = z.object({
  message: ChatMessageSchema,
  planning: ChatPlanningStateSchema.optional(),
}).strict();
export type SendMessageResponse = z.infer<typeof SendMessageResponseSchema>;
