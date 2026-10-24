// Pure reservation ledger validator/producer (plan-26 Task3). Read-only:
// never mutates the ledger, never touches git, never performs remote calls.

import { createHash } from 'node:crypto';
import { STABLE_SEMVER_PATTERN, canonicalJson } from './policy.mjs';

export const LEDGER_SCHEMA_VERSION = 1;

const STABLE_SEMVER_RE = new RegExp(`^${STABLE_SEMVER_PATTERN}$`);
const UPPERCASE_UUID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[1-8][0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// UTC ISO-8601, optional exactly-3-digit millisecond fraction, Z suffix only.
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const RECORD_HASH_RE = /^[0-9a-f]{64}$/;
const INTENTS = new Set(['release', 'hotfix']);
// Nullable; actual "no normal release until disposition confirmed" gating is
// consumed by later tasks (plan-26 ruling), not enforced here.
const DISPOSITIONS = new Set(['confirmed']);

export function recordHashOf(record) {
  return createHash('sha256').update(canonicalJson(record)).digest('hex');
}

function isValidTimestamp(value) {
  if (typeof value !== 'string' || !TIMESTAMP_RE.test(value)) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const iso = date.toISOString();
  return value.includes('.') ? iso === value : iso === `${value.slice(0, -1)}.000Z`;
}

export function validateReservationRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { valid: false, blockers: [{ code: 'RESERVATION_RECORD_SHAPE', field: 'record', detail: 'reservation record must be a JSON object' }] };
  }
  const blockers = [];
  const fail = (code, field, detail) => blockers.push({ code, field, detail });

  if (typeof record.version !== 'string' || !STABLE_SEMVER_RE.test(record.version)) {
    fail('RESERVATION_VERSION_SEMVER', 'version', `"${record.version}" violates stable MAJOR.MINOR.PATCH-only encoding`);
  }
  if (typeof record.operationId !== 'string') {
    fail('RESERVATION_OPERATION_ID_UUID', 'operationId', 'operationId must be a string');
  } else if (!UUID_RE.test(record.operationId)) {
    const detail = UPPERCASE_UUID_RE.test(record.operationId)
      ? 'operationId must be canonical lowercase RFC 4122 UUID (uppercase is an encoding violation)'
      : `"${record.operationId}" is not a valid RFC 4122 UUID`;
    fail('RESERVATION_OPERATION_ID_UUID', 'operationId', detail);
  }
  if (!isValidTimestamp(record.reservedAt)) {
    fail('RESERVATION_TIMESTAMP_INVALID', 'reservedAt', `"${record.reservedAt}" is not a valid UTC ISO-8601 timestamp`);
  }
  if (!INTENTS.has(record.intent)) {
    fail('RESERVATION_INTENT_INVALID', 'intent', `expected release|hotfix, got ${JSON.stringify(record.intent)}`);
  }
  const disposition = record.hotfixForwardPortDisposition;
  if (disposition !== undefined && disposition !== null && !DISPOSITIONS.has(disposition)) {
    fail('RESERVATION_DISPOSITION_INVALID', 'hotfixForwardPortDisposition', 'must be null (pending) or "confirmed"');
  }
  if (record.intent === 'release' && disposition === 'confirmed') {
    fail('RESERVATION_DISPOSITION_INVALID', 'hotfixForwardPortDisposition', 'forward-port disposition applies only to hotfix reservations');
  }

  return { valid: blockers.length === 0, blockers };
}

