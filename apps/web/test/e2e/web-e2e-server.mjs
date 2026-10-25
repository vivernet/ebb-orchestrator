import { Buffer } from "node:buffer";
import { clearTimeout, setTimeout } from "node:timers";
import { createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../server");
const home = process.env.EBB_ORCHESTRATOR_HOME;
let backendPort = Number(process.argv[2]);
if (!home || !Number.isInteger(backendPort) || backendPort < 1 || backendPort > 65535) throw new Error("E2E server configuration is invalid");
const databasePath = resolve(home, "ebb-orchestrator.db");
const lockPath = join(home, "orchestrator.lock");
const migrationDirectory = join(serverRoot, "dist/platform/database/migrations");
const migrations = readdirSync(migrationDirectory).filter((file) => file.endsWith(".sql")).map((file) => {
  const match = /^(\d+)_([^.]*)\.sql$/.exec(file);
  if (!match) throw new Error("Invalid migration filename");
  return { version: Number(match[1]), name: match[2], sql: readFileSync(join(migrationDirectory, file), "utf8") };
});
const [
  { createApp }, { createSqliteDatabase }, { runMigrations }, { SchedulerService },
  { createAuthRepository }, { createNodeDigestPort, createNodeRandomTokenPort },
  { createArgon2PasswordHasher }, { createAuthService }, { StatusTracker }, { SingleInstanceLock },
  { ApprovalService }, { OnboardingService },
] = await Promise.all([
  import("../../../server/dist/app/create-app.js"),
  import("../../../server/dist/platform/database/sqlite-database.js"),
  import("../../../server/dist/platform/database/migrator.js"),
  import("../../../server/dist/modules/scheduler/scheduler-service.js"),
  import("../../../server/dist/platform/security/auth-repository.js"),
  import("../../../server/dist/platform/security/auth-ports.js"),
  import("../../../server/dist/platform/security/password-hasher.js"),
  import("../../../server/dist/platform/security/auth-service.js"),
  import("../../../server/dist/platform/process/system-lifecycle.js"),
  import("../../../server/dist/platform/process/single-instance-lock.js"),
  import("../../../server/dist/modules/approvals/approval-service.js"),
  import("../../../server/dist/modules/projects/onboarding-service.js"),
]);
const { seedE2ELocalUser } = await import("../../../server/test/e2e/fixtures/auth-fixture.mjs");
const { ProjectConfigService } = await import("../../../server/dist/modules/projects/project-config-service.js");
const { ProviderSettingsService } = await import("../../../server/dist/modules/runtime/providers/provider-settings-service.js");
const { createProviderSettingsRepository } = await import("../../../server/dist/modules/runtime/providers/provider-settings-repository.js");
const { createProviderCredentialStore } = await import("../../../server/dist/modules/runtime/providers/provider-credential-store.js");
const { ProviderNetworkGateway } = await import("../../../server/dist/modules/runtime/providers/provider-network-gateway.js");
const { createProviderCustomModelsRepository } = await import("../../../server/dist/modules/runtime/providers/provider-management.js");
const { InMemorySecretStore } = await import("../../../server/dist/platform/security/secret-store.js");
const host = "127.0.0.1";
let canonicalDatabasePath;
let seeded = false;
let busy = false;
let backend;
let controlServer;
let controlEndpoint;
let activeDb = null;
const testMode = process.env.EBB_E2E_TEST_MODE === "1";
let testFault;

function send(message) {
  if (typeof process.send === "function" && process.connected) process.send(message);
}

function sendAndWait(message) {
  return new Promise((resolvePromise, reject) => {
    if (typeof process.send !== "function" || !process.connected) return reject(new Error("E2E IPC channel is not connected"));
    process.send(message, (error) => error ? reject(error) : resolvePromise());
  });
}

const ACTIVE_RUN_STATUSES = new Set(["STARTED", "IN_PROGRESS", "COMPLETING"]);
const TERMINAL_RUN_STATUSES = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

/**
 * Реализует RunCommandService-контракт для E2E: детерминированные команды
 * checkpoint/pause/resume/cancel/cancel-all с durable-персистенцией в SQLite.
 * Это тестовый двойник runtime (без внешних провайдеров), но не mock — все
 * переходы выполняются через реальные HTTP-маршруты и реальную БД.
 */
function createHarnessRunService(getDb) {
  const now = () => new Date().toISOString();
  const requireRun = (db, runId) => {
    const run = db.get("SELECT id, status FROM agent_runs WHERE id=$id", { id: runId });
    if (!run) throw Object.assign(new Error("run not found"), { code: "RUN_NOT_FOUND" });
    return run;
  };
  const controlRow = (db, runId) => db.get(
    "SELECT state, checkpoint_id, version, updated_at FROM run_control_state WHERE run_id=$id",
    { id: runId },
  );
  const recordCommand = (db, runId, requestId, command, status, version, result) => {
    const ctrl = controlRow(db, runId);
    const attempt = (ctrl?.version ?? 0) + 1;
    db.run(
      `INSERT INTO run_control_commands(request_id,run_id,attempt,command,expected_version,status,result_json,created_at,updated_at)
       VALUES($requestId,$runId,$attempt,$command,$expectedVersion,$status,$result,$now,$now)`,
      { requestId, runId, attempt, command, expectedVersion: ctrl?.version ?? 0, status, result: JSON.stringify(result ?? {}), now: now() },
    );
  };
  const writeControlState = (db, runId, state, checkpointId, version, attempt) => {
    const at = now();
    const existing = controlRow(db, runId);
    if (existing) {
      db.run(
        "UPDATE run_control_state SET state=$state, checkpoint_id=$checkpointId, version=$version, attempt=$attempt, updated_at=$at WHERE run_id=$runId",
        { state, checkpointId, version, attempt, at, runId },
      );
    } else {
      db.run(
        "INSERT INTO run_control_state(run_id,attempt,state,checkpoint_id,version,updated_at) VALUES($runId,$attempt,$state,$checkpointId,$version,$at)",
        { runId, attempt, state, checkpointId, version, at },
      );
    }
    return { state, version, updatedAt: at, checkpointId };
  };
  const upsertCheckpoint = (db, runId, requestId, version, attempt) => {
    const id = `ckpt-${runId}-${version}`;
    db.run(
      `INSERT OR IGNORE INTO run_checkpoints(id,run_id,attempt,request_id,session_id,owner_generation,containment_ref,launch_nonce_hash,context_hash,workspace_snapshot_hash,event_cursor,checkpoint_hash,created_at)
       VALUES($id,$runId,$attempt,$requestId,$session,$owner,$containment,$nonce,$context,$workspace,$cursor,$hash,$at)`,
      { id, runId, attempt, requestId, session: `session-${runId}`, owner: 1, containment: `containment-${runId}`, nonce: `nonce-${version}`, context: `context-${version}`, workspace: `workspace-${version}`, cursor: `cursor-${version}`, hash: `hash-${version}`, at: now() },
    );
    return id;
  };

  return {
    async cancelRun(runId) {
      const db = getDb();
      if (!db) throw Object.assign(new Error("database unavailable"), { code: "RUN_SERVICE_UNAVAILABLE" });
      const run = requireRun(db, runId);
      if (ACTIVE_RUN_STATUSES.has(run.status)) {
        db.run("UPDATE agent_runs SET status='CANCELLED', ended_at=$at WHERE id=$id", { id: runId, at: now() });
      }
    },
    async cancelAllRuns(expectedRunIds) {
      const db = getDb();
      if (!db) throw Object.assign(new Error("database unavailable"), { code: "RUN_SERVICE_UNAVAILABLE" });
      const results = [];
      for (const runId of expectedRunIds) {
        const run = db.get("SELECT id, status FROM agent_runs WHERE id=$id", { id: runId });
        if (!run || TERMINAL_RUN_STATUSES.has(run.status)) {
          results.push({ runId, outcome: "NOT_ACTIVE" });
          continue;
        }
        db.run("UPDATE agent_runs SET status='CANCELLED', ended_at=$at WHERE id=$id", { id: runId, at: now() });
        results.push({ runId, outcome: "CANCELLED" });
      }
      return { results };
    },
    async createCheckpoint(runId, requestId) {
      const db = getDb();
      if (!db) throw Object.assign(new Error("database unavailable"), { code: "RUN_SERVICE_UNAVAILABLE" });
      requireRun(db, runId);
      const current = controlRow(db, runId) ?? { state: "ACTIVE", version: 0 };
      if (current.state === "CLOSED") throw Object.assign(new Error("RUN_CONTROL_TERMINAL"), { code: "RUN_CONTROL_TERMINAL" });
      const version = current.version + 1;
      const attempt = version;
      recordCommand(db, runId, requestId, "CHECKPOINT", "COMPLETED", version, { checkpointId: `ckpt-${runId}-${version}` });
      const checkpointId = upsertCheckpoint(db, runId, requestId, version, attempt);
      const control = writeControlState(db, runId, "ACTIVE", null, version, attempt);
      return { command: "CHECKPOINT", status: "COMPLETED", control, failureCode: null };
    },
    async pauseRun(runId, requestId) {
      const db = getDb();
      if (!db) throw Object.assign(new Error("database unavailable"), { code: "RUN_SERVICE_UNAVAILABLE" });
      requireRun(db, runId);
      const current = controlRow(db, runId) ?? { state: "ACTIVE", version: 0 };
      if (current.state === "CLOSED") throw Object.assign(new Error("RUN_CONTROL_TERMINAL"), { code: "RUN_CONTROL_TERMINAL" });
      if (current.state === "PAUSED") throw Object.assign(new Error("RUN_CONTROL_ALREADY_PAUSED"), { code: "RUN_CONTROL_ALREADY_PAUSED" });
      const version = current.version + 1;
      const attempt = version;
      recordCommand(db, runId, requestId, "PAUSE", "COMPLETED", version, { checkpointId: `ckpt-${runId}-${version}` });
      const checkpointId = upsertCheckpoint(db, runId, requestId, version, attempt);
      const control = writeControlState(db, runId, "PAUSED", checkpointId, version, attempt);
      return { command: "PAUSE", status: "COMPLETED", control, failureCode: null };
    },
    async resumeRunControl(runId, requestId) {
      const db = getDb();
      if (!db) throw Object.assign(new Error("database unavailable"), { code: "RUN_SERVICE_UNAVAILABLE" });
      requireRun(db, runId);
      const current = controlRow(db, runId);
      if (!current || current.state !== "PAUSED") throw Object.assign(new Error("RUN_CONTROL_NOT_PAUSED"), { code: "RUN_CONTROL_NOT_PAUSED" });
      const version = current.version + 1;
      const attempt = version;
      recordCommand(db, runId, requestId, "RESUME", "COMPLETED", version, {});
      const control = writeControlState(db, runId, "ACTIVE", null, version, attempt);
      return { command: "RESUME", status: "COMPLETED", control, failureCode: null };
    },
  };
}

function loadRuntime() {
  return {
    async startRun() {}, async runResult() { return {}; }, async resumeRun() {}, async cancelRun() {},
    async inspectRun() { throw new Error("not implemented"); }, async collectResult() { return {}; },
    async collectUsage() { return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, cost: 0 }; }, async healthCheck() { return true; },
  };
}

