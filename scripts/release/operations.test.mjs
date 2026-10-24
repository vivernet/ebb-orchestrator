// plan-26 Task7: operations state machine tests (test-first RED).
// PUBLISH/WITHDRAW/RESUME/STATUS orchestration through journalled adapters,
// with fault injection at every remote boundary. Mocked adapters only — no
// live provider calls, no real remotes, no registry writes. The local
// process is not a public writer: these tests exercise the orchestration
// primitives that Task8's trusted workflow will invoke.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  publish,
  withdraw,
  resume,
  statusOperation,
} from './operations.mjs';
import {
  acquireLock,
  writeApproval,
  writeGates,
  writeInventory,
  writeState,
} from './journal.mjs';
import {
  buildApprovalBundle,
  confirmApprovalBundle,
  evaluateGates,
  planGates,
} from './gates.mjs';
import { inventoryHashOf } from './github.mjs';
import { policyHashOf } from './policy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const BOOTSTRAP_CONFIG = join(REPO_ROOT, '.ebb', 'release-policy.json');

const E = 'e'.repeat(40);
const C = 'c'.repeat(40);
const T = '1'.repeat(40);
const PARENT = '3'.repeat(40);
const TAG_OBJ = 'a'.repeat(40);
const REL_ID = 101;
const GHCR_DIGEST = `sha256:${'b'.repeat(64)}`;
const GHCR_DIGEST_2 = `sha256:${'d'.repeat(64)}`;
const OP = '11111111-1111-4111-8111-111111111111';
const NOW = '2026-10-24T12:00:00Z';
const EV = '2026-10-24T11:55:00Z';
const WORKFLOW_SHA = 'b'.repeat(40);
const RUN_ID = 'run-ebb-1';
const CANDIDATE_REF = `refs/heads/ebb-release-candidates/${OP}`;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeBoundConfig() {
  const cfg = JSON.parse(readFileSync(BOOTSTRAP_CONFIG, 'utf8'));
  cfg.bindingStatus = 'bound';
  cfg.trustedBindings.workflows['release-validation.yml'].fullSha = 'b'.repeat(40);
  cfg.trustedBindings.workflows['release-operations.yml'].fullSha = WORKFLOW_SHA;
  cfg.trustedBindings.scriptBundle.fullSha = 'd'.repeat(40);
  cfg.pendingBindings = [];
  for (const platform of cfg.gates.requiredPlatforms) {
    platform.status = 'configured';
    delete platform.blocker;
    delete platform.producerTask;
  }
  return cfg;
}

const CFG = makeBoundConfig();

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

function commitInputsFixture(overrides = {}) {
  return {
    message: 'release snapshot 1.0.0',
    author: { name: 'Ebb Release Bot', email: 'release@ebb.local' },
    committer: { name: 'Ebb Release Bot', email: 'release@ebb.local' },
    timestamp: '2026-10-24T10:00:00Z',
    ...overrides,
  };
}

