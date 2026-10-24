/* global structuredClone */

// plan-26 Task6: pure gate planning/evidence (read/preparation flow).
// Given a validated PolicyV1 + Candidate + RemoteInventory + journal state,
// produces the gate plan, per-check evidence evaluation, evidence digest and
// the concrete ApprovalBundle. Never performs network/remote/registry calls,
// never prompts, never auto-approves: the receipt's confirmationHash stays
// null until an explicit external confirmation is supplied.

import { createHash } from 'node:crypto';
import {
  STABLE_SEMVER_PATTERN,
  canonicalJson,
  collectGateBlockers,
  policyHashOf,
  validateConfig,
} from './policy.mjs';
import { validateReservationProof } from './version-reservations.mjs';
import { validatePinnedSource, ABSENT } from './snapshot.mjs';
import { inventoryHashOf } from './github.mjs';

export const GATES_SCHEMA_VERSION = 1;

const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const STABLE_SEMVER_RE = new RegExp(`^${STABLE_SEMVER_PATTERN}$`);
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const CANDIDATE_REF_RE = /^refs\/heads\/ebb-release-candidates\//;

const MODES = new Set(['publish', 'withdraw']);
const CONCLUSIONS = new Set(['success', 'failure', 'skipped', 'missing', 'expired']);
const DEFAULT_MAX_EVIDENCE_AGE_MS = 10 * 60 * 1000;

// WITHDRAW safety subset (plan-26 section 15): trusted release-tool
// regressions, exact target/root-or-parent provenance, surviving-publication
// integrity only when a parent exists, permissions/ruleset/deletion
// layout/eligibility evidence and fresh configured local/CI safety checks.
// The defect target app matrix is deliberately NOT part of withdrawal.
const WITHDRAW_SAFETY_SPECS = Object.freeze([
  { command: 'release-tool-regression', platform: 'release-tooling', scope: 'local' },
  { command: 'withdraw-permissions-eligibility', platform: 'release-tooling', scope: 'local' },
  { command: 'withdraw-target-provenance', platform: 'release-tooling', scope: 'local' },
  { command: 'withdraw-safety-checks', platform: 'quality-security-ubuntu-node24', scope: 'ci' },
]);
const WITHDRAW_SURVIVOR_SPEC = Object.freeze({ command: 'withdraw-survivor-integrity', platform: 'release-tooling', scope: 'local' });

function failList(...blockers) {
  return { valid: false, blockers };
}

function isFullSha(value) {
  return typeof value === 'string' && FULL_SHA_RE.test(value);
}

function isValidTimestamp(value) {
  if (typeof value !== 'string' || !TIMESTAMP_RE.test(value)) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const iso = date.toISOString();
  return value.includes('.') ? iso === value : iso === `${value.slice(0, -1)}.000Z`;
}

function epochMs(timestamp) {
  return Date.parse(timestamp);
}

function inventoryRefs(inventory) {
  return Array.isArray(inventory?.refs) ? inventory.refs : [];
}

function inventoryRefSha(inventory, ref) {
  const entry = inventoryRefs(inventory).find((item) => item && item.ref === ref);
  return entry && typeof entry.sha === 'string' ? entry.sha : null;
}

function repositoryIdentityBlockers(config, inventory) {
  const blockers = [];
  const repository = config && config.repository;
  if (!inventory || typeof inventory !== 'object') {
    blockers.push({ code: 'INVENTORY_SHAPE', field: 'inventory', detail: 'remote inventory must be a JSON object' });
    return blockers;
  }
  if (inventory.repositoryId !== repository?.id) {
    blockers.push({ code: 'REPO_IDENTITY_MISMATCH', field: 'inventory.repositoryId', detail: `inventory repository id ${inventory.repositoryId} does not match policy id ${repository?.id}` });
  }
  const ownership = inventory.ownership;
  if (!ownership || ownership.owner !== repository?.owner) {
    blockers.push({ code: 'REPO_IDENTITY_MISMATCH', field: 'inventory.ownership.owner', detail: `inventory owner ${ownership?.owner} does not match policy owner ${repository?.owner}` });
  }
  return blockers;
}

