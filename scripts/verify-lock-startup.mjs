#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

const repositoryRoot = resolve(import.meta.dirname, "..");
const serverMain = resolve(repositoryRoot, "apps/server/dist/main.js");
const home = await mkdtemp(join(tmpdir(), "ebb-lock-startup-"));
const lockPath = join(home, "orchestrator.lock");
const lockBytes = randomBytes(24);
await writeFile(lockPath, lockBytes);
const port = String(3000 + randomBytes(2).readUInt16BE() % 30000);
const env = { ...process.env, EBB_ORCHESTRATOR_HOME: home, PORT: port };
let child;
let stdout = "";
let stderr = "";

function waitForExit(processChild, timeoutMs) {
  return new Promise((resolveExit, reject) => {
    const timer = globalThis.setTimeout(() => reject(new Error("server did not exit within the bounded timeout")), timeoutMs);
    processChild.once("exit", (code, signal) => {
      globalThis.clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
}

try {
  child = spawn(process.execPath, [serverMain], {
    cwd: repositoryRoot,
    env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const result = await waitForExit(child, 15_000);
  assert.notEqual(result.code, 0, `conflicting server exited successfully: ${stdout}\n${stderr}`);
  assert.deepEqual(await readFile(lockPath), lockBytes, "conflict changed the existing lock bytes");
  assert.ok(stderr.includes(lockPath), "conflict diagnostic omitted the exact lock path");
  assert.doesNotMatch(`${stdout}\n${stderr}`, /listening|status: READY|\bREADY\b/);
  assert.equal(existsSync(join(home, "ebb-orchestrator.db")), false);
  const response = await globalThis.fetch(`http://127.0.0.1:${port}/api/v1/health`, {
    signal: globalThis.AbortSignal.timeout(1_000),
  }).catch(() => undefined);
  assert.equal(response, undefined, "conflicting server opened a listener");
  console.log("lock startup verification passed");
} finally {
  if (child && child.exitCode === null) {
    child.kill();
    await waitForExit(child, 5_000).catch(() => undefined);
  }
  await rm(home, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
}
