#!/usr/bin/env node
import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, access, stat } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve, relative, sep, win32, posix } from "node:path";
import { finished } from "node:stream/promises";
import { pathToFileURL } from "node:url";

const repositoryRoot = resolve(import.meta.dirname, "..");
const smokeServerEntrypoint = resolve(repositoryRoot, "scripts/local-user-stdin-smoke-server.mjs");
const SMOKE_SHUTDOWN_MESSAGE = "ebb-local-user-stdin-smoke:shutdown";

/** Возвращает точный дочерний argv, где секрет передаётся отдельно только через stdin. */
export function buildBootstrapArgs(entrypoint = smokeServerEntrypoint) {
  return [entrypoint, "--bootstrap-local-user-stdin"];
}

/** Создаёт непредсказуемый пароль только в памяти и его framing для stdin. */
export function createSmokeSecret() {
  const secret = randomBytes(32).toString("base64url");
  return { secret, payload: Buffer.from(`${secret}\n${secret}\n`, "utf8") };
}

export function assertSecretAbsent(secret, surfaces) {
  const encoded = String(secret);
  for (const [name, values] of Object.entries(surfaces)) {
    for (const value of values ?? []) {
      const text = Buffer.isBuffer(value) || value instanceof Uint8Array ? Buffer.from(value).toString("utf8") : String(value);
      assert.equal(text.includes(encoded), false, `secret appeared in ${name}`);
    }
  }
}

export function assertOutputMatches(output, pattern, label) {
  assert.equal(pattern.test(output), true, `expected ${label}`);
}

/** Завершает stdin, дожидается обработки данных и обнуляет буфер payload. */
export async function endInput(stream, payload) {
  const completion = finished(stream, { cleanup: true, readable: false });
  try {
    stream.end(payload);
    await completion;
  } finally {
    payload.fill(0);
  }
}

/** Запрашивает штатное завершение тестового server child через его приватный IPC-канал. */
export function requestSmokeShutdown(child) {
  if (!child.connected || typeof child.send !== "function") {
    return Promise.reject(new Error("smoke child has no connected IPC channel"));
  }
  return new Promise((resolveRequest, rejectRequest) => {
    child.send(SMOKE_SHUTDOWN_MESSAGE, (error) => {
      if (error) rejectRequest(error);
      else resolveRequest();
    });
  });
}