function suggestedVersions(inventory) {
  const tags = Array.isArray(inventory?.releases) ? inventory.releases.map((release) => release?.tag_name).filter(Boolean) : [];
  let maxMinor = -1;
  let base = null;
  for (const tag of tags) {
    const match = String(tag).match(/^v(\d+)\.(\d+)\.\d+$/);
    if (match) {
      const minor = Number(match[2]);
      if (minor > maxMinor) {
        maxMinor = minor;
        base = { major: Number(match[1]), minor };
      }
    }
  }
  if (base) return [`${base.major}.${base.minor + 1}.0`];
  return ['1.0.0'];
}

export function planGates({ config, mode, pinnedSource, candidate, reservationProof, inventory, version }) {
  const blockers = [];
  const fail = (code, field, detail) => blockers.push({ code, field, detail });

  const configResult = validateConfig(config);
  if (!configResult.valid) {
    for (const blocker of configResult.blockers) fail(blocker.code, `config.${blocker.field}`, blocker.detail);
    return { valid: false, plan: { mode: mode ?? null, version: version ?? null, policyHash: null }, blockers, nextAction: null };
  }
  const policyHash = policyHashOf(config);

  if (!MODES.has(mode)) {
    fail('MODE_UNKNOWN', 'mode', `expected publish|withdraw, got ${JSON.stringify(mode)}`);
  }

  const requestedVersion = version ?? null;
  if (requestedVersion === null) {
    fail('VERSION_REQUIRED', 'version', 'no version was provided; a version must be chosen explicitly, never silently inferred');
  } else if (!STABLE_SEMVER_RE.test(requestedVersion)) {
    fail('SEMVER_ENCODING_VIOLATION', 'version', `"${requestedVersion}" violates stable MAJOR.MINOR.PATCH-only encoding`);
  }

  for (const blocker of repositoryIdentityBlockers(config, inventory)) blockers.push(blocker);

  const masterSha = inventoryRefSha(inventory, config.repository?.releaseBranch);
  const developSha = inventoryRefSha(inventory, 'refs/heads/develop');
  const releaseCount = Array.isArray(inventory?.releases) ? inventory.releases.length : 0;

  // Dummy legacy master: a master ref with zero releases is pre-transition
  // residue, never a legitimate release baseline.
  if (masterSha !== null && releaseCount === 0) {
    fail('BLOCKED_LEGACY_MASTER', 'inventory.refs', 'master exists with zero releases: legacy master pre-transition must be removed by the approved transition, not treated as a release');
  }

  if (mode === 'publish') {
    if (!pinnedSource || typeof pinnedSource !== 'object') {
      fail('PINNED_SOURCE_SHAPE', 'pinnedSource', 'publish requires a pinned source');
    } else {
      const pinned = validatePinnedSource(pinnedSource);
      for (const blocker of pinned.blockers) blockers.push(blocker);
      if (pinned.valid) {
        if (developSha !== null && developSha !== pinnedSource.sourceSha) {
          fail('SOURCE_DRIFT', 'inventory.refs', `develop head ${developSha} differs from pinned source ${pinnedSource.sourceSha}`);
        }
        const oldMaster = pinnedSource.oldMaster;
        if (oldMaster === ABSENT) {
          if (masterSha !== null) fail('MASTER_DRIFT', 'inventory.refs', `root source pinned with ABSENT old master but master ref ${masterSha} exists`);
        } else if (masterSha === null || masterSha !== oldMaster) {
          fail('MASTER_DRIFT', 'inventory.refs', `pinned previous master ${oldMaster} does not equal inventory master ${masterSha ?? 'ABSENT'}`);
        }
      }
    }

    if (!candidate || typeof candidate !== 'object') {
      fail('CANDIDATE_SHAPE', 'candidate', 'publish requires a candidate');
    } else if (pinnedSource && typeof pinnedSource === 'object' && pinnedSource.valid !== false) {
      if (!isFullSha(candidate.candidateSha) || !isFullSha(candidate.candidateTree)) {
        fail('CANDIDATE_SHAPE', 'candidate', 'candidate requires full candidateSha/candidateTree');
      } else if (candidate.candidateTree !== pinnedSource.sourceTree) {
        fail('CANDIDATE_TREE_MISMATCH', 'candidate.candidateTree', 'candidate tree must equal the pinned source tree (dummy commit shape)');
      }
      const expectedParent = pinnedSource.oldMaster === ABSENT ? null : pinnedSource.oldMaster;
      if (candidate.parent !== expectedParent) {
        fail('CANDIDATE_PARENT_MISMATCH', 'candidate.parent', `candidate parent ${candidate.parent} does not match pinned old master ${expectedParent ?? 'ABSENT'}`);
      }
    }

    if (requestedVersion !== null && releaseCount > 0 && Array.isArray(inventory?.releases)) {
      const tag = `v${requestedVersion}`;
      if (inventory.releases.some((release) => release && release.tag_name === tag)) {
        fail('IMMUTABLE_RELEASE_TAG', 'inventory.releases', `Release for ${tag} already exists; the version is consumed and the tag cannot be republished`);
      }
    }
  }

  if (mode === 'withdraw') {
    if (masterSha === null) {
      fail('TARGET_MASTER_MISSING', 'inventory.refs', 'withdraw requires the surviving master ref of the target release');
    }
    if (!pinnedSource || typeof pinnedSource !== 'object') {
      fail('PINNED_SOURCE_SHAPE', 'pinnedSource', 'withdraw requires a target provenance (oldMaster = parent or ABSENT)');
    } else {
      const oldMaster = pinnedSource.oldMaster;
      if (oldMaster !== ABSENT && !isFullSha(oldMaster)) {
        fail('PINNED_SOURCE_OLD_MASTER', 'pinnedSource.oldMaster', 'withdraw oldMaster must be ABSENT or a full parent SHA');
      }
    }
  }

  if (!reservationProof || typeof reservationProof !== 'object') {
    fail('RESERVATION_MISSING', 'reservationProof', 'a confirmed reservation proof is required before any gate planning');
  } else {
    const proof = validateReservationProof(reservationProof);
    for (const blocker of proof.blockers) fail(blocker.code, `reservationProof.${blocker.field}`, blocker.detail);
    if (requestedVersion !== null && proof.valid && reservationProof.version !== requestedVersion) {
      fail('RESERVATION_VERSION_MISMATCH', 'reservationProof.version', `reservation version ${reservationProof.version} does not match requested version ${requestedVersion}`);
    }
  }

  const requiredSpecs = [];
  let rootWithdraw = false;
  let parentPresent = false;
  if (mode === 'publish') {
    for (const platform of config.gates?.requiredPlatforms ?? []) {
      if (platform.status !== 'configured') continue;
      for (const check of platform.requiredChecks ?? []) {
        requiredSpecs.push({ command: check, platform: platform.id, scope: 'ci' });
      }
    }
  } else if (mode === 'withdraw') {
    rootWithdraw = !pinnedSource || pinnedSource.oldMaster === ABSENT;
    parentPresent = !rootWithdraw;
    requiredSpecs.push(...WITHDRAW_SAFETY_SPECS);
    if (parentPresent) requiredSpecs.push(WITHDRAW_SURVIVOR_SPEC);
  }

  if (mode === 'publish') {
    const coveredIds = (config.gates?.requiredPlatforms ?? []).filter((platform) => platform.status === 'configured').map((platform) => platform.id);
    for (const blocker of collectGateBlockers(config, coveredIds)) blockers.push(blocker);
  }

  const plan = {
    schemaVersion: GATES_SCHEMA_VERSION,
    mode: mode ?? null,
    version: requestedVersion,
    policyHash,
    sourceSha: pinnedSource && typeof pinnedSource === 'object' ? (pinnedSource.sourceSha ?? null) : null,
    sourceTree: pinnedSource && typeof pinnedSource === 'object' ? (pinnedSource.sourceTree ?? null) : null,
    candidateSha: mode === 'publish' && candidate && typeof candidate === 'object' ? (candidate.candidateSha ?? null) : null,
    targetSha: mode === 'withdraw' ? masterSha : null,
    rootWithdraw,
    parentPresent,
    requiredSpecs,
    publishMatrix: mode === 'publish' ? (config.gates?.requiredPlatforms ?? []).map((platform) => platform.id) : null,
    safetySubset: mode === 'withdraw',
    pinnedSource: pinnedSource && typeof pinnedSource === 'object' ? structuredClone(pinnedSource) : null,
    candidate: mode === 'publish' && candidate && typeof candidate === 'object' ? structuredClone(candidate) : null,
    inventoryHash: inventory ? inventoryHashOf(inventory) : null,
  };

  const nextAction =
    requestedVersion === null && blockers.some((blocker) => blocker.code === 'VERSION_REQUIRED')
      ? { kind: 'VERSION_CHOICE_REQUIRED', suggestedVersions: suggestedVersions(inventory) }
      : null;

  return { valid: blockers.length === 0, plan, blockers, nextAction };
}

