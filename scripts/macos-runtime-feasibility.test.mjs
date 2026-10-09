import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('Phase 1 never claims membership, restart, exec identity or platform readiness', () => {
  const source = readFileSync('scripts/macos-runtime-feasibility.mjs', 'utf8');
  for (const field of ['membership', 'fullScopeStop', 'restart', 'staleAfterExec']) {
    assert.match(source, new RegExp(`${field}: 'NOT_RUN'`));
  }
  assert.match(source, /platformReadiness: 'NOT_CLAIMED'/);
  assert.match(source, /shell: false/);
  assert.match(source, /timeout = 30_000/);
  assert.doesNotMatch(source, /process\.env|launchctl|sudo|pkill/);
});

test('hosted dispatch is limited to trusted develop push and exact probe files', () => {
  const workflow = readFileSync('.github/workflows/macos-runtime-feasibility.yml', 'utf8');
  assert.match(workflow, /branches: \[develop\]/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /pull_request|secrets\.|Hermes|provider|sudo/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /timeout-minutes: 10/);
  const paths = workflow.split('    paths:\n')[1].split('permissions:')[0].trim().split('\n');
  assert.equal(paths.length, 4);
  for (const line of paths) assert.match(line.trim(), /^- (\.github\/workflows\/macos-runtime-feasibility\.yml|scripts\/macos-runtime-feasibility\.(cpp|mjs|test\.mjs))$/);
});

test('non-macOS execution reports NOT_RUN and returns nonzero', { skip: process.platform === 'darwin' }, () => {
  const temporary = mkdtempSync(join(tmpdir(), 'ebb-macos-wrapper-test-'));
  try {
    const reportPath = join(temporary, 'report.json');
    const child = spawnSync(process.execPath, ['scripts/macos-runtime-feasibility.mjs', reportPath], {
      shell: false, encoding: 'utf8', timeout: 5000,
    });
    assert.equal(child.status, 1);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(report.reason, 'MACOS_REQUIRED');
    assert.equal(report.phaseVerdict, 'NOT_RUN');
    assert.equal(report.platformReadiness, 'NOT_CLAIMED');
  } finally { rmSync(temporary, { recursive: true }); }
});