/**
 * Детерминированный SQLite-фикстур для populated-фазы E2E (plan-27 Task 9).
 * Фиксированные временные метки и ID; данные соответствуют journey-сценариям
 * (run control, timeline cursor paging, approvals, usage UTC-граница, queue).
 */
function seedE2EFixture(db) {
  const T0 = "2026-10-24T06:00:00.000Z";
  const insert = (table, columns, rows) => {
    const colList = columns.join(",");
    for (const row of rows) {
      const placeholders = columns.map((_, i) => `$${i}`).join(",");
      const params = Object.fromEntries(columns.map((c, i) => [String(i), row[i]]));
      db.run(`INSERT OR IGNORE INTO ${table}(${colList}) VALUES(${placeholders})`, params);
    }
  };

  insert("projects", ["id", "name", "display_name", "status", "created_at", "updated_at"], [
    ["proj-1", "ebb-ai-hub", "Ebb AI Hub", "ACTIVE", T0, T0],
    ["proj-2", "xrocket-sdk", "xRocket SDK", "ACTIVE", T0, T0],
    ["proj-3", "ebb-censor-bot", "Ebb Censor Bot", "ACTIVE", T0, T0],
  ]);

  insert("epics", ["id", "project_id", "display_id", "title", "status", "contract_json", "created_at", "updated_at"], [
    ["epic-42", "proj-1", "EPIC-42", "Anthropic Provider", "IN_PROGRESS", "{}", T0, T0],
  ]);

  insert("tasks", ["id", "project_id", "epic_id", "display_id", "title", "status", "contract_json", "required", "created_at", "updated_at"], [
    ["task-421", "proj-1", "epic-42", "TASK-421", "Абстракция провайдера", "INTEGRATED_INTO_EPIC", "{}", 1, T0, T0],
    ["task-422", "proj-1", "epic-42", "TASK-422", "Клиент Anthropic", "INTEGRATED_INTO_EPIC", "{}", 1, T0, T0],
    ["task-423", "proj-1", "epic-42", "TASK-423", "Request mapping", "INTEGRATED_INTO_EPIC", "{}", 1, T0, T0],
    ["task-424", "proj-1", "epic-42", "TASK-424", "Response mapping", "INTEGRATED_INTO_EPIC", "{}", 1, T0, T0],
    ["task-425", "proj-1", "epic-42", "TASK-425", "Streaming", "QA", "{}", 1, T0, T0],
    ["task-426", "proj-1", "epic-42", "TASK-426", "Tool calling", "REVIEW", "{}", 1, T0, T0],
    ["task-427", "proj-1", "epic-42", "TASK-427", "Error normalization", "INTEGRATED_INTO_EPIC", "{}", 1, T0, T0],
    ["task-428", "proj-1", "epic-42", "TASK-428", "Integration tests", "BLOCKED", "{}", 1, T0, T0],
    ["task-429", "proj-1", "epic-42", "TASK-429", "Документация", "READY", "{}", 0, T0, T0],
    ["task-116", "proj-2", null, "TASK-116", "Улучшение повторных попыток", "REVIEW", "{}", 1, T0, T0],
    ["task-508", "proj-3", null, "TASK-508", "Восстановление", "WAITING_FOR_APPROVAL", "{}", 1, T0, T0],
  ]);

  insert("dependencies", ["id", "task_id", "depends_on_task_id", "type", "created_at"], [
    ["dep-1", "task-428", "task-425", "BLOCKING", T0],
    ["dep-2", "task-428", "task-426", "BLOCKING", T0],
  ]);

  insert("agent_runs", ["id", "role", "runtime", "model", "task_id", "epic_id", "status", "session_id", "attempt", "trigger_reason", "started_at", "ended_at", "exit_code", "input_tokens", "cached_input_tokens", "output_tokens", "cost"], [
    ["run-841", "QA", "Hermes", "default", "task-425", null, "IN_PROGRESS", "session-dev-425", 1, "Выполняются сценарии disconnect/reconnect", "2026-10-24T05:41:18.000Z", null, null, 50000, 30000, 12000, 0.78],
    ["run-846", "Reviewer", "Hermes", "default", "task-426", null, "IN_PROGRESS", "session-dev-426", 1, "Review tool calling", "2026-10-24T05:52:57.000Z", null, null, 20000, 8000, 6000, 0.32],
    ["run-852", "QA", "Hermes", "default", "task-116", null, "IN_PROGRESS", "session-dev-116", 1, "Retry handling", "2026-10-24T05:56:39.000Z", null, null, 15000, 5000, 4000, 0.21],
    ["run-821", "Senior Developer", "Hermes", "default", "task-425", null, "COMPLETED", "session-dev-425", 1, "Первоначальная реализация", "2026-10-23T09:00:00.000Z", "2026-10-23T10:45:00.000Z", 0, 120000, 40000, 30000, 1.94],
    ["run-829", "Reviewer", "Hermes", "default", "task-425", null, "COMPLETED", "session-dev-425", 1, "2 замечания", "2026-10-23T11:00:00.000Z", "2026-10-23T12:10:00.000Z", 0, 80000, 20000, 15000, 0.98],
    ["run-834", "Senior Developer", "Hermes", "default", "task-425", null, "COMPLETED", "session-dev-425", 1, "Возобновлена dev-425", "2026-10-23T13:00:00.000Z", "2026-10-23T14:20:00.000Z", 0, 100000, 25000, 18000, 1.41],
  ]);

  insert("run_control_state", ["run_id", "attempt", "state", "checkpoint_id", "version", "updated_at"], [
    ["run-841", 1, "ACTIVE", null, 0, "2026-10-24T05:41:20.000Z"],
    ["run-846", 1, "ACTIVE", null, 0, "2026-10-24T05:52:59.000Z"],
  ]);

  insert("scheduler_reservations", ["id", "kind", "subject_id", "project_id", "owner_id", "reserved_at", "estimate_cost", "status", "actual_cost", "role", "model", "approval_id", "run_id"], [
    ["res-841", "RUN", "run-841", "proj-1", "local-user", "2026-10-24T05:41:20.000Z", 0.78, "RESERVED", null, "QA", "default", null, "run-841"],
    ["res-846", "RUN", "run-846", "proj-1", "local-user", "2026-10-24T05:52:59.000Z", 0.32, "RESERVED", null, "Reviewer", "default", null, "run-846"],
    ["res-852", "RUN", "run-852", "proj-2", "local-user", "2026-10-24T05:56:40.000Z", 0.21, "RESERVED", null, "QA", "default", null, "run-852"],
  ]);

  insert("outbox_events", ["id", "type", "aggregate_type", "aggregate_id", "payload_json", "created_at", "available_at", "attempts", "processed_at"], [
    ["evt-001", "run_started", "AgentRun", "run-841", "{}", "2026-10-24T05:41:18.000Z", "2026-10-24T05:41:18.000Z", 0, null],
    ["evt-002", "tool_used", "AgentRun", "run-841", "{}", "2026-10-24T06:15:08.000Z", "2026-10-24T06:15:08.000Z", 0, null],
    ["evt-003", "file_changed", "AgentRun", "run-841", "{}", "2026-10-24T06:17:54.000Z", "2026-10-24T06:17:54.000Z", 0, null],
    ["evt-004", "test_completed", "AgentRun", "run-841", "{}", "2026-10-24T06:18:12.000Z", "2026-10-24T06:18:12.000Z", 0, null],
    ["evt-005", "permission_requested", "AgentRun", "run-841", "{}", "2026-10-24T06:18:43.000Z", "2026-10-24T06:18:43.000Z", 0, null],
    ["evt-006", "checkpoint_created", "AgentRun", "run-841", "{}", "2026-10-24T06:19:30.000Z", "2026-10-24T06:19:30.000Z", 0, null],
  ]);
  // Дополнительные события для проверки cursor-пагинации в UI (лимит страницы 50).
  const extraEvents = [];
  for (let i = 7; i <= 61; i += 1) {
    const id = `evt-${String(i).padStart(3, "0")}`;
    const createdAt = `2026-10-24T06:19:${String(30 + i).padStart(2, "0")}.000Z`;
    extraEvents.push([id, "tool_used", "AgentRun", "run-841", "{}", createdAt, createdAt, 0, null]);
  }
  insert("outbox_events", ["id", "type", "aggregate_type", "aggregate_id", "payload_json", "created_at", "available_at", "attempts", "processed_at"], extraEvents);

  insert("approvals", ["id", "type", "subject_id", "subject_type", "status", "requested_by", "resolved_by", "resolution_note", "created_at", "resolved_at"], [
    ["appr-1", "WORKFLOW_CHANGE", "epic-42", "EPIC", "PENDING", "Coordinator", null, null, "2026-10-24T05:42:00.000Z", null],
    ["appr-2", "SCOPE_CHANGE", "task-116", "TASK", "PENDING", "DevOps", null, null, "2026-10-24T05:47:00.000Z", null],
    ["appr-3", "FINAL_MERGE", "task-116", "TASK", "PENDING", "Reviewer", null, null, "2026-10-24T05:58:00.000Z", null],
    ["appr-4", "ARCHITECTURE_CHANGE", "epic-42", "EPIC", "APPROVED", "Architect", "local-user", "approved", "2026-10-23T10:00:00.000Z", "2026-10-23T11:00:00.000Z"],
    ["appr-onb-1", "WORKFLOW_CHANGE", "proj-1", "PROJECT", "APPROVED", "Coordinator", "local-user", "onboarding approved", "2026-10-23T08:00:00.000Z", "2026-10-23T09:00:00.000Z"],
  ]);

  insert("onboarding_configs", ["project_id", "repository_path", "facts_json", "proposed_json", "status", "approval_id", "created_at", "updated_at", "activated_at"], [
    ["proj-1", "C:/Repos/ebb-ai-hub", "{}", "{}", "ACTIVE", "appr-onb-1", "2026-10-23T08:00:00.000Z", "2026-10-23T09:00:00.000Z", "2026-10-23T09:00:00.000Z"],
  ]);

  insert("usage_records", ["id", "run_id", "reservation_id", "project_id", "epic_id", "task_id", "role", "model", "trigger_reason", "rework_category", "input_tokens", "cached_tokens", "output_tokens", "total_tokens", "estimated_cost", "runtime", "actual_cost", "created_at"], [
    ["usage-b-1", "run-821", null, "proj-1", "epic-42", "task-425", "Senior Developer", "terra", "Первоначальная разработка", null, 4000, 1000, 1500, 6500, 1.0, "Hermes", 1.0, "2026-10-20T23:59:59.999Z"],
    ["usage-b-2", "run-829", null, "proj-1", "epic-42", "task-425", "Reviewer", "terra", "Review + QA", null, 6000, 2000, 3000, 11000, 2.0, "Hermes", 2.0, "2026-10-21T00:00:00.000Z"],
    ["usage-b-3", "run-834", null, "proj-1", "epic-42", "task-425", "Senior Developer", "terra", "Rework", "rework", 5000, 1500, 2500, 9000, 1.5, "Hermes", 1.5, "2026-10-22T00:00:00.000Z"],
    ["usage-d-1", "run-841", null, "proj-1", "epic-42", "task-425", "QA", "luna", "QA", null, 3000, 1000, 2000, 6000, 0.78, "Hermes", 0.78, "2026-10-24T05:41:18.000Z"],
    ["usage-d-2", "run-846", null, "proj-1", "epic-42", "task-426", "Reviewer", "terra", "Review", null, 2000, 800, 1200, 4000, 0.32, "Hermes", 0.32, "2026-10-24T05:52:57.000Z"],
    ["usage-d-3", "run-852", null, "proj-2", null, "task-116", "QA", "luna", "QA", null, 1500, 500, 800, 2800, 0.21, "Hermes", 0.21, "2026-10-24T05:56:39.000Z"],
  ]);

  insert("budget_configs", ["id", "scope", "scope_id", "limit_cost", "soft_limit_cost", "policy", "spent_cost", "reserved_cost", "created_at", "updated_at"], [
    ["budget-proj-1", "project", "proj-1", 30.0, 20.0, "soft", 18.72, 0.0, T0, T0],
    ["budget-global", "global", "global", 200.0, 150.0, "soft", 128.73, 0.0, T0, T0],
  ]);

  insert("scheduler_run_requests", ["id", "task_id", "idempotency_key", "role", "model", "origin_type", "origin_id", "status", "created_at", "updated_at", "run_id", "failure_code"], [
    ["req-1", "task-424", "e2e-key-1", "developer", "default", "TASK_API", "task-api:task-424", "PENDING", "2026-10-24T05:55:00.000Z", "2026-10-24T05:55:00.000Z", null, null],
    ["req-2", "task-429", "e2e-key-2", "middle-developer", "default", "TASK_API", "task-api:task-429", "PENDING", "2026-10-24T05:56:00.000Z", "2026-10-24T05:56:00.000Z", null, null],
  ]);
}

