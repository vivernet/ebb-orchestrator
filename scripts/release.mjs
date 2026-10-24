// plan-26 Task6: release CLI preparation flow (read-only vs named local
// objects/journal). Modes: prepare|validate|rollback|resume|status.
// - prepare: read-only except named local objects/journal; never touches
//   remote refs (remote refs require a separate authorization; this CLI does
//   not push), never prompts, never auto-approves.
// - validate: evaluates gate evidence against the persisted plan; on success
//   produces the ApprovalBundle (receipt confirmationHash stays null).
// - rollback: by default prepares inventory, never deletes anything.
// - resume: BLOCKED until the mutation backend exists (Task8).
// - status: read-only reconciliation; never repairs.
// Exit contract: 0 only for a verified stage success; 1 for BLOCKED/PARTIAL/
// CONFLICT (incomplete mutation is never 0); 2 for malformed input. All child
// processes are spawned with validated argv and shell:false (git plumbing in
// snapshot.mjs). Exceptions become typed error/code/report.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FULL_SHA_PATTERN,
  SCHEMA_VERSION,
  STABLE_SEMVER_PATTERN,
  policyHashOf,
  validateConfig,
} from './release/policy.mjs';
import {
  appendEvent,
  readApproval,
  readGates,
  readInventory,
  readState,
  safeError,
  resolveCommonDir,
  transitionStage,
  writeApproval,
  writeGates,
  writeInventory,
  writeState,
} from './release/journal.mjs';
import { ABSENT, createCandidate, validatePinnedSource } from './release/snapshot.mjs';
import { createReservationProof, validateLedger, validateReservationProof } from './release/version-reservations.mjs';
import { inventoryHashOf } from './release/github.mjs';
import { buildApprovalBundle, evaluateGates, planGates } from './release/gates.mjs';
import { statusOperation } from './release/operations.mjs';

const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const STABLE_SEMVER_RE = new RegExp(`^${STABLE_SEMVER_PATTERN}$`);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REF_RE = /^refs\/[A-Za-z0-9._/-]+$/;
const MODES = new Set(['prepare', 'validate', 'rollback', 'resume', 'status']);

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
];

function makeReport(fields) {
  const report = {};
  for (const field of REPORT_FIELDS) report[field] = fields[field] ?? null;
  return report;
}

function emit(report, exitCode) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return exitCode;
}

class UsageError extends Error {
  constructor(code, field, detail) {
    super(detail);
    this.name = 'UsageError';
    this.code = code;
    this.field = field;
  }
}

function usageReport(error) {
  const blocked = error.code === 'BLOCKED';
  return makeReport({
    status: blocked ? 'BLOCKED' : 'CONFIG_ERROR',
    mode: null,
    blockers: [{ code: error.code, field: error.field, detail: error.message }],
    nextAction: null,
  });
}

function parseArgs(argv) {
  const args = [...argv];
  const mode = args.shift();
  if (!MODES.has(mode)) {
    throw new UsageError('CLI_USAGE', 'argv', 'usage: node scripts/release.mjs prepare|validate|rollback|resume|status [options]');
  }
  const opts = { mode };
  while (args.length > 0) {
    const arg = args.shift();
    const value = () => {
      if (args.length === 0) throw new UsageError('CLI_MISSING_VALUE', 'argv', `option ${arg} requires a value`);
      return args.shift();
    };
    switch (arg) {
      case '--config':
        opts.config = value();
        break;
      case '--operation':
        opts.operationId = value();
        break;
      case '--inventory-file':
        opts.inventoryFile = value();
        break;
      case '--ledger-file':
        opts.ledgerFile = value();
        break;
      case '--now':
        opts.now = value();
        break;
      case '--version':
        opts.version = value();
        break;
      case '--source-ref':
        opts.sourceRef = value();
        break;
      case '--source-sha':
        opts.sourceSha = value();
        break;
      case '--source-tree':
        opts.sourceTree = value();
        break;
      case '--old-master':
        opts.oldMaster = value();
        break;
      case '--commit-inputs-file':
        opts.commitInputsFile = value();
        break;
      case '--reservation-proof-file':
        opts.reservationProofFile = value();
        break;
      case '--evidence-file':
        opts.evidenceFile = value();
        break;
      case '--help':
        opts.help = true;
        break;
      default:
        throw new UsageError('CLI_UNKNOWN_ARG', 'argv', `unknown argument ${arg}`);
    }
  }
  return opts;
}

