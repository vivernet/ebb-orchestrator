/* global process, setTimeout, Buffer */

// plan-26 Task4 (part B): interruption-safe local journal/checkpoint/lock/
// transfer under git-common-dir/ebb-release/, validated UUID operation paths.
// Storage: operations/<uuid>/{state.json,events.jsonl,inventory.json,gates.json,
// approval.json}; atomic tmp+rename writes; append-only intent/result events;
// integrity/schema/version checks; monotonic stage progression; finite mutex
// wait; checksum backup manifest + safe deterministic importer. The lock
// protects only the local cache — remote serialization is Task8's workflow.

import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

export const JOURNAL_SCHEMA_VERSION = 1;

export const STATUSES = Object.freeze([
  'PREPARED',
  'VALIDATED',
  'AWAITING_CONFIRMATION',
  'PUBLISHING',
  'PUBLISHED',
  'ROLLBACK_PREPARED',
  'ROLLING_BACK',
  'ROLLED_BACK',
  'PARTIAL',
  'BLOCKED',
  'CONFLICT',
]);

export const STAGES = Object.freeze([
  'prepared',
  'validated',
  'awaiting-confirmation',
  'publishing',
  'published',
  'rollback-prepared',
  'rolling-back',
  'rolled-back',
]);

export const FILE_NAMES = Object.freeze(['state.json', 'events.jsonl', 'inventory.json', 'gates.json', 'approval.json']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const EVENT_KINDS = new Set(['intent', 'result']);

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export function validateOperationId(operationId) {
  return typeof operationId === 'string' && UUID_RE.test(operationId);
}

function isValidTimestamp(value) {
  if (typeof value !== 'string' || !TIMESTAMP_RE.test(value)) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const iso = date.toISOString();
  return value.includes('.') ? iso === value : iso === `${value.slice(0, -1)}.000Z`;
}

export function safeError(error, env = process.env) {
  let message = error instanceof Error ? error.message : String(error);
  let name = error instanceof Error ? error.name : 'Error';
  let code = error && typeof error === 'object' && error.code ? String(error.code) : 'ERROR';
  for (const [, value] of Object.entries(env)) {
    if (typeof value === 'string' && value.length >= 8 && message.includes(value)) {
      message = message.split(value).join('<redacted>');
    }
  }
  return { code, name, message };
}

export async function resolveCommonDir({ cwd }) {
  const run = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf8', shell: false });
  if (run.status !== 0 || run.error) {
    throw new Error(`COMMON_DIR_UNAVAILABLE: ${safeError(run.error ?? new Error(run.stderr)).message}`);
  }
  return resolve(cwd, run.stdout.trim());
}

export function storageRoot({ commonDir }) {
  return join(commonDir, 'ebb-release');
}

async function guardedOperationDir({ commonDir, operationId }) {
  if (!validateOperationId(operationId)) {
    return { valid: false, blockers: [{ code: 'OPERATION_ID_INVALID', field: 'operationId', detail: 'operationId must be a canonical lowercase RFC 4122 UUID' }] };
  }
  let commonReal;
  try {
    commonReal = await realpath(commonDir);
  } catch (error) {
    return { valid: false, blockers: [{ code: 'STORAGE_ROOT_UNAVAILABLE', field: 'commonDir', detail: safeError(error).message }] };
  }
  const root = join(commonReal, 'ebb-release');
  try {
    await mkdir(join(root, 'operations'), { recursive: true });
  } catch (error) {
    return { valid: false, blockers: [{ code: 'STORAGE_ROOT_UNAVAILABLE', field: 'commonDir', detail: safeError(error).message }] };
  }
  let baseReal;
  try {
    baseReal = await realpath(join(root, 'operations'));
  } catch (error) {
    return { valid: false, blockers: [{ code: 'STORAGE_ROOT_UNAVAILABLE', field: 'commonDir', detail: safeError(error).message }] };
  }
  const rootReal = await realpath(root);
  if (baseReal !== rootReal && !baseReal.startsWith(rootReal + sep)) {
    return { valid: false, blockers: [{ code: 'PATH_ESCAPE', field: 'path', detail: `operations root ${baseReal} escapes ${rootReal}` }] };
  }
  const target = join(baseReal, operationId);
  let stat;
  try {
    stat = await lstat(target);
  } catch {
    stat = null;
  }
  if (stat && stat.isSymbolicLink()) {
    return { valid: false, blockers: [{ code: 'PATH_ESCAPE', field: 'path', detail: `operation path ${target} is a symlink escaping the journal root` }] };
  }
  return { valid: true, path: target, blockers: [] };
}

export async function operationDir({ commonDir, operationId }) {
  return guardedOperationDir({ commonDir, operationId });
}

export async function atomicWrite(file, text) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `${basename(file)}.tmp-${randomUUID().slice(0, 8)}`);
  await writeFile(tmp, text, { encoding: 'utf8', flag: 'wx' });
  try {
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

export async function atomicWriteJson(file, value) {
  await atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
  return { ok: true };
}

function readJsonFile(raw, fileCode) {
  try {
    return { parsed: JSON.parse(raw), raw };
  } catch {
    return { error: { code: `${fileCode}_INTEGRITY`, detail: `${basename(fileCode.toLowerCase())} is not valid JSON` } };
  }
}

export async function readState({ commonDir, operationId }) {
  const { valid, path, blockers } = await guardedOperationDir({ commonDir, operationId });
  if (!valid) return { ok: false, code: blockers[0].code, detail: blockers[0].detail };
  let raw;
  try {
    raw = await readFile(join(path, 'state.json'), 'utf8');
  } catch (error) {
    return { ok: false, code: error.code === 'ENOENT' ? 'STATE_MISSING' : 'STATE_INTEGRITY', detail: safeError(error).message };
  }
  const read = readJsonFile(raw, 'STATE');
  if (read.error) return { ok: false, ...read.error };
  const state = read.parsed;
  if (state.schemaVersion !== JOURNAL_SCHEMA_VERSION) {
    return { ok: false, code: 'STATE_SCHEMA_VERSION', detail: `expected schemaVersion ${JOURNAL_SCHEMA_VERSION}` };
  }
  if (state.operationId !== operationId) {
    return { ok: false, code: 'STATE_OPERATION_ID_MISMATCH', detail: 'state operationId does not match the storage directory' };
  }
  if (!STATUSES.includes(state.status)) {
    return { ok: false, code: 'STATE_STATUS', detail: `unknown status ${JSON.stringify(state.status)}` };
  }
  if (!STAGES.includes(state.stage)) {
    return { ok: false, code: 'STATE_STAGE', detail: `unknown stage ${JSON.stringify(state.stage)}` };
  }
  return { ok: true, state };
}

export async function writeState({ commonDir, operationId, state }) {
  if (!state || typeof state !== 'object') return { ok: false, code: 'STATE_SHAPE' };
  if (state.schemaVersion !== JOURNAL_SCHEMA_VERSION) return { ok: false, code: 'STATE_SCHEMA_VERSION' };
  if (state.operationId !== operationId) return { ok: false, code: 'STATE_OPERATION_ID_MISMATCH' };
  if (!STATUSES.includes(state.status)) return { ok: false, code: 'STATE_STATUS' };
  if (!STAGES.includes(state.stage)) return { ok: false, code: 'STATE_STAGE' };
  const { valid, path, blockers } = await guardedOperationDir({ commonDir, operationId });
  if (!valid) return { ok: false, code: blockers[0].code };
  return atomicWriteJson(join(path, 'state.json'), state);
}

export async function readEvents({ commonDir, operationId }) {
  const { valid, path, blockers } = await guardedOperationDir({ commonDir, operationId });
  if (!valid) return { ok: false, code: blockers[0].code, detail: blockers[0].detail };
  let raw;
  try {
    raw = await readFile(join(path, 'events.jsonl'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: true, events: [] };
    return { ok: false, code: 'EVENTS_READ', detail: safeError(error).message };
  }
  const lines = raw.split('\n').filter((line) => line.trim().length > 0);
  const events = [];
  let previousSeq = 0;
  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return { ok: false, code: 'EVENTS_INTEGRITY' };
    }
    if (!Number.isInteger(event.seq) || event.seq <= 0 || event.seq <= previousSeq) {
      return { ok: false, code: 'EVENTS_SEQ', detail: `events must be append-only with strictly increasing seq (got ${event.seq} after ${previousSeq})` };
    }
    if (!EVENT_KINDS.has(event.kind)) return { ok: false, code: 'EVENT_KIND' };
    if (typeof event.event !== 'string' || event.event.length === 0) return { ok: false, code: 'EVENT_NAME' };
    if (!isValidTimestamp(event.ts)) return { ok: false, code: 'EVENT_TIMESTAMP' };
    previousSeq = event.seq;
    events.push(event);
  }
  return { ok: true, events };
}

