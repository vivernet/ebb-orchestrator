// plan-26 Task7: operations state machines (PUBLISH/WITHDRAW/RESUME/STATUS)
// through journalled adapters. This module exposes the intent/stage/
// reconciliation primitives that Task8's trusted release-operations workflow
// will invoke; the local process is NOT a public writer. It never performs
// real remote writes on its own — every remote side effect goes through the
// injected `adapters` (mocked in tests, wired to real providers by Task8).
//
// Adapter contract (all methods async; results/mutations recorded in the
// operation journal before and after every remote boundary):
//   adapters.git.readRemoteRefs() -> [{ref, sha}]
//   adapters.git.readCommitParents({sha}) -> [parentSha...]
//   adapters.git.executeRefTransaction({actions}) -> {ok:true} | {ok:false, code, detail}
//     actions: [{kind:'create'|'update'|'delete', ref, value?, expected?}]
//   adapters.ghcr.assessEligibility({targets}) ->
//     {eligible, knownRestrictions:[{version,count}], unknownCounts:[{version}], sharedAmbiguity:[...]}
//   adapters.ghcr.publishVersionObjects({owner, packageName, version, sourceSha, sourceUrl, platforms})
//     -> {ok:true, digests:[...]} | {ok:false, code, detail}
//   adapters.ghcr.readPublicVersion({packageName, version}) -> null | {digest, labels, visibility}
//   adapters.ghcr.deleteVersionObjects({targets}) ->
//     {status:'OK'|'PARTIAL'|'BLOCKED', deleted:[...], remaining:[...], refusal:{code, version}?}
//   adapters.github.createRelease({tag, target, name, assets}) -> {releaseId, htmlUrl}
//   adapters.github.deleteRelease({releaseId, tag}) -> {ok:true}
//   adapters.github.readReleaseByTag({tag}) -> null | {id, tag_name, assets}
//   adapters.github.verifyReleaseAssets({releaseId, assets}) -> {ok:true}
//   adapters.workflow.getRun({runId}) -> {status, conclusion}
//
// Fault injection: `faults.beforeRequest(stepId)`, `faults.afterRemoteSuccess(stepId)`,
// `faults.beforeCheckpoint(stepId)` — thrown errors simulate crashes/timeouts at
// every remote boundary (intent persisted but request not sent; remote accepted
// but result lost; reconciled but checkpoint not persisted).

import { createHash } from 'node:crypto';
import {
  readApproval,
  readGates,
  readInventory,
  readState,
  safeError,
  writeState,
  appendEvent,
  acquireLock,
} from './journal.mjs';
import { canonicalJson, policyHashOf, validateConfig } from './policy.mjs';
import { evaluateGates } from './gates.mjs';
import { inventoryHashOf } from './github.mjs';
import { ABSENT } from './snapshot.mjs';

export const OPERATIONS_SCHEMA_VERSION = 1;

const ZERO40 = '0'.repeat(40);
const RUN_ID_RE = /^[A-Za-z0-9._-]+$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

const REPORT_FIELDS = [
  'schemaVersion',
  'operationId',
  'mode',
  'status',
  'stage',
  'repositoryId',
  'version',
  'sourceRef',
  'sourceSha',
  'sourceTree',
  'oldMaster',
  'candidateSha',
  'candidateTree',
  'policyHash',
  'reservationProof',
  'inventoryHash',
  'gateEvidenceHash',
  'confirmationHash',
  'remoteIdentities',
  'blockers',
  'nextAction',
  'remainingIdentities',
  'ambiguities',
];

const REFUSAL_BLOCKED_CODES = new Set([
  'ATOMIC_UNSUPPORTED',
  'PROTECTED_REF_REFUSED',
  'GHCR_SERVER_REFUSAL',
  'GHCR_PERMISSION_DENIED',
  'GHCR_AUTH_FAILED',
  'GH_RELEASE_DELETE_REFUSED',
  'IMMUTABLE_RELEASE_ORDER',
  'CAS_REFUSED',
]);

export class OperationError extends Error {
  constructor(code, detail, { field } = {}) {
    super(detail ?? code);
    this.name = 'OperationError';
    this.code = code;
    if (field !== undefined) this.field = field;
  }
}

export function isValidTimestamp(value) {
  if (typeof value !== 'string' || !TIMESTAMP_RE.test(value)) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const iso = date.toISOString();
  return value.includes('.') ? iso === value : iso === `${value.slice(0, -1)}.000Z`;
}

function makeReport(fields) {
  const report = {};
  for (const field of REPORT_FIELDS) report[field] = fields[field] ?? null;
  return report;
}

function refSha(refs, ref) {
  const entry = Array.isArray(refs) ? refs.find((item) => item && item.ref === ref) : null;
  return entry && typeof entry.sha === 'string' ? entry.sha : null;
}

function isSameObject(a, b) {
  return canonicalJson(a) === canonicalJson(b);
}

function nowIso(now) {
  return now ?? new Date().toISOString();
}

// --- input validation ------------------------------------------------------

export function validateRunIdentity(runIdentity, config) {
  if (!runIdentity || typeof runIdentity !== 'object') {
    return { valid: false, blockers: [{ code: 'RUN_IDENTITY_SHAPE', field: 'runIdentity', detail: 'trusted serialized-run identity required' }] };
  }
  const blockers = [];
  if (typeof runIdentity.runId !== 'string' || !RUN_ID_RE.test(runIdentity.runId)) {
    blockers.push({ code: 'RUN_IDENTITY_INVALID', field: 'runIdentity.runId', detail: 'runId must be a URL-safe identifier' });
  }
  const binding = config?.trustedBindings?.workflows?.['release-operations.yml'];
  if (!binding || binding.fullSha !== runIdentity.workflowFullSha) {
    blockers.push({ code: 'TRUSTED_RUN_IDENTITY_MISMATCH', field: 'runIdentity.workflowFullSha', detail: 'run identity does not match the pinned trusted release-operations workflow' });
  }
  if (!isValidTimestamp(runIdentity.startedAt)) {
    blockers.push({ code: 'RUN_IDENTITY_INVALID', field: 'runIdentity.startedAt', detail: 'startedAt must be a valid UTC ISO-8601 timestamp' });
  }
  return { valid: blockers.length === 0, blockers };
}

