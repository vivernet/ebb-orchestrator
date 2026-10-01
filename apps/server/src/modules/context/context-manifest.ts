/**
 * Сборщик безопасного manifest provenance для подготовленного контекста.
 * Manifest хранит идентификаторы, версии и digest, но не prompt, секреты или
 * полное содержимое выбранных knowledge items.
 */

import type { ContextItemProvenance, ContextManifest, ContextManifestV1 } from './context-types.js';

type ManifestRole = ContextManifest['role'];

type ManifestInput = {
  taskContractVersion: string;
  taskContractDigest?: string | null;
  guidelineIds?: string[];
  guidelineProvenance?: ContextItemProvenance[];
  decisionIds?: string[];
  decisionProvenance?: ContextItemProvenance[];
  findingIds?: string[];
  findingProvenance?: ContextItemProvenance[];
  defectIds?: string[];
  defectProvenance?: ContextItemProvenance[];
  contextBuilderVersion?: string;
  initialTokenSize?: number;
};

type ManifestV1Input = ManifestInput & {
  runId: string;
  taskId: string;
  role: ManifestRole;
};

/** Собирает versioned ContextManifest provenance без хранения полного текста. */
export class ManifestBuilder {
  /**
   * Формирует manifest, сохраняя прежние ID-массивы и добавляя явные version/digest tuples.
   * Для legacy-входов без точной provenance version и digest остаются `null`; это
   * не утверждает, что исходные элементы имели пустое содержимое.
   *
   * @param input Подготовленные безопасные метаданные контекста без полного текста.
   * @returns Manifest, пригодный для отображения состава и сравнения версий контекста.
   * @throws {TypeError} Если передан некорректный SHA-256 digest или версия элемента.
   */
  build(input: ManifestV1Input): ContextManifestV1 {
    assertManifestIdentity(input);
    if (input.initialTokenSize !== undefined
      && (!Number.isSafeInteger(input.initialTokenSize) || input.initialTokenSize < 0)) {
      throw new TypeError('Exact initial token size must be a non-negative safe integer or unknown.');
    }
    const guidelines = makeItemProvenance(input.guidelineIds, input.guidelineProvenance);
    const decisions = makeItemProvenance(input.decisionIds, input.decisionProvenance);
    const findings = makeItemProvenance(input.findingIds, input.findingProvenance);
    const defects = makeItemProvenance(input.defectIds, input.defectProvenance);
    const result: ContextManifestV1 = {
      runId: input.runId,
      taskId: input.taskId,
      role: input.role,
      taskContractVersion: input.taskContractVersion,
      taskContractDigest: normalizeDigest(input.taskContractDigest ?? null, 'contract'),
      guidelineIds: guidelines.ids,
      guidelineProvenance: guidelines.provenance,
      decisionIds: decisions.ids,
      decisionProvenance: decisions.provenance,
      findingIds: findings.ids,
      findingProvenance: findings.provenance,
      defectIds: defects.ids,
      defectProvenance: defects.provenance,
      contextBuilderVersion: input.contextBuilderVersion ?? '1.0.0',
      initialTokenSize: input.initialTokenSize ?? null,
      createdAt: new Date().toISOString(),
    };

    return result;
  }

  /** Формирует provenance manifest пакета контекста Developer. */
  buildForDeveloper(input: Omit<ManifestV1Input, 'role'>): ContextManifestV1 {
    return this.build({ ...input, role: 'developer' });
  }

  /** Формирует provenance manifest пакета контекста Reviewer. */
  buildForReviewer(input: Omit<ManifestV1Input, 'role' | 'defectIds' | 'defectProvenance'>): ContextManifestV1 {
    return this.build({ ...input, role: 'reviewer' });
  }

  /** Формирует provenance manifest пакета контекста QA. */
  buildForQA(input: Omit<ManifestV1Input, 'role' | 'guidelineIds' | 'guidelineProvenance' | 'decisionIds' | 'decisionProvenance'>): ContextManifestV1 {
    return this.build({ ...input, role: 'qa' });
  }
}

function assertManifestIdentity(input: ManifestV1Input): void {
  if (typeof input.runId !== 'string' || input.runId.length === 0) {
    throw new TypeError('ContextManifestV1 requires a non-empty runId.');
  }
  if (typeof input.taskId !== 'string' || input.taskId.length === 0) {
    throw new TypeError('ContextManifestV1 requires a non-empty taskId.');
  }
  if (!['developer', 'reviewer', 'qa', 'integration', 'architect'].includes(input.role)) {
    throw new TypeError('ContextManifestV1 requires a supported role.');
  }
}

function makeItemProvenance(
  ids: readonly string[] | undefined,
  provenance: readonly ContextItemProvenance[] | undefined,
): { ids: string[]; provenance: ContextItemProvenance[] } {
  const normalizedProvenance = provenance?.map((item) => {
    if (typeof item?.id !== 'string' || item.id.trim().length === 0) {
      throw new TypeError('Context item provenance requires a non-empty ID.');
    }
    if (item.version !== null && (!Number.isSafeInteger(item.version) || item.version < 1)) {
      throw new TypeError('Context item provenance requires an ID and a positive integer version or null.');
    }
    return {
      id: item.id,
      version: item.version,
      digest: normalizeDigest(item.digest, item.id),
    };
  });
  if (normalizedProvenance) {
    const provenanceIds = new Set<string>();
    for (const item of normalizedProvenance) {
      if (provenanceIds.has(item.id)) {
        throw new TypeError('Context item provenance IDs must be unique.');
      }
      provenanceIds.add(item.id);
    }
  }

  const selectedIds = ids === undefined
    ? normalizedProvenance?.map((item) => item.id) ?? []
    : validateSelectedIds(ids);
  if (normalizedProvenance === undefined) {
    return {
      ids: [...selectedIds],
      provenance: selectedIds.map((id) => ({ id, version: null, digest: null })),
    };
  }

  const provenanceById = new Map(normalizedProvenance.map((item) => [item.id, item]));
  if (selectedIds.length !== normalizedProvenance.length || selectedIds.some((id) => !provenanceById.has(id))) {
    throw new TypeError('Context item provenance IDs must match the selected IDs exactly.');
  }
  return {
    ids: [...selectedIds],
    provenance: selectedIds.map((id) => {
      const item = provenanceById.get(id);
      if (!item) throw new TypeError('Context item provenance IDs must match the selected IDs exactly.');
      return item;
    }),
  };
}

function validateSelectedIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new TypeError('Selected context item IDs must be non-empty strings.');
    }
    if (seen.has(id)) {
      throw new TypeError('Selected context item IDs must be unique.');
    }
    seen.add(id);
  }
  return [...ids];
}

function normalizeDigest(value: string | null, field: string): string | null {
  if (value === null) return null;
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new TypeError(`Context provenance ${field} digest must be a lowercase SHA-256 hex string or null.`);
  }
  return value;
}

export const manifestBuilder = new ManifestBuilder();