async function verifyHealth(url) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await globalThis.fetch(url);
      const body = await response.json();
      if (response.status === 200 && body.status === "ok" && body.lifecycle === "READY") return;
    } catch { /* Повторяем проверку до истечения срока готовности. */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error("Backend health did not become READY");
}

async function startBackend() {
  if (backend) throw new Error("Backend is already running");
  mkdirSync(home, { recursive: true });
  const lock = new SingleInstanceLock(lockPath);
  let lockAcquired = false;
  let database;
  let app;
  try {
    await lock.acquire();
    lockAcquired = true;
    const openPath = testMode && testFault === "db-open-once" ? join(home, "missing-db-parent", "ebb-orchestrator.db") : databasePath;
    if (openPath !== databasePath) testFault = undefined;
    database = createSqliteDatabase(openPath);
    activeDb = database;
    runMigrations(database, migrations);
    const passwordHasher = createArgon2PasswordHasher();
    const repository = createAuthRepository(database, passwordHasher, createNodeRandomTokenPort(), createNodeDigestPort());
    const status = new StatusTracker();
    await status.set("READY");
    const approvalService = new ApprovalService(database);
    const onboardingService = new OnboardingService(database, approvalService);
    const providerSettingsRepository = createProviderSettingsRepository(database);
    const providerSecretStore = new InMemorySecretStore(database);
    const providerCredentialStore = createProviderCredentialStore(providerSecretStore, providerSettingsRepository);
    const providerSettingsService = new ProviderSettingsService(providerSettingsRepository, providerCredentialStore, providerSecretStore);
    const providerGateway = new ProviderNetworkGateway();
    const providerCustomModels = createProviderCustomModelsRepository(database);
    app = createApp({ host, port: backendPort, db: database, scheduler: new SchedulerService(database), runtime: loadRuntime(), runService: createHarnessRunService(() => activeDb), authService: createAuthService(repository, passwordHasher, { now: () => new Date().toISOString() }), approvalService, onboardingService, projectConfigService: new ProjectConfigService(database, approvalService), status, providerSettings: { service: providerSettingsService, gateway: providerGateway }, providerModels: { service: providerSettingsService, gateway: providerGateway, customModels: providerCustomModels, credentialStore: providerCredentialStore } });
    await app.listen({ host, port: backendPort });
    backend = { app, database, lock, appClosed: false, databaseClosed: false, lockReleased: false };
    const backendUrl = `http://${host}:${backendPort}`;
    await verifyHealth(`${backendUrl}/api/v1/health`);
    const path = await realpath(databasePath);
    canonicalDatabasePath ??= path;
    if (path !== canonicalDatabasePath) throw new Error("E2E database path changed");
    return { host, port: backendPort, backendUrl, lifecycle: "READY", databasePath: path };
  } catch (error) {
    if (backend?.app === app && app) {
      try {
        await app.close();
        backend.appClosed = true;
      } catch {
        throw error;
      }
    }
    if (database && !backend?.databaseClosed) {
      try { database.close(); } catch { /* Не подменяем исходную ошибку запуска. */ }
    }
    if (lockAcquired && !backend?.lockReleased) {
      try { await lock.release(); } catch { /* Не подменяем исходную ошибку запуска. */ }
    }
    if (backend?.app === app && backend.appClosed) backend = undefined;
    throw error;
  }
}

