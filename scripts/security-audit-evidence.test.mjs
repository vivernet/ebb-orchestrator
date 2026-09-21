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

test('production workflow uploads provenance evidence and preserves audit failure status', () => {
  const workflow = readFileSync(join(root, '.github/workflows/production-gates.yml'), 'utf8');

  assert.match(workflow, /security-audit-evidence\.mjs/);
  assert.match(workflow, /if: always\(\)/);
  assert.match(workflow, /steps\.dependency-audit\.outcome == 'failure'/);
});