export function verifyReceipt(bundle, receipt) {
  if (!receipt || typeof receipt !== 'object') {
    return { valid: false, blockers: [{ code: 'RECEIPT_MISSING', field: 'receipt', detail: 'an explicit confirmation receipt is required' }] };
  }
  if (typeof receipt.confirmationHash !== 'string' || receipt.confirmationHash.length === 0) {
    return { valid: false, blockers: [{ code: 'CONFIRMATION_HASH_MISMATCH', field: 'receipt.confirmationHash', detail: 'receipt must carry the explicit confirmation hash' }] };
  }
  if (receipt.confirmationHash !== bundle?.expectedConfirmationHash) {
    return { valid: false, blockers: [{ code: 'CONFIRMATION_HASH_MISMATCH', field: 'receipt.confirmationHash', detail: 'confirmation hash is not bound to this exact action bundle; a changed scope requires a fresh receipt' }] };
  }
  // The confirmation hash itself binds the exact action bundle (it is computed
  // over the approval hash and the actions). When the receipt carries an
  // approval hash, it must agree with the stored bundle as well.
  if (receipt.approvalHash != null && receipt.approvalHash !== bundle?.receipt?.approvalHash) {
    return { valid: false, blockers: [{ code: 'APPROVAL_HASH_MISMATCH', field: 'receipt.approvalHash', detail: 'receipt approval hash does not match the stored approval bundle' }] };
  }
  if (!isValidTimestamp(receipt.confirmedAt)) {
    return { valid: false, blockers: [{ code: 'RECEIPT_INVALID', field: 'receipt.confirmedAt', detail: 'confirmedAt must be a valid UTC ISO-8601 timestamp' }] };
  }
  return { valid: true, blockers: [] };
}

function verifyPins(ctx, config, approval, blockers, fail) {
  if (approval.policyHash !== policyHashOf(config)) {
    fail('APPROVAL_POLICY_HASH_MISMATCH', 'approval.policyHash', 'approval was built under a different policy');
  }
  if (approval.inventoryHash !== ctx.state.inventoryHash) {
    fail('APPROVAL_INVENTORY_HASH_MISMATCH', 'approval.inventoryHash', 'approval inventory does not match the persisted operation inventory');
  }
  const stateProof = ctx.state.reservationProof;
  if (!stateProof || !approval.reservationProof || !isSameObject(stateProof, approval.reservationProof)) {
    fail('APPROVAL_RESERVATION_MISMATCH', 'approval.reservationProof', 'approval reservation proof does not match the persisted operation');
  }
  if (approval.operationId !== ctx.state.operationId) {
    fail('APPROVAL_OPERATION_ID_MISMATCH', 'approval.operationId', 'approval is bound to a different operation');
  }
  const stateCandidate = ctx.state.candidate;
  if (approval.mode === 'publish') {
    if (!stateCandidate || approval.candidateSha !== stateCandidate.candidateSha || approval.candidateTree !== stateCandidate.candidateTree) {
      fail('CANDIDATE_REGENERATED', 'candidate', 'approval pins a candidate that does not match the persisted immutable candidate');
    }
  }
}

// --- operation context -----------------------------------------------------

async function openContext({ commonDir, operationId, config }) {
  const stateRead = await readState({ commonDir, operationId });
  if (!stateRead.ok) {
    return { ok: false, blockers: [{ code: stateRead.code, field: 'state', detail: stateRead.detail }] };
  }
  const configResult = validateConfig(config);
  if (!configResult.valid) {
    return { ok: false, blockers: configResult.blockers.map((blocker) => ({ ...blocker, field: `config.${blocker.field}` })) };
  }
  const inventoryRead = await readInventory({ commonDir, operationId });
  const gatesRead = await readGates({ commonDir, operationId });
  const approvalRead = await readApproval({ commonDir, operationId });
  return {
    ok: true,
    state: stateRead.state,
    inventory: inventoryRead.ok ? inventoryRead.value : null,
    gates: gatesRead.ok ? gatesRead.value : null,
    approval: approvalRead.ok ? approvalRead.value : null,
    config,
    commonDir,
    operationId,
  };
}

function remainingIdentities(state) {
  const order = Array.isArray(state?.order) ? state.order : [];
  const steps = state?.steps && typeof state.steps === 'object' ? state.steps : {};
  const ids = order.length > 0 ? order : Object.keys(steps);
  return ids.filter((id) => !steps[id] || steps[id].status !== 'confirmed');
}

// --- journal helpers -------------------------------------------------------

async function persistState(ctx, patch) {
  const next = { ...ctx.state, ...patch, updatedAt: nowIso() };
  const written = await writeState({ commonDir: ctx.commonDir, operationId: ctx.operationId, state: next });
  if (!written.ok) {
    throw new OperationError(written.code, written.detail);
  }
  ctx.state = next;
  return next;
}

async function recordEvent(ctx, kind, event, payload, now) {
  await appendEvent({ commonDir: ctx.commonDir, operationId: ctx.operationId, kind, event, payload, ts: nowIso(now) });
}

async function ensureSteps(ctx, defs) {
  const existing = ctx.state.steps && typeof ctx.state.steps === 'object' ? ctx.state.steps : {};
  const existingOrder = Array.isArray(ctx.state.order) ? ctx.state.order : [];
  const merged = { ...existing };
  const order = [...existingOrder];
  for (const def of defs) {
    if (!(def.id in merged)) merged[def.id] = { status: 'planned' };
    if (!order.includes(def.id)) order.push(def.id);
  }
  const changed = !ctx.state.steps || JSON.stringify(ctx.state.order) !== JSON.stringify(order);
  if (!changed) return;
  await persistState(ctx, { steps: merged, order });
}

async function markRequested(ctx, step, now) {
  ctx.state.steps[step.id] = { ...ctx.state.steps[step.id], status: 'requested', requestedAt: nowIso(now) };
  await persistState(ctx, { steps: ctx.state.steps });
  await recordEvent(ctx, 'intent', 'step-intent', { stepId: step.id, stage: ctx.state.stage }, now);
}

async function confirmStep(ctx, step, result, now) {
  ctx.state.steps[step.id] = { ...ctx.state.steps[step.id], status: 'confirmed', result, recordedAt: nowIso(now) };
  const remote = { ...(ctx.state.remoteIdentities ?? {}) };
  if (step.id === 'ghcr-publish' && Array.isArray(result?.published)) {
    remote.ghcr = result.published;
  } else if (step.id === 'git-cas') {
    remote.refs = { ...(remote.refs ?? {}), master: result?.master ?? null, tag: result?.tag ?? null };
  } else if (step.id === 'github-release') {
    remote.release = { releaseId: result?.releaseId ?? null, htmlUrl: result?.htmlUrl ?? null };
  } else if (step.id === 'ghcr-delete') {
    remote.ghcrDeletion = { deleted: result?.deleted ?? [], remaining: result?.remaining ?? [] };
  } else if (step.id === 'git-cas-delete') {
    remote.refs = { ...(remote.refs ?? {}), master: result?.master ?? null, tag: null };
  }
  await persistState(ctx, { steps: ctx.state.steps, remoteIdentities: remote });
  await recordEvent(ctx, 'result', 'step-result', { stepId: step.id, result }, now);
}

