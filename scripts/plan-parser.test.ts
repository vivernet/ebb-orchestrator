import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parsePlan, type PlanMetadata, type PlanStatus } from './plan-parser.js';

let directory: string;
let fixtureIndex: number;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'plan-parser-')); fixtureIndex = 0; });
afterEach(() => rmSync(directory, { recursive: true, force: true }));

function parse(metadata: Record<string, unknown>): PlanMetadata {
  const path = join(directory, `fixture-${fixtureIndex++}.md`);
  writeFileSync(path, `---\n${Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\nBody\n`);
  return parsePlan(path);
}

const required = {
  id: 'plan-91', kind: 'plan', status: 'planned', title: 'Fixture Plan',
  created: '2026-09-25', updated: '2026-09-26',
};
const statuses: PlanStatus[] = ['proposed', 'planned', 'in_progress', 'blocked', 'completed', 'superseded', 'cancelled'];

describe('plan-parser', () => {
  it('accepts required-only metadata and omits optional properties', () => {
    const result = parse(required);
    expect(result).toEqual(required);
    expect(Object.keys(result).sort()).toEqual(['created', 'id', 'kind', 'status', 'title', 'updated']);
  });

  it('accepts every optional field, including summary', () => {
    expect(parse({ ...required, summary: 'Short summary', depends_on: ['plan-90'], specs: ['spec-01'], evidence: ['evidence.md'] })).toEqual({
      ...required, summary: 'Short summary', depends_on: ['plan-90'], specs: ['spec-01'], evidence: ['evidence.md'],
    });
  });

  it.each(Object.keys(required))('rejects missing required field %s', (field) => {
    const input: Record<string, unknown> = { ...required };
    delete input[field];
    expect(() => parse(input)).toThrow();
  });

  it.each(Object.keys(required))('rejects wrong type for required field %s', (field) => {
    expect(() => parse({ ...required, [field]: field === 'status' ? 1 : null })).toThrow();
  });

  it.each(['summary', 'depends_on', 'specs', 'evidence'])('rejects wrong type for optional field %s', (field) => {
    expect(() => parse({ ...required, [field]: 42 })).toThrow();
  });

  it.each(['roadmap', 'stage', 'undeclared'])('rejects unknown frontmatter field %s', (field) => {
    expect(() => parse({ ...required, [field]: 'value' })).toThrow(/неизвестн.*поле/i);
  });

  it('rejects invalid kind and statuses outside the lifecycle union', () => {
    expect(() => parse({ ...required, kind: 'ledger' })).toThrow();
    expect(() => parse({ ...required, status: 'draft' })).toThrow();
  });

  it.each(['2026-02-29', '2026-13-01', '2026-04-31', '26-09-25', '2026-9-5'])('rejects invalid calendar date %s', (date) => {
    expect(() => parse({ ...required, created: date })).toThrow();
    expect(() => parse({ ...required, updated: date })).toThrow();
  });

  it.each(statuses)('accepts PlanStatus %s', (status) => {
    expect(parse({ ...required, status }).status).toBe(status);
  });
});