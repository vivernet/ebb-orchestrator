// plan-26 Task6: CLI integration + fault injection tests (test-first RED).
// Spawns the real CLI with validated argv and shell:false in disposable git
// fixtures. No network, no live provider calls, no real remotes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const RELEASE_SCRIPT = join(REPO_ROOT, 'scripts', 'release.mjs');
const BOOTSTRAP_CONFIG = join(REPO_ROOT, '.ebb', 'release-policy.json');

const E = 'e'.repeat(40);
const C = 'c'.repeat(40);
const T = '1'.repeat(40);
const M = '2'.repeat(40);
const OP = '11111111-1111-4111-8111-111111111111';
const NOW = '2026-10-24T12:00:00Z';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeBoundConfig() {
  const cfg = JSON.parse(readFileSync(BOOTSTRAP_CONFIG, 'utf8'));
  cfg.bindingStatus = 'bound';
  cfg.trustedBindings.workflows['release-validation.yml'].fullSha = 'b'.repeat(40);
  cfg.trustedBindings.workflows['release-operations.yml'].fullSha = 'b'.repeat(40);
  cfg.trustedBindings.scriptBundle.fullSha = 'd'.repeat(40);
  cfg.pendingBindings = [];
  for (const platform of cfg.gates.requiredPlatforms) {
    platform.status = 'configured';
    delete platform.blocker;
    delete platform.producerTask;
  }
  return cfg;
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
  const dir = await mkdtemp(join(tmpdir(), 'ebb-rel-wk-'));
  const init = gitRun(dir, ['init', '-b', 'develop']);
  assert.equal(init.status, 0, init.stderr);
  await writeFile(join(dir, 'README.md'), 'root\n');
  gitRun(dir, ['add', '.']);
  const commit = gitRun(dir, ['commit', '-m', 'initial']);
  assert.equal(commit.status, 0, commit.stderr);
  return dir;
}

async function makeBareRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'ebb-rel-bare-'));
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

function commonDir(dir) {
  const run = gitRun(dir, ['rev-parse', '--git-common-dir']);
  assert.equal(run.status, 0, run.stderr);
  return resolve(dir, run.stdout.trim());
}

function opDir(dir, operationId) {
  return join(commonDir(dir), 'ebb-release', 'operations', operationId);
}

function runCli(args, { cwd, env = {} } = {}) {
  return spawnSync(process.execPath, [RELEASE_SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    shell: false,
    env: { ...process.env, ...env },
  });
}

function parseReport(run) {
  return JSON.parse(run.stdout.trim());
}

function proofFixture(overrides = {}) {
  return {
    version: '1.0.0',
    operationId: OP,
    reservedAt: '2026-10-24T09:00:00Z',
    developSha: E,
    recordHash: 'a'.repeat(64),
    ...overrides,
  };
}

function invFixture(overrides = {}) {
  return {
    repositoryId: 1372710981,
    refs: [{ ref: 'refs/heads/develop', sha: E }],
    releases: [],
    assets: [],
    packages: [],
    versions: [],
    ociObjects: [],
    ownership: { owner: 'vivernet', visibility: 'public', canPush: true },
    observedAt: '2026-10-24T11:59:00Z',
    ...overrides,
  };
}