async function applyOutcome(ctx, status, step, error, now) {
  const steps = ctx.state.steps;
  if (step && steps[step.id]) {
    steps[step.id] = { ...steps[step.id], error: safeError(error) };
  }
  await persistState(ctx, { status, steps });
  await recordEvent(ctx, 'result', 'operation-outcome', { stepId: step?.id ?? null, status }, now);
}

async function maybeFault(faults, hook, stepId) {
  if (typeof faults?.[hook] === 'function') await faults[hook](stepId);
}

// --- mutation guard --------------------------------------------------------

async function beginMutation(ctx, { runIdentity, adapters, now }) {
  const runCheck = validateRunIdentity(runIdentity, ctx.config);
  if (!runCheck.valid) return { ok: false, blockers: runCheck.blockers };

  const previous = ctx.state.runIdentity;
  if (previous && previous.runId !== runIdentity.runId) {
    if (!adapters?.workflow?.getRun) {
      return { ok: false, blockers: [{ code: 'WORKFLOW_STATUS_UNAVAILABLE', field: 'workflow', detail: 'cannot verify the previous run termination without a workflow status adapter' }] };
    }
    let run;
    try {
      run = await adapters.workflow.getRun({ runId: previous.runId });
    } catch (error) {
      return { ok: false, blockers: [{ code: 'WORKFLOW_STATUS_UNAVAILABLE', field: 'workflow', detail: safeError(error).message }] };
    }
    if (run.status === 'in_progress' || run.status === 'queued') {
      return {
        ok: false,
        blockers: [{ code: 'LOST_WORKFLOW_STILL_RUNNING', field: 'runIdentity', detail: `previous run ${previous.runId} is still ${run.status}; do not start a second writer until its termination is proven` }],
      };
    }
    await recordEvent(ctx, 'result', 'run-supersede', { previousRunId: previous.runId, runId: runIdentity.runId }, now);
  }

  const lock = await acquireLock({ commonDir: ctx.commonDir, operationId: ctx.operationId, timeoutMs: 3000 });
  if (!lock.held) {
    return { ok: false, blockers: [{ code: lock.code, field: 'lock', detail: lock.detail ?? 'another local writer holds the operation lock' }] };
  }
  await persistState(ctx, { runIdentity });
  await recordEvent(ctx, 'intent', 'run-start', { runId: runIdentity.runId }, now);
  return { ok: true, release: lock.release };
}

// --- report builders -------------------------------------------------------

function baseReport(ctx, { status, stage, blockers = [], nextAction = null, extra = {} }) {
  const state = ctx.state;
  const inventory = ctx.inventory;
  const approval = ctx.approval;
  return makeReport({
    schemaVersion: OPERATIONS_SCHEMA_VERSION,
    operationId: state.operationId,
    mode: state.mode,
    status,
    stage,
    repositoryId: state.repositoryId ?? ctx.config.repository?.id ?? null,
    version: state.version,
    sourceRef: state.pinnedSource?.sourceRef,
    sourceSha: state.pinnedSource?.sourceSha,
    sourceTree: state.pinnedSource?.sourceTree,
    oldMaster: state.pinnedSource?.oldMaster,
    candidateSha: state.candidate?.candidateSha,
    candidateTree: state.candidate?.candidateTree,
    policyHash: state.policyHash,
    reservationProof: state.reservationProof,
    inventoryHash: state.inventoryHash ?? (inventory ? inventoryHashOf(inventory) : null),
    gateEvidenceHash: approval?.gateEvidenceHash ?? null,
    confirmationHash: approval?.receipt?.confirmationHash ?? null,
    remoteIdentities: state.remoteIdentities ?? null,
    blockers,
    nextAction,
    remainingIdentities: remainingIdentities(state),
    ambiguities: Array.isArray(state.ambiguities) ? state.ambiguities : [],
    ...extra,
  });
}

async function reportBlocked(ctx, blockers, { step, error, now } = {}) {
  await applyOutcome(ctx, 'BLOCKED', step, error ?? { code: blockers[0]?.code, message: blockers[0]?.detail }, now);
  return baseReport(ctx, { status: 'BLOCKED', stage: ctx.state.stage, blockers });
}

async function reportPartial(ctx, step, error, now) {
  await applyOutcome(ctx, 'PARTIAL', step, error, now);
  return baseReport(ctx, {
    status: 'PARTIAL',
    stage: ctx.state.stage,
    blockers: [{ code: error?.code ?? 'MUTATION_INTERRUPTED', field: 'runtime', detail: safeError(error).message }],
    nextAction: 'resume under the unchanged approval with fresh mode-specific gates reconciles exact IDs',
  });
}

async function reportConflict(ctx, blockers, { step, now } = {}) {
  await applyOutcome(ctx, 'CONFLICT', step, { code: blockers[0]?.code, message: blockers[0]?.detail }, now);
  return baseReport(ctx, { status: 'CONFLICT', stage: ctx.state.stage, blockers, nextAction: 'read-only status reports ambiguity; automatic compensation/republish is forbidden' });
}

async function reportTerminal(ctx, terminalStatus, terminalStage, now) {
  await persistState(ctx, { status: terminalStatus, stage: terminalStage });
  await recordEvent(ctx, 'result', 'operation-complete', { status: terminalStatus }, now);
  return baseReport(ctx, { status: terminalStatus, stage: terminalStage });
}

// --- withdrawal target derivation ------------------------------------------

function deriveWithdrawTargets(ctx) {
  const actions = Array.isArray(ctx.approval?.actions) ? ctx.approval.actions : [];
  return actions
    .filter((action) => action && action.kind === 'delete-ghcr-version')
    .map((action) => ({
      packageName: action.packageName ?? null,
      version: action.version,
      digest: action.digest ?? null,
      platforms: Array.isArray(action.platforms) ? action.platforms : [],
    }));
}

function withdrawalReleaseId(ctx) {
  const action = (Array.isArray(ctx.approval?.actions) ? ctx.approval.actions : []).find((item) => item && item.kind === 'delete-github-release');
  return action?.releaseId ?? null;
}

// --- verify steps ----------------------------------------------------------

