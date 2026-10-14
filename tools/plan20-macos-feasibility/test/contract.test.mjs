import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXPECTED_ATTESTATION,
  lifecycleScenarios,
  sanitizeHostFacts,
  validateEvidence,
  summarizeEvidence,
  validateHarnessStatus,
} from '../src/contract.mjs';

test('exact-SHA evidence requires a clean, tracked harness source tree', () => {
  assert.deepEqual(validateHarnessStatus(''), []);
  assert.deepEqual(validateHarnessStatus(' M tools/plan20-macos-feasibility/src/cli.mjs\n'), ['HARNESS_NOT_EXACT_SHA']);
  assert.deepEqual(validateHarnessStatus('?? tools/plan20-macos-feasibility/src/cli.mjs\n'), ['HARNESS_NOT_EXACT_SHA']);
});

test('CLI refuses dirty, untracked, ignored, wrong Git context, and mismatched evidence before creating evidence', async t => {
  const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const cases = [
    ['modified source', async root => writeFileSync(join(root, 'tools/plan20-macos-feasibility/src/cli.mjs'), `${readFileSync(join(root, 'tools/plan20-macos-feasibility/src/cli.mjs'), 'utf8')}\n// dirty\n`) , {}],
    ['untracked source', async root => writeFileSync(join(root, 'tools/plan20-macos-feasibility/src/untracked.mjs'), 'export {};\n'), {}],
    ['ignored source', async root => {
      writeFileSync(join(root, '.gitignore'), 'tools/plan20-macos-feasibility/src/ignored.mjs\n');
      writeFileSync(join(root, 'tools/plan20-macos-feasibility/src/ignored.mjs'), 'export {};\n');
    }, {}],
    ['inherited Git context', async () => {}, { GIT_DIR: 'wrong.git', GIT_WORK_TREE: 'wrong-tree' }],
    ['redirected Git index with dirty source', async root => writeFileSync(
      join(root, 'tools/plan20-macos-feasibility/src/cli.mjs'),
      `${readFileSync(join(root, 'tools/plan20-macos-feasibility/src/cli.mjs'), 'utf8')}\n// dirty\n`,
    ), { GIT_INDEX_FILE: 'redirected.index' }],
    ['lowercase redirected Git index with dirty source', async root => writeFileSync(
      join(root, 'tools/plan20-macos-feasibility/src/cli.mjs'),
      `${readFileSync(join(root, 'tools/plan20-macos-feasibility/src/cli.mjs'), 'utf8')}\n// dirty\n`,
    ), { git_index_file: 'redirected.index' }],
  ];
  for (const [name, mutate, extraEnv] of cases) await t.test(name, async () => {
    const root = makeFixture(sourceRoot);
    try {
      await mutate(root);
      const output = runCli(root, ['preflight'], extraEnv);
      assert.equal(output.code, 'HARNESS_NOT_EXACT_SHA');
      assert.equal(existsSync(join(root, 'temp/plan20-macos-feasibility')), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  await t.test('evidence with a different SHA is rejected without rewriting it', () => {
    const root = makeFixture(sourceRoot);
    try {
      const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
      const evidenceDir = join(root, 'temp/plan20-macos-feasibility', sha);
      mkdirSync(evidenceDir, { recursive: true });
      const evidencePath = join(evidenceDir, 'evidence.json');
      writeFileSync(evidencePath, JSON.stringify({ schemaVersion: 1, exactEbbSha: 'f'.repeat(40) }));
      const before = readFileSync(evidencePath, 'utf8');
      const output = runCli(root, ['report']);
      assert.equal(output.code, 'EVIDENCE_INVALID');
      assert.equal(readFileSync(evidencePath, 'utf8'), before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

function makeFixture(sourceRoot) {
  const root = mkdtempSync(join(tmpdir(), 'plan20-harness-'));
  const packageRoot = join(root, 'tools/plan20-macos-feasibility');
  cpSync(sourceRoot, packageRoot, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'harness-test@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Harness Test'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
  return root;
}

function runCli(root, args, extraEnv = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.toUpperCase().startsWith('GIT_')) delete env[name];
  const result = spawnSync(process.execPath, [join(root, 'tools/plan20-macos-feasibility/src/cli.mjs'), ...args], {
    cwd: root, env: { ...env, ...extraEnv }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  assert.equal(result.error, undefined);
  return JSON.parse(result.stdout);
}

test('host facts retain only allowlisted, bounded platform values', () => {
  const facts = sanitizeHostFacts({
    model: 'Mac15,3', arm64Flag: '1', macOSVersion: '14.5', buildVersion: '23F79', architecture: 'arm64',
    stderr: 'PRIVATE_TOKEN /Users/alex/private', serialNumber: 'C02PRIVATE',
  });
  assert.deepEqual(facts, {
    model: 'Mac15,3', arm64Flag: '1', macOSVersion: '14.5', buildVersion: '23F79', architecture: 'arm64',
  });
  assert.doesNotMatch(JSON.stringify(facts), /PRIVATE|Users|serial/i);
});

test('invalid host values are replaced by fixed diagnostic tokens', () => {
  const facts = sanitizeHostFacts({ model: '/Users/alex/private', arm64Flag: 'secret', macOSVersion: '13.5\nPRIVATE', buildVersion: '', architecture: 'x86_64' });
  assert.deepEqual(facts, {
    model: 'UNAVAILABLE', arm64Flag: 'UNAVAILABLE', macOSVersion: 'UNAVAILABLE', buildVersion: 'UNAVAILABLE', architecture: 'x86_64',
  });
});

test('lifecycle scenario catalog covers all required restart, stop, UNKNOWN, packaging cases', () => {
  for (const name of [
    'orchestrator-crash-restart-reattach', 'controller-crash-restart-reattach',
    'detached-guest-child-stop', 'controller-crash-live-unknown', 'guest-agent-loss-unknown',
    'virtualization-api-unavailable-unknown', 'mismatched-vm-or-nonce-unknown',
    'unsettled-stop-unknown', 'timeout-unknown', 'package-extract-controller-restart-cleanup',
  ]) assert.ok(lifecycleScenarios.includes(name), `missing scenario ${name}`);
});

test('evidence validation requires exact SHA, distinct host/guest, all gates and review records', () => {
  const sha = 'a'.repeat(40);
  const completeShape = {
    schemaVersion: 1,
    exactEbbSha: sha,
    spikeController: 'NOT_IMPLEMENTED',
    host: { status: 'NOT_VERIFIED', facts: sanitizeHostFacts({}), operatorPhysicalAppleSiliconAttestation: false },
    guest: null,
    gates: {
      preflight: 'NOT_RUN', lifecycle: Object.fromEntries(lifecycleScenarios.map(scenario => [scenario, 'NOT_RUN'])),
      provider: 'NOT_RUN', packaging: 'NOT_RUN', cleanup: 'NOT_RUN',
    },
    review: { architecture: 'NOT_RUN', security: 'NOT_RUN' },
  };
  assert.deepEqual(validateEvidence(completeShape, sha), []);
  assert.ok(validateEvidence({ ...completeShape, exactEbbSha: 'b'.repeat(40) }, sha).includes('EVIDENCE_SHA_MISMATCH'));
  assert.ok(validateEvidence({ ...completeShape, guest: completeShape.host }, sha).includes('HOST_GUEST_NOT_DISTINCT'));
  assert.ok(validateEvidence({ ...completeShape, host: { ...completeShape.host, operatorPhysicalAppleSiliconAttestation: EXPECTED_ATTESTATION } }, sha).includes('INVALID_ATTESTATION_RECORD'));
  assert.ok(validateEvidence({ ...completeShape, gates: { ...completeShape.gates, lifecycle: {} } }, sha).includes('INCOMPLETE_LIFECYCLE_MATRIX'));
  assert.ok(validateEvidence({ ...completeShape, spikeController: 'VERIFIED_CONTROLLER_WITH_REATTACH' }, sha).includes('SPIKE_CONTROLLER_STATUS_INVALID'));
});

test('report is NOT_VERIFIED unless every physical gate and both reviews pass', () => {
  const sha = 'c'.repeat(40);
  const evidence = {
    schemaVersion: 1, exactEbbSha: sha,
    spikeController: 'NOT_IMPLEMENTED',
    host: { status: 'NOT_VERIFIED', facts: sanitizeHostFacts({}), operatorPhysicalAppleSiliconAttestation: false },
    guest: null,
    gates: {
      preflight: 'NOT_RUN', lifecycle: Object.fromEntries(lifecycleScenarios.map(scenario => [scenario, 'NOT_RUN'])),
      provider: 'NOT_RUN', packaging: 'NOT_RUN', cleanup: 'NOT_RUN',
    },
    review: { architecture: 'NOT_RUN', security: 'NOT_RUN' },
  };
  const summary = summarizeEvidence(evidence);
  assert.equal(summary.verdict, 'NOT_VERIFIED');
  assert.equal(summary.spikeController, 'NOT_IMPLEMENTED');
  assert.equal(summary.exactEbbSha, sha);
  assert.equal(summary.guest, 'NOT_CAPTURED');
  assert.doesNotMatch(JSON.stringify(summary), /PRIVATE_VALUE|API_KEY|SECRET_VALUE|stderr\"/i);
});
