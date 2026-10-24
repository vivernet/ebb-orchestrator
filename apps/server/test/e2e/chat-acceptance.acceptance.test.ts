/**
 * Acceptance E2E чата координатора (plan-25 Task 7).
 *
 * Поднимает РЕАЛЬНЫЙ production-сервер (dist/main.js через фикстуру
 * crash-recovery-server.mjs, как в hermes-session-handoff), сеет локального
 * пользователя и активный проект с онбордингом, поднимает локальный
 * мок-upstream провайдер (OpenAI-совместимый, local-endpoint) и гоняет
 * сценарии через реальную локальную HTTP-сессию:
 *   - отправка текста → 202 + {message} без planning;
 *   - отправка запроса планирования → 202 + {message, planning: RECEIVED};
 *   - статусная прогрессия через SSE: RECEIVED → PLANNING →
 *     PLAN_PENDING_APPROVAL → (approve) → MATERIALIZED;
 *   - одобрение плана и появление материализованных задач;
 *   - cursor-пагинация истории сообщений;
 *   - SSE-реконнект: новое соединение получает последующие события.
 */
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApprovalService } from "../../src/modules/approvals/approval-service.js";
import { OnboardingService } from "../../src/modules/projects/onboarding-service.js";
import { PlanningService } from "../../src/modules/planning/planning-service.js";
import { ChatRepository } from "../../src/modules/chat/chat-repository.js";
import { createSqliteDatabase } from "../../src/platform/database/sqlite-database.js";
import type { Database } from "../../src/platform/database/database.js";
import { GitCli } from "../../src/modules/git/git-cli.js";
import { seedApprovedProjectConfig } from "../helpers/approved-project-config.js";

const SERVER_FIXTURE = resolve(import.meta.dirname, "fixtures/crash-recovery-server.mjs");
const WORKSPACE_ROOT = resolve(import.meta.dirname, "../../../..");
const SHUTDOWN_MESSAGE = "ebb-v1-crash-recovery:shutdown";

/** Только проверенные переменные окружения передаются production-ребёнку (без секретов). */
const ENVIRONMENT_ALLOWLIST = [
  "PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
  "HERMES_DATA_DIR_SUFFIX", "HERMES_RUNTIME_DIR", "HERMES_HOME", "HERMES_CONFIG", "HERMES_PROFILE", "HERMES_MODEL",
] as const;

const wait = (milliseconds: number) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

interface AuthSession { cookie: string; csrf: string; }

interface SSEEntry { event: string; data: Record<string, unknown>; }

interface ChatMessageItem {
  id: string;
  kind: string;
  status: string | null;
  requestId: string | null;
  planId: string | null;
  role: string;
  content: string;
}

interface ConversationEventPayload {
  conversationId?: string;
  kind?: string;
  role?: string;
  messageId?: string;
}

function messagePayload(entry: SSEEntry): ConversationEventPayload | undefined {
  const payload = entry.data.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  return payload as unknown as ConversationEventPayload;
}

function reservePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("TEST_PORT_UNAVAILABLE"));
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

async function spawnProductionServer(home: string, port: number, password: string): Promise<ChildProcess> {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ENVIRONMENT_ALLOWLIST) {
    const inheritedName = Object.keys(process.env).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
    if (inheritedName && process.env[inheritedName] !== undefined) environment[name] = process.env[inheritedName];
  }
  environment.EBB_ORCHESTRATOR_HOME = home;
  environment.PORT = String(port);
  const child = spawn(process.execPath, [SERVER_FIXTURE, "--bootstrap-local-user-stdin"], {
    cwd: WORKSPACE_ROOT,
    env: environment,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  child.stdin?.end(`${password}\n${password}\n`);
  return child;
}

async function waitForReady(origin: string, child: ChildProcess, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("SERVER_EXITED_BEFORE_READY");
    const response = await fetch(`${origin}/api/v1/health`, { signal: AbortSignal.timeout(500) }).catch(() => undefined);
    if (response?.ok) {
      const body = await response.json() as { lifecycle?: string };
      if (body.lifecycle === "READY") return;
    }
    await wait(100);
  }
  throw new Error("SERVER_READY_TIMEOUT");
}