async function stopBackend() {
  if (!backend) throw Object.assign(new Error("CONTROL_NOT_RUNNING"), { code: "CONTROL_NOT_RUNNING" });
  const current = backend;
  if (!current.appClosed) {
    await current.app.close();
    current.appClosed = true;
  }
  if (!current.databaseClosed) {
    current.database.close();
    current.databaseClosed = true;
  }
  activeDb = null;
  if (!current.lockReleased) {
    await current.lock.release();
    current.lockReleased = true;
  }
  backend = undefined;
  if (existsSync(lockPath)) throw new Error("Backend lock was not released");
  const reopened = createSqliteDatabase(databasePath);
  reopened.close();
  const reopenedPath = await realpath(databasePath);
  if (reopenedPath !== canonicalDatabasePath) throw new Error("E2E database path changed");
  if (existsSync(`${databasePath}-wal`) || existsSync(`${databasePath}-shm`)) throw new Error("SQLite sidecar remains after backend stop");
  return { databasePath: reopenedPath, lockAbsent: true };
}

function createControlServer() {
  controlServer = createServer((socket) => {
    let input = "";
    let handled = false;
    let commandStarted = false;
    const respond = (message) => {
      if (handled) return;
      handled = true;
      clearTimeout(timeout);
      socket.end(`${JSON.stringify(message)}\n`);
    };
    const fail = (code, requestId = "unknown") => respond({ type: "control-error", requestId, code });
    const timeout = setTimeout(() => fail("CONTROL_PROTOCOL_ERROR"), 2_000);
    socket.setEncoding("utf8");
    socket.on("data", async (chunk) => {
      if (handled) return;
      input += chunk;
      if (input.length > 4096) return fail("CONTROL_PROTOCOL_ERROR");
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      if (newline !== input.length - 1) return fail("CONTROL_PROTOCOL_ERROR");
      let request;
      try { request = JSON.parse(input.slice(0, newline)); } catch { return fail("CONTROL_PROTOCOL_ERROR"); }
      const requestId = typeof request?.requestId === "string" ? request.requestId : "unknown";
      if (!request || !["restart", "stop", "start"].includes(request.command) || typeof request.requestId !== "string") return fail("INVALID_COMMAND", requestId);
      if (busy) return fail("CONTROL_BUSY", requestId);
      commandStarted = true;
      busy = true;
      try {
        if (request.command === "stop") {
          const result = await stopBackend();
          respond({ type: "stopped", requestId, ...result });
        } else {
          if (request.command === "restart") await stopBackend();
          if (request.command === "start" && request.port !== undefined) {
            if (!Number.isInteger(request.port) || request.port < 1 || request.port > 65535) return fail("INVALID_PORT", requestId);
            backendPort = request.port;
          }
          if (backend) return fail("CONTROL_BUSY", requestId);
          const result = await startBackend();
          respond({ type: "ready", requestId, ...result, controlEndpoint });
        }
      } catch (error) {
        fail(error?.code === "CONTROL_NOT_RUNNING" ? "CONTROL_NOT_RUNNING" : error?.code === "EADDRINUSE" ? "EADDRINUSE" : "CONTROL_PROTOCOL_ERROR", requestId);
      } finally {
        busy = false;
      }
    });
    socket.on("end", () => { if (!handled && !commandStarted) fail("CONTROL_PROTOCOL_ERROR"); });
    socket.on("error", () => { clearTimeout(timeout); });
  });
  return new Promise((resolvePromise, reject) => {
    controlServer.once("error", reject);
    controlServer.listen(0, host, () => {
      const address = controlServer.address();
      if (!address || typeof address === "string") return reject(new Error("Control listener did not bind TCP"));
      controlEndpoint = `${host}:${address.port}`;
      resolvePromise();
    });
  });
}

