import { createHash } from 'node:crypto';
import type {
  ContextFingerprintInputV1,
  ContextBudgetPolicyV1,
  ContextItemProvenance,
  DecisionProvenancePayloadV1,
  DefectProvenancePayloadV1,
  FindingProvenancePayloadV1,
  GuidelineProvenancePayloadV1,
  RequestProvenancePayloadV1,
  PersistedWorkTaskContractV1,
} from './context-types.js';

/**
 * Фиксированные домены SHA-256 для сравнения provenance в версии 1.
 * Терминальный NUL отделяет тип данных от содержимого и предотвращает
 * междоменное совпадение одного и того же набора байтов.
 */
export const CONTEXT_DIGEST_DOMAINS_V1 = Object.freeze({
  contract: 'ebb-contract-v1\0',
  request: 'ebb-request-v1\0',
  guideline: 'ebb-guideline-v1\0',
  decision: 'ebb-decision-v1\0',
  finding: 'ebb-finding-v1\0',
  defect: 'ebb-defect-v1\0',
  runPrompt: 'ebb-run-prompt-v1\0',
  runContext: 'ebb-run-context-v1\0',
  contextBudgetPolicy: 'ebb-context-budget-policy-v1\0',
} as const);

/**
 * Строго преобразует JSON-совместимое значение в каноническую строку RFC 8785.
 * Объекты должны быть обычными plain objects; свойства сортируются по UTF-16,
 * строки не нормализуются, а числа сериализуются правилами ECMAScript.
 * Значения вне JSON-модели и lone surrogates отклоняются, чтобы сравнение
 * persisted provenance не зависело от потерь при обычной сериализации.
 *
 * @param value Проверенное приложением значение, которое требуется канонизировать.
 * @returns RFC 8785 JSON-строка без незначащих пробелов.
 * @throws {TypeError} Если значение нельзя однозначно представить как JSON.
 */
export function canonicalizeContextValueV1(value: unknown): string {
  const ancestors = new Set<object>();

  const serialize = (current: unknown): string => {
    if (current === null) return 'null';
    if (typeof current === 'boolean') return current ? 'true' : 'false';
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) {
        throw new TypeError('Context JSON numbers must be finite.');
      }
      return JSON.stringify(current);
    }
    if (typeof current === 'string') {
      assertUnicodeScalarString(current);
      return JSON.stringify(current);
    }
    if (typeof current !== 'object') {
      throw new TypeError(`Unsupported context JSON value: ${typeof current}.`);
    }

    if (ancestors.has(current)) {
      throw new TypeError('Context JSON value must not contain a cycle.');
    }
    ancestors.add(current);
    try {
      if (Array.isArray(current)) return serializeArray(current, serialize);
      return serializeObject(current, serialize);
    } finally {
      ancestors.delete(current);
    }
  };

  return serialize(value);
}

/**
 * Разбирает persisted JSON, не теряя сведения о повторных ключах.
 * Обычный `JSON.parse` молча оставляет последнее значение повторного ключа,
 * поэтому его нельзя использовать для валидации входных данных provenance.
 * После синтаксического разбора результат дополнительно проверяется тем же
 * строгим JSON-контрактом, который использует канонизатор.
 *
 * @param source Сохранённый JSON-текст.
 * @returns Проверенное значение JSON.
 * @throws {TypeError} Если JSON повреждён, содержит повторный ключ или значение вне RFC 8785.
 */
