import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../../src/app/create-app.js";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations, type Migration } from "../../../src/platform/database/migrator.js";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChatRepository } from "../../../src/modules/chat/chat-repository.js";
import { DomainEvent } from "../../../src/platform/events/domain-event.js";
import { EventBus } from "../../../src/platform/events/event-bus.js";
import { createTestAuthService, TEST_COOKIE } from "../../helpers/auth.js";
import { testAuthHeaders } from "../../helpers/auth.js";
import type { EpicStartInput } from "../../../src/modules/planning/epic-orchestrator.js";
import type { PlanningPlan } from "../../../src/modules/planning/planning-types.js";

const migrationDir = fileURLToPath(new URL("../../../src/platform/database/migrations/", import.meta.url));
const migrations: Migration[] = readdirSync(migrationDir).filter((file) => file.endsWith(".sql")).map((file) => ({
  version: Number(/^([0-9]+)/.exec(file)?.[1]),
  name: file.replace(/^[0-9]+_/, "").replace(/\.sql$/, ""),
  sql: readFileSync(join(migrationDir, file), "utf8"),
}));

function seedActiveProjectWithOnboarding(db: ReturnType<typeof createSqliteDatabase>, now: string): void {
  db.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES ('project-1','p','P','ACTIVE',$now,$now)", { now });
  db.run(
    "INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,resolved_by,resolution_note,created_at,resolved_at) VALUES ('onboarding-1','WORKFLOW_CHANGE','project-1','PROJECT','APPROVED','local-user','local-user',NULL,$now,$now)",
    { now },
  );
  db.run(
    "INSERT INTO onboarding_configs(project_id,repository_path,facts_json,proposed_json,status,approval_id,created_at,updated_at,activated_at) VALUES ('project-1','C:\\repo','{}',$json,'ACTIVE','onboarding-1',$now,$now,$now)",
    { now, json: JSON.stringify({ defaultBranch: "master" }) },
  );
}

function setup() {
  const db = createSqliteDatabase(":memory:");
  runMigrations(db, migrations);
  const now = new Date().toISOString();
  seedActiveProjectWithOnboarding(db, now);
  const chat = new ChatRepository(db);
  const approveAndRun = vi.fn(async () => ({
    epicId: "epic-1",
    sequence: ["plan"],
    childStatuses: ["DRAFT"],
    finalApprovalRequired: true,
    pendingFinalApproval: true,
    finalApprovalId: "approval-1",
  }));
  const eventBus = new EventBus();
  const app = createApp({
    db,
    scheduler: {} as never,
    runService: {} as never,
    epicOrchestrator: {
      start: vi.fn(async (input: EpicStartInput): Promise<PlanningPlan> => ({ id: "plan-0", status: "PENDING", approvalRequired: true, temporaryIdMap: {}, createdAt: now, ...input })),
      approveAndRun,
    },
    eventBus,
    authService: createTestAuthService(),
  });
  return { db, app, chat, eventBus, approveAndRun, now };
}

function seedPlan(db: ReturnType<typeof createSqliteDatabase>, planId: string, projectId: string, status = "PENDING", now?: string): void {
  db.run(
    "INSERT INTO planning_plans(id,project_id,plan_json,status,approval_required,created_at) VALUES($id,$projectId,'{}',$status,1,$now)",
    { id: planId, projectId, status, now: now ?? new Date().toISOString() },
  );
}

function seedPendingRequest(db: ReturnType<typeof createSqliteDatabase>, requestId: string, planId: string, now: string): void {
  db.run(
    "INSERT INTO planning_requests(id,project_id,request,requested_by,classification,plan_id,status,created_at,updated_at) VALUES($id,'project-1','Build Epic','local-user','EPIC',$planId,'PLAN_PENDING_APPROVAL',$now,$now)",
    { id: requestId, planId, now },
  );
}