export async function appendEvent({ commonDir, operationId, kind, event, payload, ts }) {
  if (!validateOperationId(operationId)) return { ok: false, code: 'OPERATION_ID_INVALID' };
  if (!EVENT_KINDS.has(kind)) return { ok: false, code: 'EVENT_KIND' };
  if (typeof event !== 'string' || event.length === 0) return { ok: false, code: 'EVENT_NAME' };
  const stamp = ts ?? nowIso();
  if (!isValidTimestamp(stamp)) return { ok: false, code: 'EVENT_TIMESTAMP' };
  const { valid, path, blockers } = await guardedOperationDir({ commonDir, operationId });
  if (!valid) return { ok: false, code: blockers[0].code };
  const eventsPath = join(path, 'events.jsonl');
  const existing = await readEvents({ commonDir, operationId });
  if (!existing.ok) return existing;
  const seq = existing.events.length === 0 ? 1 : existing.events[existing.events.length - 1].seq + 1;
  const line = JSON.stringify({ seq, ts: stamp, kind, event, ...(payload !== undefined ? { payload } : {}) });
  const next = existing.events.map((item) => JSON.stringify(item));
  next.push(line);
  return atomicWrite(eventsPath, `${next.join('\n')}\n`).then(() => ({ ok: true, seq }));
}