function readJson(path, code) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new UsageError(code, 'path', `cannot read JSON ${path}: ${safeError(error).message}`);
  }
}

function requireValue(opts, field, flag, pattern, code) {
  const value = opts[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new UsageError('CLI_MISSING_REQUIRED', 'argv', `${flag} is required`);
  }
  if (pattern && !pattern.test(value)) {
    throw new UsageError(code, field, `"${value}" violates the expected format for ${flag}`);
  }
  return value;
}

function loadConfig(opts) {
  const path = opts.config ?? join(process.cwd(), '.ebb', 'release-policy.json');
  const config = readJson(path, 'CONFIG_READ_FAILED');
  const result = validateConfig(config);
  if (!result.valid) {
    const blockers = result.blockers.map((blocker) => ({ ...blocker, field: `config.${blocker.field}` }));
    throw new UsageError('CONFIG_INVALID', 'config', `policy config is invalid: ${blockers.map((blocker) => `${blocker.code}@${blocker.field}`).join(', ')}`);
  }
  return { config, path };
}

function inventorySha(inventory, ref) {
  const entry = Array.isArray(inventory?.refs) ? inventory.refs.find((item) => item && item.ref === ref) : null;
  return entry && typeof entry.sha === 'string' ? entry.sha : null;
}

function loadInventory(opts, config) {
  const inventory = readJson(opts.inventoryFile, 'INVENTORY_FILE_READ_FAILED');
  const blockers = [];
  if (!inventory || typeof inventory !== 'object') blockers.push({ code: 'INVENTORY_SHAPE', field: 'inventory', detail: 'remote inventory must be a JSON object' });
  if (inventory?.repositoryId !== config.repository?.id) blockers.push({ code: 'REPO_IDENTITY_MISMATCH', field: 'inventory.repositoryId', detail: 'inventory repository identity does not match policy' });
  if (inventory?.ownership?.owner !== config.repository?.owner) blockers.push({ code: 'REPO_IDENTITY_MISMATCH', field: 'inventory.ownership.owner', detail: 'inventory owner does not match policy' });
  if (blockers.length > 0) throw new UsageError('BLOCKED', 'inventory', blockers.map((blocker) => `${blocker.code}@${blocker.field}`).join(', '));
  return inventory;
}

function developShaFromInventory(inventory) {
  return inventorySha(inventory, 'refs/heads/develop');
}

async function loadOrDeriveProof(opts, config, inventory, operationId) {
  if (opts.reservationProofFile) {
    const proof = readJson(opts.reservationProofFile, 'PROOF_FILE_READ_FAILED');
    const result = validateReservationProof(proof, { sourceSha: opts.sourceSha });
    if (!result.valid) {
      throw new UsageError('BLOCKED', 'reservationProof', result.blockers.map((blocker) => `${blocker.code}@${blocker.field}`).join(', '));
    }
    return proof;
  }
  const ledgerPath = opts.ledgerFile ?? join(process.cwd(), 'docs', 'releases', 'version-reservations.json');
  const ledger = readJson(ledgerPath, 'LEDGER_FILE_READ_FAILED');
  const ledgerOk = validateLedger(ledger);
  if (!ledgerOk.valid) {
    throw new UsageError('BLOCKED', 'ledger', ledgerOk.blockers.map((blocker) => `${blocker.code}@${blocker.field}`).join(', '));
  }
  const record = Array.isArray(ledger.reservations) ? ledger.reservations.find((item) => item && item.operationId === operationId) : null;
  if (!record) throw new UsageError('BLOCKED', 'ledger', `no reservation record for operation ${operationId}`);
  const developSha = developShaFromInventory(inventory);
  const made = createReservationProof(record, developSha);
  if (!made.valid) {
    throw new UsageError('BLOCKED', 'reservationProof', made.blockers.map((blocker) => `${blocker.code}@${blocker.field}`).join(', '));
  }
  return made.proof;
}

