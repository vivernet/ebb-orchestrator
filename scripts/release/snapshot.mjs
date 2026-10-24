/* global process, structuredClone */

// plan-26 Task4 (part A): immutable snapshot + annotated tag (pure producer).
// Given a validated PolicyV1 + PinnedSource + ReservationProof + persisted
// commit inputs, produces a Candidate and an annotated tag object via raw git
// plumbing (`git commit-tree` / `git mktag`) on the exact source tree with
// 0/1 parents. Never edits tracked files, never touches remotes, never writes
// secrets. Atomic ref compare-and-swap helpers are included for the local
// publication boundary (remote serialization belongs to Task8).

import { spawnSync } from 'node:child_process';
import { canonicalJson, FULL_SHA_PATTERN, validateConfig } from './policy.mjs';
import { validateReservationProof } from './version-reservations.mjs';

export const ABSENT = 'ABSENT';

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ZERO40 = '0'.repeat(40);
const REF_RE = /^refs\/[A-Za-z0-9._/-]+$/;

class GitError extends Error {
  constructor(code, detail) {
    super(detail);
    this.name = 'GitError';
    this.code = code;
  }
}

function gitRun(gitDir, args, { input, env } = {}) {
  const result = spawnSync('git', ['-c', 'core.hooksPath=', ...args], {
    cwd: gitDir,
    encoding: 'utf8',
    shell: false,
    input,
    env: { ...process.env, ...env },
  });
  if (result.error) {
    throw new GitError('GIT_SPAWN_FAILED', String(result.error.message));
  }
  return result;
}

function isFullSha(value) {
  return typeof value === 'string' && FULL_SHA_PATTERN.test(value);
}

function isValidTimestamp(value) {
  if (typeof value !== 'string' || !TIMESTAMP_RE.test(value)) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const iso = date.toISOString();
  return value.includes('.') ? iso === value : iso === `${value.slice(0, -1)}.000Z`;
}

function epochSeconds(timestamp) {
  return Math.floor(Date.parse(timestamp) / 1000);
}

function nowIso() {
  return new Date().toISOString();
}

function sameInputs(a, b) {
  return canonicalJson(a) === canonicalJson(b);
}

function failList(...blockers) {
  return { valid: false, blockers };
}

// --- validation -------------------------------------------------------------

export function validatePinnedSource(pinnedSource) {
  if (!pinnedSource || typeof pinnedSource !== 'object' || Array.isArray(pinnedSource)) {
    return failList({ code: 'PINNED_SOURCE_SHAPE', field: 'pinnedSource', detail: 'pinned source must be a JSON object' });
  }
  const blockers = [];
  const fail = (code, field, detail) => blockers.push({ code, field, detail });
  if (typeof pinnedSource.sourceRef !== 'string' || !pinnedSource.sourceRef.startsWith('refs/')) {
    fail('PINNED_SOURCE_REF', 'sourceRef', 'sourceRef must be a refs/ ref');
  }
  if (!isFullSha(pinnedSource.sourceSha)) {
    fail('PINNED_SOURCE_SHA', 'sourceSha', 'sourceSha must be a full 40-hex commit SHA');
  }
  if (!isFullSha(pinnedSource.sourceTree)) {
    fail('PINNED_SOURCE_TREE', 'sourceTree', 'sourceTree must be a full 40-hex tree SHA');
  }
  if (pinnedSource.oldMaster === ABSENT) {
    // root release: no parent
  } else if (isFullSha(pinnedSource.oldMaster)) {
    // later release: exactly one parent = pinned previous master
  } else {
    fail('PINNED_SOURCE_OLD_MASTER', 'oldMaster', 'oldMaster must be ABSENT or a full 40-hex commit SHA; release commits are root or single-parent only');
  }
  return { valid: blockers.length === 0, blockers };
}

