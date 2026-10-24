/* global process, URL */

// plan-26 Task4 (part B): journal/checkpoint/lock/transfer.
// Test-first: RED fixtures for validated UUID paths, atomic writes, append-only
// events, monotonic stages, finite mutex wait, checksum backup/import, lost
// cache recovery and no-secret guarantees. All fixtures are disposable repos.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  acquireLock,
  appendEvent,
  atomicWriteJson,
  backupManifest,
  createBackup,
  importBackup,
  operationDir,
  readApproval,
  readEvents,
  readGates,
  readInventory,
  readState,
  recoverOperation,
  resolveCommonDir,
  safeError,
  storageRoot,
  transitionStage,
  validateOperationId,
  verifyIntegrity,
} from './journal.mjs';

const OP = '11111111-1111-4111-8111-111111111111';
const OP2 = '22222222-2222-4222-8222-222222222222';

const STATE = {
  schemaVersion: 1,
  operationId: OP,
  status: 'PREPARED',
  stage: 'prepared',
  createdAt: '2026-10-24T10:00:00.000Z',
  updatedAt: '2026-10-24T10:00:00.000Z',
  mode: 'publish',
};

function gitRun(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', shell: false });
}

async function makeGitRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'ebb-journal-'));
  const init = gitRun(dir, ['init', '-b', 'develop']);
  assert.equal(init.status, 0, init.stderr);
  return dir;
}

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'ebb-journal-tmp-'));
}

function fileOf(commonDir, operationId, name) {
  return join(commonDir, 'ebb-release', 'operations', operationId, name);
}

function assertBlockedByCode(result, code) {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.code, code, JSON.stringify(result));
}

test('validateOperationId accepts canonical lowercase RFC 4122 and rejects hostile path forms', () => {
  assert.equal(validateOperationId(OP), true);
  for (const bad of [
    '',
    '..',
    '../x',
    '..\\x',
    'C:foo',
    'c:\\windows\\system32',
    'x:y',
    'a'.repeat(36),
    '11111111-1111-0111-8111-111111111111',
    '11111111-1111-4111-7111-111111111111',
    '11111111-1111-4111-8111-11111111111g',
    'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
    'not-a-uuid',
    '11111111-1111-4111-8111-111111111111/../etc',
  ]) {
    assert.equal(validateOperationId(bad), false, String(bad));
  }
});