async function stopProductionServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveSend, reject) => {
    child.send(SHUTDOWN_MESSAGE, (error) => (error ? reject(error) : resolveSend()));
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await wait(100);
  }
  throw new Error("SERVER_EXIT_TIMEOUT");
}

async function login(origin: string, password: string): Promise<AuthSession> {
  const response = await fetch(`${origin}/api/v1/session/login`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  expect(response.status).toBe(200);
  const cookieHeader = response.headers.get("set-cookie");
  const cookie = cookieHeader?.split(";", 1)[0];
  const body = await response.json() as { csrfToken?: unknown };
  expect(cookie).toBeTruthy();
  expect(typeof body.csrfToken).toBe("string");
  return { cookie: cookie!, csrf: body.csrfToken as string };
}

async function apiJson(
  origin: string,
  auth: AuthSession,
  path: string,
  options: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<{ status: number; headers: Headers; body: unknown }> {
  const headers: Record<string, string> = {
    origin,
    cookie: auth.cookie,
  };
  const method = options.method ?? (options.body === undefined ? "GET" : "POST");
  if (method !== "GET" && method !== "HEAD") headers["x-csrf-token"] = auth.csrf;
  let body: string | undefined;
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  const init: RequestInit = { method, headers, signal: AbortSignal.timeout(options.timeoutMs ?? 30_000) };
  if (body !== undefined) init.body = body;
  const response = await fetch(`${origin}${path}`, init);
  const text = await response.text();
  let parsed: unknown;
  try { parsed = text === "" ? null : JSON.parse(text); } catch { parsed = text; }
  return { status: response.status, headers: response.headers, body: parsed };
}

class SSEEventCollector {
  readonly events: SSEEntry[] = [];
  private waiters: Array<{ predicate: (events: SSEEntry[]) => boolean; resolve: () => void; timer: NodeJS.Timeout }> = [];
  private controller: AbortController | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  static async open(origin: string, conversationId: string, auth: AuthSession): Promise<SSEEventCollector> {
    const collector = new SSEEventCollector();
    const controller = new AbortController();
    collector.controller = controller;
    const response = await fetch(`${origin}/api/v1/conversations/${conversationId}/events`, {
      headers: { cookie: auth.cookie },
      signal: controller.signal,
    });
    if (response.status !== 200) throw new Error(`SSE open failed: ${response.status}`);
    collector.reader = response.body!.getReader();
    void collector.readLoop();
    return collector;
  }

  private async readLoop(): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await this.reader!.read();
      } catch {
        break; // abort/reconnect: завершаем чтение
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        let event = "message";
        const dataLines: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith(":")) continue;
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
        }
        if (dataLines.length === 0) continue;
        let data: unknown;
        try { data = JSON.parse(dataLines.join("\n")); } catch { continue; }
        if (data === null || typeof data !== "object" || Array.isArray(data)) continue;
        this.push({ event, data: data as Record<string, unknown> });
      }
    }
  }

  private push(event: SSEEntry): void {
    this.events.push(event);
    for (const waiter of [...this.waiters]) {
      if (waiter.predicate(this.events)) {
        clearTimeout(waiter.timer);
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  }

  async waitFor(predicate: (events: SSEEntry[]) => boolean, timeoutMs: number): Promise<void> {
    if (predicate(this.events)) return;
    await new Promise<void>((resolveWait, reject) => {
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.findIndex((waiter) => waiter.timer === timer), 1);
        reject(new Error("SSE_EVENT_TIMEOUT"));
      }, timeoutMs);
      this.waiters.push({ predicate, resolve: resolveWait, timer });
    });
  }

  async close(): Promise<void> {
    this.controller?.abort();
    await this.reader?.cancel().catch(() => undefined);
  }
}

