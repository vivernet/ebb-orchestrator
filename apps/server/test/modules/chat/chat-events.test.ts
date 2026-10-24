import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import type { Database } from "../../../src/platform/database/database.js";
import { runMigrations } from "../../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../../helpers/migrations.js";
import { EventBus } from "../../../src/platform/events/event-bus.js";
import { EventDispatcher } from "../../../src/platform/events/event-dispatcher.js";
import { appendOutboxEvent } from "../../../src/platform/events/outbox-repository.js";
import { DomainEvent } from "../../../src/platform/events/domain-event.js";
import { ChatRepository } from "../../../src/modules/chat/chat-repository.js";
import { registerChatEventListeners } from "../../../src/modules/chat/chat-events.js";

const NOW = "2026-10-24T12:00:00.000Z";

interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  kind: string;
  content: string;
  request_id: string | null;
  plan_id: string | null;
  status: string | null;
  created_at: string;
}

describe("ChatEventListeners", () => {
  let db: Database | undefined;
  let tmpDir: string | undefined;
  let chat: ChatRepository;
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
    tmpDir = await mkdtemp(join(tmpdir(), "ebb-chat-events-"));
    db = createSqliteDatabase(join(tmpDir, `${randomUUID()}.sqlite`));
    runMigrations(db, loadTestMigrations());

    projectId = randomUUID();
    requestId = randomUUID();
    planId = randomUUID();
    db.run(
      "INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'P','P','ACTIVE',$now,$now)",
      { id: projectId, now: NOW },
    );
    db.run(
      "INSERT INTO planning_requests(id,project_id,request,requested_by,status,created_at,updated_at) VALUES($id,$projectId,'r','u','RECEIVED',$now,$now)",
      { id: requestId, projectId, now: NOW },
    );
    db.run(
      "INSERT INTO planning_plans(id,project_id,plan_json,status,approval_required,created_at) VALUES($id,$projectId,'{}','PENDING',1,$now)",
      { id: planId, projectId, now: NOW },
    );

    nowMs = Date.parse(NOW);
    advanceMs = (ms) => { nowMs += ms; };
    chat = new ChatRepository(db, () => new Date(nowMs));
    conversationId = chat.createConversation(projectId, "Чат").id;
  }

  function messages(): MessageRow[] {
    return db!.all<MessageRow>("SELECT * FROM chat_messages ORDER BY created_at, id");
  }

  function outboxEventTypes(): string[] {
    return db!.all<{ type: string }>("SELECT type FROM outbox_events ORDER BY created_at, id").map((row) => row.type);
  }

  function publishPlanningStatus(payload: Record<string, unknown>): void {
    db!.transaction((tx) => {
      appendOutboxEvent(
        tx,
        DomainEvent.create({ type: "planning.status", aggregateType: "PlanningRequest", aggregateId: requestId, payload }),
      );
    });
  }

  async function runEventBusCycle(): Promise<void> {
    const bus = new EventBus();
    registerChatEventListeners(bus, { db: db!, chat });
    const dispatcher = new EventDispatcher(db!, bus);
    await dispatcher.dispatchBatch(100);
  }

  describe("зеркалирование статусов планирования", () => {
    const cases: { status: string; kind: string; expectPlanId: boolean; failureCode?: string }[] = [
      { status: "RECEIVED", kind: "text", expectPlanId: false },
      { status: "PLANNING", kind: "status_update", expectPlanId: false },
      { status: "NEEDS_INPUT", kind: "need_input", expectPlanId: false },
      { status: "PLAN_PENDING_APPROVAL", kind: "approval_request", expectPlanId: true },
      { status: "MATERIALIZED", kind: "status_update", expectPlanId: false },
      { status: "REJECTED", kind: "approval_result", expectPlanId: false },
      { status: "FAILED", kind: "error", expectPlanId: false, failureCode: "COORDINATOR_RUN_FAILED" },
    ];

    for (const testCase of cases) {
      it(`отражает ${testCase.status} как ${testCase.kind}`, async () => {
        await setup();
        publishPlanningStatus({
          conversationId,
          requestId,
          projectId,
          status: testCase.status,
          ...(testCase.expectPlanId ? { planId } : {}),
          ...(testCase.failureCode ? { failureCode: testCase.failureCode } : {}),
        });
        await runEventBusCycle();

        const rows = messages();
        expect(rows).toHaveLength(1);
        const mirrored = rows[0]!;
        expect(mirrored.kind).toBe(testCase.kind);
        expect(mirrored.role).toBe("system");
        expect(mirrored.request_id).toBe(requestId);
        expect(mirrored.status).toBe(testCase.status);
        expect(mirrored.content.length).toBeGreaterThan(0);
        if (testCase.expectPlanId) {
          expect(mirrored.plan_id).toBe(planId);
        }
        if (testCase.failureCode) {
          expect(mirrored.content).toContain(testCase.failureCode);
        }
      });
    }

    it("отправляет message.delta для прогрессии статуса PLANNING", async () => {
      await setup();
      publishPlanningStatus({ conversationId, requestId, projectId, status: "PLANNING" });
      await runEventBusCycle();

      expect(outboxEventTypes()).toEqual(
        expect.arrayContaining(["message.created", "conversation.updated", "message.delta"]),
      );
    });

    it("отправляет message.complete для терминальных статусов", async () => {
      await setup();
      publishPlanningStatus({ conversationId, requestId, projectId, status: "MATERIALIZED" });
      await runEventBusCycle();

      expect(outboxEventTypes()).toEqual(
        expect.arrayContaining(["message.created", "conversation.updated", "message.complete"]),
      );
      expect(outboxEventTypes()).not.toContain("message.delta");
    });

    it("не создаёт дублей при повторном цикле доставки", async () => {
      await setup();
      publishPlanningStatus({ conversationId, requestId, projectId, status: "PLAN_PENDING_APPROVAL", planId });
      await runEventBusCycle();

      const bus = new EventBus();
      registerChatEventListeners(bus, { db: db!, chat });
      const dispatcher = new EventDispatcher(db!, bus);
      await dispatcher.dispatchBatch(100);

      expect(messages()).toHaveLength(1);
    });

    it("находит беседу по последнему сообщению с requestId при отсутствии conversationId", async () => {
      await setup();
      chat.appendMessage({
        conversationId,
        role: "user",
        kind: "text",
        content: "Запрос",
        requestId,
      });
      advanceMs(1000);
      publishPlanningStatus({ requestId, projectId, status: "PLANNING" });
      await runEventBusCycle();

      const rows = messages();
      expect(rows).toHaveLength(2);
      expect(rows[0]!.kind).toBe("text");
      expect(rows[1]!.kind).toBe("status_update");
      expect(rows[1]!.conversation_id).toBe(conversationId);
    });

    it("игнорирует неизвестный статус без создания сообщений", async () => {
      await setup();
      publishPlanningStatus({ conversationId, requestId, projectId, status: "UNKNOWN" });
      await runEventBusCycle();
      expect(messages()).toHaveLength(0);
    });
  });
});