async function verifyPublish(ctx, adapters, { receipt, evidence, targets, now }) {
  const blockers = [];
  const fail = (code, field, detail) => blockers.push({ code, field, detail });
  const approval = ctx.approval;
  if (!approval) {
    fail('APPROVAL_MISSING', 'approval', 'no approval bundle is persisted for this operation');
    return { ok: false, blockers };
  }
  if (approval.mode !== 'publish') fail('MODE_MISMATCH', 'approval.mode', `operation mode ${approval.mode} is not publish`);
  if (!receipt) return { status: 'AWAITING_CONFIRMATION' };
  const receiptCheck = verifyReceipt(approval, receipt);
  for (const blocker of receiptCheck.blockers) blockers.push(blocker);
  verifyPins(ctx, ctx.config, approval, blockers, fail);
  if (!ctx.gates || !ctx.gates.plan) fail('GATES_MISSING', 'gates', 'gate plan is not persisted');
  else {
    const evaluated = evaluateGates({ config: ctx.config, plan: ctx.gates.plan, evidence, now });
    for (const blocker of evaluated.blockers) blockers.push(blocker);
    if (evaluated.valid && evaluated.gateEvidenceHash !== approval.gateEvidenceHash) {
      fail('APPROVAL_GATE_EVIDENCE_MISMATCH', 'approval.gateEvidenceHash', 'fresh gate evidence hash differs from the approved evidence');
    }
  }
  if (targets?.candidate) {
    const stateCandidate = ctx.state.candidate;
    if (!stateCandidate || targets.candidate.candidateSha !== stateCandidate.candidateSha || targets.candidate.candidateTree !== stateCandidate.candidateTree) {
      fail('CANDIDATE_REGENERATED', 'candidate', 'resume must reuse the identical persisted candidate; a regenerated candidate would mint a new identity');
    }
  }
  if (blockers.length === 0) {
    const refs = await adapters.git.readRemoteRefs();
    const developSha = refSha(refs, 'refs/heads/develop');
    const masterSha = refSha(refs, 'refs/heads/master');
    if (developSha !== null && developSha !== ctx.state.pinnedSource?.sourceSha) {
      fail('SOURCE_DRIFT', 'inventory.refs', `develop head ${developSha} differs from pinned source ${ctx.state.pinnedSource?.sourceSha}`);
    }
    const oldMaster = ctx.state.pinnedSource?.oldMaster;
    // Once the CAS step has been requested or confirmed under this operation, a
    // master/tag that exactly matches our own applied identity is the
    // interrupted step itself (completed remotely, not yet checkpointed) — not
    // drift.
    const casStarted = ['requested', 'confirmed'].includes(ctx.state.steps?.['git-cas']?.status);
    const selfApplied = masterSha === ctx.state.candidate?.candidateSha && refSha(refs, `refs/tags/v${ctx.state.version}`) === ctx.state.candidate?.annotatedTagObject?.objectSha;
    if (oldMaster === ABSENT) {
      if (masterSha !== null && !(casStarted && selfApplied)) {
        fail('MASTER_DRIFT', 'inventory.refs', 'root publish pinned ABSENT old master but a master ref exists');
      }
    } else if (masterSha !== oldMaster && !(casStarted && selfApplied)) {
      fail('MASTER_DRIFT', 'inventory.refs', `pinned previous master ${oldMaster} does not equal remote master ${masterSha ?? 'ABSENT'}`);
    }
  }
  return blockers.length === 0 ? { ok: true, blockers: [] } : { ok: false, blockers };
}

async function verifyWithdraw(ctx, adapters, { receipt, evidence, now }) {
  const blockers = [];
  const fail = (code, field, detail) => blockers.push({ code, field, detail });
  const approval = ctx.approval;
  if (!approval) {
    fail('APPROVAL_MISSING', 'approval', 'no approval bundle is persisted for this operation');
    return { ok: false, blockers };
  }
  if (approval.mode !== 'withdraw') fail('MODE_MISMATCH', 'approval.mode', 'withdrawal requires its own approved deletion intent; a publish approval never authorizes deletion');
  if (!receipt) return { status: 'AWAITING_CONFIRMATION' };
  const receiptCheck = verifyReceipt(approval, receipt);
  for (const blocker of receiptCheck.blockers) blockers.push(blocker);
  verifyPins(ctx, ctx.config, approval, blockers, fail);
  if (!ctx.gates || !ctx.gates.plan) fail('GATES_MISSING', 'gates', 'gate plan is not persisted');
  else {
    const evaluated = evaluateGates({ config: ctx.config, plan: ctx.gates.plan, evidence, now });
    for (const blocker of evaluated.blockers) blockers.push(blocker);
    if (evaluated.valid && evaluated.gateEvidenceHash !== approval.gateEvidenceHash) {
      fail('APPROVAL_GATE_EVIDENCE_MISMATCH', 'approval.gateEvidenceHash', 'fresh withdrawal safety evidence differs from the approved evidence');
    }
  }
  if (blockers.length === 0) {
    const targets = deriveWithdrawTargets(ctx);
    if (targets.length === 0) fail('WITHDRAW_TARGETS_EMPTY', 'approval.actions', 'deletion bundle carries no exact GHCR target versions');
    let eligibility;
    try {
      eligibility = await adapters.ghcr.assessEligibility({ targets });
    } catch (error) {
      fail('GHCR_ELIGIBILITY_UNAVAILABLE', 'ghcr', safeError(error).message);
      eligibility = null;
    }
    if (eligibility) {
      for (const restriction of eligibility.knownRestrictions ?? []) {
        fail('GHCR_DOWNLOAD_RESTRICTION', 'ghcr.versions', `version ${restriction.version} has ${restriction.count} downloads (exceeds the provider deletion threshold); GitHub Support escalation is required before any deletion`);
      }
      for (const ambiguity of eligibility.sharedAmbiguity ?? []) {
        fail('GHCR_AMBIGUOUS_SHARED_MANIFEST', 'ghcr.versions', typeof ambiguity === 'string' ? ambiguity : ambiguity?.detail ?? 'shared manifest ownership ambiguity blocks deletion');
      }
    }
    const refs = await adapters.git.readRemoteRefs();
    const masterSha = refSha(refs, 'refs/heads/master');
    if (masterSha === null) fail('TARGET_MASTER_MISSING', 'inventory.refs', 'withdraw requires the surviving master ref of the target release');
    const casAction = (Array.isArray(approval?.actions) ? approval.actions : []).find((action) => action && action.kind === 'cas-master');
    if (masterSha !== null && (!casAction || casAction.expected !== masterSha)) {
      fail('TARGET_NOT_LAST_RELEASE', 'inventory.refs', `target commit ${casAction?.expected ?? '?'} is not the surviving master ${masterSha}; earlier releases cannot be withdrawn while descendants survive`);
    }
    if (masterSha !== null) {
      let parents = [];
      try {
        parents = await adapters.git.readCommitParents({ sha: masterSha });
      } catch (error) {
        fail('TARGET_PROVENANCE_UNAVAILABLE', 'git', safeError(error).message);
      }
      const oldMaster = ctx.state.pinnedSource?.oldMaster;
      if (oldMaster === ABSENT) {
        if (parents.length !== 0) fail('TARGET_PROVENANCE_MISMATCH', 'git.parents', 'root withdrawal requires a parentless master; a parented target must pin that parent');
      } else if (parents[0] !== oldMaster) {
        fail('TARGET_PROVENANCE_MISMATCH', 'git.parents', `target parent ${parents[0]} does not equal pinned previous master ${oldMaster}`);
      }
    }
  }
  const ambiguities = [];
  if (blockers.length === 0) {
    try {
      const eligibility = await adapters.ghcr.assessEligibility({ targets: deriveWithdrawTargets(ctx) });
      for (const count of eligibility.unknownCounts ?? []) {
        ambiguities.push({ code: 'GHCR_ELIGIBILITY_UNKNOWN', field: 'ghcr.versions', detail: `download count for version ${count.version} is unavailable (Packages REST documents no download_count); disclosed, not invented` });
      }
    } catch {
      // eligibility failures are blockers above; nothing extra to disclose
    }
  }
  return blockers.length === 0 ? { ok: true, blockers: [], ambiguities } : { ok: false, blockers, ambiguities };
}