function checkConclusionCode(conclusion) {
  switch (conclusion) {
    case 'success':
      return null;
    case 'failure':
      return 'GATE_CHECK_FAILED';
    case 'skipped':
      return 'GATE_CHECK_SKIPPED';
    case 'missing':
      return 'GATE_CHECK_MISSING';
    case 'expired':
      return 'GATE_CHECK_EXPIRED';
    default:
      return 'GATE_EVIDENCE_SHAPE';
  }
}

function scoreEvidence(item, spec, ctx) {
  const blockers = [];
  const fail = (code, field, detail) => blockers.push({ code, field, detail });

  if (typeof item.commandIdentity !== 'string' || item.commandIdentity.length === 0) fail('GATE_EVIDENCE_SHAPE', 'commandIdentity', 'commandIdentity required');
  if (!CONCLUSIONS.has(item.conclusion)) fail('GATE_EVIDENCE_SHAPE', 'conclusion', `unknown conclusion ${JSON.stringify(item.conclusion)}`);
  if (!isValidTimestamp(item.timestamp)) fail('GATE_EVIDENCE_SHAPE', 'timestamp', 'timestamp must be a valid UTC ISO-8601 value');
  if (typeof item.logDigest !== 'string' || !SHA256_RE.test(item.logDigest)) fail('GATE_EVIDENCE_SHAPE', 'logDigest', 'logDigest must be a 64-hex sha256 digest');

  const conclusionCode = checkConclusionCode(item.conclusion);
  if (conclusionCode) fail(conclusionCode, 'conclusion', `check ${item.commandIdentity} concluded ${item.conclusion}; only success is accepted`);

  if (item.platform !== spec.platform) {
    fail('GATE_PLATFORM_IDENTITY', 'platform', `evidence platform ${item.platform} does not match required platform ${spec.platform}`);
  }

  if (ctx.sourceSha !== null) {
    if (typeof item.sourceSha !== 'string' || !isFullSha(item.sourceSha)) fail('GATE_EVIDENCE_SHAPE', 'sourceSha', 'sourceSha must be a full 40-hex commit SHA');
    else if (item.sourceSha !== ctx.sourceSha) fail('GATE_WRONG_SHA', 'sourceSha', `evidence source ${item.sourceSha} differs from pinned source ${ctx.sourceSha}`);
  }
  if (ctx.candidateSha !== null) {
    if (typeof item.candidateSha !== 'string' || !isFullSha(item.candidateSha)) fail('GATE_EVIDENCE_SHAPE', 'candidateSha', 'candidateSha must be a full 40-hex commit SHA');
    else if (item.candidateSha !== ctx.candidateSha) fail('GATE_WRONG_SHA', 'candidateSha', `evidence candidate ${item.candidateSha} differs from expected ${ctx.candidateSha}`);
  }
  if (ctx.sourceTree !== null) {
    if (typeof item.tree !== 'string' || !isFullSha(item.tree)) fail('GATE_EVIDENCE_SHAPE', 'tree', 'tree must be a full 40-hex tree SHA');
    else if (item.tree !== ctx.sourceTree) fail('GATE_TREE_MISMATCH', 'tree', `evidence tree ${item.tree} differs from pinned tree ${ctx.sourceTree}`);
  }

  if (spec.scope === 'ci') {
    if (item.scope !== 'ci' || item.runId === null || item.runId === undefined || item.checkId === null || item.checkId === undefined) {
      fail('GATE_CI_EVIDENCE_REQUIRED', 'scope', 'CI evidence requires scope ci and non-null runId/checkId');
    }
    if (item.event !== 'workflow_dispatch') fail('GATE_CI_CONTEXT', 'event', `CI evidence event ${item.event} is not the trusted manual validation dispatch`);
    if (typeof item.ref !== 'string' || !CANDIDATE_REF_RE.test(item.ref)) fail('GATE_CI_CONTEXT', 'ref', 'CI evidence must reference the authorized candidate ref namespace');
    if (item.headSha !== ctx.candidateSha) fail('GATE_CI_CONTEXT', 'headSha', `CI evidence head ${item.headSha} must equal the tested candidate ${ctx.candidateSha}`);
  } else {
    for (const field of ['runId', 'checkId', 'event', 'ref', 'headSha']) {
      if (item[field] !== null && item[field] !== undefined) {
        fail('GATE_EVIDENCE_SHAPE', field, `${field} must be explicitly null for non-CI evidence`);
      }
    }
    if (item.scope !== 'local') fail('GATE_EVIDENCE_SHAPE', 'scope', 'non-CI evidence must have scope local');
  }

  return { valid: blockers.length === 0, blockers };
}

