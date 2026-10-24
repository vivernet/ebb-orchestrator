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
import { ChatService } from "../../../src/modules/chat/chat-service.js";

const NOW = "2026-10-24T12:00:00.000Z";

describe("ChatService", () => {
  let db: Database | undefined;
  let tmpDir: string | undefined;
  let chat: ChatRepository;
  let service: ChatService;
  let projectId: string;
  let conversationId: string;
  let nowMs: number;

  afterEach(async () => {
    db?.close();
    db = undefined;
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  async function setup(): Promise<void> {
    tmpDir = await mkdtemp(join(tmpdir(), "ebb-chat-service-"));
    db = createSqliteDatabase(join(tmpDir, `${randomUUID()}.sqlite`));
    runMigrations(db, loadTestMigrations());

    projectId = randomUUID();
    db.run(
      "INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'P','P','ACTIVE',$now,$now)",
      { id: projectId, now: NOW },
    );
    const approvalId = randomUUID();
    db.run(
      "INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,resolved_by,resolution_note,created_at,resolved_at) VALUES($id,'WORKFLOW_CHANGE',$projectId,'PROJECT','APPROVED','u','u',NULL,$now,$now)",
      { id: approvalId, projectId, now: NOW },
    );
    db.run(
      "INSERT INTO onboarding_configs(project_id,repository_path,facts_json,proposed_json,status,approval_id,created_at,updated_at,activated_at) VALUES($projectId,'C:/repo','{}','{}','ACTIVE',$approvalId,$now,$now,$now)",
      { projectId, approvalId, now: NOW },
    );

    nowMs = Date.parse(NOW);
    chat = new ChatRepository(db, () => new Date(nowMs));
    service = new ChatService(db, chat);
    conversationId = chat.createConversation(projectId, "Чат").id;
  }

  function planningRequests(): { id: string; status: string; project_id: string }[] {
    return db!.all<{ id: string; status: string; project_id: string }>("SELECT id,status,project_id FROM planning_requests");
  }

  function backgroundJobs(): { type: string; dedupe_key: string | null; status: string }[] {
    return db!.all<{ type: string; dedupe_key: string | null; status: string }>(
      "SELECT type,dedupe_key,status FROM background_jobs",
    );
  }

  function outboxEventTypes(): string[] {
    return db!.all<{ type: string }>("SELECT type FROM outbox_events ORDER BY created_at, id").map((row) => row.type);
  }

  describe("sendMessage", () => {
    it("сохраняет обычное текстовое сообщение без планирования", async () => {
      await setup();
      const response = service.sendMessage(conversationId, { content: "привет" });

      expect(response.planning).toBeUndefined();
      expect(response.message.role).toBe("user");
      expect(response.message.kind).toBe("text");
      expect(response.message.content).toBe("привет");
      expect(response.message.requestId).toBeNull();
      expect(response.message.planId).toBeNull();
      expect(response.message.status).toBeNull();
      expect(planningRequests()).toHaveLength(0);
      expect(backgroundJobs()).toHaveLength(0);
      expect(outboxEventTypes()).toEqual(
        expect.arrayContaining(["message.created", "conversation.updated"]),
      );
    });

    it("отклоняет пустое сообщение", async () => {
      await setup();
      expect(() => service.sendMessage(conversationId, { content: "   " })).toThrow(
        "CHAT_MESSAGE_CONTENT_INVALID",
      );
    });

    it("отклоняет неизвестную беседу", async () => {
      await setup();
      expect(() => service.sendMessage(`conv_${randomUUID()}`, { content: "hi" })).toThrow(
        "CHAT_CONVERSATION_NOT_FOUND",
      );
    });
  });

  describe("sendMessage asPlanningRequest", () => {
    it("создаёт planning_request, ставит coordinator.planning job и возвращает 202-ответ", async () => {
      await setup();
      const response = service.sendMessage(conversationId, {
        content: "Запланируй эпик",
        asPlanningRequest: true,
      });

      expect(response.planning).toBeDefined();
      expect(response.planning!.status).toBe("RECEIVED");
      const requestId = response.planning!.requestId;
      expect(requestId).toMatch(/^[0-9a-f-]{36}$/);

      const requests = planningRequests();
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ id: requestId, status: "RECEIVED", project_id: projectId });

      const jobs = backgroundJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        type: "coordinator.planning",
        dedupe_key: `planning:${requestId}`,
        status: "QUEUED",
      });

      expect(response.message.requestId).toBe(requestId);
      expect(response.message.role).toBe("user");
      expect(response.message.kind).toBe("text");
      expect(outboxEventTypes()).toEqual(
        expect.arrayContaining([
          "message.created",
          "conversation.updated",
          "planning.status",
        ]),
      );
    });

    it("отклоняет запрос для неактивного проекта", async () => {
      await setup();
      db!.run("UPDATE projects SET status='ARCHIVED' WHERE id=$id", { id: projectId });
      expect(() =>
        service.sendMessage(conversationId, { content: "План", asPlanningRequest: true }),
      ).toThrow("CHAT_PROJECT_NOT_ACTIVE");
    });

    it("отклоняет запрос без активного onboarding", async () => {
      await setup();
      db!.run("UPDATE onboarding_configs SET status='PROPOSED' WHERE project_id=$id", { id: projectId });
      expect(() =>
        service.sendMessage(conversationId, { content: "План", asPlanningRequest: true }),
      ).toThrow("CHAT_ACTIVE_ONBOARDING_REQUIRED");
    });
  });

  describe("sendMessage asPlanningRequest с requestId (NEEDS_INPUT-продолжение)", () => {
    async function setupWithNeedsInputRequest(): Promise<string> {
      await setup();
      const requestId = randomUUID();
      db!.run(
        "INSERT INTO planning_requests(id,project_id,request,requested_by,status,created_at,updated_at) VALUES($id,$projectId,'r','u','NEEDS_INPUT',$now,$now)",
        { id: requestId, projectId, now: NOW },
      );
      return requestId;
    }

    it("переводит запрос из NEEDS_INPUT в RECEIVED и ставит coordinator.planning job", async () => {
      const requestId = await setupWithNeedsInputRequest();
      const response = service.sendMessage(conversationId, {
        content: "Дополнение: нужен эпик с двумя задачами",
        asPlanningRequest: true,
        requestId,
      });

      expect(response.planning).toEqual({ requestId, status: "RECEIVED" });
      expect(response.message.requestId).toBe(requestId);
      expect(response.message.kind).toBe("text");

      const requests = planningRequests();
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ id: requestId, status: "RECEIVED", project_id: projectId });
      expect(
        db!.get<{ coordinator_run_id: string | null; classification: string | null }>(
          "SELECT coordinator_run_id,classification FROM planning_requests WHERE id=$id",
          { id: requestId },
        ),
      ).toEqual({ coordinator_run_id: null, classification: null });

      const jobs = backgroundJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        type: "coordinator.planning",
        dedupe_key: `planning:${requestId}`,
        status: "QUEUED",
      });

      expect(outboxEventTypes()).toEqual(
        expect.arrayContaining([
          "message.created",
          "conversation.updated",
          "planning.status",
        ]),
      );
    });

    it("отклоняет продолжение для запроса не в статусе NEEDS_INPUT", async () => {
      const requestId = await setupWithNeedsInputRequest();
      db!.run("UPDATE planning_requests SET status='PLANNING' WHERE id=$id", { id: requestId });
      expect(() =>
        service.sendMessage(conversationId, {
          content: "Дополнение",
          asPlanningRequest: true,
          requestId,
        }),
      ).toThrow("CHAT_PLANNING_REQUEST_NOT_AWAITING_INPUT");
    });

    it("отклоняет продолжение для неизвестного requestId", async () => {
      await setup();
      expect(() =>
        service.sendMessage(conversationId, {
          content: "Дополнение",
          asPlanningRequest: true,
          requestId: randomUUID(),
        }),
      ).toThrow("CHAT_PLANNING_REQUEST_NOT_FOUND");
    });

    it("отклоняет продолжение для запроса другого проекта", async () => {
      await setup();
      const otherProjectId = randomUUID();
      db!.run(
        "INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'O','O','ACTIVE',$now,$now)",
        { id: otherProjectId, now: NOW },
      );
      const otherRequestId = randomUUID();
      db!.run(
        "INSERT INTO planning_requests(id,project_id,request,requested_by,status,created_at,updated_at) VALUES($id,$projectId,'r','u','NEEDS_INPUT',$now,$now)",
        { id: otherRequestId, projectId: otherProjectId, now: NOW },
      );
      expect(() =>
        service.sendMessage(conversationId, {
          content: "Дополнение",
          asPlanningRequest: true,
          requestId: otherRequestId,
        }),
      ).toThrow("CHAT_PLANNING_REQUEST_NOT_FOUND");
    });
  });
});