function remoteIdentitiesOf(inventory) {
  return {
    repositoryId: inventory?.repositoryId ?? null,
    owner: inventory?.ownership?.owner ?? null,
    visibility: inventory?.ownership?.visibility ?? null,
    refs: Array.isArray(inventory?.refs) ? inventory.refs.map((item) => item?.ref).filter(Boolean) : [],
    releases: Array.isArray(inventory?.releases) ? inventory.releases.map((item) => item?.tag_name).filter(Boolean) : [],
    packages: Array.isArray(inventory?.packages) ? inventory.packages.map((item) => item?.name).filter(Boolean) : [],
  };
}

async function cmdPrepare(opts) {
  const { config } = loadConfig(opts);
  const operationId = opts.operationId ?? randomUUID();
  if (opts.operationId && !UUID_RE.test(opts.operationId)) {
    throw new UsageError('OPERATION_ID_INVALID', 'operationId', 'operationId must be a canonical lowercase RFC 4122 UUID');
  }
  const version = requireValue(opts, 'version', '--version', STABLE_SEMVER_RE, 'SEMVER_ENCODING_VIOLATION');
  const sourceRef = opts.sourceRef ?? 'refs/heads/develop';
  if (!REF_RE.test(sourceRef)) {
    throw new UsageError('PINNED_SOURCE_REF', 'sourceRef', '--source-ref must be a refs/ ref');
  }
  const sourceSha = requireValue(opts, 'sourceSha', '--source-sha', FULL_SHA_RE, 'PINNED_SOURCE_SHA');
  const sourceTree = requireValue(opts, 'sourceTree', '--source-tree', FULL_SHA_RE, 'PINNED_SOURCE_TREE');
  const oldMaster = opts.oldMaster ?? ABSENT;
  if (oldMaster !== ABSENT && !FULL_SHA_RE.test(oldMaster)) {
    throw new UsageError('PINNED_SOURCE_OLD_MASTER', 'oldMaster', '--old-master must be ABSENT or a full 40-hex commit SHA');
  }
  const pinnedSource = { sourceRef, sourceSha, sourceTree, oldMaster };
  const pinnedOk = validatePinnedSource(pinnedSource);
  if (!pinnedOk.valid) {
    throw new UsageError('BLOCKED', 'pinnedSource', pinnedOk.blockers.map((blocker) => `${blocker.code}@${blocker.field}`).join(', '));
  }

  const inventory = loadInventory(opts, config);
  const proof = await loadOrDeriveProof(opts, config, inventory, operationId);
  if (proof.version !== version) {
    throw new UsageError('BLOCKED', 'reservationProof.version', `reservation version ${proof.version} does not match requested version ${version}`);
  }

  const commitInputs = readJson(opts.commitInputsFile, 'COMMIT_INPUTS_FILE_READ_FAILED');
  const created = await createCandidate({ gitDir: process.cwd(), config, pinnedSource, reservationProof: proof, commitInputs });
  if (!created.valid) {
    throw new UsageError('BLOCKED', 'candidate', created.blockers.map((blocker) => `${blocker.code}@${blocker.field}`).join(', '));
  }
  const candidate = created.candidate;

  const planned = planGates({ config, mode: 'publish', pinnedSource, candidate, reservationProof: proof, inventory, version });
  if (!planned.valid) {
    return emit(
      makeReport({
        operationId,
        mode: 'prepare',
        status: 'BLOCKED',
        stage: null,
        repositoryId: config.repository.id,
        version,
        sourceRef,
        sourceSha,
        sourceTree,
        oldMaster,
        policyHash: policyHashOf(config),
        reservationProof: proof,
        inventoryHash: inventoryHashOf(inventory),
        blockers: planned.blockers,
        nextAction: planned.nextAction,
      }),
      1,
    );
  }

  const commonDir = await resolveCommonDir({ cwd: process.cwd() });
  const now = opts.now ?? new Date().toISOString();
  const policyHash = policyHashOf(config);
  const state = {
    schemaVersion: SCHEMA_VERSION,
    operationId,
    status: 'PREPARED',
    stage: 'prepared',
    updatedAt: now,
    mode: 'publish',
    version,
    pinnedSource,
    candidate,
    reservationProof: proof,
    policyHash,
    inventoryHash: inventoryHashOf(inventory),
  };
  await writeState({ commonDir, operationId, state });
  await writeInventory({ commonDir, operationId, value: { schemaVersion: SCHEMA_VERSION, operationId, ...inventory } });
  await writeGates({ commonDir, operationId, value: { schemaVersion: SCHEMA_VERSION, operationId, plan: planned.plan, policyHash, inventoryHash: state.inventoryHash } });
  await appendEvent({ commonDir, operationId, kind: 'intent', event: 'prepare', payload: { version, sourceSha, candidateSha: candidate.candidateSha }, ts: now });

  return emit(
    makeReport({
      operationId,
      mode: 'prepare',
      status: 'PREPARED',
      stage: 'prepared',
      repositoryId: config.repository.id,
      version,
      sourceRef,
      sourceSha,
      sourceTree,
      oldMaster,
      candidateSha: candidate.candidateSha,
      candidateTree: candidate.candidateTree,
      policyHash,
      reservationProof: proof,
      inventoryHash: state.inventoryHash,
      gateEvidenceHash: null,
      confirmationHash: null,
      remoteIdentities: remoteIdentitiesOf(inventory),
      blockers: [],
      nextAction: null,
    }),
    0,
  );
}

