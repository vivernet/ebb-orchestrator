import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as yaml from 'js-yaml';
import { buildAuditEvidence, resolveWindowsPnpmExecutable } from './security-audit-evidence.mjs';

const root = resolve(import.meta.dirname, '..');
const failurePathVerifier = join(root, 'scripts/security-audit-failure-path-check.mjs');

function runFailurePathVerifier({ scenario, outcomes, evidenceExitCode }) {
  const fixtureDirectory = mkdtempSync(join(tmpdir(), 'ebb-plan17-failure-path-'));
  const evidencePath = join(fixtureDirectory, 'audit.json');

  if (evidenceExitCode !== undefined) {
    writeFileSync(evidencePath, JSON.stringify({ exitCode: evidenceExitCode }), 'utf8');
  }

  try {
    return spawnSync(process.execPath, [failurePathVerifier], {
      cwd: fixtureDirectory,
      encoding: 'utf8',
      env: {
        ...process.env,
        PLAN17_SCENARIO: scenario,
        AUDIT_EVIDENCE_PATH: evidencePath,
        ...outcomes,
      },
    });
  } finally {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
}

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

test('manual failure-path workflow mirrors production audit conditions and wires all four scenarios', () => {
  const production = readFileSync(join(root, '.github/workflows/production-gates.yml'), 'utf8');
  const manual = readFileSync(join(root, '.github/workflows/security-audit-failure-paths.yml'), 'utf8');
  const manualWorkflow = yaml.load(manual, { schema: yaml.JSON_SCHEMA });
  const events = manualWorkflow.on ?? manualWorkflow['on'];
  const steps = manualWorkflow.jobs['failure-path'].steps;
  const stepsById = new Map(steps.filter((step) => step.id).map((step) => [step.id, step]));

  assert.deepEqual(Object.keys(events), ['workflow_dispatch']);
  assert.deepEqual(events.workflow_dispatch.inputs.scenario.options, [
    'upstream-failure',
    'audit-failure',
    'install-failure',
    'cancel-before-audit',
  ]);
  for (const condition of [
    "if: ${{ !cancelled() && steps.install-dependencies.outcome == 'success' }}",
    "if: ${{ !cancelled() && steps.dependency-audit.outcome != 'skipped' }}",
    "if: ${{ !cancelled() && steps.dependency-audit.outcome == 'failure' }}",
  ]) {
    assert.ok(production.includes(condition), `production is missing ${condition}`);
    assert.ok(manual.includes(condition), `manual workflow is missing ${condition}`);
  }
  assert.match(manual, /^name: Ebb Orchestrator — /);
  assert.match(manual, /PLAN17_SCENARIO: \$\{\{ inputs\.scenario \}\}/);
  assert.doesNotMatch(manual, /\[\[\s*"\$\{\{\s*inputs\.scenario/);
  assert.match(manual, /uses: actions\/upload-artifact@v6/);
  assert.match(manual, /node scripts\/security-audit-evidence\.mjs --output/);
  assert.match(manual, /GITHUB_PATH/);
  assert.match(manual, /REAL_PNPM/);
  assert.match(manual, /симулированный отказ audit/);
  assert.match(manual, /if-no-files-found: error/);

  assert.equal(stepsById.get('upstream-quality-gate').if, "${{ inputs.scenario == 'upstream-failure' }}");
  assert.equal(stepsById.get('cancellation-pause').if, "${{ inputs.scenario == 'cancel-before-audit' }}");
  assert.equal(stepsById.get('audit-failure-injection').if, "${{ success() && inputs.scenario == 'audit-failure' }}");
  assert.equal(stepsById.get('upload-audit-evidence').uses, 'actions/upload-artifact@v6');
  assert.equal(stepsById.get('verify-scenario-outcomes').run, 'node scripts/security-audit-failure-path-check.mjs');
  assert.equal(stepsById.get('verify-scenario-outcomes').if, '${{ !cancelled() }}');
  assert.equal(stepsById.get('verify-scenario-outcomes').env.INSTALL_OUTCOME, '${{ steps.install-dependencies.outcome }}');
  assert.equal(stepsById.get('verify-scenario-outcomes').env.UPSTREAM_GATE_OUTCOME, '${{ steps.upstream-quality-gate.outcome }}');
  assert.equal(stepsById.get('verify-scenario-outcomes').env.AUDIT_INJECTION_OUTCOME, '${{ steps.audit-failure-injection.outcome }}');
  assert.match(stepsById.get('verify-scenario-outcomes').env.AUDIT_OUTCOME, /steps\.dependency-audit\.outcome/);
  assert.match(stepsById.get('verify-scenario-outcomes').env.UPLOAD_OUTCOME, /steps\.upload-audit-evidence\.outcome/);
  assert.equal(stepsById.get('verify-scenario-outcomes').env.FINAL_GATE_OUTCOME, '${{ steps.fail-if-audit-failed.outcome }}');
  assert.ok(steps.indexOf(stepsById.get('cancellation-pause')) < steps.indexOf(stepsById.get('dependency-audit')));
  assert.ok(steps.indexOf(stepsById.get('verify-scenario-outcomes')) > steps.indexOf(stepsById.get('fail-if-audit-failed')));
});

test('failure-path verifier enforces each non-cancelled scenario outcome and its evidence', () => {
  const cases = [
    {
      scenario: 'upstream-failure',
      outcomes: {
        INSTALL_OUTCOME: 'success',
        UPSTREAM_GATE_OUTCOME: 'failure',
        AUDIT_INJECTION_OUTCOME: 'skipped',
        AUDIT_OUTCOME: 'success',
        UPLOAD_OUTCOME: 'success',
        FINAL_GATE_OUTCOME: 'skipped',
      },
      evidenceExitCode: 0,
    },
    {
      scenario: 'audit-failure',
      outcomes: {
        INSTALL_OUTCOME: 'success',
        UPSTREAM_GATE_OUTCOME: 'skipped',
        AUDIT_INJECTION_OUTCOME: 'success',
        AUDIT_OUTCOME: 'failure',
        UPLOAD_OUTCOME: 'success',
        FINAL_GATE_OUTCOME: 'failure',
      },
      evidenceExitCode: 1,
    },
    {
      scenario: 'install-failure',
      outcomes: {
        INSTALL_OUTCOME: 'failure',
        UPSTREAM_GATE_OUTCOME: 'skipped',
        AUDIT_INJECTION_OUTCOME: 'skipped',
        AUDIT_OUTCOME: 'skipped',
        UPLOAD_OUTCOME: 'skipped',
        FINAL_GATE_OUTCOME: 'skipped',
      },
    },
  ];

  for (const testCase of cases) {
    const result = runFailurePathVerifier(testCase);
    assert.equal(result.status, 0, `${testCase.scenario}: ${result.stderr}`);
  }

  const mismatch = runFailurePathVerifier({
    ...cases[1],
    outcomes: { ...cases[1].outcomes, UPLOAD_OUTCOME: 'skipped' },
  });
  assert.notEqual(mismatch.status, 0);
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