// --- publish steps ----------------------------------------------------------

function publishSteps(ctx, adapters, { targets, now }) {
  const version = ctx.state.version;
  const tag = `v${version}`;
  const candidateSha = ctx.state.candidate?.candidateSha;
  const tagObjectSha = ctx.state.candidate?.annotatedTagObject?.objectSha;
  const owner = ctx.config.repository.owner;
  const sourceUrl = ctx.config.repository.remote;
  const candidateRef = `refs/heads/ebb-release-candidates/${ctx.state.operationId}`;

  const ghcrTargets = (targets?.ghcr ?? []).map((target) => ({
    packageName: target.packageName,
    platforms: target.platforms ?? [],
  }));

  const readPublishedGhcr = async () => {
    const found = [];
    for (const target of ghcrTargets) {
      const v = await adapters.ghcr.readPublicVersion({ packageName: target.packageName, version });
      if (v) found.push({ packageName: target.packageName, ...v });
    }
    return found;
  };

  return [
    {
      id: 'verify',
      kind: 'check',
      check: async () => verifyPublish(ctx, adapters, { receipt: ctx._receipt, evidence: ctx._evidence, targets, now }),
    },
    {
      id: 'ghcr-publish',
      kind: 'execute',
      reconcile: async () => {
        const found = await readPublishedGhcr();
        if (found.length === ghcrTargets.length) {
          const claimed = ctx.state.steps['ghcr-publish']?.status === 'requested';
          if (claimed) {
            return { done: true, result: { published: found.map((item) => ({ packageName: item.packageName, version, digest: item.digest })) } };
          }
          return { conflict: true, blockers: [{ code: 'UNKNOWN_ARTIFACT_ID', field: 'ghcr', detail: 'GHCR versions already exist for this version but this operation never requested them' }] };
        }
        if (found.length > 0) {
          return { conflict: true, blockers: [{ code: 'UNKNOWN_ARTIFACT_ID', field: 'ghcr', detail: 'a GHCR version exists for this operation but does not match the full approved target set' }] };
        }
        return { done: false };
      },
      execute: async () => {
        const published = [];
        for (const target of ghcrTargets) {
          const result = await adapters.ghcr.publishVersionObjects({
            owner,
            packageName: target.packageName,
            version,
            sourceSha: ctx.state.pinnedSource?.sourceSha,
            sourceUrl,
            platforms: target.platforms,
          });
          if (!result.ok) {
            throw new OperationError(result.code ?? 'GHCR_PUBLISH_FAILED', result.detail ?? 'GHCR publication refused');
          }
          published.push({ packageName: target.packageName, version, digest: result.digests?.[0] ?? null });
        }
        return { published };
      },
      postReconcile: async (result) => {
        for (const item of result.published) {
          const v = await adapters.ghcr.readPublicVersion({ packageName: item.packageName, version });
          if (!v || v.digest !== item.digest) {
            return { conflict: true, blockers: [{ code: 'UNKNOWN_ARTIFACT_ID', field: 'ghcr', detail: `public readback for ${item.packageName}@${version} does not match the published digest` }] };
          }
        }
        return { ok: true };
      },
    },
    {
      id: 'git-cas',
      kind: 'execute',
      reconcile: async () => {
        const refs = await adapters.git.readRemoteRefs();
        const tagSha = refSha(refs, `refs/tags/${tag}`);
        const masterSha = refSha(refs, 'refs/heads/master');
        if (tagSha === tagObjectSha && masterSha === candidateSha) {
          return { done: true, result: { master: masterSha, tag: tagSha } };
        }
        if (tagSha !== null && tagSha !== tagObjectSha) {
          return { conflict: true, blockers: [{ code: 'TAG_COLLISION', field: 'refs/tags', detail: `remote tag ${tag} already points at ${tagSha}, not the approved tag object` }] };
        }
        const oldMaster = ctx.state.pinnedSource?.oldMaster;
        if (oldMaster === ABSENT) {
          if (masterSha !== null) {
            return { conflict: true, blockers: [{ code: 'MASTER_DRIFT', field: 'inventory.refs', detail: 'master exists but this operation is a root publish' }] };
          }
        } else if (masterSha !== oldMaster) {
          return { conflict: true, blockers: [{ code: 'MASTER_DRIFT', field: 'inventory.refs', detail: `master ${masterSha} moved off the pinned parent ${oldMaster}` }] };
        }
        return { done: false };
      },
      execute: async () => {
        const oldMaster = ctx.state.pinnedSource?.oldMaster;
        const actions = [
          { kind: 'create', ref: `refs/tags/${tag}`, value: tagObjectSha },
          { kind: 'update', ref: 'refs/heads/master', expected: oldMaster === ABSENT ? ZERO40 : oldMaster, value: candidateSha },
        ];
        const tx = await adapters.git.executeRefTransaction({ actions });
        if (!tx.ok) {
          throw new OperationError(tx.code ?? 'CAS_REFUSED', tx.detail ?? 'atomic ref transaction refused');
        }
        return { master: candidateSha, tag: tagObjectSha };
      },
      postReconcile: async () => {
        const refs = await adapters.git.readRemoteRefs();
        if (refSha(refs, `refs/tags/${tag}`) !== tagObjectSha || refSha(refs, 'refs/heads/master') !== candidateSha) {
          return { conflict: true, blockers: [{ code: 'CAS_READBACK_MISMATCH', field: 'inventory.refs', detail: 'ref readback does not match the applied CAS transaction' }] };
        }
        return { ok: true };
      },
    },
    {
      id: 'github-release',
      kind: 'execute',
      reconcile: async () => {
        const release = await adapters.github.readReleaseByTag({ tag });
        if (!release) return { done: false };
        const expectedId = ctx.state.remoteIdentities?.release?.releaseId ?? null;
        if (expectedId !== null && release.id === expectedId) return { done: true, result: { releaseId: release.id } };
        if (ctx.state.steps['github-release']?.status === 'requested' && release.tag_name === tag) {
          // the operation itself requested this Release before the crash; its
          // existence with the exact tag is the completed step identity
          return { done: true, result: { releaseId: release.id, htmlUrl: release.html_url ?? null } };
        }
        return { conflict: true, blockers: [{ code: 'UNKNOWN_ARTIFACT_ID', field: 'github.releases', detail: `a Release for ${tag} exists with an unexpected id ${release.id}` }] };
      },
      execute: async () => {
        const release = await adapters.github.createRelease({
          tag,
          target: candidateSha,
          name: `Release v${version}`,
          assets: targets?.assets ?? [],
        });
        return { releaseId: release.releaseId, htmlUrl: release.htmlUrl };
      },
      postReconcile: async (result) => {
        const release = await adapters.github.readReleaseByTag({ tag });
        if (!release || release.id !== result.releaseId) {
          return { conflict: true, blockers: [{ code: 'UNKNOWN_ARTIFACT_ID', field: 'github.releases', detail: 'Release readback does not match the created Release identity' }] };
        }
        const assets = await adapters.github.verifyReleaseAssets({ releaseId: result.releaseId, assets: targets?.assets ?? [] });
        if (!assets.ok) {
          return { conflict: true, blockers: [{ code: 'RELEASE_ASSET_HASH_MISMATCH', field: 'github.assets', detail: 'Release asset hash verification failed' }] };
        }
        return { ok: true };
      },
    },
    {
      id: 'final-readback',
      kind: 'finalize',
      reconcile: async () => {
        const refs = await adapters.git.readRemoteRefs();
        const release = await adapters.github.readReleaseByTag({ tag });
        const found = await readPublishedGhcr();
        const allPostconditions = refSha(refs, 'refs/heads/master') === candidateSha
          && refSha(refs, `refs/tags/${tag}`) === tagObjectSha
          && release !== null
          && found.length === ghcrTargets.length;
        const candidatePresent = refSha(refs, candidateRef) !== null;
        if (allPostconditions && !candidatePresent) return { done: true, result: {} };
        if (!allPostconditions) {
          return { conflict: true, blockers: [{ code: 'FINAL_READBACK', field: 'remoteIdentities', detail: 'final readback does not satisfy all PUBLISH postconditions' }] };
        }
        return { done: false }; // cleanup remaining
      },
      execute: async () => {
        const refs = await adapters.git.readRemoteRefs();
        if (refSha(refs, candidateRef) !== null) {
          const tx = await adapters.git.executeRefTransaction({ actions: [{ kind: 'delete', ref: candidateRef, expected: candidateSha }] });
          if (!tx.ok) throw new OperationError(tx.code ?? 'CAS_REFUSED', tx.detail ?? 'candidate ref cleanup refused');
        }
        const after = await adapters.git.readRemoteRefs();
        if (refSha(after, candidateRef) !== null) {
          throw new OperationError('CANDIDATE_REF_LEFTOVER', 'candidate cleanup did not remove the authorized temporary ref');
        }
        return { cleanup: true };
      },
      postReconcile: async () => ({ ok: true }),
    },
  ];
}