export function parsePersistedContextJsonV1(source: string): unknown {
  if (typeof source !== 'string') {
    throw new TypeError('Persisted context JSON must be a string.');
  }

  let offset = 0;
  const fail = (message: string): never => {
    throw new TypeError(`${message} At offset ${offset}.`);
  };
  const skipWhitespace = (): void => {
    while (source[offset] === ' ' || source[offset] === '\t' || source[offset] === '\n' || source[offset] === '\r') {
      offset += 1;
    }
  };
  const parseString = (): string => {
    if (source[offset] !== '"') return fail('Expected a JSON string.');
    const start = offset;
    offset += 1;
    while (offset < source.length) {
      const character = source[offset];
      if (character === '"') {
        offset += 1;
        try {
          return JSON.parse(source.slice(start, offset)) as string;
        } catch {
          return fail('Malformed JSON string.');
        }
      }
      if (character === '\\') {
        offset += 2;
      } else {
        offset += 1;
      }
    }
    return fail('Unterminated JSON string.');
  };

  const parseValue = (): unknown => {
    skipWhitespace();
    const character = source[offset];
    if (character === '"') return parseString();
    if (character === '{') {
      offset += 1;
      skipWhitespace();
      const record: Record<string, unknown> = {};
      const keys = new Set<string>();
      if (source[offset] === '}') {
        offset += 1;
        return record;
      }
      while (offset < source.length) {
        skipWhitespace();
        const key = parseString();
        if (keys.has(key)) return fail(`Duplicate JSON object key ${JSON.stringify(key)}.`);
        keys.add(key);
        skipWhitespace();
        if (source[offset] !== ':') return fail('Expected a colon after a JSON object key.');
        offset += 1;
        const value = parseValue();
        Object.defineProperty(record, key, {
          configurable: true,
          enumerable: true,
          value,
          writable: true,
        });
        skipWhitespace();
        if (source[offset] === '}') {
          offset += 1;
          return record;
        }
        if (source[offset] !== ',') return fail('Expected a comma or object terminator.');
        offset += 1;
      }
      return fail('Unterminated JSON object.');
    }
    if (character === '[') {
      offset += 1;
      skipWhitespace();
      const items: unknown[] = [];
      if (source[offset] === ']') {
        offset += 1;
        return items;
      }
      while (offset < source.length) {
        items.push(parseValue());
        skipWhitespace();
        if (source[offset] === ']') {
          offset += 1;
          return items;
        }
        if (source[offset] !== ',') return fail('Expected a comma or array terminator.');
        offset += 1;
      }
      return fail('Unterminated JSON array.');
    }
    if (source.startsWith('true', offset)) {
      offset += 4;
      return true;
    }
    if (source.startsWith('false', offset)) {
      offset += 5;
      return false;
    }
    if (source.startsWith('null', offset)) {
      offset += 4;
      return null;
    }

    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(offset));
    if (number) {
      offset += number[0].length;
      try {
        return JSON.parse(number[0]) as number;
      } catch {
        return fail('Malformed JSON number.');
      }
    }
    return fail('Expected a JSON value.');
  };

  const parsed = parseValue();
  skipWhitespace();
  if (offset !== source.length) return fail('Unexpected trailing JSON content.');
  canonicalizeContextValueV1(parsed);
  return parsed;
}

/**
 * Вычисляет SHA-256 от точного доменного префикса и переданных UTF-8/canonical bytes.
 * Домен должен включать завершающий NUL-разделитель; значения v1 доступны в
 * {@link CONTEXT_DIGEST_DOMAINS_V1} и не должны конструироваться вызывающим кодом.
 *
 * @param domain Домен с завершающим NUL-разделителем, обычно из v1-каталога.
 * @param canonicalBytes Точные байты канонического JSON либо persisted prompt.
 * @returns Нижнерегистровый hexadecimal SHA-256 digest.
 * @throws {TypeError} Если домен не завершён NUL-разделителем или массив байтов не поддерживается.
 */
export function sha256DomainDigest(domain: string, canonicalBytes: Uint8Array): string {
  if (typeof domain !== 'string' || domain.length < 2 || !domain.endsWith('\0') || domain.slice(0, -1).includes('\0')) {
    throw new TypeError('Context digest domain must be a non-empty NUL-terminated string.');
  }
  if (!(canonicalBytes instanceof Uint8Array)) {
    throw new TypeError('Context digest input must be a Uint8Array.');
  }
  return createHash('sha256').update(domain, 'utf8').update(canonicalBytes).digest('hex');
}

/** Вычисляет contract digest только для полной persisted Work Task Contract v1. */
export function digestTaskContractV1(contract: PersistedWorkTaskContractV1): string {
  assertExactFields(contract, [
    'version', 'goal', 'context', 'requirements', 'acceptanceCriteria', 'dependencies', 'nonGoals',
    'definitionOfDone',
  ], 'Task Contract');
  if (!Number.isSafeInteger(contract.version) || contract.version < 1) {
    throw new TypeError('Task Contract version must be a positive safe integer.');
  }
  assertNonEmptyString(contract.goal, 'contract.goal');
  assertString(contract.context, 'contract.context');
  for (const field of ['requirements', 'acceptanceCriteria', 'dependencies', 'nonGoals', 'definitionOfDone'] as const) {
    assertStringArray(contract[field], `contract.${field}`);
  }
  return digestCanonicalValue(CONTEXT_DIGEST_DOMAINS_V1.contract, contract);
}