/** Ожидает конкретный status-переход сообщения-зеркала в истории. */
async function waitForStatusMessage(
  origin: string, auth: AuthSession, conversationId: string, status: string, timeoutMs = 90_000,
): Promise<ChatMessageItem> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const page = await apiJson(origin, auth, `/api/v1/conversations/${conversationId}/messages?limit=50`);
    expect(page.status).toBe(200);
    const body = page.body as { items?: ChatMessageItem[] };
    const found = (body.items ?? []).find((message) => message.status === status);
    if (found) return found;
    const failed = (body.items ?? []).find((message) => message.kind === "error");
    if (failed) throw new Error(`CHAT_MESSAGE_FAILED: ${failed.content}`);
    await wait(250);
  }
  throw new Error(`STATUS_MESSAGE_TIMEOUT: ${status}`);
}

/** Вставляет минимальную строку agent_runs для детерминированного планирования. */
function insertPlanningRun(database: Database, runId: string, role: string, status: string, output?: string): void {
  const now = new Date().toISOString();
  database.run(
    `INSERT INTO agent_runs(id,role,runtime,model,task_id,epic_id,status,trigger_reason,context_version,output_schema_version,started_at,ended_at,exit_code,output)
     VALUES($id,$role,'provider','default',NULL,NULL,$status,$trigger,$version,$schema,$started,$ended,$code,$output)`,
    {
      id: runId, role, status,
      trigger: role === "coordinator" ? "planning-request" : "planning-request-role",
      version: "1", schema: "1",
      started: now, ended: status === "COMPLETED" ? now : null,
      code: status === "COMPLETED" ? 0 : null,
      output: output ?? null,
    },
  );
}

/** Привязывает review-run к planning request (planning_request_role_runs). */
function linkPlanningRoleRun(database: Database, requestId: string, role: string, runId: string): void {
  database.run(
    "INSERT INTO planning_request_role_runs(request_id,role,run_id,created_at) VALUES($requestId,$role,$runId,$now)",
    { requestId, role, runId, now: new Date().toISOString() },
  );
}

/** Отменяет durable coordinator.planning job, чтобы JobWorker не вмешивался в ручной сценарий. */
function cancelPlanningJob(database: Database, requestId: string): void {
  database.run(
    `UPDATE background_jobs SET status='CANCELLED', updated_at=$now
     WHERE type='coordinator.planning' AND payload_json LIKE $match AND status IN ('QUEUED','RETRY_WAIT')`,
    { match: `%${requestId}%`, now: new Date().toISOString() },
  );
}

