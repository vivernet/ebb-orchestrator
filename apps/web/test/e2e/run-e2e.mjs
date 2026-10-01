import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import { clearTimeout, setTimeout } from "node:timers";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, connect } from "node:net";
import { monitorDetachedProcessGroups, spawnManagedChild, terminateManagedChild, waitForChildExit } from "./child-lifecycle.mjs";
import { createE2EPasswordChannel } from "./credential-channel.mjs";
import { createDetachedLedgerErrorDetector } from "./detached-ledger-error-detector.mjs";

const require = createRequire(import.meta.url);
const webRoot = resolve(import.meta.dirname, "../..");
const repoRoot = resolve(webRoot, "../..");
const serverScript = resolve(import.meta.dirname, "web-e2e-server.mjs");
const detachedProcessLedgerPreload = resolve(import.meta.dirname, "detached-process-ledger.cjs");
const playwrightCli = resolve(dirname(require.resolve("@playwright/test/package.json")), "cli.js");
const viteCli = resolve(dirname(require.resolve("vite/package.json")), "bin/vite.js");
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const buildCommand = process.platform === "win32" ? "cmd.exe" : pnpmCommand;
const buildArgs = process.platform === "win32" ? ["/d", "/s", "/c", "pnpm.cmd run server:build"] : ["run", "server:build"];
const password = Buffer.from(randomBytes(32).toString("base64url"), "utf8");
const children = new Map();
const controlSockets = new Set();
const inheritedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:password|passwd|token|secret|credential)/i.test(key)));
let e2eHome;
let passwordChannel;
let controlEndpoint;
let controlChannel;
let playwrightExitCode = 1;
let primaryError;
let detachedProcessLedgerFailure = false;

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function recordChildEvent(child, event, details = {}) {
  child.lifecycleEvents ??= [];
  child.lifecycleEvents.push({ event, at: new Date().toISOString(), ...details });
}

function trackChild(name, child) {
  children.set(name, child);
  child.startupOutput = "";
  child.lifecycleEvents = [];
  const detectDetachedLedgerFailure = createDetachedLedgerErrorDetector(() => {
    child.detachedProcessGroupLedgerError = true;
    detachedProcessLedgerFailure = true;
  });
  child.once("exit", (code, signal) => recordChildEvent(child, "exit", { code, signal }));
  child.once("close", (code, signal) => recordChildEvent(child, "close", { code, signal }));
  child.once("disconnect", () => recordChildEvent(child, "disconnect"));
  child.stderr?.on("data", (chunk) => {
    const output = chunk.toString("utf8");
    child.startupOutput = `${child.startupOutput}${output}`.slice(-8192);
    detectDetachedLedgerFailure(chunk);
    process.stderr.write(chunk);
  });
  child.once("error", (error) => {
    if (!primaryError) primaryError = error;
  });
  return child;
}

function waitForChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode ?? 1);
  return new Promise((resolvePromise, reject) => {
    const finish = (error, code) => {
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolvePromise(code ?? 1);
    };
    const onError = (error) => finish(error);
    const onExit = (code) => finish(undefined, code);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function spawnNode(name, args, { cwd = webRoot, env = process.env, ipc = false } = {}) {
  const stdio = ipc ? ["ignore", "inherit", "pipe", "ipc"] : ["ignore", "inherit", "pipe"];
  return trackChild(name, spawnManagedChild(process.execPath, args, { cwd, env, shell: false, stdio, windowsHide: true }));
}

function runBuild() {
  const child = spawnManagedChild(buildCommand, buildArgs, {
    cwd: repoRoot, env: inheritedEnv, shell: false, stdio: "inherit", windowsHide: true,
  });
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const finish = async (error) => {
      if (settled) return;
      settled = true;
      child.off("error", onError);
      child.off("exit", onExit);
      try {
        await terminateManagedChild(child);
      } catch (cleanupError) {
        return reject(error ? new AggregateError([error, cleanupError], "server:build failed and process-group teardown was not verified") : cleanupError);
      }
      if (error) reject(error);
      else resolvePromise();
    };
    const onError = (error) => { void finish(error); };
    const onExit = (code) => {
      void finish(code === 0 ? undefined : new Error(`server:build failed with exit code ${code ?? 1}`));
    };
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function allocateLoopbackPort() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const probe = createServer();
    const port = await new Promise((resolvePromise, reject) => {
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        if (!address || typeof address === "string") return reject(new Error("Could not allocate a loopback port"));
        resolvePromise(address.port);
      });
    });
    await new Promise((resolvePromise, reject) => probe.close((error) => error ? reject(error) : resolvePromise()));
    if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
  }
  throw new Error("Could not allocate a dynamic loopback port");
}

