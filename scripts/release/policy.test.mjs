/* global process */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  FULL_SHA_PATTERN,
  SCHEMA_VERSION,
  canonicalJson,
  policyHashOf,
  runPolicyCheck,
  validateConfig,
  validateInput,
} from './policy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const CONFIG_PATH = join(REPO_ROOT, '.ebb', 'release-policy.json');
const POLICY_SCRIPT = join(HERE, 'policy.mjs');

const E = 'e'.repeat(40);
const F = 'f'.repeat(40);
const T = 't'.repeat(40);
const REMOTE = 'https://github.com/vivernet/ebb-orchestrator.git';
const REPO = { id: 1372710981, owner: 'vivernet', name: 'ebb-orchestrator', remote: REMOTE };

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepMerge(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) {
    return override === undefined ? base : override;
  }
  if (base && typeof base === 'object' && override && typeof override === 'object') {
    const out = { ...base };
    for (const key of Object.keys(override)) {
      out[key] = deepMerge(base[key], override[key]);
    }
    return out;
  }
  return override === undefined ? base : override;
}

let BOOTSTRAP_CONFIG;

function allConfiguredIds() {
  return BOOTSTRAP_CONFIG.gates.requiredPlatforms.map((platform) => platform.id);
}

function baseInput(overrides = {}) {
  const input = {
    schemaVersion: SCHEMA_VERSION,
    repository: { ...REPO },
    event: {
      type: 'push',
      ref: 'refs/heads/master',
      headSha: F,
      commit: {
        sha: F,
        parents: [],
        tree: T,
        message: 'release snapshot 1.0.0',
        provenance: { sourceSha: E, sourceTree: T, version: '1.0.0' },
      },
    },
    masterState: { exists: false, sha: null, releasesCount: 0 },
    version: '1.0.0',
    evidence: { platforms: allConfiguredIds().map((id) => ({ id })) },
  };
  return deepMerge(input, overrides);
}

function prInput(overrides = {}) {
  return deepMerge(
    {
      schemaVersion: SCHEMA_VERSION,
      repository: { ...REPO },
      event: { type: 'pull_request', ref: 'refs/pull/1/merge', baseRef: 'refs/heads/develop', headSha: F },
      version: null,
    },
    overrides,
  );
}

function makeBoundConfig() {
  const cfg = clone(BOOTSTRAP_CONFIG);
  cfg.bindingStatus = 'bound';
  cfg.trustedBindings.workflows['release-validation.yml'].fullSha = 'b'.repeat(40);
  cfg.trustedBindings.workflows['release-operations.yml'].fullSha = 'c'.repeat(40);
  cfg.trustedBindings.scriptBundle.fullSha = 'd'.repeat(40);
  cfg.pendingBindings = [];
  for (const platform of cfg.gates.requiredPlatforms) {
    platform.status = 'configured';
    delete platform.blocker;
    delete platform.producerTask;
  }
  return cfg;
}

test('bootstrap config loads from .ebb/release-policy.json', async () => {
  BOOTSTRAP_CONFIG = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
});

test('bootstrap config is schema-valid with pending bindings', () => {
  const result = validateConfig(BOOTSTRAP_CONFIG);
  assert.equal(result.valid, true, JSON.stringify(result.blockers));
  assert.equal(BOOTSTRAP_CONFIG.bindingStatus, 'pending');
  assert.ok(Array.isArray(BOOTSTRAP_CONFIG.pendingBindings) && BOOTSTRAP_CONFIG.pendingBindings.length > 0);
  assert.equal(BOOTSTRAP_CONFIG.repository.id, 1372710981);
  assert.equal(BOOTSTRAP_CONFIG.repository.owner, 'vivernet');
  assert.equal(BOOTSTRAP_CONFIG.repository.name, 'ebb-orchestrator');
  assert.equal(BOOTSTRAP_CONFIG.repository.remote, REMOTE);
  assert.equal(BOOTSTRAP_CONFIG.repository.defaultBranch, 'develop');
  assert.equal(BOOTSTRAP_CONFIG.repository.releaseBranch, 'refs/heads/master');
  assert.equal(BOOTSTRAP_CONFIG.mutationPolicy.requiresBindingStatus, 'bound');
});

test('pending trusted binding rejects placeholder full SHA', () => {
  const cfg = clone(BOOTSTRAP_CONFIG);
  cfg.trustedBindings.workflows['release-validation.yml'].fullSha = 'a'.repeat(40);
  const result = validateConfig(cfg);
  assert.equal(result.valid, false);
  assert.ok(result.blockers.some((blocker) => blocker.code === 'CONFIG_TRUSTED_BINDING_PLACEHOLDER'));
});

test('bound config requires full SHAs and empty pendingBindings', () => {
  const cfg = clone(BOOTSTRAP_CONFIG);
  cfg.bindingStatus = 'bound';
  const result = validateConfig(cfg);
  assert.equal(result.valid, false);
  assert.ok(result.blockers.some((blocker) => blocker.code === 'CONFIG_TRUSTED_BINDING_FULL_SHA'));
  assert.ok(result.blockers.some((blocker) => blocker.code === 'CONFIG_PENDING_BINDINGS_ON_BOUND'));
});

