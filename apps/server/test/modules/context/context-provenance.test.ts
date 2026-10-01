import { describe, expect, it } from 'vitest';
import * as provenanceApi from '../../../src/modules/context/context-provenance.js';
import type {
  ContextFingerprintInputV1,
  DecisionProvenancePayloadV1,
  DefectProvenancePayloadV1,
  FindingProvenancePayloadV1,
  GuidelineProvenancePayloadV1,
  RequestProvenancePayloadV1,
  PersistedWorkTaskContractV1,
} from '../../../src/modules/context/context-types.js';
import {
  canonicalizeContextValueV1,
  parsePersistedContextJsonV1,
  sortContextItemProvenanceV1,
} from '../../../src/modules/context/context-provenance.js';
import { ManifestBuilder } from '../../../src/modules/context/context-manifest.js';

describe('canonicalizeContextValueV1', () => {
  it('matches fixed RFC 8785 canonical JSON examples', () => {
    expect(canonicalizeContextValueV1({ z: 1, a: { c: true, b: null } })).toBe(
      '{"a":{"b":null,"c":true},"z":1}',
    );
    expect(
      canonicalizeContextValueV1({
        numbers: [333333333.3333333, 1e30, 4.5, 2e-3, 1e-27],
      }),
    ).toBe('{"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27]}');
    expect(
      canonicalizeContextValueV1(
        parsePersistedContextJsonV1('{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001]}'),
      ),
    ).toBe('{"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27]}');
    expect(canonicalizeContextValueV1({ '\uE000': 'bmp', '\u{10000}': 'astral' })).toBe(
      '{"𐀀":"astral","":"bmp"}',
    );
    expect(canonicalizeContextValueV1({ text: '\b\t\n\f\r"\\/' })).toBe(
      '{"text":"\\b\\t\\n\\f\\r\\"\\\\/"}',
    );
  });

  it('preserves missing versus null, array order, and Unicode code points without normalization', () => {
    expect(canonicalizeContextValueV1({})).toBe('{}');
    expect(canonicalizeContextValueV1({ value: null })).toBe('{"value":null}');
    expect(canonicalizeContextValueV1([1, 2])).not.toBe(canonicalizeContextValueV1([2, 1]));
    expect(canonicalizeContextValueV1('\u00e9')).toBe('"é"');
    expect(canonicalizeContextValueV1('e\u0301')).toBe('"é"');
    expect(canonicalizeContextValueV1('\u00e9')).not.toBe(canonicalizeContextValueV1('e\u0301'));
    expect(canonicalizeContextValueV1('\ud83d\ude00')).toBe('"😀"');
  });

  it('uses ECMAScript number serialization for edge values', () => {
    expect(canonicalizeContextValueV1([-0, 1e-6, 1e-7, 1e20, 1e21])).toBe(
      '[0,0.000001,1e-7,100000000000000000000,1e+21]',
    );
    expect(canonicalizeContextValueV1(9007199254740992)).toBe('9007199254740992');
  });

  it('rejects non-JSON values, malformed object shapes, cycles, and lone surrogates', () => {
    for (const value of [undefined, NaN, Infinity, -Infinity, 1n, Symbol('x'), () => null, new Date()]) {
      expect(() => canonicalizeContextValueV1(value)).toThrow();
    }
    expect(() => canonicalizeContextValueV1('\ud800')).toThrow(/surrogate/i);
    expect(() => canonicalizeContextValueV1({ '\udfff': 1 })).toThrow(/surrogate/i);
    const sparse: unknown[] = new Array(2);
    sparse[1] = 1;
    expect(() => canonicalizeContextValueV1(sparse)).toThrow(/sparse|hole/i);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => canonicalizeContextValueV1(cyclic)).toThrow(/cycle/i);
    expect(() => canonicalizeContextValueV1(Object.create({ inherited: true }))).toThrow(/plain object/i);
    const accessor = Object.defineProperty({}, 'value', { enumerable: true, get: () => 1 });
    expect(() => canonicalizeContextValueV1(accessor)).toThrow(/accessor/i);
  });
});