// --- withdraw steps ---------------------------------------------------------

function withdrawSteps(ctx, adapters, { now }) {
  const version = ctx.state.version;
  const tag = `v${version}`;
  const releaseId = withdrawalReleaseId(ctx);
  const owner = ctx.config.repository.owner;
  const targets = deriveWithdrawTargets(ctx);
  const survivors = Array.isArray(ctx.inventory?.versions)
    ? ctx.inventory.versions.filter((item) => item && item.version !== version)
    : [];

  return [
    {
      id: 'verify',
      kind: 'check',
      check: async () => verifyWithdraw(ctx, adapters, { receipt: ctx._receipt, evidence: ctx._evidence, now }),
    },
    {
      id: 'ghcr-delete',
      kind: 'execute',
      reconcile: async () => {
        const present = [];
        for (const target of targets) {
          const v = await adapters.ghcr.readPublicVersion({ packageName: target.packageName, version: target.version });
          if (v) present.push(target);
        }
        if (present.length === 0) return { done: true, result: { deleted: targets.map((target) => target.version), remaining: [] } };
        if (present.length < targets.length) {
          return { conflict: true, blockers: [{ code: 'UNKNOWN_ARTIFACT_ID', field: 'ghcr', detail: 'partial remote presence does not match the approved deletion scope' }] };
        }
        return { done: false };
      },
      execute: async () => {
        const result = await adapters.ghcr.deleteVersionObjects({ targets });
        if (result.status === 'BLOCKED') {
          throw new OperationError(result.refusal?.code ?? 'GHCR_SERVER_REFUSAL', `GHCR deletion refused for ${result.refusal?.version ?? 'target'}`);
        }
        return result;
      },
      postReconcile: async (result) => {
        if (result.status === 'PARTIAL') {
          return { partial: true, result };
        }
        for (const target of targets) {
          const v = await adapters.ghcr.readPublicVersion({ packageName: target.packageName, version: target.version });
          if (v) {
            return { conflict: true, blockers: [{ code: 'TARGET_STILL_PRESENT', field: 'ghcr', detail: `target version ${target.version} still reads back after deletion` }] };
          }
        }
        return { ok: true };
      },
    },
    {
      id: 'github-release-delete',
      kind: 'execute',
      reconcile: async () => {
        const release = await adapters.github.readReleaseByTag({ tag });
        if (!release) return { done: true, result: {} };
        if (release.id !== releaseId) {
          return { conflict: true, blockers: [{ code: 'UNKNOWN_ARTIFACT_ID', field: 'github.releases', detail: `Release for ${tag} has unexpected id ${release.id}` }] };
        }
        return { done: false };
      },
      execute: async () => {
        const result = await adapters.github.deleteRelease({ releaseId, tag });
        if (!result.ok) throw new OperationError('GH_RELEASE_DELETE_REFUSED', 'GitHub refused to delete the Release');
        return {};
      },
      postReconcile: async () => {
        const release = await adapters.github.readReleaseByTag({ tag });
        if (release) {
          return { conflict: true, blockers: [{ code: 'IMMUTABLE_RELEASE_ORDER', field: 'github.releases', detail: 'Release still exists; the tag cannot be removed while the immutable Release exists' }] };
        }
        return { ok: true };
      },
    },
    {
      id: 'git-cas-delete',
      kind: 'execute',
      reconcile: async () => {
        const refs = await adapters.git.readRemoteRefs();
        const tagSha = refSha(refs, `refs/tags/${tag}`);
        const masterSha = refSha(refs, 'refs/heads/master');
        const oldMaster = ctx.state.pinnedSource?.oldMaster;
        const tagGone = tagSha === null;
        const masterExpected = oldMaster === ABSENT ? masterSha === null : masterSha === oldMaster;
        if (tagGone && masterExpected) return { done: true, result: {} };
        const release = await adapters.github.readReleaseByTag({ tag });
        if (release) {
          return { conflict: true, blockers: [{ code: 'IMMUTABLE_RELEASE_ORDER', field: 'github.releases', detail: 'cannot remove the tag while its immutable Release exists' }] };
        }
        if (tagGone && !masterExpected) {
          return { conflict: true, blockers: [{ code: 'MASTER_DRIFT', field: 'inventory.refs', detail: `master ${masterSha ?? 'ABSENT'} does not match the pinned parent ${oldMaster}` }] };
        }
        return { done: false };
      },
      execute: async () => {
        const refs = await adapters.git.readRemoteRefs();
        const masterSha = refSha(refs, 'refs/heads/master');
        const oldMaster = ctx.state.pinnedSource?.oldMaster;
        const actions = [{ kind: 'delete', ref: `refs/tags/${tag}`, expected: ctx.state.candidate?.annotatedTagObject?.objectSha ?? null }];
        if (oldMaster === ABSENT) {
          actions.push({ kind: 'delete', ref: 'refs/heads/master', expected: masterSha });
        } else {
          actions.push({ kind: 'update', ref: 'refs/heads/master', expected: masterSha, value: oldMaster });
        }
        const tx = await adapters.git.executeRefTransaction({ actions });
        if (!tx.ok) throw new OperationError(tx.code ?? 'CAS_REFUSED', tx.detail ?? 'atomic ref deletion refused');
        return { master: oldMaster === ABSENT ? null : oldMaster };
      },
      postReconcile: async () => {
        const refs = await adapters.git.readRemoteRefs();
        const tagSha = refSha(refs, `refs/tags/${tag}`);
        const masterSha = refSha(refs, 'refs/heads/master');
        const oldMaster = ctx.state.pinnedSource?.oldMaster;
        if (tagSha !== null) {
          return { conflict: true, blockers: [{ code: 'TARGET_STILL_PRESENT', field: 'inventory.refs', detail: 'target tag still present after CAS removal' }] };
        }
        if (oldMaster === ABSENT ? masterSha !== null : masterSha !== oldMaster) {
          return { conflict: true, blockers: [{ code: 'MASTER_DRIFT', field: 'inventory.refs', detail: 'master readback does not match the rolled-back parent/ABSENT' }] };
        }
        return { ok: true };
      },
    },
    {
      id: 'final-readback',
      kind: 'finalize',
      reconcile: async () => {
        const refs = await adapters.git.readRemoteRefs();
        const oldMaster = ctx.state.pinnedSource?.oldMaster;
        const masterOk = oldMaster === ABSENT ? refSha(refs, 'refs/heads/master') === null : refSha(refs, 'refs/heads/master') === oldMaster;
        const tagOk = refSha(refs, `refs/tags/${tag}`) === null;
        const release = await adapters.github.readReleaseByTag({ tag });
        const targetsAbsent = [];
        for (const target of targets) {
          const v = await adapters.ghcr.readPublicVersion({ packageName: target.packageName, version: target.version });
          if (v) targetsAbsent.push(target);
        }
        const survivorsIntact = [];
        for (const survivor of survivors) {
          const v = await adapters.ghcr.readPublicVersion({ packageName: survivor.packageName ?? owner, version: survivor.version });
          if (!v || v.digest !== survivor.digest) survivorsIntact.push(survivor);
        }
        if (masterOk && tagOk && release === null && targetsAbsent.length === 0 && survivorsIntact.length === 0) {
          return { done: true, result: {} };
        }
        const blockers = [];
        if (!masterOk) blockers.push({ code: 'FINAL_READBACK', field: 'inventory.refs', detail: 'master did not roll back to parent/ABSENT' });
        if (!tagOk) blockers.push({ code: 'FINAL_READBACK', field: 'inventory.refs', detail: 'target tag still present' });
        if (release) blockers.push({ code: 'FINAL_READBACK', field: 'github.releases', detail: 'target Release still present' });
        for (const target of targetsAbsent) blockers.push({ code: 'TARGET_STILL_PRESENT', field: 'ghcr', detail: `target version ${target.version} still present` });
        for (const survivor of survivorsIntact) blockers.push({ code: 'SURVIVOR_INTEGRITY', field: 'ghcr', detail: `surviving version ${survivor.version} is missing or changed` });
        return { conflict: true, blockers };
      },
      execute: async () => ({}),
      postReconcile: async () => ({ ok: true }),
    },
  ];
}