test('pendingBindings must resolve every pending trusted binding and blocked platform', () => {
  const cfg = clone(BOOTSTRAP_CONFIG);
  cfg.pendingBindings.pop();
  const result = validateConfig(cfg);
  assert.equal(result.valid, false);
  assert.ok(result.blockers.some((blocker) => blocker.code === 'CONFIG_PENDING_BINDING_UNRESOLVED'));
});

test('pendingBindings must not invent unknown fields', () => {
  const cfg = clone(BOOTSTRAP_CONFIG);
  cfg.pendingBindings.push({ field: 'invented.field', producerTask: 'TaskX', blocker: 'x' });
  const result = validateConfig(cfg);
  assert.equal(result.valid, false);
  assert.ok(result.blockers.some((blocker) => blocker.code === 'CONFIG_PENDING_BINDING_UNKNOWN'));
});

test('full SHA pattern accepts 40-hex and rejects short ids', () => {
  assert.equal(FULL_SHA_PATTERN.test('abc'), false);
  assert.equal(FULL_SHA_PATTERN.test('a'.repeat(40)), true);
});

test('check rejects malformed repository id', () => {
  for (const bad of [0, -1, '1372710981', null]) {
    const input = baseInput({ repository: { ...REPO, id: bad } });
    const result = validateInput(input, BOOTSTRAP_CONFIG);
    assert.equal(result.status, 'BLOCKED', String(bad));
    assert.ok(result.blockers.some((blocker) => blocker.code === 'REPO_IDENTITY_MISMATCH'), String(bad));
  }
});

test('check rejects remote mismatch', () => {
  const input = baseInput({ repository: { ...REPO, remote: 'https://github.com/other/orphan.git' } });
  const result = validateInput(input, BOOTSTRAP_CONFIG);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.blockers.some((blocker) => blocker.code === 'REPO_IDENTITY_MISMATCH' && blocker.field === 'repository.remote'));
});

test('SemVer encoding rejects prerelease/build/suffix encodings', () => {
  for (const version of ['1.2.3-beta.1', '1.2.3+build', '1.2.3.4', 'v1.2.3', '01.2.3', '1.2']) {
    const input = baseInput({ version });
    const result = validateInput(input, BOOTSTRAP_CONFIG);
    assert.equal(result.status, 'BLOCKED', version);
    assert.ok(result.blockers.some((blocker) => blocker.code === 'SEMVER_ENCODING_VIOLATION'), version);
  }
});

test('SemVer encoding accepts stable MAJOR.MINOR.PATCH only', () => {
  const result = validateInput(baseInput(), makeBoundConfig());
  assert.equal(result.status, 'PASS');
});

test('release path requires full configured gate platform coverage', () => {
  const input = baseInput({ evidence: { platforms: [{ id: 'unrelated-platform' }] } });
  const result = validateInput(input, BOOTSTRAP_CONFIG);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.blockers.some((blocker) => blocker.code === 'GATE_PLATFORM_COVERAGE'));
  assert.ok(result.blockers.some((blocker) => blocker.code === 'GATE_PLATFORM_BLOCKED'));
});

test('ordinary PR targeting master is forbidden', () => {
  const input = prInput({ event: { baseRef: 'refs/heads/master' } });
  const result = validateInput(input, BOOTSTRAP_CONFIG);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.blockers.some((blocker) => blocker.code === 'PR_BASE_MASTER_FORBIDDEN'));
});

test('ordinary PR targeting develop passes', () => {
  const result = validateInput(prInput(), BOOTSTRAP_CONFIG);
  assert.equal(result.status, 'PASS');
  assert.equal(result.exitCode, 0);
});

test('merge release commit rejected', () => {
  const input = baseInput({
    event: {
      commit: { sha: F, parents: [E, 'd'.repeat(40)], tree: T, message: 'merge', provenance: { sourceSha: E, sourceTree: T } },
    },
  });
  const result = validateInput(input, BOOTSTRAP_CONFIG);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.blockers.some((blocker) => blocker.code === 'MERGE_RELEASE_COMMIT_FORBIDDEN'));
});

test('dummy commit shape (tree mismatch) rejected', () => {
  const input = baseInput({
    event: {
      commit: { sha: F, parents: [], tree: 'x'.repeat(40), message: 'dummy', provenance: { sourceSha: E, sourceTree: T } },
    },
  });
  const result = validateInput(input, BOOTSTRAP_CONFIG);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.blockers.some((blocker) => blocker.code === 'TREE_MISMATCH'));
});

test('release commit without provenance rejected', () => {
  const input = baseInput();
  delete input.event.commit.provenance;
  const result = validateInput(input, BOOTSTRAP_CONFIG);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.blockers.some((blocker) => blocker.code === 'MISSING_PROVENANCE'));
});