export function evaluateGates({ config, plan, evidence, now }) {
  const blockers = [];
  const fail = (code, field, detail) => blockers.push({ code, field, detail });

  if (!plan || typeof plan !== 'object') {
    return { valid: false, conclusion: 'blocked', gateResults: [], blockers: [{ code: 'GATE_PLAN_SHAPE', field: 'plan', detail: 'gate plan required' }], evidence: [], gateEvidenceHash: null, policyHash: policyHashOf(config), planHash: null };
  }
  const policyHash = policyHashOf(config);
  if (typeof plan.policyHash === 'string' && plan.policyHash !== policyHash) {
    fail('APPROVAL_POLICY_HASH_MISMATCH', 'plan.policyHash', `plan was built under policy ${plan.policyHash}, config is ${policyHash}`);
  }

  const items = Array.isArray(evidence) ? evidence : [];
  const ctx = {
    sourceSha: typeof plan.sourceSha === 'string' ? plan.sourceSha : null,
    sourceTree: typeof plan.sourceTree === 'string' ? plan.sourceTree : null,
    candidateSha: typeof plan.candidateSha === 'string' ? plan.candidateSha : (typeof plan.targetSha === 'string' ? plan.targetSha : null),
  };
  const maxAgeMs = config.gates?.maxEvidenceAgeMs ?? DEFAULT_MAX_EVIDENCE_AGE_MS;
  const referenceMs = now !== undefined ? epochMs(now) : Date.now();

  const specs = Array.isArray(plan.requiredSpecs) ? plan.requiredSpecs : [];
  const commandIndex = new Map();
  for (const spec of specs) {
    const list = commandIndex.get(spec.command) ?? [];
    list.push(spec);
    commandIndex.set(spec.command, list);
  }

  const gateResults = [];
  const matchedKeys = new Set();
  for (const spec of specs) {
    const matches = items.filter((item) => item && item.platform === spec.platform && item.commandIdentity === spec.command);
    if (matches.length === 0) {
      const miss = { code: 'GATE_CHECK_MISSING', field: `gates.${spec.platform}.${spec.command}`, detail: `required check ${spec.command} on ${spec.platform} has no evidence` };
      blockers.push(miss);
      gateResults.push({ spec, conclusion: 'missing', blockers: [miss] });
      continue;
    }
    matchedKeys.add(`${spec.platform}\u0000${spec.command}`);
    const perCheck = [];
    let specValid = true;
    for (const item of matches) {
      const scored = scoreEvidence(item, spec, ctx);
      if (scored.valid) {
        const elapsed = referenceMs - epochMs(item.timestamp);
        if (Number.isNaN(elapsed) || elapsed < 0 || elapsed > maxAgeMs) {
          scored.blockers.push({ code: 'GATE_EVIDENCE_EXPIRED', field: 'timestamp', detail: `evidence ${item.commandIdentity} is stale (age ${elapsed}ms > ${maxAgeMs}ms)` });
        }
      }
      if (scored.blockers.length > 0) {
        specValid = false;
        blockers.push(...scored.blockers);
      }
      perCheck.push({ evidence: item, conclusion: scored.valid ? 'success' : 'blocked', blockers: scored.blockers });
    }
    gateResults.push({ spec, conclusion: specValid ? 'success' : 'blocked', checks: perCheck });
  }

  for (const item of items) {
    if (!item || typeof item !== 'object') {
      blockers.push({ code: 'GATE_EVIDENCE_SHAPE', field: 'evidence', detail: 'evidence entry must be a JSON object' });
      continue;
    }
    const candidates = commandIndex.get(item.commandIdentity) ?? [];
    const exact = candidates.find((spec) => spec.platform === item.platform);
    if (exact) {
      if (!matchedKeys.has(`${item.platform}\u0000${item.commandIdentity}`)) {
        blockers.push({ code: 'GATE_CHECK_UNKNOWN', field: 'evidence', detail: `evidence check ${item.commandIdentity} on ${item.platform} is not part of the gate plan for this mode` });
      }
      continue;
    }
    if (candidates.length > 0) {
      blockers.push({ code: 'GATE_PLATFORM_IDENTITY', field: 'platform', detail: `evidence check ${item.commandIdentity} runs on platform ${item.platform}, but the plan requires ${candidates.map((spec) => spec.platform).join('|')}` });
    } else {
      blockers.push({ code: 'GATE_CHECK_UNKNOWN', field: 'evidence', detail: `evidence check ${item.commandIdentity} on ${item.platform} is not part of the gate plan for this mode` });
    }
  }

  const valid = blockers.length === 0;
  return {
    valid,
    conclusion: valid ? 'success' : 'blocked',
    gateResults,
    blockers,
    evidence: items,
    gateEvidenceHash: gateEvidenceDigest(items),
    policyHash,
    planHash: createHash('sha256').update(canonicalJson({ mode: plan.mode, specs })).digest('hex'),
  };
}

