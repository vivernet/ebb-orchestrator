import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as collector from './plan-collector.js';
import { collectPlans } from './plan-collector.js';

test('collectPlans preserves Plan IDs and dependency arrays and exposes no grouping API', () => {
  const directory = mkdtempSync(join(tmpdir(), 'plan-collector-'));
  try {
    const source = (id: string, depends: string[]) => `---\nid: ${id}\nkind: plan\nstatus: planned\ntitle: ${id}\ncreated: 2026-09-25\nupdated: 2026-09-26\ndepends_on:\n${depends.map((item) => `  - ${item}`).join('\n')}\n---\n`;
    writeFileSync(join(directory, 'one.md'), source('plan-91', ['plan-90', 'plan-89']));
    writeFileSync(join(directory, 'two.md'), source('plan-92', ['plan-91']));
    writeFileSync(join(directory, 'ledger.md'), '---\nid: ledger-01\nkind: ledger\nstatus: draft\ntitle: Ledger\ncreated: 2026-09-25\nupdated: 2026-09-26\n---\n');
    writeFileSync(join(directory, 'ignore.txt'), 'not markdown');
    mkdirSync(join(directory, 'nested'));
    writeFileSync(join(directory, 'nested', 'nested.md'), source('plan-93', []));
    const plans = collectPlans(directory);
    assert.deepEqual(plans.map(({ id, depends_on }) => ({ id, depends_on })), [
      { id: 'plan-91', depends_on: ['plan-90', 'plan-89'] },
      { id: 'plan-92', depends_on: ['plan-91'] },
    ]);
    assert.equal('groupedByStage' in collector, false);
    assert.ok(plans.every((plan) => !('roadmap' in plan) && !('stage' in plan)));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('collectPlans returns an empty array for a missing directory', () => {
  assert.deepEqual(collectPlans(join(tmpdir(), 'missing-plan-collector')), []);
});