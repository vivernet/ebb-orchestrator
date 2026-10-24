/**
 * Репозиторий чата координатора: постоянная история бесед и сообщений
 * в таблицах `chat_conversations`/`chat_messages` (миграция 052).
 */

import { randomUUID } from "node:crypto";
import type { Database, DatabaseTx } from "../../platform/database/database.js";
import {
  chatKinds,
  chatMessageStatuses,
  chatRoles,
} from "@ebb-orchestrator/contracts";
import type {
  ChatConversation,
  ChatKind,
  ChatMessage,
  ChatMessageStatus,
  ChatRole,
  MessagesPage,
} from "@ebb-orchestrator/contracts";

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;
const MAX_CURSOR_LENGTH = 512;
const MAX_CURSOR_ID_LENGTH = 128;

/** Сообщение, подготовленное для записи в историю чата. */
export interface NewChatMessage {
  /** Беседа, к которой относится сообщение. */
  readonly conversationId: string;
  /** Роль автора сообщения. */
  readonly role: ChatRole;
  /** Вид сообщения. */
  readonly kind: ChatKind;
  /** Текст сообщения (непустой). */
  readonly content: string;
  /** Привязка к запросу планирования (nullable). */
  readonly requestId?: string | null;
  /** Привязка к плану планирования (nullable). */
  readonly planId?: string | null;
  /** Статус планирования на момент сообщения (nullable, зеркалит PlanningRequestStatus). */
  readonly status?: ChatMessageStatus | null;
}

/** Опции чтения страницы истории сообщений. */
export interface ListChatMessagesOptions {
  /** Opaque cursor (base64url от `${createdAt}|${id}`); отсутствует — самая новая страница. */
  readonly cursor?: string;
  /** Размер страницы: 1..200, по умолчанию 50. */
  readonly limit?: number;
  /**
   * Направление движения по истории относительно позиции курсора:
   * `older` — вниз к старым сообщениям (используйте `nextCursor`),
   * `newer` — вверх к новым (используйте `prevCursor`).
   */
  readonly direction?: "older" | "newer";
}

interface ConversationRow {
  id: string;
  project_id: string;
  title: string | null;
  status: ChatConversation["status"];
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: ChatRole;
  kind: ChatKind;
  content: string;
  request_id: string | null;
  plan_id: string | null;
  status: ChatMessageStatus | null;
  created_at: string;
}

/**
 * Хранит беседы и сообщения чата координатора в SQLite.
 *
 * Управляет идентификаторами с префиксами `conv_`/`msg_`, инвариантами
 * ролей/видов/статусов и cursor-пагинацией истории сообщений.
 */
export class ChatRepository {
  /**
   * Создаёт репозиторий чата над общей SQLite connection.
   *
   * @param db Общая SQLite connection (разделяется между модулями).
   * @param clock Источник времени; переопределяется в тестах для детерминизма.
   */
  constructor(
    private readonly db: Database,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** Создаёт активную беседу в проекте; `title` необязателен. */
  createConversation(projectId: string, title?: string | null): ChatConversation {
    if (typeof projectId !== "string" || projectId.trim() === "") throw new Error("CHAT_PROJECT_ID_INVALID");
    const id = `conv_${randomUUID()}`;
    const now = this.clock().toISOString();
    this.db.run(
      `INSERT INTO chat_conversations(id,project_id,title,status,created_at,updated_at)
       VALUES($id,$projectId,$title,'ACTIVE',$now,$now)`,
      { id, projectId, title: title ?? null, now },
    );
    return this.projectConversation(this.db.get<ConversationRow>("SELECT * FROM chat_conversations WHERE id=$id", { id })!);
  }

  /** Возвращает беседы проекта от последней активности к более ранним. */
  listConversations(projectId: string): ChatConversation[] {
    return this.db.all<ConversationRow>(
      "SELECT * FROM chat_conversations WHERE project_id=$projectId ORDER BY updated_at DESC, id DESC",
      { projectId },
    ).map((row) => this.projectConversation(row));
  }

  /** Возвращает беседу по идентификатору либо `undefined`. */
  findConversation(conversationId: string): ChatConversation | undefined {
    const row = this.db.get<ConversationRow>("SELECT * FROM chat_conversations WHERE id=$id", { id: conversationId });
    return row ? this.projectConversation(row) : undefined;
  }

  /**
   * Добавляет сообщение в историю и обновляет метку активности беседы
   * атомарно. Переданная `tx` позволяет включать запись в внешнюю
   * транзакцию (например, вместе с outbox-событием планирования).
   */
  appendMessage(input: NewChatMessage, tx?: DatabaseTx): ChatMessage {
    validateNewMessage(input);
    const perform = (source: DatabaseTx): ChatMessage => {
      const id = `msg_${randomUUID()}`;
      const now = this.clock().toISOString();
      source.run(
        `INSERT INTO chat_messages(id,conversation_id,role,kind,content,request_id,plan_id,status,created_at)
         VALUES($id,$conversationId,$role,$kind,$content,$requestId,$planId,$status,$now)`,
        {
          id,
          conversationId: input.conversationId,
          role: input.role,
          kind: input.kind,
          content: input.content,
          requestId: input.requestId ?? null,
          planId: input.planId ?? null,
          status: input.status ?? null,
          now,
        },
      );
      source.run("UPDATE chat_conversations SET updated_at=$now WHERE id=$id", { id: input.conversationId, now });
      return this.projectMessage(source.get<MessageRow>("SELECT * FROM chat_messages WHERE id=$id", { id })!);
    };
    return tx ? perform(tx) : this.db.transaction((inner) => perform(inner));
  }

  /**
   * Читает страницу истории сообщений беседы (новые сверху) с cursor-пагинацией.
   *
   * Страница возвращает окно сообщений по убыванию `created_at` (затем `id`).
   * Окна не пересекаются: `nextCursor` ведёт к соседнему более старому окну,
   * а `prevCursor` — к самому новому окну среди сообщений новее границы.
   * Если таких сообщений нет, `prevCursor` равен null. Обход вниз по
   * `nextCursor` покрывает всю историю без пропусков и повторов.
   * Cursor — base64url от `${createdAt}|${id}`.
   */
  listMessages(conversationId: string, options: ListChatMessagesOptions = {}): MessagesPage {
    const limit = options.limit ?? DEFAULT_PAGE_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) throw new Error("CHAT_LIMIT_INVALID");
    const direction = options.direction ?? "older";
    if (direction !== "older" && direction !== "newer") throw new Error("CHAT_DIRECTION_INVALID");
    const position = options.cursor === undefined ? null : decodeCursor(options.cursor);

    const boundCondition = direction === "newer"
      ? "(created_at > $boundCreatedAt OR (created_at = $boundCreatedAt AND id > $boundId))"
      : "(created_at < $boundCreatedAt OR (created_at = $boundCreatedAt AND id < $boundId))";

    const rows: MessageRow[] = position === null
      ? this.db.all<MessageRow>(
          `SELECT * FROM chat_messages WHERE conversation_id=$conversationId
           ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}`,
          { conversationId },
        )
      : this.db.all<MessageRow>(
          `SELECT * FROM chat_messages WHERE conversation_id=$conversationId AND ${boundCondition}
           ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}`,
          { conversationId, boundCreatedAt: position.createdAt, boundId: position.id },
        );

    const items = rows.slice(0, limit).map((row) => this.projectMessage(row));
    if (items.length === 0) return { items, nextCursor: null, prevCursor: null };

    const newest = items[0]!;
    const oldest = items.at(-1)!;
    const nextCursor = this.existsOlderThan(conversationId, oldest.createdAt, oldest.id)
      ? encodeCursor(oldest.createdAt, oldest.id)
      : null;
    const prevCursor = position !== null && this.existsNewerThan(conversationId, newest.createdAt, newest.id)
      ? encodeCursor(newest.createdAt, newest.id)
      : null;

    return { items, nextCursor, prevCursor };
  }