export function gateEvidenceDigest(evidence) {
  return createHash('sha256').update(canonicalJson(evidence ?? [])).digest('hex');
}

function withdrawTargets(inventory, version) {
  const targets = [];
  const packages = Array.isArray(inventory?.packages) ? inventory.packages : [];
  for (const pkg of packages) {
    const versions = Array.isArray(pkg?.versions) ? pkg.versions : [];
    for (const v of versions) {
      if (v && v.version === version) {
        targets.push({ packageName: pkg.name, version, digest: v.digest ?? null, platforms: Array.isArray(v.platforms) ? v.platforms : [] });
      }
    }
  }
  const versions = Array.isArray(inventory?.versions) ? inventory.versions : [];
  for (const v of versions) {
    if (v && v.version === version) {
      targets.push({ packageName: v.packageName ?? null, version, digest: v.digest ?? null, platforms: Array.isArray(v.platforms) ? v.platforms : [] });
    }
  }
  return targets;
}

function buildActions({ mode, config, pinnedSource, candidate, inventory, version, operationId, parentSha }) {
  const tag = `v${version}`;
  if (mode === 'publish') {
    const oldMaster = pinnedSource.oldMaster;
    return [
      { kind: 'create-candidate-ref', ref: `refs/heads/ebb-release-candidates/${operationId}`, value: candidate.candidateSha },
      { kind: 'create-annotated-tag', name: tag, target: candidate.candidateSha },
      { kind: 'cas-master', ref: config.repository.releaseBranch, expected: oldMaster === ABSENT ? '0'.repeat(40) : oldMaster, value: candidate.candidateSha },
      { kind: 'create-github-release', name: tag, target: candidate.candidateSha, assets: [] },
      { kind: 'publish-ghcr-versions', version, packages: [] },
    ];
  }
  const masterSha = inventoryRefSha(inventory, config.repository.releaseBranch);
  const release = Array.isArray(inventory?.releases) ? inventory.releases.find((item) => item && item.tag_name === tag) : null;
  const actions = [];
  const targets = withdrawTargets(inventory, version);
  for (const target of targets) actions.push({ kind: 'delete-ghcr-version', ...target });
  actions.push({ kind: 'delete-github-release', releaseId: release?.id ?? null, tag });
  actions.push({ kind: 'cas-master', ref: config.repository.releaseBranch, expected: masterSha, value: parentSha ?? '0'.repeat(40) });
  actions.push({ kind: 'delete-annotated-tag', name: tag });
  return actions;
}