/** Вычисляет Request digest ровно по его persisted identity/project/request полям. */
export function digestRequestV1(request: RequestProvenancePayloadV1): string {
  assertExactFields(request, ['id', 'project_id', 'request'], 'Request');
  assertNonEmptyString(request.id, 'request.id');
  assertNonEmptyString(request.project_id, 'request.project_id');
  assertString(request.request, 'request.request');
  return digestCanonicalValue(CONTEXT_DIGEST_DOMAINS_V1.request, {
    id: request.id,
    project_id: request.project_id,
    request: request.request,
  });
}

/** Вычисляет Decision digest по точному выбранному persisted field set. */
export function digestDecisionV1(decision: DecisionProvenancePayloadV1): string {
  assertExactFields(decision, [
    'id', 'status', 'scope', 'title', 'rationale', 'related_guideline', 'content',
  ], 'Decision');
  assertNonEmptyString(decision.id, 'decision.id');
  for (const field of ['status', 'scope', 'title', 'rationale', 'content'] as const) {
    assertString(decision[field], `decision.${field}`);
  }
  assertNullableString(decision.related_guideline, 'decision.related_guideline');
  return digestCanonicalValue(CONTEXT_DIGEST_DOMAINS_V1.decision, {
    id: decision.id,
    status: decision.status,
    scope: decision.scope,
    title: decision.title,
    rationale: decision.rationale,
    related_guideline: decision.related_guideline,
    content: decision.content,
  });
}

/** Вычисляет Guideline digest по versioned searchable fields без текста или file path. */
export function digestGuidelineV1(guideline: GuidelineProvenancePayloadV1): string {
  assertExactFields(guideline, [
    'id', 'version', 'status', 'scope', 'applicable_roles', 'content_hash',
  ], 'Guideline');
  assertNonEmptyString(guideline.id, 'guideline.id');
  if (!Number.isSafeInteger(guideline.version) || guideline.version < 1) {
    throw new TypeError('Guideline version must be a positive safe integer.');
  }
  for (const field of ['status', 'scope', 'applicable_roles', 'content_hash'] as const) {
    assertString(guideline[field], `guideline.${field}`);
  }
  return digestCanonicalValue(CONTEXT_DIGEST_DOMAINS_V1.guideline, {
    id: guideline.id,
    version: guideline.version,
    status: guideline.status,
    scope: guideline.scope,
    applicable_roles: guideline.applicable_roles,
    content_hash: guideline.content_hash,
  });
}

/** Вычисляет Finding digest по отображаемым role-relevant полям и guideline reference. */
export function digestFindingV1(finding: FindingProvenancePayloadV1): string {
  assertExactFields(finding, ['id', 'status', 'title', 'description', 'guideline_ref'], 'Finding');
  assertNonEmptyString(finding.id, 'finding.id');
  for (const field of ['status', 'title', 'description'] as const) assertString(finding[field], `finding.${field}`);
  assertNullableString(finding.guideline_ref, 'finding.guideline_ref');
  return digestCanonicalValue(CONTEXT_DIGEST_DOMAINS_V1.finding, {
    id: finding.id,
    status: finding.status,
    title: finding.title,
    description: finding.description,
    guideline_ref: finding.guideline_ref,
  });
}

/** Вычисляет Defect digest по отображаемым role-relevant полям и acceptance reference. */
export function digestDefectV1(defect: DefectProvenancePayloadV1): string {
  assertExactFields(defect, ['id', 'status', 'title', 'description', 'acceptance_criterion_ref'], 'Defect');
  assertNonEmptyString(defect.id, 'defect.id');
  for (const field of ['status', 'title', 'description'] as const) assertString(defect[field], `defect.${field}`);
  assertNullableString(defect.acceptance_criterion_ref, 'defect.acceptance_criterion_ref');
  return digestCanonicalValue(CONTEXT_DIGEST_DOMAINS_V1.defect, {
    id: defect.id,
    status: defect.status,
    title: defect.title,
    description: defect.description,
    acceptance_criterion_ref: defect.acceptance_criterion_ref,
  });
}

/** Хеширует точные UTF-8 bytes, сохранённые в `agent_runs.prompt`, не декодируя их. */
export function digestRunPromptBytesV1(promptBytes: Uint8Array): string {
  return sha256DomainDigest(CONTEXT_DIGEST_DOMAINS_V1.runPrompt, promptBytes);
}

