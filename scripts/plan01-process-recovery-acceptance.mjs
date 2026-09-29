#!/usr/bin/env node
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const entrypoint = resolve(root, "scripts/plan01-process-recovery-server.mjs");
const shutdownMessage = "ebb-plan01-process-recovery:shutdown";

async function reservePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return address.port;
}

function launch(env, bootstrap = false) {
  const child = spawn(process.execPath, [entrypoint, ...(bootstrap ? ["--bootstrap-local-user-stdin"] : [])], {
    cwd: root,
    env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.output = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => { child.output.stdout += chunk; });
  child.stderr.on("data", (chunk) => { child.output.stderr += chunk; });
  return child;
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolveExit, reject) => {
    const onExit = (code, signal) => {
      globalThis.clearTimeout(timer);
      child.off("exit", onExit);
      resolveExit({ code, signal });
    };
    const timer = globalThis.setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error("server process did not exit within the bounded timeout"));
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

async function waitForReady(child, port) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited before READY (${child.exitCode}): ${child.output.stderr}`);
    }
    const response = await globalThis.fetch(`http://127.0.0.1:${port}/api/v1/health`, {
      signal: globalThis.AbortSignal.timeout(500),
    }).catch(() => undefined);
    if (response?.ok) {
      const body = await response.json();
      assert.equal(body.lifecycle, "READY");
      assert.match(child.output.stdout, /status: READY/);
      return;
    }
    await new Promise((resolveWait) => globalThis.setTimeout(resolveWait, 100));
  }
  throw new Error("health endpoint did not reach READY within 60 seconds");
}

async function stopGracefully(child) {
  await new Promise((resolveSend, reject) => {
    child.send(shutdownMessage, (error) => error ? reject(error) : resolveSend());
  });
  const result = await waitForExit(child, 15_000);
  assert.equal(result.code, 0, `server did not stop cleanly: ${JSON.stringify(result)}`);
  assert.match(child.output.stdout, /shutdown complete/);
}

async function stopOwnedChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    await new Promise((resolveSend, reject) => {
      child.send(shutdownMessage, (error) => error ? reject(error) : resolveSend());
    });
    await waitForExit(child, 15_000);
  } catch {
    child.kill("SIGTERM");
    await waitForExit(child, 15_000);
  }
  assert.ok(child.exitCode !== null || child.signalCode !== null, "owned child is still running; preserve its home");
}

function migrationSnapshot(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return db.prepare("SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version").all();
  } finally {
    db.close();
  }
}

function seedPendingState(databasePath) {
  const db = new DatabaseSync(databasePath);
  const now = new Date();
  const future = new Date(now.getTime() + 30 * 60_000).toISOString();
  try {
    db.prepare(`INSERT INTO outbox_events
      (id, type, aggregate_type, aggregate_id, payload_json, created_at, available_at, attempts)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0)`).run(
      "plan01-recovery-event", "AgentRunRequested", "task", "missing-plan01-task", "{}", now.toISOString(), future,
    );
    db.prepare(`INSERT INTO background_jobs
      (id, type, payload_json, priority, status, run_after, attempts, max_attempts, created_at, updated_at)
      VALUES (?, ?, ?, 0, 'RETRY_WAIT', ?, 0, 5, ?, ?)`).run(
      "plan01-retryable-job", "acceptance-retry-probe", "{}", future, now.toISOString(), now.toISOString(),
    );
  } finally {
    db.close();
  }
}

function seedExpiredLease(databasePath) {
  const db = new DatabaseSync(databasePath);
  const now = new Date();
  const future = new Date(now.getTime() + 30 * 60_000).toISOString();
  const expired = new Date(now.getTime() - 60_000).toISOString();
  try {
    db.prepare(`INSERT INTO background_jobs
      (id, type, payload_json, priority, status, run_after, attempts, max_attempts,
       lease_owner, lease_expires_at, created_at, updated_at)
      VALUES (?, ?, ?, 0, 'RUNNING', ?, 0, 5, ?, ?, ?, ?)`).run(
      "plan01-expired-job", "acceptance-recovery-probe", "{}", future,
      "interrupted-process", expired, now.toISOString(), now.toISOString(),
    );
  } finally {
    db.close();
  }
}

