import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createReservationProof,
  recordHashOf,
  validateAppendOnly,
  validateLedger,
  validateNoReuse,
  validateRequestAgainstManifest,
  validateReservationProof,
  validateReservationRecord,
} from './version-reservations.mjs';

const DEV_SHA = 'e'.repeat(40);
const OP_A = '11111111-1111-4111-8111-111111111111';
const OP_B = '22222222-2222-4222-8222-222222222222';

function record(overrides = {}) {
  return { version: '1.0.0', operationId: OP_A, reservedAt: '2026-10-24T10:00:00Z', intent: 'release', ...overrides };
}

function ledger(records = []) {
  return { schemaVersion: 1, reservations: records };
}

function assertBlocked(result, code) {
  assert.equal(result.valid, false, JSON.stringify(result));
  assert.ok(result.blockers.some((blocker) => blocker.code === code), `expected ${code}, got ${JSON.stringify(result.blockers)}`);
}

test('empty ledger is schema-valid', () => {
  const result = validateLedger(ledger());
  assert.equal(result.valid, true, JSON.stringify(result.blockers));
  assert.deepEqual(result.blockers, []);
});

test('ledger schemaVersion must be 1', () => {
  assertBlocked(validateLedger({ schemaVersion: 2, reservations: [] }), 'RESERVATION_SCHEMA_VERSION');
});

test('reservations must be an array', () => {
  assertBlocked(validateLedger({ schemaVersion: 1, reservations: 'x' }), 'RESERVATION_NOT_ARRAY');
});

test('valid reservation record is accepted', () => {
  const result = validateReservationRecord(record());
  assert.equal(result.valid, true, JSON.stringify(result.blockers));
});

test('non-object record is rejected', () => {
  assertBlocked(validateReservationRecord(null), 'RESERVATION_RECORD_SHAPE');
});

test('SemVer policy rejects prerelease/build/variant encodings', () => {
  for (const version of ['1.2.3-beta.1', '1.2.3+build', 'v1.2.3', '01.2.3', '1.2', '1.2.3.4']) {
    assertBlocked(validateReservationRecord(record({ version })), 'RESERVATION_VERSION_SEMVER');
  }
});

test('UUID validation rejects malformed operationId', () => {
  const bad = [
    'not-a-uuid',
    '11111111-1111-4111-8111-11111111111g',
    '11111111-1111-0111-8111-111111111111',
    '11111111-1111-4111-7111-111111111111',
    '11111111-1111-4111-8111-11111111111',
  ];
  for (const operationId of bad) {
    assertBlocked(validateReservationRecord(record({ operationId })), 'RESERVATION_OPERATION_ID_UUID');
  }
});