/**
 * Вычисляет доменно-разделённый digest поддерживаемой structural pruning policy v1.
 * В digest входят ровно `version` и `limit`; дополнительные поля и неподдерживаемая
 * версия не допускаются. Digest включается в prompt provenance, а не раскрывает лимит.
 *
 * @param policy Проверенная deterministic policy для выбранных Guidelines.
 * @returns Нижнерегистровый SHA-256 digest канонической policy.
 * @throws {TypeError} Если поля, версия или limit не соответствуют v1.
 */
export function digestContextBudgetPolicyV1(policy: ContextBudgetPolicyV1): string {
  assertExactFields(policy, ['version', 'limit'], 'Context budget policy');
  if (policy.version !== 1 || !Number.isSafeInteger(policy.limit) || policy.limit < 0) {
    throw new TypeError('Context budget policy is unsupported or invalid.');
  }
  return digestCanonicalValue(CONTEXT_DIGEST_DOMAINS_V1.contextBudgetPolicy, policy);
}

/**
 * Строит deterministic execution/input fingerprint. Входная структура полная:
 * неизвестные версии и digest передаются явно как `null`; item/capability arrays
 * сортируются перед JCS, а location identity нормализуются без помещения значений
 * в DTO или результата, доступного клиенту.
 */
export function digestRunContextV1(input: ContextFingerprintInputV1): string {
  assertExactFields(input, [
    'promptHash', 'subjectType', 'subjectId', 'contractOrRequestDigest', 'items', 'contextBuilderVersion',
    'role', 'roleVersion', 'runtime', 'runtimeVersion', 'model', 'modelVersion', 'outputSchemaVersion',
    'contextVersion', 'workspaceIdentity', 'targetHead',
    'targetBranch', 'effectiveCapabilityIds', 'projectConfigRevisionId', 'projectConfigHash', 'policyIdentity',
  ], 'Run context fingerprint');
  assertSha256(input.promptHash, 'promptHash');
  if (!['TASK', 'EPIC', 'REQUEST'].includes(input.subjectType)) {
    throw new TypeError('Run context subjectType must be TASK, EPIC, or REQUEST.');
  }
  assertNonEmptyString(input.subjectId, 'subjectId');
  assertNullableSha256(input.contractOrRequestDigest, 'contractOrRequestDigest');
  assertNullableNonEmptyString(input.contextBuilderVersion, 'contextBuilderVersion');
  assertNonEmptyString(input.role, 'role');
  assertNullableNonEmptyString(input.roleVersion, 'roleVersion');
  assertNullableNonEmptyString(input.runtime, 'runtime');
  assertNullableNonEmptyString(input.runtimeVersion, 'runtimeVersion');
  assertNullableNonEmptyString(input.model, 'model');
  assertNullableNonEmptyString(input.modelVersion, 'modelVersion');
  assertNullableNonEmptyString(input.outputSchemaVersion, 'outputSchemaVersion');
  assertNullableNonEmptyString(input.contextVersion, 'contextVersion');
  assertNullableNonEmptyString(input.targetHead, 'targetHead');
  assertNullableNonEmptyString(input.targetBranch, 'targetBranch');
  if (input.projectConfigRevisionId !== null && !isCanonicalUuid(input.projectConfigRevisionId)) {
    throw new TypeError('Project Config revision ID must be a canonical UUID or null.');
  }
  assertNullableSha256(input.projectConfigHash, 'projectConfigHash');
  if ((input.projectConfigRevisionId === null) !== (input.projectConfigHash === null)) {
    throw new TypeError('Project Config revision ID and hash must both be known or both be null.');
  }
  assertExactFields(input.workspaceIdentity, ['repository', 'workspace', 'worktree'], 'Workspace identity');
  assertExactFields(input.policyIdentity, ['providerId', 'providerPolicyId', 'runtimeId', 'runtimePolicyId'], 'Policy identity');
  for (const [field, value] of Object.entries(input.policyIdentity)) {
    assertNullableNonEmptyString(value, `policyIdentity.${field}`);
  }
  if (!Array.isArray(input.items)) throw new TypeError('Run context items must be an array.');
  input.items.forEach((item, index) => assertExactFields(item, ['id', 'version', 'digest'], `items[${index}]`));
  if (!Array.isArray(input.effectiveCapabilityIds)) throw new TypeError('Effective capability IDs must be an array.');
  canonicalizeContextValueV1(input.effectiveCapabilityIds);
  input.effectiveCapabilityIds.forEach((id, index) => assertNonEmptyString(id, `effectiveCapabilityIds[${index}]`));
  if (new Set(input.effectiveCapabilityIds).size !== input.effectiveCapabilityIds.length) {
    throw new TypeError('Effective capability IDs must not contain duplicates.');
  }

  const canonicalEnvelope = {
    prompt_hash: input.promptHash,
    subject_type: input.subjectType,
    subject_id: input.subjectId,
    contract_or_request_digest: input.contractOrRequestDigest,
    items: sortContextItemProvenanceV1(input.items).map(({ id, version, digest }) => ({ id, version, digest })),
    context_builder_version: input.contextBuilderVersion,
    role: input.role,
    role_version: input.roleVersion,
    runtime: input.runtime,
    runtime_version: input.runtimeVersion,
    model: input.model,
    model_version: input.modelVersion,
    output_schema_version: input.outputSchemaVersion,
    context_version: input.contextVersion,
    workspace_identity: {
      repository: normalizeWorkspaceIdentity(input.workspaceIdentity.repository),
      workspace: normalizeWorkspaceIdentity(input.workspaceIdentity.workspace),
      worktree: normalizeWorkspaceIdentity(input.workspaceIdentity.worktree),
    },
    target_head: input.targetHead,
    target_branch: input.targetBranch,
    effective_capability_ids: [...input.effectiveCapabilityIds].sort(compareStrings),
    project_config_revision_id: input.projectConfigRevisionId,
    project_config_hash: input.projectConfigHash,
    policy_identity: {
      provider_id: input.policyIdentity.providerId,
      provider_policy_id: input.policyIdentity.providerPolicyId,
      runtime_id: input.policyIdentity.runtimeId,
      runtime_policy_id: input.policyIdentity.runtimePolicyId,
    },
  };
  return digestCanonicalValue(CONTEXT_DIGEST_DOMAINS_V1.runContext, canonicalEnvelope);
}