test('operationDir builds bounded roots under git-common-dir/ebb-release/operations/<uuid>', async () => {
  const repo = await makeGitRepo();
  try {
    const common = await resolveCommonDir({ cwd: repo });
    assert.ok(typeof common === 'string' && common.length > 0);
    const root = storageRoot({ commonDir: common });
    assert.ok(root.endsWith(join('ebb-release')));
    const { valid, path, blockers } = await operationDir({ commonDir: common, operationId: OP });
    assert.equal(valid, true, JSON.stringify(blockers));
    assert.equal(path, join(root, 'operations', OP));
    assert.ok(path.startsWith(root + sep));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('operationDir refuses symlink/junction escape from the operations root', async (t) => {
  const repo = await makeGitRepo();
  const outside = await tempDir();
  try {
    const common = await resolveCommonDir({ cwd: repo });
    const root = storageRoot({ commonDir: common });
    const ops = join(root, 'operations');
    await mkdir(ops, { recursive: true });
    await rm(ops, { recursive: true, force: true });
    try {
      await (await import('node:fs/promises')).symlink(outside, ops, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      t.skip(`symlink unavailable: ${error.message}`);
      return;
    }
    const { valid, blockers } = await operationDir({ commonDir: common, operationId: OP });
    assert.equal(valid, false);
    assert.ok(blockers.some((b) => b.code === 'PATH_ESCAPE'), JSON.stringify(blockers));
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('atomic write: crash-before-rename leaves original intact and tmp litter ignored', async () => {
  const repo = await makeGitRepo();
  try {
    const common = await resolveCommonDir({ cwd: repo });
    const first = await atomicWriteJson(fileOf(common, OP, 'state.json'), STATE);
    assert.equal(first.ok, true, JSON.stringify(first));
    const tmpLitter = fileOf(common, OP, 'state.json') + '.tmp-deadbeef';
    await writeFile(tmpLitter, 'partial garbage');
    const re = await readState({ commonDir: common, operationId: OP });
    assert.equal(re.ok, true, JSON.stringify(re));
    assert.deepEqual(re.state, STATE);
    await rm(tmpLitter, { force: true });
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('atomic write: crash-after-rename yields complete new content, no tmp remnants', async () => {
  const repo = await makeGitRepo();
  try {
    const common = await resolveCommonDir({ cwd: repo });
    await atomicWriteJson(fileOf(common, OP, 'state.json'), STATE);
    const next = { ...STATE, status: 'PUBLISHED', stage: 'published', updatedAt: '2026-10-24T11:00:00.000Z' };
    const written = await atomicWriteJson(fileOf(common, OP, 'state.json'), next);
    assert.equal(written.ok, true);
    const re = await readState({ commonDir: common, operationId: OP });
    assert.equal(re.ok, true, JSON.stringify(re));
    assert.deepEqual(re.state, next);
    const dirEntries = await (await import('node:fs/promises')).readdir(join(common, 'ebb-release', 'operations', OP));
    assert.ok(!dirEntries.some((entry) => entry.includes('.tmp-')));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('state integrity: truncated/tampered JSON fail closed', async () => {
  const repo = await makeGitRepo();
  try {
    const common = await resolveCommonDir({ cwd: repo });
    const statePath = fileOf(common, OP, 'state.json');
    await atomicWriteJson(statePath, STATE);
    await writeFile(statePath, '{"schemaVersion": 1, "oper');
    assertBlockedByCode(await readState({ commonDir: common, operationId: OP }), 'STATE_INTEGRITY');
    await writeFile(statePath, '{"schemaVersion": 99, "operationId": "' + OP + '", "status": "PREPARED", "stage": "prepared"}');
    assertBlockedByCode(await readState({ commonDir: common, operationId: OP }), 'STATE_SCHEMA_VERSION');
    await writeFile(statePath, JSON.stringify({ ...STATE, operationId: OP2 }));
    assertBlockedByCode(await readState({ commonDir: common, operationId: OP }), 'STATE_OPERATION_ID_MISMATCH');
    await writeFile(statePath, JSON.stringify({ ...STATE, stage: 'bogus' }));
    assertBlockedByCode(await readState({ commonDir: common, operationId: OP }), 'STATE_STAGE');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('events are append-only with monotonic seq and intent/result kinds', async () => {
  const repo = await makeGitRepo();
  try {
    const common = await resolveCommonDir({ cwd: repo });
    const e1 = await appendEvent({
      commonDir: common,
      operationId: OP,
      kind: 'intent',
      event: 'publish.request',
      payload: { version: '1.0.0' },
    });
    assert.equal(e1.ok, true, JSON.stringify(e1));
    assert.equal(e1.seq, 1);
    const e2 = await appendEvent({
      commonDir: common,
      operationId: OP,
      kind: 'result',
      event: 'publish.response',
      payload: { status: 'ok' },
    });
    assert.equal(e2.seq, 2);
    const read = await readEvents({ commonDir: common, operationId: OP });
    assert.equal(read.ok, true, JSON.stringify(read));
    assert.deepEqual(read.events.map((e) => e.seq), [1, 2]);
    assert.equal(read.events[0].kind, 'intent');
    assert.equal(read.events[1].kind, 'result');
    assert.equal(read.events[0].event, 'publish.request');
    const badKind = await appendEvent({ commonDir: common, operationId: OP, kind: 'hack', event: 'x' });
    assertBlockedByCode(badKind, 'EVENT_KIND');
    const eventsPath = fileOf(common, OP, 'events.jsonl');
    const lines = (await readFile(eventsPath, 'utf8')).trim().split('\n');
    await writeFile(eventsPath, `${lines[1]}\n${lines[0]}\n`);
    assertBlockedByCode(await readEvents({ commonDir: common, operationId: OP }), 'EVENTS_SEQ');
    await writeFile(eventsPath, `${lines[0]}\n${lines[0]}\n`);
    assertBlockedByCode(await readEvents({ commonDir: common, operationId: OP }), 'EVENTS_SEQ');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('stage progression is monotonic; regression and unknown stages rejected', () => {
  const forward = transitionStage({ ...STATE, stage: 'prepared' }, 'validated');
  assert.equal(forward.ok, true, JSON.stringify(forward));
  assert.equal(forward.state.stage, 'validated');
  const regression = transitionStage({ ...STATE, stage: 'validated' }, 'prepared');
  assert.equal(regression.ok, false);
  assert.equal(regression.code, 'STAGE_REGRESSION');
  const unknown = transitionStage({ ...STATE, stage: 'prepared' }, 'nope');
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'STAGE_UNKNOWN');
  const jump = transitionStage({ ...STATE, stage: 'prepared' }, 'published');
  assert.equal(jump.ok, true, JSON.stringify(jump));
});

test('duplicate lock refused within finite wait; released lock can be re-acquired', async () => {
  const repo = await makeGitRepo();
  try {
    const common = await resolveCommonDir({ cwd: repo });
    const first = await acquireLock({ commonDir: common, operationId: OP, timeoutMs: 500 });
    assert.equal(first.held, true);
    const second = await acquireLock({ commonDir: common, operationId: OP, timeoutMs: 250 });
    assert.equal(second.held, false);
    assert.ok(second.code === 'LOCK_BUSY' || second.code === 'LOCK_STALE_NO_TERMINATION_EVIDENCE', second.code);
    await first.release();
    const third = await acquireLock({ commonDir: common, operationId: OP, timeoutMs: 500 });
    assert.equal(third.held, true, JSON.stringify(third));
    await third.release();
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('stale lock without owner-termination evidence is refused (no auto-break)', async () => {
  const repo = await makeGitRepo();
  try {
    const common = await resolveCommonDir({ cwd: repo });
    const lockPath = join(common, 'ebb-release', 'locks', `${OP}.lock`);
    await mkdir(dirname(lockPath), { recursive: true });
    const deadProbe = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8', shell: false });
    assert.equal(deadProbe.status, 0);
    await writeFile(
      lockPath,
      JSON.stringify({ operationId: OP, token: 'dead-token', pid: deadProbe.pid, host: 'ghost', acquiredAt: '2026-10-24T09:00:00Z' }),
    );
    const attempt = await acquireLock({ commonDir: common, operationId: OP, timeoutMs: 150 });
    assert.equal(attempt.held, false);
    assert.equal(attempt.code, 'LOCK_STALE_NO_TERMINATION_EVIDENCE');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('finite mutex wait succeeds when the holder releases during the wait', async () => {
  const repo = await makeGitRepo();
  try {
    const common = await resolveCommonDir({ cwd: repo });
    const moduleUrl = fileURLToPath(new URL('./journal.mjs', import.meta.url));
    const moduleHref = new URL(`file:///${moduleUrl.replace(/\\/g, '/')}`).href;
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { acquireLock } from ${JSON.stringify(moduleHref)};
         const l = await acquireLock({ commonDir: process.env.EBB_COMMON, operationId: process.env.EBB_OP, timeoutMs: 2000 });
         if (!l.held) process.exit(3);
         setTimeout(() => l.release(), 400);`,
      ],
      { encoding: 'utf8', shell: false, env: { ...process.env, EBB_COMMON: common, EBB_OP: OP } },
    );
    assert.equal(child.status, 0, child.stderr);
    const acquired = await acquireLock({ commonDir: common, operationId: OP, timeoutMs: 5000 });
    assert.equal(acquired.held, true, JSON.stringify(acquired));
    await acquired.release();
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('backup manifest + safe importer restore cache deterministically', async () => {
  const repo = await makeGitRepo();
  try {
    const common = await resolveCommonDir({ cwd: repo });
    await atomicWriteJson(fileOf(common, OP, 'state.json'), STATE);
    await appendEvent({ commonDir: common, operationId: OP, kind: 'intent', event: 'publish.request' });
    await atomicWriteJson(fileOf(common, OP, 'inventory.json'), { schemaVersion: 1, operationId: OP, items: [] });
    const backed = await createBackup({ commonDir: common, operationId: OP });
    assert.equal(backed.ok, true, JSON.stringify(backed));
    const manifest = await backupManifest({ commonDir: common, operationId: OP });
    assert.equal(manifest.ok, true, JSON.stringify(manifest));
    assert.equal(Object.keys(manifest.manifest.files).length, 3);

    const stateBefore = await readFile(fileOf(common, OP, 'state.json'), 'utf8');
    const eventsBefore = await readFile(fileOf(common, OP, 'events.jsonl'), 'utf8');
    await rm(join(common, 'ebb-release', 'operations', OP), { recursive: true, force: true });

    const integrity = await verifyIntegrity({ commonDir: common, operationId: OP });
    assert.equal(integrity.ok, false);
    assert.equal(integrity.code, 'CACHE_MISSING');

    const recovered = await recoverOperation({ commonDir: common, operationId: OP });
    assert.equal(recovered.status, 'restored', JSON.stringify(recovered));
    assert.equal(await readFile(fileOf(common, OP, 'state.json'), 'utf8'), stateBefore);
    assert.equal(await readFile(fileOf(common, OP, 'events.jsonl'), 'utf8'), eventsBefore);

    const ver = await verifyIntegrity({ commonDir: common, operationId: OP });
    assert.equal(ver.ok, true, JSON.stringify(ver));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('checkpoint deletion followed by guessed resume → BLOCKED ambiguity (no guessed state)', async () => {
  const repo = await makeGitRepo();
  try {
    const common = await resolveCommonDir({ cwd: repo });
    await atomicWriteJson(fileOf(common, OP, 'state.json'), STATE);
    await appendEvent({ commonDir: common, operationId: OP, kind: 'intent', event: 'publish.request' });
    await rm(fileOf(common, OP, 'state.json'), { force: true });
    const recovered = await recoverOperation({ commonDir: common, operationId: OP });
    assert.equal(recovered.status, 'blocked');
    assert.equal(recovered.code, 'AMBIGUOUS_CACHE');
    assert.equal(recovered.state, undefined);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('corrupt checksum manifest refuses import; no partial restoration', async () => {
  const repo = await makeGitRepo();
  try {
    const common = await resolveCommonDir({ cwd: repo });
    await atomicWriteJson(fileOf(common, OP, 'state.json'), STATE);
    await appendEvent({ commonDir: common, operationId: OP, kind: 'intent', event: 'publish.request' });
    await createBackup({ commonDir: common, operationId: OP });
    const manifestPath = join(common, 'ebb-release', 'backup', `${OP}-manifest.json`);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const firstFile = Object.keys(manifest.files)[0];
    manifest.files[firstFile].sha256 = 'f'.repeat(64);
    await writeFile(manifestPath, JSON.stringify(manifest));
    await rm(join(common, 'ebb-release', 'operations', OP), { recursive: true, force: true });
    const imp = await importBackup({ commonDir: common, operationId: OP });
    assert.equal(imp.ok, false);
    assert.equal(imp.code, 'BACKUP_CHECKSUM_MISMATCH');
    const stillMissing = await recoverOperation({ commonDir: common, operationId: OP });
    assert.equal(stillMissing.status, 'blocked');
    assert.ok(['AMBIGUOUS_CACHE', 'CACHE_ABSENT', 'BACKUP_CHECKSUM_MISMATCH'].includes(stillMissing.code), stillMissing.code);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('no secrets are ever written to journal files or leaked in error output', async () => {
  const repo = await makeGitRepo();
  const secret = 'super-secret-e2e-value-987654';
  process.env.EBB_TEST_SECRET = secret;
  try {
    const common = await resolveCommonDir({ cwd: repo });
    await atomicWriteJson(fileOf(common, OP, 'state.json'), STATE);
    const boom = new Error(`remote refused: ${secret}`);
    await appendEvent({ commonDir: common, operationId: OP, kind: 'result', event: 'publish.response', payload: { error: safeError(boom) } });
    const safe = safeError(boom);
    assert.ok(!safe.message.includes(secret));
    assert.ok(safe.message.includes('<redacted>'));
    const all = [
      await readFile(fileOf(common, OP, 'state.json'), 'utf8'),
      await readFile(fileOf(common, OP, 'events.jsonl'), 'utf8'),
    ].join('\n');
    assert.ok(!all.includes(secret));
    assert.ok(!safe.message.includes(process.env.PATH?.slice(0, 12) ?? ''));
  } finally {
    delete process.env.EBB_TEST_SECRET;
    await rm(repo, { recursive: true, force: true });
  }
});

test('not files must be exactly the five named journal files; readers validate schema/owner', async () => {
  const repo = await makeGitRepo();
  try {
    const common = await resolveCommonDir({ cwd: repo });
    await atomicWriteJson(fileOf(common, OP, 'state.json'), STATE);
    await appendEvent({ commonDir: common, operationId: OP, kind: 'intent', event: 'publish.request' });
    await atomicWriteJson(fileOf(common, OP, 'inventory.json'), { schemaVersion: 1, operationId: OP, items: [] });
    await atomicWriteJson(fileOf(common, OP, 'gates.json'), { schemaVersion: 1, operationId: OP, gates: [] });
    await atomicWriteJson(fileOf(common, OP, 'approval.json'), { schemaVersion: 1, operationId: OP, approval: null });
    const inv = await readInventory({ commonDir: common, operationId: OP });
    const gates = await readGates({ commonDir: common, operationId: OP });
    const approval = await readApproval({ commonDir: common, operationId: OP });
    assert.equal(inv.ok, true, JSON.stringify(inv));
    assert.equal(gates.ok, true, JSON.stringify(gates));
    assert.equal(approval.ok, true, JSON.stringify(approval));
    const entries = await (await import('node:fs/promises')).readdir(join(common, 'ebb-release', 'operations', OP));
    assert.deepEqual(entries.sort(), ['approval.json', 'events.jsonl', 'gates.json', 'inventory.json', 'state.json']);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
