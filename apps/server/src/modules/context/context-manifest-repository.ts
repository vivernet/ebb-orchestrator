import { randomUUID } from 'node:crypto';
import type { Database, DatabaseTx } from '../../platform/database/database.js';
import {
  canonicalizeContextValueV1,
  digestRunPromptBytesV1,
  parsePersistedContextJsonV1,
} from './context-provenance.js';
import type {
  ContextItemProvenance,
  ContextManifestReadResult,
  ContextManifestRoleV1,
  ContextManifestV2,
  ContextSubjectV1,
  PreparedRunContext,
} from './context-types.js';

interface ContextManifestRow {
  id: unknown;
  run_id: unknown;
  subject_type: unknown;
  task_id: unknown;
  epic_id: unknown;
  request_id: unknown;
  role: unknown;
  contract_request_digest: unknown;
  items_json: unknown;
  prompt_hash: unknown;
  context_hash: unknown;
  context_builder_version: unknown;
  initial_token_size: unknown;
  created_at: unknown;
}

const MANIFEST_ROLES: readonly ContextManifestRoleV1[] = [
  'coordinator', 'product_manager', 'architect', 'developer', 'reviewer', 'qa', 'integration',
];

/**
 * Атомарно добавляет безопасную provenance-запись для уже подготовленного Run.
 * Вызов рассчитан на внешнюю транзакцию, в которой создаётся Run; сам prompt сюда
 * передаётся только для сверки точных UTF-8 bytes и в базу не записывается.
 *
 * @param tx Активная SQLite transaction вызывающего сервиса.
 * @param prepared Валидированный контекст, построенный для конкретного subject и роли.
 * @param runId Orchestrator ID создаваемого Run.
 * @throws {TypeError} Если prompt hash, subject, role или provenance не соответствуют контракту.
 * @throws {Error} Если SQLite отклоняет FK, subject-binding или повторный manifest для Run.
 */
export function insertContextManifestTx(tx: DatabaseTx, prepared: PreparedRunContext, runId: string): void {
  assertNonEmpty(runId, 'runId');
  const normalized = validatePreparedContext(prepared);
  const id = randomUUID();
  const createdAt = new Date().toISOString();

  tx.run(
    `INSERT INTO context_manifests(
      id, run_id, subject_type, task_id, epic_id, request_id, role,
      contract_request_digest, items_json, prompt_hash, context_hash,
      context_builder_version, initial_token_size, created_at
    ) VALUES (
      $id, $runId, $subjectType, $taskId, $epicId, $requestId, $role,
      $contractRequestDigest, $itemsJson, $promptHash, $contextHash,
      $contextBuilderVersion, $initialTokenSize, $createdAt
    )`,
    {
      id,
      runId,
      subjectType: normalized.subject.type,
      taskId: normalized.subject.type === 'TASK' ? normalized.subject.id : null,
      epicId: normalized.subject.type === 'EPIC' ? normalized.subject.id : null,
      requestId: normalized.subject.type === 'REQUEST' ? normalized.subject.id : null,
      role: normalized.role,
      contractRequestDigest: normalized.contractRequestDigest,
      itemsJson: canonicalizeContextValueV1(normalized.items),
      promptHash: normalized.promptHash,
      contextHash: normalized.contextHash,
      contextBuilderVersion: normalized.contextBuilderVersion,
      initialTokenSize: normalized.initialTokenSize,
      createdAt,
    },
  );
}

/**
 * Читает только новую subject-bound v2 provenance и явно помечает неполную историю.
 * Две или более v1-записи на один Run не выбираются произвольно, а отсутствие строки
 * не представляется достоверно пустым контекстом.
 *
 * @param db Мигрированная база Orchestrator.
 * @param runId Orchestrator ID Run.
 * @returns Безопасный manifest либо стабильное unavailable-состояние без сырых деталей ошибки.
 */
export function getContextManifest(db: Database, runId: string): ContextManifestReadResult {
  const row = db.get<ContextManifestRow>(
    `SELECT id, run_id, subject_type, task_id, epic_id, request_id, role,
            contract_request_digest, items_json, prompt_hash, context_hash,
            context_builder_version, initial_token_size, created_at
       FROM context_manifests
      WHERE run_id = $runId`,
    { runId },
  );
  if (!row) return { availability: 'unavailable', reason: 'LEGACY_PROVENANCE_UNAVAILABLE' };

  try {
    return { availability: 'available', manifest: decodeManifestRow(row) };
  } catch {
    return { availability: 'unavailable', reason: 'INVALID_PERSISTED_PROVENANCE' };
  }
}