export function assertRuntimePaths(home, paths) {
  const root = resolve(home);
  for (const [name, candidate] of Object.entries(paths)) {
    const fromRoot = (process.platform === "win32" ? win32 : posix).relative(root, (process.platform === "win32" ? win32 : posix).resolve(candidate));
    assert.ok(fromRoot && fromRoot !== ".." && !fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : sep}`), `${name} escaped disposable home: ${candidate}`);
  }
}

export async function cleanupOwnedChild(child, removeHome, timeoutMs = 5_000) {
  if (child && child.exitCode === null && child.signalCode === null) {
    const graceful = waitForExit(child, timeoutMs).catch(() => undefined);
    if (child.connected) {
      await Promise.race([
        requestSmokeShutdown(child).catch(() => child.kill(process.platform === "win32" ? "SIGTERM" : "SIGINT")),
        graceful,
      ]);
    } else {
      child.kill(process.platform === "win32" ? "SIGTERM" : "SIGINT");
    }
    await graceful;
    if (child.exitCode === null && child.signalCode === null) {
      const forced = waitForExit(child, timeoutMs);
      child.kill("SIGKILL");
      await forced;
    }
    assert.ok(child.exitCode !== null || child.signalCode !== null, "owned server process did not stop; preserving disposable home");
  }
  await removeHome();
}

export function waitForExit(child, timeoutMs) {
  return new Promise((resolveExit, reject) => {
    const onExit = (code, signal) => {
      globalThis.clearTimeout(timer);
      child.off("exit", onExit);
      resolveExit({ code, signal });
    };
    const timer = globalThis.setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error("server did not exit within the bounded timeout"));
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

async function scanFiles(directory) {
  const matches = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) matches.push(...await scanFiles(path));
    else if (entry.isFile()) matches.push({ path, bytes: await readFile(path) });
  }
  return matches;
}

async function runSmoke() {
  const home = await mkdtemp(join(tmpdir(), "ebb-local-user-stdin-"));
  let secret;
  let payload;
  let secretBytes;
  let child;
  let stdout = "";
  let stderr = "";
  try {
    const defaultEbbOrchestratorHome = join(homedir(), ".ebb-orchestrator");
    const defaultEbbOrchestratorHomeExistedBefore = await access(defaultEbbOrchestratorHome).then(() => true, () => false);
    const port = String(3000 + randomBytes(2).readUInt16BE() % 30000);
    const env = { ...process.env, EBB_ORCHESTRATOR_HOME: home, PORT: port };
    const { resolveOrchestratorHome } = await import(pathToFileURL(resolve(repositoryRoot, "apps/server/dist/platform/home/orchestrator-home.js")));
    const homePaths = resolveOrchestratorHome(env, process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux");
    assert.equal(homePaths.root, home);
    const runtimePaths = {
      database: homePaths.database,
      checkpoints: join(homePaths.runtime, "checkpoints"),
      artifacts: homePaths.artifacts,
      hermesResults: join(homePaths.runtime, "hermes", "results"),
    };
    assertRuntimePaths(home, runtimePaths);
    const generated = createSmokeSecret();
    secret = generated.secret;
    payload = generated.payload;
    secretBytes = Buffer.from(secret, "utf8");
    const args = buildBootstrapArgs();

    assert.equal(args.includes(secret), false);
    assert.equal(Object.values(env).includes(secret), false);
    child = spawn(process.execPath, args, {
      cwd: repositoryRoot,
      env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const childArgv = [process.execPath, ...args];
    assert.equal(childArgv.some((argument) => argument.includes(secret)), false);
    assert.equal(Object.values(env).some((value) => value.includes?.(secret)), false);

    await endInput(child.stdin, payload);
    const healthDeadline = Date.now() + 60_000;
    let health;
    while (Date.now() < healthDeadline) {
      if (child.exitCode !== null) throw new Error(`server exited before READY (${child.exitCode})`);
      health = await globalThis.fetch(`http://127.0.0.1:${port}/api/v1/health`, { signal: globalThis.AbortSignal.timeout(500) }).catch(() => undefined);
      if (health?.ok) break;
      await new Promise((resolveWait) => globalThis.setTimeout(resolveWait, 200));
    }
    assert.ok(health?.ok, "health endpoint did not become ready");
    const healthBody = await health.json();
    assert.equal(healthBody.status, "ok");
    assert.equal(healthBody.lifecycle, "READY");
    assertOutputMatches(stdout, /status: READY/, "READY status in child stdout");

    const databasePath = homePaths.database;
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const auth = db.prepare("SELECT password_hash, hash_algorithm FROM local_users WHERE id = 1").get();
      assert.equal(auth?.hash_algorithm, "argon2id");
      assert.match(auth?.password_hash, /^\$argon2id\$v=19\$/);
    } finally {
      db.close();
    }
    const files = await scanFiles(home);
    assert.ok((await stat(homePaths.artifacts)).isDirectory(), "artifact directory was not created under disposable home");
    assert.ok(files.some(({ path }) => path === databasePath), "disposable database was not created");
    for (const { bytes } of files) assert.equal(bytes.includes(secretBytes), false, "raw secret appeared in a disposable file");
    assert.equal(`${stdout}\n${stderr}`.includes(secret), false, "secret appeared in captured output");
    assert.equal(child.spawnargs.some((argument) => argument.includes(secret)), false, "secret appeared in child argv");

    await requestSmokeShutdown(child);
    const stopped = await waitForExit(child, 10_000);
    assert.equal(stopped.code, 0, "server did not shut down cleanly");
    assertOutputMatches(`${stdout}\n${stderr}`, /shutdown complete/, "shutdown completion in child output");
    const filesAfterShutdown = await scanFiles(home);
    for (const { bytes } of filesAfterShutdown) assert.equal(bytes.includes(secretBytes), false, "raw secret appeared in a shutdown log or file");
    assertSecretAbsent(secret, { stdout: [stdout], stderr: [stderr] });
    assert.equal(await access(defaultEbbOrchestratorHome).then(() => true, () => false), defaultEbbOrchestratorHomeExistedBefore, "default ~/.ebb-orchestrator existence changed");
    console.log("local-user stdin bootstrap smoke passed");
  } finally {
    secretBytes?.fill(0);
    payload?.fill(0);
    await cleanupOwnedChild(child, () => rm(home, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await runSmoke();