describe('parsePersistedContextJsonV1', () => {
  it('rejects duplicate decoded object keys and malformed or trailing JSON', () => {
    expect(() => parsePersistedContextJsonV1('{"id":"first","id":"second"}')).toThrow(/duplicate/i);
    expect(() => parsePersistedContextJsonV1('{"id":"first","\\u0069d":"second"}')).toThrow(/duplicate/i);
    expect(() => parsePersistedContextJsonV1('{"value":')).toThrow();
    expect(() => parsePersistedContextJsonV1('{"value":1} trailing')).toThrow();
  });

  it('accepts strict JSON and returns a value with the same JCS representation', () => {
    const persisted = parsePersistedContextJsonV1('{ "z": 1, "a": [true, null] }');
    expect(canonicalizeContextValueV1(persisted)).toBe('{"a":[true,null],"z":1}');
    expect(() => parsePersistedContextJsonV1('"\\ud800"')).toThrow(/surrogate/i);
    expect(() => parsePersistedContextJsonV1('1e400')).toThrow(/finite|number/i);
  });
});

describe('domain-separated provenance digests', () => {
  const semanticDigest = (name: string, input: unknown): string => {
    const builder = (provenanceApi as unknown as Record<string, unknown>)[name];
    if (typeof builder !== 'function') throw new Error(`Missing semantic provenance builder ${name}.`);
    return (builder as (value: unknown) => string)(input);
  };

  const contract = {
    version: 1,
    goal: 'ship the feature',
    context: 'production context',
    requirements: ['persist provenance', 'preserve prompt'],
    acceptanceCriteria: ['manifest exists'],
    dependencies: ['TASK-0'],
    nonGoals: ['capture hidden Hermes history'],
    definitionOfDone: ['tests pass'],
  } satisfies PersistedWorkTaskContractV1;

  const request = { id: 'REQ-1', project_id: 'PROJECT-1', request: 'prepare a release' } satisfies RequestProvenancePayloadV1;
  const decision = {
    id: 'DEC-0001', status: 'ACCEPTED', scope: 'PROJECT', title: 'Keep provenance exact',
    rationale: 'Recovery needs stable identity.', related_guideline: 'GL-SEC-001', content: 'Use exact inputs.',
  } satisfies DecisionProvenancePayloadV1;
  const guideline = {
    id: 'GL-SEC-001', version: 3, status: 'ACTIVE', scope: 'PROJECT',
    applicable_roles: 'developer,reviewer', content_hash: 'a'.repeat(64),
  } satisfies GuidelineProvenancePayloadV1;
  const finding = {
    id: 'F-1', status: 'OPEN', title: 'Unsafe resume', description: 'Prior process is live.', guideline_ref: 'GL-SEC-001',
  } satisfies FindingProvenancePayloadV1;
  const defect = {
    id: 'D-1', status: 'OPEN', title: 'Stale result', description: 'Acceptance was not rerun.',
    acceptance_criterion_ref: 'AC-2',
  } satisfies DefectProvenancePayloadV1;

  it('hashes the complete validated contract and exact Request payload with fixed vectors', () => {
    expect(semanticDigest('digestTaskContractV1', contract)).toBe('b3b7b20a3da87182ed94dff59718a9880a2cf898e08b7689678da877973f9ca7');
    expect(semanticDigest('digestRequestV1', request)).toBe('3bfdc597415229d56ab736b333a0971f958224f04b5801dc6a61a4f26ba2224f');

    for (const [field, value] of Object.entries(contract)) {
      const changed = typeof value === 'number' ? value + 1 : Array.isArray(value) ? [...value, 'changed'] : `${value}-changed`;
      expect(semanticDigest('digestTaskContractV1', { ...contract, [field]: changed }))
        .not.toBe(semanticDigest('digestTaskContractV1', contract));
    }
    expect(() => semanticDigest('digestTaskContractV1', { ...contract, definitionOfDone: undefined }))
      .toThrow(/contract|definitionOfDone|validated|required/i);
    expect(() => semanticDigest('digestTaskContractV1', { ...contract, version: 0 }))
      .toThrow(/version/i);

    for (const field of ['id', 'project_id', 'request']) {
      expect(semanticDigest('digestRequestV1', { ...request, [field]: `${request[field as keyof typeof request]}-changed` }))
        .not.toBe(semanticDigest('digestRequestV1', request));
    }
  });

  it('hashes the exact selected Decision, Guideline, Finding, and Defect fields', () => {
    const vectors = [
      ['digestDecisionV1', decision, '4f3697470ea6e83681a91f2943a187e6b2be5c07feb7bfd5dd0c121f1ac9b309'],
      ['digestGuidelineV1', guideline, '4a95c68f6bae4aaf54bf067fa716879e015358685d16d662f54f6438765e632f'],
      ['digestFindingV1', finding, '078b43f34543cc596b9ec809304c447a3d857a07d8da5e89e0788bfe6dec4c7d'],
      ['digestDefectV1', defect, '3dfb5b674f1c0245e0ee5da2207f02d323f75003ce14091844c889baa6c60dc7'],
    ] as const;
    for (const [builder, value, expected] of vectors) {
      expect(semanticDigest(builder, value)).toBe(expected);
      for (const [field, current] of Object.entries(value)) {
        const changed = typeof current === 'number' ? current + 1 : `${current}-changed`;
        expect(semanticDigest(builder, { ...value, [field]: changed })).not.toBe(semanticDigest(builder, value));
      }
    }
  });

  it('hashes exact persisted prompt UTF-8 bytes with a fixed vector', () => {
    const bytes = new TextEncoder().encode('Prompt:\n€');
    expect(semanticDigest('digestRunPromptBytesV1', bytes)).toBe('03213831c8a5bea3b678ef34fca369233fededec8b8a383efadafbf625246607');
    expect(semanticDigest('digestRunPromptBytesV1', new TextEncoder().encode('Prompt: €')))
      .not.toBe(semanticDigest('digestRunPromptBytesV1', bytes));
  });

  it('fingerprints every prepared input and execution boundary field, sorting only defined sets', () => {
    const fingerprint = {
      promptHash: '1'.repeat(64),
      subjectType: 'TASK',
      subjectId: 'TASK-1',
      contractOrRequestDigest: '2'.repeat(64),
      items: [
        { id: 'GL-2', version: 2, digest: 'b'.repeat(64) },
        { id: 'GL-1', version: null, digest: null },
      ],
      contextBuilderVersion: '2.1.0',
      role: 'developer',
      roleVersion: null,
      runtime: 'hermes',
      runtimeVersion: '1.0.0',
      model: 'model-a',
      modelVersion: '2026-01',
      outputSchemaVersion: 'output-v1',
      contextVersion: 'context-v1',
      workspaceIdentity: { repository: 'C:/repo', workspace: 'C:/repo/.ebb-orchestrator/worktrees/TASK-1', worktree: 'TASK-1' },
      targetHead: 'abcdef0123456789',
      targetBranch: 'feature/context',
      effectiveCapabilityIds: ['workspace.read', 'workspace.write'],
      projectConfigRevisionId: '11111111-1111-4111-8111-111111111111',
      projectConfigHash: '3'.repeat(64),
      policyIdentity: {
        providerId: 'provider-a', providerPolicyId: 'provider-local-v1',
        runtimeId: 'hermes', runtimePolicyId: 'hermes-local-v1',
      },
    } satisfies ContextFingerprintInputV1;

    const baseDigest = semanticDigest('digestRunContextV1', fingerprint);
    expect(baseDigest).toBe('907c1b191f35afb474d4a6b4fa121113b6d06955c54328fee7e80f720fab6616');
    expect(semanticDigest('digestRunContextV1', {
      ...fingerprint,
      items: [...fingerprint.items].reverse(),
      effectiveCapabilityIds: [...fingerprint.effectiveCapabilityIds].reverse(),
    })).toBe(baseDigest);
    expect(semanticDigest('digestRunContextV1', {
      ...fingerprint,
      workspaceIdentity: {
        repository: 'c:\\repo\\.',
        workspace: 'C:\\repo\\.ebb-orchestrator\\worktrees\\TASK-1',
        worktree: 'TASK-1/./',
      },
    })).toBe(baseDigest);

    const topLevelMutations: Array<[string, unknown]> = [
      ['promptHash', '4'.repeat(64)], ['subjectType', 'EPIC'], ['subjectId', 'TASK-2'],
      ['contractOrRequestDigest', '5'.repeat(64)], ['contextBuilderVersion', '2.1.1'],
      ['role', 'reviewer'], ['roleVersion', '1.0'], ['runtime', 'other-runtime'],
      ['runtimeVersion', '1.0.1'], ['model', 'model-b'], ['modelVersion', '2026-02'],
      ['outputSchemaVersion', 'output-v2'], ['contextVersion', 'context-v2'],
      ['targetHead', 'fedcba9876543210'], ['targetBranch', 'feature/other'],
      ['projectConfigRevisionId', '22222222-2222-4222-8222-222222222222'], ['projectConfigHash', '6'.repeat(64)],
    ];
    for (const [field, value] of topLevelMutations) {
      expect(semanticDigest('digestRunContextV1', { ...fingerprint, [field]: value }), field).not.toBe(baseDigest);
    }
    for (const field of ['repository', 'workspace', 'worktree']) {
      expect(semanticDigest('digestRunContextV1', {
        ...fingerprint,
        workspaceIdentity: { ...fingerprint.workspaceIdentity, [field]: `${fingerprint.workspaceIdentity[field as keyof typeof fingerprint.workspaceIdentity]}-changed` },
      }), `workspaceIdentity.${field}`).not.toBe(baseDigest);
    }
    for (const field of ['providerId', 'providerPolicyId', 'runtimeId', 'runtimePolicyId']) {
      expect(semanticDigest('digestRunContextV1', {
        ...fingerprint,
        policyIdentity: { ...fingerprint.policyIdentity, [field]: `${fingerprint.policyIdentity[field as keyof typeof fingerprint.policyIdentity]}-changed` },
      }), `policyIdentity.${field}`).not.toBe(baseDigest);
    }
    expect(semanticDigest('digestRunContextV1', {
      ...fingerprint,
      items: [...fingerprint.items, { id: 'GL-3', version: 1, digest: '7'.repeat(64) }],
    })).not.toBe(baseDigest);
    const firstItem = fingerprint.items[0];
    if (!firstItem) throw new Error('Fingerprint fixture must include a first item.');
    for (const [field, value] of Object.entries(firstItem)) {
      const changed = field === 'version'
        ? (value as number) + 1
        : field === 'digest'
          ? '8'.repeat(64)
          : `${value as string}-changed`;
      expect(semanticDigest('digestRunContextV1', {
        ...fingerprint,
        items: [{ ...firstItem, [field]: changed }, ...fingerprint.items.slice(1)],
      }), `items[0].${field}`).not.toBe(baseDigest);
    }
    expect(semanticDigest('digestRunContextV1', {
      ...fingerprint,
      effectiveCapabilityIds: [...fingerprint.effectiveCapabilityIds, 'workspace.delete'],
    })).not.toBe(baseDigest);
    expect(() => semanticDigest('digestRunContextV1', { ...fingerprint, runtimeVersion: undefined }))
      .toThrow(/runtimeVersion/i);
    expect(() => semanticDigest('digestRunContextV1', { ...fingerprint, projectConfigRevisionId: null }))
      .toThrow(/revision ID and hash/i);

    const unknowns = semanticDigest('digestRunContextV1', {
      ...fingerprint,
      contractOrRequestDigest: null,
      contextBuilderVersion: null,
      roleVersion: null,
      runtime: null,
      runtimeVersion: null,
      model: null,
      modelVersion: null,
      outputSchemaVersion: null,
      contextVersion: null,
      projectConfigRevisionId: null,
      projectConfigHash: null,
      items: [{ id: 'GL-UNKNOWN', version: null, digest: null }],
    });
    expect(unknowns).toMatch(/^[a-f0-9]{64}$/);
    expect(unknowns).not.toBe(baseDigest);
  });

  it('sorts item provenance tuples deterministically while preserving null unknowns', () => {
    const digestA = 'a'.repeat(64);
    const digestB = 'b'.repeat(64);
    const items = [
      { id: 'GL-2', version: 3, digest: digestB },
      { id: 'GL-1', version: null, digest: null },
      { id: 'GL-1', version: 2, digest: digestB },
      { id: 'GL-1', version: 2, digest: digestA },
    ];
    const expected = [items[1], items[3], items[2], items[0]];
    expect(sortContextItemProvenanceV1(items)).toEqual(expected);
    expect(sortContextItemProvenanceV1([...items].reverse())).toEqual(expected);
  });
});