function waitForMessage(child, type, requestId, timeoutMs = 90_000) {
  return new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => finish(new Error(`Timed out waiting for backend ${type} acknowledgement`)), timeoutMs);
    const onMessage = (message) => {
      if (message?.requestId !== requestId) return;
      if (message.type === type) return finish(undefined, message);
      if (message.type === "seed-error") {
        const error = new Error(`Backend setup failed: ${message.code}`);
        error.code = message.code;
        error.controlEndpoint = message.controlEndpoint;
        finish(error);
      }
    };
    const onClose = (code) => finish(new Error(`Backend exited before ${type} acknowledgement (exit ${code ?? 1})`));
    const onError = (error) => finish(error);
    const finish = (error, value) => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("close", onClose);
      child.off("error", onError);
      if (error) reject(error);
      else resolvePromise(value);
    };
    child.on("message", onMessage);
    child.once("close", onClose);
    child.once("error", onError);
  });
}

function waitForBackendShutdown(child, requestId, timeoutMs = 5_000) {
  return new Promise((resolvePromise, reject) => {
    let timer;
    const finish = (error, value) => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) reject(error);
      else resolvePromise(value);
    };
    const onMessage = (message) => {
      if (message?.requestId !== requestId) return;
      if (message.type === "shutdown-complete") return finish(undefined, message);
      if (message.type === "shutdown-error") {
        const error = new Error(`Backend shutdown failed: ${message.code ?? "unknown"}`);
        error.code = message.code;
        finish(error);
      }
    };
    const onExit = (code, signal) => finish(new Error(`Backend exited before shutdown acknowledgement (code=${code ?? "none"}, signal=${signal ?? "none"})`));
    const onError = (error) => finish(error);
    timer = setTimeout(() => finish(new Error("Backend shutdown acknowledgement timed out")), timeoutMs);
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

function sendChildMessage(child, message) {
  return new Promise((resolvePromise, reject) => {
    if (!child.connected) return reject(new Error("Backend IPC channel is not connected"));
    try {
      child.send(message, (error) => error ? reject(error) : resolvePromise());
    } catch (error) { reject(error); }
  });
}

async function waitForHttp(url, child, accept) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      const error = new Error(`Server exited before readiness at ${url}`);
      if (/EADDRINUSE|address already in use|port .+ in use/i.test(child.startupOutput ?? "")) error.code = "EADDRINUSE";
      throw error;
    }
    try {
      const response = await globalThis.fetch(url);
      if (accept(response)) return response;
    } catch { /* Повторяем запрос до истечения срока готовности. */ }
    await delay(100);
  }
  throw new Error(`Readiness deadline expired for ${url}`);
}

function parseControlEndpoint(endpoint) {
  const match = /^127\.0\.0\.1:([1-9]\d{0,4})$/.exec(endpoint ?? "");
  if (!match || Number(match[1]) > 65535) throw new Error("Backend returned an invalid control endpoint");
  return Number(match[1]);
}

