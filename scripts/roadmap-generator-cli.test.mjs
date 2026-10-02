import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'scripts/roadmap-generator-cli.mjs');
const plan = (overrides = {}) => ({ id: 'plan-91', kind: 'plan', status: 'planned', title: 'CLI Fixture Plan', created: '2026-09-20', updated: '2026-09-21', depends_on: ['plan-90'], ...overrides });
const yaml = (data) => `---\n${Object.entries(data).map(([key, value]) => `${key}: ${Array.isArray(value) ? `[${value.join(', ')}]` : value}`).join('\n')}\n---\n`;

test('CLI projects only validated Plans from --plans-root to --output', () => {
  const temp = mkdtempSync(join(tmpdir(), 'ebb-roadmap-cli-'));
  try {
    const plans = join(temp, 'plans');
    const output = join(temp, 'out', 'roadmap.md');
    mkdirSync(plans);
    writeFileSync(join(plans, 'plan.md'), yaml(plan()));
    writeFileSync(join(plans, 'ledger.md'), yaml({ ...plan({ id: 'ledger-90', kind: 'ledger', status: 'draft', title: 'Ledger Fixture' }) }));
    writeFileSync(join(plans, 'merge-decisions.md'), yaml({ id: 'plan-08-01-merge', kind: 'governance-evidence', status: 'superseded', title: 'Historical merge evidence', type: 'evidence' }));
    writeFileSync(join(plans, 'progress-ledger.md'), yaml({ id: 'plan-00-progress-ledger', status: 'superseded', title: 'Progress Ledger', type: 'evidence' }));
    const generatedPath = join(root, 'docs/roadmap/generated.md');
    const generatedBefore = readFileSync(generatedPath, 'utf8');
    const result = spawnSync(process.execPath, [cli, `--plans-root=${plans}`, `--output=${output}`], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `Roadmap generated: ${output}\nPlans included: 1\n`);
    assert.equal(result.stderr, '');
    const content = readFileSync(output, 'utf8');
    assert.match(content, /^---\nid: roadmap-01\nstatus: generated\nkind: roadmap\ntitle: Ebb Orchestrator Roadmap\nsummary: Generated from Plan metadata and dependencies\ncreated: 2026-09-16\nupdated: 2026-09-21\n---\n\n/);
    assert.match(content, /plan-91/);
    assert.match(content, /CLI Fixture Plan/);
    assert.match(content, /\[current-state roadmap\]\(02-current-state\.md\)/);
    assert.match(content, /planned/);
    assert.match(content, /plan-90 → plan-91/);
    assert.doesNotMatch(content, /ledger-90|Ledger Fixture|plan-08-01-merge|Historical merge evidence|plan-00-progress-ledger|Progress Ledger|Stage Register|\| Stage \|/i);
    assert.equal(readFileSync(generatedPath, 'utf8'), generatedBefore);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('CLI parser enforces Plan contract and accepts every PlanStatus', () => {
  const statuses = ['proposed', 'planned', 'in_progress', 'blocked', 'completed', 'superseded', 'cancelled'];
  const required = plan({ depends_on: undefined });
  delete required.depends_on;
  const cases = [
    ['required-only', required, true],
    ['optional-present', plan({ summary: 'summary', depends_on: ['plan-90'], specs: ['spec-01'], evidence: ['evidence.md'] }), true],
    ...statuses.map(status => [status, plan({ status }), true]),
    ['bad-status', plan({ status: 'draft' }), false],
    ...['id', 'kind', 'status', 'title', 'created', 'updated'].map(key => { const copy = { ...required }; delete copy[key]; return [`missing-${key}`, copy, false]; }),
    ...Object.entries({ id: 42, kind: 42, status: 42, title: 42, created: 42, updated: 42 }).map(([key, value]) => [`wrong-type-${key}`, plan({ [key]: value }), false]),
    ['invalid-kind', plan({ kind: 'unknown-kind' }), false],
    ['bad-date-created-day', plan({ created: '2026-02-29' }), false],
    ['bad-date-created-month', plan({ created: '2026-13-01' }), false],
    ['bad-date-updated-day', plan({ updated: '2026-04-31' }), false],
    ['bad-date-updated-format', plan({ updated: '2026-9-5' }), false],
    ['bad-summary', plan({ summary: 3 }), false],
    ['bad-depends-on', plan({ depends_on: 'plan-90' }), false],
    ['bad-specs', plan({ specs: 'spec-01' }), false],
    ['bad-evidence', plan({ evidence: ['evidence.md', 42] }), false],
    ['unknown-roadmap-field', plan({ roadmap: '01' }), false],
    ['unknown-stage-field', plan({ stage: '01' }), false],
    ['unknown-field', plan({ undeclared: true }), false],
  ];
  for (const [name, data, valid] of cases) {
    const temp = mkdtempSync(join(tmpdir(), 'ebb-roadmap-matrix-'));
    try {
      const source = join(temp, `${name}.md`);
      const output = join(temp, 'output.md');
      writeFileSync(source, yaml(data));
      const result = spawnSync(process.execPath, [cli, `--plans-root=${temp}`, `--output=${output}`], { cwd: root, encoding: 'utf8' });
      if (valid) {
        assert.equal(result.status, 0, `${name}: ${result.stderr}`);
        const content = readFileSync(output, 'utf8');
        assert.equal(content.split('\n').filter((line) => line.startsWith('| plan-')).length, 1);
        assert.ok(content.includes(`| plan-91 | ${data.status} |`), name);
      } else {
        assert.notEqual(result.status, 0, `${name} was accepted`);
        assert.ok(result.stderr.includes(source), `${name}: ${result.stderr}`);
        assert.equal(existsSync(output), false, name);
      }
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }
});

test('CLI reports invalid Plan metadata with its source instead of silently omitting it', () => {
  const temp = mkdtempSync(join(tmpdir(), 'ebb-roadmap-invalid-plan-'));
  try {
    const plans = join(temp, 'plans');
    const source = join(plans, 'invalid-plan.md');
    const output = join(temp, 'roadmap.md');
    mkdirSync(plans);
    writeFileSync(source, yaml({ id: 'plan-91', kind: 'plan', title: 'Invalid Fixture', created: '2026-09-20', updated: '2026-09-21' }));

    const result = spawnSync(process.execPath, [cli, `--plans-root=${plans}`, `--output=${output}`], { cwd: root, encoding: 'utf8' });

    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(source), result.stderr);
    assert.match(result.stderr, /missing status/);
    assert.equal(existsSync(output), false);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('CLI reports Markdown without frontmatter in the plans root', () => {
  const temp = mkdtempSync(join(tmpdir(), 'ebb-roadmap-missing-frontmatter-'));
  try {
    const plans = join(temp, 'plans');
    const source = join(plans, 'missing-frontmatter.md');
    const output = join(temp, 'roadmap.md');
    mkdirSync(plans);
    writeFileSync(source, '# Plan without frontmatter\n');

    const result = spawnSync(process.execPath, [cli, `--plans-root=${plans}`, `--output=${output}`], { cwd: root, encoding: 'utf8' });

    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(source), result.stderr);
    assert.match(result.stderr, /missing YAML frontmatter/);
    assert.equal(existsSync(output), false);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('CLI reports plan directory traversal failures', () => {
  const temp = mkdtempSync(join(tmpdir(), 'ebb-roadmap-missing-root-'));
  try {
    const plans = join(temp, 'missing-plans');
    const output = join(temp, 'roadmap.md');
    const result = spawnSync(process.execPath, [cli, `--plans-root=${plans}`, `--output=${output}`], { cwd: root, encoding: 'utf8' });

    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(plans), result.stderr);
    assert.equal(existsSync(output), false);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('CLI dry-run previews content without creating or changing the output file', () => {
  const temp = mkdtempSync(join(tmpdir(), 'ebb-roadmap-dry-run-'));
  try {
    const plans = join(temp, 'plans');
    const output = join(temp, 'not-created', 'roadmap.md');
    mkdirSync(plans);
    writeFileSync(join(plans, 'plan.md'), yaml(plan({ depends_on: [] })));

    const result = spawnSync(process.execPath, [cli, `--plans-root=${plans}`, `--output=${output}`, '--dry-run'], { cwd: root, encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /DRY RUN MODE/);
    assert.match(result.stdout, /Generated content preview/);
    assert.equal(result.stderr, '');
    assert.equal(existsSync(output), false);
    assert.equal(existsSync(dirname(output)), false);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('CLI rejects duplicate Plan IDs before changing the output file', () => {
  const temp = mkdtempSync(join(tmpdir(), 'ebb-roadmap-duplicate-ids-'));
  try {
    const plans = join(temp, 'plans');
    const output = join(temp, 'roadmap.md');
    const sentinel = 'keep existing roadmap\n';
    mkdirSync(plans);
    writeFileSync(join(plans, 'first.md'), yaml(plan({ depends_on: [] })));
    writeFileSync(join(plans, 'second.md'), yaml(plan({ title: 'Duplicate ID Fixture', depends_on: [] })));
    writeFileSync(output, sentinel);

    const result = spawnSync(process.execPath, [cli, `--plans-root=${plans}`, `--output=${output}`], { cwd: root, encoding: 'utf8' });

    assert.notEqual(result.status, 0, 'duplicate Plan IDs must fail validation');
    assert.match(result.stderr, /Duplicate plan ID/);
    assert.equal(readFileSync(output, 'utf8'), sentinel);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('CLI rejects circular Plan dependencies before changing the output file', () => {
  const temp = mkdtempSync(join(tmpdir(), 'ebb-roadmap-circular-deps-'));
  try {
    const plans = join(temp, 'plans');
    const output = join(temp, 'roadmap.md');
    const sentinel = 'keep existing roadmap\n';
    mkdirSync(plans);
    writeFileSync(join(plans, 'first.md'), yaml(plan({ depends_on: ['plan-92'] })));
    writeFileSync(join(plans, 'second.md'), yaml(plan({ id: 'plan-92', title: 'Second Plan', depends_on: ['plan-91'] })));
    writeFileSync(output, sentinel);

    const result = spawnSync(process.execPath, [cli, `--plans-root=${plans}`, `--output=${output}`], { cwd: root, encoding: 'utf8' });

    assert.notEqual(result.status, 0, 'circular dependencies must fail validation');
    assert.match(result.stderr, /Circular dependency/);
    assert.equal(readFileSync(output, 'utf8'), sentinel);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
