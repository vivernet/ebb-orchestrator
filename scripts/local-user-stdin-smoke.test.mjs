import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { assertOutputMatches, assertRuntimePaths, cleanupOwnedChild, assertSecretAbsent, buildBootstrapArgs, createSmokeSecret, endInput, requestSmokeShutdown, waitForExit } from "./local-user-stdin-smoke.mjs";
import { getLaunchConfig } from "./run-server.js";

test("smoke generates valid stdin records and opts in only with the exact flag", () => {
  const { secret, payload } = createSmokeSecret();
  try {
    assert.ok(secret.length >= 32);
    assert.deepEqual(payload.toString("utf8"), `${secret}\n${secret}\n`);
    const args = buildBootstrapArgs("server-entry.js");
    assert.deepEqual(args, ["server-entry.js", "--bootstrap-local-user-stdin"]);
    assert.equal(args.includes(secret), false);
    assertSecretAbsent(secret, { argv: args, env: ["EBB_ORCHESTRATOR_HOME=/disposable"], files: [], stdout: [], stderr: [] });
    assert.throws(() => assertSecretAbsent(secret, { stdout: [`diagnostic ${secret}`] }), /stdout/);
  } finally {
    payload.fill(0);
  }
});

test("launcher forwards only the supplied opt-in token verbatim", () => {
  const config = getLaunchConfig(["--bootstrap-local-user-stdin", "--unrelated"]);
  assert.deepEqual(config.args.slice(-2), ["--bootstrap-local-user-stdin", "--unrelated"]);
  assert.equal(config.options.shell, false);
});

test("smoke ends a real child stdin pipe and observes EOF", async () => {
  const child = spawn(process.execPath, ["-e", "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(s))"], {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });
  const payload = Buffer.from("memory-only-payload");
  await endInput(child.stdin, payload);
  const result = await waitForExit(child, 5_000);
  assert.ok(result.code === 0 || result.signal === "SIGTERM");
  assert.equal(output, "memory-only-payload");
  assert.ok(payload.every((byte) => byte === 0));
});

test("endInput waits for writes before clearing the payload", async () => {
  let received;
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      globalThis.setTimeout(() => {
        received = Buffer.from(chunk);
        callback();
      }, 10);
    },
  });
  const payload = Buffer.from("buffer-lifetime-marker");
  await endInput(stream, payload);
  assert.equal(received?.toString("utf8"), "buffer-lifetime-marker");
  assert.ok(payload.every((byte) => byte === 0), "input payload must be cleared after the write finishes");
});

test("smoke waits for owned child exit within a bounded deadline", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exit = waitForExit(child, 5_000);
  child.kill("SIGTERM");
  const result = await exit;
  assert.ok(result.code === 0 || result.signal === "SIGTERM");
});

test("smoke requires database, checkpoints, and artifacts under disposable home", () => {
  assertRuntimePaths("C:/tmp/disposable", {
    database: "C:/tmp/disposable/ebb-orchestrator.db",
    checkpoints: "C:/tmp/disposable/runtime/checkpoints",
    artifacts: "C:/tmp/disposable/artifacts",
    hermesResults: "C:/tmp/disposable/runtime/hermes/results",
  });
  assert.throws(() => assertRuntimePaths("C:/tmp/disposable", {
    database: "C:/Users/test/.orchestrator/ebb-orchestrator.db",
    checkpoints: "C:/tmp/disposable/runtime/checkpoints",
    artifacts: "C:/tmp/disposable/artifacts",
    hermesResults: "C:/tmp/disposable/runtime/hermes/results",
  }), /database/);
});

test("owned child exits before disposable home removal", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { shell: false, stdio: "ignore" });
  const order = [];
  await cleanupOwnedChild(child, async () => {
    order.push("remove");
    assert.ok(child.exitCode !== null || child.signalCode !== null, "child still alive during home removal");
  });
  assert.deepEqual(order, ["remove"]);
});

test("smoke requests graceful shutdown through the child IPC channel", async () => {
  const child = spawn(process.execPath, ["-e", "process.on('message', message => { if (message === 'ebb-local-user-stdin-smoke:shutdown') process.exit(0); })"], {
    shell: false,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  try {
    await requestSmokeShutdown(child);
    const result = await waitForExit(child, 5_000);
    assert.equal(result.code, 0);
  } finally {
    await cleanupOwnedChild(child, async () => {});
  }
});

test("output assertion failures omit child output contents", () => {
  const diagnosticMarker = "diagnostic-output-marker";
  assert.throws(
    () => assertOutputMatches(diagnosticMarker, /expected-status/, "child status"),
    (error) => error.message.includes("expected child status") && !error.message.includes(diagnosticMarker),
  );
});

test("post-shutdown secret check uses a real newline between captured streams", () => {
  const source = readFileSync(join(import.meta.dirname, "local-user-stdin-smoke.mjs"), "utf8");
  const start = source.indexOf("const filesAfterShutdown");
  const end = source.indexOf('console.log("local-user stdin bootstrap smoke passed")', start);
  assert.ok(start !== -1 && end > start, "post-shutdown smoke assertions must be present");
  assert.ok(
    source.slice(start, end).includes('assertSecretAbsent(secret, { stdout: [stdout], stderr: [stderr] })'),
    "post-shutdown secret assertion must inspect streams independently",
  );
});

test("shutdown completion matcher joins captured streams with a real newline", () => {
  const source = readFileSync(join(import.meta.dirname, "local-user-stdin-smoke.mjs"), "utf8");
  const start = source.indexOf("const stopped = await waitForExit(child, 10_000)");
  const end = source.indexOf("const filesAfterShutdown", start);
  assert.ok(start !== -1 && end > start, "post-shutdown assertions must be present");
  assert.ok(
    source.slice(start, end).includes('assertOutputMatches(`${stdout}\\n${stderr}`'),
    "shutdown output matcher must use an actual newline separator",
  );
});