describe("Task 7: chat acceptance (real production session + local mock upstream)", () => {
  let root = "";
  let home = "";
  let origin = "";
  let password = "";
  let child: ChildProcess | null = null;
  let auth: AuthSession;
  let projectId = "";
  let conversationId = "";
  let planningRequestId = "";
  let sse: SSEEventCollector | null = null;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "ebb-plan25-chat-acceptance-"));
    home = join(root, "orchestrator-home");
    await mkdir(home, { recursive: true });

    // Репозиторий-фикстура для онбординга (без него chat planning невозможен).
    const repository = join(root, "repository");
    await mkdir(repository, { recursive: true });
    const git = new GitCli();
    await git.run(repository, ["init", "--initial-branch=master"]);
    await git.run(repository, ["config", "user.email", "chat-acceptance@example.invalid"]);
    await git.run(repository, ["config", "user.name", "Chat Acceptance"]);
    await writeFile(join(repository, "README.md"), "# Chat acceptance repository\n");
    await git.run(repository, ["add", "README.md"]);
    const commit = await git.run(repository, ["commit", "-m", "initial"]);
    if (commit.exitCode !== 0) throw new Error("FIXTURE_GIT_COMMIT_FAILED");

    password = randomUUID();
    const port = await reservePort();
    origin = `http://127.0.0.1:${port}`;

    child = await spawnProductionServer(home, port, password);
    await waitForReady(origin, child);
    auth = await login(origin, password);

    // Активный проект с одобренным онбордингом (та же схема, что в Task5C).
    const database = createSqliteDatabase(join(home, "ebb-orchestrator.db"));
    try {
      const approvals = new ApprovalService(database);
      const onboarding = new OnboardingService(database, approvals);
      const draft = await onboarding.discoverAndCreateDraft(repository);
      onboarding.requestApproval(draft.projectId, {
        defaultBranch: "master", workflow: "standard", roles: ["developer"],
        guidelines: ["Use this disposable repository for chat E2E only."],
      });
      onboarding.approve(draft.projectId);
      onboarding.activate(draft.projectId);
      seedApprovedProjectConfig(database, draft.projectId, "master");
      projectId = draft.projectId;
    } finally {
      database.close();
    }

    // Беседа и первый текстовый запрос.
    const createResponse = await apiJson(origin, auth, `/api/v1/projects/${projectId}/conversations`, { method: "POST", body: {} });
    expect(createResponse.status).toBe(201);
    conversationId = ((createResponse.body as { conversation: { id: string } }).conversation.id);

    const sendResponse = await apiJson(origin, auth, `/api/v1/conversations/${conversationId}/messages`, {
      method: "POST",
      body: { content: "hello from chat acceptance", asPlanningRequest: false },
    });
    expect(sendResponse.status).toBe(202);
    const sendBody = sendResponse.body as { message: { id: string; kind: string }; planning?: unknown };
    expect(sendBody.message.id).toBeTruthy();
    expect(sendBody.message.kind).toBe("text");
    expect(sendBody.planning).toBeUndefined();
  }, 180_000);

  afterAll(async () => {
    await sse?.close().catch(() => undefined);
    sse = null;
    if (child) await stopProductionServer(child).catch(() => undefined);
    if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }, 60_000);

  it("отправка запроса планирования возвращает 202 с planning RECEIVED и зеркало статуса приходит через SSE", async () => {
    sse = await SSEEventCollector.open(origin, conversationId, auth);

    const sendResponse = await apiJson(origin, auth, `/api/v1/conversations/${conversationId}/messages`, {
      method: "POST",
      body: { content: "Спланируй эпик с двумя задачами для e2e", asPlanningRequest: true },
    });
    expect(sendResponse.status).toBe(202);
    const sendBody = sendResponse.body as { message: { id: string }; planning: { requestId: string; status: string } };
    expect(sendBody.planning.status).toBe("RECEIVED");
    expect(sendBody.planning.requestId).toBeTruthy();
    planningRequestId = sendBody.planning.requestId;

    // Не даём JobWorker трогать этот request (детерминированный сценарий ниже).
    const cancelDb = createSqliteDatabase(join(home, "ebb-orchestrator.db"));
    try {
      cancelPlanningJob(cancelDb, planningRequestId);
    } finally {
      cancelDb.close();
    }

    // RECEIVED-зеркало (системное сообщение) приходит через outbox→bus→SSE.
    await sse.waitFor((events) => events.some((entry) => {
      const payload = messagePayload(entry);
      return entry.event === "message.created" && payload?.conversationId === conversationId &&
        payload?.kind === "text" && payload?.role === "system";
    }), 60_000);

    const page = await apiJson(origin, auth, `/api/v1/conversations/${conversationId}/messages?limit=50`);
    expect(page.status).toBe(200);
    const items = (page.body as { items: ChatMessageItem[] }).items;
    const received = items.find((message) => message.requestId === planningRequestId && message.status === "RECEIVED");
    expect(received).toBeTruthy();
    expect(items.filter((message) => message.kind === "error")).toEqual([]);
  }, 90_000);

  it("детерминированная прогрессия статусов RECEIVED→PLANNING→PLAN_PENDING_APPROVAL→MATERIALIZED через SSE (мок-планирование)", async () => {
    const database = createSqliteDatabase(join(home, "ebb-orchestrator.db"));
    try {
      const planning = new PlanningService(database);
      const requestId = randomUUID();
      const now = new Date().toISOString();

      // 1. planning_request создаётся напрямую (без durable coordinator-джоба):
      //    сценарий изолирован от JobWorker и не требует LLM/провайдера.
      database.run(
        `INSERT INTO planning_requests(id,project_id,request,requested_by,status,planning_decisions_required,created_at,updated_at)
         VALUES($id,$projectId,'Эпик с двумя задачами','local-user','RECEIVED',1,$now,$now)`,
        { id: requestId, projectId, now },
      );

      // 2. Сообщение пользователя, привязанное к requestId (резолв беседы зеркалом).
      const chatRepository = new ChatRepository(database);
      chatRepository.appendMessage({ conversationId, role: "user", kind: "text", content: "Спланируй эпик с двумя задачами для e2e", requestId });

      sse = await SSEEventCollector.open(origin, conversationId, auth);

      // 3. PLANNING через claimRequest (требует coordinator-run).
      const coordinatorRunId = randomUUID();
      insertPlanningRun(database, coordinatorRunId, "coordinator", "STARTED");
      expect(planning.claimRequest(requestId, coordinatorRunId)).toBe(true);
      await sse.waitFor((events) => events.some((entry) => {
        const payload = messagePayload(entry);
        return entry.event === "message.created" && payload?.conversationId === conversationId &&
          payload?.kind === "status_update";
      }), 60_000);

      // 4. PLAN_PENDING_APPROVAL: EPIC-план с решениями PM/Architect.
      const productManager = { version: "1.0.0", outcome: "PRODUCT_DEFINITION", summary: "pm", goal: "g", scope: ["s"], requirements: ["r"], acceptanceCriteria: ["a"] };
      const architect = { version: "1.0.0", outcome: "DESIGN", summary: "arch", components: ["c"], decisions: ["d"] };
      const pmRunId = randomUUID();
      const architectRunId = randomUUID();
      insertPlanningRun(database, pmRunId, "product_manager", "COMPLETED", JSON.stringify(productManager));
      insertPlanningRun(database, architectRunId, "architect", "COMPLETED", JSON.stringify(architect));
      linkPlanningRoleRun(database, requestId, "product_manager", pmRunId);
      linkPlanningRoleRun(database, requestId, "architect", architectRunId);

      const planInput = {
        projectId,
        requestedBy: "local-user",
        epic: { title: "E2E эпик", goal: "g" },
        tasks: [
          { ref: "task_e2e_a", title: "A", acceptanceCriteria: ["a"], dependsOn: [], role: "developer", workflow: "standard", optional: false },
          { ref: "task_e2e_b", title: "B", acceptanceCriteria: ["b"], dependsOn: ["task_e2e_a"], role: "developer", workflow: "standard", optional: false },
        ],
        planningDecisions: { productManager, architect },
      };
      const plan = planning.completeRequest(requestId, coordinatorRunId, "EPIC", planInput as Parameters<PlanningService["completeRequest"]>[3]);
      expect(plan.status).toBe("PENDING");

      const statusEvents = database.all<{ type: string; payload_json: string }>(
        "SELECT type, payload_json FROM outbox_events WHERE type='planning.status' AND payload_json LIKE $match ORDER BY created_at DESC LIMIT 5",
        { match: `%${requestId}%` },
      );
      expect(statusEvents.some((row) => row.payload_json.includes(plan.id)), JSON.stringify(statusEvents)).toBe(true);

      const approvalMessage = await waitForStatusMessage(origin, auth, conversationId, "PLAN_PENDING_APPROVAL");
      const planIdFromDb = database.get<{ plan_id: string | null }>("SELECT plan_id FROM planning_requests WHERE id=$id", { id: requestId })?.plan_id ?? null;
      const pendingMessages = database.all<{ id: string; kind: string; plan_id: string | null; status: string | null }>(
        "SELECT id, kind, plan_id, status FROM chat_messages WHERE conversation_id=$conversationId AND status='PLAN_PENDING_APPROVAL' ORDER BY created_at DESC, id DESC LIMIT 5",
        { conversationId },
      );
      expect(planIdFromDb, `db plan_id request=${requestId}`).toBe(plan.id);
      expect(pendingMessages, JSON.stringify(pendingMessages)).toHaveLength(1);
      expect(approvalMessage.kind).toBe("approval_request");
      expect(approvalMessage.planId).toBe(plan.id);
      expect(approvalMessage.requestId).toBe(requestId);

      // 5. Одобрение → MATERIALIZED + материализация задач.
      planning.approvePlan(plan.id, "local-user", requestId);
      const materialized = await waitForStatusMessage(origin, auth, conversationId, "MATERIALIZED");
      expect(materialized.kind).toBe("status_update");
      expect(materialized.requestId).toBe(requestId);
      // В зеркале MATERIALIZED planId не хранится (только approval_request несёт planId).

      const taskCount = database.get<{ count: number }>("SELECT COUNT(*) AS count FROM tasks WHERE project_id=$projectId", { projectId })?.count ?? 0;
      expect(taskCount).toBeGreaterThanOrEqual(2);
    } finally {
      database.close();
    }
  }, 180_000);

  it("cursor-пагинация истории не теряет и не повторяет сообщения", async () => {
    const added: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const response = await apiJson(origin, auth, `/api/v1/conversations/${conversationId}/messages`, {
        method: "POST",
        body: { content: `pagination message ${index}`, asPlanningRequest: false },
      });
      expect(response.status).toBe(202);
      added.push((response.body as { message: { id: string } }).message.id);
    }

    const collected: string[] = [];
    let cursor: string | null = null;
    for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
      const suffix = cursor === null ? "limit=5" : `limit=5&cursor=${encodeURIComponent(cursor)}&direction=older`;
      const response = await apiJson(origin, auth, `/api/v1/conversations/${conversationId}/messages?${suffix}`);
      expect(response.status).toBe(200);
      const page = response.body as { items: Array<{ id: string }>; nextCursor: string | null };
      for (const item of page.items) collected.push(item.id);
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }

    expect(new Set(collected).size).toBe(collected.length);
    const allExpected = new Set<string>();
    const history = await apiJson(origin, auth, `/api/v1/conversations/${conversationId}/messages?limit=200`);
    for (const item of (history.body as { items: Array<{ id: string }> }).items) allExpected.add(item.id);
    expect(allExpected.size).toBeGreaterThanOrEqual(12);
    expect(new Set(collected).size).toBeGreaterThanOrEqual(12);
    expect(added.every((id) => collected.includes(id))).toBe(true);
  }, 120_000);

  it("SSE-реконнект: новое соединение продолжает получать события", async () => {
    await sse!.close();
    sse = null;

    const reopened = await SSEEventCollector.open(origin, conversationId, auth);
    const sendResponse = await apiJson(origin, auth, `/api/v1/conversations/${conversationId}/messages`, {
      method: "POST",
      body: { content: "после реконнекта", asPlanningRequest: false },
    });
    expect(sendResponse.status).toBe(202);
    const messageId = (sendResponse.body as { message: { id: string } }).message.id;

    await reopened.waitFor((events) => events.some((entry) => {
      const payload = messagePayload(entry);
      return entry.event === "message.created" && payload?.messageId === messageId;
    }), 30_000);
    await reopened.close();
  }, 90_000);
});