function validatePreparedContext(prepared: PreparedRunContext): {
  subject: ContextSubjectV1;
  role: ContextManifestRoleV1;
  contractRequestDigest: string | null;
  items: ContextItemProvenance[];
  promptHash: string;
  contextHash: string;
  contextBuilderVersion: string;
  initialTokenSize: number | null;
} {
  if (typeof prepared !== 'object' || prepared === null) throw new TypeError('Prepared context is required.');
  const subject = normalizeSubject(prepared.subject);
  if (!MANIFEST_ROLES.includes(prepared.role)) throw new TypeError('Manifest role is unsupported.');
  if (typeof prepared.finalPrompt !== 'string') throw new TypeError('Prepared final prompt must be text.');
  const computedPromptHash = digestRunPromptBytesV1(new TextEncoder().encode(prepared.finalPrompt));
  assertDigest(prepared.promptHash, 'promptHash');
  if (prepared.promptHash !== computedPromptHash) throw new TypeError('Prepared prompt hash does not match exact prompt bytes.');
  assertNullableDigest(prepared.contractDigest, 'contractDigest');
  assertDigest(prepared.contextHash, 'contextHash');
  assertNonEmpty(prepared.contextBuilderVersion, 'contextBuilderVersion');
  if (prepared.initialTokenSize !== null &&
      (!Number.isSafeInteger(prepared.initialTokenSize) || prepared.initialTokenSize < 0)) {
    throw new TypeError('Initial token count must be an exact non-negative integer or null.');
  }
  if (typeof prepared.workspaceFingerprint !== 'string' || prepared.workspaceFingerprint.trim() === '') {
    throw new TypeError('Workspace fingerprint must be present.');
  }

  if (!Array.isArray(prepared.items)) throw new TypeError('Context provenance items must be an array.');
  const seen = new Set<string>();
  const items = prepared.items.map((item, index) => {
    if (!isPlainRecord(item)) throw new TypeError(`Context item ${index} must be a plain object.`);
    const keys = Object.keys(item).sort();
    if (keys.length !== 3 || keys[0] !== 'digest' || keys[1] !== 'id' || keys[2] !== 'version') {
      throw new TypeError(`Context item ${index} must contain only id, version, and digest.`);
    }
    assertNonEmpty(item.id, `items[${index}].id`);
    if (seen.has(item.id)) throw new TypeError('Context provenance item IDs must be unique.');
    seen.add(item.id);
    const version = item.version;
    if (version !== null && (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1)) {
      throw new TypeError(`Context item ${index} version must be a positive integer or null.`);
    }
    assertNullableDigest(item.digest, `items[${index}].digest`);
    return { id: item.id, version, digest: item.digest };
  });

  return {
    subject,
    role: prepared.role,
    contractRequestDigest: prepared.contractDigest,
    items,
    promptHash: prepared.promptHash,
    contextHash: prepared.contextHash,
    contextBuilderVersion: prepared.contextBuilderVersion,
    initialTokenSize: prepared.initialTokenSize,
  };
}

function decodeManifestRow(row: ContextManifestRow): ContextManifestV2 {
  assertNonEmpty(row.id, 'id');
  assertNonEmpty(row.run_id, 'run_id');
  const subjectType = row.subject_type;
  if (subjectType !== 'TASK' && subjectType !== 'EPIC' && subjectType !== 'REQUEST') {
    throw new TypeError('Persisted subject type is unsupported.');
  }
  const subjectId = subjectType === 'TASK' ? row.task_id : subjectType === 'EPIC' ? row.epic_id : row.request_id;
  const subject: ContextSubjectV1 = normalizeSubject({ type: subjectType, id: subjectId });
  const nonNullSubjects = [row.task_id, row.epic_id, row.request_id].filter((value) => value !== null);
  if (nonNullSubjects.length !== 1) throw new TypeError('Persisted manifest must contain exactly one subject.');
  if (typeof row.role !== 'string' || !MANIFEST_ROLES.includes(row.role as ContextManifestRoleV1)) {
    throw new TypeError('Persisted role is unsupported.');
  }
  assertNullableDigest(row.contract_request_digest, 'contract_request_digest');
  assertDigest(row.prompt_hash, 'prompt_hash');
  assertDigest(row.context_hash, 'context_hash');
  assertNonEmpty(row.context_builder_version, 'context_builder_version');
  if (row.initial_token_size !== null &&
      (!Number.isSafeInteger(row.initial_token_size) || Number(row.initial_token_size) < 0)) {
    throw new TypeError('Persisted token count is invalid.');
  }
  assertNonEmpty(row.created_at, 'created_at');
  if (typeof row.items_json !== 'string') throw new TypeError('Persisted context items are not text.');
  const parsed = parsePersistedContextJsonV1(row.items_json);
  if (!Array.isArray(parsed)) throw new TypeError('Persisted context items must be an array.');
  const items = normalizeItems(parsed);

  return {
    id: row.id,
    runId: row.run_id,
    subject,
    role: row.role as ContextManifestRoleV1,
    contractRequestDigest: row.contract_request_digest,
    items,
    promptHash: row.prompt_hash,
    contextHash: row.context_hash,
    contextBuilderVersion: row.context_builder_version,
    initialTokenSize: row.initial_token_size as number | null,
    createdAt: row.created_at,
  };
}

function normalizeItems(value: readonly unknown[]): ContextItemProvenance[] {
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (!isPlainRecord(entry)) throw new TypeError(`Persisted context item ${index} is invalid.`);
    const keys = Object.keys(entry).sort();
    if (keys.length !== 3 || keys[0] !== 'digest' || keys[1] !== 'id' || keys[2] !== 'version') {
      throw new TypeError(`Persisted context item ${index} has unexpected fields.`);
    }
    assertNonEmpty(entry.id, `items[${index}].id`);
    if (seen.has(entry.id)) throw new TypeError('Persisted context item IDs are duplicated.');
    seen.add(entry.id);
    const version = entry.version;
    if (version !== null && (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1)) {
      throw new TypeError(`Persisted context item ${index} version is invalid.`);
    }
    assertNullableDigest(entry.digest, `items[${index}].digest`);
    return { id: entry.id, version, digest: entry.digest };
  });
}

function normalizeSubject(value: unknown): ContextSubjectV1 {
  if (!isPlainRecord(value)) throw new TypeError('Manifest subject must be an object.');
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'id' || keys[1] !== 'type') throw new TypeError('Manifest subject fields are invalid.');
  if (value.type !== 'TASK' && value.type !== 'EPIC' && value.type !== 'REQUEST') {
    throw new TypeError('Manifest subject type is unsupported.');
  }
  assertNonEmpty(value.id, 'subject.id');
  return { type: value.type, id: value.id };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function assertNonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} must be a non-empty string.`);
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest.`);
  }
}

function assertNullableDigest(value: unknown, label: string): asserts value is string | null {
  if (value !== null) assertDigest(value, label);
}