test('uppercase UUID is rejected as encoding violation', () => {
  assertBlocked(validateReservationRecord(record({ operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'.toUpperCase() })), 'RESERVATION_OPERATION_ID_UUID');
});

test('invalid timestamps are rejected', () => {
  const bad = [
    '2026-13-01T00:00:00Z',
    '2026-10-24 10:00:00Z',
    '2026-10-24T10:00:00+00:00',
    '2026-10-24T10:00:00',
    '2026-02-30T00:00:00Z',
    '2026-10-24T10:00:00.12Z',
    'not-a-date',
  ];
  for (const reservedAt of bad) {
    assertBlocked(validateReservationRecord(record({ reservedAt })), 'RESERVATION_TIMESTAMP_INVALID');
  }
});

test('intent must be release|hotfix', () => {
  for (const intent of ['deploy', '', 5]) {
    assertBlocked(validateReservationRecord(record({ intent })), 'RESERVATION_INTENT_INVALID');
  }
});

test('hotfix forward-port disposition is nullable and gating is deferred', () => {
  assert.equal(validateReservationRecord(record({ intent: 'hotfix' })).valid, true);
  assert.equal(validateReservationRecord(record({ intent: 'hotfix', hotfixForwardPortDisposition: null })).valid, true);
  // Field is recorded (confirmed) but actual gating is consumed by later tasks.
  assert.equal(validateReservationRecord(record({ intent: 'hotfix', hotfixForwardPortDisposition: 'confirmed' })).valid, true);
  assert.equal(validateReservationRecord(record({ intent: 'release', hotfixForwardPortDisposition: null })).valid, true);
  assertBlocked(validateReservationRecord(record({ intent: 'hotfix', hotfixForwardPortDisposition: 'done' })), 'RESERVATION_DISPOSITION_INVALID');
  assertBlocked(validateReservationRecord(record({ intent: 'release', hotfixForwardPortDisposition: 'confirmed' })), 'RESERVATION_DISPOSITION_INVALID');
});

test('repeated version in ledger is rejected (no-reuse)', () => {
  assertBlocked(validateLedger(ledger([record(), record({ operationId: OP_B, version: '1.0.0' })])), 'RESERVATION_VERSION_REUSE');
});

test('repeated operationId in ledger is rejected', () => {
  assertBlocked(validateLedger(ledger([record(), record({ version: '1.0.1', operationId: OP_A })])), 'RESERVATION_OPERATION_ID_REUSE');
});

test('validateNoReuse rejects candidate version after prior reservation', () => {
  const result = validateNoReuse(ledger([record()]), record({ operationId: OP_B }));
  assert.equal(result.valid, false);
  assert.ok(result.blockers.some((blocker) => blocker.code === 'RESERVATION_VERSION_REUSE'));
});

test('append-only accepts pure append', () => {
  const prev = ledger([record()]);
  const next = ledger([record(), record({ operationId: OP_B, version: '1.0.1', intent: 'hotfix' })]);
  const result = validateAppendOnly(prev, next);
  assert.equal(result.valid, true, JSON.stringify(result.blockers));
});

test('append-only rejects edits to old records', () => {
  const prev = ledger([record()]);
  const next = ledger([record({ reservedAt: '2026-10-24T11:00:00Z' }), record({ operationId: OP_B, version: '1.0.1' })]);
  assertBlocked(validateAppendOnly(prev, next), 'APPEND_ONLY_EDIT');
});

test('append-only rejects reorder of old records', () => {
  const prev = ledger([record(), record({ operationId: OP_B, version: '1.0.1' })]);
  const next = ledger([record({ operationId: OP_B, version: '1.0.1' }), record()]);
  assertBlocked(validateAppendOnly(prev, next), 'APPEND_ONLY_REORDER');
});

test('append-only rejects deletion of old records', () => {
  assertBlocked(validateAppendOnly(ledger([record()]), ledger([])), 'APPEND_ONLY_DELETE');
});

test('case/encoding collision is detected', () => {
  const result = validateLedger(ledger([record(), record({ operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'.toUpperCase() })]));
  assert.equal(result.valid, false);
  assert.ok(
    result.blockers.some((blocker) => ['RESERVATION_OPERATION_ID_UUID', 'RESERVATION_COLLISION'].includes(blocker.code)),
    JSON.stringify(result.blockers),
  );
});

test('release removed then reuse is rejected', () => {
  // The release for 1.0.0 was withdrawn; the reservation still consumes the version.
  const result = validateNoReuse(ledger([record()]), record({ operationId: OP_B }));
  assert.ok(result.blockers.some((blocker) => blocker.code === 'RESERVATION_VERSION_REUSE'));
});

test('interrupted/cancelled operation still consumes its version', () => {
  // Ledger records carry no op status: an interrupted/cancelled operation never frees its version.
  const prev = ledger([record()]);
  const result = validateNoReuse(prev, record({ operationId: OP_B }));
  assert.equal(result.valid, false);
  const reuse = result.blockers.find((blocker) => blocker.code === 'RESERVATION_VERSION_REUSE');
  assert.ok(reuse && /cancelled|removed|interrupted/.test(reuse.detail));
});

test('local-only unreviewed reservation is rejected', () => {
  for (const developSha of [null, undefined, 'abc123', 'e'.repeat(39)]) {
    const result = createReservationProof(record(), developSha);
    assert.equal(result.valid, false, String(developSha));
    assert.ok(result.blockers.some((blocker) => blocker.code === 'RESERVATION_LOCAL_ONLY_UNREVIEWED'), String(developSha));
  }
});

test('circular source SHA is rejected', () => {
  const proof = {
    version: '1.0.0',
    operationId: OP_A,
    reservedAt: '2026-10-24T10:00:00Z',
    developSha: DEV_SHA,
    recordHash: recordHashOf(record()),
  };
  const result = validateReservationProof(proof, { record: record({ sourceSha: DEV_SHA }) });
  assertBlocked(result, 'RESERVATION_CIRCULAR_SOURCE_SHA');
});

test('proof is produced with exact seam shape', () => {
  const result = createReservationProof(record(), DEV_SHA);
  assert.equal(result.valid, true, JSON.stringify(result.blockers));
  assert.deepEqual(Object.keys(result.proof).sort(), ['developSha', 'operationId', 'recordHash', 'reservedAt', 'version']);
  assert.match(result.proof.recordHash, /^[0-9a-f]{64}$/);
  assert.equal(result.proof.recordHash, recordHashOf(record()));
  const check = validateReservationProof(result.proof, { record: record() });
  assert.equal(check.valid, true, JSON.stringify(check.blockers));
});

test('proof tampering is detected via recordHash mismatch', () => {
  const result = createReservationProof(record(), DEV_SHA);
  const proof = { ...result.proof, recordHash: '0'.repeat(64) };
  assertBlocked(validateReservationProof(proof, { record: record() }), 'PROOF_RECORD_HASH_MISMATCH');
});

test('manifest version and candidate request match validation', () => {
  const match = validateRequestAgainstManifest({ manifest: { version: '1.0.0' }, request: { version: '1.0.0' } });
  assert.equal(match.valid, true, JSON.stringify(match.blockers));
  assertBlocked(
    validateRequestAgainstManifest({ manifest: { version: '1.0.0' }, request: { version: '1.0.1' } }),
    'VERSION_MANIFEST_MISMATCH',
  );
  assertBlocked(validateRequestAgainstManifest({ manifest: { version: 'v1.0.0' }, request: { version: '1.0.0' } }), 'MANIFEST_VERSION_INVALID');
  const none = validateRequestAgainstManifest({ manifest: {}, request: { version: '1.0.0' } });
  assert.equal(none.valid, true);
  assert.ok(none.notes.some((note) => note.startsWith('NO_CANONICAL_VERSION')));
});

test('recordHash is deterministic canonical sha256', () => {
  assert.equal(recordHashOf(record()), recordHashOf(record()));
  assert.notEqual(recordHashOf(record()), recordHashOf(record({ version: '1.0.1' })));
  assert.match(recordHashOf(record()), /^[0-9a-f]{64}$/);
});
