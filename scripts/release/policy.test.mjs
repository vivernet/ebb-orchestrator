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

let CONFIG;

function allConfiguredIds() {
  return CONFIG.gates.requiredPlatforms.map((platform) => platform.id);
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
  const cfg = clone(CONFIG);
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

// Derived bootstrap-shape config (bindingStatus pending, structured null trusted
// full SHAs, trusted-binding entries restored) mirroring the pre-Task8 config
// that Task2 created.
function makePendingBootstrapConfig() {
  const cfg = clone(CONFIG);
  cfg.bindingStatus = 'pending';
  cfg.trustedBindings.workflows['release-validation.yml'].fullSha = null;
  cfg.trustedBindings.workflows['release-operations.yml'].fullSha = null;
  cfg.trustedBindings.scriptBundle.fullSha = null;
  cfg.pendingBindings = [
    { field: 'trustedBindings.workflows.release-validation.yml.fullSha', producerTask: 'Task8', blocker: 'release-validation.yml not created; Task8 must create + review + pin full commit SHA' },
    { field: 'trustedBindings.workflows.release-operations.yml.fullSha', producerTask: 'Task8', blocker: 'release-operations.yml not created; Task8 must create + review + pin full commit SHA' },
    { field: 'trustedBindings.scriptBundle.fullSha', producerTask: 'Task8', blocker: 'approved release script bundle full SHA pending until Task8 binding review' },
    ...cfg.pendingBindings.map((entry) => ({ ...entry })),
  ];
  return cfg;
}

test('release policy config loads from .ebb/release-policy.json', async () => {
  CONFIG = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
});

test('on-disk config is schema-valid: bound trusted bindings and platform-only pending entries', () => {
  const result = validateConfig(CONFIG);
  assert.equal(result.valid, true, JSON.stringify(result.blockers));
  assert.equal(CONFIG.bindingStatus, 'bound');
  const pendingFields = CONFIG.pendingBindings.map((entry) => entry.field);
  assert.deepEqual(
    [...pendingFields].sort(),
    [
      'gates.requiredPlatforms.governance-release-docker.status',
      'gates.requiredPlatforms.native-linux-node24-selfhosted.status',
    ],
  );
  for (const field of pendingFields) {
    assert.ok(field.startsWith('gates.requiredPlatforms.'), `unexpected pending field ${field}`);
    assert.ok(!field.startsWith('trustedBindings.'), `trusted-binding field must not remain pending: ${field}`);
  }
  for (const [name, binding] of Object.entries(CONFIG.trustedBindings.workflows)) {
    assert.equal(typeof binding.fullSha, 'string', `workflow ${name} must pin a full SHA`);
    assert.match(binding.fullSha, FULL_SHA_PATTERN);
    assert.equal(binding.bindingStatus, 'bound');
  }
  assert.equal(typeof CONFIG.trustedBindings.scriptBundle.fullSha, 'string');
  assert.match(CONFIG.trustedBindings.scriptBundle.fullSha, FULL_SHA_PATTERN);
  assert.equal(CONFIG.trustedBindings.scriptBundle.bindingStatus, 'bound');
  assert.equal(CONFIG.repository.id, 1372710981);
  assert.equal(CONFIG.repository.owner, 'vivernet');
  assert.equal(CONFIG.repository.name, 'ebb-orchestrator');
  assert.equal(CONFIG.repository.remote, REMOTE);
  assert.equal(CONFIG.repository.defaultBranch, 'develop');
  assert.equal(CONFIG.repository.releaseBranch, 'refs/heads/master');
  assert.equal(CONFIG.mutationPolicy.requiresBindingStatus, 'bound');
});

test('derived pending bootstrap config is schema-valid with pending bindings', () => {
  const cfg = makePendingBootstrapConfig();
  const result = validateConfig(cfg);
  assert.equal(result.valid, true, JSON.stringify(result.blockers));
  assert.equal(cfg.bindingStatus, 'pending');
  assert.ok(Array.isArray(cfg.pendingBindings) && cfg.pendingBindings.length > 0);
});

test('pending trusted binding rejects placeholder full SHA', () => {
  const cfg = makePendingBootstrapConfig();
  cfg.trustedBindings.workflows['release-validation.yml'].fullSha = 'a'.repeat(40);
  const result = validateConfig(cfg);
  assert.equal(result.valid, false);
  assert.ok(result.blockers.some((blocker) => blocker.code === 'CONFIG_TRUSTED_BINDING_PLACEHOLDER'));
});

test('bound config rejects null/placeholder trusted full SHAs', () => {
  const cfg = clone(CONFIG);
  cfg.trustedBindings.workflows['release-validation.yml'].fullSha = null;
  const result = validateConfig(cfg);
  assert.equal(result.valid, false);
  assert.ok(result.blockers.some((blocker) => blocker.code === 'CONFIG_TRUSTED_BINDING_FULL_SHA'));
});

test('bound config rejects trusted-field entries kept in pendingBindings', () => {
  const cfg = clone(CONFIG);
  cfg.pendingBindings.push({ field: 'trustedBindings.workflows.release-operations.yml.fullSha', producerTask: 'TaskX', blocker: 'must be resolved at bind time' });
  const result = validateConfig(cfg);
  assert.equal(result.valid, false);
  assert.ok(result.blockers.some((blocker) => blocker.code === 'CONFIG_PENDING_BINDINGS_ON_BOUND'));
});

test('pendingBindings must resolve every pending trusted binding and blocked platform', () => {
  const cfg = makePendingBootstrapConfig();
  cfg.pendingBindings.pop();
  const result = validateConfig(cfg);
  assert.equal(result.valid, false);
  assert.ok(result.blockers.some((blocker) => blocker.code === 'CONFIG_PENDING_BINDING_UNRESOLVED'));
});

test('bound config must keep a pending entry for every blocked platform', () => {
  const cfg = clone(CONFIG);
  cfg.pendingBindings.pop();
  const result = validateConfig(cfg);
  assert.equal(result.valid, false);
  assert.ok(result.blockers.some((blocker) => blocker.code === 'CONFIG_PENDING_BINDING_UNRESOLVED'));
});

test('pendingBindings must not invent unknown fields', () => {
  const cfg = makePendingBootstrapConfig();
  cfg.pendingBindings.push({ field: 'invented.field', producerTask: 'TaskX', blocker: 'x' });
  const result = validateConfig(cfg);
  assert.equal(result.valid, false);
  assert.ok(result.blockers.some((blocker) => blocker.code === 'CONFIG_PENDING_BINDING_UNKNOWN'));
});

test('full SHA pattern accepts 40-hex and rejects short ids', () => {
  assert.equal(FULL_SHA_PATTERN.test('abc'), false);
  assert.equal(FULL_SHA_PATTERN.test('a'.repeat(40)), true);
});

test('bound config pins match the reviewed workflow/script identities (exact git hashes)', () => {
  // Pins are blob/tree hashes of the reviewed HEAD tree — computed from git
  // HEAD itself, so the test is independent of working-tree state (shallow
  // fetch-safe) and never self-referential: the config lives outside
  // scripts/release and .github/workflows, so its own commit/tree is not part
  // of any pinned identity.
  const git = (args) => spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
  const validationBlob = git(['rev-parse', 'HEAD:.github/workflows/release-validation.yml']).stdout.trim();
  const operationsBlob = git(['rev-parse', 'HEAD:.github/workflows/release-operations.yml']).stdout.trim();
  const scriptTree = git(['rev-parse', 'HEAD:scripts/release']).stdout.trim();
  assert.equal(validationBlob.length, 40);
  assert.equal(operationsBlob.length, 40);
  assert.equal(scriptTree.length, 40);
  assert.equal(CONFIG.trustedBindings.workflows['release-validation.yml'].fullSha, validationBlob);
  assert.equal(CONFIG.trustedBindings.workflows['release-operations.yml'].fullSha, operationsBlob);
  assert.equal(CONFIG.trustedBindings.scriptBundle.fullSha, scriptTree);
});

test('bound config rejects tampered/mismatched pin identities (divergence is detectable)', () => {
  const tampered = clone(CONFIG);
  tampered.trustedBindings.workflows['release-validation.yml'].fullSha = '0'.repeat(39) + '1';
  const result = validateConfig(tampered);
  // format stays valid so divergence is caught by external identity evidence,
  // not by schema validation — assert the config no longer matches git reality
  assert.equal(result.valid, true);
  assert.notEqual(tampered.trustedBindings.workflows['release-validation.yml'].fullSha, CONFIG.trustedBindings.workflows['release-validation.yml'].fullSha);
});

test('check rejects malformed repository id', () => {
  for (const bad of [0, -1, '1372710981', null]) {
    const input = baseInput({ repository: { ...REPO, id: bad } });
    const result = validateInput(input, CONFIG);
    assert.equal(result.status, 'BLOCKED', String(bad));
    assert.ok(result.blockers.some((blocker) => blocker.code === 'REPO_IDENTITY_MISMATCH'), String(bad));
  }
});

test('check rejects remote mismatch', () => {
  const input = baseInput({ repository: { ...REPO, remote: 'https://github.com/other/orphan.git' } });
  const result = validateInput(input, CONFIG);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.blockers.some((blocker) => blocker.code === 'REPO_IDENTITY_MISMATCH' && blocker.field === 'repository.remote'));
});

