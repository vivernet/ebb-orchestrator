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
const host = "127.0.0.1";
let canonicalDatabasePath;
let seeded = false;
let busy = false;
let backend;
let controlServer;
let controlEndpoint;
const testMode = process.env.EBB_E2E_TEST_MODE === "1";
let testFault;

function send(message) {
  if (typeof process.send === "function" && process.connected) process.send(message);
}

function loadRuntime() {
  return {
    async startRun() {}, async runResult() { return {}; }, async resumeRun() {}, async cancelRun() {},
    async inspectRun() { throw new Error("not implemented"); }, async collectResult() { return {}; },
    async collectUsage() { return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, cost: 0 }; }, async healthCheck() { return true; },
  };
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
    runMigrations(database, migrations);
    const passwordHasher = createArgon2PasswordHasher();
    const repository = createAuthRepository(database, passwordHasher, createNodeRandomTokenPort(), createNodeDigestPort());
    const status = new StatusTracker();
    await status.set("READY");
    const approvalService = new ApprovalService(database);
    const onboardingService = new OnboardingService(database, approvalService);
    app = createApp({ host, port: backendPort, db: database, scheduler: new SchedulerService(database), runtime: loadRuntime(), authService: createAuthService(repository, passwordHasher, { now: () => new Date().toISOString() }), approvalService, onboardingService, status });
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

process.on("message", async (message) => {
  const requestId = typeof message?.requestId === "string" ? message.requestId : "unknown";
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
