// plan-26 Task6: gate planning/evidence tests (test-first RED). Pure fixtures
// only — no network, no git, no provider calls. Covers the seam contract:
// GateEvidence, PUBLISH full matrix vs WITHDRAW safety subset, evidence
// digest, ApprovalBundle with explicit (never auto) confirmation hash.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ABSENT } from './snapshot.mjs';
import { policyHashOf } from './policy.mjs';
import {
  buildApprovalBundle,
  confirmApprovalBundle,
  evaluateGates,
  gateEvidenceDigest,
  planGates,
} from './gates.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const CONFIG_PATH = join(REPO_ROOT, '.ebb', 'release-policy.json');

const E = 'e'.repeat(40);
const C = 'c'.repeat(40);
const T = '1'.repeat(40);
const M = '2'.repeat(40);
const OP = '11111111-1111-4111-8111-111111111111';
const CAND_REF = `refs/heads/ebb-release-candidates/${OP}`;
const NOW = '2026-10-24T12:00:00.000Z';
const LOG = (i) => `a${String(i).padStart(63, '0')}`;

let CONFIG;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeBoundConfig() {
  const cfg = clone(CONFIG);
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

function pinFixture(oldMaster = ABSENT) {
  return { sourceRef: 'refs/heads/develop', sourceSha: E, sourceTree: T, oldMaster };
}

function candFixture(overrides = {}) {
  return {
    candidateSha: C,
    candidateTree: T,
    parent: null,
    commitInputs: {
      message: 'release snapshot 1.0.0',
      author: { name: 'Ebb Release Bot', email: 'release@ebb.local' },
      committer: { name: 'Ebb Release Bot', email: 'release@ebb.local' },
      timestamp: '2026-10-24T10:00:00.000Z',
    },
    annotatedTagObject: { objectSha: 'g'.repeat(40), target: C, type: 'commit', name: 'v1.0.0' },
    ...overrides,
  };
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

function releaseFixture(tag, id = 101, overrides = {}) {
  return {
    id,
    tag_name: tag,
    name: `Release ${tag}`,
    draft: false,
    prerelease: false,
    assets: [],
    ...overrides,
  };
}

function ev(overrides = {}) {
  return {
    commandIdentity: 'pnpm lint',
    conclusion: 'success',
    sourceSha: E,
    candidateSha: C,
    tree: T,
    platform: 'quality-security-ubuntu-node24',
    timestamp: '2026-10-24T11:55:00Z',
    logDigest: LOG(1),
    scope: 'ci',
    runId: 'run-1',
    checkId: 'check-1',
    event: 'workflow_dispatch',
    ref: CAND_REF,
    headSha: C,
    ...overrides,
  };
}

function fullMatrixEvidence(cfg, pin, cand, overrides = {}) {
  const items = [];
  for (const platform of cfg.gates.requiredPlatforms) {
    platform.requiredChecks.forEach((check, index) => {
      items.push(
        ev({
          commandIdentity: check,
          platform: platform.id,
          sourceSha: pin.sourceSha,
          candidateSha: cand.candidateSha,
          tree: pin.sourceTree,
          runId: `run-${platform.id}-${index}`,
          checkId: `check-${platform.id}-${index}`,
          logDigest: LOG(index + 1),
          ...overrides,
        }),
      );
    });
  }
  return items;
}

function safetyEvidence({ parent = false, _overrides = {} } = {}) {
  const items = [
    ev({ commandIdentity: 'release-tool-regression', scope: 'local', runId: null, checkId: null, event: null, ref: null, headSha: null, platform: 'release-tooling', logDigest: LOG(1), ..._overrides }),
    ev({ commandIdentity: 'withdraw-permissions-eligibility', scope: 'local', runId: null, checkId: null, event: null, ref: null, headSha: null, platform: 'release-tooling', logDigest: LOG(2), ..._overrides }),
    ev({ commandIdentity: 'withdraw-target-provenance', scope: 'local', runId: null, checkId: null, event: null, ref: null, headSha: null, platform: 'release-tooling', logDigest: LOG(3), ..._overrides }),
    ev({ commandIdentity: 'withdraw-safety-checks', platform: 'quality-security-ubuntu-node24', logDigest: LOG(4), ..._overrides }),
  ];
  if (parent) {
    items.push(ev({ commandIdentity: 'withdraw-survivor-integrity', scope: 'local', runId: null, checkId: null, event: null, ref: null, headSha: null, platform: 'release-tooling', logDigest: LOG(5), ..._overrides }));
  }
  return items;
}

function assertBlocked(result, code) {
  assert.equal(result.valid, false, JSON.stringify(result));
  assert.ok(
    result.blockers.some((blocker) => blocker.code === code),
    `expected ${code}, got ${JSON.stringify(result.blockers)}`,
  );
}

function assertValid(result) {
  assert.equal(result.valid, true, JSON.stringify(result.blockers ?? result));
}

test('bootstrap config loads from .ebb/release-policy.json', async () => {
  CONFIG = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
});

// ---------------------------------------------------------------------------
// Gate planning
// ---------------------------------------------------------------------------

test('missing version is never silently chosen: returns required choice/nextAction', () => {
  const result = planGates({ config: CONFIG, mode: 'publish', pinnedSource: pinFixture(), candidate: candFixture(), reservationProof: null, inventory: invFixture(), version: null });
  assert.equal(result.valid, false);
  assert.ok(result.blockers.some((blocker) => blocker.code === 'VERSION_REQUIRED'));
  assert.equal(result.plan.version, null);
  assert.ok(result.nextAction);
  assert.equal(result.nextAction.kind, 'VERSION_CHOICE_REQUIRED');
  assert.ok(Array.isArray(result.nextAction.suggestedVersions));
  assert.ok(result.nextAction.suggestedVersions.every((v) => typeof v === 'string'));
});

test('unknown mode is rejected', () => {
  const result = planGates({ config: CONFIG, mode: 'explode', pinnedSource: pinFixture(), candidate: candFixture(), reservationProof: proofFixture(), inventory: invFixture(), version: '1.0.0' });
  assertBlocked(result, 'MODE_UNKNOWN');
});

test('publish plan surfaces blocked platforms as named blockers, never PASS', () => {
  const result = planGates({ config: CONFIG, mode: 'publish', pinnedSource: pinFixture(), candidate: candFixture(), reservationProof: proofFixture(), inventory: invFixture(), version: '1.0.0' });
  assert.equal(result.valid, false);
  assert.ok(result.blockers.some((blocker) => blocker.code === 'GATE_PLATFORM_BLOCKED' && blocker.detail.includes('BLOCKED_DOCKER_DEPENDENCY')));
  assert.ok(result.blockers.some((blocker) => blocker.code === 'GATE_PLATFORM_BLOCKED' && blocker.detail.includes('BLOCKED_SELF_HOSTED_RUNNER')));
});

test('publish full matrix requires every configured platform and its checks', () => {
  const cfg = makeBoundConfig();
  const result = planGates({ config: cfg, mode: 'publish', pinnedSource: pinFixture(), candidate: candFixture(), reservationProof: proofFixture(), inventory: invFixture(), version: '1.0.0' });
  assertValid(result);
  const expected = cfg.gates.requiredPlatforms.flatMap((platform) => platform.requiredChecks.map((check) => `${platform.id}\u0000${check}`));
  const actual = result.plan.requiredSpecs.map((spec) => `${spec.platform}\u0000${spec.command}`);
  assert.equal(actual.length, expected.length);
  for (const entry of expected) assert.ok(actual.includes(entry), `missing ${entry}`);
});

const WITHDRAW_INV = () => invFixture({ refs: [{ ref: 'refs/heads/develop', sha: E }, { ref: 'refs/heads/master', sha: C }], releases: [releaseFixture('v1.0.0', 101, { target_commitish: 'develop' })] });

test('withdraw safety subset never includes the defect app matrix', () => {
  const cfg = makeBoundConfig();
  const result = planGates({ config: cfg, mode: 'withdraw', pinnedSource: pinFixture(), candidate: null, reservationProof: proofFixture(), inventory: WITHDRAW_INV(), version: '1.0.0' });
  assertValid(result);
  const appCommands = new Set(cfg.gates.requiredPlatforms[0].requiredChecks);
  for (const spec of result.plan.requiredSpecs) {
    assert.ok(!appCommands.has(spec.command), `app test ${spec.command} must not be required for withdraw`);
  }
});

test('root withdraw must not require the nonexistent parent image checks', () => {
  const cfg = makeBoundConfig();
  const result = planGates({ config: cfg, mode: 'withdraw', pinnedSource: pinFixture(), candidate: null, reservationProof: proofFixture(), inventory: WITHDRAW_INV(), version: '1.0.0' });
  assertValid(result);
  const commands = result.plan.requiredSpecs.map((spec) => spec.command);
  assert.ok(!commands.includes('withdraw-survivor-integrity'));
  assert.equal(result.plan.rootWithdraw, true);
});

test('non-root withdraw includes survivor integrity for the surviving parent', () => {
  const cfg = makeBoundConfig();
  const result = planGates({ config: cfg, mode: 'withdraw', pinnedSource: pinFixture(M), candidate: null, reservationProof: proofFixture(), inventory: WITHDRAW_INV(), version: '1.0.0' });
  assertValid(result);
  const commands = result.plan.requiredSpecs.map((spec) => spec.command);
  assert.ok(commands.includes('withdraw-survivor-integrity'));
});

test('no confirmed reservation blocks the plan', () => {
  const result = planGates({ config: CONFIG, mode: 'publish', pinnedSource: pinFixture(), candidate: candFixture(), reservationProof: null, inventory: invFixture(), version: '1.0.0' });
  assertBlocked(result, 'RESERVATION_MISSING');
});

test('reservation proof version must match the requested version', () => {
  const result = planGates({ config: CONFIG, mode: 'publish', pinnedSource: pinFixture(), candidate: candFixture(), reservationProof: proofFixture({ version: '2.0.0' }), inventory: invFixture(), version: '1.0.0' });
  assertBlocked(result, 'RESERVATION_VERSION_MISMATCH');
});

test('candidate tree must equal the pinned source tree (dummy shape check)', () => {
  const result = planGates({ config: CONFIG, mode: 'publish', pinnedSource: pinFixture(), candidate: candFixture({ candidateTree: '3'.repeat(40) }), reservationProof: proofFixture(), inventory: invFixture(), version: '1.0.0' });
  assertBlocked(result, 'CANDIDATE_TREE_MISMATCH');
});

test('candidate parent must match the pinned old master', () => {
  const result = planGates({ config: CONFIG, mode: 'publish', pinnedSource: pinFixture(M), candidate: candFixture({ parent: null }), reservationProof: proofFixture(), inventory: invFixture(), version: '1.0.0' });
  assertBlocked(result, 'CANDIDATE_PARENT_MISMATCH');
});

test('source drift: develop ref differs from the pinned source SHA', () => {
  const result = planGates({ config: CONFIG, mode: 'publish', pinnedSource: pinFixture(), candidate: candFixture(), reservationProof: proofFixture(), inventory: invFixture({ refs: [{ ref: 'refs/heads/develop', sha: '9'.repeat(40) }] }), version: '1.0.0' });
  assertBlocked(result, 'SOURCE_DRIFT');
});

test('master drift: master ref differs from the pinned old master', () => {
  const result = planGates({ config: CONFIG, mode: 'publish', pinnedSource: pinFixture(M), candidate: candFixture({ parent: M }), reservationProof: proofFixture(), inventory: invFixture({ refs: [{ ref: 'refs/heads/develop', sha: E }, { ref: 'refs/heads/master', sha: '8'.repeat(40) }] }), version: '1.0.0' });
  assertBlocked(result, 'MASTER_DRIFT');
});

test('master drift: root pinned source but master ref already exists', () => {
  const result = planGates({ config: CONFIG, mode: 'publish', pinnedSource: pinFixture(), candidate: candFixture(), reservationProof: proofFixture(), inventory: invFixture({ refs: [{ ref: 'refs/heads/develop', sha: E }, { ref: 'refs/heads/master', sha: M }] }), version: '1.0.0' });
  assertBlocked(result, 'MASTER_DRIFT');
});

test('dummy legacy master (master exists, zero releases) is blocked', () => {
  const result = planGates({ config: CONFIG, mode: 'publish', pinnedSource: pinFixture(), candidate: candFixture(), reservationProof: proofFixture(), inventory: invFixture({ refs: [{ ref: 'refs/heads/develop', sha: E }, { ref: 'refs/heads/master', sha: M }], releases: [] }), version: '1.0.0' });
  assertBlocked(result, 'BLOCKED_LEGACY_MASTER');
});

test('inventory from another repository identity is rejected', () => {
  const result = planGates({ config: CONFIG, mode: 'publish', pinnedSource: pinFixture(), candidate: candFixture(), reservationProof: proofFixture(), inventory: invFixture({ repositoryId: 42, ownership: { owner: 'someone-else', visibility: 'public', canPush: true } }), version: '1.0.0' });
  assertBlocked(result, 'REPO_IDENTITY_MISMATCH');
});

// ---------------------------------------------------------------------------
// Evidence evaluation — PUBLISH full matrix
// ---------------------------------------------------------------------------

function pubCtx(_overrides = {}) {
  const cfg = makeBoundConfig();
  const pin = pinFixture();
  const cand = candFixture();
  const plan = planGates({ config: cfg, mode: 'publish', pinnedSource: pin, candidate: cand, reservationProof: proofFixture(), inventory: invFixture(), version: '1.0.0' });
  assertValid(plan);
  return { cfg, pin, cand, plan: plan.plan };
}

test('full PUBLISH matrix with exact source/candidate evidence passes', () => {
  const { cfg, plan } = pubCtx();
  const evidence = fullMatrixEvidence(cfg, pinFixture(), candFixture());
  const result = evaluateGates({ config: cfg, plan, evidence, now: NOW });
  assertValid(result);
  assert.equal(result.conclusion, 'success');
});

test('PUBLISH missing an app test (Playwright E2E) is blocked', () => {
  const { cfg, plan } = pubCtx();
  const evidence = fullMatrixEvidence(cfg, pinFixture(), candFixture()).filter((item) => item.commandIdentity !== 'Playwright Chromium/browser E2E');
  const result = evaluateGates({ config: cfg, plan, evidence, now: NOW });
  assertBlocked(result, 'GATE_CHECK_MISSING');
});

test('skipped matrix leg is blocked', () => {
  const { cfg, plan } = pubCtx();
  const evidence = fullMatrixEvidence(cfg, pinFixture(), candFixture());
  evidence[0].conclusion = 'skipped';
  const result = evaluateGates({ config: cfg, plan, evidence, now: NOW });
  assertBlocked(result, 'GATE_CHECK_SKIPPED');
});

test('stale/wrong source SHA evidence is blocked', () => {
  const { cfg, plan } = pubCtx();
  const evidence = fullMatrixEvidence(cfg, pinFixture(), candFixture());
  evidence[0].sourceSha = '9'.repeat(40);
  const result = evaluateGates({ config: cfg, plan, evidence, now: NOW });
  assertBlocked(result, 'GATE_WRONG_SHA');
});

test('wrong candidate SHA evidence is blocked', () => {
  const { cfg, plan } = pubCtx();
  const evidence = fullMatrixEvidence(cfg, pinFixture(), candFixture());
  evidence[0].candidateSha = '9'.repeat(40);
  const result = evaluateGates({ config: cfg, plan, evidence, now: NOW });
  assertBlocked(result, 'GATE_WRONG_SHA');
});

test('evidence tree mismatch is blocked', () => {
  const { cfg, plan } = pubCtx();
  const evidence = fullMatrixEvidence(cfg, pinFixture(), candFixture());
  evidence[0].tree = '9'.repeat(40);
  const result = evaluateGates({ config: cfg, plan, evidence, now: NOW });
  assertBlocked(result, 'GATE_TREE_MISMATCH');
});

test('check from a different platform is blocked', () => {
  const { cfg, plan } = pubCtx();
  const evidence = fullMatrixEvidence(cfg, pinFixture(), candFixture());
  evidence[0].platform = 'unrelated-platform';
  const result = evaluateGates({ config: cfg, plan, evidence, now: NOW });
  assertBlocked(result, 'GATE_PLATFORM_IDENTITY');
});

test('expired evidence is blocked', () => {
  const { cfg, plan } = pubCtx();
  const evidence = fullMatrixEvidence(cfg, pinFixture(), candFixture());
  evidence[0].timestamp = '2026-10-24T10:00:00Z';
  const result = evaluateGates({ config: cfg, plan, evidence, now: NOW });
  assertBlocked(result, 'GATE_EVIDENCE_EXPIRED');
});

test('check from a different event (PR run) is blocked', () => {
  const { cfg, plan } = pubCtx();
  const evidence = fullMatrixEvidence(cfg, pinFixture(), candFixture());
  evidence[0].event = 'pull_request';
  evidence[0].ref = 'refs/pull/1/merge';
  evidence[0].headSha = '9'.repeat(40);
  const result = evaluateGates({ config: cfg, plan, evidence, now: NOW });
  assertBlocked(result, 'GATE_CI_CONTEXT');
});

test('check whose headSha differs from the candidate SHA is blocked', () => {
  const { cfg, plan } = pubCtx();
  const evidence = fullMatrixEvidence(cfg, pinFixture(), candFixture());
  evidence[0].headSha = '9'.repeat(40);
  const result = evaluateGates({ config: cfg, plan, evidence, now: NOW });
  assertBlocked(result, 'GATE_CI_CONTEXT');
});

test('check from a non-candidate ref is blocked', () => {
  const { cfg, plan } = pubCtx();
  const evidence = fullMatrixEvidence(cfg, pinFixture(), candFixture());
  evidence[0].ref = 'refs/heads/develop';
  const result = evaluateGates({ config: cfg, plan, evidence, now: NOW });
  assertBlocked(result, 'GATE_CI_CONTEXT');
});

test('CI evidence without run/check ids is blocked', () => {
  const { cfg, plan } = pubCtx();
  const evidence = fullMatrixEvidence(cfg, pinFixture(), candFixture());
  evidence[0].runId = null;
  evidence[0].checkId = null;
  const result = evaluateGates({ config: cfg, plan, evidence, now: NOW });
  assertBlocked(result, 'GATE_CI_EVIDENCE_REQUIRED');
});

test('local evidence must carry explicit null non-CI fields', () => {
  const cfg = makeBoundConfig();
  const plan = planGates({ config: cfg, mode: 'withdraw', pinnedSource: pinFixture(), candidate: null, reservationProof: proofFixture(), inventory: WITHDRAW_INV(), version: '1.0.0' });
  assertValid(plan);
  const evidence = safetyEvidence();
  evidence[0].runId = 'run-ghost';
  const result = evaluateGates({ config: cfg, plan: plan.plan, evidence, now: NOW });
  assertBlocked(result, 'GATE_EVIDENCE_SHAPE');
});

test('unknown evidence command is blocked (fail closed)', () => {
  const { cfg, plan } = pubCtx();
  const evidence = fullMatrixEvidence(cfg, pinFixture(), candFixture());
  evidence.push(ev({ commandIdentity: 'some-invented-check' }));
  const result = evaluateGates({ config: cfg, plan, evidence, now: NOW });
  assertBlocked(result, 'GATE_CHECK_UNKNOWN');
});

// ---------------------------------------------------------------------------
// Evidence evaluation — WITHDRAW safety subset
// ---------------------------------------------------------------------------

function witCtx({ parent = false } = {}) {
  const cfg = makeBoundConfig();
  const oldMaster = parent ? M : ABSENT;
  const pin = pinFixture(oldMaster);
  const inv = invFixture({ refs: [{ ref: 'refs/heads/develop', sha: E }, { ref: 'refs/heads/master', sha: C }], releases: [releaseFixture('v1.0.0', 101, { target_commitish: 'develop' })] });
  const plan = planGates({ config: cfg, mode: 'withdraw', pinnedSource: pin, candidate: null, reservationProof: proofFixture(), inventory: inv, version: '1.0.0' });
  assertValid(plan);
  return { cfg, inv, plan: plan.plan, targetSha: C };
}

test('withdraw accepts only the safety subset evidence (no app tests needed)', () => {
  const { cfg, plan } = witCtx();
  const result = evaluateGates({ config: cfg, plan, evidence: safetyEvidence(), now: NOW });
  assertValid(result);
  assert.equal(result.conclusion, 'success');
});

test('withdraw cannot pass with only the publish app matrix evidence', () => {
  const { cfg, plan } = witCtx();
  const appEvidence = fullMatrixEvidence(cfg, pinFixture(), candFixture()).slice(0, 3);
  const result = evaluateGates({ config: cfg, plan, evidence: appEvidence, now: NOW });
  assertBlocked(result, 'GATE_CHECK_MISSING');
});

test('root withdraw ignores survivor evidence expectations and still passes safety subset', () => {
  const { cfg, plan } = witCtx();
  const result = evaluateGates({ config: cfg, plan, evidence: safetyEvidence(), now: NOW });
  assertValid(result);
});

// ---------------------------------------------------------------------------
// Digests
// ---------------------------------------------------------------------------

test('gate evidence digest is deterministic and canonical', () => {
  const a = [ev(), ev({ commandIdentity: 'pnpm typecheck', runId: 'run-2', checkId: 'check-2' })];
  const b = clone(a);
  assert.equal(gateEvidenceDigest(a), gateEvidenceDigest(b));
  assert.match(gateEvidenceDigest(a), /^[0-9a-f]{64}$/);
  const reordered = [a[1], a[0]];
  assert.notEqual(gateEvidenceDigest(a), gateEvidenceDigest(reordered));
});

// ---------------------------------------------------------------------------
// Approval bundle
// ---------------------------------------------------------------------------

function gatesOk(cfg, pin, cand) {
  const plan = planGates({ config: cfg, mode: 'publish', pinnedSource: pin, candidate: cand, reservationProof: proofFixture(), inventory: invFixture(), version: '1.0.0' });
  assertValid(plan);
  const evidence = fullMatrixEvidence(cfg, pin, cand);
  const evalResult = evaluateGates({ config: cfg, plan: plan.plan, evidence, now: NOW });
  assertValid(evalResult);
  return { plan: plan.plan, evidence, gates: evalResult };
}

test('approval bundle binds mode/actions/pins/reservation/inventory/gates/policy hashes', () => {
  const cfg = makeBoundConfig();
  const pin = pinFixture();
  const cand = candFixture();
  const { gates } = gatesOk(cfg, pin, cand);
  const inventory = invFixture();
  const result = buildApprovalBundle({ config: cfg, mode: 'publish', pinnedSource: pin, candidate: cand, reservationProof: proofFixture(), inventory, gates, operationId: OP });
  assertValid(result);
  const bundle = result.bundle;
  assert.equal(bundle.mode, 'publish');
  assert.equal(bundle.operationId, OP);
  assert.equal(bundle.version, '1.0.0');
  assert.equal(bundle.policyHash, policyHashOf(cfg));
  assert.equal(bundle.inventoryHash, result.inventoryHash);
  assert.equal(bundle.gateEvidenceHash, result.gateEvidenceHash);
  assert.ok(Array.isArray(bundle.actions) && bundle.actions.length > 0);
  assert.ok(bundle.pins.workflows['release-validation.yml'].fullSha);
  assert.equal(bundle.receipt.approvalHash, result.approvalHash);
  assert.equal(bundle.receipt.confirmationHash, null);
  assert.equal(bundle.receipt.confirmedAt, null);
  assert.ok(!JSON.stringify(bundle).includes('token') && !JSON.stringify(bundle).includes('secret'));
});

test('publish bundle actions are exact and include master CAS/tag/release', () => {
  const cfg = makeBoundConfig();
  const pin = pinFixture();
  const cand = candFixture();
  const { gates } = gatesOk(cfg, pin, cand);
  const result = buildApprovalBundle({ config: cfg, mode: 'publish', pinnedSource: pin, candidate: cand, reservationProof: proofFixture(), inventory: invFixture(), gates, operationId: OP });
  assertValid(result);
  const kinds = result.bundle.actions.map((action) => action.kind);
  assert.ok(kinds.includes('create-annotated-tag'));
  assert.ok(kinds.includes('cas-master'));
  assert.ok(kinds.includes('create-github-release'));
  const master = result.bundle.actions.find((action) => action.kind === 'cas-master');
  assert.equal(master.expected, '0'.repeat(40));
  assert.equal(master.value, C);
});

test('publish refuses a version that already has an immutable Release', () => {
  const cfg = makeBoundConfig();
  const pin = pinFixture(M);
  const cand = candFixture({ parent: M });
  const plan = planGates({ config: cfg, mode: 'publish', pinnedSource: pin, candidate: cand, reservationProof: proofFixture(), inventory: invFixture({ refs: [{ ref: 'refs/heads/develop', sha: E }, { ref: 'refs/heads/master', sha: M }], releases: [releaseFixture('v1.0.0')] }), version: '1.0.0' });
  assertBlocked(plan, 'IMMUTABLE_RELEASE_TAG');
});

test('withdraw bundle orders ghcr deletion before Release removal before tag CAS', () => {
  const cfg = makeBoundConfig();
  const pin = pinFixture(M);
  const inv = invFixture({
    refs: [{ ref: 'refs/heads/develop', sha: E }, { ref: 'refs/heads/master', sha: C }],
    releases: [releaseFixture('v1.0.0', 101)],
    versions: [{ packageName: 'ebb-orchestrator', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}`, platforms: ['linux/amd64'] }],
  });
  const plan = planGates({ config: cfg, mode: 'withdraw', pinnedSource: pin, candidate: null, reservationProof: proofFixture(), inventory: inv, version: '1.0.0' });
  assertValid(plan);
  const evidence = safetyEvidence({ parent: true });
  const gates = evaluateGates({ config: cfg, plan: plan.plan, evidence, now: NOW });
  assertValid(gates);
  const result = buildApprovalBundle({ config: cfg, mode: 'withdraw', pinnedSource: pin, candidate: null, reservationProof: proofFixture(), inventory: inv, gates, operationId: OP });
  assertValid(result);
  const kinds = result.bundle.actions.map((action) => action.kind);
  const releaseIdx = kinds.indexOf('delete-github-release');
  const masterIdx = kinds.indexOf('cas-master');
  const tagIdx = kinds.indexOf('delete-annotated-tag');
  const ghcrIdxs = kinds.map((kind, i) => (kind === 'delete-ghcr-version' ? i : -1)).filter((i) => i >= 0);
  assert.ok(ghcrIdxs.length > 0);
  for (const idx of ghcrIdxs) assert.ok(idx < releaseIdx);
  assert.ok(releaseIdx >= 0 && masterIdx > releaseIdx && tagIdx > masterIdx);
  const release = result.bundle.actions.find((action) => action.kind === 'delete-github-release');
  assert.equal(release.releaseId, 101);
});

test('root withdraw bundle CAS deletes master (no parent restore)', () => {
  const cfg = makeBoundConfig();
  const pin = pinFixture();
  const inv = WITHDRAW_INV();
  const plan = planGates({ config: cfg, mode: 'withdraw', pinnedSource: pin, candidate: null, reservationProof: proofFixture(), inventory: inv, version: '1.0.0' });
  assertValid(plan);
  const evidence = safetyEvidence();
  const gates = evaluateGates({ config: cfg, plan: plan.plan, evidence, now: NOW });
  assertValid(gates);
  const result = buildApprovalBundle({ config: cfg, mode: 'withdraw', pinnedSource: pin, candidate: null, reservationProof: proofFixture(), inventory: inv, gates, operationId: OP });
  assertValid(result);
  const master = result.bundle.actions.find((action) => action.kind === 'cas-master');
  assert.equal(master.expected, C);
  assert.equal(master.value, '0'.repeat(40));
});

test('approval from another inventory is rejected (hash mismatch)', () => {
  const cfg = makeBoundConfig();
  const pin = pinFixture();
  const cand = candFixture();
  const { gates } = gatesOk(cfg, pin, cand);
  const foreign = invFixture({ repositoryId: 42, ownership: { owner: 'other', visibility: 'public', canPush: true } });
  const result = buildApprovalBundle({ config: cfg, mode: 'publish', pinnedSource: pin, candidate: cand, reservationProof: proofFixture(), inventory: foreign, gates, operationId: OP });
  assertBlocked(result, 'REPO_IDENTITY_MISMATCH');
});

test('approval from another policy is rejected (policy hash mismatch)', () => {
  const cfgA = makeBoundConfig();
  const cfgB = makeBoundConfig();
  cfgB.repository.id = 999;
  const pin = pinFixture();
  const cand = candFixture();
  const plan = planGates({ config: cfgA, mode: 'publish', pinnedSource: pin, candidate: cand, reservationProof: proofFixture(), inventory: invFixture(), version: '1.0.0' });
  assertValid(plan);
  const evidence = fullMatrixEvidence(cfgA, pin, cand);
  const gates = evaluateGates({ config: cfgA, plan: plan.plan, evidence, now: NOW });
  assertValid(gates);
  const result = buildApprovalBundle({ config: cfgB, mode: 'publish', pinnedSource: pin, candidate: cand, reservationProof: proofFixture(), inventory: invFixture(), gates, operationId: OP });
  assertBlocked(result, 'APPROVAL_POLICY_HASH_MISMATCH');
});

test('explicit user confirmation hash is required; never auto-approved', () => {
  const cfg = makeBoundConfig();
  const pin = pinFixture();
  const cand = candFixture();
  const { gates } = gatesOk(cfg, pin, cand);
  const result = buildApprovalBundle({ config: cfg, mode: 'publish', pinnedSource: pin, candidate: cand, reservationProof: proofFixture(), inventory: invFixture(), gates, operationId: OP });
  assertValid(result);
  const bundle = result.bundle;
  assert.equal(bundle.receipt.confirmationHash, null);
  // a wrong/nonexistent confirmation cannot be conjured by the tool
  const bad = confirmApprovalBundle(bundle, '0'.repeat(64));
  assert.equal(bad.valid, false);
  const good = confirmApprovalBundle(bundle, result.expectedConfirmationHash);
  assert.equal(good.valid, true);
  assert.equal(good.receipt.confirmationHash, result.expectedConfirmationHash);
  assert.ok(good.receipt.confirmedAt);
});
