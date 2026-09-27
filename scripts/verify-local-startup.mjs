#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PassThrough, Writable } from "node:stream";
import { randomBytes } from "node:crypto";
import { setImmediate as waitForImmediate } from "node:timers/promises";

const repositoryRoot = resolve(import.meta.dirname, "..");
const serverMain = resolve(repositoryRoot, "apps/server/dist/main.js");
const home = await mkdtemp(join(tmpdir(), "ebb-local-startup-"));
const port = 34791;
const password = randomBytes(18).toString("base64url");
let activeServer;

function isolatedEnvironment() {
  const env = {
    ...process.env,
    EBB_ORCHESTRATOR_HOME: home,
    EBB_ORCHESTRATOR_NO_OPEN_UI: "1",
    PORT: String(port),
  };
  delete env.EBB_ORCHESTRATOR_BOOTSTRAP_FILE;
  delete env.EBB_DISABLE_AUTH;
  return env;
}

function spawnServer() {
  const child = spawn(process.execPath, [serverMain], {
    cwd: repositoryRoot,
    env: isolatedEnvironment(),
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return { child, output: () => `${stdout}\n${stderr}` };
}

function waitForExit(child, timeoutMs = 10_000) {
  return new Promise((resolveExit, reject) => {
    let timer;
    let settled = false;
    const onExit = (code, signal) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      child.off("exit", onExit);
      resolveExit({ code, signal });
    };
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    if (exited()) {
      resolveExit({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    timer = globalThis.setTimeout(() => {
      settled = true;
      child.off("exit", onExit);
      reject(new Error("server process did not exit"));
    }, timeoutMs);
    child.once("exit", onExit);
    if (exited()) onExit(child.exitCode, child.signalCode);
  });
}

async function waitForText(server, text, timeoutMs = 20_000) {
  const startedAt = Date.now();
  while (!server.output().includes(text)) {
    if (server.child.exitCode !== null) throw new Error(`server exited before ${text}: ${server.output()}`);
    if (Date.now() - startedAt > timeoutMs) throw new Error(`server did not emit ${text}: ${server.output()}`);
    await waitForImmediate();
  }
}

async function createUserThroughTtyAdapter() {
  const databaseModule = await import(pathToFileURL(resolve(repositoryRoot, "apps/server/dist/platform/database/sqlite-database.js")));
  const migratorModule = await import(pathToFileURL(resolve(repositoryRoot, "apps/server/dist/platform/database/migrator.js")));
  const repositoryModule = await import(pathToFileURL(resolve(repositoryRoot, "apps/server/dist/platform/security/auth-repository.js")));
  const portsModule = await import(pathToFileURL(resolve(repositoryRoot, "apps/server/dist/platform/security/auth-ports.js")));
  const hasherModule = await import(pathToFileURL(resolve(repositoryRoot, "apps/server/dist/platform/security/password-hasher.js")));
  const wizardModule = await import(pathToFileURL(resolve(repositoryRoot, "apps/server/dist/platform/security/local-user-wizard.js")));
  const migrationDirectory = resolve(repositoryRoot, "apps/server/dist/platform/database/migrations");
  const migrationFiles = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
  const migrations = await Promise.all(migrationFiles.map(async (file) => ({
    version: Number(file.slice(0, 3)),
    name: file.slice(4, -4),
    sql: await readFile(join(migrationDirectory, file), "utf8"),
  })));
  const database = databaseModule.createSqliteDatabase(join(home, "ebb-orchestrator.db"));
  try {
    migratorModule.runMigrations(database, migrations);
    const repository = repositoryModule.createAuthRepository(
      database,
      hasherModule.createArgon2PasswordHasher(),
      portsModule.createNodeRandomTokenPort(),
      portsModule.createNodeDigestPort(),
    );
    const input = new PassThrough();
    input.isTTY = true;
    input.setRawMode = () => input;
    const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    output.isTTY = true;
    const pending = wizardModule.runLocalUserWizard(input, output, repository);
    await waitForImmediate();
    input.write(`${password}\r`);
    await waitForImmediate();
    input.write(`${password}\r`);
    assert.equal(await pending, "CREATED");
    assert.equal(await repository.hasLocalUser(), true);
  } finally {
    database.close();
  }
}

try {
  const first = spawnServer();
  first.child.stdin.end();
  const firstExit = await waitForExit(first.child);
  assert.notEqual(firstExit.code, 0, first.output());
  assert.match(first.output(), /interactive TTY/i);
  assert.doesNotMatch(first.output(), /listening|status: READY|worker start/i);
  await assert.rejects(globalThis.fetch(`http://127.0.0.1:${port}/api/v1/health`));

  await createUserThroughTtyAdapter();

  const second = spawnServer();
  activeServer = second;
  await waitForText(second, "status: READY");
  const health = await globalThis.fetch(`http://127.0.0.1:${port}/api/v1/health`);
  assert.equal(health.status, 200);
  const body = await health.json();
  assert.equal(body.status, "ok");
  assert.equal(body.lifecycle, "READY");
  assert.doesNotMatch(second.output(), /Создайте локальный пароль|Повторите локальный пароль/);
  second.child.kill("SIGTERM");
  const secondExit = await waitForExit(second.child);
  assert.ok(secondExit.code === 0 || secondExit.signal === "SIGTERM", second.output());
  assert.equal(existsSync(join(home, "bootstrap.json")), false);
  console.log("local startup verification passed");
} finally {
  if (activeServer?.child.exitCode === null) {
    activeServer.child.kill();
    await waitForExit(activeServer.child, 5_000).catch(() => undefined);
  }
  await new Promise((resolve) => globalThis.setTimeout(resolve, 500));
  await rm(home, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
}