export function buildApprovalBundle({ config, mode, pinnedSource, candidate, reservationProof, inventory, gates, operationId }) {
  const blockers = [];
  const fail = (code, field, detail) => blockers.push({ code, field, detail });

  if (!MODES.has(mode)) fail('MODE_UNKNOWN', 'mode', `expected publish|withdraw, got ${JSON.stringify(mode)}`);
  for (const blocker of repositoryIdentityBlockers(config, inventory)) blockers.push(blocker);
  if (!gates || typeof gates !== 'object') {
    fail('APPROVAL_GATES_MISSING', 'gates', 'validated gates are required for an approval bundle');
  } else {
    if (typeof gates.policyHash === 'string' && gates.policyHash !== policyHashOf(config)) {
      fail('APPROVAL_POLICY_HASH_MISMATCH', 'gates.policyHash', `gates were evaluated under policy ${gates.policyHash}, config is ${policyHashOf(config)}`);
    }
    if (gates.conclusion !== 'success') fail('APPROVAL_GATES_NOT_SUCCESS', 'gates.conclusion', 'approval bundle requires success gate conclusion');
  }

  const policyHash = policyHashOf(config);
  const inventoryHash = inventoryHashOf(inventory);
  const gateEvidenceHash = typeof gates?.gateEvidenceHash === 'string' ? gates.gateEvidenceHash : gateEvidenceDigest(gates?.evidence ?? []);
  const version = reservationProof && typeof reservationProof === 'object' ? reservationProof.version : null;

  let parentSha = null;
  if (mode === 'withdraw' && pinnedSource && typeof pinnedSource === 'object' && pinnedSource.oldMaster !== ABSENT) {
    parentSha = pinnedSource.oldMaster;
  }
  let actions = [];
  if (mode === 'publish') {
    if (!candidate || typeof candidate !== 'object' || !isFullSha(candidate.candidateSha)) {
      fail('CANDIDATE_SHAPE', 'candidate', 'publish bundle requires a candidate with full candidateSha');
    } else {
      actions = buildActions({ mode, config, pinnedSource, candidate, inventory, version, operationId });
    }
  } else {
    if (inventoryRefSha(inventory, config.repository?.releaseBranch) === null) {
      fail('TARGET_MASTER_MISSING', 'inventory.refs', 'withdraw bundle requires the surviving master ref of the target release');
    } else {
      actions = buildActions({ mode, config, pinnedSource, candidate, inventory, version, operationId, parentSha });
    }
  }

  const pins = {
    policyHash,
    workflows: config.trustedBindings?.workflows ?? null,
    scriptBundle: config.trustedBindings?.scriptBundle ?? null,
  };

  const bundle = {
    schemaVersion: GATES_SCHEMA_VERSION,
    operationId,
    mode,
    repositoryId: config.repository?.id ?? null,
    version,
    sourceRef: pinnedSource && typeof pinnedSource === 'object' ? (pinnedSource.sourceRef ?? null) : null,
    sourceSha: pinnedSource && typeof pinnedSource === 'object' ? (pinnedSource.sourceSha ?? null) : null,
    sourceTree: pinnedSource && typeof pinnedSource === 'object' ? (pinnedSource.sourceTree ?? null) : null,
    oldMaster: pinnedSource && typeof pinnedSource === 'object' ? (pinnedSource.oldMaster ?? null) : null,
    candidateSha: candidate && typeof candidate === 'object' ? (candidate.candidateSha ?? null) : null,
    candidateTree: candidate && typeof candidate === 'object' ? (candidate.candidateTree ?? null) : null,
    policyHash,
    reservationProof: reservationProof && typeof reservationProof === 'object' ? structuredClone(reservationProof) : null,
    inventoryHash,
    gateEvidenceHash,
    actions,
    pins,
    receipt: { approvalHash: null, confirmationHash: null, confirmedAt: null },
  };

  const approvalHash = createHash('sha256').update(canonicalJson({ mode, actions, pins, reservationProof: bundle.reservationProof, inventoryHash, gateEvidenceHash, policyHash })).digest('hex');
  const expectedConfirmationHash = createHash('sha256').update(canonicalJson({ approvalHash, actions })).digest('hex');
  bundle.receipt.approvalHash = approvalHash;
  bundle.expectedConfirmationHash = expectedConfirmationHash;

  return {
    valid: blockers.length === 0,
    bundle,
    blockers,
    approvalHash,
    expectedConfirmationHash,
    inventoryHash,
    gateEvidenceHash,
  };
}

export function confirmApprovalBundle(bundle, confirmationHash) {
  if (typeof confirmationHash !== 'string' || !SHA256_RE.test(confirmationHash) || confirmationHash !== bundle.expectedConfirmationHash) {
    return failList({ code: 'CONFIRMATION_HASH_MISMATCH', field: 'confirmationHash', detail: 'confirmation hash must be the 64-hex sha256 digest bound to this exact action bundle, provided explicitly by the user' });
  }
  const receipt = {
    approvalHash: bundle.approvalHash ?? null,
    confirmationHash,
    confirmedAt: new Date().toISOString(),
  };
  return { valid: true, receipt, blockers: [] };
}