test('absent master with zero releases accepted explicitly', () => {
  const result = validateInput(baseInput(), makeBoundConfig());
  assert.equal(result.status, 'PASS');
  assert.equal(result.exitCode, 0);
  assert.ok(result.notes.some((note) => note.startsWith('ABSENT_MASTER_ZERO_RELEASES_ACCEPTED')));
});

test('root commit on existing master rejected', () => {
  const input = baseInput({ masterState: { exists: true, sha: E, releasesCount: 1 } });
  const result = validateInput(input, BOOTSTRAP_CONFIG);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.blockers.some((blocker) => blocker.code === 'ROOT_LATER_PARENT_MISMATCH'));
});

test('single-parent commit without existing master rejected', () => {
  const input = baseInput({
    event: { commit: { sha: F, parents: [E], tree: T, message: 'later', provenance: { sourceSha: E, sourceTree: T } } },
  });
  const result = validateInput(input, BOOTSTRAP_CONFIG);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.blockers.some((blocker) => blocker.code === 'ROOT_LATER_PARENT_MISMATCH'));
});

test('single-parent commit must pin previous master', () => {
  const input = baseInput({
    masterState: { exists: true, sha: E, releasesCount: 1 },
    event: { commit: { sha: F, parents: ['b'.repeat(40)], tree: T, message: 'later', provenance: { sourceSha: E, sourceTree: T } } },
  });
  const result = validateInput(input, BOOTSTRAP_CONFIG);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.blockers.some((blocker) => blocker.code === 'ROOT_LATER_PARENT_MISMATCH'));
});

test('present master with zero releases is BLOCKED_LEGACY_MASTER', () => {
  const input = baseInput({ masterState: { exists: true, sha: E, releasesCount: 0 } });
  const result = validateInput(input, BOOTSTRAP_CONFIG);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.blockers.some((blocker) => blocker.code === 'BLOCKED_LEGACY_MASTER'));
});

test('mutation intent fails closed on pending bootstrap with named blockers', () => {
  const input = baseInput({ intent: 'publish' });
  const result = validateInput(input, BOOTSTRAP_CONFIG);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.blockers.some((blocker) => blocker.code === 'MUTATION_NOT_ALLOWED'));
  assert.ok(
    result.blockers.some(
      (blocker) => blocker.code === 'PENDING_TRUSTED_BINDING' && blocker.field === 'trustedBindings.workflows.release-operations.yml.fullSha',
    ),
  );
  assert.ok(
    result.blockers.some(
      (blocker) => blocker.code === 'PENDING_TRUSTED_BINDING' && blocker.field === 'trustedBindings.scriptBundle.fullSha',
    ),
  );
  assert.ok(result.blockers.some((blocker) => blocker.code === 'GATE_PLATFORM_BLOCKED'));
});

test('bound config permits mutation intent when gates covered', () => {
  const input = baseInput({ intent: 'publish' });
  const result = validateInput(input, makeBoundConfig());
  assert.equal(result.status, 'PASS');
  assert.equal(result.exitCode, 0);
});

test('policyHash is deterministic 64-hex sha256', () => {
  const first = policyHashOf(BOOTSTRAP_CONFIG);
  const second = policyHashOf(clone(BOOTSTRAP_CONFIG));
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, second);
  assert.equal(canonicalJson(BOOTSTRAP_CONFIG), canonicalJson(clone(BOOTSTRAP_CONFIG)));
});

test('runPolicyCheck returns typed report with hash and status', () => {
  const result = runPolicyCheck({ config: BOOTSTRAP_CONFIG, input: baseInput() });
  assert.equal(result.command, 'policy:check');
  assert.equal(result.mode, 'read-only');
  assert.match(result.policyHash, /^[0-9a-f]{64}$/);
  assert.equal(result.bindingStatus, 'pending');
  assert.ok(Array.isArray(result.blockers));
});

test('CLI check emits JSON report and exits nonzero on bootstrap blockers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ebb-policy-cli-'));
  try {
    const eventPath = join(dir, 'event.json');
    await writeFile(eventPath, JSON.stringify(baseInput()));
    const run = spawnSync(process.execPath, [POLICY_SCRIPT, 'check', '--event-file', eventPath], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    assert.equal(run.status, 1);
    const report = JSON.parse(run.stdout);
    assert.equal(report.command, 'policy:check');
    assert.equal(report.status, 'BLOCKED');
    assert.match(report.policyHash, /^[0-9a-f]{64}$/);
    assert.ok(report.blockers.length > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI rejects malformed event file with CONFIG_ERROR exit 2', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ebb-policy-cli-bad-'));
  try {
    const eventPath = join(dir, 'event.json');
    await writeFile(eventPath, 'not json {');
    const run = spawnSync(process.execPath, [POLICY_SCRIPT, 'check', '--event-file', eventPath], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    assert.equal(run.status, 2);
    const report = JSON.parse(run.stdout);
    assert.equal(report.status, 'CONFIG_ERROR');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
