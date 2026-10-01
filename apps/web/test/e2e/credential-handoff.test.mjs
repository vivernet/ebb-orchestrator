import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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
import { createDetachedLedgerErrorDetector } from "./detached-ledger-error-detector.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const webRoot = join(repoRoot, "apps/web");
const serverRoot = join(repoRoot, "apps/server");
const ownedLaunchFiles = [
  "apps/server/src/main.ts",
  "apps/web/vite.config.ts",
  "apps/web/playwright.config.ts",
  "apps/web/test/e2e/run-e2e.mjs",
  "apps/web/test/e2e/child-lifecycle.mjs",
  "apps/web/test/e2e/detached-ledger-error-detector.mjs",
  "apps/web/test/e2e/detached-process-ledger.cjs",
  "apps/web/test/e2e/web-e2e-server.mjs",
  "apps/web/test/e2e/v1-ui.spec.ts",
  "scripts/run-server.js",
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
  const playwright = await source("apps/web/playwright.config.ts");
  const fixtures = await source("apps/web/test/e2e/fixtures.ts");
  const spec = await source("apps/web/test/e2e/v1-ui.spec.ts");
  assert.match(launcher, /passwordChannel\.endpoint/);
  assert.match(launcher, /EBB_E2E_HOME:\s*e2eHome/);
  assert.match(launcher, /EBB_E2E_PLAYWRIGHT_OUTPUT_DIR:\s*join\(e2eHome, ["']playwright-output["']\)/);
  assert.match(playwright, /outputDir:\s*launcherOutputDir\(\)/);
  assert.match(playwright, /output directory must be a child of its isolated home/);
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

test("launcher teardown owns, escalates, and verifies each POSIX child process group", async () => {
  const launcher = await source("apps/web/test/e2e/run-e2e.mjs");
  const lifecycle = await source("apps/web/test/e2e/child-lifecycle.mjs");
  const ledgerErrorDetector = await source("apps/web/test/e2e/detached-ledger-error-detector.mjs");
  const preload = await source("apps/web/test/e2e/detached-process-ledger.cjs");
  assert.match(launcher, /spawnManagedChild/);
  assert.match(launcher, /monitorDetachedProcessGroups\(playwright,/);
  assert.match(launcher, /detached-process-groups\.jsonl/);
  assert.match(launcher, /NODE_OPTIONS/);
  assert.match(launcher, /EBB_E2E_PROCESS_GROUP_LEDGER/);
  assert.match(launcher, /createDetachedLedgerErrorDetector/);
  assert.match(ledgerErrorDetector, /suffix/);
  assert.match(launcher, /mode:\s*0o600/);
  assert.match(launcher, /terminateManagedChild/);
  assert.match(lifecycle, /readLinuxProcessIdentity/);
  assert.match(lifecycle, /startTicks/);
  assert.match(lifecycle, /signalVerifiedDetachedGroups/);
  assert.match(preload, /childProcess\.spawn\s*=\s*function trackedSpawn/);
  assert.match(preload, /O_APPEND/);
  assert.match(preload, /fsyncSync/);
  assert.match(lifecycle, /execFileProvider\("taskkill\.exe", \["\/PID", String\(child\.pid\), "\/T", "\/F"\]/);
  assert.match(launcher, /cleanupErrors\.length === 0[\s\S]*assertCleanSqliteAndHome/);
});

test("Windows taskkill failure exposes process identity, status, and stderr", async () => {
  const { terminateWindowsChild } = await import("./child-lifecycle.mjs");
  assert.equal(typeof terminateWindowsChild, "function");

  const child = { pid: 42, exitCode: null, signalCode: null };
  const lifecycleEvents = [];
  const taskkillError = Object.assign(new Error("taskkill failed"), { code: "EPERM" });
  let observedError;
  await assert.rejects(terminateWindowsChild(child, {
    timeoutMs: 0,
    onEvent: (event, details) => lifecycleEvents.push({ event, ...details }),
    waitForChildExitProvider: async () => ({ exited: false, code: null, signal: null }),
    execFileProvider: (command, args, options, callback) => {
      assert.equal(command, "taskkill.exe");
      assert.deepEqual(args, ["/PID", "42", "/T", "/F"]);
      assert.deepEqual(options, { shell: false, windowsHide: true });
      callback(taskkillError, "", "Access is denied.");
    },
  }), (error) => {
    observedError = error;
    assert.match(error.message, /Windows E2E child did not exit after taskkill \(pid=42, exitCode=running, signalCode=none, taskkillCode=EPERM, taskkillStderr="Access is denied\."\)/);
    return true;
  });

  assert.equal(observedError.cause, taskkillError);
  assert.ok(lifecycleEvents.some((event) => event.event === "taskkill-result"
    && event.succeeded === false
    && event.errorCode === "EPERM"
    && event.stderr === "Access is denied."));
});

test("detached ledger error marker is detected when split across stderr chunks", () => {
  const marker = "EBB_E2E_DETACHED_LEDGER_ERROR";
  for (let splitAt = 1; splitAt < marker.length; splitAt += 1) {
    let detectionCount = 0;
    const detect = createDetachedLedgerErrorDetector(() => { detectionCount += 1; });
    assert.equal(detect(Buffer.from(marker.slice(0, splitAt))), false, `split ${splitAt}: partial marker`);
    assert.equal(detect(Buffer.from(marker.slice(splitAt))), true, `split ${splitAt}: trailing marker`);
    assert.equal(detectionCount, 1, `split ${splitAt}: marker callback count`);
  }
});

function processGroupExists(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessGroupExit(processGroupId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(processGroupId) && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  return !processGroupExists(processGroupId);
}

test("POSIX teardown escalates when a grandchild ignores SIGTERM and removes only its owned home", {
  skip: process.platform !== "linux",
}, async (t) => {
  const home = await mkdtemp(join(tmpdir(), "ebb-e2e-process-group-"));
  const ledgerPath = join(home, "detached-process-groups.jsonl");
  const preloadPath = join(repoRoot, "apps/web/test/e2e/detached-process-ledger.cjs");
  await writeFile(ledgerPath, "", { flag: "wx", mode: 0o600 });
  const script = [
    "process.on('SIGTERM', () => {});",
    "const { spawn } = require('node:child_process');",
    "const grandchild = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\"], { stdio: 'ignore' });",
    "process.send({ type: 'ready', grandchildPid: grandchild.pid });",
    "setInterval(() => {}, 1000);",
  ].join("\n");
  let processGroupId;
  let child;
  t.after(async () => {
    let cleanupError;
    if (child) {
      try { await (await import("./child-lifecycle.mjs")).terminateManagedChild(child, { termTimeoutMs: 100, killTimeoutMs: 3_000 }); }
      catch (error) { cleanupError = error; }
    }
    const groupCleaned = !Number.isInteger(processGroupId) || await waitForProcessGroupExit(processGroupId, 3_000);
    assert.ok(groupCleaned && !cleanupError, `Test-owned process group ${processGroupId} survived safe cleanup (${cleanupError?.message ?? "group remains"}); retained ${home}`);
    await rm(home, { recursive: true, force: false });
    await assert.rejects(stat(home), { code: "ENOENT" });
  });
  const { spawnManagedChild, terminateManagedChild } = await import("./child-lifecycle.mjs");
  child = spawnManagedChild(process.execPath, ["-e", script], {
    cwd: home,
    env: {
      ...process.env,
      EBB_E2E_HOME: home,
      EBB_E2E_PROCESS_GROUP_LEDGER: ledgerPath,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, "--require", JSON.stringify(preloadPath)].filter(Boolean).join(" "),
    },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
  });
  processGroupId = child.pid;
  const { monitorDetachedProcessGroups } = await import("./child-lifecycle.mjs");
  monitorDetachedProcessGroups(child, { pollIntervalMs: 10, ledgerPath });
  const [ready] = await once(child, "message");
  assert.equal(ready.type, "ready");
  assert.ok(Number.isInteger(ready.grandchildPid));

  const lifecycleEvents = [];
  const result = await terminateManagedChild(child, {
    termTimeoutMs: 100,
    killTimeoutMs: 3_000,
    pollIntervalMs: 20,
    onEvent: (event, details) => lifecycleEvents.push({ event, ...details }),
  });
  assert.deepEqual(result, { exited: true, groupGone: true, escalated: true });
  assert.ok(lifecycleEvents.some((event) => event.event === "signal-result" && event.signal === "SIGKILL" && event.sent));
  assert.equal(processGroupExists(processGroupId), false, "owned group and SIGTERM-ignoring grandchild are gone");
});

test("POSIX teardown tracks detached descendants and keeps the home until their group is gone", {
  skip: process.platform !== "linux",
}, async (t) => {
  const home = await mkdtemp(join(tmpdir(), "ebb-e2e-detached-group-"));
  const ledgerPath = join(home, "detached-process-groups.jsonl");
  const preloadPath = join(repoRoot, "apps/web/test/e2e/detached-process-ledger.cjs");
  const survivorIdentityPath = join(home, "survivor-identity.json");
  await writeFile(ledgerPath, "", { flag: "wx", mode: 0o600 });
  const detachedLeaderScript = [
    "const { spawn } = require('node:child_process');",
    "const { readFileSync, writeFileSync } = require('node:fs');",
    "const survivor = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\"], { stdio: 'ignore' });",
    "const stat = readFileSync(`/proc/${survivor.pid}/stat`, 'utf8');",
    "const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\\s+/);",
    "writeFileSync(process.env.EBB_E2E_SURVIVOR_IDENTITY, JSON.stringify({ pid: survivor.pid, processGroupId: Number(fields[2]), sessionId: Number(fields[3]), startTicks: fields[19] }), { mode: 0o600 });",
    "survivor.unref();",
    "setTimeout(() => process.exit(0), 75);",
  ].join("\n");
  const rootScript = [
    "const { spawn } = require('node:child_process');",
    `const detached = spawn(process.execPath, ["-e", ${JSON.stringify(detachedLeaderScript)}], { detached: true, stdio: 'ignore' });`,
    "detached.once('exit', () => process.send({ type: 'ready', detachedPid: detached.pid }));",
    "setInterval(() => {}, 1000);",
  ].join("\n");
  let processGroupId;
  let rootGroupId;
  let child;
  let terminationAttempted = false;
  t.after(async () => {
    let cleanupError;
    if (child && !terminationAttempted) {
      try { await (await import("./child-lifecycle.mjs")).terminateManagedChild(child, { termTimeoutMs: 100, killTimeoutMs: 3_000 }); }
      catch (error) { cleanupError = error; }
    }
    try {
      const { readLinuxProcessIdentity } = await import("./child-lifecycle.mjs");
      const saved = JSON.parse(await readFile(survivorIdentityPath, "utf8"));
      const current = readLinuxProcessIdentity(saved.pid);
      if (current && current.pid === saved.pid && current.processGroupId === saved.processGroupId
          && current.sessionId === saved.sessionId && current.startTicks === saved.startTicks) {
        process.kill(saved.pid, "SIGKILL");
      } else if (processGroupExists(saved.processGroupId)) {
        cleanupError ??= new Error("Survivor PID identity changed; refusing to signal test cleanup process");
      }
    } catch (error) {
      if (error?.code !== "ENOENT") cleanupError ??= error;
    }
    const groupCleaned = (await Promise.all([processGroupId, rootGroupId].map((groupId) => (
      Number.isInteger(groupId) ? waitForProcessGroupExit(groupId, 3_000) : true
    )))).every(Boolean);
    assert.ok(groupCleaned, `Test-owned process groups ${processGroupId}/${rootGroupId} survived safe cleanup (${cleanupError?.message ?? "group remains"}); retained ${home}`);
    await rm(home, { recursive: true, force: false });
    await assert.rejects(stat(home), { code: "ENOENT" });
  });

  const { monitorDetachedProcessGroups, spawnManagedChild, terminateManagedChild } = await import("./child-lifecycle.mjs");
  child = spawnManagedChild(process.execPath, ["-e", rootScript], {
    cwd: home,
    env: {
      ...process.env,
      EBB_E2E_HOME: home,
      EBB_E2E_PROCESS_GROUP_LEDGER: ledgerPath,
      EBB_E2E_SURVIVOR_IDENTITY: survivorIdentityPath,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, "--require", JSON.stringify(preloadPath)].filter(Boolean).join(" "),
    },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
  });
  rootGroupId = child.pid;
  monitorDetachedProcessGroups(child, { pollIntervalMs: 10, ledgerPath });
  const [ready] = await once(child, "message");
  assert.equal(ready.type, "ready");
  processGroupId = ready.detachedPid;

  const trackingDeadline = Date.now() + 3_000;
  while (!child.ownedDetachedProcessGroups?.has(processGroupId) && Date.now() < trackingDeadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  const trackedGroup = child.ownedDetachedProcessGroups?.get(processGroupId);
  assert.ok(trackedGroup, "append-only spawn ledger captures detached session leader even after it exits");
  assert.ok(typeof trackedGroup.startTicks === "string", "ledger records Linux kernel start ticks");
  assert.equal(processGroupExists(processGroupId), true, "detached leader exited but its persistent same-session child remains");
  const survivor = JSON.parse(await readFile(survivorIdentityPath, "utf8"));
  const { readLinuxProcessIdentity } = await import("./child-lifecycle.mjs");
  const beforeTerm = readLinuxProcessIdentity(survivor.pid);
  assert.deepEqual(beforeTerm, survivor, "survivor PID, process group, session, and start ticks still match the owned identity");
  process.kill(survivor.pid, "SIGTERM");
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  assert.deepEqual(readLinuxProcessIdentity(survivor.pid), survivor, "the exact detached survivor ignores SIGTERM and remains alive");
  assert.equal(processGroupExists(processGroupId), true, "same-session group remains after the verified SIGTERM");

  terminationAttempted = true;
  await assert.rejects(terminateManagedChild(child, {
    termTimeoutMs: 100,
    killTimeoutMs: 100,
    pollIntervalMs: 20,
  }), /could not be verified/);
  assert.equal(processGroupExists(processGroupId), true, "teardown fails closed while the recorded group still has a surviving child");
  assert.equal(existsSync(home), true, "home remains available while the orphaned recorded group is alive");
});

test("POSIX teardown refuses root process-group reuse before signalling", async (t) => {
  const { terminatePosixManagedChild } = await import("./child-lifecycle.mjs");
  const processId = 424_242;
  const originalStartTicks = "100001";
  const replacementStartTicks = "100002";

  for (const scenario of ["before-term", "before-kill"]) {
    await t.test(scenario, async () => {
      let identityReads = 0;
      let currentStartTicks = originalStartTicks;
      const signalCalls = [];
      const processIdentityProvider = () => {
        identityReads += 1;
        if ((scenario === "before-term" && identityReads >= 1) || (scenario === "before-kill" && identityReads >= 2)) {
          currentStartTicks = replacementStartTicks;
        }
        return { pid: processId, processGroupId: processId, sessionId: processId, startTicks: currentStartTicks };
      };
      const child = {
        pid: processId,
        ownedProcessGroupId: processId,
        ownedProcessIdentity: { pid: processId, processGroupId: processId, sessionId: processId, startTicks: originalStartTicks },
        exitCode: null,
        signalCode: null,
      };

      await assert.rejects(terminatePosixManagedChild(child, {
        termTimeoutMs: 0,
        killTimeoutMs: 0,
        pollIntervalMs: 1,
        processIdentityProvider,
        processGroupExistsProvider: () => true,
        signalProcessGroupProvider: (groupId, signal) => {
          signalCalls.push({ groupId, signal, startTicks: currentStartTicks });
          return true;
        },
      }), /refusing to signal/);

      const expectedCalls = scenario === "before-term"
        ? []
        : [{ groupId: processId, signal: "SIGTERM", startTicks: originalStartTicks }];
      assert.deepEqual(signalCalls, expectedCalls, "no signal is sent while the observed group belongs to the replacement identity");
      assert.ok(identityReads >= (scenario === "before-term" ? 1 : 2));
    });
  }
});

test("POSIX teardown keeps reading detached-group ledger through bounded signal phases", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "ebb-e2e-late-detached-ledger-"));
  t.after(async () => {
    if (existsSync(home)) await rm(home, { recursive: true, force: false });
  });

  const { terminatePosixManagedChild } = await import("./child-lifecycle.mjs");
  const rootPid = 515_151;
  const latePid = 515_252;
  const rootIdentity = { pid: rootPid, processGroupId: rootPid, sessionId: rootPid, startTicks: "151515" };
  const lateIdentity = { pid: latePid, processGroupId: latePid, sessionId: latePid, startTicks: "252525" };
  const child = {
    pid: rootPid,
    ownedProcessGroupId: rootPid,
    ownedProcessIdentity: rootIdentity,
    ownedDetachedProcessGroups: new Map(),
    exitCode: null,
    signalCode: null,
  };
  const ledgerRecords = [];
  child.detachedProcessGroupMonitor = {
    refresh() {
      for (const record of ledgerRecords) {
        child.ownedDetachedProcessGroups.set(record.processGroupId, {
          leaderPid: record.pid,
          processGroupId: record.processGroupId,
          sessionId: record.sessionId,
          startTicks: record.startTicks,
        });
      }
    },
  };

  let rootGroupExists = true;
  let lateGroupExists = false;
  let ledgerAppendedDuringTerm = false;
  const signalCalls = [];
  const processIdentityProvider = (pid) => {
    if (pid === rootPid) return rootGroupExists ? rootIdentity : undefined;
    if (pid === latePid) return lateGroupExists ? lateIdentity : undefined;
    return undefined;
  };
  const processGroupExistsProvider = (processGroupId) => (
    processGroupId === rootPid ? rootGroupExists : processGroupId === latePid ? lateGroupExists : false
  );
  const signalProcessGroupProvider = (processGroupId, signal) => {
    signalCalls.push({ processGroupId, signal });
    if (processGroupId === rootPid && signal === "SIGTERM") {
      rootGroupExists = false;
      child.signalCode = "SIGTERM";
      lateGroupExists = true;
      ledgerAppendedDuringTerm = true;
      ledgerRecords.push({
        version: 1,
        type: "detached-process-group",
        pid: latePid,
        processGroupId: latePid,
        sessionId: latePid,
        startTicks: lateIdentity.startTicks,
      });
    }
    return true;
  };

  await assert.rejects(terminatePosixManagedChild(child, {
    termTimeoutMs: 0,
    killTimeoutMs: 0,
    pollIntervalMs: 1,
    processIdentityProvider,
    processGroupExistsProvider,
    signalProcessGroupProvider,
  }), /could not be verified/);

  assert.equal(ledgerAppendedDuringTerm, true, "a new detached group is appended after the initial ownership snapshot");
  assert.deepEqual(signalCalls, [
    { processGroupId: rootPid, signal: "SIGTERM" },
    { processGroupId: latePid, signal: "SIGTERM" },
    { processGroupId: latePid, signal: "SIGKILL" },
  ], "the teardown re-reads and signals the late group with fresh identity gates");
  assert.equal(lateGroupExists, true, "the simulated late group remains after bounded escalation");
  assert.equal(existsSync(home), true, "the isolated home remains while a late ledger group is alive");

  lateGroupExists = false;
  const recovered = await terminatePosixManagedChild(child, {
    termTimeoutMs: 0,
    killTimeoutMs: 0,
    pollIntervalMs: 1,
    processIdentityProvider,
    processGroupExistsProvider,
    signalProcessGroupProvider,
  });
  assert.deepEqual(recovered, { exited: true, groupGone: true, escalated: false });
  await rm(home, { recursive: true, force: false });
  await assert.rejects(stat(home), { code: "ENOENT" });
});

test("POSIX teardown retains the home when root identity is unavailable but its group remains", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "ebb-e2e-unknown-root-identity-"));
  t.after(async () => {
    if (existsSync(home)) await rm(home, { recursive: true, force: false });
  });

  const { terminatePosixManagedChild } = await import("./child-lifecycle.mjs");
  const processId = 616_161;
  const signalCalls = [];
  const child = {
    pid: processId,
    ownedProcessGroupId: processId,
    exitCode: 0,
    signalCode: null,
  };
  await assert.rejects(terminatePosixManagedChild(child, {
    processIdentityProvider: () => undefined,
    processGroupExistsProvider: () => true,
    signalProcessGroupProvider: (groupId, signal) => {
      signalCalls.push({ groupId, signal });
      return true;
    },
  }), /refusing to signal/);

  assert.deepEqual(signalCalls, [], "an unverified root group is never signalled");
  assert.equal(existsSync(home), true, "the isolated home remains while the unverified group exists");
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

async function resolveWithin(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolvePromise) => { timer = setTimeout(() => resolvePromise(undefined), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function terminateHarnessProcess(child, disposeGraceMs) {
  let exit = await waitForChildExit(child, disposeGraceMs).catch(() => ({ exited: false }));
  if (!exit.exited) {
    child.kill("SIGTERM");
    exit = await waitForChildExit(child, disposeGraceMs).catch(() => ({ exited: false }));
  }
  if (!exit.exited) {
    child.kill("SIGKILL");
    exit = await waitForChildExit(child, disposeGraceMs).catch(() => ({ exited: false }));
  }
  if (!exit.exited) throw new Error(`E2E runtime harness child did not exit after bounded TERM/KILL (pid=${child.pid ?? "none"})`);
}

async function cleanupRuntimeHarness(child, home, childClosePromise, spawnOutcomePromise, disposeGraceMs) {
  if (!child.pid) {
    const spawnOutcome = await resolveWithin(spawnOutcomePromise, disposeGraceMs);
    if (!spawnOutcome) throw new Error("E2E runtime harness spawn outcome could not be verified; isolated home retained");
    if (spawnOutcome.kind === "spawned") {
      if (!child.pid) throw new Error("E2E runtime harness PID could not be verified after spawn; isolated home retained");
    } else {
      const closed = await resolveWithin(childClosePromise, disposeGraceMs);
      if (!closed) throw new Error("E2E runtime harness spawn failure did not close its child handle; isolated home retained");
    }
  }

  if (child.pid) {
    if (child.connected) child.disconnect();
    // The E2E wrapper owns its backend in-process, so this exact ChildProcess handle is its full process boundary.
    await terminateHarnessProcess(child, disposeGraceMs);
  }

  if (existsSync(home)) await rm(home, { recursive: true, force: false });
  if (existsSync(home)) throw new Error("E2E runtime harness isolated home remained after verified cleanup");
}

async function startRuntimeHarness({
  port,
  testMode = false,
  serverScriptPath = join(webRoot, "test/e2e/web-e2e-server.mjs"),
  nodeExecutablePath = process.execPath,
  bootstrapTimeoutMs = 5_000,
  disposeGraceMs = 5_000,
  onSpawn,
}) {
  const home = await mkdtemp(join(tmpdir(), "ebb-runtime-failure-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:password|passwd|token|secret|credential)/i.test(key)));
  let child;
  try {
    child = spawn(nodeExecutablePath, [serverScriptPath, String(port)], {
      cwd: repoRoot,
      env: { ...env, EBB_ORCHESTRATOR_HOME: home, ...(testMode ? { EBB_E2E_TEST_MODE: "1" } : {}) },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    });
  } catch (error) {
    await rm(home, { recursive: true, force: false });
    throw error;
  }
  const messages = [];
  const waiters = [];
  let childError;
  let childExit;
  let resolveSpawnOutcome;
  const spawnOutcomePromise = new Promise((resolvePromise) => { resolveSpawnOutcome = resolvePromise; });
  const childClosePromise = new Promise((resolvePromise) => {
    child.once("close", (code, signal) => {
      resolvePromise({ code, signal });
    });
  });
  child.once("spawn", () => {
    resolveSpawnOutcome({ kind: "spawned" });
  });
  child.on("error", (error) => {
    childError ??= error;
    resolveSpawnOutcome({ kind: "error", error });
    for (const waiter of [...waiters]) waiter.reject(error);
  });
  child.once("exit", (code, signal) => {
    childExit = { code, signal };
    const error = new Error(`E2E runtime harness exited before expected response (code=${code ?? "none"}, signal=${signal ?? "none"})`);
    for (const waiter of [...waiters]) waiter.reject(error);
  });
  child.on("message", (message) => {
    messages.push(message);
    const index = waiters.findIndex((waiter) => waiter.matches(message));
    if (index >= 0) waiters.splice(index, 1)[0].resolve(message);
  });
  const waitFor = (matches, timeoutMs = 5_000) => {
    const predicate = typeof matches === "string" ? (message) => message.type === matches || message.type === "seed-error" : matches;
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    if (childError) return Promise.reject(childError);
    if (childExit) return Promise.reject(new Error(`E2E runtime harness exited before expected response (code=${childExit.code ?? "none"}, signal=${childExit.signal ?? "none"})`));
    return new Promise((resolvePromise, reject) => {
      let settled = false;
      let timer;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        callback(value);
      };
      const waiter = {
        matches: predicate,
        resolve: (message) => finish(resolvePromise, message),
        reject: (error) => finish(reject, error),
      };
      timer = setTimeout(() => waiter.reject(new Error("Timed out awaiting E2E server response")), timeoutMs);
      waiters.push(waiter);
    });
  };
  const request = async (command, options = {}) => {
    const requestId = randomUUID();
    const response = waitFor((message) => message.requestId === requestId);
    child.send({ type: "e2e-control", command, requestId, ...options });
    return response;
  };
  const seedPassword = Buffer.from(randomBytes(24).toString("base64url"));
  let disposal;
  const dispose = () => {
    disposal ??= cleanupRuntimeHarness(child, home, childClosePromise, spawnOutcomePromise, disposeGraceMs);
    return disposal;
  };
  try {
    onSpawn?.({ child, home });
    const seeded = waitFor((message) => ["harness-ready", "ready", "seed-error"].includes(message.type), bootstrapTimeoutMs);
    child.send({ type: "seed-password", requestId: randomUUID(), password: seedPassword.toString("utf8") });
    const ready = await seeded;
    if (ready.type === "seed-error") throw new Error(`E2E runtime fixture bootstrap failed: ${ready.code}`);
    return { child, home, ready, request, waitFor, dispose };
  } catch (error) {
    try {
      await dispose();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `E2E runtime harness bootstrap failed and teardown was not verified: ${cleanupError.message}`, { cause: cleanupError });
    }
    throw error;
  } finally {
    seedPassword.fill(0);
  }
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

test("runtime harness bootstrap failures terminate their child and remove their home before rejecting", async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "ebb-runtime-harness-bootstrap-"));
  const stalledServerPath = join(fixtureRoot, "stalled-server.mjs");
  const exitingServerPath = join(fixtureRoot, "exiting-server.mjs");
  await writeFile(stalledServerPath, "process.on('message', () => {}); setInterval(() => {}, 1_000);\n", { flag: "wx" });
  await writeFile(exitingServerPath, "process.exit(7);\n", { flag: "wx" });
  try {
    const scenarios = [
      {
        name: "bootstrap timeout",
        options: { serverScriptPath: stalledServerPath, nodeExecutablePath: process.execPath, port: 45_678 },
        timeoutMs: 100,
        expectedError: /Timed out awaiting E2E server response/,
      },
      {
        name: "child exit before bootstrap response",
        options: { serverScriptPath: exitingServerPath, port: 45_678 },
        timeoutMs: 2_000,
        expectedError: /exited before expected response/,
      },
      {
        name: "spawn error before bootstrap response",
        options: { serverScriptPath: stalledServerPath, nodeExecutablePath: join(fixtureRoot, "missing-node.exe"), port: 45_678 },
        timeoutMs: 100,
        expectedError: /ENOENT/,
      },
    ];
    for (const scenario of scenarios) {
      await t.test(scenario.name, async () => {
        let captured;
        try {
          await assert.rejects(startRuntimeHarness({
            ...scenario.options,
            bootstrapTimeoutMs: scenario.timeoutMs,
            disposeGraceMs: 1_000,
            onSpawn: (details) => { captured = details; },
          }), scenario.expectedError);
          assert.ok(captured?.child, "test observes the exact harness child created by this attempt");
          const childExit = await waitForChildExit(captured.child, 250);
          assert.equal(childExit.exited, true, "a failed bootstrap must not leave its child process alive");
          await assert.rejects(stat(captured.home), { code: "ENOENT" }, "a failed bootstrap must remove its isolated home");
        } finally {
          if (captured?.child?.pid && captured.child.exitCode === null && captured.child.signalCode === null) {
            captured.child.kill("SIGTERM");
            const cleanupExit = await waitForChildExit(captured.child, 1_000);
            assert.equal(cleanupExit.exited, true, `test-owned bootstrap child ${captured.child.pid} must be cleaned after assertion`);
          }
          if (captured?.home && existsSync(captured.home)) await rm(captured.home, { recursive: true, force: false });
        }
      });
    }
  } finally {
    await rm(fixtureRoot, { recursive: true, force: false });
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