  private projectConversation(row: ConversationRow): ChatConversation {
    return {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private projectMessage(row: MessageRow): ChatMessage {
    return {
      id: row.id,
      conversationId: row.conversation_id,
      role: row.role,
      kind: row.kind,
      content: row.content,
      requestId: row.request_id,
      planId: row.plan_id,
      status: row.status,
      createdAt: row.created_at,
    };
  }

  private existsNewerThan(conversationId: string, createdAt: string, id: string): boolean {
    return this.db.get(
      `SELECT 1 FROM chat_messages WHERE conversation_id=$conversationId
       AND (created_at > $boundCreatedAt OR (created_at = $boundCreatedAt AND id > $boundId)) LIMIT 1`,
      { conversationId, boundCreatedAt: createdAt, boundId: id },
    ) !== undefined;
  }

  private existsOlderThan(conversationId: string, createdAt: string, id: string): boolean {
    return this.db.get(
      `SELECT 1 FROM chat_messages WHERE conversation_id=$conversationId
       AND (created_at < $boundCreatedAt OR (created_at = $boundCreatedAt AND id < $boundId)) LIMIT 1`,
      { conversationId, boundCreatedAt: createdAt, boundId: id },
    ) !== undefined;
  }
}

function validateNewMessage(input: NewChatMessage): void {
  if (typeof input.conversationId !== "string" || input.conversationId.trim() === "") {
    throw new Error("CHAT_CONVERSATION_ID_INVALID");
  }
  if (!chatRoles.includes(input.role)) throw new Error("CHAT_ROLE_INVALID");
  if (!chatKinds.includes(input.kind)) throw new Error("CHAT_KIND_INVALID");
  if (typeof input.content !== "string" || input.content.trim() === "") throw new Error("CHAT_MESSAGE_CONTENT_INVALID");
  if (input.status !== undefined && input.status !== null && !chatMessageStatuses.includes(input.status)) {
    throw new Error("CHAT_STATUS_INVALID");
  }
}

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  if (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new Error("CHAT_CURSOR_INVALID");
  }
  const bytes = Buffer.from(cursor, "base64url");
  if (bytes.toString("base64url") !== cursor) throw new Error("CHAT_CURSOR_INVALID");
  const text = bytes.toString("utf8");
  const separator = text.indexOf("|");
  if (separator <= 0 || separator === text.length - 1) throw new Error("CHAT_CURSOR_INVALID");
  const createdAt = text.slice(0, separator);
  const id = text.slice(separator + 1);
  if (!Number.isFinite(Date.parse(createdAt)) || id.length === 0 || id.length > MAX_CURSOR_ID_LENGTH) {
    throw new Error("CHAT_CURSOR_INVALID");
  }
  return { createdAt, id };
}