function closeControlServer() {
  if (!controlServer?.listening) return Promise.resolve();
  return new Promise((resolvePromise, reject) => {
    controlServer.close((error) => error ? reject(error) : resolvePromise());
  });
}

process.on("message", async (message) => {
  const requestId = typeof message?.requestId === "string" ? message.requestId : "unknown";
  if (message?.type === "shutdown") {
    try {
      if (backend) await stopBackend();
      await closeControlServer();
      const controlListenerClosed = !controlServer?.listening;
      if (!controlListenerClosed) throw new Error("Control listener remained open during shutdown");
      await sendAndWait({ type: "shutdown-complete", requestId, controlListenerClosed });
      process.exit(0);
    } catch (error) {
      send({ type: "shutdown-error", requestId, code: error?.code ?? error?.name ?? "unknown" });
    }
    return;
  }
  if (testMode && message?.type === "e2e-control") {
    try {
      if (message.command === "inject-db-open-failure") testFault = "db-open-once";
      else if (message.command === "inject-close-failure" && backend) {
        const originalClose = backend.app.close;
        let failOnce = true;
        backend.app.close = async (...args) => {
          if (failOnce) {
            failOnce = false;
            throw new Error("Injected app close failure");
          }
          backend.app.close = originalClose;
          return originalClose.apply(backend.app, args);
        };
      }
      else if (message.command === "start" && message.port !== undefined) {
        if (!Number.isInteger(message.port) || message.port < 1 || message.port > 65535) throw Object.assign(new Error("Invalid port"), { code: "INVALID_PORT" });
        backendPort = message.port;
      }
      if (message.command === "inject-db-open-failure" || message.command === "inject-close-failure") {
        send({ type: "test-injected", requestId });
      } else if (message.command === "start") {
        send({ type: "ready", requestId, ...await startBackend() });
      } else if (message.command === "stop") {
        send({ type: "stopped", requestId, ...await stopBackend() });
      } else {
        throw Object.assign(new Error("Invalid test command"), { code: "INVALID_COMMAND" });
      }
    } catch (error) {
      send({ type: "control-error", requestId, code: error?.code === "EADDRINUSE" ? "EADDRINUSE" : "CONTROL_PROTOCOL_ERROR" });
    }
    return;
  }
  if (message?.type !== "seed-password" || typeof message.password !== "string" || seeded) {
    send({ type: "seed-error", requestId, code: "DUPLICATE_SEED" });
    return;
  }
  seeded = true;
  const passwordBytes = Buffer.from(message.password, "utf8");
  message.password = "";
  let seedDatabase;
  try {
    mkdirSync(home, { recursive: true });
    seedDatabase = createSqliteDatabase(databasePath);
    runMigrations(seedDatabase, migrations);
    const passwordHasher = createArgon2PasswordHasher();
    await seedE2ELocalUser({ database: seedDatabase, passwordHasher, password: passwordBytes.toString("utf8"), now: new Date().toISOString() });
    if (process.env.EBB_E2E_SEED_FIXTURE === "1") seedE2EFixture(seedDatabase);
    seedDatabase.close();
    seedDatabase = undefined;
    passwordBytes.fill(0);
    send({ type: "seeded", requestId });
    await createControlServer();
    if (testMode) {
      send({ type: "harness-ready", requestId, controlEndpoint });
      return;
    }
    const ready = await startBackend();
    send({ type: "ready", requestId, ...ready, controlEndpoint });
  } catch (error) {
    send({ type: "seed-error", requestId, code: error?.code === "EADDRINUSE" ? "EADDRINUSE" : "SEED_FAILED", controlEndpoint });
  } finally {
    passwordBytes.fill(0);
    if (seedDatabase) seedDatabase.close();
  }
});

process.on("disconnect", async () => {
  process.stderr.write(`[E2E backend lifecycle] IPC disconnect received; running=${Boolean(backend)}\n`);
  try { if (backend) await stopBackend(); } catch (error) {
    process.stderr.write(`[E2E backend lifecycle] shutdown on disconnect failed; code=${error?.code ?? error?.name ?? "unknown"}\n`);
  }
  process.stderr.write(`[E2E backend lifecycle] closing control listener; listening=${Boolean(controlServer?.listening)}\n`);
  if (controlServer?.listening) controlServer.close();
  process.stderr.write("[E2E backend lifecycle] calling process.exit(0)\n");
  process.exit(0);
});