export function validateLedger(ledger) {
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) {
    return { valid: false, blockers: [{ code: 'RESERVATION_LEDGER_SHAPE', field: 'ledger', detail: 'reservation ledger must be a JSON object' }] };
  }
  const blockers = [];
  const fail = (code, field, detail) => blockers.push({ code, field, detail });

  if (ledger.schemaVersion !== LEDGER_SCHEMA_VERSION) {
    fail('RESERVATION_SCHEMA_VERSION', 'schemaVersion', `expected ${LEDGER_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(ledger.reservations)) {
    fail('RESERVATION_NOT_ARRAY', 'reservations', 'array required');
    return { valid: false, blockers };
  }

  const seenVersions = new Map();
  const seenOperations = new Map();
  const seenKeys = new Map();
  for (const [index, item] of ledger.reservations.entries()) {
    const rec = validateReservationRecord(item);
    for (const blocker of rec.blockers) {
      blockers.push({ ...blocker, field: `reservations[${index}].${blocker.field}` });
    }
    if (!rec.valid) continue;

    const versionKey = item.version.toLowerCase();
    const opKey = item.operationId.toLowerCase();
    const key = `${versionKey}::${opKey}`;

    if (seenVersions.has(versionKey)) {
      fail(
        'RESERVATION_VERSION_REUSE',
        `reservations[${index}].version`,
        `version ${item.version} is already reserved by operation ${seenVersions.get(versionKey)}; a removed/cancelled/interrupted release still consumes its version forever`,
      );
    } else {
      seenVersions.set(versionKey, item.operationId);
    }
    if (seenOperations.has(opKey)) {
      fail('RESERVATION_OPERATION_ID_REUSE', `reservations[${index}].operationId`, `operationId ${item.operationId} is already used by record index ${seenOperations.get(opKey)}`);
    } else {
      seenOperations.set(opKey, index);
    }
    if (seenKeys.has(key)) {
      fail('RESERVATION_COLLISION', `reservations[${index}]`, 'case/encoding collision: entry duplicates another reservation under normalization');
    } else {
      seenKeys.set(key, index);
    }
  }

  return { valid: blockers.length === 0, blockers };
}

export function validateNoReuse(existingLedger, candidate) {
  const blockers = [];
  const candidateVersion = candidate && typeof candidate.version === 'string' ? candidate.version.toLowerCase() : null;
  if (candidateVersion !== null && existingLedger && Array.isArray(existingLedger.reservations)) {
    for (const record of existingLedger.reservations) {
      if (typeof record.version === 'string' && record.version.toLowerCase() === candidateVersion) {
        blockers.push({
          code: 'RESERVATION_VERSION_REUSE',
          field: 'version',
          detail: `version ${candidate.version} was already reserved by ${record.operationId}; a removed/cancelled/interrupted release still consumes its version forever`,
        });
        break;
      }
    }
  }
  return { valid: blockers.length === 0, blockers };
}

function recordsOf(ledger) {
  return ledger && Array.isArray(ledger.reservations) ? ledger.reservations : null;
}

export function validateAppendOnly(previousLedger, nextLedger) {
  const prev = recordsOf(previousLedger);
  const next = recordsOf(nextLedger);
  if (prev === null || next === null) {
    return { valid: false, blockers: [{ code: 'APPEND_ONLY_LEDGER_SHAPE', field: 'ledger', detail: 'both ledgers must expose reservations arrays' }] };
  }
  if (next.length < prev.length) {
    return {
      valid: false,
      blockers: [{ code: 'APPEND_ONLY_DELETE', field: 'reservations', detail: `history shrank from ${prev.length} to ${next.length} records; old records may never be deleted` }],
    };
  }
  for (let i = 0; i < prev.length; i += 1) {
    if (canonicalJson(next[i]) !== canonicalJson(prev[i])) {
      const prefix = next.slice(0, prev.length);
      const canon = (entries) => canonicalJson([...entries].sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))));
      const sameSet = canon(prefix) === canon(prev);
      return {
        valid: false,
        blockers: [
          {
            code: sameSet ? 'APPEND_ONLY_REORDER' : 'APPEND_ONLY_EDIT',
            field: `reservations[${i}]`,
            detail: `record ${i} differs from history; the ledger is append-only (no edits/reorder/delete of old records)`,
          },
        ],
      };
    }
  }
  return { valid: true, blockers: [] };
}

export function createReservationProof(record, developSha) {
  const rec = validateReservationRecord(record);
  const blockers = rec.blockers.map((blocker) => ({ ...blocker, field: `record.${blocker.field}` }));
  if (typeof developSha !== 'string' || !FULL_SHA_RE.test(developSha)) {
    blockers.push({
      code: 'RESERVATION_LOCAL_ONLY_UNREVIEWED',
      field: 'developSha',
      detail: 'a reservation proof requires the full SHA of the reviewed develop commit carrying the ledger; local-only/unreviewed reservations are rejected',
    });
  }
  if (blockers.length > 0) return { valid: false, blockers };
  return {
    valid: true,
    proof: {
      version: record.version,
      operationId: record.operationId,
      reservedAt: record.reservedAt,
      developSha,
      recordHash: recordHashOf(record),
    },
  };
}

export function validateReservationProof(proof, opts = {}) {
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) {
    return { valid: false, blockers: [{ code: 'PROOF_SHAPE', field: 'proof', detail: 'reservation proof must be a JSON object' }] };
  }
  const blockers = [];
  const fail = (code, field, detail) => blockers.push({ code, field, detail });

  if (typeof proof.version !== 'string' || !STABLE_SEMVER_RE.test(proof.version)) {
    fail('RESERVATION_VERSION_SEMVER', 'version', `"${proof.version}" violates stable MAJOR.MINOR.PATCH-only encoding`);
  }
  if (typeof proof.operationId !== 'string' || !UUID_RE.test(proof.operationId)) {
    fail('RESERVATION_OPERATION_ID_UUID', 'operationId', `"${proof.operationId}" is not a canonical lowercase UUID`);
  }
  if (!isValidTimestamp(proof.reservedAt)) {
    fail('RESERVATION_TIMESTAMP_INVALID', 'reservedAt', `"${proof.reservedAt}" is not a valid UTC ISO-8601 timestamp`);
  }
  if (typeof proof.developSha !== 'string' || !FULL_SHA_RE.test(proof.developSha)) {
    fail('RESERVATION_LOCAL_ONLY_UNREVIEWED', 'developSha', 'proof requires the full SHA of a remote reviewed develop commit; local-only unreviewed reservations are rejected');
  }
  if (typeof proof.recordHash !== 'string' || !RECORD_HASH_RE.test(proof.recordHash)) {
    fail('PROOF_RECORD_HASH', 'recordHash', 'recordHash must be a 64-hex sha256 digest of the canonical record');
  }

  const sourceSha = opts.sourceSha ?? opts.record?.sourceSha;
  if (sourceSha === proof.developSha) {
    fail('RESERVATION_CIRCULAR_SOURCE_SHA', 'sourceSha', 'source pin cannot reference the reservation commit itself; reservation precedes source pin');
  }

  if (opts.record) {
    const expected = recordHashOf(opts.record);
    if (proof.recordHash !== expected) {
      fail('PROOF_RECORD_HASH_MISMATCH', 'recordHash', `expected ${expected} for the referenced record`);
    }
  }

  return { valid: blockers.length === 0, blockers };
}

export function validateRequestAgainstManifest({ manifest, request } = {}) {
  const blockers = [];
  const notes = [];
  const version = request && typeof request.version === 'string' ? request.version : null;
  const manifestVersion = manifest && typeof manifest.version === 'string' ? manifest.version : null;
  if (manifestVersion !== null) {
    if (!STABLE_SEMVER_RE.test(manifestVersion)) {
      blockers.push({ code: 'MANIFEST_VERSION_INVALID', field: 'manifest.version', detail: `"${manifestVersion}" is not a stable SemVer canonical version` });
    } else if (version !== null && version !== manifestVersion) {
      blockers.push({
        code: 'VERSION_MANIFEST_MISMATCH',
        field: 'request.version',
        detail: `candidate request version ${version} does not match canonical manifest version ${manifestVersion}`,
      });
    }
  } else {
    notes.push('NO_CANONICAL_VERSION: manifest has no version; match check deferred until canonical source provides one');
  }
  return { valid: blockers.length === 0, blockers, notes };
}