async function cmdValidate(opts) {
  const operationId = requireValue(opts, 'operationId', '--operation', UUID_RE, 'OPERATION_ID_INVALID');
  const evidencePath = requireValue(opts, 'evidenceFile', '--evidence-file', null, 'CLI_MISSING_REQUIRED');
  const { config } = loadConfig(opts);
  const commonDir = await resolveCommonDir({ cwd: process.cwd() });

  const stateRead = await readState({ commonDir, operationId });
  if (!stateRead.ok) {
    return emit(makeReport({ operationId, mode: 'validate', status: 'BLOCKED', blockers: [{ code: stateRead.code, field: 'state', detail: stateRead.detail }] }), 1);
  }
  const state = stateRead.state;
  if (state.status !== 'PREPARED') {
    return emit(makeReport({ operationId, mode: 'validate', status: state.status === 'PARTIAL' ? 'PARTIAL' : 'BLOCKED', stage: state.stage, blockers: [{ code: 'STATE_STATUS', field: 'state.status', detail: `validate requires PREPARED state, got ${state.status}` }] }), 1);
  }

  const gatesRead = await readGates({ commonDir, operationId });
  if (!gatesRead.ok) {
    return emit(makeReport({ operationId, mode: 'validate', status: 'BLOCKED', blockers: [{ code: gatesRead.code, field: 'gates', detail: gatesRead.detail }] }), 1);
  }
  const plan = gatesRead.value.plan;
  const inventoryRead = await readInventory({ commonDir, operationId });
  const inventory = inventoryRead.ok ? inventoryRead.value : null;

  const evidence = readJson(evidencePath, 'EVIDENCE_FILE_READ_FAILED');
  const now = opts.now;
  const evaluated = evaluateGates({ config, plan, evidence, now });
  if (!evaluated.valid) {
    return emit(
      makeReport({
        operationId,
        mode: 'validate',
        status: 'BLOCKED',
        stage: state.stage,
        repositoryId: config.repository.id,
        version: state.version,
        policyHash: policyHashOf(config),
        reservationProof: state.reservationProof,
        inventoryHash: state.inventoryHash,
        gateEvidenceHash: evaluated.gateEvidenceHash,
        blockers: evaluated.blockers,
        nextAction: null,
      }),
      1,
    );
  }

  const proof = state.reservationProof;
  const bundleResult = buildApprovalBundle({
    config,
    mode: state.mode,
    pinnedSource: state.pinnedSource,
    candidate: state.candidate,
    reservationProof: proof,
    inventory,
    gates: evaluated,
    operationId,
  });
  if (!bundleResult.valid) {
    return emit(makeReport({ operationId, mode: 'validate', status: 'BLOCKED', stage: state.stage, blockers: bundleResult.blockers }), 1);
  }

  await writeApproval({ commonDir, operationId, value: { schemaVersion: SCHEMA_VERSION, operationId, ...bundleResult.bundle } });
  await writeGates({
    commonDir,
    operationId,
    value: {
      schemaVersion: SCHEMA_VERSION,
      operationId,
      plan,
      results: evaluated.gateResults,
      policyHash: evaluated.policyHash,
      gateEvidenceHash: evaluated.gateEvidenceHash,
    },
  });
  const next = transitionStage(state, 'validated');
  await writeState({ commonDir, operationId, state: { ...next.state, status: 'VALIDATED' } });
  await appendEvent({ commonDir, operationId, kind: 'result', event: 'validate', payload: { conclusion: 'success', gateEvidenceHash: evaluated.gateEvidenceHash }, ts: opts.now ?? new Date().toISOString() });

  return emit(
    makeReport({
      operationId,
      mode: 'validate',
      status: 'VALIDATED',
      stage: 'validated',
      repositoryId: config.repository.id,
      version: state.version,
      sourceRef: state.pinnedSource?.sourceRef,
      sourceSha: state.pinnedSource?.sourceSha,
      sourceTree: state.pinnedSource?.sourceTree,
      oldMaster: state.pinnedSource?.oldMaster,
      candidateSha: state.candidate?.candidateSha,
      candidateTree: state.candidate?.candidateTree,
      policyHash: evaluated.policyHash,
      reservationProof: proof,
      inventoryHash: state.inventoryHash,
      gateEvidenceHash: evaluated.gateEvidenceHash,
      confirmationHash: null,
      blockers: [],
      nextAction: null,
    }),
    0,
  );
}