function publishInventoryFixture(overrides = {}) {
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

function withdrawInventoryFixture({ _root = true, survivors = [] } = {}) {
  const refs = [
    { ref: 'refs/heads/develop', sha: E },
    { ref: 'refs/heads/master', sha: C },
  ];
  const versions = [
    { version: '1.0.0', packageName: 'ebb-orchestrator', digest: GHCR_DIGEST, platforms: ['linux/amd64'] },
  ];
  versions.push(...survivors);
  return {
    repositoryId: 1372710981,
    refs,
    releases: [{ id: REL_ID, tag_name: 'v1.0.0', name: 'Release v1.0.0', draft: false, prerelease: false, assets: [] }],
    assets: [],
    packages: [{ id: 42, name: 'ebb-orchestrator', visibility: 'public', owner: 'vivernet' }],
    versions,
    ociObjects: [
      { version: '1.0.0', tag: 'v1.0.0', topDigest: GHCR_DIGEST, childDigests: [] },
    ],
    ownership: { owner: 'vivernet', owned: true, public: true },
    observedAt: '2026-10-24T11:59:00Z',
  };
}

function withdrawRemoteState({ root = true, survivors = [], withTag = true, masterSha = C, parents } = {}) {
  const refs = [
    { ref: 'refs/heads/develop', sha: E },
    { ref: 'refs/heads/master', sha: masterSha },
  ];
  if (withTag) refs.push({ ref: 'refs/tags/v1.0.0', sha: TAG_OBJ });
  const parentsMap = parents ?? { [masterSha]: root ? [] : [PARENT] };
  const publicVersions = new Map([
    ['ebb-orchestrator@1.0.0', { digest: GHCR_DIGEST, labels: { version: '1.0.0' }, visibility: 'public' }],
  ]);
  for (const survivor of survivors) {
    publicVersions.set(`${survivor.packageName}@${survivor.version}`, { digest: survivor.digest, labels: { version: survivor.version }, visibility: 'public' });
  }
  const releases = new Map();
  if (withTag) releases.set('v1.0.0', { id: REL_ID, tag_name: 'v1.0.0', html_url: 'https://github.com/vivernet/ebb-orchestrator/releases/tag/v1.0.0', assets: [] });
  return { refs, parents: parentsMap, publicVersions, releases };
}

function publishEvidence(cfg = CFG, overrides = {}) {
  const items = [];
  for (const platform of cfg.gates.requiredPlatforms) {
    platform.requiredChecks.forEach((check, index) => {
      items.push({
        commandIdentity: check,
        conclusion: 'success',
        sourceSha: E,
        candidateSha: C,
        tree: T,
        platform: platform.id,
        timestamp: EV,
        logDigest: `a${String(index + 1).padStart(63, '0')}`,
        scope: 'ci',
        runId: `run-${platform.id}-${index}`,
        checkId: `check-${platform.id}-${index}`,
        event: 'workflow_dispatch',
        ref: CANDIDATE_REF,
        headSha: C,
        ...overrides,
      });
    });
  }
  return items;
}

function localEvidence(command, platform, overrides = {}) {
  return {
    commandIdentity: command,
    conclusion: 'success',
    sourceSha: C,
    candidateSha: C,
    tree: null,
    platform,
    timestamp: EV,
    logDigest: `b${String(command.length).padStart(63, '0')}`,
    scope: 'local',
    runId: null,
    checkId: null,
    event: null,
    ref: null,
    headSha: null,
    ...overrides,
  };
}

function withdrawEvidence({ root = true } = {}) {
  const items = [
    localEvidence('release-tool-regression', 'release-tooling'),
    localEvidence('withdraw-permissions-eligibility', 'release-tooling'),
    localEvidence('withdraw-target-provenance', 'release-tooling'),
    {
      commandIdentity: 'withdraw-safety-checks',
      conclusion: 'success',
      sourceSha: C,
      candidateSha: C,
      tree: null,
      platform: 'quality-security-ubuntu-node24',
      timestamp: EV,
      logDigest: `c${'0'.repeat(63)}`,
      scope: 'ci',
      runId: 'run-withdraw-safety',
      checkId: 'check-withdraw-safety',
      event: 'workflow_dispatch',
      ref: CANDIDATE_REF,
      headSha: C,
    },
  ];
  if (!root) items.push(localEvidence('withdraw-survivor-integrity', 'release-tooling'));
  return items;
}

function stateBase({ mode = 'publish', status = 'VALIDATED', stage = 'validated', oldMaster = 'ABSENT', extra = {} } = {}) {
  return {
    schemaVersion: 1,
    operationId: OP,
    status,
    stage,
    updatedAt: NOW,
    mode,
    version: '1.0.0',
    pinnedSource: {
      sourceRef: mode === 'publish' ? 'refs/heads/develop' : 'refs/heads/master',
      sourceSha: mode === 'publish' ? E : C,
      sourceTree: mode === 'publish' ? T : null,
      oldMaster,
    },
    candidate: mode === 'publish'
      ? { candidateSha: C, candidateTree: T, parent: null, commitInputs: commitInputsFixture(), annotatedTagObject: { objectSha: TAG_OBJ, target: C, type: 'commit', name: 'v1.0.0' } }
      : null,
    reservationProof: proofFixture(),
    policyHash: 'p'.repeat(64),
    inventoryHash: 'i'.repeat(64),
    ...extra,
  };
}

async function seedOperation(dir, {
  mode = 'publish',
  status = 'VALIDATED',
  stage = 'validated',
  oldMaster = 'ABSENT',
  root = true,
  survivors = [],
  inventory,
  approval = true,
  receipt = true,
  gateEvidence,
  extraState = {},
} = {}) {
  const inv = inventory ?? (mode === 'publish' ? publishInventoryFixture() : withdrawInventoryFixture({ root, survivors }));
  const pinnedSource = stateBase({ mode, oldMaster }).pinnedSource;
  const candidate = mode === 'publish' ? stateBase().candidate : null;
  const proof = proofFixture();
  const plan = planGates({ config: CFG, mode, pinnedSource, candidate, reservationProof: proof, inventory: inv, version: '1.0.0' });
  assert.ok(plan.valid, JSON.stringify(plan.blockers));
  const evidence = gateEvidence ?? (mode === 'publish' ? publishEvidence() : withdrawEvidence({ root }));
  const evaluated = evaluateGates({ config: CFG, plan: plan.plan, evidence, now: NOW });
  assert.ok(evaluated.valid, JSON.stringify(evaluated.blockers));
  const built = buildApprovalBundle({ config: CFG, mode, pinnedSource, candidate, reservationProof: proof, inventory: inv, gates: evaluated, operationId: OP });
  assert.ok(built.valid, JSON.stringify(built.blockers));
  const bundle = built.bundle;
  const rcpt = receipt ? confirmApprovalBundle(bundle, bundle.expectedConfirmationHash).receipt : null;
  const state = stateBase({ mode, status, stage, oldMaster, extra: extraState });
  state.policyHash = policyHashOf(CFG);
  state.inventoryHash = inventoryHashOf(inv);
  await writeState({ commonDir: dir, operationId: OP, state });
  await writeInventory({ commonDir: dir, operationId: OP, value: { schemaVersion: 1, operationId: OP, ...inv } });
  await writeGates({ commonDir: dir, operationId: OP, value: { schemaVersion: 1, operationId: OP, plan: plan.plan, policyHash: plan.policyHash, inventoryHash: evaluated.planHash } });
  if (approval) {
    await writeApproval({ commonDir: dir, operationId: OP, value: { schemaVersion: 1, operationId: OP, ...bundle } });
  }
  return { cfg: CFG, inv, bundle, plan, evaluated, evidence, candidate, pinnedSource, proof, receipt: rcpt };
}

async function makeJournal() {
  const dir = await mkdtemp(join(tmpdir(), 'ebb-op-'));
  await mkdir(join(dir, 'ebb-release', 'operations', OP), { recursive: true });
  return dir;
}

function makeAdapters(overrides = {}) {
  const log = [];
  const record = (slot, name, payload) => log.push({ slot, name, payload: clone(payload ?? null) });
  const setRef = (ref, sha) => {
    const index = adapters._state.refs.findIndex((item) => item.ref === ref);
    if (index >= 0) adapters._state.refs[index] = { ref, sha };
    else adapters._state.refs.push({ ref, sha });
  };
  const adapters = {
    _state: {
      refs: [{ ref: 'refs/heads/develop', sha: E }],
      parents: {},
      publicVersions: new Map(),
      releases: new Map(),
    },
    git: {
      readRemoteRefs: async () => clone(adapters._state.refs),
      readCommitParents: async ({ sha }) => clone(adapters._state.parents[sha] ?? []),
      executeRefTransaction: async ({ actions }) => {
        record('git', 'tx', { actions });
        for (const action of actions) {
          const current = adapters._state.refs.find((item) => item.ref === action.ref)?.sha ?? null;
          const expectsAbsent = action.expected === '0'.repeat(40);
          const mismatch = action.expected !== undefined && action.expected !== null
            && (expectsAbsent ? current !== null : current !== action.expected);
          if (mismatch) {
            return { ok: false, code: 'CAS_STALE', detail: `expected ${action.ref} at ${action.expected}, found ${current ?? 'ABSENT'}` };
          }
          if (action.kind === 'create' || action.kind === 'update') setRef(action.ref, action.value);
          else if (action.kind === 'delete') {
            adapters._state.refs = adapters._state.refs.filter((item) => item.ref !== action.ref);
          }
        }
        return { ok: true };
      },
    },
    ghcr: {
      assessEligibility: async () => ({
        eligible: true,
        knownRestrictions: [],
        unknownCounts: [],
        sharedAmbiguity: [],
      }),
      publishVersionObjects: async ({ packageName, version }) => {
        record('ghcr', 'publish', { packageName, version });
        adapters._state.publicVersions.set(`${packageName}@${version}`, { digest: GHCR_DIGEST, labels: { version }, visibility: 'public' });
        return { ok: true, digests: [GHCR_DIGEST] };
      },
      readPublicVersion: async ({ packageName, version }) => {
        record('ghcr', 'readPublicVersion', { packageName, version });
        const key = `${packageName}@${version}`;
        if (adapters._state.publicVersions.has(key)) return clone(adapters._state.publicVersions.get(key));
        return null;
      },
      deleteVersionObjects: async ({ targets }) => {
        record('ghcr', 'delete', { targets });
        const deleted = [];
        for (const target of targets) {
          const key = `${target.packageName}@${target.version}`;
          if (adapters._state.publicVersions.has(key)) {
            adapters._state.publicVersions.delete(key);
            deleted.push(target.version);
          }
        }
        return { status: 'OK', deleted, remaining: [], refusal: null };
      },
    },
    github: {
      createRelease: async ({ tag, target }) => {
        record('github', 'createRelease', { tag, target });
        adapters._state.releases.set(tag, { id: REL_ID, tag_name: tag, html_url: `https://github.com/vivernet/ebb-orchestrator/releases/tag/${tag}`, assets: [] });
        return { releaseId: REL_ID, htmlUrl: `https://github.com/vivernet/ebb-orchestrator/releases/tag/${tag}` };
      },
      deleteRelease: async ({ releaseId, tag }) => {
        record('github', 'deleteRelease', { releaseId, tag });
        adapters._state.releases.delete(tag);
        return { ok: true };
      },
      readReleaseByTag: async ({ tag }) => {
        record('github', 'readReleaseByTag', { tag });
        return adapters._state.releases.has(tag) ? clone(adapters._state.releases.get(tag)) : null;
      },
      verifyReleaseAssets: async ({ releaseId, assets }) => {
        record('github', 'verifyReleaseAssets', { releaseId, assets });
        return { ok: true };
      },
    },
    workflow: {
      getRun: async ({ runId }) => {
        record('workflow', 'getRun', { runId });
        const status = adapters._state.runStatus ?? 'completed';
        return { status, conclusion: status === 'completed' ? 'success' : null };
      },
    },
  };
  if (overrides._state) {
    if (overrides._state.refs) adapters._state.refs = overrides._state.refs;
    if (overrides._state.parents) adapters._state.parents = overrides._state.parents;
    if (overrides._state.runStatus) adapters._state.runStatus = overrides._state.runStatus;
    if (overrides._state.publicVersions) {
      for (const [key, value] of overrides._state.publicVersions) adapters._state.publicVersions.set(key, value);
    }
    if (overrides._state.releases) {
      for (const [tag, value] of overrides._state.releases) adapters._state.releases.set(tag, value);
    }
  }
  for (const section of ['git', 'ghcr', 'github', 'workflow']) {
    if (overrides[section]) Object.assign(adapters[section], overrides[section]);
  }
  return { adapters, log };
}

function publishTargets(overrides = {}) {
  return {
    ghcr: [{ packageName: 'ebb-orchestrator', platforms: ['linux/amd64'] }],
    assets: [{ name: 'checksums.txt', contentSha256: 'c'.repeat(64) }],
    ...overrides,
  };
}

function runIdentityFixture(overrides = {}) {
  return {
    runId: RUN_ID,
    workflowFullSha: WORKFLOW_SHA,
    startedAt: NOW,
    ...overrides,
  };
}

async function readJson(dir, name) {
  return JSON.parse(await readFile(join(dir, 'ebb-release', 'operations', OP, name), 'utf8'));
}

const noFaults = {};

// ---------------------------------------------------------------------------
// PUBLISH — approval/receipt/run gates
// ---------------------------------------------------------------------------

test('publish without approval is BLOCKED and performs no remote request', async () => {
  const dir = await makeJournal();
  await seedOperation(dir, { approval: false });
  const { adapters, log } = makeAdapters();
  const report = await publish({
    commonDir: dir, operationId: OP, config: CFG,
    receipt: null, evidence: publishEvidence(), runIdentity: runIdentityFixture(),
    adapters, targets: publishTargets(), faults: noFaults, now: NOW,
  });
  assert.equal(report.status, 'BLOCKED');
  assert.ok(report.blockers.some((blocker) => blocker.code === 'APPROVAL_MISSING'));
  assert.equal(log.length, 0);
  await rm(dir, { recursive: true, force: true });
});

test('publish with approval but no receipt is AWAITING_CONFIRMATION (no remote request)', async () => {
  const dir = await makeJournal();
  await seedOperation(dir, { receipt: false });
  const { adapters, log } = makeAdapters();
  const report = await publish({
    commonDir: dir, operationId: OP, config: CFG,
    receipt: null, evidence: publishEvidence(), runIdentity: runIdentityFixture(),
    adapters, targets: publishTargets(), faults: noFaults, now: NOW,
  });
  assert.equal(report.status, 'AWAITING_CONFIRMATION');
  assert.equal(log.length, 0);
  await rm(dir, { recursive: true, force: true });
});

test('publish with a mismatched receipt is BLOCKED', async () => {
  const dir = await makeJournal();
  const seeded = await seedOperation(dir);
  const { adapters, log } = makeAdapters();
  const badReceipt = { ...seeded.receipt, confirmationHash: '0'.repeat(64) };
  const report = await publish({
    commonDir: dir, operationId: OP, config: CFG,
    receipt: badReceipt, evidence: publishEvidence(), runIdentity: runIdentityFixture(),
    adapters, targets: publishTargets(), faults: noFaults, now: NOW,
  });
  assert.equal(report.status, 'BLOCKED');
  assert.ok(report.blockers.some((blocker) => blocker.code === 'CONFIRMATION_HASH_MISMATCH'));
  assert.equal(log.length, 0);
  await rm(dir, { recursive: true, force: true });
});

test('publish with mismatched gate evidence is BLOCKED (fresh mode-specific gates required)', async () => {
  const dir = await makeJournal();
  const seeded = await seedOperation(dir);
  const { adapters } = makeAdapters();
  const staleEvidence = publishEvidence(CFG, { timestamp: '2026-10-24T00:00:00Z' });
  const report = await publish({
    commonDir: dir, operationId: OP, config: CFG,
    receipt: seeded.receipt, evidence: staleEvidence, runIdentity: runIdentityFixture(),
    adapters, targets: publishTargets(), faults: noFaults, now: NOW,
  });
  assert.equal(report.status, 'BLOCKED');
  assert.ok(report.blockers.some((blocker) => blocker.code === 'GATE_EVIDENCE_EXPIRED'));
  await rm(dir, { recursive: true, force: true });
});

test('publish rejects an untrusted run identity', async () => {
  const dir = await makeJournal();
  await seedOperation(dir);
  const { adapters, log } = makeAdapters();
  const report = await publish({
    commonDir: dir, operationId: OP, config: CFG,
    receipt: null, evidence: publishEvidence(), runIdentity: runIdentityFixture({ workflowFullSha: 'f'.repeat(40) }),
    adapters, targets: publishTargets(), faults: noFaults, now: NOW,
  });
  assert.equal(report.status, 'BLOCKED');
  assert.ok(report.blockers.some((blocker) => blocker.code === 'TRUSTED_RUN_IDENTITY_MISMATCH'));
  assert.equal(log.length, 0);
  await rm(dir, { recursive: true, force: true });
});

test('publish rejects a second writer holding the local lock', async () => {
  const dir = await makeJournal();
  await seedOperation(dir);
  const held = await acquireLock({ commonDir: dir, operationId: OP, token: 'other-writer', timeoutMs: 200 });
  assert.ok(held.held);
  const { adapters, log } = makeAdapters();
  const report = await publish({
    commonDir: dir, operationId: OP, config: CFG,
    receipt: null, evidence: publishEvidence(), runIdentity: runIdentityFixture(),
    adapters, targets: publishTargets(), faults: noFaults, now: NOW,
  });
  assert.equal(report.status, 'BLOCKED');
  assert.ok(report.blockers.some((blocker) => blocker.code === 'LOCK_BUSY'));
  assert.equal(log.length, 0);
  await held.release();
  await rm(dir, { recursive: true, force: true });
});

test('publish rejects a lost workflow that is still running', async () => {
  const dir = await makeJournal();
  const seeded = await seedOperation(dir, { extraState: { runIdentity: { runId: 'run-lost', workflowFullSha: WORKFLOW_SHA, startedAt: NOW } } });
  const { adapters, log } = makeAdapters({ _state: { runStatus: 'in_progress' } });
  const report = await publish({
    commonDir: dir, operationId: OP, config: CFG,
    receipt: seeded.receipt, evidence: seeded.evidence, runIdentity: runIdentityFixture({ runId: 'run-new' }),
    adapters, targets: publishTargets(), faults: noFaults, now: NOW,
  });
  assert.equal(report.status, 'BLOCKED');
  assert.ok(report.blockers.some((blocker) => blocker.code === 'LOST_WORKFLOW_STILL_RUNNING'));
  assert.equal(log.length, 1); // only the run status probe
  await rm(dir, { recursive: true, force: true });
});

test('publish proceeds when the previous run is proven terminated', async () => {
  const dir = await makeJournal();
  const seeded = await seedOperation(dir, { extraState: { runIdentity: { runId: 'run-lost', workflowFullSha: WORKFLOW_SHA, startedAt: NOW } } });
  const { adapters, log } = makeAdapters();
  const report = await publish({
    commonDir: dir, operationId: OP, config: CFG,
    receipt: seeded.receipt, evidence: seeded.evidence, runIdentity: runIdentityFixture({ runId: 'run-new' }),
    adapters, targets: publishTargets(), faults: noFaults, now: NOW,
  });
  assert.equal(report.status, 'PUBLISHED');
  assert.ok(log.some((entry) => entry.slot === 'workflow' && entry.name === 'getRun'));
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// PUBLISH — happy path and ordering
// ---------------------------------------------------------------------------

test('publish happy path publishes GHCR first, then CAS refs, then Release, then final readback + candidate cleanup', async () => {
  const dir = await makeJournal();
  const seeded = await seedOperation(dir);
  const { adapters, log } = makeAdapters();
  adapters._state.refs.push({ ref: CANDIDATE_REF, sha: C });
  const report = await publish({
    commonDir: dir, operationId: OP, config: CFG,
    receipt: seeded.receipt, evidence: seeded.evidence, runIdentity: runIdentityFixture(),
    adapters, targets: publishTargets(), faults: noFaults, now: NOW,
  });
  assert.equal(report.status, 'PUBLISHED');
  assert.equal(report.stage, 'published');
  assert.equal(report.operationId, OP);
  assert.equal(report.version, '1.0.0');
  assert.equal(report.candidateSha, C);
  assert.equal(report.remainingIdentities.length, 0);

  const kinds = log.map((entry) => `${entry.slot}:${entry.name}`);
  const ghcrPublish = kinds.indexOf('ghcr:publish');
  const txIndexes = log.map((entry, index) => (entry.name === 'tx' ? index : -1)).filter((index) => index >= 0);
  const releaseIndex = kinds.indexOf('github:createRelease');
  assert.ok(ghcrPublish >= 0);
  assert.ok(txIndexes.length >= 1);
  assert.ok(releaseIndex > ghcrPublish);
  assert.ok(txIndexes[0] < releaseIndex);
  // candidate cleanup is the final transaction
  const lastTx = log[txIndexes[txIndexes.length - 1]].payload.actions;
  assert.ok(lastTx.some((action) => action.kind === 'delete' && action.ref === CANDIDATE_REF));

  const state = await readJson(dir, 'state.json');
  assert.equal(state.status, 'PUBLISHED');
  assert.equal(state.stage, 'published');
  assert.equal(state.runIdentity.runId, RUN_ID);
  const steps = state.steps;
  for (const id of ['verify', 'ghcr-publish', 'git-cas', 'github-release', 'final-readback']) {
    assert.equal(steps[id].status, 'confirmed', id);
  }
  await rm(dir, { recursive: true, force: true });
});

test('publish records remote identities in journal and events', async () => {
  const dir = await makeJournal();
  const seeded = await seedOperation(dir);
  const { adapters } = makeAdapters();
  const report = await publish({
    commonDir: dir, operationId: OP, config: CFG,
    receipt: seeded.receipt, evidence: seeded.evidence, runIdentity: runIdentityFixture(),
    adapters, targets: publishTargets(), faults: noFaults, now: NOW,
  });
  assert.equal(report.status, 'PUBLISHED');
  const state = await readJson(dir, 'state.json');
  assert.equal(state.remoteIdentities.ghcr[0].digest, GHCR_DIGEST);
  assert.equal(state.remoteIdentities.release.releaseId, REL_ID);
  assert.equal(state.remoteIdentities.refs.tag, TAG_OBJ);
  const events = (await readFile(join(dir, 'ebb-release', 'operations', OP, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean);
  const names = events.map((line) => JSON.parse(line).event);
  assert.ok(names.includes('step-intent'));
  assert.ok(names.includes('step-result'));
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// PUBLISH — fault injection at every remote boundary
// ---------------------------------------------------------------------------

const PUBLISH_EXEC_STEPS = ['ghcr-publish', 'git-cas', 'github-release'];

for (const stepId of PUBLISH_EXEC_STEPS) {
  test(`publish crash/timeout before request at ${stepId} is BLOCKED with zero remote calls for that step`, async () => {
    const dir = await makeJournal();
    const seeded = await seedOperation(dir);
    const { adapters, log } = makeAdapters();
    const faults = { beforeRequest: (id) => { if (id !== stepId) return; throw new Error(`FAULT_BEFORE_REQUEST_${stepId}`); } };
    const report = await publish({
      commonDir: dir, operationId: OP, config: CFG,
      receipt: seeded.receipt, evidence: seeded.evidence, runIdentity: runIdentityFixture(),
      adapters, targets: publishTargets(), faults, now: NOW,
    });
    assert.equal(report.status, 'BLOCKED');
    const calls = log.filter((entry) => entry.name !== 'getRun' && entry.name !== 'readRemoteRefs' && entry.name !== 'readCommitParents' && entry.name !== 'readPublicVersion' && entry.name !== 'readReleaseByTag' && entry.name !== 'verifyReleaseAssets');
    if (stepId === 'git-cas') {
      assert.equal(calls.filter((entry) => entry.name === 'tx').length, 0, 'git-cas itself must not reach the remote before the crash');
    }
    if (stepId === 'github-release') {
      assert.equal(calls.filter((entry) => entry.slot === 'github' && entry.name === 'createRelease').length, 0, 'github-release itself must not reach the remote before the crash');
    }
    const state = await readJson(dir, 'state.json');
    assert.equal(state.steps[stepId].status, 'requested');
    assert.ok(state.steps[stepId].requestedAt);
    await rm(dir, { recursive: true, force: true });
  });

  test(`publish crash after remote success at ${stepId} is PARTIAL and resume reconciles by exact IDs`, async () => {
    const dir = await makeJournal();
    const seeded = await seedOperation(dir);
    const { adapters, log } = makeAdapters();
    const faults = {
      afterRemoteSuccess: (id) => {
        if (id !== stepId) return;
        // simulate the remote effect having landed before the crash
        if (stepId === 'git-cas') {
          adapters._state.refs = adapters._state.refs.filter((ref) => ref.ref !== CANDIDATE_REF);
          adapters._state.refs.push({ ref: 'refs/heads/master', sha: C }, { ref: 'refs/tags/v1.0.0', sha: TAG_OBJ });
        }
        if (stepId === 'github-release') {
          adapters._state.releases.set('v1.0.0', { id: REL_ID, tag_name: 'v1.0.0', assets: [] });
        }
        if (stepId === 'ghcr-publish') {
          adapters._state.publicVersions.set('ebb-orchestrator@1.0.0', { digest: GHCR_DIGEST, labels: { version: '1.0.0' }, visibility: 'public' });
        }
        throw new Error(`FAULT_AFTER_REMOTE_SUCCESS_${stepId}`);
      },
    };
    const report = await publish({
      commonDir: dir, operationId: OP, config: CFG,
      receipt: seeded.receipt, evidence: seeded.evidence, runIdentity: runIdentityFixture(),
      adapters, targets: publishTargets(), faults, now: NOW,
    });
    assert.equal(report.status, 'PARTIAL');
    assert.ok(report.remainingIdentities.includes(stepId));
    const state = await readJson(dir, 'state.json');
    assert.equal(state.status, 'PARTIAL');
    assert.equal(state.steps[stepId].status, 'requested');

    // resume: reconciliation sees the landed artifact and completes without re-executing it
    const again = await resume({
      commonDir: dir, operationId: OP, config: CFG,
      receipt: seeded.receipt, evidence: seeded.evidence, runIdentity: runIdentityFixture(),
      adapters, targets: publishTargets(), faults: noFaults, now: NOW,
    });
    assert.equal(again.status, 'PUBLISHED', JSON.stringify(again.blockers));
    const publishCount = log.filter((entry) => entry.slot === 'ghcr' && entry.name === 'publish').length;
    if (stepId === 'ghcr-publish') {
      assert.equal(publishCount, 1, 'ghcr publish must not re-execute after remote success');
    }
    await rm(dir, { recursive: true, force: true });
  });

  test(`publish crash before checkpoint at ${stepId} is PARTIAL and resume completes`, async () => {
    const dir = await makeJournal();
    const seeded = await seedOperation(dir);
    const { adapters, log } = makeAdapters();
    const faults = {
      beforeCheckpoint: (id) => {
        if (id !== stepId) return;
        if (stepId === 'git-cas') {
          adapters._state.refs.push({ ref: 'refs/heads/master', sha: C }, { ref: 'refs/tags/v1.0.0', sha: TAG_OBJ });
        }
        if (stepId === 'github-release') {
          adapters._state.releases.set('v1.0.0', { id: REL_ID, tag_name: 'v1.0.0', assets: [] });
        }
        if (stepId === 'ghcr-publish') {
          adapters._state.publicVersions.set('ebb-orchestrator@1.0.0', { digest: GHCR_DIGEST, labels: { version: '1.0.0' }, visibility: 'public' });
        }
        throw new Error(`FAULT_BEFORE_CHECKPOINT_${stepId}`);
      },
    };
    const report = await publish({
      commonDir: dir, operationId: OP, config: CFG,
      receipt: seeded.receipt, evidence: seeded.evidence, runIdentity: runIdentityFixture(),
      adapters, targets: publishTargets(), faults, now: NOW,
    });
    assert.equal(report.status, 'PARTIAL');
    const again = await resume({
      commonDir: dir, operationId: OP, config: CFG,
      receipt: seeded.receipt, evidence: seeded.evidence, runIdentity: runIdentityFixture(),
      adapters, targets: publishTargets(), faults: noFaults, now: NOW,
    });
    assert.equal(again.status, 'PUBLISHED', JSON.stringify(again.blockers));
    assert.ok(log.length > 0);
    await rm(dir, { recursive: true, force: true });
  });
}

// ---------------------------------------------------------------------------
// PUBLISH — remote anomalies
// ---------------------------------------------------------------------------

test('publish reports CONFLICT on unknown artifact IDs (GHCR digest mismatch)', async () => {
  const dir = await makeJournal();
  const seeded = await seedOperation(dir);
  const { adapters } = makeAdapters({
    ghcr: {
      readPublicVersion: async ({ version }) => ({ digest: `sha256:${'f'.repeat(64)}`, labels: { version }, visibility: 'public' }),
    },
  });
  const report = await publish({
    commonDir: dir, operationId: OP, config: CFG,
    receipt: seeded.receipt, evidence: seeded.evidence, runIdentity: runIdentityFixture(),
    adapters, targets: publishTargets(), faults: noFaults, now: NOW,
  });
  assert.equal(report.status, 'CONFLICT');
  assert.ok(report.blockers.some((blocker) => blocker.code === 'UNKNOWN_ARTIFACT_ID'));
  const state = await readJson(dir, 'state.json');
  assert.equal(state.status, 'CONFLICT');
  await rm(dir, { recursive: true, force: true });
});

test('publish reports CONFLICT on tag collision (remote tag already exists)', async () => {
  const dir = await makeJournal();
  const seeded = await seedOperation(dir);
  const { adapters } = makeAdapters({
    _state: {
      refs: [
        { ref: 'refs/heads/develop', sha: E },
        { ref: 'refs/tags/v1.0.0', sha: '9'.repeat(40) },
      ],
    },
  });
  const report = await publish({
    commonDir: dir, operationId: OP, config: CFG,
    receipt: seeded.receipt, evidence: seeded.evidence, runIdentity: runIdentityFixture(),
    adapters, targets: publishTargets(), faults: noFaults, now: NOW,
  });
  assert.equal(report.status, 'CONFLICT');
  assert.ok(report.blockers.some((blocker) => blocker.code === 'TAG_COLLISION'));
  await rm(dir, { recursive: true, force: true });
});

test('publish BLOCKED when atomic CAS is unsupported', async () => {
  const dir = await makeJournal();
  const seeded = await seedOperation(dir);
  const { adapters, log } = makeAdapters({
    git: { executeRefTransaction: async () => ({ ok: false, code: 'ATOMIC_UNSUPPORTED', detail: 'server does not support atomic push' }) },
  });
  const report = await publish({
    commonDir: dir, operationId: OP, config: CFG,
    receipt: seeded.receipt, evidence: seeded.evidence, runIdentity: runIdentityFixture(),
    adapters, targets: publishTargets(), faults: noFaults, now: NOW,
  });
  assert.equal(report.status, 'BLOCKED');
  assert.ok(report.blockers.some((blocker) => blocker.code === 'ATOMIC_UNSUPPORTED'));
  assert.ok(!log.some((entry) => entry.slot === 'github'));
  await rm(dir, { recursive: true, force: true });
});

test('publish BLOCKED on protected ref refusal', async () => {
  const dir = await makeJournal();
  const seeded = await seedOperation(dir);
  const { adapters } = makeAdapters({
    git: { executeRefTransaction: async () => ({ ok: false, code: 'PROTECTED_REF_REFUSED', detail: 'ruleset refused' }) },
  });
  const report = await publish({
    commonDir: dir, operationId: OP, config: CFG,
    receipt: seeded.receipt, evidence: seeded.evidence, runIdentity: runIdentityFixture(),
    adapters, targets: publishTargets(), faults: noFaults, now: NOW,
  });
  assert.equal(report.status, 'BLOCKED');
  assert.ok(report.blockers.some((blocker) => blocker.code === 'PROTECTED_REF_REFUSED'));
  await rm(dir, { recursive: true, force: true });
});

test('publish BLOCKED on source/master drift after gate', async () => {
  const dir = await makeJournal();
  const seeded = await seedOperation(dir);
  const { adapters } = makeAdapters({
    _state: { refs: [{ ref: 'refs/heads/develop', sha: '9'.repeat(40) }] },
  });
  const report = await publish({
    commonDir: dir, operationId: OP, config: CFG,
    receipt: seeded.receipt, evidence: seeded.evidence, runIdentity: runIdentityFixture(),
    adapters, targets: publishTargets(), faults: noFaults, now: NOW,
  });
  assert.equal(report.status, 'BLOCKED');
  assert.ok(report.blockers.some((blocker) => blocker.code === 'SOURCE_DRIFT' || blocker.code === 'MASTER_DRIFT'));
  await rm(dir, { recursive: true, force: true });
});

test('republish after rollback is BLOCKED (terminal state, no new identity)', async () => {
  const dir = await makeJournal();
  const seeded = await seedOperation(dir, { status: 'ROLLED_BACK', stage: 'rolled-back', mode: 'withdraw', oldMaster: 'ABSENT', root: true });
  const { adapters, log } = makeAdapters();
  const report = await publish({
    commonDir: dir, operationId: OP, config: CFG,
    receipt: seeded.receipt, evidence: seeded.evidence, runIdentity: runIdentityFixture(),
    adapters, targets: publishTargets(), faults: noFaults, now: NOW,
  });
  assert.equal(report.status, 'BLOCKED');
  assert.ok(report.blockers.some((blocker) => blocker.code === 'TERMINAL_STATE'));
  assert.equal(log.length, 0);
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// WITHDRAW
// ---------------------------------------------------------------------------

test('withdraw BLOCKED without a fresh withdraw receipt', async () => {
  const dir = await makeJournal();
  await seedOperation(dir, { mode: 'withdraw', status: 'ROLLBACK_PREPARED', stage: 'rollback-prepared', oldMaster: 'ABSENT', root: true, receipt: false });
  const { adapters, log } = makeAdapters();
  const report = await withdraw({
    commonDir: dir, operationId: OP, config: CFG,
    receipt: null, evidence: withdrawEvidence({ root: true }), runIdentity: runIdentityFixture(),
    adapters, faults: noFaults, now: NOW,
  });
  assert.equal(report.status, 'AWAITING_CONFIRMATION');
  assert.equal(log.length, 0);
  await rm(dir, { recursive: true, force: true });
});

test('withdraw rejects a publish-mode approval (withdrawal partial publish is separate approved intent)', async () => {
  const dir = await makeJournal();
  const seeded = await seedOperation(dir); // publish approval
  const { adapters, log } = makeAdapters();
  const report = await withdraw({
    commonDir: dir, operationId: OP, config: CFG,
    receipt: seeded.receipt, evidence: withdrawEvidence({ root: true }), runIdentity: runIdentityFixture(),
    adapters, faults: noFaults, now: NOW,
  });
  assert.equal(report.status, 'BLOCKED');
  assert.ok(report.blockers.some((blocker) => blocker.code === 'MODE_MISMATCH'));
  assert.equal(log.length, 0);
  await rm(dir, { recursive: true, force: true });
});

test('withdraw known download restriction blocks before any deletion', async () => {
  const dir = await makeJournal();
  const seeded = await seedOperation(dir, { mode: 'withdraw', status: 'ROLLBACK_PREPARED', stage: 'rollback-prepared', oldMaster: 'ABSENT', root: true });
  const { adapters, log } = makeAdapters({
    _state: withdrawRemoteState({ root: true }),
    ghcr: {
      assessEligibility: async () => ({
        eligible: false,
        knownRestrictions: [{ version: '1.0.0', count: 9000 }],
        unknownCounts: [],
        sharedAmbiguity: [],
      }),
    },
  });
  const report = await withdraw({
    commonDir: dir, operationId: OP, config: CFG,
    receipt: seeded.receipt, evidence: withdrawEvidence({ root: true }), runIdentity: runIdentityFixture(),
    adapters, faults: noFaults, now: NOW,
  });
  assert.equal(report.status, 'BLOCKED');
  assert.ok(report.blockers.some((blocker) => blocker.code === 'GHCR_DOWNLOAD_RESTRICTION'));
  assert.ok(!log.some((entry) => entry.slot === 'ghcr' && entry.name === 'delete'));
  assert.ok(!log.some((entry) => entry.slot === 'github'));
  assert.ok(!log.some((entry) => entry.slot === 'git'));
  await rm(dir, { recursive: true, force: true });
});

test('withdraw discloses unavailable download counts as ambiguity and still proceeds', async () => {
  const dir = await makeJournal();
  const seeded = await seedOperation(dir, { mode: 'withdraw', status: 'ROLLBACK_PREPARED', stage: 'rollback-prepared', oldMaster: 'ABSENT', root: true });
  const { adapters } = makeAdapters({
    _state: withdrawRemoteState({ root: true }),
    ghcr: {
      assessEligibility: async () => ({
        eligible: true,
        knownRestrictions: [],
        unknownCounts: [{ version: '1.0.0' }],
        sharedAmbiguity: [],
      }),
    },
  });
  const report = await withdraw({
    commonDir: dir, operationId: OP, config: CFG,
    receipt: seeded.receipt, evidence: withdrawEvidence({ root: true }), runIdentity: runIdentityFixture(),
    adapters, faults: noFaults, now: NOW,
  });
  assert.equal(report.status, 'ROLLED_BACK');
  assert.ok(report.ambiguities.some((ambiguity) => ambiguity.code === 'GHCR_ELIGIBILITY_UNKNOWN'));
  const state = await readJson(dir, 'state.json');
  assert.ok(state.ambiguities.some((ambiguity) => ambiguity.code === 'GHCR_ELIGIBILITY_UNKNOWN'));
  await rm(dir, { recursive: true, force: true });
});

test('withdraw root: master disappears, no dummy restore, no survivor requirement', async () => {
  const dir = await makeJournal();
  const seeded = await seedOperation(dir, { mode: 'withdraw', status: 'ROLLBACK_PREPARED', stage: 'rollback-prepared', oldMaster: 'ABSENT', root: true });
  const { adapters, log } = makeAdapters({ _state: withdrawRemoteState({ root: true }) });
  const report = await withdraw({
    commonDir: dir, operationId: OP, config: CFG,
    receipt: seeded.receipt, evidence: withdrawEvidence({ root: true }), runIdentity: runIdentityFixture(),
    adapters, faults: noFaults, now: NOW,
  });
  assert.equal(report.status, 'ROLLED_BACK');
  assert.equal(report.stage, 'rolled-back');
  const tx = log.find((entry) => entry.name === 'tx');
  assert.ok(tx, 'expected a ref transaction');
  const actions = tx.payload.actions;
  // no create/update actions: only exact deletes (tag + master), never a restore
  for (const action of actions) assert.equal(action.kind, 'delete');
  const refs = actions.map((action) => action.ref);
  assert.ok(refs.includes('refs/tags/v1.0.0'));
  assert.ok(refs.includes('refs/heads/master'));
  assert.ok(!actions.some((action) => action.kind === 'create' || action.kind === 'update'));
  const state = await readJson(dir, 'state.json');
  assert.equal(state.status, 'ROLLED_BACK');
  await rm(dir, { recursive: true, force: true });
});

test('withdraw later release: master moves to pinned parent and survivors stay intact', async () => {
  const dir = await makeJournal();
  const survivors = [
    { version: '0.9.0', packageName: 'ebb-orchestrator', digest: GHCR_DIGEST_2, platforms: ['linux/amd64'] },
  ];
  const seeded = await seedOperation(dir, { mode: 'withdraw', status: 'ROLLBACK_PREPARED', stage: 'rollback-prepared', oldMaster: PARENT, root: false, survivors });
  const { adapters, log } = makeAdapters({ _state: withdrawRemoteState({ root: false, survivors }) });
  const report = await withdraw({
    commonDir: dir, operationId: OP, config: CFG,
    receipt: seeded.receipt, evidence: withdrawEvidence({ root: false }), runIdentity: runIdentityFixture(),
    adapters, faults: noFaults, now: NOW,
  });
  assert.equal(report.status, 'ROLLED_BACK', JSON.stringify(report.blockers));
  const tx = log.find((entry) => entry.name === 'tx');
  const actions = tx.payload.actions;
  const masterAction = actions.find((action) => action.ref === 'refs/heads/master');
  assert.equal(masterAction.kind, 'update');
  assert.equal(masterAction.expected, C);
  assert.equal(masterAction.value, PARENT);
  assert.ok(actions.some((action) => action.kind === 'delete' && action.ref === 'refs/tags/v1.0.0'));
  await rm(dir, { recursive: true, force: true });
});

test('withdraw GHCR deletion refusal after one success is PARTIAL; later Release/ref steps never run', async () => {
  const dir = await makeJournal();
  const seeded = await seedOperation(dir, { mode: 'withdraw', status: 'ROLLBACK_PREPARED', stage: 'rollback-prepared', oldMaster: 'ABSENT', root: true, inventory: withdrawInventoryFixture({ root: true }) });
  const { adapters, log } = makeAdapters({
    _state: withdrawRemoteState({ root: true }),
    ghcr: {
      assessEligibility: async () => ({ eligible: true, knownRestrictions: [], unknownCounts: [], sharedAmbiguity: [] }),
      deleteVersionObjects: async ({ targets }) => ({
        status: 'PARTIAL',
        deleted: [targets[0].version],
        remaining: [targets[0].version],
        refusal: { code: 'GHCR_SERVER_REFUSAL', version: targets[0].version },
      }),
    },
  });
  const report = await withdraw({
    commonDir: dir, operationId: OP, config: CFG,
    receipt: seeded.receipt, evidence: withdrawEvidence({ root: true }), runIdentity: runIdentityFixture(),
    adapters, faults: noFaults, now: NOW,
  });
  assert.equal(report.status, 'PARTIAL');
  assert.ok(report.blockers.some((blocker) => blocker.code === 'PARTIAL_GHCR_DELETION'));
  assert.ok(!log.some((entry) => entry.slot === 'github'));
  assert.ok(!log.some((entry) => entry.slot === 'git'));
  const state = await readJson(dir, 'state.json');
  assert.equal(state.status, 'PARTIAL');
  assert.deepEqual(state.steps['ghcr-delete'].result.deleted, ['1.0.0']);
  assert.deepEqual(state.steps['ghcr-delete'].result.remaining, ['1.0.0']);
  await rm(dir, { recursive: true, force: true });
});

test('resume completes remaining GHCR deletions after PARTIAL_GHCR_DELETION', async () => {
  const dir = await makeJournal();
  const targets = [
    { version: '1.0.0', packageName: 'ebb-orchestrator', digest: GHCR_DIGEST, platforms: ['linux/amd64'] },
    { version: '1.0.0', packageName: 'ebb-orchestrator-extra', digest: GHCR_DIGEST_2, platforms: ['linux/arm64'] },
  ];
  const seeded = await seedOperation(dir, {
    mode: 'withdraw', status: 'ROLLBACK_PREPARED', stage: 'rollback-prepared', oldMaster: 'ABSENT', root: true,
    inventory: {
      repositoryId: 1372710981,
      refs: [
        { ref: 'refs/heads/develop', sha: E },
        { ref: 'refs/heads/master', sha: C },
      ],
      releases: [{ id: REL_ID, tag_name: 'v1.0.0', name: 'Release v1.0.0', draft: false, prerelease: false, assets: [] }],
      assets: [],
      packages: [{ id: 42, name: 'ebb-orchestrator', visibility: 'public', owner: 'vivernet' }],
      versions: targets,
      ociObjects: [
        { version: '1.0.0', tag: 'v1.0.0', topDigest: GHCR_DIGEST, childDigests: [] },
        { version: '1.0.0', tag: 'v1.0.0', topDigest: GHCR_DIGEST_2, childDigests: [] },
      ],
      ownership: { owner: 'vivernet', owned: true, public: true },
      observedAt: '2026-10-24T11:59:00Z',
    },
  });
  const remote = {
    refs: [
      { ref: 'refs/heads/develop', sha: E },
      { ref: 'refs/heads/master', sha: C },
      { ref: 'refs/tags/v1.0.0', sha: TAG_OBJ },
    ],
    parents: { [C]: [] },
    publicVersions: new Map([
      ['ebb-orchestrator@1.0.0', { digest: GHCR_DIGEST, labels: { version: '1.0.0' }, visibility: 'public' }],
      ['ebb-orchestrator-extra@1.0.0', { digest: GHCR_DIGEST_2, labels: { version: '1.0.0' }, visibility: 'public' }],
    ]),
    releases: new Map([['v1.0.0', { id: REL_ID, tag_name: 'v1.0.0', html_url: 'https://github.com/vivernet/ebb-orchestrator/releases/tag/v1.0.0', assets: [] }]]),
  };
  // first attempt: provider deletes only the first target, refuses the second
  const { adapters } = makeAdapters({
    _state: remote,
    ghcr: {
      deleteVersionObjects: async ({ targets: t }) => ({
        status: 'PARTIAL',
        deleted: [t[0].version],
        remaining: [t[1].version],
        refusal: { code: 'GHCR_SERVER_REFUSAL', version: t[1].version },
      }),
    },
  });
  const first = await withdraw({
    commonDir: dir, operationId: OP, config: CFG,
    receipt: seeded.receipt, evidence: withdrawEvidence({ root: true }), runIdentity: runIdentityFixture(),
    adapters, faults: noFaults, now: NOW,
  });
  assert.equal(first.status, 'PARTIAL');
  assert.ok(first.blockers.some((blocker) => blocker.code === 'PARTIAL_GHCR_DELETION'));
  // resume: the already-deleted version is absent remotely; only the remaining one is re-targeted
  const remoteAfterPartial = {
    refs: remote.refs,
    parents: remote.parents,
    publicVersions: new Map([['ebb-orchestrator-extra@1.0.0', { digest: GHCR_DIGEST_2, labels: { version: '1.0.0' }, visibility: 'public' }]]),
    releases: remote.releases,
  };
  const { adapters: againAdapters, log: againLog } = makeAdapters({ _state: remoteAfterPartial });
  const again = await resume({
    commonDir: dir, operationId: OP, config: CFG,
    receipt: seeded.receipt, evidence: withdrawEvidence({ root: true }), runIdentity: runIdentityFixture(),
    adapters: againAdapters, faults: noFaults, now: NOW,
  });
  assert.equal(again.status, 'ROLLED_BACK', JSON.stringify(again.blockers));
  const deletes = againLog.filter((entry) => entry.slot === 'ghcr' && entry.name === 'delete');
  assert.equal(deletes.length, 1);
  assert.deepEqual(deletes[0].payload.targets, [targets[1]]);
  const state = await readJson(dir, 'state.json');
  assert.equal(state.status, 'ROLLED_BACK');
  assert.deepEqual(state.steps['ghcr-delete'].result.remaining, []);
  await rm(dir, { recursive: true, force: true });
});

test('withdraw provider refusal before any success is BLOCKED; Release/refs untouched', async () => {
  const dir = await makeJournal();
  const seeded = await seedOperation(dir, { mode: 'withdraw', status: 'ROLLBACK_PREPARED', stage: 'rollback-prepared', oldMaster: 'ABSENT', root: true });
  const { adapters, log } = makeAdapters({
    _state: withdrawRemoteState({ root: true }),
    ghcr: {
      deleteVersionObjects: async () => ({ status: 'BLOCKED', deleted: [], remaining: ['1.0.0'], refusal: { code: 'GHCR_PERMISSION_DENIED', version: '1.0.0' } }),
    },
  });
  const report = await withdraw({
    commonDir: dir, operationId: OP, config: CFG,
    receipt: seeded.receipt, evidence: withdrawEvidence({ root: true }), runIdentity: runIdentityFixture(),
    adapters, faults: noFaults, now: NOW,
  });
  assert.equal(report.status, 'BLOCKED');
  assert.ok(!log.some((entry) => entry.slot === 'github'));
  assert.ok(!log.some((entry) => entry.slot === 'git'));
  await rm(dir, { recursive: true, force: true });
});

test('withdraw immutable Release order violation: tag removal never precedes Release absence', async () => {
  const dir = await makeJournal();
  const seeded = await seedOperation(dir, { mode: 'withdraw', status: 'ROLLBACK_PREPARED', stage: 'rollback-prepared', oldMaster: 'ABSENT', root: true });
  const { adapters, log } = makeAdapters({
    _state: withdrawRemoteState({ root: true }),
    github: {
      deleteRelease: async () => ({ ok: true }),
      readReleaseByTag: async ({ tag }) => ({ id: REL_ID, tag_name: tag, assets: [] }), // release survives deletion readback
    },
  });
  const report = await withdraw({
    commonDir: dir, operationId: OP, config: CFG,
    receipt: seeded.receipt, evidence: withdrawEvidence({ root: true }), runIdentity: runIdentityFixture(),
    adapters, faults: noFaults, now: NOW,
  });
  assert.equal(report.status, 'CONFLICT');
  assert.ok(report.blockers.some((blocker) => blocker.code === 'IMMUTABLE_RELEASE_ORDER'));
  assert.ok(!log.some((entry) => entry.slot === 'git' && entry.name === 'tx'));
  await rm(dir, { recursive: true, force: true });
});

test('withdraw rollback of an earlier release with descendants is BLOCKED', async () => {
  const dir = await makeJournal();
  const seeded = await seedOperation(dir, { mode: 'withdraw', status: 'ROLLBACK_PREPARED', stage: 'rollback-prepared', oldMaster: 'ABSENT', root: true });
  // master moved forward: target commit is no longer the surviving head
  const { adapters, log } = makeAdapters({
    _state: withdrawRemoteState({ root: false, masterSha: '7'.repeat(40), withTag: true, parents: { ['7'.repeat(40)]: [C] } }),
  });
  const report = await withdraw({
    commonDir: dir, operationId: OP, config: CFG,
    receipt: seeded.receipt, evidence: withdrawEvidence({ root: true }), runIdentity: runIdentityFixture(),
    adapters, faults: noFaults, now: NOW,
  });
  assert.equal(report.status, 'BLOCKED');
  assert.ok(report.blockers.some((blocker) => blocker.code === 'TARGET_NOT_LAST_RELEASE'));
  assert.ok(!log.some((entry) => entry.slot === 'ghcr' && entry.name === 'delete'));
  await rm(dir, { recursive: true, force: true });
});

test('withdraw root with invented parent provenance is BLOCKED (root withdraw without parent image)', async () => {
  const dir = await makeJournal();
  const seeded = await seedOperation(dir, { mode: 'withdraw', status: 'ROLLBACK_PREPARED', stage: 'rollback-prepared', oldMaster: 'ABSENT', root: true });
  const { adapters } = makeAdapters({
    _state: withdrawRemoteState({ root: false, parents: { [C]: [PARENT] } }), // root commit claims a parent -> inconsistency
  });
  const report = await withdraw({
    commonDir: dir, operationId: OP, config: CFG,
    receipt: seeded.receipt, evidence: withdrawEvidence({ root: true }), runIdentity: runIdentityFixture(),
    adapters, faults: noFaults, now: NOW,
  });
  assert.equal(report.status, 'BLOCKED');
  assert.ok(report.blockers.some((blocker) => blocker.code === 'TARGET_PROVENANCE_MISMATCH'));
  await rm(dir, { recursive: true, force: true });
});

test('withdraw final readback sees a missing survivor -> CONFLICT, never ROLLED_BACK', async () => {
  const dir = await makeJournal();
  const survivors = [
    { version: '0.9.0', packageName: 'ebb-orchestrator', digest: GHCR_DIGEST_2, platforms: ['linux/amd64'] },
  ];
  const seeded = await seedOperation(dir, { mode: 'withdraw', status: 'ROLLBACK_PREPARED', stage: 'rollback-prepared', oldMaster: PARENT, root: false, survivors });
  const { adapters } = makeAdapters({
    _state: withdrawRemoteState({ root: false, survivors: [] }), // survivor missing remotely
  });
  const report = await withdraw({
    commonDir: dir, operationId: OP, config: CFG,
    receipt: seeded.receipt, evidence: withdrawEvidence({ root: false }), runIdentity: runIdentityFixture(),
    adapters, faults: noFaults, now: NOW,
  });
  assert.equal(report.status, 'CONFLICT');
  assert.ok(report.blockers.some((blocker) => blocker.code === 'SURVIVOR_INTEGRITY'));
  const state = await readJson(dir, 'state.json');
  assert.notEqual(state.status, 'ROLLED_BACK');
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// RESUME
// ---------------------------------------------------------------------------

test('resume with unchanged bundle + fresh gates proceeds and keeps all immutable IDs', async () => {
  const dir = await makeJournal();
  const seeded = await seedOperation(dir);
  const { adapters } = makeAdapters();
  const faults = { beforeRequest: (id) => { if (id === 'git-cas') throw new Error('FAULT_BEFORE_REQUEST_git-cas'); } };
  const first = await publish({
    commonDir: dir, operationId: OP, config: CFG,
    receipt: seeded.receipt, evidence: seeded.evidence, runIdentity: runIdentityFixture(),
    adapters, targets: publishTargets(), faults, now: NOW,
  });
  assert.equal(first.status, 'BLOCKED');
  const stateBefore = await readJson(dir, 'state.json');
  assert.equal(stateBefore.candidate.candidateSha, C);

  const again = await resume({
    commonDir: dir, operationId: OP, config: CFG,
    receipt: seeded.receipt, evidence: seeded.evidence, runIdentity: runIdentityFixture(),
    adapters, targets: publishTargets(), faults: noFaults, now: NOW,
  });
  assert.equal(again.status, 'PUBLISHED', JSON.stringify(again.blockers));
  assert.equal(again.operationId, OP);
  assert.equal(again.version, '1.0.0');
  assert.equal(again.candidateSha, C);
  const stateAfter = await readJson(dir, 'state.json');
  assert.equal(stateAfter.operationId, OP);
  assert.equal(stateAfter.version, '1.0.0');
  assert.equal(stateAfter.candidate.candidateSha, C);
  assert.equal(stateAfter.candidate.annotatedTagObject.objectSha, TAG_OBJ);
  await rm(dir, { recursive: true, force: true });
});

test('resume rejects a regenerated candidate (new commit inputs)', async () => {
  const dir = await makeJournal();
  const seeded = await seedOperation(dir);
  const { adapters, log } = makeAdapters();
  const first = await publish({
    commonDir: dir, operationId: OP, config: CFG,
    receipt: seeded.receipt, evidence: seeded.evidence, runIdentity: runIdentityFixture(),
    adapters, targets: publishTargets(), faults: { beforeRequest: (id) => { if (id === 'git-cas') throw new Error('FAULT'); } }, now: NOW,
  });
  assert.equal(first.status, 'BLOCKED');
  const regenerated = await resume({
    commonDir: dir, operationId: OP, config: CFG,
    receipt: seeded.receipt, evidence: seeded.evidence, runIdentity: runIdentityFixture(),
    adapters, targets: publishTargets({ candidate: { candidateSha: '5'.repeat(40), candidateTree: T } }), faults: noFaults, now: NOW,
  });
  assert.equal(regenerated.status, 'BLOCKED');
  assert.ok(regenerated.blockers.some((blocker) => blocker.code === 'CANDIDATE_REGENERATED'));
  assert.equal(log.filter((entry) => entry.name === 'tx').length, 0);
  await rm(dir, { recursive: true, force: true });
});

test('resume rejects a changed deletion scope without a fresh receipt', async () => {
  const dir = await makeJournal();
  const seeded = await seedOperation(dir, { mode: 'withdraw', status: 'ROLLBACK_PREPARED', stage: 'rollback-prepared', oldMaster: 'ABSENT', root: true });
  // a new bundle with a changed (larger) deletion scope is written, but the old receipt is reused
  const changedInv = withdrawInventoryFixture({ root: true });
  changedInv.versions.push({ version: '1.0.0', packageName: 'another-image', digest: GHCR_DIGEST_2, platforms: ['linux/arm64'] });
  await seedOperation(dir, { mode: 'withdraw', status: 'ROLLBACK_PREPARED', stage: 'rollback-prepared', oldMaster: 'ABSENT', root: true, inventory: changedInv });
  const { adapters } = makeAdapters();
  const report = await resume({
    commonDir: dir, operationId: OP, config: CFG,
    receipt: seeded.receipt, evidence: withdrawEvidence({ root: true }), runIdentity: runIdentityFixture(),
    adapters, faults: noFaults, now: NOW,
  });
  assert.equal(report.status, 'BLOCKED');
  assert.ok(report.blockers.some((blocker) => blocker.code === 'CONFIRMATION_HASH_MISMATCH' || blocker.code === 'CHANGED_SCOPE_WITHOUT_FRESH_RECEIPT'));
  await rm(dir, { recursive: true, force: true });
});

test('resume of a PARTIAL publish cannot switch to withdraw under the publish approval', async () => {
  const dir = await makeJournal();
  const seeded = await seedOperation(dir);
  const { adapters } = makeAdapters();
  const faults = { afterRemoteSuccess: (id) => { if (id === 'ghcr-publish') throw new Error('FAULT'); } };
  const first = await publish({
    commonDir: dir, operationId: OP, config: CFG,
    receipt: seeded.receipt, evidence: seeded.evidence, runIdentity: runIdentityFixture(),
    adapters, targets: publishTargets(), faults, now: NOW,
  });
  assert.equal(first.status, 'PARTIAL');
  const withdrawn = await withdraw({
    commonDir: dir, operationId: OP, config: CFG,
    receipt: seeded.receipt, evidence: withdrawEvidence({ root: true }), runIdentity: runIdentityFixture(),
    adapters, faults: noFaults, now: NOW,
  });
  assert.equal(withdrawn.status, 'BLOCKED');
  assert.ok(withdrawn.blockers.some((blocker) => blocker.code === 'MODE_MISMATCH'));
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// STATUS
// ---------------------------------------------------------------------------

test('status is read-only: reports state, remaining identities and ambiguities, never repairs', async () => {
  const dir = await makeJournal();
  await seedOperation(dir, { status: 'PARTIAL', stage: 'publishing', extraState: {
    steps: {
      verify: { status: 'confirmed' },
      'ghcr-publish': { status: 'confirmed' },
      'git-cas': { status: 'requested', requestedAt: NOW },
      'github-release': { status: 'planned' },
      'final-readback': { status: 'planned' },
    },
    ambiguities: [{ code: 'GHCR_ELIGIBILITY_UNKNOWN', field: 'versions', detail: 'download count unavailable' }],
  } });
  const before = await readFile(join(dir, 'ebb-release', 'operations', OP, 'state.json'), 'utf8');
  const { adapters, log } = makeAdapters();
  const report = await statusOperation({ commonDir: dir, operationId: OP, config: CFG, adapters, now: NOW });
  assert.equal(report.status, 'PARTIAL');
  assert.equal(report.stage, 'publishing');
  assert.deepEqual(report.remainingIdentities, ['git-cas', 'github-release', 'final-readback']);
  assert.ok(report.ambiguities.some((ambiguity) => ambiguity.code === 'GHCR_ELIGIBILITY_UNKNOWN'));
  const after = await readFile(join(dir, 'ebb-release', 'operations', OP, 'state.json'), 'utf8');
  assert.equal(after, before);
  assert.ok(!log.some((entry) => entry.name === 'tx'));
  assert.ok(!log.some((entry) => entry.slot === 'github' && entry.name === 'deleteRelease'));
  await rm(dir, { recursive: true, force: true });
});

test('status reports CONFLICT state without touching anything', async () => {
  const dir = await makeJournal();
  await seedOperation(dir, { status: 'CONFLICT', stage: 'publishing', extraState: { steps: { 'git-cas': { status: 'requested' } } } });
  const { adapters, log } = makeAdapters();
  const report = await statusOperation({ commonDir: dir, operationId: OP, config: CFG, adapters, now: NOW });
  assert.equal(report.status, 'CONFLICT');
  assert.deepEqual(report.remainingIdentities, ['git-cas']);
  assert.equal(log.length, 0);
  await rm(dir, { recursive: true, force: true });
});