test('SemVer encoding rejects prerelease/build/suffix encodings', () => {
  for (const version of ['1.2.3-beta.1', '1.2.3+build', '1.2.3.4', 'v1.2.3', '01.2.3', '1.2']) {
    const input = baseInput({ version });
    const result = validateInput(input, CONFIG);
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
  const result = validateInput(input, makePendingBootstrapConfig());
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.blockers.some((blocker) => blocker.code === 'GATE_PLATFORM_COVERAGE'));
  assert.ok(result.blockers.some((blocker) => blocker.code === 'GATE_PLATFORM_BLOCKED'));
});

test('ordinary PR targeting master is forbidden', () => {
  const input = prInput({ event: { baseRef: 'refs/heads/master' } });
  const result = validateInput(input, CONFIG);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.blockers.some((blocker) => blocker.code === 'PR_BASE_MASTER_FORBIDDEN'));
});

test('ordinary PR targeting develop passes', () => {
  const result = validateInput(prInput(), CONFIG);
  assert.equal(result.status, 'PASS');
  assert.equal(result.exitCode, 0);
});

test('merge release commit rejected', () => {
  const input = baseInput({
    event: {
      commit: { sha: F, parents: [E, 'd'.repeat(40)], tree: T, message: 'merge', provenance: { sourceSha: E, sourceTree: T } },
    },
  });
  const result = validateInput(input, CONFIG);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.blockers.some((blocker) => blocker.code === 'MERGE_RELEASE_COMMIT_FORBIDDEN'));
});

