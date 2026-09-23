import { parseFrontMatter, parseDocument, validateDocument, loadMigrationMap, validateMigrationMap, resolveCanonicalDocument } from './docs-governance-lib.mjs';
import assert from 'node:assert';
import { test } from 'node:test';

test('parseFrontMatter extracts metadata and body', () => {
  const text = '---\nid: roadmap-01\nkind: roadmap\ntitle: Test\nstatus: draft\ncreated: 2024-01-01\nupdated: 2024-01-02\n---\nActual content';
  const { data, body } = parseFrontMatter(text);
  assert.strictEqual(data.id, 'roadmap-01');
  assert.strictEqual(data.kind, 'roadmap');
  assert.strictEqual(body, 'Actual content');
});

test('parseDocument parses file content', () => {
  const doc = parseDocument('test.md', '---\nid: spec-02\nkind: spec\ntitle: API Spec\nstatus: in-progress\ncreated: 2024-01-01\nupdated: 2024-01-02\n---\nText');
  assert.strictEqual(doc.kind, 'spec');
  assert.strictEqual(doc.status, 'in-progress');
});

test('validateDocument returns empty for valid document', () => {
  const record = { id: 'plan-01', kind: 'plan', title: 'Plan', status: 'approved', created: '2024-01-01', updated: '2024-01-02', depends_on: [], specs: [], evidence: [], body: '', filePath: 'test.md' };
  const issues = validateDocument(record, []);
  assert.strictEqual(issues.length, 0);
});

test('validateDocument returns issues for invalid id', () => {
  const record = { id: 'invalid', kind: 'plan', title: 'Plan', status: 'approved', created: '2024-01-01', updated: '2024-01-02', depends_on: [], specs: [], evidence: [], body: '', filePath: 'test.md' };
  const issues = validateDocument(record, []);
  assert.strictEqual(issues.length, 1);
  assert.strictEqual(issues[0].field, 'id');
});

test('loadMigrationMap parses migration document', async () => {
  const map = await loadMigrationMap('./docs/architecture/plans/governance/evidence/03-document-migration-map.md');
  assert.ok(map.entries.length > 0);
  assert.ok(map.entries[0].oldPath);
  assert.ok(map.entries[0].newPath);
  assert.ok(map.entries[0].action);
});

test('validateMigrationMap checks source paths exist', async () => {
  const inventory = [{ filePath: 'docs/README.md', id: 'index-00', kind: 'index', title: 'Docs', status: 'approved', created: '2026-01-01', updated: '2026-01-01', depends_on: [], specs: [], evidence: [], body: '' }];
  const map = await loadMigrationMap('./docs/architecture/plans/governance/evidence/03-document-migration-map.md');
  const issues = await validateMigrationMap(map, inventory);
  assert.ok(issues.some(i => i.field === 'incomplete_mapping'));
});

test('resolveCanonicalDocument finds canonical target', async () => {
  const result = await resolveCanonicalDocument('docs/architecture/plans/2026-09-16-v1-roadmap.md');
  assert.strictEqual(result.action, 'merge');
  assert.ok(result.target);
});

// Tests for Roadmap Model building and rendering
test('buildRoadmapModel aggregates plans by stage', async () => {
  const { buildRoadmapModel } = await import('./docs-governance-lib.mjs');
  const catalog = [
    { id: 'plan-01', kind: 'plan', title: 'Stage 1 Plan', status: 'completed', created: '2024-01-01', updated: '2024-01-02', roadmap: '01', stage: '01', depends_on: [], specs: [], evidence: [], body: '', filePath: 'test1.md' },
    { id: 'plan-02', kind: 'plan', title: 'Stage 1 Plan 2', status: 'in-progress', created: '2024-01-01', updated: '2024-01-02', roadmap: '01', stage: '01', depends_on: [], specs: [], evidence: [], body: '', filePath: 'test2.md' },
    { id: 'plan-03', kind: 'plan', title: 'Stage 2 Plan', status: 'proposed', created: '2024-01-01', updated: '2024-01-02', roadmap: '01', stage: '02', depends_on: [], specs: [], evidence: [], body: '', filePath: 'test3.md' }
  ];
  const model = buildRoadmapModel(catalog);
  assert.strictEqual(model.stages.length, 2);
  assert.strictEqual(model.stages[0].stage, '01');
  assert.strictEqual(model.stages[0].plans.length, 2);
});

test('renderRoadmap generates sections with markers', async () => {
  const { renderRoadmap } = await import('./docs-governance-lib.mjs');
  const model = {
    generatedAt: '2024-01-02',
    stages: [
      { stage: '01', plans: [{ id: 'plan-01', status: 'completed', title: 'Stage 1' }] }
    ],
    plans: [{ id: 'plan-01', status: 'completed', title: 'Stage 1' }],
    proposals: []
  };
  const output = renderRoadmap(model);
  assert.ok(output.includes('<!-- BEGIN GENERATED'));
  assert.ok(output.includes('<!-- END GENERATED'));
});

test('isGeneratedRoadmapUpToDate checks for matching content', async () => {
  const { isGeneratedRoadmapUpToDate } = await import('./docs-governance-lib.mjs');
  const existing = 'some content';
  const expected = 'some content';
  assert.ok(isGeneratedRoadmapUpToDate(existing, expected));
});

test('writeGeneratedRoadmap writes file to path', async () => {
  const { writeGeneratedRoadmap } = await import('./docs-governance-lib.mjs');
  writeGeneratedRoadmap('/tmp/roadmap-test.md', 'test content');
  const { readFileSync } = await import('fs');
  assert.ok(readFileSync('/tmp/roadmap-test.md', 'utf-8').includes('test content'));
  const { unlinkSync } = await import('fs');
  unlinkSync('/tmp/roadmap-test.md');
});