function makeTypedReader(name, codePrefix) {
  return async ({ commonDir, operationId }) => {
    const { valid, path, blockers } = await guardedOperationDir({ commonDir, operationId });
    if (!valid) return { ok: false, code: blockers[0].code, detail: blockers[0].detail };
    let raw;
    try {
      raw = await readFile(join(path, name), 'utf8');
    } catch (error) {
      return { ok: false, code: error.code === 'ENOENT' ? `${codePrefix}_MISSING` : `${codePrefix}_INTEGRITY`, detail: safeError(error).message };
    }
    const read = readJsonFile(raw, codePrefix);
    if (read.error) return { ok: false, ...read.error };
    const value = read.parsed;
    if (value.schemaVersion !== JOURNAL_SCHEMA_VERSION) {
      return { ok: false, code: `${codePrefix}_SCHEMA_VERSION`, detail: `expected schemaVersion ${JOURNAL_SCHEMA_VERSION}` };
    }
    if (value.operationId !== operationId) {
      return { ok: false, code: `${codePrefix}_OPERATION_ID_MISMATCH`, detail: 'file operationId does not match the storage directory' };
    }
    return { ok: true, value };
  };
}

function makeTypedWriter(name, codePrefix) {
  return async ({ commonDir, operationId, value }) => {
    if (!value || typeof value !== 'object') return { ok: false, code: `${codePrefix}_SHAPE` };
    if (value.schemaVersion !== JOURNAL_SCHEMA_VERSION) return { ok: false, code: `${codePrefix}_SCHEMA_VERSION` };
    if (value.operationId !== operationId) return { ok: false, code: `${codePrefix}_OPERATION_ID_MISMATCH` };
    const { valid, path, blockers } = await guardedOperationDir({ commonDir, operationId });
    if (!valid) return { ok: false, code: blockers[0].code };
    return atomicWriteJson(join(path, name), value);
  };
}

export const readInventory = makeTypedReader('inventory.json', 'INVENTORY');
export const readGates = makeTypedReader('gates.json', 'GATES');
export const readApproval = makeTypedReader('approval.json', 'APPROVAL');
export const writeInventory = makeTypedWriter('inventory.json', 'INVENTORY');
export const writeGates = makeTypedWriter('gates.json', 'GATES');
export const writeApproval = makeTypedWriter('approval.json', 'APPROVAL');