function hasControlChars(message) {
  for (let i = 0; i < message.length; i += 1) {
    const code = message.charCodeAt(i);
    if (code === 0x0a) continue; // newline is allowed
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function validateCommitInputs(commitInputs) {
  if (!commitInputs || typeof commitInputs !== 'object' || Array.isArray(commitInputs)) {
    return failList({ code: 'COMMIT_INPUTS_SHAPE', field: 'commitInputs', detail: 'commit inputs must be a JSON object' });
  }
  const blockers = [];
  const fail = (code, field, detail) => blockers.push({ code, field, detail });
  if (typeof commitInputs.message !== 'string' || commitInputs.message.trim().length === 0) {
    fail('COMMIT_INPUTS_MESSAGE', 'message', 'non-empty commit message required');
  } else if (hasControlChars(commitInputs.message)) {
    fail('COMMIT_INPUTS_MESSAGE', 'message', 'commit message must not contain control characters');
  }
  if (!isValidTimestamp(commitInputs.timestamp)) {
    fail('COMMIT_INPUTS_TIMESTAMP', 'timestamp', `"${commitInputs.timestamp}" is not a valid UTC ISO-8601 timestamp`);
  }
  for (const role of ['author', 'committer']) {
    const identity = commitInputs[role];
    if (!identity || typeof identity !== 'object' || typeof identity.name !== 'string' || identity.name.length === 0 || /[\n\r]/.test(identity.name)) {
      fail('COMMIT_INPUTS_IDENTITY', role, `${role}.name must be a non-empty string without newlines`);
    }
    if (typeof identity.email !== 'string' || !EMAIL_RE.test(identity.email)) {
      fail('COMMIT_INPUTS_IDENTITY', role, `${role}.email must be a valid email address`);
    }
  }
  return { valid: blockers.length === 0, blockers };
}

export function validateSnapshotRequest({ config, pinnedSource, reservationProof, commitInputs }) {
  const blockers = [];
  const configResult = validateConfig(config);
  if (!configResult.valid) {
    for (const blocker of configResult.blockers) blockers.push({ ...blocker, field: `config.${blocker.field}` });
  }
  const pinned = validatePinnedSource(pinnedSource);
  for (const blocker of pinned.blockers) blockers.push(blocker);
  const proof = validateReservationProof(reservationProof, { sourceSha: pinnedSource?.sourceSha });
  for (const blocker of proof.blockers) blockers.push({ ...blocker, field: `reservationProof.${blocker.field}` });
  const inputs = validateCommitInputs(commitInputs);
  for (const blocker of inputs.blockers) blockers.push(blocker);
  if (pinned.valid && proof.valid) {
    if (pinnedSource.oldMaster !== ABSENT && pinnedSource.oldMaster === pinnedSource.sourceSha) {
      blockers.push({ code: 'PINNED_SOURCE_CIRCULAR_OLD_MASTER', field: 'oldMaster', detail: 'old master cannot equal the source commit' });
    }
  }
  return { valid: blockers.length === 0, blockers };
}

// --- object database verification ------------------------------------------

export async function verifySourceObjects({ gitDir, pinnedSource }) {
  const pinned = validatePinnedSource(pinnedSource);
  if (!pinned.valid) return pinned;
  const treeRun = gitRun(gitDir, ['rev-parse', '--verify', '--quiet', `${pinnedSource.sourceSha}^{tree}`]);
  if (treeRun.status !== 0) {
    return failList({ code: 'MISSING_SOURCE_OBJECT', field: 'sourceSha', detail: `source commit ${pinnedSource.sourceSha} is not present in the object database` });
  }
  const actualTree = treeRun.stdout.trim();
  if (actualTree !== pinnedSource.sourceTree) {
    return failList({ code: 'TREE_MISMATCH', field: 'sourceTree', detail: `source commit tree ${actualTree} differs from pinned source tree ${pinnedSource.sourceTree}` });
  }
  if (pinnedSource.oldMaster !== ABSENT) {
    const typeRun = gitRun(gitDir, ['cat-file', '-t', pinnedSource.oldMaster]);
    if (typeRun.status !== 0 || typeRun.stdout.trim() !== 'commit') {
      return failList({ code: 'MISSING_OLD_MASTER_OBJECT', field: 'oldMaster', detail: `pinned previous master ${pinnedSource.oldMaster} is not a commit object` });
    }
  }
  return { valid: true, blockers: [] };
}

// --- commit/tag construction ------------------------------------------------

function commitMessageFor({ version, pinnedSource, reservationProof }) {
  const lines = [
    `release snapshot ${version}`,
    '',
    `source: ${pinnedSource.sourceRef} ${pinnedSource.sourceSha}`,
    `source-tree: ${pinnedSource.sourceTree}`,
    `previous-master: ${pinnedSource.oldMaster}`,
    `version: ${version}`,
    `operation: ${reservationProof.operationId}`,
    `reservation-hash: ${reservationProof.recordHash}`,
  ];
  return lines.join('\n');
}

function commitEnvFor(commitInputs) {
  const epoch = epochSeconds(commitInputs.timestamp);
  return {
    GIT_AUTHOR_NAME: commitInputs.author.name,
    GIT_AUTHOR_EMAIL: commitInputs.author.email,
    GIT_AUTHOR_DATE: `${epoch} +0000`,
    GIT_COMMITTER_NAME: commitInputs.committer.name,
    GIT_COMMITTER_EMAIL: commitInputs.committer.email,
    GIT_COMMITTER_DATE: `${epoch} +0000`,
  };
}

function makeCommit(gitDir, { tree, parent, message, env }) {
  const args = ['commit-tree', tree];
  if (parent) args.push('-p', parent);
  args.push('-m', message);
  const run = gitRun(gitDir, args, { env });
  if (run.status !== 0) throw new GitError('COMMIT_TREE_FAILED', run.stderr.trim() || run.stdout.trim());
  return run.stdout.trim();
}

function makeAnnotatedTag(gitDir, { target, version, message, commitInputs }) {
  const epoch = epochSeconds(commitInputs.timestamp);
  const taggerName = commitInputs.committer.name;
  const taggerEmail = commitInputs.committer.email;
  const content = [
    `object ${target}`,
    'type commit',
    `tag v${version}`,
    `tagger ${taggerName} <${taggerEmail}> ${epoch} +0000`,
    '',
    message,
    '',
  ].join('\n');
  const run = gitRun(gitDir, ['mktag'], { input: content, env: commitEnvFor(commitInputs) });
  if (run.status !== 0) throw new GitError('MKTAG_FAILED', run.stderr.trim() || run.stdout.trim());
  return {
    objectSha: run.stdout.trim(),
    target,
    type: 'commit',
    name: `v${version}`,
    tagger: { name: taggerName, email: taggerEmail, when: commitInputs.timestamp },
    message,
  };
}

function buildCandidate({ gitDir, pinnedSource, reservationProof, commitInputs }) {
  const parent = pinnedSource.oldMaster === ABSENT ? null : pinnedSource.oldMaster;
  const message = commitMessageFor({ version: reservationProof.version, pinnedSource, reservationProof });
  const env = commitEnvFor(commitInputs);
  const candidateSha = makeCommit(gitDir, { tree: pinnedSource.sourceTree, parent, message, env });
  const annotatedTagObject = makeAnnotatedTag(gitDir, {
    target: candidateSha,
    version: reservationProof.version,
    message,
    commitInputs,
  });
  return {
    candidateSha,
    candidateTree: pinnedSource.sourceTree,
    parent,
    commitInputs: structuredClone(commitInputs),
    annotatedTagObject,
  };
}

// --- public API --------------------------------------------------------------

export async function createCandidate({ gitDir, config, pinnedSource, reservationProof, commitInputs, existing }) {
  const request = validateSnapshotRequest({ config, pinnedSource, reservationProof, commitInputs });
  if (!request.valid) return request;
  const objects = await verifySourceObjects({ gitDir, pinnedSource });
  if (!objects.valid) return objects;

  if (existing) {
    const stored = existing.commitInputs;
    if (!stored || typeof stored !== 'object' || !sameInputs(stored, commitInputs)) {
      return failList({
        code: 'CANDIDATE_INPUTS_CONFLICT',
        field: 'commitInputs',
        detail: 'resume requires the identical persisted commit inputs; a different timestamp/identity/message would silently mint a new identity',
      });
    }
  }

  const candidate = buildCandidate({ gitDir, pinnedSource, reservationProof, commitInputs });

  if (existing) {
    if (!isFullSha(existing.candidateSha) || existing.candidateSha !== candidate.candidateSha) {
      return failList({
        code: 'CANDIDATE_STATE_MISMATCH',
        field: 'candidateSha',
        detail: `resumed candidate SHA ${existing.candidateSha} does not match recomputed ${candidate.candidateSha}`,
      });
    }
    const tag = existing.annotatedTagObject;
    if (!tag || typeof tag !== 'object' || tag.target !== candidate.annotatedTagObject.target) {
      return failList({
        code: 'CANDIDATE_TAG_TARGET_MISMATCH',
        field: 'annotatedTagObject.target',
        detail: 'annotated tag must point at the candidate commit',
      });
    }
    return { valid: true, candidate: existing };
  }
  return { valid: true, candidate };
}

export async function resumeCandidate({ candidate, commitInputs, gitDir, pinnedSource, reservationProof }) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return failList({ code: 'CANDIDATE_SHAPE', field: 'candidate', detail: 'candidate must be a JSON object' });
  }
  if (!commitInputs || typeof commitInputs !== 'object' || !sameInputs(candidate.commitInputs, commitInputs)) {
    return failList({
      code: 'CANDIDATE_INPUTS_CONFLICT',
      field: 'commitInputs',
      detail: 'resume requires the exact persisted commit inputs; no new identity may be minted',
    });
  }
  if (gitDir) {
    if (!pinnedSource || !reservationProof) {
      return failList({ code: 'CANDIDATE_RESUME_CONTEXT', field: 'argv', detail: 'gitDir resume requires pinnedSource and reservationProof' });
    }
    const objects = await verifySourceObjects({ gitDir, pinnedSource });
    if (!objects.valid) return objects;
    const rebuilt = buildCandidate({ gitDir, pinnedSource, reservationProof, commitInputs });
    if (rebuilt.candidateSha !== candidate.candidateSha || rebuilt.annotatedTagObject.target !== candidate.annotatedTagObject.target) {
      return failList({ code: 'CANDIDATE_STATE_MISMATCH', field: 'candidateSha', detail: 'resumed candidate does not match the persisted identity' });
    }
    return { valid: true, candidate };
  }
  return { valid: true, candidate };
}