// --- step runner -----------------------------------------------------------

async function runMutation(ctx, defs, { faults, now, terminalStatus, terminalStage }) {
  await ensureSteps(ctx, defs);

  // define an initial status for the mutation
  const initialStatus = terminalStatus === 'PUBLISHED' ? 'PUBLISHING' : 'ROLLING_BACK';
  const initialStage = terminalStatus === 'PUBLISHED' ? 'publishing' : 'rolling-back';
  if (!['PUBLISHING', 'ROLLING_BACK', 'PARTIAL', 'BLOCKED', 'CONFLICT'].includes(ctx.state.status)) {
    await persistState(ctx, { status: initialStatus, stage: initialStage });
    await recordEvent(ctx, 'intent', 'mutation-start', {}, now);
  }

  for (const def of defs) {
    const step = ctx.state.steps[def.id];
    // checks (verification) always re-run: resume requires fresh mode-specific
    // gates and an unchanged bundle under the original receipt
    if (def.kind !== 'check' && step.status === 'confirmed') continue;

    if (def.kind === 'check') {
      const check = await def.check();
      if (check && check.status === 'AWAITING_CONFIRMATION') {
        return baseReport(ctx, { status: 'AWAITING_CONFIRMATION', stage: ctx.state.stage, blockers: [{ code: 'RECEIPT_MISSING', field: 'receipt', detail: 'approval bundle is persisted but no matching confirmation receipt was supplied' }] });
      }
      if (!check.ok) {
        const ambiguities = check.ambiguities ?? [];
        if (ambiguities.length > 0) {
          const merged = [...(Array.isArray(ctx.state.ambiguities) ? ctx.state.ambiguities : []), ...ambiguities];
          await persistState(ctx, { ambiguities: merged });
        }
        return reportBlocked(ctx, check.blockers, { step, now });
      }
      if (check.ambiguities?.length > 0) {
        const merged = [...(Array.isArray(ctx.state.ambiguities) ? ctx.state.ambiguities : []), ...check.ambiguities];
        await persistState(ctx, { ambiguities: merged });
      }
      await confirmStep(ctx, def, { ok: true }, now);
      continue;
    }

    // reconcile first: existing equal artifact = completed step
    const pre = await def.reconcile();
    if (pre.conflict) return reportConflict(ctx, pre.blockers, { step, now });
    if (pre.done) {
      await confirmStep(ctx, def, pre.result ?? {}, now);
      continue;
    }

    await markRequested(ctx, def, now);
    try {
      await maybeFault(faults, 'beforeRequest', def.id);
    } catch (error) {
      return reportBlocked(ctx, [{ code: 'MUTATION_INTERRUPTED_BEFORE_REQUEST', field: 'runtime', detail: safeError(error).message }], { step: def, error, now });
    }

    let outcome;
    try {
      outcome = await def.execute();
    } catch (error) {
      const code = error instanceof OperationError ? error.code : (error?.code ?? 'ERROR');
      if (REFUSAL_BLOCKED_CODES.has(code)) {
        return reportBlocked(ctx, [{ code, field: 'runtime', detail: safeError(error).message }], { step: def, error, now });
      }
      return reportPartial(ctx, def, error, now);
    }

    try {
      await maybeFault(faults, 'afterRemoteSuccess', def.id);
    } catch (error) {
      return reportPartial(ctx, def, error, now);
    }

    const post = await def.postReconcile(outcome);
    if (post.conflict) return reportConflict(ctx, post.blockers, { step: def, now });
    if (post.partial) {
      const blockers = [{
        code: 'PARTIAL_GHCR_DELETION',
        field: 'ghcr',
        detail: `deleted ${post.result.deleted?.length ?? 0}, remaining ${JSON.stringify(post.result.remaining ?? [])}`,
      }];
      await persistState(ctx, { steps: { ...ctx.state.steps, [def.id]: { ...ctx.state.steps[def.id], status: 'requested', result: post.result } } });
      await recordEvent(ctx, 'result', 'step-result', { stepId: def.id, result: post.result }, now);
      await applyOutcome(ctx, 'PARTIAL', def, { code: 'PARTIAL_GHCR_DELETION', message: blockers[0].detail }, now);
      return baseReport(ctx, { status: 'PARTIAL', stage: ctx.state.stage, blockers, nextAction: 'resume under the unchanged withdrawal approval reconciles remaining exact IDs' });
    }

    try {
      await maybeFault(faults, 'beforeCheckpoint', def.id);
    } catch (error) {
      return reportPartial(ctx, def, error, now);
    }

    await confirmStep(ctx, def, post.result ?? outcome, now);
  }

  return reportTerminal(ctx, terminalStatus, terminalStage, now);
}