function controlRequest(command, timeoutMs = 5_000, options = {}) {
  if (!controlChannel) return Promise.reject(new Error("Control channel is not ready"));
  const port = parseControlEndpoint(controlChannel.endpoint);
  const requestId = randomUUID();
  return new Promise((resolvePromise, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    controlSockets.add(socket);
    let input = "";
    const timer = setTimeout(() => finish(new Error("Control channel deadline expired")), timeoutMs);
    const finish = (error, value) => {
      clearTimeout(timer);
      controlSockets.delete(socket);
      socket.removeAllListeners();
      socket.destroy();
      if (error) reject(error);
      else resolvePromise(value);
    };
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify({ command, requestId, ...options })}\n`));
    socket.on("data", (chunk) => { input += chunk; });
    socket.once("end", () => {
      try {
        const response = JSON.parse(input.trim());
        if (response.requestId !== requestId) throw new Error("Control request id mismatch");
        if (response.type === "control-error") {
          const error = new Error(`Backend control failed: ${response.code}`);
          error.code = response.code;
          throw error;
        }
        finish(undefined, response);
      } catch (error) { finish(error); }
    });
    socket.once("error", (error) => finish(error));
  });
}

function closeControlChannel() {
  for (const socket of controlSockets) socket.destroy();
  controlSockets.clear();
}

function childLifecycleSummary(name, child) {
  return JSON.stringify({
    name,
    pid: child.pid ?? null,
    connected: child.connected ?? null,
    exitCode: child.exitCode,
    signalCode: child.signalCode,
    events: child.lifecycleEvents,
  });
}

async function terminateChild(name) {
  const child = children.get(name);
  if (!child) return;
  try {
    await terminateManagedChild(child, { onEvent: (event, details) => recordChildEvent(child, event, details) });
  } catch (cause) {
    throw new Error(`E2E ${name} teardown failed: ${cause.message}; lifecycle=${childLifecycleSummary(name, child)}`, { cause });
  }
  children.delete(name);
}

async function assertCleanSqliteAndHome() {
  if (!e2eHome) return;
  for (const name of ["orchestrator.lock", "ebb-orchestrator.db-wal", "ebb-orchestrator.db-shm"]) {
    if (existsSync(join(e2eHome, name))) throw new Error(`E2E teardown left ${name}`);
  }
  await rm(e2eHome, { recursive: true, force: false });
  if (existsSync(e2eHome)) throw new Error("E2E isolated home remains after teardown");
}

try {
  const backendPort = await allocateLoopbackPort();
  let frontendPort = await allocateLoopbackPort();
  await runBuild();

  e2eHome = await mkdtemp(join(tmpdir(), "ebb-orchestrator-e2e-"));
  const detachedProcessLedger = process.platform === "win32" ? undefined : join(e2eHome, "detached-process-groups.jsonl");
  if (detachedProcessLedger) await writeFile(detachedProcessLedger, "", { flag: "wx", mode: 0o600 });
  const backend = spawnNode("backend", [serverScript, String(backendPort)], {
    cwd: repoRoot,
    env: { ...inheritedEnv, EBB_ORCHESTRATOR_HOME: e2eHome },
    ipc: true,
  });
  const requestId = randomUUID();
  const seeded = waitForMessage(backend, "seeded", requestId);
  const ready = waitForMessage(backend, "ready", requestId);
  backend.send({ type: "seed-password", requestId, password: password.toString("utf8") });
  await seeded;
  let backendReady;
  try {
    backendReady = await ready;
  } catch (error) {
    if (error?.code !== "EADDRINUSE" || !error.controlEndpoint) throw error;
    controlEndpoint = error.controlEndpoint;
    parseControlEndpoint(controlEndpoint);
    controlChannel = { endpoint: controlEndpoint, async dispose() { closeControlChannel(); } };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const retryPort = await allocateLoopbackPort();
      try {
        backendReady = await controlRequest("start", 5_000, { port: retryPort });
        break;
      } catch (retryError) {
        if (retryError?.code !== "EADDRINUSE" || attempt === 2) throw retryError;
      }
    }
  }
  if (backendReady.host !== "127.0.0.1" || backendReady.backendUrl !== `http://127.0.0.1:${backendReady.port}` || backendReady.lifecycle !== "READY") {
    throw new Error("Backend readiness acknowledgement did not match its allocated loopback origin");
  }
  controlEndpoint = backendReady.controlEndpoint;
  parseControlEndpoint(controlEndpoint);
  controlChannel = {
    endpoint: controlEndpoint,
    async dispose() { closeControlChannel(); },
  };

  passwordChannel = await createE2EPasswordChannel(password);
  frontendPort = await allocateLoopbackPort();
  let frontend;
  let frontendUrl;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    frontendUrl = `http://127.0.0.1:${frontendPort}`;
    frontend = spawnNode("frontend", [viteCli, "--mode", "e2e", "--host", "127.0.0.1", "--port", String(frontendPort), "--strictPort"], {
      env: { ...inheritedEnv, EBB_E2E_BACKEND_URL: backendReady.backendUrl },
    });
    try {
      await waitForHttp(`${frontendUrl}/`, frontend, (response) => response.status === 200);
      break;
    } catch (error) {
      if (error?.code !== "EADDRINUSE" || attempt === 2) throw error;
      await terminateChild("frontend");
      frontendPort = await allocateLoopbackPort();
    }
  }

  const playwrightArgs = process.argv.slice(2);
  if (playwrightArgs[0] === "--") playwrightArgs.shift();
  const playwrightEnv = {
    ...inheritedEnv,
    EBB_E2E_SERVERS_STARTED: "1",
    EBB_E2E_BASE_URL: frontendUrl,
    EBB_E2E_BACKEND_URL: backendReady.backendUrl,
    EBB_E2E_HOME: e2eHome,
    EBB_E2E_PLAYWRIGHT_OUTPUT_DIR: join(e2eHome, "playwright-output"),
    EBB_E2E_PASSWORD_CHANNEL: passwordChannel.endpoint,
    EBB_E2E_CONTROL_CHANNEL: controlEndpoint,
  };
  if (detachedProcessLedger) {
    playwrightEnv.EBB_E2E_PROCESS_GROUP_LEDGER = detachedProcessLedger;
    playwrightEnv.NODE_OPTIONS = [inheritedEnv.NODE_OPTIONS, "--require", JSON.stringify(detachedProcessLedgerPreload)].filter(Boolean).join(" ");
  }
  const playwright = spawnNode("playwright", [playwrightCli, "test", ...playwrightArgs], {
    env: playwrightEnv,
  });
  monitorDetachedProcessGroups(playwright, { ledgerPath: detachedProcessLedger });
  playwrightExitCode = await waitForChild(playwright);
} catch (error) {
  primaryError = error;
} finally {
  const cleanupErrors = [];
  for (const name of ["playwright", "frontend"]) {
    try { await terminateChild(name); } catch (error) { cleanupErrors.push(error); }
  }
  if (controlEndpoint && children.has("backend")) {
    const backendProcess = children.get("backend");
    recordChildEvent(backendProcess, "control-stop-requested");
    try {
      const stopped = await controlRequest("stop");
      recordChildEvent(backendProcess, "control-stop-response", { type: stopped.type });
      if (stopped.type !== "stopped") cleanupErrors.push(new Error("Backend did not acknowledge final stop"));
    } catch (error) {
      recordChildEvent(backendProcess, "control-stop-error", { name: error?.name ?? null, code: error?.code ?? null });
      cleanupErrors.push(error);
    }
  }
  if (controlChannel) {
    try { await controlChannel.dispose(); } catch (error) { cleanupErrors.push(error); }
  }
  if (passwordChannel) {
    try { await passwordChannel.dispose(); } catch (error) { cleanupErrors.push(error); }
  }
  password.fill(0);
  const backend = children.get("backend");
  if (backend && !controlEndpoint) {
    try { await terminateChild("backend"); } catch (error) { cleanupErrors.push(error); }
  } else if (backend) {
    const requestId = randomUUID();
    recordChildEvent(backend, "shutdown-requested", { requestId });
    let forceTerminationNeeded = false;
    try {
      const acknowledgementPromise = waitForBackendShutdown(backend, requestId);
      const [, acknowledgement] = await Promise.all([
        sendChildMessage(backend, { type: "shutdown", requestId }),
        acknowledgementPromise,
      ]);
      recordChildEvent(backend, "shutdown-acknowledged", { controlListenerClosed: acknowledgement.controlListenerClosed === true });
      if (acknowledgement.controlListenerClosed !== true) {
        cleanupErrors.push(new Error("Backend shutdown acknowledgement did not confirm control listener closure"));
        forceTerminationNeeded = true;
      } else {
        const exit = await waitForChildExit(backend, 5_000);
        recordChildEvent(backend, "shutdown-exit-result", { exited: exit.exited, code: exit.code, signal: exit.signal });
        if (!exit.exited) {
          cleanupErrors.push(new Error(`Backend did not exit after shutdown acknowledgement; lifecycle=${childLifecycleSummary("backend", backend)}`));
          forceTerminationNeeded = true;
        } else {
          try { await terminateChild("backend"); } catch (terminationError) { cleanupErrors.push(terminationError); }
          if (exit.code !== 0 || exit.signal !== null) {
            cleanupErrors.push(new Error(`Backend exited abnormally after shutdown acknowledgement (code=${exit.code ?? "none"}, signal=${exit.signal ?? "none"})`));
          }
        }
      }
    } catch (error) {
      cleanupErrors.push(error);
      forceTerminationNeeded = true;
    }
    if (forceTerminationNeeded && children.has("backend")) {
      try { await terminateChild("backend"); } catch (terminationError) { cleanupErrors.push(terminationError); }
    }
  }
  if (detachedProcessLedgerFailure) cleanupErrors.push(new Error("E2E detached process ownership ledger failed; isolated home must be retained"));
  if (cleanupErrors.length === 0) {
    try { await assertCleanSqliteAndHome(); } catch (error) { cleanupErrors.push(error); }
  }
  if (cleanupErrors.length > 0 && !primaryError) primaryError = new AggregateError(cleanupErrors, "E2E teardown failed");
  if (cleanupErrors.length > 0 && primaryError) {
    for (const error of cleanupErrors) process.stderr.write(`E2E teardown failure: ${error.message}\n`);
    if (e2eHome && existsSync(e2eHome)) process.stderr.write(`E2E isolated home retained after unverified teardown: ${e2eHome}\n`);
  }
}

if (primaryError) {
  process.stderr.write(`E2E launcher failed: ${primaryError.message}\n`);
  process.exitCode = 1;
} else {
  process.exitCode = playwrightExitCode;
}
