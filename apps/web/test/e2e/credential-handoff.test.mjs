import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { clearTimeout, setTimeout } from "node:timers";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { waitForChildExit } from "./child-lifecycle.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const webRoot = join(repoRoot, "apps/web");
const serverRoot = join(repoRoot, "apps/server");
const ownedLaunchFiles = [
  "apps/server/src/main.ts",
  "apps/web/vite.config.ts",
  "apps/web/playwright.config.ts",
  "apps/web/test/e2e/run-e2e.mjs",
  "apps/web/test/e2e/web-e2e-server.mjs",
  "apps/web/test/e2e/v1-ui.spec.ts",
  "scripts/run-server.js",
  "start.bat",
];

async function source(path) {
  return readFile(join(repoRoot, path), "utf8");
}

async function filesUnder(root, suffixes = [".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"]) {
  const found = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (suffixes.some((suffix) => entry.name.endsWith(suffix))) found.push(path);
    }
  }
  await visit(root);
  return found;
}

function sourceRelative(path) {
  return relative(repoRoot, path).replaceAll("\\", "/");
}

test("launcher and application sources contain no bootstrap credential path", async () => {
  for (const path of ownedLaunchFiles) {
    const text = await source(path);
    for (const marker of ["EBB_ORCHESTRATOR_BOOTSTRAP_FILE", "#ebb-bootstrap", "bootstrap.json", "--bootstrap-file", "/session/bootstrap", "/session/new?local=true"]) {
      assert.equal(text.includes(marker), false, `${path} retains forbidden marker ${marker}`);
    }
    assert.doesNotMatch(text, /127\.0\.0\.1:(?:3001|4173)/, `${path} retains a fixed E2E origin`);
  }
  const dist = join(serverRoot, "dist");
  try {
    for (const path of await filesUnder(dist)) {
      const text = await readFile(path, "utf8");
      for (const marker of ["EBB_ORCHESTRATOR_BOOTSTRAP_FILE", "#ebb-bootstrap", "bootstrap.json", "--bootstrap-file", "/session/bootstrap", "/session/new?local=true"]) {
        assert.equal(text.includes(marker), false, `${sourceRelative(path)} retains forbidden marker ${marker}`);
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const main = await source("apps/server/src/main.ts");
  assert.doesNotMatch(main, /from\s+["'][^"']*apps\/server\/test/);
  assert.doesNotMatch(main, /auth-fixture|seedE2ELocalUser/);
});

test("harness uses launcher-validated dynamic loopback origins", async () => {
  const vite = await source("apps/web/vite.config.ts");
  const playwright = await source("apps/web/playwright.config.ts");
  const launcher = await source("apps/web/test/e2e/run-e2e.mjs");
  assert.match(vite, /EBB_E2E_BACKEND_URL/);
  assert.match(vite, /127\.0\.0\.1/);
  assert.match(playwright, /EBB_E2E_BASE_URL/);
  assert.match(playwright, /webServer:\s*undefined/);
  assert.doesNotMatch(playwright, /web-e2e-server|vite --mode|port\s*:\s*\d{4,5}/);
  assert.match(launcher, /allocateLoopbackPort/);
  assert.match(launcher, /frontendPort/);
  assert.match(launcher, /backendPort/);
  assert.match(launcher, /EBB_E2E_BASE_URL/);
  assert.match(launcher, /EBB_E2E_BACKEND_URL/);
});

test("production source and built output exclude test-only seed fixture references", async () => {
  const candidates = [join(serverRoot, "src"), join(serverRoot, "dist")];
  for (const directory of candidates) {
    try {
      const entries = await filesUnder(directory);
      for (const path of entries) {
        const text = await readFile(path, "utf8");
        assert.doesNotMatch(text, /apps\/server\/test|auth-fixture\.mjs|seedE2ELocalUser/, sourceRelative(path));
        assert.doesNotMatch(text, /readE2EPasswordFromStdin|E2E_TEST_PASSWORD|process\.env(?:\.[A-Za-z_$][\w$]*|\[[^\]]+\])\s*(?:\?\.)?\s*(?:password|passwd|token|secret|credential)/i, sourceRelative(path));
        assert.doesNotMatch(text, /(?:console\.(?:log|info|warn|error)|process\.(?:stdout|stderr)\.write)[^\n]*(?:password|secret|credential)/i, sourceRelative(path));
      }
    } catch (error) {
      if (error?.code !== "ENOENT" || directory.endsWith("src")) throw error;
    }
  }
  const packageJson = JSON.parse(await source("apps/server/package.json"));
  assert.equal(packageJson.type, "module");
  const tsconfig = JSON.parse(await source("apps/server/tsconfig.build.json"));
  assert.ok(tsconfig.exclude?.some((path) => path.includes("test")));
  assert.equal(await readFile(join(serverRoot, "test/e2e/fixtures/auth-fixture.mjs"), "utf8").then((text) => text.includes("seedE2ELocalUser")), true);
});

test("password channel delivers independent transient buffers and closes cleanly", async () => {
  const { createE2EPasswordChannel, readE2EPasswordFromChannel } = await import(pathToFileURL(join(webRoot, "test/e2e/credential-channel.mjs")));
  const password = Buffer.from("synthetic-e2e-regression-value", "utf8");
  const channel = await createE2EPasswordChannel(password);
  try {
    assert.deepEqual(Object.keys(channel).sort(), ["channelId", "dispose", "endpoint", "host", "port"]);
    assert.equal(channel.host, "127.0.0.1");
    assert.match(channel.endpoint, /^127\.0\.0\.1:[1-9]\d{0,4}\/[0-9a-f]{32}$/);
    const copies = await Promise.all(Array.from({ length: 8 }, () => readE2EPasswordFromChannel(channel.endpoint)));
    assert.equal(copies.length, 8);
    for (const copy of copies) {
      assert.notEqual(copy, password);
      assert.deepEqual(copy, password);
      copy.fill(0);
    }
  } finally {
    await channel.dispose();
    await channel.dispose();
  }
  password.fill(0);
  assert.ok(password.every((byte) => byte === 0));
  await assert.rejects(readE2EPasswordFromChannel(channel.endpoint), { code: "CHANNEL_UNAVAILABLE" });
});

test("password channel rejects malformed, missing, timed-out, and incomplete reads", async () => {
  const { readE2EPasswordFromChannel } = await import(pathToFileURL(join(webRoot, "test/e2e/credential-channel.mjs")));
  await assert.rejects(readE2EPasswordFromChannel(), { code: "MISSING_ENDPOINT" });
  await assert.rejects(readE2EPasswordFromChannel("localhost:10/abcdef"), { code: "MALFORMED_ENDPOINT" });

  let stalledSocket;
  const stalled = createServer((socket) => { stalledSocket = socket; });
  await new Promise((resolvePromise) => stalled.listen(0, "127.0.0.1", resolvePromise));
  const address = stalled.address();
  assert.ok(address && typeof address === "object");
  const endpoint = `127.0.0.1:${address.port}/${"a".repeat(32)}`;
  try {
    await assert.rejects(readE2EPasswordFromChannel(endpoint), { code: "TIMEOUT" });
  } finally {
    stalledSocket?.destroy();
    await new Promise((resolvePromise, reject) => stalled.close((error) => error ? reject(error) : resolvePromise()));
  }

  let eofSocket;
  const eof = createServer((socket) => { eofSocket = socket; socket.end(); });
  await new Promise((resolvePromise) => eof.listen(0, "127.0.0.1", resolvePromise));
  const eofAddress = eof.address();
  assert.ok(eofAddress && typeof eofAddress === "object");
  try {
    await assert.rejects(readE2EPasswordFromChannel(`127.0.0.1:${eofAddress.port}/${"b".repeat(32)}`), { code: "EOF" });
  } finally {
    eofSocket?.destroy();
    await new Promise((resolvePromise, reject) => eof.close((error) => error ? reject(error) : resolvePromise()));
  }
});

test("password channel rejects a second request on one connection", async () => {
  const { createE2EPasswordChannel } = await import(pathToFileURL(join(webRoot, "test/e2e/credential-channel.mjs")));
  const password = Buffer.from("another-synthetic-regression-value", "utf8");
  const channel = await createE2EPasswordChannel(password);
  const net = await import("node:net");
  const client = net.connect({ host: channel.host, port: channel.port });
  try {
    const response = new Promise((resolvePromise, reject) => {
      const chunks = [];
      client.on("data", (chunk) => chunks.push(chunk));
      client.once("error", reject);
      client.once("end", () => resolvePromise(Buffer.concat(chunks)));
    });
    await new Promise((resolvePromise, reject) => {
      client.once("connect", resolvePromise);
      client.once("error", reject);
    });
    client.end(`${channel.channelId}\n${channel.channelId}\n`, "ascii");
    const frame = await response;
    assert.equal(frame.readUInt8(0), 1);
    assert.equal(frame.subarray(5).toString("ascii"), "DUPLICATE_REQUEST");
  } finally {
    client.destroy();
    await channel.dispose();
    password.fill(0);
  }
});

test("password channel disposal closes held sockets and rejects subsequent reads", async () => {
  const { createE2EPasswordChannel, readE2EPasswordFromChannel } = await import(pathToFileURL(join(webRoot, "test/e2e/credential-channel.mjs")));
  const password = Buffer.from("held-socket-regression", "utf8");
  const channel = await createE2EPasswordChannel(password);
  const net = await import("node:net");
  const client = net.connect({ host: channel.host, port: channel.port });
  await new Promise((resolvePromise, reject) => {
    client.once("connect", resolvePromise);
    client.once("error", reject);
  });
  const closed = new Promise((resolvePromise) => client.once("close", resolvePromise));
  await channel.dispose();
  await channel.dispose();
  await closed;
  await assert.rejects(readE2EPasswordFromChannel(channel.endpoint), { code: "CHANNEL_UNAVAILABLE" });
  client.destroy();
  password.fill(0);
});

test("password channel client rejects invalid response frames", async () => {
  const { readE2EPasswordFromChannel } = await import(pathToFileURL(join(webRoot, "test/e2e/credential-channel.mjs")));
  let invalidSocket;
  const invalid = createServer((socket) => {
    invalidSocket = socket;
    socket.end(Buffer.from([2, 0, 0, 0, 0]));
  });
  await new Promise((resolvePromise) => invalid.listen(0, "127.0.0.1", resolvePromise));
  const address = invalid.address();
  assert.ok(address && typeof address === "object");
  try {
    await assert.rejects(readE2EPasswordFromChannel(`127.0.0.1:${address.port}/${"c".repeat(32)}`), { code: "INVALID_RESPONSE" });
  } finally {
    invalidSocket?.destroy();
    await new Promise((resolvePromise, reject) => invalid.close((error) => error ? reject(error) : resolvePromise()));
  }
});

test("seed fixture creates one real local user and rejects duplicate seeding", async () => {
  const { seedE2ELocalUser } = await import(pathToFileURL(join(serverRoot, "test/e2e/fixtures/auth-fixture.mjs")));
  const { createSqliteDatabase } = await import(pathToFileURL(join(serverRoot, "dist/platform/database/sqlite-database.js")));
  const { runMigrations } = await import(pathToFileURL(join(serverRoot, "dist/platform/database/migrator.js")));
  const { createAuthRepository } = await import(pathToFileURL(join(serverRoot, "dist/platform/security/auth-repository.js")));
  const { createNodeDigestPort, createNodeRandomTokenPort } = await import(pathToFileURL(join(serverRoot, "dist/platform/security/auth-ports.js")));
  const { createArgon2PasswordHasher } = await import(pathToFileURL(join(serverRoot, "dist/platform/security/password-hasher.js")));
  const migrationsDirectory = join(serverRoot, "dist/platform/database/migrations");
  const migrations = (await readdir(migrationsDirectory)).filter((file) => file.endsWith(".sql")).map((file) => ({
    version: Number(/^(\d+)_/.exec(file)?.[1]), name: /^(\d+)_([^.]*)\.sql$/.exec(file)?.[2], sql: "",
  }));
  for (const migration of migrations) migration.sql = await readFile(join(migrationsDirectory, `${String(migration.version).padStart(3, "0")}_${migration.name}.sql`), "utf8");
  const home = await mkdtemp(join(tmpdir(), "ebb-seed-regression-"));
  const database = createSqliteDatabase(join(home, "ebb-orchestrator.db"));
  try {
    runMigrations(database, migrations);
    const passwordHasher = createArgon2PasswordHasher();
    const repository = createAuthRepository(database, passwordHasher, createNodeRandomTokenPort(), createNodeDigestPort());
    const seedPassword = "synthetic-seed-regression-value";
    await seedE2ELocalUser({ database, passwordHasher, password: seedPassword, now: "2026-09-26T00:00:00.000Z" });
    assert.equal(await repository.hasLocalUser(), true);
    assert.equal(database.get("SELECT COUNT(*) AS count FROM auth_sessions").count, 0);
    await assert.rejects(seedE2ELocalUser({ database, passwordHasher, password: "unused-regression-value", now: "2026-09-26T00:00:00.000Z" }), { code: "DUPLICATE_SEED" });
    assert.equal(database.get("SELECT COUNT(*) AS count FROM local_users").count, 1);
    assert.equal(database.get("SELECT COUNT(*) AS count FROM auth_sessions").count, 0);
  } finally {
    database.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("production and E2E paths exclude secret-bearing environment, argv, stdin, files, and logs", async () => {
  const paths = [
    "apps/server/src/main.ts",
    "apps/server/test/e2e/fixtures/auth-fixture.mjs",
    "apps/web/vite.config.ts",
    "apps/web/playwright.config.ts",
    "apps/web/test/e2e/run-e2e.mjs",
    "apps/web/test/e2e/web-e2e-server.mjs",
    "apps/web/test/e2e/credential-channel.mjs",
    "apps/web/test/e2e/fixtures.ts",
    "apps/web/test/e2e/v1-ui.spec.ts",
  ];
  for (const path of paths) {
    const text = await source(path);
    assert.doesNotMatch(text, /EBB_DISABLE_AUTH|E2E_TEST_PASSWORD|readE2EPasswordFromStdin/);
    if (path !== "apps/server/src/main.ts") assert.doesNotMatch(text, /process\.stdin|stdin\.write/);
    assert.doesNotMatch(text, /process\.argv[^\n]*(?:password|secret|credential)|(?:password|secret|credential)[^\n]*process\.argv/i);
    assert.doesNotMatch(text, /(?:writeFile|writeFileSync|appendFile|createWriteStream)[^\n]*(?:password|credential|secret)/i);
    assert.doesNotMatch(text, /(?:console\.(?:log|info|warn|error)|process\.(?:stdout|stderr)\.write)[^\n]*(?:password|e2ePassword|secret)/i);
  }
  const launcher = await source("apps/web/test/e2e/run-e2e.mjs");
  const fixtures = await source("apps/web/test/e2e/fixtures.ts");
  const spec = await source("apps/web/test/e2e/v1-ui.spec.ts");
  assert.match(launcher, /passwordChannel\.endpoint/);
  assert.match(fixtures, /process\.env\.EBB_E2E_PASSWORD_CHANNEL/);
  assert.match(fixtures, /import\s*\{\s*test\s+as\s+base\s*\}\s*from\s*["']@playwright\/test["']/);
  assert.match(spec, /data:\s*\{\s*password:\s*e2ePassword\.toString\('utf8'\)\s*\}/);
});

test("launcher teardown is failure-visible and removes only its isolated home", async () => {
  const launcher = await source("apps/web/test/e2e/run-e2e.mjs");
  const server = await source("apps/web/test/e2e/web-e2e-server.mjs");
  const spec = await source("apps/web/test/e2e/v1-ui.spec.ts");
  assert.match(launcher, /mkdtemp/);
  assert.match(launcher, /EBB_ORCHESTRATOR_HOME/);
  assert.match(launcher, /\.finally|finally\s*\{/);
  assert.match(launcher, /password\.fill\(0\)/);
  assert.match(launcher, /passwordChannel\.dispose\(\)/);
  assert.match(launcher, /controlChannel\.dispose\(\)/);
  assert.match(launcher, /rm\(e2eHome/);
  assert.match(server, /restart/);
  assert.match(server, /realpath/);
  assert.match(server, /async function stopBackend\(\)/);
  assert.match(spec, /restartE2EBackend/);
  assert.match(spec, /stop/);
  assert.match(spec, /start/);
});

function listenLoopback(server) {
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise(server.address().port));
  });
}

async function freeLoopbackPort() {
  const server = createServer();
  const port = await listenLoopback(server);
  await closeListener(server);
  return port;
}

async function closeListener(server) {
  if (!server?.listening) return;
  await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
}

async function startRuntimeHarness({ port, testMode = false }) {
  const home = await mkdtemp(join(tmpdir(), "ebb-runtime-failure-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:password|passwd|token|secret|credential)/i.test(key)));
  const child = spawn(process.execPath, [join(webRoot, "test/e2e/web-e2e-server.mjs"), String(port)], {
    cwd: repoRoot,
    env: { ...env, EBB_ORCHESTRATOR_HOME: home, ...(testMode ? { EBB_E2E_TEST_MODE: "1" } : {}) },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
  });
  const messages = [];
  const waiters = [];
  child.on("message", (message) => {
    messages.push(message);
    const index = waiters.findIndex((waiter) => waiter.matches(message));
    if (index >= 0) waiters.splice(index, 1)[0].resolve(message);
  });
  child.on("error", (error) => { for (const waiter of waiters.splice(0)) waiter.reject(error); });
  const waitFor = (matches, timeoutMs = 5_000) => {
    const predicate = typeof matches === "string" ? (message) => message.type === matches || message.type === "seed-error" : matches;
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.findIndex((waiter) => waiter.resolve === wrappedResolve);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error("Timed out awaiting E2E server response"));
      }, timeoutMs);
      const wrappedResolve = (message) => { clearTimeout(timer); resolvePromise(message); };
      waiters.push({ matches: predicate, resolve: wrappedResolve, reject });
    });
  };
  const request = async (command, options = {}) => {
    const requestId = randomUUID();
    const response = waitFor((message) => message.requestId === requestId);
    child.send({ type: "e2e-control", command, requestId, ...options });
    return response;
  };
  const seedPassword = Buffer.from(randomBytes(24).toString("base64url"));
  const seeded = waitFor((message) => ["harness-ready", "ready", "seed-error"].includes(message.type));
  child.send({ type: "seed-password", requestId: randomUUID(), password: seedPassword.toString("utf8") });
  seedPassword.fill(0);
  const ready = await seeded;
  if (ready.type === "seed-error") {
    child.disconnect();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await rm(home, { recursive: true, force: true });
    throw new Error(`E2E runtime fixture bootstrap failed: ${ready.code}`);
  }
  return {
    child, home, ready, request, waitFor,
    async dispose() {
      if (child.connected) child.disconnect();
      if (child.exitCode === null && child.signalCode === null) {
        await Promise.race([
          new Promise((resolvePromise) => child.once("close", resolvePromise)),
          new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000)),
        ]);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
          await new Promise((resolvePromise) => child.once("close", resolvePromise));
        }
      }
      await rm(home, { recursive: true, force: true });
      await assert.rejects(stat(home), { code: "ENOENT" });
    },
  };
}

test("backend shutdown acknowledges cleanup before a normal process exit", async () => {
  const port = await freeLoopbackPort();
  const harness = await startRuntimeHarness({ port, testMode: true });
  try {
    const started = await harness.request("start");
    assert.equal(started.type, "ready");
    const requestId = randomUUID();
    const acknowledgementPromise = harness.waitFor((message) => message.requestId === requestId);
    harness.child.send({ type: "shutdown", requestId });
    const acknowledgement = await acknowledgementPromise;
    assert.equal(acknowledgement.type, "shutdown-complete");
    assert.equal(acknowledgement.controlListenerClosed, true);
    const exit = await waitForChildExit(harness.child, 5_000);
    assert.deepEqual(exit, { exited: true, code: 0, signal: null });
    await assert.rejects(stat(join(harness.home, "orchestrator.lock")), { code: "ENOENT" });
  } finally {
    await harness.dispose();
  }
});

test("child exit wait allows a delayed IPC disconnect handler to finish before fallback termination", async () => {
  const script = "process.on('disconnect', () => setTimeout(() => process.exit(0), 75)); process.send({ type: 'ready' }); setInterval(() => {}, 1000);";
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
  try {
    const [ready] = await once(child, "message");
    assert.equal(ready.type, "ready");
    const exitPromise = waitForChildExit(child, 1_000);
    child.disconnect();
    assert.deepEqual(await exitPromise, { exited: true, code: 0, signal: null });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exitPromise = waitForChildExit(child, 2_000);
      child.kill();
      await exitPromise;
    }
  }
});

test("child exit is observed before close when a descendant still holds inherited stderr", async () => {
  const script = [
    "const { spawn } = require('node:child_process');",
    "process.on('disconnect', () => process.exit(0));",
    "spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 350)'], { stdio: ['ignore', 'ignore', 'inherit'] });",
    "process.send({ type: 'ready' });",
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
  let closeObserved = false;
  child.once("close", () => { closeObserved = true; });
  try {
    const [ready] = await once(child, "message");
    assert.equal(ready.type, "ready");
    const closePromise = once(child, "close");
    const exitPromise = waitForChildExit(child, 1_000);
    child.disconnect();
    assert.deepEqual(await exitPromise, { exited: true, code: 0, signal: null });
    assert.equal(closeObserved, false);
    let timer;
    const closed = await Promise.race([
      closePromise,
      new Promise((resolvePromise) => { timer = setTimeout(() => resolvePromise(undefined), 500); }),
    ]);
    clearTimeout(timer);
    if (closed) assert.equal(closeObserved, true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exitPromise = waitForChildExit(child, 2_000);
      child.kill();
      await exitPromise;
    }
  }
});

test("DB open failure after lock acquisition releases the lock and allows a real retry", async () => {
  const port = await freeLoopbackPort();
  const harness = await startRuntimeHarness({ port, testMode: true });
  try {
    assert.equal(harness.ready.type, "harness-ready", `test-mode bootstrap failed: ${harness.ready.code ?? "no code"}`);
    const failed = await harness.request("inject-db-open-failure");
    assert.equal(failed.type, "test-injected");
    const startFailure = await harness.request("start");
    assert.equal(startFailure.type, "control-error");
    assert.equal(startFailure.code, "CONTROL_PROTOCOL_ERROR");
    await assert.rejects(stat(join(harness.home, "orchestrator.lock")), { code: "ENOENT" });
    await assert.rejects(stat(join(harness.home, "ebb-orchestrator.db-wal")), { code: "ENOENT" });
    await assert.rejects(stat(join(harness.home, "ebb-orchestrator.db-shm")), { code: "ENOENT" });
    const occupied = createServer();
    const retryPort = await listenLoopback(occupied);
    await closeListener(occupied);
    const started = await harness.request("start", { port: retryPort });
    assert.equal(started.type, "ready");
    assert.equal(started.lifecycle, "READY");
    const stopped = await harness.request("stop");
    assert.equal(stopped.type, "stopped");
    await assert.rejects(stat(join(harness.home, "orchestrator.lock")), { code: "ENOENT" });
  } finally {
    await harness.dispose();
  }
});

test("app close failure keeps listener, SQLite, and lock tracked until shutdown retry succeeds", async () => {
  const occupied = createServer();
  const port = await listenLoopback(occupied);
  await closeListener(occupied);
  const harness = await startRuntimeHarness({ port, testMode: true });
  try {
    const started = await harness.request("start");
    assert.equal(started.type, "ready");
    const dbPath = started.databasePath;
    const injected = await harness.request("inject-close-failure");
    assert.equal(injected.type, "test-injected");
    const failedStop = await harness.request("stop");
    assert.equal(failedStop.type, "control-error");
    const health = await globalThis.fetch(`${started.backendUrl}/api/v1/health`);
    assert.equal(health.status, 200);
    assert.ok((await readFile(join(harness.home, "orchestrator.lock"), "utf8")).length > 0);
    assert.ok((await stat(dbPath)).isFile());
    const stopped = await harness.request("stop");
    assert.equal(stopped.type, "stopped");
    assert.equal(stopped.databasePath, dbPath);
    await assert.rejects(stat(join(harness.home, "orchestrator.lock")), { code: "ENOENT" });
    await assert.rejects(stat(`${dbPath}-wal`), { code: "ENOENT" });
    await assert.rejects(stat(`${dbPath}-shm`), { code: "ENOENT" });
  } finally {
    await harness.dispose();
  }
});

test("real EADDRINUSE startup retries on a new port and exhaustion leaves lock reusable", async () => {
  const occupied = createServer();
  const initialPort = await listenLoopback(occupied);
  const harness = await startRuntimeHarness({ port: initialPort, testMode: true });
  try {
    assert.equal(harness.ready.type, "harness-ready");
    const databasePath = join(harness.home, "ebb-orchestrator.db");
    const collisionServers = [occupied];
    const collisionPorts = [initialPort];
    for (let index = 0; index < 2; index += 1) {
      const server = createServer();
      collisionPorts.push(await listenLoopback(server));
      collisionServers.push(server);
    }
    for (const collisionPort of collisionPorts) {
      const failedStart = await harness.request("start", { port: collisionPort });
      assert.equal(failedStart.type, "control-error");
      assert.equal(failedStart.code, "EADDRINUSE");
      await assert.rejects(stat(join(harness.home, "orchestrator.lock")), { code: "ENOENT" });
    }
    for (const server of collisionServers) await closeListener(server);
    const retryPort = await freeLoopbackPort();
    const retried = await harness.request("start", { port: retryPort });
    assert.equal(retried.type, "ready");
    assert.equal(retried.databasePath, databasePath);
    const stopped = await harness.request("stop");
    assert.equal(stopped.type, "stopped");
  } finally {
    await closeListener(occupied);
    await harness.dispose();
  }
});