export function transitionStage(state, nextStage) {
  if (!state || typeof state !== 'object' || !STAGES.includes(state.stage)) {
    return { ok: false, code: 'STATE_SHAPE' };
  }
  if (!STAGES.includes(nextStage)) return { ok: false, code: 'STAGE_UNKNOWN' };
  const currentIndex = STAGES.indexOf(state.stage);
  const nextIndex = STAGES.indexOf(nextStage);
  if (nextIndex <= currentIndex) {
    return { ok: false, code: 'STAGE_REGRESSION', detail: `stage ${state.stage} -> ${nextStage} would regress` };
  }
  return { ok: true, state: { ...state, stage: nextStage, updatedAt: nowIso() } };
}

export async function acquireLock({ commonDir, operationId, token, timeoutMs = 3000, pollMs = 25 }) {
  if (!validateOperationId(operationId)) return { held: false, code: 'OPERATION_ID_INVALID' };
  const lockToken = token ?? randomUUID();
  const locksPath = join(commonDir, 'ebb-release', 'locks');
  await mkdir(locksPath, { recursive: true });
  const lockPath = join(locksPath, `${operationId}.lock`);
  const entry = { operationId, token: lockToken, pid: process.pid, host: hostname(), acquiredAt: nowIso() };
  const deadline = Date.now() + timeoutMs;
  const release = async () => {
    try {
      await rm(lockPath, { force: true });
    } catch {
      // lock already released
    }
  };
  for (;;) {
    try {
      await writeFile(lockPath, JSON.stringify(entry), { encoding: 'utf8', flag: 'wx' });
      return { held: true, token: lockToken, release };
    } catch (error) {
      if (error.code !== 'EEXIST') {
        return { held: false, code: 'LOCK_ERROR', detail: safeError(error).message };
      }
    }
    let owner;
    try {
      owner = JSON.parse(await readFile(lockPath, 'utf8'));
    } catch {
      owner = null;
    }
    if (owner && owner.token === lockToken) {
      return { held: true, token: lockToken, release };
    }
    if (Date.now() >= deadline) {
      let alive = true;
      if (owner && Number.isInteger(owner.pid)) {
        try {
          process.kill(owner.pid, 0);
        } catch {
          alive = false;
        }
      }
      return {
        held: false,
        code: alive ? 'LOCK_BUSY' : 'LOCK_STALE_NO_TERMINATION_EVIDENCE',
        detail: 'lock is held by another owner and there is no owner-termination evidence; refusing to auto-break',
      };
    }
    await sleep(pollMs);
  }
}

export async function createBackup({ commonDir, operationId }) {
  const { valid, path, blockers } = await guardedOperationDir({ commonDir, operationId });
  if (!valid) return { ok: false, code: blockers[0].code };
  const root = storageRoot({ commonDir });
  const backupDir = join(root, 'backup', operationId);
  await mkdir(backupDir, { recursive: true });
  const files = {};
  for (const name of FILE_NAMES) {
    const filePath = join(path, name);
    let raw;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      return { ok: false, code: 'BACKUP_READ_FAILED', detail: safeError(error).message };
    }
    files[name] = {
      size: Buffer.byteLength(raw, 'utf8'),
      sha256: createHash('sha256').update(raw).digest('hex'),
    };
    await writeFile(join(backupDir, name), raw, { encoding: 'utf8' });
  }
  const manifest = { schemaVersion: JOURNAL_SCHEMA_VERSION, operationId, createdAt: nowIso(), files };
  const manifestPath = join(root, 'backup', `${operationId}-manifest.json`);
  await atomicWriteJson(manifestPath, manifest);
  return { ok: true, manifest };
}