describe("chat routes", () => {
  it("requires a session for chat API access (auth boundary)", async () => {
    const { app, db } = setup();
    const response = await app.inject({ method: "GET", url: "/api/v1/projects/project-1/conversations" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ contractVersion: 1, error: { code: "AUTH_SESSION_REQUIRED" } });
    const post = await app.inject({ method: "POST", url: "/api/v1/projects/project-1/conversations", payload: {} });
    expect(post.statusCode).toBe(401);
    await app.close(); db.close();
  });

  it("creates and lists conversations of a project", async () => {
    const { app, db } = setup();
    const headers = testAuthHeaders();
    const created = await app.inject({ method: "POST", url: "/api/v1/projects/project-1/conversations", headers, payload: { title: "Вопрос по плану" } });
    expect(created.statusCode).toBe(201);
    const conversationId = (created.json() as { conversation: { id: string } }).conversation.id;
    expect(conversationId).toMatch(/^conv_/);
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM chat_conversations")?.count).toBe(1);

    const list = await app.inject({ method: "GET", url: "/api/v1/projects/project-1/conversations", headers });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ conversations: [{ id: conversationId, projectId: "project-1", status: "ACTIVE" }] });

    const missingProject = await app.inject({ method: "GET", url: "/api/v1/projects/nope/conversations", headers });
    expect(missingProject.statusCode).toBe(404);
    expect(missingProject.json()).toMatchObject({ contractVersion: 1, error: { code: "CHAT_PROJECT_NOT_FOUND" } });

    const one = await app.inject({ method: "GET", url: `/api/v1/conversations/${conversationId}`, headers });
    expect(one.statusCode).toBe(200);
    expect(one.json()).toMatchObject({ conversation: { id: conversationId, projectId: "project-1" } });

    const missing = await app.inject({ method: "GET", url: "/api/v1/conversations/conv_missing", headers });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ contractVersion: 1, error: { code: "CHAT_CONVERSATION_NOT_FOUND" } });
    await app.close(); db.close();
  });

  it("posts a plain message (202) and validates the message body", async () => {
    const { app, db, chat } = setup();
    const headers = testAuthHeaders();
    const conversation = chat.createConversation("project-1");

    const ok = await app.inject({ method: "POST", url: `/api/v1/conversations/${conversation.id}/messages`, headers, payload: { content: "Привет" } });
    expect(ok.statusCode).toBe(202);
    const body = ok.json() as { message: { role: string; kind: string; content: string; requestId: string | null }; planning?: unknown };
    expect(body.message).toMatchObject({ role: "user", kind: "text", content: "Привет", requestId: null });
    expect(body.planning).toBeUndefined();

    const empty = await app.inject({ method: "POST", url: `/api/v1/conversations/${conversation.id}/messages`, headers, payload: { content: "   " } });
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toMatchObject({ contractVersion: 1, error: { code: "CHAT_MESSAGE_CONTENT_INVALID" } });

    const unknownKey = await app.inject({ method: "POST", url: `/api/v1/conversations/${conversation.id}/messages`, headers, payload: { content: "x", evil: 1 } });
    expect(unknownKey.statusCode).toBe(400);
    expect(unknownKey.json()).toMatchObject({ contractVersion: 1, error: { code: "CHAT_INVALID_REQUEST" } });

    const missingConversation = await app.inject({ method: "POST", url: "/api/v1/conversations/conv_missing/messages", headers, payload: { content: "x" } });
    expect(missingConversation.statusCode).toBe(404);
    expect(missingConversation.json()).toMatchObject({ contractVersion: 1, error: { code: "CHAT_CONVERSATION_NOT_FOUND" } });
    await app.close(); db.close();
  });

  it("posts a planning request (202 with planning) and continuation for NEEDS_INPUT", async () => {
    const { app, db, chat } = setup();
    const headers = testAuthHeaders();
    const conversation = chat.createConversation("project-1");

    const planning = await app.inject({ method: "POST", url: `/api/v1/conversations/${conversation.id}/messages`, headers, payload: { content: "Спланируй Epic", asPlanningRequest: true } });
    expect(planning.statusCode).toBe(202);
    const body = planning.json() as { message: { requestId: string | null }; planning: { requestId: string; status: string } };
    expect(body.planning).toMatchObject({ status: "RECEIVED" });
    expect(body.message.requestId).toBe(body.planning.requestId);
    expect(db.get<{ type: string }>("SELECT type FROM background_jobs WHERE dedupe_key=$key", { key: `planning:${body.planning.requestId}` })?.type).toBe("coordinator.planning");

    const notActive = await app.inject({ method: "POST", url: `/api/v1/conversations/${conversation.id}/messages`, headers, payload: { content: "x", asPlanningRequest: true, requestId: "request-missing" } });
    expect(notActive.statusCode).toBe(404);
    expect(notActive.json()).toMatchObject({ contractVersion: 1, error: { code: "CHAT_PLANNING_REQUEST_NOT_FOUND" } });

    const now = new Date().toISOString();
    db.run(
      "INSERT INTO planning_requests(id,project_id,request,requested_by,classification,plan_id,status,created_at,updated_at) VALUES('request-awaiting','project-1','Ask','local-user',NULL,NULL,'NEEDS_INPUT',$now,$now)",
      { now },
    );
    const continuation = await app.inject({ method: "POST", url: `/api/v1/conversations/${conversation.id}/messages`, headers, payload: { content: "Дополнение", asPlanningRequest: true, requestId: "request-awaiting" } });
    expect(continuation.statusCode).toBe(202);
    expect(continuation.json()).toMatchObject({ planning: { requestId: "request-awaiting", status: "RECEIVED" } });
    expect(db.get<{ status: string }>("SELECT status FROM planning_requests WHERE id='request-awaiting'")?.status).toBe("RECEIVED");

    const wrongState = await app.inject({ method: "POST", url: `/api/v1/conversations/${conversation.id}/messages`, headers, payload: { content: "x", asPlanningRequest: true, requestId: "request-awaiting" } });
    expect(wrongState.statusCode).toBe(409);
    expect(wrongState.json()).toMatchObject({ contractVersion: 1, error: { code: "CHAT_PLANNING_REQUEST_NOT_AWAITING_INPUT" } });
    await app.close(); db.close();
  });

  it("paginates message history with cursor (no overlaps, covers all)", async () => {
    const { app, db, chat } = setup();
    const headers = testAuthHeaders();
    const conversation = chat.createConversation("project-1");
    for (const content of ["one", "two", "three"]) {
      await app.inject({ method: "POST", url: `/api/v1/conversations/${conversation.id}/messages`, headers, payload: { content } });
    }

    const page1 = await app.inject({ method: "GET", url: `/api/v1/conversations/${conversation.id}/messages?limit=2`, headers });
    expect(page1.statusCode).toBe(200);
    const p1 = page1.json() as { items: Array<{ id: string; content: string }>; nextCursor: string | null; prevCursor: string | null };
    expect(p1.items).toHaveLength(2);
    expect(p1.items.map((item) => item.content)).toEqual(["three", "two"]);
    expect(p1.nextCursor).toBeTruthy();
    expect(p1.prevCursor).toBeNull();

    const page2 = await app.inject({ method: "GET", url: `/api/v1/conversations/${conversation.id}/messages?limit=2&cursor=${encodeURIComponent(p1.nextCursor!)}`, headers });
    expect(page2.statusCode).toBe(200);
    const p2 = page2.json() as { items: Array<{ id: string; content: string }>; nextCursor: string | null; prevCursor: string | null };
    expect(p2.items.map((item) => item.content)).toEqual(["one"]);
    expect(p2.nextCursor).toBeNull();
    expect(p2.prevCursor).toBeTruthy();
    const seen = new Set([...p1.items, ...p2.items].map((item) => item.id));
    expect(seen.size).toBe(3);

    const badLimit = await app.inject({ method: "GET", url: `/api/v1/conversations/${conversation.id}/messages?limit=0`, headers });
    expect(badLimit.statusCode).toBe(400);
    expect(badLimit.json()).toMatchObject({ contractVersion: 1, error: { code: "CHAT_LIMIT_INVALID" } });

    const badDirection = await app.inject({ method: "GET", url: `/api/v1/conversations/${conversation.id}/messages?direction=sideways`, headers });
    expect(badDirection.statusCode).toBe(400);
    expect(badDirection.json()).toMatchObject({ contractVersion: 1, error: { code: "CHAT_DIRECTION_INVALID" } });

    const badCursor = await app.inject({ method: "GET", url: `/api/v1/conversations/${conversation.id}/messages?cursor=%2A%2A%2A`, headers });
    expect(badCursor.statusCode).toBe(400);
    expect(badCursor.json()).toMatchObject({ contractVersion: 1, error: { code: "CHAT_CURSOR_INVALID" } });

    const missing = await app.inject({ method: "GET", url: "/api/v1/conversations/conv_missing/messages", headers });
    expect(missing.statusCode).toBe(404);
    await app.close(); db.close();
  });

  it("streams conversation events via SSE (text/event-stream, :ok, event delivery)", async () => {
    const { app, db, chat, eventBus } = setup();
    const conversation = chat.createConversation("project-1");
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("test server did not expose an address");

    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/conversations/${conversation.id}/events`, {
      headers: { cookie: TEST_COOKIE },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    expect(decoder.decode(first.value)).toContain(":ok");

    eventBus.emitObserved(DomainEvent.create({
      type: "message.created",
      aggregateType: "ChatMessage",
      aggregateId: "msg_1",
      payload: { messageId: "msg_1", conversationId: conversation.id, kind: "text", role: "user" },
    }));
    const second = await reader.read();
    const chunk = decoder.decode(second.value);
    expect(chunk).toContain("event: message.created");
    expect(chunk).toContain(conversation.id);

    try {
      await reader.cancel();
    } finally {
      controller.abort();
      await app.close();
      db.close();
    }
  });

  it("rejects SSE for a missing conversation with the contract error", async () => {
    const { app, db } = setup();
    const response = await app.inject({ method: "GET", url: "/api/v1/conversations/conv_missing/events", headers: { cookie: TEST_COOKIE } });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ contractVersion: 1, error: { code: "CHAT_CONVERSATION_NOT_FOUND" } });
    await app.close(); db.close();
  });

  it("delegates plan approval to EpicOrchestrator.approveAndRun", async () => {
    const { app, db, chat, approveAndRun, now } = setup();
    const headers = testAuthHeaders();
    const conversation = chat.createConversation("project-1");
    seedPlan(db, "plan-1", "project-1", "PENDING", now);
    seedPendingRequest(db, "request-1", "plan-1", now);

    const detached = await app.inject({ method: "POST", url: `/api/v1/conversations/${conversation.id}/plans/plan-1/approve`, headers, payload: {} });
    expect(detached.statusCode).toBe(200);
    expect(approveAndRun).toHaveBeenCalledWith("plan-1", "local-user", undefined);

    const linked = await app.inject({ method: "POST", url: `/api/v1/conversations/${conversation.id}/plans/plan-1/approve`, headers, payload: { requestId: "request-1" } });
    expect(linked.statusCode).toBe(200);
    expect(approveAndRun).toHaveBeenLastCalledWith("plan-1", "local-user", "request-1");

    const wrongRequest = await app.inject({ method: "POST", url: `/api/v1/conversations/${conversation.id}/plans/plan-1/approve`, headers, payload: { requestId: "request-other" } });
    expect(wrongRequest.statusCode).toBe(404);
    expect(wrongRequest.json()).toMatchObject({ contractVersion: 1, error: { code: "CHAT_PLANNING_REQUEST_NOT_FOUND" } });

    const foreignPlan = await app.inject({ method: "POST", url: `/api/v1/conversations/${conversation.id}/plans/plan-foreign/approve`, headers, payload: {} });
    expect(foreignPlan.statusCode).toBe(404);
    expect(foreignPlan.json()).toMatchObject({ contractVersion: 1, error: { code: "CHAT_PLAN_NOT_FOUND" } });
    await app.close(); db.close();
  });

  it("delegates plan rejection to the planning authority (rejectPlan)", async () => {
    const { app, db, chat, now } = setup();
    const headers = testAuthHeaders();
    const conversation = chat.createConversation("project-1");
    seedPlan(db, "plan-2", "project-1", "PENDING", now);
    seedPendingRequest(db, "request-2", "plan-2", now);

    const rejected = await app.inject({ method: "POST", url: `/api/v1/conversations/${conversation.id}/plans/plan-2/reject`, headers, payload: {} });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json()).toMatchObject({ plan: { id: "plan-2", status: "REJECTED" } });
    expect(db.get<{ status: string }>("SELECT status FROM planning_plans WHERE id='plan-2'")?.status).toBe("REJECTED");
    expect(db.get<{ status: string }>("SELECT status FROM planning_requests WHERE id='request-2'")?.status).toBe("REJECTED");
    expect(db.get<{ type: string }>("SELECT type FROM outbox_events WHERE type='planning.status' ORDER BY id DESC LIMIT 1")?.type).toBe("planning.status");

    const again = await app.inject({ method: "POST", url: `/api/v1/conversations/${conversation.id}/plans/plan-2/reject`, headers, payload: {} });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ contractVersion: 1, error: { code: "CHAT_PLAN_ALREADY_RESOLVED" } });

    const badBody = await app.inject({ method: "POST", url: `/api/v1/conversations/${conversation.id}/plans/plan-2/reject`, headers, payload: { note: "x" } });
    expect(badBody.statusCode).toBe(400);
    expect(badBody.json()).toMatchObject({ contractVersion: 1, error: { code: "CHAT_INVALID_REQUEST" } });
    await app.close(); db.close();
  });
});