// --- atomic ref CAS (local publication boundary) ----------------------------

function validateRefArg(ref) {
  if (typeof ref !== 'string' || !REF_RE.test(ref)) {
    throw new GitError('CAS_REF_INVALID', `invalid ref ${JSON.stringify(ref)}`);
  }
  return ref;
}

export async function casCreateRef({ gitDir, ref, value }) {
  return casUpdateRef({ gitDir, ref, value, expected: ZERO40 });
}

export async function casUpdateRef({ gitDir, ref, value, expected }) {
  validateRefArg(ref);
  if (!isFullSha(value)) throw new GitError('CAS_VALUE_INVALID', 'CAS value must be a full 40-hex commit SHA');
  if (!isFullSha(expected)) throw new GitError('CAS_EXPECTED_INVALID', 'CAS expected must be a full 40-hex commit SHA (zero SHA for absent)');
  const run = gitRun(gitDir, ['update-ref', ref, value, expected]);
  if (run.status === 0) return { ok: true };
  return { ok: false, code: 'CAS_REFUSED', detail: run.stderr.trim() || 'compare-and-swap refused' };
}

export async function casDeleteRef({ gitDir, ref, expected }) {
  validateRefArg(ref);
  if (!isFullSha(expected)) throw new GitError('CAS_EXPECTED_INVALID', 'CAS expected must be a full 40-hex commit SHA');
  const run = gitRun(gitDir, ['update-ref', '-d', ref, expected]);
  if (run.status === 0) return { ok: true };
  return { ok: false, code: 'CAS_REFUSED', detail: run.stderr.trim() || 'ref deletion refused' };
}

export async function readRef({ gitDir, ref }) {
  validateRefArg(ref);
  const run = gitRun(gitDir, ['rev-parse', '--verify', '--quiet', ref]);
  if (run.status !== 0) return null;
  return run.stdout.trim();
}

export { nowIso };