async function cmdRollback(opts) {
  const operationId = requireValue(opts, 'operationId', '--operation', UUID_RE, 'OPERATION_ID_INVALID');
  const { config } = loadConfig(opts);
  const commonDir = await resolveCommonDir({ cwd: process.cwd() });
  const stateRead = await readState({ commonDir, operationId });
  if (!stateRead.ok) {
    return emit(makeReport({ operationId, mode: 'rollback', status: 'BLOCKED', blockers: [{ code: stateRead.code, field: 'state', detail: stateRead.detail }] }), 1);
  }
  const state = stateRead.state;
  if (!['PUBLISHED', 'PARTIAL', 'CONFLICT'].includes(state.status)) {
    return emit(
      makeReport({ operationId, mode: 'rollback', status: 'BLOCKED', stage: state.stage, blockers: [{ code: 'STATE_STATUS', field: 'state.status', detail: `rollback prepares a published operation, got ${state.status}` }] }),
      1,
    );
  }

  const inventory = loadInventory(opts, config);
  const masterSha = inventorySha(inventory, config.repository.releaseBranch);
  if (masterSha === null) {
    return emit(makeReport({ operationId, mode: 'rollback', status: 'BLOCKED', blockers: [{ code: 'TARGET_MASTER_MISSING', field: 'inventory.refs', detail: 'target master ref missing from inventory' }] }), 1);
  }
  const oldMaster = opts.oldMaster ?? ABSENT;
  if (oldMaster !== ABSENT && !FULL_SHA_RE.test(oldMaster)) {
    throw new UsageError('PINNED_SOURCE_OLD_MASTER', 'oldMaster', '--old-master must be ABSENT or a full 40-hex commit SHA');
  }
  const pinnedSource = { sourceRef: config.repository.releaseBranch, sourceSha: masterSha, sourceTree: null, oldMaster };
  const version = state.version;
  const planned = planGates({ config, mode: 'withdraw', pinnedSource, candidate: null, reservationProof: state.reservationProof, inventory, version });
  if (!planned.valid) {
    return emit(makeReport({ operationId, mode: 'rollback', status: 'BLOCKED', stage: state.stage, blockers: planned.blockers, nextAction: planned.nextAction }), 1);
  }

  const now = opts.now ?? new Date().toISOString();
  const policyHash = policyHashOf(config);
  const next = transitionStage(state, 'rollback-prepared');
  const nextState = { ...next.state, status: 'ROLLBACK_PREPARED', mode: 'withdraw', pinnedSource, inventoryHash: inventoryHashOf(inventory), policyHash };
  await writeState({ commonDir, operationId, state: nextState });
  await writeInventory({ commonDir, operationId, value: { schemaVersion: SCHEMA_VERSION, operationId, ...inventory } });
  await writeGates({ commonDir, operationId, value: { schemaVersion: SCHEMA_VERSION, operationId, plan: planned.plan, policyHash, inventoryHash: nextState.inventoryHash } });
  await appendEvent({ commonDir, operationId, kind: 'intent', event: 'rollback-prepare', payload: { version, masterSha }, ts: now });

  return emit(
    makeReport({
      operationId,
      mode: 'rollback',
      status: 'ROLLBACK_PREPARED',
      stage: 'rollback-prepared',
      repositoryId: config.repository.id,
      version,
      sourceRef: config.repository.releaseBranch,
      sourceSha: masterSha,
      oldMaster,
      policyHash,
      reservationProof: state.reservationProof,
      inventoryHash: nextState.inventoryHash,
      remoteIdentities: remoteIdentitiesOf(inventory),
      blockers: [],
      nextAction: null,
    }),
    0,
  );
}