// --- public orchestration --------------------------------------------------

async function mutate({ mode, terminalStatus, terminalStage, makeSteps, commonDir, operationId, config, receipt, evidence, runIdentity, adapters, targets, faults, now }) {
  const ctx = await openContext({ commonDir, operationId, config });
  if (!ctx.ok) {
    return makeReport({
      operationId,
      mode,
      status: 'BLOCKED',
      stage: null,
      blockers: ctx.blockers,
      remainingIdentities: [],
      ambiguities: [],
    });
  }
  ctx._receipt = receipt;
  ctx._evidence = evidence;
  ctx._releaseId = null;

  // terminal states cannot be re-entered; a rollback is a separate approved intent
  if (['PUBLISHED', 'ROLLED_BACK'].includes(ctx.state.status)) {
    const blockers = [{ code: 'TERMINAL_STATE', field: 'state.status', detail: `operation is ${ctx.state.status}; no further mutation under this intent is possible` }];
    return baseReport(ctx, { status: 'BLOCKED', stage: ctx.state.stage, blockers });
  }

  const guard = await beginMutation(ctx, { runIdentity, adapters, now });
  if (!guard.ok) {
    return baseReport(ctx, { status: 'BLOCKED', stage: ctx.state.stage, blockers: guard.blockers });
  }
  try {
    const steps = makeSteps(ctx, adapters, { targets, now });
    return await runMutation(ctx, steps, { adapters, faults, now, terminalStatus, terminalStage });
  } finally {
    await guard.release();
  }
}

export async function publish({ commonDir, operationId, config, receipt, evidence, runIdentity, adapters, targets, faults = {}, now }) {
  return mutate({
    mode: 'publish',
    terminalStatus: 'PUBLISHED',
    terminalStage: 'published',
    makeSteps: publishSteps,
    commonDir, operationId, config, receipt, evidence, runIdentity, adapters, targets, faults, now,
  });
}

export async function withdraw({ commonDir, operationId, config, receipt, evidence, runIdentity, adapters, faults = {}, now }) {
  return mutate({
    mode: 'withdraw',
    terminalStatus: 'ROLLED_BACK',
    terminalStage: 'rolled-back',
    makeSteps: withdrawSteps,
    commonDir, operationId, config, receipt, evidence, runIdentity, adapters, targets: null, faults, now,
  });
}

export async function resume({ commonDir, operationId, config, receipt, evidence, runIdentity, adapters, targets, faults = {}, now }) {
  const ctx = await openContext({ commonDir, operationId, config });
  if (!ctx.ok) {
    return makeReport({
      operationId,
      mode: 'resume',
      status: 'BLOCKED',
      stage: null,
      blockers: ctx.blockers,
      remainingIdentities: [],
      ambiguities: [],
    });
  }
  if (['PUBLISHED', 'ROLLED_BACK'].includes(ctx.state.status)) {
    return baseReport(ctx, { status: 'BLOCKED', stage: ctx.state.stage, blockers: [{ code: 'TERMINAL_STATE', field: 'state.status', detail: `operation is ${ctx.state.status}; resume has nothing to continue` }] });
  }
  ctx._receipt = receipt;
  ctx._evidence = evidence;
  ctx._releaseId = null;
  const mode = ctx.state.mode === 'publish' ? 'publish' : 'withdraw';
  const guard = await beginMutation(ctx, { runIdentity, adapters, now });
  if (!guard.ok) {
    return baseReport(ctx, { status: 'BLOCKED', stage: ctx.state.stage, blockers: guard.blockers });
  }
  try {
    const steps = mode === 'publish'
      ? publishSteps(ctx, adapters, { targets, now })
      : withdrawSteps(ctx, adapters, { now });
    return await runMutation(ctx, steps, {
      adapters, faults, now,
      terminalStatus: mode === 'publish' ? 'PUBLISHED' : 'ROLLED_BACK',
      terminalStage: mode === 'publish' ? 'published' : 'rolled-back',
    });
  } finally {
    await guard.release();
  }
}

export async function statusOperation({ commonDir, operationId, config, _adapters, _now }) {
  const ctx = await openContext({ commonDir, operationId, config });
  if (!ctx.ok) {
    return makeReport({
      operationId,
      mode: 'status',
      status: 'BLOCKED',
      stage: null,
      blockers: ctx.blockers,
      remainingIdentities: [],
      ambiguities: [],
    });
  }
  const incomplete = ['PARTIAL', 'CONFLICT', 'BLOCKED'].includes(ctx.state.status);
  const report = baseReport(ctx, {
    status: ctx.state.status,
    stage: ctx.state.stage,
    blockers: incomplete
      ? [{ code: 'INCOMPLETE_MUTATION', field: 'state.status', detail: `operation is ${ctx.state.status}; incomplete mutation is never success` }]
      : [],
  });
  report.mode = 'status';
  return report;
}

export { createHash, canonicalJson, ABSENT };