export async function backupManifest({ commonDir, operationId }) {
  if (!validateOperationId(operationId)) return { ok: false, code: 'OPERATION_ID_INVALID' };
  const manifestPath = join(storageRoot({ commonDir }), 'backup', `${operationId}-manifest.json`);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    return { ok: false, code: 'BACKUP_MANIFEST_MISSING', detail: safeError(error).message };
  }
  if (manifest.schemaVersion !== JOURNAL_SCHEMA_VERSION) {
    return { ok: false, code: 'BACKUP_MANIFEST_INVALID', detail: `expected schemaVersion ${JOURNAL_SCHEMA_VERSION}` };
  }
  if (manifest.operationId !== operationId) {
    return { ok: false, code: 'BACKUP_MANIFEST_INVALID', detail: 'manifest operationId mismatch' };
  }
  if (!manifest.files || typeof manifest.files !== 'object') {
    return { ok: false, code: 'BACKUP_MANIFEST_INVALID', detail: 'manifest files map required' };
  }
  return { ok: true, manifest };
}

export async function importBackup({ commonDir, operationId }) {
  const manResult = await backupManifest({ commonDir, operationId });
  if (!manResult.ok) return manResult;
  const { manifest } = manResult;
  const backupDir = join(storageRoot({ commonDir }), 'backup', operationId);
  const { valid, path, blockers } = await guardedOperationDir({ commonDir, operationId });
  if (!valid) return { ok: false, code: blockers[0].code };
  const imported = [];
  for (const [name, meta] of Object.entries(manifest.files)) {
    if (!FILE_NAMES.includes(name)) {
      return { ok: false, code: 'BACKUP_UNEXPECTED_FILE', detail: name };
    }
    if (!meta || typeof meta.size !== 'number' || typeof meta.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(meta.sha256)) {
      return { ok: false, code: 'BACKUP_MANIFEST_INVALID', detail: name };
    }
    let raw;
    try {
      raw = await readFile(join(backupDir, name), 'utf8');
    } catch (error) {
      return { ok: false, code: 'BACKUP_BLOB_MISSING', detail: `${name}: ${safeError(error).message}` };
    }
    const hash = createHash('sha256').update(raw).digest('hex');
    if (hash !== meta.sha256 || Buffer.byteLength(raw, 'utf8') !== meta.size) {
      return { ok: false, code: 'BACKUP_CHECKSUM_MISMATCH', detail: name };
    }
    await atomicWrite(join(path, name), raw);
    imported.push(name);
  }
  return { ok: true, imported };
}

export async function verifyIntegrity({ commonDir, operationId }) {
  const { valid, path, blockers } = await guardedOperationDir({ commonDir, operationId });
  if (!valid) return { ok: false, code: blockers[0].code };
  let entries;
  try {
    entries = await readdir(path);
  } catch {
    return { ok: false, code: 'CACHE_MISSING' };
  }
  if (entries.length === 0) return { ok: false, code: 'CACHE_MISSING' };
  const manResult = await backupManifest({ commonDir, operationId });
  if (!manResult.ok) return manResult;
  const { manifest } = manResult;
  for (const name of FILE_NAMES) {
    if (!manifest.files[name]) continue;
    let raw;
    try {
      raw = await readFile(join(path, name), 'utf8');
    } catch (error) {
      return { ok: false, code: 'CACHE_INTEGRITY', detail: `${name}: ${safeError(error).message}` };
    }
    const hash = createHash('sha256').update(raw).digest('hex');
    if (hash !== manifest.files[name].sha256) {
      return { ok: false, code: 'CACHE_CHECKSUM_MISMATCH', detail: name };
    }
  }
  return { ok: true };
}

export async function recoverOperation({ commonDir, operationId }) {
  const stateResult = await readState({ commonDir, operationId });
  if (stateResult.ok) return { status: 'present', state: stateResult.state };
  const manResult = await backupManifest({ commonDir, operationId });
  if (manResult.ok) {
    const importResult = await importBackup({ commonDir, operationId });
    if (importResult.ok) {
      const again = await readState({ commonDir, operationId });
      if (again.ok) return { status: 'restored', state: again.state };
      return { status: 'blocked', code: 'AMBIGUOUS_CACHE' };
    }
    return { status: 'blocked', code: importResult.code, detail: importResult.detail };
  }
  const eventsResult = await readEvents({ commonDir, operationId });
  if (eventsResult.ok && eventsResult.events.length > 0) {
    return { status: 'blocked', code: 'AMBIGUOUS_CACHE', detail: 'events exist without verified state/backup; rebuilding state would guess' };
  }
  return { status: 'blocked', code: 'CACHE_ABSENT' };
}

export { nowIso };