/**
 * Возвращает новую копию provenance items в стабильном порядке tuple `(id, version, digest)`.
 * Неизвестные version/digest сортируются перед известными и сохраняются как `null`.
 *
 * @param items Идентификаторы и известные либо неизвестные версии выбранного контекста.
 * @returns Отсортированные записи без изменения исходного массива.
 */
export function sortContextItemProvenanceV1(
  items: readonly ContextItemProvenance[],
): ContextItemProvenance[] {
  for (const item of items) {
    if (typeof item.id !== 'string' || item.id.length === 0) {
      throw new TypeError('Context item provenance requires a non-empty ID.');
    }
    assertUnicodeScalarString(item.id);
    if (item.version !== null && (!Number.isSafeInteger(item.version) || item.version < 1)) {
      throw new TypeError('Context item provenance version must be a positive safe integer or null.');
    }
    if (item.digest !== null && !/^[a-f0-9]{64}$/.test(item.digest)) {
      throw new TypeError('Context item provenance digest must be a lowercase SHA-256 hex string or null.');
    }
  }
  return [...items].sort((left, right) => {
    const idOrder = compareStrings(left.id, right.id);
    if (idOrder !== 0) return idOrder;
    const versionOrder = compareNullableNumbers(left.version, right.version);
    if (versionOrder !== 0) return versionOrder;
    return compareNullableStrings(left.digest, right.digest);
  });
}

function serializeArray(items: unknown[], serialize: (value: unknown) => string): string {
  if (Object.getPrototypeOf(items) !== Array.prototype) {
    throw new TypeError('Context JSON arrays must be plain arrays.');
  }
  const ownKeys = Reflect.ownKeys(items);
  if (ownKeys.some((key) => typeof key !== 'string')) {
    throw new TypeError('Context JSON arrays must not have symbol properties.');
  }
  const expectedOwnKeys = new Set<string>(['length']);
  const serialized: string[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const key = String(index);
    expectedOwnKeys.add(key);
    const descriptor = Object.getOwnPropertyDescriptor(items, key);
    if (!descriptor) throw new TypeError('Context JSON arrays must not be sparse or contain holes.');
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError('Context JSON arrays must not contain hidden or accessor entries.');
    }
    serialized.push(serialize(descriptor.value));
  }
  if (ownKeys.some((key) => typeof key === 'string' && !expectedOwnKeys.has(key))) {
    throw new TypeError('Context JSON arrays must not have extra properties.');
  }
  return `[${serialized.join(',')}]`;
}