test('dummy commit shape (tree mismatch) rejected', () => {
  const input = baseInput({
    event: {
      commit: { sha: F, parents: [], tree: 'x'.repeat(40), message: 'dummy', provenance: { sourceSha: E, sourceTree: T } },
    },
  });
  const result = validateInput(input, CONFIG);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.blockers.some((blocker) => blocker.code === 'TREE_MISMATCH'));
});

test('release commit without provenance rejected', () => {
  const input = baseInput();
  delete input.event.commit.provenance;
  const result = validateInput(input, CONFIG);
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
  const result = validateInput(input, CONFIG);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.blockers.some((blocker) => blocker.code === 'ROOT_LATER_PARENT_MISMATCH'));
});

test('single-parent commit without existing master rejected', () => {
  const input = baseInput({
    event: { commit: { sha: F, parents: [E], tree: T, message: 'later', provenance: { sourceSha: E, sourceTree: T } } },
  });
  const result = validateInput(input, CONFIG);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.blockers.some((blocker) => blocker.code === 'ROOT_LATER_PARENT_MISMATCH'));
});

test('single-parent commit must pin previous master', () => {
  const input = baseInput({
    masterState: { exists: true, sha: E, releasesCount: 1 },
    event: { commit: { sha: F, parents: ['b'.repeat(40)], tree: T, message: 'later', provenance: { sourceSha: E, sourceTree: T } } },
  });
  const result = validateInput(input, CONFIG);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.blockers.some((blocker) => blocker.code === 'ROOT_LATER_PARENT_MISMATCH'));
});

test('present master with zero releases is BLOCKED_LEGACY_MASTER', () => {
  const input = baseInput({ masterState: { exists: true, sha: E, releasesCount: 0 } });
  const result = validateInput(input, CONFIG);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.blockers.some((blocker) => blocker.code === 'BLOCKED_LEGACY_MASTER'));
});

test('mutation intent fails closed on pending bootstrap with named blockers', () => {
  const input = baseInput({ intent: 'publish' });
  const result = validateInput(input, makePendingBootstrapConfig());
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

test('bound config: ordinary PR check passes while mutation fails closed on blocked platforms', () => {
  const pr = validateInput(prInput(), CONFIG);
  assert.equal(pr.status, 'PASS', JSON.stringify(pr.blockers));
  assert.equal(pr.exitCode, 0);
  const result = validateInput(baseInput({ intent: 'publish' }), CONFIG);
  assert.equal(result.status, 'BLOCKED');
  const platformBlockers = result.blockers.filter((blocker) => blocker.code === 'GATE_PLATFORM_BLOCKED');
  const platformFields = [...new Set(platformBlockers.map((blocker) => blocker.field))];
  assert.equal(platformFields.length, 2);
  assert.ok(platformFields.some((field) => field.includes('native-linux-node24-selfhosted')));
  assert.ok(platformFields.some((field) => field.includes('governance-release-docker')));
  assert.ok(
    result.blockers.every((blocker) => blocker.code !== 'PENDING_TRUSTED_BINDING'),
    'bound config must not report trusted-binding pending entries',
  );
});

test('policyHash is deterministic 64-hex sha256', () => {
  const first = policyHashOf(CONFIG);
  const second = policyHashOf(clone(CONFIG));
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, second);
  assert.equal(canonicalJson(CONFIG), canonicalJson(clone(CONFIG)));
});

test('runPolicyCheck returns typed report with hash and status', () => {
  const result = runPolicyCheck({ config: CONFIG, input: baseInput() });
  assert.equal(result.command, 'policy:check');
  assert.equal(result.mode, 'read-only');
  assert.match(result.policyHash, /^[0-9a-f]{64}$/);
  assert.equal(result.bindingStatus, 'bound');
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