function cmdResume(opts) {
  const operationId = opts.operationId;
  return emit(
    makeReport({
      operationId,
      mode: 'resume',
      status: 'BLOCKED',
      blockers: [
        {
          code: 'RESUME_MUTATION_BACKEND',
          field: 'resume',
          detail: 'the serialized mutation backend (trusted release-operations workflow) does not exist yet; resume is BLOCKED until Task8 binds it',
        },
      ],
      nextAction: 'Task8: create and pin the trusted release-operations workflow before resume is possible',
    }),
    1,
  );
}

async function cmdStatus(opts) {
  const operationId = requireValue(opts, 'operationId', '--operation', UUID_RE, 'OPERATION_ID_INVALID');
  const { config } = loadConfig(opts);
  const commonDir = await resolveCommonDir({ cwd: process.cwd() });
  const report = await statusOperation({ commonDir, operationId, config });
  const incomplete = ['PARTIAL', 'CONFLICT'].includes(report.status);
  const stateUnreadable = report.status === 'BLOCKED' && Array.isArray(report.blockers) && report.blockers.some((blocker) => blocker.field === 'state');
  return emit(report, incomplete || stateUnreadable ? 1 : 0);
}

async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    return emit(usageReport(error), 2);
  }
  if (opts.help) {
    process.stdout.write('usage: node scripts/release.mjs prepare|validate|rollback|resume|status [options]\n');
    return 0;
  }
  try {
    switch (opts.mode) {
      case 'prepare':
        return await cmdPrepare(opts);
      case 'validate':
        return await cmdValidate(opts);
      case 'rollback':
        return await cmdRollback(opts);
      case 'resume':
        return cmdResume(opts);
      case 'status':
        return await cmdStatus(opts);
      default:
        throw new UsageError('CLI_USAGE', 'argv', `unknown mode ${opts.mode}`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      return emit(usageReport(error), error.code === 'BLOCKED' ? 1 : 2);
    }
    const typed = safeError(error);
    return emit(
      makeReport({
        mode: opts.mode,
        status: 'BLOCKED',
        blockers: [{ code: typed.code || 'ERROR', field: 'runtime', detail: typed.message }],
        nextAction: null,
      }),
      1,
    );
  }
}

const thisFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedFile === thisFile) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