function commitInputsFixture(overrides = {}) {
  return {
    message: 'release snapshot 1.0.0',
    author: { name: 'Ebb Release Bot', email: 'release@ebb.local' },
    committer: { name: 'Ebb Release Bot', email: 'release@ebb.local' },
    timestamp: '2026-10-24T10:00:00Z',
    ...overrides,
  };
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function fullMatrixEvidence(cfg, sourceSha, candidateSha, tree, overrides = {}) {
  const items = [];
  for (const platform of cfg.gates.requiredPlatforms) {
    platform.requiredChecks.forEach((check, index) => {
      items.push({
        commandIdentity: check,
        conclusion: 'success',
        sourceSha,
        candidateSha,
        tree,
        platform: platform.id,
        timestamp: '2026-10-24T11:55:00Z',
        logDigest: `a${String(index + 1).padStart(63, '0')}`,
        scope: 'ci',
        runId: `run-${platform.id}-${index}`,
        checkId: `check-${platform.id}-${index}`,
        event: 'workflow_dispatch',
        ref: `refs/heads/ebb-release-candidates/${OP}`,
        headSha: candidateSha,
        ...overrides,
      });
    });
  }
  return items;
}

async function prepareBase(dir) {
  const cfg = makeBoundConfig();
  const cfgPath = join(dir, 'policy.json');
  await writeJson(cfgPath, cfg);
  // commit 1 = reservation commit (develop head at reservation time)
  await writeFile(join(dir, 'version.txt'), '0.0.0\n');
  gitRun(dir, ['add', 'version.txt']);
  const reserve = gitRun(dir, ['commit', '-m', 'reserve version 1.0.0']);
  assert.equal(reserve.status, 0, reserve.stderr);
  const devSha = headSha(dir);
  // commit 2 = source commit being pinned (object must exist in the repo)
  await writeFile(join(dir, 'version.txt'), '1.0.0\n');
  gitRun(dir, ['add', 'version.txt']);
  const source = gitRun(dir, ['commit', '-m', 'source for release 1.0.0']);
  assert.equal(source.status, 0, source.stderr);
  const sourceSha = headSha(dir);
  const sourceTree = treeOf(dir, sourceSha);
  const inv = invFixture({ refs: [{ ref: 'refs/heads/develop', sha: sourceSha }] });
  const invPath = join(dir, 'inventory.json');
  await writeJson(invPath, inv);
  const proofPath = join(dir, 'proof.json');
  await writeJson(proofPath, proofFixture({ developSha: devSha }));
  const inputsPath = join(dir, 'commit-inputs.json');
  await writeJson(inputsPath, commitInputsFixture());
  gitRun(dir, ['add', '-A']);
  const fixtures = gitRun(dir, ['commit', '-m', 'fixtures']);
  assert.equal(fixtures.status, 0, fixtures.stderr);
  return { cfg, cfgPath, inv, invPath, proofPath, inputsPath, sourceSha, sourceTree, devSha };
}

const PREPARE_ARGS = (opts) => [
  'prepare',
  '--config', opts.cfgPath,
  '--operation', OP,
  '--version', '1.0.0',
  '--source-ref', 'refs/heads/develop',
  '--source-sha', opts.sourceSha,
  '--source-tree', opts.sourceTree,
  '--old-master', 'ABSENT',
  '--commit-inputs-file', opts.inputsPath,
  '--reservation-proof-file', opts.proofPath,
  '--inventory-file', opts.invPath,
  '--now', NOW,
];

test('unknown mode is malformed input (exit 2)', async () => {
  const dir = await makeWorkRepo();
  const run = runCli(['explode'], { cwd: dir });
  assert.equal(run.status, 2, run.stdout);
  const report = parseReport(run);
  assert.equal(report.status, 'CONFIG_ERROR');
  assert.ok(report.blockers.some((blocker) => blocker.code === 'CLI_USAGE'));
  await rm(dir, { recursive: true, force: true });
});

test('prepare without required inputs is malformed input (exit 2)', async () => {
  const dir = await makeWorkRepo();
  const run = runCli(['prepare', '--config', BOOTSTRAP_CONFIG, '--operation', OP], { cwd: dir });
  assert.equal(run.status, 2, run.stdout);
  const report = parseReport(run);
  assert.equal(report.status, 'CONFIG_ERROR');
  await rm(dir, { recursive: true, force: true });
});

test('malformed version is rejected (exit 2) and executes nothing', async () => {
  const dir = await makeWorkRepo();
  const base = await prepareBase(dir);
  const args = PREPARE_ARGS(base).map((arg) => (arg === '1.0.0' ? '1.2.3 && touch pwned' : arg));
  const run = runCli(args, { cwd: dir });
  assert.equal(run.status, 2, run.stdout);
  const report = parseReport(run);
  assert.equal(report.status, 'CONFIG_ERROR');
  assert.ok(report.blockers.some((blocker) => blocker.code === 'SEMVER_ENCODING_VIOLATION'));
  await assert.rejects(readFile(join(dir, 'pwned')), /ENOENT/);
  await rm(dir, { recursive: true, force: true });
});

test('prepare with the real bootstrap config is BLOCKED by named platform blockers, never PASS', async () => {
  const dir = await makeWorkRepo();
  const base = await prepareBase(dir);
  const run = runCli(PREPARE_ARGS({ ...base, cfgPath: BOOTSTRAP_CONFIG }), { cwd: dir });
  assert.equal(run.status, 1, run.stdout);
  const report = parseReport(run);
  assert.equal(report.status, 'BLOCKED');
  assert.ok(report.blockers.some((blocker) => blocker.detail.includes('BLOCKED_DOCKER_DEPENDENCY')));
  assert.ok(report.blockers.some((blocker) => blocker.detail.includes('BLOCKED_SELF_HOSTED_RUNNER')));
  const statePath = join(opDir(dir, OP), 'state.json');
  await assert.rejects(readFile(statePath), /ENOENT/);
  await rm(dir, { recursive: true, force: true });
});

test('prepare succeeds read-only: PREPARED report, journal state, no ref mutations, no remote push', async () => {
  const dir = await makeWorkRepo();
  const base = await prepareBase(dir);
  const run = runCli(PREPARE_ARGS(base), { cwd: dir });
  assert.equal(run.status, 0, run.stdout);
  const report = parseReport(run);
  assert.equal(report.status, 'PREPARED');
  assert.equal(report.mode, 'prepare');
  assert.equal(report.operationId, OP);
  assert.equal(report.version, '1.0.0');
  assert.equal(report.repositoryId, 1372710981);
  assert.equal(report.sourceSha, base.sourceSha);
  assert.equal(report.sourceTree, base.sourceTree);
  assert.equal(report.oldMaster, 'ABSENT');
  assert.match(report.candidateSha, /^[0-9a-f]{40}$/);
  assert.equal(report.candidateTree, base.sourceTree);
  assert.match(report.policyHash, /^[0-9a-f]{64}$/);
  assert.ok(report.reservationProof);
  assert.equal(report.confirmationHash, null);
  assert.equal(report.blockers.length, 0);
  assert.equal(report.nextAction, null);
  // read-only: no ref changes, no remote refs created
  const refs = gitRun(dir, ['for-each-ref', '--format=%(refname)']).stdout.trim().split('\n');
  assert.ok(refs.includes('refs/heads/develop'));
  assert.ok(!refs.includes('refs/heads/master'));
  assert.ok(!refs.some((ref) => ref.includes('ebb-release-candidates')));
  assert.ok(!refs.some((ref) => ref.startsWith('refs/remotes/')));
  // journal present
  const state = JSON.parse(await readFile(join(opDir(dir, OP), 'state.json'), 'utf8'));
  assert.equal(state.status, 'PREPARED');
  assert.equal(state.stage, 'prepared');
  await readFile(join(opDir(dir, OP), 'inventory.json'), 'utf8');
  await readFile(join(opDir(dir, OP), 'gates.json'), 'utf8');
  await rm(dir, { recursive: true, force: true });
});

test('validate turns a prepared operation into VALIDATED with receipt (confirmationHash stays null)', async () => {
  const dir = await makeWorkRepo();
  const base = await prepareBase(dir);
  const run = runCli(PREPARE_ARGS(base), { cwd: dir });
  assert.equal(run.status, 0, run.stdout);
  const prepared = parseReport(run);
  const evidencePath = join(dir, 'evidence.json');
  const evidence = fullMatrixEvidence(base.cfg, base.sourceSha, prepared.candidateSha, base.sourceTree);
  await writeJson(evidencePath, evidence);
  const vRun = runCli(['validate', '--config', base.cfgPath, '--operation', OP, '--evidence-file', evidencePath, '--now', NOW], { cwd: dir });
  assert.equal(vRun.status, 0, vRun.stdout);
  const report = parseReport(vRun);
  assert.equal(report.status, 'VALIDATED');
  assert.equal(report.stage, 'validated');
  assert.match(report.gateEvidenceHash, /^[0-9a-f]{64}$/);
  const approval = JSON.parse(await readFile(join(opDir(dir, OP), 'approval.json'), 'utf8'));
  assert.equal(approval.receipt.confirmationHash, null);
  assert.equal(approval.receipt.confirmedAt, null);
  await rm(dir, { recursive: true, force: true });
});

test('validate with bad evidence returns BLOCKED (exit 1) and never auto-approves', async () => {
  const dir = await makeWorkRepo();
  const base = await prepareBase(dir);
  const run = runCli(PREPARE_ARGS(base), { cwd: dir });
  assert.equal(run.status, 0, run.stdout);
  const prepared = parseReport(run);
  const evidencePath = join(dir, 'evidence.json');
  const evidence = fullMatrixEvidence(base.cfg, base.sourceSha, prepared.candidateSha, base.sourceTree);
  evidence[0].conclusion = 'skipped';
  await writeJson(evidencePath, evidence);
  const vRun = runCli(['validate', '--config', base.cfgPath, '--operation', OP, '--evidence-file', evidencePath, '--now', NOW], { cwd: dir });
  assert.equal(vRun.status, 1, vRun.stdout);
  const report = parseReport(vRun);
  assert.equal(report.status, 'BLOCKED');
  assert.ok(report.blockers.some((blocker) => blocker.code === 'GATE_CHECK_SKIPPED'));
  await assert.rejects(readFile(join(opDir(dir, OP), 'approval.json')), /ENOENT/);
  await rm(dir, { recursive: true, force: true });
});

test('rollback prepares inventory only: ROLLBACK_PREPARED, no deletion, refs untouched', async () => {
  const dir = await makeWorkRepo();
  const base = await prepareBase(dir);
  // seed a plausible PUBLISHED state so rollback has something authoritative to prepare
  const statePath = join(opDir(dir, OP), 'state.json');
  await mkdir(opDir(dir, OP), { recursive: true });
  await writeJson(statePath, {
    schemaVersion: 1,
    operationId: OP,
    status: 'PUBLISHED',
    stage: 'published',
    updatedAt: NOW,
    mode: 'publish',
    version: '1.0.0',
    reservationProof: proofFixture({ developSha: E }),
  });
  const inv = invFixture({
    refs: [{ ref: 'refs/heads/develop', sha: E }, { ref: 'refs/heads/master', sha: C }],
    releases: [{ id: 101, tag_name: 'v1.0.0', name: 'Release v1.0.0', draft: false, prerelease: false, assets: [] }],
    packages: [],
    versions: [{ version: '1.0.0', digest: `sha256:${'a'.repeat(64)}`, platforms: ['linux/amd64'] }],
  });
  await writeJson(base.invPath, inv);
  const run = runCli(['rollback', '--config', base.cfgPath, '--operation', OP, '--old-master', 'ABSENT', '--inventory-file', base.invPath, '--now', NOW], { cwd: dir });
  assert.equal(run.status, 0, run.stdout);
  const report = parseReport(run);
  assert.equal(report.status, 'ROLLBACK_PREPARED');
  assert.equal(report.mode, 'rollback');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(state.status, 'ROLLBACK_PREPARED');
  const refs = gitRun(dir, ['for-each-ref', '--format=%(refname)']).stdout.trim().split('\n');
  assert.ok(!refs.includes('refs/heads/master'));
  await rm(dir, { recursive: true, force: true });
});

test('resume is BLOCKED until Task11 gate acceptance enables the pinned mutation backend', async () => {
  const dir = await makeWorkRepo();
  const run = runCli(['resume', '--operation', OP], { cwd: dir });
  assert.equal(run.status, 1, run.stdout);
  const report = parseReport(run);
  assert.equal(report.status, 'BLOCKED');
  assert.equal(report.mode, 'resume');
  assert.ok(report.nextAction && String(report.nextAction).includes('Task11'));
  await rm(dir, { recursive: true, force: true });
});

test('status is read-only and reports the persisted state', async () => {
  const dir = await makeWorkRepo();
  const base = await prepareBase(dir);
  const run = runCli(PREPARE_ARGS(base), { cwd: dir });
  assert.equal(run.status, 0, run.stdout);
  const sRun = runCli(['status', '--config', base.cfgPath, '--operation', OP], { cwd: dir });
  assert.equal(sRun.status, 0, sRun.stdout);
  const report = parseReport(sRun);
  assert.equal(report.status, 'PREPARED');
  assert.equal(report.mode, 'status');
  assert.deepEqual(report.remainingIdentities, []);
  assert.deepEqual(report.ambiguities, []);
  await rm(dir, { recursive: true, force: true });
});

test('status on a PARTIAL operation exits nonzero (incomplete mutation is never success)', async () => {
  const dir = await makeWorkRepo();
  const base = await prepareBase(dir);
  const statePath = join(opDir(dir, OP), 'state.json');
  await mkdir(opDir(dir, OP), { recursive: true });
  await writeJson(statePath, { schemaVersion: 1, operationId: OP, status: 'PARTIAL', stage: 'publishing', updatedAt: NOW, mode: 'publish', version: '1.0.0' });
  const sRun = runCli(['status', '--config', base.cfgPath, '--operation', OP], { cwd: dir });
  assert.equal(sRun.status, 1, sRun.stdout);
  const report = parseReport(sRun);
  assert.equal(report.status, 'PARTIAL');
  await rm(dir, { recursive: true, force: true });
});

test('status surfaces the operation state machine: remaining identities and ambiguities, never repairs', async () => {
  const dir = await makeWorkRepo();
  const base = await prepareBase(dir);
  const statePath = join(opDir(dir, OP), 'state.json');
  await mkdir(opDir(dir, OP), { recursive: true });
  await writeJson(statePath, {
    schemaVersion: 1,
    operationId: OP,
    status: 'PARTIAL',
    stage: 'publishing',
    updatedAt: NOW,
    mode: 'publish',
    version: '1.0.0',
    steps: {
      verify: { status: 'confirmed' },
      'ghcr-publish': { status: 'confirmed' },
      'git-cas': { status: 'requested', requestedAt: NOW },
      'github-release': { status: 'planned' },
      'final-readback': { status: 'planned' },
    },
    order: ['verify', 'ghcr-publish', 'git-cas', 'github-release', 'final-readback'],
    ambiguities: [{ code: 'GHCR_ELIGIBILITY_UNKNOWN', field: 'versions', detail: 'download count unavailable' }],
  });
  const sRun = runCli(['status', '--config', base.cfgPath, '--operation', OP], { cwd: dir });
  assert.equal(sRun.status, 1, sRun.stdout);
  const report = parseReport(sRun);
  assert.equal(report.status, 'PARTIAL');
  assert.deepEqual(report.remainingIdentities, ['git-cas', 'github-release', 'final-readback']);
  assert.ok(report.ambiguities.some((ambiguity) => ambiguity.code === 'GHCR_ELIGIBILITY_UNKNOWN'));
  const walk = gitRun(dir, ['status', '--porcelain']).stdout;
  assert.equal(walk.trim(), '');
  await rm(dir, { recursive: true, force: true });
});

test('fault injection: secrets in environment never leak into output', async () => {
  const dir = await makeWorkRepo();
  const secret = 'supersecret-token-xyz-98765';
  const run = runCli(['explode'], { cwd: dir, env: { GH_TOKEN: secret } });
  assert.ok(!run.stdout.includes(secret));
  assert.ok(!run.stderr.includes(secret));
  await rm(dir, { recursive: true, force: true });
});

test('fault injection: hostile argv is treated as data, never interpolated', async () => {
  const dir = await makeWorkRepo();
  const base = await prepareBase(dir);
  const hostile = '1.0.0 $(touch owned) `touch owned2`';
  const args = PREPARE_ARGS(base).map((arg) => (arg === '1.0.0' ? hostile : arg));
  const run = runCli(args, { cwd: dir });
  assert.equal(run.status, 2, run.stdout);
  await assert.rejects(readFile(join(dir, 'owned')), /ENOENT/);
  await assert.rejects(readFile(join(dir, 'owned2')), /ENOENT/);
  await rm(dir, { recursive: true, force: true });
});

test('fault injection: prepare never writes outside the validated journal namespace', async () => {
  const dir = await makeWorkRepo();
  const base = await prepareBase(dir);
  const run = runCli(PREPARE_ARGS(base), { cwd: dir });
  assert.equal(run.status, 0, run.stdout);
  const walk = gitRun(dir, ['status', '--porcelain']).stdout;
  assert.equal(walk.trim(), '');
  await rm(dir, { recursive: true, force: true });
});
