/* global process */

// plan-26 Task4 (part A): immutable snapshot + annotated tag.
// Test-first: RED fixtures exercise createCandidate/resumeCandidate and the
// atomic ref CAS helpers against disposable git worktree/bare fixtures only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  casCreateRef,
  casDeleteRef,
  casUpdateRef,
  createCandidate,
  readRef,
  resumeCandidate,
} from './snapshot.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const CONFIG_PATH = join(REPO_ROOT, '.ebb', 'release-policy.json');

const ZERO = '0'.repeat(40);
const OP_A = '11111111-1111-4111-8111-111111111111';
const DEV_SHA = 'e'.repeat(40);

const COMMIT_INPUTS = Object.freeze({
  message: 'release snapshot 1.0.0',
  author: { name: 'Ebb Release Bot', email: 'release@ebb.local' },
  committer: { name: 'Ebb Release Bot', email: 'release@ebb.local' },
  timestamp: '2026-10-24T10:00:00.000Z',
});

function proof(overrides = {}) {
  return {
    version: '1.0.0',
    operationId: OP_A,
    reservedAt: '2026-10-24T09:00:00Z',
    developSha: DEV_SHA,
    recordHash: 'a'.repeat(64),
    ...overrides,
  };
}

function gitRun(cwd, args, env = {}) {
  return spawnSync('git', ['-c', 'core.hooksPath=', ...args], {
    cwd,
    encoding: 'utf8',
    shell: false,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@ebb.local',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@ebb.local',
      ...env,
    },
  });
}

async function makeWorkRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'ebb-snap-wk-'));
  const init = gitRun(dir, ['init', '-b', 'develop']);
  assert.equal(init.status, 0, init.stderr);
  await writeFile(join(dir, 'README.md'), 'root\n');
  await writeFile(join(dir, 'version.txt'), '0.0.0\n');
  gitRun(dir, ['add', '.']);
  const commit = gitRun(dir, ['commit', '-m', 'initial']);
  assert.equal(commit.status, 0, commit.stderr);
  return dir;
}

async function makeBareRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'ebb-snap-bare-'));
  const init = gitRun(dir, ['init', '--bare']);
  assert.equal(init.status, 0, init.stderr);
  return dir;
}

function headSha(dir) {
  return gitRun(dir, ['rev-parse', 'HEAD']).stdout.trim();
}

function treeOf(dir, sha) {
  return gitRun(dir, ['rev-parse', `${sha}^{tree}`]).stdout.trim();
}

function commitParents(dir, sha) {
  const raw = gitRun(dir, ['cat-file', '-p', sha]).stdout;
  return raw
    .split('\n')
    .filter((line) => line.startsWith('parent '))
    .map((line) => line.slice('parent '.length).trim());
}

async function commitFile(dir, rel, content, message = 'change') {
  await writeFile(join(dir, rel), content);
  gitRun(dir, ['add', rel]);
  const commit = gitRun(dir, ['commit', '-m', message]);
  assert.equal(commit.status, 0, commit.stderr);
  return headSha(dir);
}

function pin(sourceSha, sourceTree, oldMaster = 'ABSENT') {
  return { sourceRef: 'refs/heads/develop', sourceSha, sourceTree, oldMaster };
}

function writeBlob(bare, content) {
  const run = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: bare, input: content, encoding: 'utf8', shell: false });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
}

function makeTree(bare, entries) {
  const input = entries.map((entry) => `${entry.mode} ${entry.type} ${entry.sha}\t${entry.path}`).join('\n') + '\n';
  const run = spawnSync('git', ['mktree'], { cwd: bare, input, encoding: 'utf8', shell: false });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
}

function makeRealCommit(bare, message) {
  const blob = writeBlob(bare, message);
  const tree = makeTree(bare, [{ mode: '100644', type: 'blob', sha: blob, path: 'file.txt' }]);
  const run = spawnSync('git', ['commit-tree', tree, '-m', message], {
    cwd: bare,
    encoding: 'utf8',
    shell: false,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@ebb.local',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@ebb.local',
    },
  });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
}

