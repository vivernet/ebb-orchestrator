"use strict";

/* global process, require */

// CommonJS обязателен: этот файл загружается Node через `NODE_OPTIONS=--require`.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const childProcess = require("node:child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("node:fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("node:path");

const ledgerPath = process.env.EBB_E2E_PROCESS_GROUP_LEDGER;
const e2eHome = process.env.EBB_E2E_HOME;

if (ledgerPath || e2eHome) {
  try {
    if (!ledgerPath || !e2eHome) throw new Error("E2E detached process ledger environment is incomplete");
    const resolvedHome = fs.realpathSync(e2eHome);
    const resolvedLedger = path.resolve(ledgerPath);
    if (path.dirname(resolvedLedger) !== resolvedHome) throw new Error("E2E detached process ledger is outside its isolated home");
    const stat = fs.lstatSync(resolvedLedger);
    if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o777) !== 0o600) {
      throw new Error("E2E detached process ledger is not a private regular file");
    }
  } catch {
    process.stderr.write("EBB_E2E_DETACHED_LEDGER_ERROR: ledger validation failed\n");
    globalThis.__ebbE2EDetachedLedgerError = true;
  }
}

function linuxIdentity(pid) {
  if (process.platform !== "linux" || !Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) return undefined;
    const fields = stat.slice(closeParen + 1).trim().split(/\s+/);
    return {
      processGroupId: Number(fields[2]),
      sessionId: Number(fields[3]),
      startTicks: fields[19],
    };
  } catch {
    return undefined;
  }
}

function appendLedgerRecord(record) {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const fd = fs.openSync(ledgerPath, fs.constants.O_WRONLY | fs.constants.O_APPEND | noFollow);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error("E2E detached process ledger is not a regular file");
    fs.fchmodSync(fd, 0o600);
    fs.writeSync(fd, `${JSON.stringify(record)}\n`, undefined, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function recordDetachedChild(child) {
  try {
    if (!Number.isInteger(child.pid) || child.pid <= 0) throw new Error("Detached child PID is unavailable");
    const identity = linuxIdentity(child.pid);
    appendLedgerRecord({
      version: 1,
      type: "detached-process-group",
      pid: child.pid,
      processGroupId: identity?.processGroupId ?? child.pid,
      sessionId: identity?.sessionId ?? null,
      startTicks: identity?.startTicks ?? null,
    });
    return true;
  } catch {
    globalThis.__ebbE2EDetachedLedgerError = true;
    process.stderr.write("EBB_E2E_DETACHED_LEDGER_ERROR: detached process ownership could not be recorded\n");
    return false;
  }
}

if (ledgerPath && !globalThis.__ebbE2ESpawnHookInstalled) {
  globalThis.__ebbE2ESpawnHookInstalled = true;
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = function trackedSpawn(command, args, options) {
    const spawnOptions = Array.isArray(args) ? options : args;
    const child = originalSpawn.apply(this, arguments);
    if (spawnOptions?.detached === true) {
      if (!recordDetachedChild(child)) throw new Error("E2E detached process ownership could not be recorded");
      child.once("spawn", () => {
        if (!recordDetachedChild(child)) throw new Error("E2E detached process ownership could not be recorded on spawn");
      });
    }
    return child;
  };
}