describe('ManifestBuilder provenance', () => {
  it('does not claim ContextManifestV1 when required Run identity is absent', () => {
    expect(() => new ManifestBuilder().build({ taskContractVersion: 'v1' } as never))
      .toThrow(/runId|taskId|role/i);
  });

  it('retains ID arrays and represents unknown item version and digest as null', () => {
    const manifest = new ManifestBuilder().build({
      runId: 'RUN-1',
      taskId: 'TASK-1',
      role: 'developer',
      taskContractVersion: 'unknown',
      guidelineIds: ['GL-1'],
      decisionIds: ['DEC-1'],
      findingIds: ['F-1'],
      defectIds: ['D-1'],
    });
    expect(manifest).toMatchObject({ runId: 'RUN-1', taskId: 'TASK-1', role: 'developer' });
    expect(manifest.taskContractDigest).toBeNull();
    expect(manifest.guidelineIds).toEqual(['GL-1']);
    expect(manifest.guidelineProvenance).toEqual([{ id: 'GL-1', version: null, digest: null }]);
    expect(manifest.decisionProvenance).toEqual([{ id: 'DEC-1', version: null, digest: null }]);
    expect(manifest.findingProvenance).toEqual([{ id: 'F-1', version: null, digest: null }]);
    expect(manifest.defectProvenance).toEqual([{ id: 'D-1', version: null, digest: null }]);
    expect(manifest.initialTokenSize).toBeNull();
    expect(JSON.stringify(manifest)).not.toMatch(/prompt|secret|content/i);
  });

  it('preserves exact token counts and rejects malformed counts', () => {
    const builder = new ManifestBuilder();
    const input = {
      runId: 'RUN-3',
      taskId: 'TASK-3',
      role: 'developer' as const,
      taskContractVersion: 'v1',
    };

    expect(builder.build({ ...input, initialTokenSize: 5000 }).initialTokenSize).toBe(5000);
    for (const initialTokenSize of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => builder.build({ ...input, initialTokenSize })).toThrow(/token/i);
    }
  });

  it('persists known integer versions and digest while preserving the ID-only API', () => {
    const digest = 'a'.repeat(64);
    const manifest = new ManifestBuilder().build({
      runId: 'RUN-2',
      taskId: 'TASK-2',
      role: 'developer',
      taskContractVersion: 'v1',
      guidelineProvenance: [{ id: 'GL-7', version: 7, digest }],
    });
    expect(manifest.guidelineIds).toEqual(['GL-7']);
    expect(manifest.guidelineProvenance).toEqual([{ id: 'GL-7', version: 7, digest }]);
  });
});

