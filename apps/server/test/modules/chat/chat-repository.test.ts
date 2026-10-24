import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import type { Database } from "../../../src/platform/database/database.js";
import { runMigrations } from "../../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../../helpers/migrations.js";
import { ChatRepository } from "../../../src/modules/chat/chat-repository.js";
import type { NewChatMessage } from "../../../src/modules/chat/chat-repository.js";

const NOW = "2026-10-24T12:00:00.000Z";

describe("ChatRepository", () => {
  let db: Database | undefined;
  let tmpDir: string | undefined;
  let repo: ChatRepository;
  let projectId: string;
  let conversationId: string;
  let requestId: string;
  let planId: string;
  let nowMs: number;
  let advanceMs: (ms: number) => void;

  afterEach(async () => {
    db?.close();
    db = undefined;
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  async function setup(): Promise<void> {
    tmpDir = await mkdtemp(join(tmpdir(), "ebb-chat-repository-"));
    db = createSqliteDatabase(join(tmpDir, `${randomUUID()}.sqlite`));
    runMigrations(db, loadTestMigrations());

    projectId = randomUUID();
    requestId = randomUUID();
    planId = randomUUID();
    db.run("INSERT INTO projects(id,name,display_name,created_at,updated_at) VALUES($id,'P','P',$now,$now)", { id: projectId, now: NOW });
    db.run("INSERT INTO planning_requests(id,project_id,request,requested_by,created_at) VALUES($id,$projectId,'r','u',$now)", { id: requestId, projectId, now: NOW });
    db.run("INSERT INTO planning_plans(id,project_id,plan_json,status,approval_required,created_at) VALUES($id,$projectId,'{}','APPROVED',0,$now)", { id: planId, projectId, now: NOW });

    nowMs = Date.parse(NOW);
    advanceMs = (ms) => { nowMs += ms; };
    repo = new ChatRepository(db, () => new Date(nowMs));
    conversationId = repo.createConversation(projectId, "Чат").id;
  }

  function messageInput(overrides: Partial<NewChatMessage> = {}): NewChatMessage {
    return {
      conversationId,
      role: "user",
      kind: "text",
      content: "привет",
      ...overrides,
    };
  }

  /** Добавляет сообщение с уникальным нарастающим created_at. */
  function appendMany(count: number): void {
    for (let index = 0; index < count; index += 1) {
      advanceMs(1000);
      repo.appendMessage(messageInput({ content: `msg-${index}` }));
    }
  }

  describe("conversations", () => {
    it("создаёт активную беседу с префиксом conv_ и отклоняет неизвестный проект", async () => {
      await setup();
      expect(conversationId).toMatch(/^conv_[0-9a-f-]{36}$/);
      expect(repo.findConversation(conversationId)).toEqual({
        id: conversationId,
        projectId,
        title: "Чат",
        status: "ACTIVE",
        createdAt: NOW,
        updatedAt: NOW,
      });
      const untitled = repo.createConversation(projectId);
      expect(untitled.title).toBeNull();
      expect(() => repo.createConversation(randomUUID())).toThrow(/FOREIGN KEY/);
      expect(() => repo.createConversation("  ")).toThrow("CHAT_PROJECT_ID_INVALID");
    });

    it("перечисляет беседы только выбранного проекта от последней активности", async () => {
      await setup();
      advanceMs(1000);
      const second = repo.createConversation(projectId, "Второй");
      advanceMs(5000);
      const third = repo.createConversation(projectId, "Третий");
      expect(repo.listConversations(projectId).map(({ id }) => id)).toEqual([third.id, second.id, conversationId]);
      expect(repo.listConversations(randomUUID())).toEqual([]);
    });

    it("находит беседу по id и возвращает undefined для отсутствующей", async () => {
      await setup();
      expect(repo.findConversation(conversationId)?.id).toBe(conversationId);
      expect(repo.findConversation(randomUUID())).toBeUndefined();
    });
  });

  describe("appendMessage", () => {
    it("пишет сообщение с префиксом msg_ и обновляет updated_at беседы", async () => {
      await setup();
      advanceMs(1000);
      const created = repo.appendMessage(messageInput({ kind: "status_update", status: null }));
      expect(created.id).toMatch(/^msg_[0-9a-f-]{36}$/);
      expect(created).toEqual({
        id: created.id,
        conversationId,
        role: "user",
        kind: "status_update",
        content: "привет",
        requestId: null,
        planId: null,
        status: null,
        createdAt: new Date(nowMs).toISOString(),
      });
      const conversation = repo.findConversation(conversationId)!;
      expect(conversation.updatedAt).toBe(created.createdAt);
      expect(conversation.createdAt).toBe(NOW);
    });

    it("сохраняет привязки к запросу/плану и статус планирования", async () => {
      await setup();
      advanceMs(1000);
      const linked = repo.appendMessage(messageInput({
        role: "coordinator",
        kind: "approval_request",
        requestId,
        planId,
        status: "PLAN_PENDING_APPROVAL",
      }));
      expect(linked.requestId).toBe(requestId);
      expect(linked.planId).toBe(planId);
      expect(linked.status).toBe("PLAN_PENDING_APPROVAL");
    });

    it("валидирует контракт сообщения", async () => {
      await setup();
      expect(() => repo.appendMessage(messageInput({ content: "   " }))).toThrow("CHAT_MESSAGE_CONTENT_INVALID");
      expect(() => repo.appendMessage(messageInput({ role: "admin" as never }))).toThrow("CHAT_ROLE_INVALID");
      expect(() => repo.appendMessage(messageInput({ kind: "bogus" as never }))).toThrow("CHAT_KIND_INVALID");
      expect(() => repo.appendMessage(messageInput({ status: "BOGUS" as never }))).toThrow("CHAT_STATUS_INVALID");
      expect(() => repo.appendMessage(messageInput({ conversationId: "" }))).toThrow("CHAT_CONVERSATION_ID_INVALID");
      expect(() => repo.appendMessage(messageInput({ conversationId: randomUUID() }))).toThrow(/FOREIGN KEY/);
      expect(() => repo.appendMessage(messageInput({ requestId: randomUUID() }))).toThrow(/FOREIGN KEY/);
      expect(() => repo.appendMessage(messageInput({ planId: randomUUID() }))).toThrow(/FOREIGN KEY/);
    });

    it("откатывает запись вместе с внешней транзакцией", async () => {
      await setup();
      advanceMs(1000);
      expect(() => db!.transaction((tx) => {
        repo.appendMessage(messageInput(), tx);
        throw new Error("boom");
      })).toThrow("boom");
      expect(db!.get("SELECT COUNT(*) AS count FROM chat_messages")).toEqual({ count: 0 });
      expect(repo.findConversation(conversationId)!.updatedAt).toBe(NOW);
    });

    it("фиксирует несколько сообщений в одной внешней транзакции", async () => {
      await setup();
      advanceMs(1000);
      db!.transaction((tx) => {
        repo.appendMessage(messageInput({ content: "a" }), tx);
        advanceMs(1000);
        repo.appendMessage(messageInput({ content: "b" }), tx);
      });
      expect(db!.get("SELECT COUNT(*) AS count FROM chat_messages")).toEqual({ count: 2 });
      expect(repo.findConversation(conversationId)!.updatedAt).toBe(new Date(nowMs).toISOString());
    });
  });

  describe("listMessages", () => {
    it("возвращает пустую страницу для беседы без сообщений", async () => {
      await setup();
      expect(repo.listMessages(conversationId)).toEqual({ items: [], nextCursor: null, prevCursor: null });
    });

    it("пагинирует историю вниз/вверх без пропусков и дубликатов", async () => {
      await setup();
      appendMany(120);

      const first = repo.listMessages(conversationId);
      expect(first.items).toHaveLength(50);
      expect(first.prevCursor).toBeNull();
      expect(first.nextCursor).not.toBeNull();
      const firstIds = first.items.map(({ id }) => id);
      for (let index = 1; index < firstIds.length; index += 1) {
        expect(first.items[index]!.createdAt < first.items[index - 1]!.createdAt).toBe(true);
      }

      const collected: string[] = [...firstIds];
      let page = first;
      while (page.nextCursor) {
        page = repo.listMessages(conversationId, { cursor: page.nextCursor });
        expect(page.items.length).toBeGreaterThan(0);
        collected.push(...page.items.map(({ id }) => id));
      }
      expect(collected).toHaveLength(120);
      expect(new Set(collected).size).toBe(120);

      // Подъём вверх от второй страницы восстанавливает первую.
      const second = repo.listMessages(conversationId, { cursor: first.nextCursor! });
      const upward = repo.listMessages(conversationId, { cursor: second.prevCursor!, direction: "newer" });
      expect(upward.items.map(({ id }) => id)).toEqual(firstIds);
      expect(upward.prevCursor).toBeNull();

      // Подъём от самой нижней страницы возвращает самое новое окно истории
      // (оно же — первая страница), а его nextCursor продолжает обход вниз.
      const top = repo.listMessages(conversationId, { cursor: page.prevCursor!, direction: "newer" });
      expect(top.items.map(({ id }) => id)).toEqual(collected.slice(0, 50));
      expect(top.prevCursor).toBeNull();
      expect(top.nextCursor).not.toBeNull();
    });

    it("направление newer от произвольной позиции отдаёт только более новые сообщения", async () => {
      await setup();
      appendMany(120);
      const all = repo.listMessages(conversationId, { limit: 200 });
      const middle = all.items[60]!;
      const newer = repo.listMessages(conversationId, { cursor: encodeCursor(middle.createdAt, middle.id), direction: "newer" });
      expect(newer.items).toHaveLength(50);
      expect(newer.items.every(({ createdAt }) => createdAt > middle.createdAt)).toBe(true);
      // Верхнее окно подмножества: выше него более новых сообщений нет.
      expect(newer.prevCursor).toBeNull();
      expect(newer.nextCursor).not.toBeNull();
      // Продолжение вниз от окна идёт по истории без пропусков и повторов.
      const nextDown = repo.listMessages(conversationId, { cursor: newer.nextCursor! });
      expect(nextDown.items).toHaveLength(50);
      expect(Date.parse(nextDown.items[0]!.createdAt)).toBeLessThan(Date.parse(newer.items.at(-1)!.createdAt));
      expect(nextDown.prevCursor).not.toBeNull();
      expect(nextDown.nextCursor).not.toBeNull();
    });

    it("ограничивает размер страницы и отклоняет недопустимые limit", async () => {
      await setup();
      appendMany(5);
      expect(repo.listMessages(conversationId, { limit: 1 }).items).toHaveLength(1);
      expect(repo.listMessages(conversationId, { limit: 200 }).items).toHaveLength(5);
      expect(() => repo.listMessages(conversationId, { limit: 0 })).toThrow("CHAT_LIMIT_INVALID");
      expect(() => repo.listMessages(conversationId, { limit: 201 })).toThrow("CHAT_LIMIT_INVALID");
      expect(() => repo.listMessages(conversationId, { limit: 1.5 })).toThrow("CHAT_LIMIT_INVALID");
      expect(() => repo.listMessages(conversationId, { direction: "sideways" as never })).toThrow("CHAT_DIRECTION_INVALID");
    });

    it("отклоняет неканонические и битые cursor", async () => {
      await setup();
      appendMany(3);
      expect(() => repo.listMessages(conversationId, { cursor: "!!!" })).toThrow("CHAT_CURSOR_INVALID");
      expect(() => repo.listMessages(conversationId, { cursor: "" })).toThrow("CHAT_CURSOR_INVALID");
      expect(() => repo.listMessages(conversationId, { cursor: Buffer.from("not-a-timestamp|id", "utf8").toString("base64url") })).toThrow("CHAT_CURSOR_INVALID");
      expect(() => repo.listMessages(conversationId, { cursor: Buffer.from(`${NOW}|`, "utf8").toString("base64url") })).toThrow("CHAT_CURSOR_INVALID");
      expect(() => repo.listMessages(conversationId, { cursor: `${Buffer.from(`${NOW}|id`, "utf8").toString("base64url")}=` })).toThrow("CHAT_CURSOR_INVALID");
      expect(() => repo.listMessages(conversationId, { cursor: "a".repeat(513) })).toThrow("CHAT_CURSOR_INVALID");
    });
  });
});

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`, "utf8").toString("base64url");
}