function inspectRecovery(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const event = db.prepare("SELECT attempts, processed_at, available_at FROM outbox_events WHERE id = ?")
      .get("plan01-recovery-event");
    const retryableJob = db.prepare(`SELECT status, attempts, lease_owner, lease_expires_at, run_after
      FROM background_jobs WHERE id = ?`).get("plan01-retryable-job");
    const job = db.prepare(`SELECT status, attempts, lease_owner, lease_expires_at, run_after
      FROM background_jobs WHERE id = ?`).get("plan01-expired-job");
    return { event, retryableJob, job };
  } finally {
    db.close();
  }
}

async function waitForOutboxRetry(databasePath) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { event } = inspectRecovery(databasePath);
    if (event?.attempts > 0 && event.processed_at === null) return event;
    await new Promise((resolveWait) => globalThis.setTimeout(resolveWait, 100));
  }
  throw new Error("pending outbox event was not retried after becoming available");
}

async function runAcceptance() {
  const home = await mkdtemp(join(tmpdir(), "ebb-plan01-recovery-"));
  const port = await reservePort();
  const env = { ...process.env, EBB_ORCHESTRATOR_HOME: home, PORT: String(port) };
  let child;
  let passwordBytes;
  let passwordPayload;
  try {
    child = launch(env, true);
    const password = randomBytes(32).toString("base64url");
    passwordBytes = Buffer.from(password, "utf8");
    passwordPayload = Buffer.from(`${password}\n${password}\n`, "utf8");
    child.stdin.end(passwordPayload);
    passwordPayload.fill(0);
    await waitForReady(child, port);
    const { resolveOrchestratorHome } = await import(pathToFileURL(resolve(root, "apps/server/dist/platform/home/orchestrator-home.js")));
    const databasePath = resolveOrchestratorHome(env, process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux").database;
    const beforeRestartMigrations = migrationSnapshot(databasePath);
    assert.ok(beforeRestartMigrations.length > 0, "production startup did not apply migrations");

    seedPendingState(databasePath);

    const competing = launch(env);
    const competingExit = await waitForExit(competing, 10_000);
    assert.equal(competingExit.code, 1, "second production process was not rejected");
    assert.match(competing.output.stderr, /Could not acquire the startup lock/);

    await stopGracefully(child);
    child = undefined;

    seedExpiredLease(databasePath);
    child = launch(env);
    await waitForReady(child, port);
    assert.deepEqual(migrationSnapshot(databasePath), beforeRestartMigrations, "restart changed already-applied migrations");

    const afterRestart = inspectRecovery(databasePath);
    assert.equal(afterRestart.event.processed_at, null, "pending event was lost during restart");
    assert.ok(Date.parse(afterRestart.event.available_at) > Date.now(), "event should remain durably available for a later delivery attempt");
    assert.equal(afterRestart.retryableJob.status, "RETRY_WAIT", "existing retryable job was not durable across restart");
    assert.equal(afterRestart.retryableJob.lease_owner, null);
    assert.equal(afterRestart.retryableJob.lease_expires_at, null);
    assert.equal(afterRestart.job.status, "RETRY_WAIT", "expired job lease was not recovered");
    assert.equal(afterRestart.job.attempts, 1);
    assert.equal(afterRestart.job.lease_owner, null);
    assert.equal(afterRestart.job.lease_expires_at, null);
    assert.ok(Date.parse(afterRestart.job.run_after) > Date.now(), "recovered job must follow its retry backoff");

    const db = new DatabaseSync(databasePath);
    try {
      db.prepare("UPDATE outbox_events SET available_at = ? WHERE id = ?")
        .run(new Date(Date.now() - 1_000).toISOString(), "plan01-recovery-event");
    } finally {
      db.close();
    }
    const retriedEvent = await waitForOutboxRetry(databasePath);
    assert.equal(retriedEvent.processed_at, null, "failed consumer must leave event pending");

    console.log("PLAN01_PROCESS_RECOVERY_ACCEPTANCE=PASS");
    console.log("Verified: migrations unchanged, pending event retried, expired job lease recovered, READY after restart, second instance rejected.");
    await stopGracefully(child);
    child = undefined;
  } finally {
    passwordBytes?.fill(0);
    passwordPayload?.fill(0);
    await stopOwnedChild(child);
    await rm(home, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runAcceptance().catch((error) => {
    console.error("PLAN01_PROCESS_RECOVERY_ACCEPTANCE=FAIL");
    console.error(error instanceof Error ? error.message : "unknown failure");
    process.exitCode = 1;
  });
}