function assertBlocked(result, code) {
  assert.equal(result.valid, false, JSON.stringify(result));
  assert.ok(
    result.blockers.some((blocker) => blocker.code === code),
    `expected ${code}, got ${JSON.stringify(result.blockers)}`,
  );
}

let POLICY_CONFIG;

test('bootstrap policy config loads', async () => {
  POLICY_CONFIG = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
});

test('RED root candidate: ABSENT master → zero parents, tree equals source tree, readback matches', async () => {
  const repo = await makeWorkRepo();
  try {
    const sourceSha = headSha(repo);
    const sourceTree = treeOf(repo, sourceSha);
    const result = await createCandidate({
      gitDir: repo,
      config: POLICY_CONFIG,
      pinnedSource: pin(sourceSha, sourceTree),
      reservationProof: proof(),
      commitInputs: COMMIT_INPUTS,
    });
    assert.equal(result.valid, true, JSON.stringify(result.blockers));
    const candidate = result.candidate;
    assert.match(candidate.candidateSha, /^[0-9a-f]{40}$/);
    assert.equal(candidate.candidateTree, sourceTree);
    assert.equal(candidate.parent, null);
    assert.equal(candidate.annotatedTagObject.target, candidate.candidateSha);
    assert.match(candidate.annotatedTagObject.objectSha, /^[0-9a-f]{40}$/);
    assert.equal(treeOf(repo, candidate.candidateSha), sourceTree);
    assert.deepEqual(commitParents(repo, candidate.candidateSha), []);
    const tag = gitRun(repo, ['cat-file', 'tag', candidate.annotatedTagObject.objectSha]);
    assert.equal(tag.status, 0, tag.stderr);
    assert.ok(tag.stdout.includes(`object ${candidate.candidateSha}`));
    assert.ok(tag.stdout.includes('tag v1.0.0'));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('RED second snapshot pins previous master as exactly one parent; merge-shaped input rejected', async () => {
  const repo = await makeWorkRepo();
  try {
    const s1 = headSha(repo);
    const first = await createCandidate({
      gitDir: repo,
      config: POLICY_CONFIG,
      pinnedSource: pin(s1, treeOf(repo, s1)),
      reservationProof: proof(),
      commitInputs: COMMIT_INPUTS,
    });
    assert.equal(first.valid, true, JSON.stringify(first.blockers));

    const s2 = await commitFile(repo, 'README.md', 'v2\n');
    const t2 = treeOf(repo, s2);
    const second = await createCandidate({
      gitDir: repo,
      config: POLICY_CONFIG,
      pinnedSource: pin(s2, t2, first.candidate.candidateSha),
      reservationProof: proof({ version: '1.0.1' }),
      commitInputs: { ...COMMIT_INPUTS, message: 'release snapshot 1.0.1' },
    });
    assert.equal(second.valid, true, JSON.stringify(second.blockers));
    assert.equal(second.candidate.parent, first.candidate.candidateSha);
    assert.deepEqual(commitParents(repo, second.candidate.candidateSha), [first.candidate.candidateSha]);

    const mergeAttempt = await createCandidate({
      gitDir: repo,
      config: POLICY_CONFIG,
      pinnedSource: pin(s2, t2, [first.candidate.candidateSha, 'b'.repeat(40)]),
      reservationProof: proof({ version: '1.0.2' }),
      commitInputs: { ...COMMIT_INPUTS, message: 'merge release' },
    });
    assertBlocked(mergeAttempt, 'PINNED_SOURCE_OLD_MASTER');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('RED no tracked-file edits; README/version stamping never leaks into candidate tree', async () => {
  const repo = await makeWorkRepo();
  try {
    const s2 = await commitFile(repo, 'README.md', '# changed\n');
    const sourceSha = await commitFile(repo, 'version.txt', '1.0.0\n');
    const sourceTree = treeOf(repo, sourceSha);
    void s2;
    const result = await createCandidate({
      gitDir: repo,
      config: POLICY_CONFIG,
      pinnedSource: pin(sourceSha, sourceTree),
      reservationProof: proof({ version: '1.0.1' }),
      commitInputs: { ...COMMIT_INPUTS, timestamp: '2026-10-24T10:00:00.000Z' },
    });
    assert.equal(result.valid, true, JSON.stringify(result.blockers));
    assert.equal(result.candidate.candidateTree, sourceTree);
    assert.equal(treeOf(repo, result.candidate.candidateSha), sourceTree);
    const sourceLs = gitRun(repo, ['ls-tree', '-r', sourceTree]).stdout;
    const candidateLs = gitRun(repo, ['ls-tree', '-r', result.candidate.candidateSha]).stdout;
    assert.equal(candidateLs, sourceLs);
    assert.equal(gitRun(repo, ['status', '--porcelain']).stdout, '');
    const commit = gitRun(repo, ['cat-file', '-p', result.candidate.candidateSha]).stdout;
    assert.ok(commit.includes('source: refs/heads/develop ' + sourceSha));
    assert.ok(commit.includes('source-tree: ' + sourceTree));
    assert.ok(commit.includes('previous-master: ABSENT'));
    assert.ok(commit.includes('operation: ' + OP_A));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('RED source drift: claimed sourceTree differs from actual source commit tree → BLOCKED', async () => {
  const repo = await makeWorkRepo();
  try {
    const sourceSha = headSha(repo);
    const otherTree = treeOf(repo, sourceSha);
    const s2 = await commitFile(repo, 'version.txt', '1.0.0\n');
    const wrongTree = treeOf(repo, s2);
    assert.notEqual(otherTree, wrongTree);
    const result = await createCandidate({
      gitDir: repo,
      config: POLICY_CONFIG,
      pinnedSource: pin(sourceSha, wrongTree),
      reservationProof: proof(),
      commitInputs: COMMIT_INPUTS,
    });
    assertBlocked(result, 'TREE_MISMATCH');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('RED missing source object / missing oldMaster object → BLOCKED', async () => {
  const repo = await makeWorkRepo();
  try {
    const sourceSha = headSha(repo);
    const sourceTree = treeOf(repo, sourceSha);
    const missing = await createCandidate({
      gitDir: repo,
      config: POLICY_CONFIG,
      pinnedSource: pin('f'.repeat(40), sourceTree),
      reservationProof: proof(),
      commitInputs: COMMIT_INPUTS,
    });
    assertBlocked(missing, 'MISSING_SOURCE_OBJECT');

    const missingParent = await createCandidate({
      gitDir: repo,
      config: POLICY_CONFIG,
      pinnedSource: pin(sourceSha, sourceTree, 'f'.repeat(40)),
      reservationProof: proof({ version: '1.0.1' }),
      commitInputs: { ...COMMIT_INPUTS, message: 'release snapshot 1.0.1' },
    });
    assertBlocked(missingParent, 'MISSING_OLD_MASTER_OBJECT');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('RED deterministic IDs: identical persisted inputs produce identical candidate/tag SHAs', async () => {
  const repo = await makeWorkRepo();
  try {
    const sourceSha = headSha(repo);
    const sourceTree = treeOf(repo, sourceSha);
    const first = await createCandidate({
      gitDir: repo,
      config: POLICY_CONFIG,
      pinnedSource: pin(sourceSha, sourceTree),
      reservationProof: proof(),
      commitInputs: COMMIT_INPUTS,
    });
    const second = await createCandidate({
      gitDir: repo,
      config: POLICY_CONFIG,
      pinnedSource: pin(sourceSha, sourceTree),
      reservationProof: proof(),
      commitInputs: COMMIT_INPUTS,
    });
    assert.equal(first.valid, true, JSON.stringify(first.blockers));
    assert.equal(second.valid, true, JSON.stringify(second.blockers));
    assert.equal(second.candidate.candidateSha, first.candidate.candidateSha);
    assert.equal(second.candidate.annotatedTagObject.objectSha, first.candidate.annotatedTagObject.objectSha);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('RED resume returns identical Candidate object when inputs unchanged', async () => {
  const repo = await makeWorkRepo();
  try {
    const sourceSha = headSha(repo);
    const sourceTree = treeOf(repo, sourceSha);
    const first = await createCandidate({
      gitDir: repo,
      config: POLICY_CONFIG,
      pinnedSource: pin(sourceSha, sourceTree),
      reservationProof: proof(),
      commitInputs: COMMIT_INPUTS,
    });
    assert.equal(first.valid, true, JSON.stringify(first.blockers));
    const resumed = await createCandidate({
      gitDir: repo,
      config: POLICY_CONFIG,
      pinnedSource: pin(sourceSha, sourceTree),
      reservationProof: proof(),
      commitInputs: COMMIT_INPUTS,
      existing: first.candidate,
    });
    assert.equal(resumed.valid, true, JSON.stringify(resumed.blockers));
    assert.deepEqual(resumed.candidate, first.candidate);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('RED resumed timestamp must not silently create a new identity → BLOCKED', async () => {
  const repo = await makeWorkRepo();
  try {
    const sourceSha = headSha(repo);
    const sourceTree = treeOf(repo, sourceSha);
    const first = await createCandidate({
      gitDir: repo,
      config: POLICY_CONFIG,
      pinnedSource: pin(sourceSha, sourceTree),
      reservationProof: proof(),
      commitInputs: COMMIT_INPUTS,
    });
    assert.equal(first.valid, true, JSON.stringify(first.blockers));
    const later = await createCandidate({
      gitDir: repo,
      config: POLICY_CONFIG,
      pinnedSource: pin(sourceSha, sourceTree),
      reservationProof: proof(),
      commitInputs: { ...COMMIT_INPUTS, timestamp: '2026-10-25T10:00:00.000Z' },
      existing: first.candidate,
    });
    assertBlocked(later, 'CANDIDATE_INPUTS_CONFLICT');
    assert.equal(later.candidate, undefined);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('RED wrong annotated tag target detected on verify/resume', async () => {
  const repo = await makeWorkRepo();
  try {
    const sourceSha = headSha(repo);
    const sourceTree = treeOf(repo, sourceSha);
    const first = await createCandidate({
      gitDir: repo,
      config: POLICY_CONFIG,
      pinnedSource: pin(sourceSha, sourceTree),
      reservationProof: proof(),
      commitInputs: COMMIT_INPUTS,
    });
    assert.equal(first.valid, true, JSON.stringify(first.blockers));
    const tampered = {
      ...first.candidate,
      annotatedTagObject: { ...first.candidate.annotatedTagObject, target: 'd'.repeat(40) },
    };
    const resumed = await createCandidate({
      gitDir: repo,
      config: POLICY_CONFIG,
      pinnedSource: pin(sourceSha, sourceTree),
      reservationProof: proof(),
      commitInputs: COMMIT_INPUTS,
      existing: tampered,
    });
    assertBlocked(resumed, 'CANDIDATE_TAG_TARGET_MISMATCH');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('RED tag object carries version/source/previous-master/operation metadata', async () => {
  const repo = await makeWorkRepo();
  try {
    const sourceSha = headSha(repo);
    const sourceTree = treeOf(repo, sourceSha);
    const result = await createCandidate({
      gitDir: repo,
      config: POLICY_CONFIG,
      pinnedSource: pin(sourceSha, sourceTree),
      reservationProof: proof(),
      commitInputs: COMMIT_INPUTS,
    });
    assert.equal(result.valid, true, JSON.stringify(result.blockers));
    const tag = gitRun(repo, ['cat-file', 'tag', result.candidate.annotatedTagObject.objectSha]).stdout;
    assert.ok(tag.includes('tag v1.0.0'));
    assert.ok(tag.includes('source: refs/heads/develop ' + sourceSha));
    assert.ok(tag.includes('source-tree: ' + sourceTree));
    assert.ok(tag.includes('previous-master: ABSENT'));
    assert.ok(tag.includes('operation: ' + OP_A));
    assert.ok(tag.includes('version: 1.0.0'));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('RED CAS: absent master creation succeeds; duplicate creation refused', async () => {
  const bare = await makeBareRepo();
  try {
    const first = makeRealCommit(bare, 'release one');
    const second = makeRealCommit(bare, 'release two');
    const created = await casCreateRef({ gitDir: bare, ref: 'refs/heads/master', value: first });
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(await readRef({ gitDir: bare, ref: 'refs/heads/master' }), first);
    const dup = await casCreateRef({ gitDir: bare, ref: 'refs/heads/master', value: second });
    assert.equal(dup.ok, false);
    assert.equal(await readRef({ gitDir: bare, ref: 'refs/heads/master' }), first);
  } finally {
    await rm(bare, { recursive: true, force: true });
  }
});

test('RED CAS: stale lease refusal — updating with stale expected leaves ref unchanged', async () => {
  const bare = await makeBareRepo();
  try {
    const v1 = makeRealCommit(bare, 'v1');
    const v2 = makeRealCommit(bare, 'v2');
    const stale = makeRealCommit(bare, 'stale writer');
    assert.equal((await casCreateRef({ gitDir: bare, ref: 'refs/heads/master', value: v1 })).ok, true);
    assert.equal((await casUpdateRef({ gitDir: bare, ref: 'refs/heads/master', value: v2, expected: v1 })).ok, true);
    assert.equal(await readRef({ gitDir: bare, ref: 'refs/heads/master' }), v2);
    const refused = await casUpdateRef({ gitDir: bare, ref: 'refs/heads/master', value: stale, expected: v1 });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'CAS_REFUSED');
    assert.equal(await readRef({ gitDir: bare, ref: 'refs/heads/master' }), v2);
  } finally {
    await rm(bare, { recursive: true, force: true });
  }
});

test('RED CAS: root ref deletion removes master; later parent restore recreates via absent creation', async () => {
  const bare = await makeBareRepo();
  try {
    const root = makeRealCommit(bare, 'root');
    const later = makeRealCommit(bare, 'later');
    assert.equal((await casCreateRef({ gitDir: bare, ref: 'refs/heads/master', value: root })).ok, true);
    const deleted = await casDeleteRef({ gitDir: bare, ref: 'refs/heads/master', expected: root });
    assert.equal(deleted.ok, true, JSON.stringify(deleted));
    assert.equal(await readRef({ gitDir: bare, ref: 'refs/heads/master' }), null);
    const deleteStale = await casDeleteRef({ gitDir: bare, ref: 'refs/heads/master', expected: root });
    assert.equal(deleteStale.ok, false);
    const restored = await casCreateRef({ gitDir: bare, ref: 'refs/heads/master', value: later });
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.equal(await readRef({ gitDir: bare, ref: 'refs/heads/master' }), later);
    assert.equal(ZERO.length, 40);
  } finally {
    await rm(bare, { recursive: true, force: true });
  }
});

test('RED CAS: refused ref update never creates partial/anonymous ref state', async () => {
  const bare = await makeBareRepo();
  try {
    const v1 = makeRealCommit(bare, 'v1');
    const other = makeRealCommit(bare, 'other');
    assert.equal((await casCreateRef({ gitDir: bare, ref: 'refs/heads/master', value: v1 })).ok, true);
    const refused = await casUpdateRef({ gitDir: bare, ref: 'refs/heads/master', value: other, expected: ZERO });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'CAS_REFUSED');
    assert.equal(await readRef({ gitDir: bare, ref: 'refs/heads/master' }), v1);
  } finally {
    await rm(bare, { recursive: true, force: true });
  }
});

test('RED resumeCandidate rejects missing/unknown-state inputs without guessing', async () => {
  const repo = await makeWorkRepo();
  try {
    const sourceSha = headSha(repo);
    const sourceTree = treeOf(repo, sourceSha);
    const first = await createCandidate({
      gitDir: repo,
      config: POLICY_CONFIG,
      pinnedSource: pin(sourceSha, sourceTree),
      reservationProof: proof(),
      commitInputs: COMMIT_INPUTS,
    });
    assert.equal(first.valid, true, JSON.stringify(first.blockers));
    const noInputs = await resumeCandidate({ candidate: first.candidate, commitInputs: undefined });
    assert.equal(noInputs.valid, false);
    const changedInputs = await resumeCandidate({
      candidate: first.candidate,
      commitInputs: { ...COMMIT_INPUTS, message: 'different message' },
    });
    assert.equal(changedInputs.valid, false);
    assert.ok(changedInputs.blockers.some((b) => b.code === 'CANDIDATE_INPUTS_CONFLICT'));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