function serializeObject(
  record: object,
  serialize: (value: unknown) => string,
): string {
  const prototype = Object.getPrototypeOf(record) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Context JSON objects must be plain objects.');
  }
  const ownKeys = Reflect.ownKeys(record);
  if (ownKeys.some((key) => typeof key !== 'string')) {
    throw new TypeError('Context JSON objects must not have symbol properties.');
  }
  const keys = ownKeys as string[];
  const values = new Map<string, unknown>();
  for (const key of keys) {
    assertUnicodeScalarString(key);
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor?.enumerable) {
      throw new TypeError('Context JSON objects must not contain hidden properties.');
    }
    if (!('value' in descriptor)) {
      throw new TypeError('Context JSON objects must not contain accessors.');
    }
    values.set(key, descriptor.value);
  }
  keys.sort(compareStrings);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${serialize(values.get(key))}`).join(',')}}`;
}

function assertUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError('Context JSON strings must not contain lone surrogates.');
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError('Context JSON strings must not contain lone surrogates.');
    }
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNullableNumbers(left: number | null, right: number | null): number {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return left < right ? -1 : 1;
}

function compareNullableStrings(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return compareStrings(left, right);
}

function digestCanonicalValue(domain: string, value: unknown): string {
  return sha256DomainDigest(domain, new TextEncoder().encode(canonicalizeContextValueV1(value)));
}

function assertExactFields(value: unknown, required: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} must be a plain object.`);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== 'string')) throw new TypeError(`${label} must not contain symbol fields.`);
  const fields = ownKeys as string[];
  const expected = new Set(required);
  if (fields.length !== expected.size || fields.some((field) => !expected.has(field))) {
    const missing = required.filter((field) => !fields.includes(field));
    const extra = fields.filter((field) => !expected.has(field));
    throw new TypeError(`${label} fields do not match the v1 contract (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'}).`);
  }
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      throw new TypeError(`${label}.${field} must be an enumerable data field.`);
    }
  }
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string.`);
  assertUnicodeScalarString(value);
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  assertString(value, label);
  if (value.length === 0) throw new TypeError(`${label} must not be empty.`);
}

function assertNullableString(value: unknown, label: string): asserts value is string | null {
  if (value !== null) assertString(value, label);
}

function assertNullableNonEmptyString(value: unknown, label: string): asserts value is string | null {
  if (value !== null) assertNonEmptyString(value, label);
}

function assertStringArray(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array of strings.`);
  value.forEach((item, index) => assertString(item, `${label}[${index}]`));
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 hex string.`);
  }
}

function assertNullableSha256(value: unknown, label: string): asserts value is string | null {
  if (value !== null) assertSha256(value, label);
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

/** Нормализует синтаксис пути одинаково на Windows и POSIX до fingerprint hashing. */
function normalizeWorkspaceIdentity(value: string | null): string | null {
  if (value === null) return null;
  assertNonEmptyString(value, 'workspace identity');
  const slashes = value.replace(/\\/g, '/');
  const drive = /^([a-zA-Z]):(\/)?/.exec(slashes);
  const isUnc = slashes.startsWith('//');
  const isRooted = Boolean(drive?.[2]) || (!drive && slashes.startsWith('/')) || isUnc;
  let prefix = '';
  let remainder = slashes;
  if (drive) {
    prefix = `${drive[1]!.toUpperCase()}:${drive[2] ? '/' : ''}`;
    remainder = slashes.slice(drive[0].length);
  } else if (isUnc) {
    prefix = '//';
    remainder = slashes.slice(2);
  } else if (slashes.startsWith('/')) {
    prefix = '/';
    remainder = slashes.slice(1);
  }

  const segments: string[] = [];
  for (const segment of remainder.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      const previous = segments[segments.length - 1];
      if (previous !== undefined && previous !== '..') segments.pop();
      else if (!isRooted) segments.push(segment);
      continue;
    }
    segments.push(segment);
  }
  const normalized = `${prefix}${segments.join('/')}`;
  if (normalized !== '') return normalized;
  return prefix || '.';
}