describe('ManifestBuilder selected provenance integrity', () => {
  type BuildInput = Parameters<ManifestBuilder['build']>[0];
  type IdField = 'guidelineIds' | 'decisionIds' | 'findingIds' | 'defectIds';
  type ProvenanceField = 'guidelineProvenance' | 'decisionProvenance' | 'findingProvenance' | 'defectProvenance';

  const builder = new ManifestBuilder();
  const base: BuildInput = {
    runId: 'RUN-PROVENANCE',
    taskId: 'TASK-PROVENANCE',
    role: 'developer',
    taskContractVersion: 'v1',
  };
  const buildWith = (field: IdField | ProvenanceField, value: unknown) =>
    builder.build({ ...base, [field]: value } as BuildInput);
  const buildWithPair = (
    idField: IdField,
    ids: string[],
    provenanceField: ProvenanceField,
    provenance: Array<{ id: string; version: null; digest: null }>,
  ) => builder.build({ ...base, [idField]: ids, [provenanceField]: provenance } as BuildInput);
  const kinds = [
    { name: 'guidelines', idField: 'guidelineIds', provenanceField: 'guidelineProvenance', id: 'GL-1', extra: 'GL-2' },
    { name: 'decisions', idField: 'decisionIds', provenanceField: 'decisionProvenance', id: 'DEC-1', extra: 'DEC-2' },
    { name: 'findings', idField: 'findingIds', provenanceField: 'findingProvenance', id: 'F-1', extra: 'F-2' },
    { name: 'defects', idField: 'defectIds', provenanceField: 'defectProvenance', id: 'D-1', extra: 'D-2' },
  ] as const;
  const item = (id: string) => ({ id, version: null, digest: null });

  it('rejects empty and duplicate selected IDs and provenance IDs for every item kind', () => {
    for (const kind of kinds) {
      expect(() => buildWith(kind.idField, [kind.id, kind.id]), kind.name).toThrow(/duplicate|unique/i);
      expect(() => buildWith(kind.idField, ['']), kind.name).toThrow(/non-empty|empty/i);
      expect(() => buildWith(kind.provenanceField, [item(kind.id), item(kind.id)]), kind.name)
        .toThrow(/duplicate|unique/i);
      expect(() => buildWith(kind.provenanceField, [item('')]), kind.name)
        .toThrow(/non-empty|empty/i);
    }
  });

  it('rejects extra, missing, and mismatched provenance entries instead of filling or dropping them', () => {
    for (const kind of kinds) {
      expect(() => buildWithPair(kind.idField, [kind.id], kind.provenanceField, [item(kind.id), item(kind.extra)]), kind.name)
        .toThrow(/match|selected|extra|mismatch/i);
      expect(() => buildWithPair(kind.idField, [kind.id, kind.extra], kind.provenanceField, [item(kind.id)]), kind.name)
        .toThrow(/match|selected|missing|mismatch/i);
      expect(() => buildWithPair(kind.idField, [kind.id], kind.provenanceField, [item(kind.extra)]), kind.name)
        .toThrow(/match|selected|missing|extra|mismatch/i);
    }
  });

  it('derives IDs from supplied provenance only after validating its IDs', () => {
    const valid = builder.build({ ...base, guidelineProvenance: [item('GL-2'), item('GL-1')] });
    expect(valid.guidelineIds).toEqual(['GL-2', 'GL-1']);
    expect(valid.guidelineProvenance).toEqual([item('GL-2'), item('GL-1')]);
    expect(() => builder.build({ ...base, guidelineProvenance: [item('GL-1'), item('GL-1')] }))
      .toThrow(/duplicate|unique/i);
    expect(() => builder.build({ ...base, guidelineProvenance: [item('')] }))
      .toThrow(/non-empty|empty/i);
  });
});
