import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildAuditEvidence, resolveWindowsPnpmExecutable } from './security-audit-evidence.mjs';

const root = resolve(import.meta.dirname, '..');

test('buildAuditEvidence binds parsed audit output to repository provenance', () => {
  const evidence = buildAuditEvidence({
    auditOutput: JSON.stringify({ advisories: {}, metadata: { vulnerabilities: { high: 0 } } }),
    command: 'pnpm audit --prod --json',
    toolVersion: '12.4.2',
    nodeVersion: '24.19.0',
    runAt: '2026-09-21T12:00:00.000Z',
    revision: 'abc123',
    branch: 'develop',
    lockfileSha256: 'lock-hash',
    exitCode: 0,
  });

  assert.deepEqual(evidence, {
    command: 'pnpm audit --prod --json',
    tool: 'pnpm',
    toolVersion: '12.4.2',
    nodeVersion: '24.19.0',
    runAt: '2026-09-21T12:00:00.000Z',
    revision: 'abc123',
    branch: 'develop',
    lockfileSha256: 'lock-hash',
    exitCode: 0,
    raw: { advisories: {}, metadata: { vulnerabilities: { high: 0 } } },
  });
});

test('buildAuditEvidence preserves non-JSON audit output and failure status', () => {
  const evidence = buildAuditEvidence({
    auditOutput: 'registry unavailable',
    command: 'pnpm audit --prod --json',
    toolVersion: '12.4.2',
    nodeVersion: '24.19.0',
    runAt: '2026-09-21T12:00:00.000Z',
    revision: 'abc123',
    branch: 'develop',
    lockfileSha256: 'lock-hash',
    exitCode: 1,
  });

  assert.equal(evidence.exitCode, 1);
  assert.equal(evidence.raw, 'registry unavailable');
});

test('resolveWindowsPnpmExecutable bypasses cmd shims for shell:false', () => {
  const files = new Map([
    [
      'C:\\Program Files\\nodejs\\pnpm.cmd',
      'call "C:\\Users\\alex1\\AppData\\Roaming\\npm\\pnpm.cmd" %*',
    ],
    [
      'C:\\Users\\alex1\\AppData\\Roaming\\npm\\pnpm.cmd',
      '"%dp0%\\node_modules\\pnpm\\pnpm.exe" %*',
    ],
    [
      'C:\\Users\\alex1\\AppData\\Roaming\\npm\\node_modules\\pnpm\\pnpm.exe',
      null,
    ],
  ]);

  assert.equal(
    resolveWindowsPnpmExecutable('C:\\Program Files\\nodejs\\pnpm.cmd', {
      readShim: (path) => files.get(path),
      fileExists: (path) => files.has(path),
    }),
    'C:\\Users\\alex1\\AppData\\Roaming\\npm\\node_modules\\pnpm\\pnpm.exe',
  );
});

test('scan manifest describes a run-bound evidence contract instead of a stale snapshot', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'scan-manifest.json'), 'utf8'));

  assert.equal(manifest.scanner.result, 'requires-ci-run');
  assert.equal(manifest.scanner.revision, null);
  assert.equal(manifest.scanner.lockfileSha256, null);
  assert.equal(manifest.scanner.exitCode, null);
  assert.equal(manifest.scanner.artifactPattern, 'artifacts/security/pnpm-audit-prod-{revision}.json');
});

test('root test graph builds contracts before workspace tests', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.scripts.test, 'pnpm --filter @ebb-orchestrator/contracts build && pnpm -r --if-present test && node --test scripts/server-env.test.mjs scripts/run-server.test.mjs scripts/local-user-stdin-smoke.test.mjs');
});

test('production workflow runs local-user stdin smoke after server build', () => {
  const workflow = readFileSync(join(root, '.github/workflows/production-gates.yml'), 'utf8');

  const serverBuild = workflow.indexOf('pnpm server:build');
  const stdinSmoke = workflow.indexOf('node scripts/local-user-stdin-smoke.mjs');
  const webBuild = workflow.indexOf('pnpm web:build');
  const harnessContracts = workflow.indexOf('node --test scripts/security-audit-evidence.test.mjs apps/web/test/e2e/credential-handoff.test.mjs');
  const browserE2E = workflow.indexOf('pnpm --dir apps/web test:e2e');
  assert.ok(serverBuild !== -1, 'workflow must build the server');
  assert.ok(stdinSmoke > serverBuild, 'workflow must run stdin smoke after server build');
  assert.ok(webBuild > stdinSmoke, 'workflow must build web before running E2E harness contracts');
  assert.ok(harnessContracts > webBuild, 'workflow must run E2E harness contracts after both builds');
  assert.ok(browserE2E > harnessContracts, 'workflow must run browser E2E after harness contracts');
});

test('production workflow preserves audit evidence under exact conditional contract', () => {
  const workflow = readFileSync(join(root, '.github/workflows/production-gates.yml'), 'utf8');

  assert.ok(workflow.includes('id: install-dependencies'));
  assert.ok(workflow.includes("if: ${{ !cancelled() && steps.install-dependencies.outcome == 'success' }}"));
  assert.ok(workflow.includes("if: ${{ !cancelled() && steps.dependency-audit.outcome != 'skipped' }}"));
  assert.ok(workflow.includes("if: ${{ !cancelled() && steps.dependency-audit.outcome == 'failure' }}"));
  assert.ok(workflow.includes('uses: actions/upload-artifact@v6'));
  assert.ok(workflow.includes('name: pnpm-audit-prod-${{ github.sha }}'));
  assert.ok(workflow.includes('path: artifacts/security/pnpm-audit-prod-${{ github.sha }}.json'));
  assert.ok(workflow.includes('if-no-files-found: error'));
  assert.ok(!workflow.includes('archive: false'));

  const install = workflow.indexOf('id: install-dependencies');
  const audit = workflow.indexOf('- name: Dependency audit');
  const upload = workflow.indexOf('- name: Upload dependency audit evidence');
  const finalGate = workflow.indexOf('- name: Fail if dependency audit failed');
  assert.ok(install < audit && audit < upload && upload < finalGate);
});
