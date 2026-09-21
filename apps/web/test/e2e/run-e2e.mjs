import { createRequire } from "node:module";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const webRoot = resolve(import.meta.dirname, "../..");
const e2eRoot = resolve(webRoot, "test/e2e");
const bootstrapFile = resolve(e2eRoot, ".playwright/bootstrap.json");
const e2eHome = resolve(tmpdir(), `ebb-orchestrator-e2e-${process.pid}`);
const playwrightCli = resolve(dirname(require.resolve("@playwright/test/package.json")), "cli.js");
const viteCli = resolve(dirname(require.resolve("vite/package.json")), "bin/vite.js");

const children = [];
let playwright;

function delay(milliseconds) {
  return new Promise((resolvePromise) => globalThis.setTimeout(resolvePromise, milliseconds));
}

function spawnChild(name, args, env = process.env) {
  const child = spawn(process.execPath, args, {
    cwd: webRoot,
    env,
    shell: false,
    stdio: "inherit",
    windowsHide: true,
  });
  children.push({ name, child });
  return child;
}

async function waitForUrl(url, child, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`${url} server exited before becoming ready (exit code ${child.exitCode})`);
    }
    try {
      const response = await globalThis.fetch(url);
      if (response.status >= 200 && response.status < 500) return;
    } catch {
      // The server is still starting.
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function waitForExit(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolvePromise) => child.once("close", resolvePromise));
}

function terminateProcessTree(child, force = false) {
  if (child.exitCode !== null) return Promise.resolve();
  if (process.platform !== "win32") {
    child.kill("SIGTERM");
    return Promise.resolve();
  }
  return new Promise((resolvePromise) => {
    execFile("taskkill.exe", ["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])], {
      windowsHide: true,
      shell: false,
    }, () => {
      // Windows может оставить ChildProcess handle без close-события после
      // принудительного завершения дерева; unref не позволяет этому handle
      // удерживать launcher после teardown.
      child.unref();
      resolvePromise();
    });
  });
}

async function stopChild(child) {
  await terminateProcessTree(child, true);
  await Promise.race([waitForExit(child), delay(1_000)]);
  if (child.exitCode === null) {
    await terminateProcessTree(child, true);
    await Promise.race([waitForExit(child), delay(1_000)]);
  }
  // На Windows taskkill /T /F завершает process tree, но Node может не
  // обновить ChildProcess.exitCode и не прислать close для уже уничтоженного
  // дочернего процесса. Повторное завершение выше является проверяемым
  // teardown-контрактом; stale exitCode не должен превращать зелёный E2E в
  // ложный failure.
}

async function removeBootstrapFile() {
  await rm(bootstrapFile, { force: true });
  await rm(dirname(bootstrapFile), { recursive: true, force: true });
  // Windows может удерживать SQLite handle после process-tree teardown;
  // isolated home находится в OS temp и не загрязняет repository.
}

try {
  await mkdir(dirname(bootstrapFile), { recursive: true });
  await rm(e2eHome, { recursive: true, force: true });
  const backend = spawnChild("backend", [resolve(webRoot, "../server/dist/main.js")], {
    ...process.env,
    PORT: "3001",
    EBB_ORCHESTRATOR_HOME: e2eHome,
    EBB_ORCHESTRATOR_BOOTSTRAP_FILE: bootstrapFile,
    EBB_ORCHESTRATOR_NO_OPEN_UI: "1",
  });
  await waitForUrl("http://127.0.0.1:3001/api/v1/health", backend);

  const frontend = spawnChild("frontend", [
    viteCli,
    "--mode", "e2e",
    "--host", "127.0.0.1",
    "--port", "4173",
  ]);
  await waitForUrl("http://127.0.0.1:4173/", frontend);

  playwright = spawnChild("playwright", [playwrightCli, "test", ...process.argv.slice(2)], {
    ...process.env,
    EBB_E2E_SERVERS_STARTED: "1",
  });
  const exitCode = await new Promise((resolvePromise) => playwright.once("close", (code) => resolvePromise(code ?? 1)));
  process.exitCode = exitCode;
} finally {
  for (const { child } of children.slice().reverse()) {
    await stopChild(child);
  }
  await removeBootstrapFile();
}

if (!existsSync(bootstrapFile)) {
  process.stdout.write("E2E harness teardown verified: no bootstrap artifact remains.\n");
}
