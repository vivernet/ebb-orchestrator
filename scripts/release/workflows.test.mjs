// plan-26 Task8 (part 1): trusted workflow schema/contract fixtures (test-first
// RED). Parses .github/workflows/release-validation.yml and
// release-operations.yml with js-yaml and asserts the policy contract from
// plan-26 section 11 and branch-and-release-policy section 3:
//   - manual workflow_dispatch only, untrusted inputs, validated argv
//   - exact pinned source/candidate trees (no floating HEAD for publisher code)
//   - release-operations: the single writer, one repository-level concurrency
//     group for publish/withdraw/resume, cancel-in-progress false, finite
//     timeouts, trusted minimal permissions, no shell interpolation of
//     untrusted inputs, no secret-printing steps
//   - release-validation: read-only + tests only, full publish matrix, explicit
//     BLOCKED notes for self-hosted Linux and Docker scope (fail closed)
//   - existing production/codeql/security-audit workflows keep their contract
//     (no second writer, no audit semantics degradation)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as parseYaml } from 'js-yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const WORKFLOWS_DIR = join(REPO_ROOT, '.github', 'workflows');

const VALIDATION = 'release-validation.yml';
const OPERATIONS = 'release-operations.yml';
const PRODUCTION_GATES = 'production-gates.yml';
const CODEQL = 'codeql.yml';
const AUDIT_FAILURE_PATHS = 'security-audit-failure-paths.yml';

// Jobs that deliver the full PUBLISH source matrix (plan-26 §15).
const PUBLISH_MATRIX_JOBS = [
  'quality-security-ubuntu-node24',
  'native-windows-node24',
  'native-linux-node24-selfhosted',
  'keyring-linux-windows-node24',
  'codeql-ubuntu',
  'release-module-tests',
  'governance-docs-skills',
  'docker-scope',
];

// Jobs that exist only to fail closed with an explicit BLOCKED note because
// the platform/dependency is absent (self-hosted Linux runner, Docker).
const BLOCKED_JOBS = {
  'native-linux-node24-selfhosted': 'BLOCKED_SELF_HOSTED_RUNNER',
  'docker-scope': 'BLOCKED_DOCKER_DEPENDENCY',
};

const ALLOWED_SHELLS = new Set(['bash', 'pwsh']);
const SECRET_PATTERNS = [/GITHUB_TOKEN/i, /\bTOKEN\b/i, /\bPASSWORD\b/i, /\bSECRET\b/i];
const FULL_SHA_RE = /^[0-9a-f]{40}$/;

async function readWorkflow(name) {
  const text = await readFile(join(WORKFLOWS_DIR, name), 'utf8');
  const doc = parseYaml(text);
  assert.ok(doc && typeof doc === 'object' && !Array.isArray(doc), `${name} must parse as a YAML mapping`);
  return doc;
}

function walkJobs(doc, fn) {
  const jobs = doc.jobs ?? {};
  for (const [jobId, job] of Object.entries(jobs)) {
    fn(jobId, job);
  }
  return jobs;
}

function stepsOf(job) {
  return Array.isArray(job?.steps) ? job.steps : [];
}

function runTextsOf(job) {
  return stepsOf(job)
    .filter((step) => typeof step?.run === 'string')
    .map((step) => step.run);
}

function assertManualDispatchOnly(doc, name) {
  const triggers = Object.keys(doc.on ?? {});
  assert.deepEqual(triggers, ['workflow_dispatch'], `${name}: must trigger only on workflow_dispatch`);
  assert.ok(doc.on.workflow_dispatch.inputs, `${name}: must declare workflow_dispatch inputs`);
}

function assertFiniteTimeouts(doc, name) {
  walkJobs(doc, (jobId, job) => {
    const minutes = job['timeout-minutes'];
    assert.ok(Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440, `${name} job ${jobId}: timeout-minutes must be a finite integer in [1, 1440] (got ${minutes})`);
  });
}

function assertNode24Consistent(doc, name) {
  walkJobs(doc, (jobId, job) => {
    for (const step of stepsOf(job)) {
      if (step?.uses === 'actions/setup-node@v7') {
        assert.equal(step.with?.['node-version'], '24.x', `${name} job ${jobId}: setup-node must use node 24.x`);
      }
      if (step?.uses === 'pnpm/setup@v1') {
        assert.equal(step.with?.runtime, 'node@24', `${name} job ${jobId}: pnpm setup must target node@24`);
      }
    }
  });
}

function assertNoShellInterpolation(doc, name) {
  walkJobs(doc, (jobId, job) => {
    for (const step of stepsOf(job)) {
      if (typeof step?.run === 'string') {
        assert.ok(!step.run.includes('${{'), `${name} job ${jobId}: untrusted input interpolated into shell command text: ${step.run}`);
        for (const pattern of SECRET_PATTERNS) {
          assert.ok(!pattern.test(step.run), `${name} job ${jobId}: run step must not print secrets (matched ${pattern})`);
        }
      }
      if (typeof step?.shell === 'string') {
        assert.ok(ALLOWED_SHELLS.has(step.shell), `${name} job ${jobId}: shell ${step.shell} is not in the safe allowlist`);
      }
    }
  });
}

function assertNoSecretEnv(doc, name) {
  walkJobs(doc, (jobId, job) => {
    const env = { ...(job?.env ?? {}), ...(job?.defaults?.run?.env ?? {}) };
    for (const [key, value] of Object.entries(env)) {
      assert.ok(!SECRET_PATTERNS.some((pattern) => pattern.test(key)), `${name} job ${jobId}: env key ${key} looks like a secret`);
      assert.ok(!String(value).includes('secrets.'), `${name} job ${jobId}: env value must not reference secrets context`);
    }
    for (const step of stepsOf(job)) {
      for (const [key, value] of Object.entries(step?.env ?? {})) {
        assert.ok(!SECRET_PATTERNS.some((pattern) => pattern.test(key)), `${name} job ${jobId}: step env key ${key} looks like a secret`);
        assert.ok(!String(value).includes('secrets.'), `${name} job ${jobId}: step env value must not reference secrets context`);
      }
    }
  });
}

test('release-validation.yml: manual dispatch inputs declare pinned source/candidate metadata', async () => {
  const doc = await readWorkflow(VALIDATION);
  assertManualDispatchOnly(doc, VALIDATION);
  const inputs = doc.on.workflow_dispatch.inputs;

  assert.equal(inputs.mode.type, 'choice');
  assert.ok(Array.isArray(inputs.mode.options) && inputs.mode.options.includes('publish') && inputs.mode.options.includes('withdraw'));

  assert.equal(inputs['source-ref'].type, 'string');
  assert.equal(inputs['source-ref'].required, true);
  assert.equal(inputs['source-ref'].default, 'refs/heads/develop');
  assert.equal(inputs['source-sha'].type, 'string');
  assert.equal(inputs['source-sha'].required, true);

  assert.equal(inputs['candidate-ref'].type, 'string');
  assert.equal(inputs['candidate-ref'].required, false);
  assert.equal(inputs['candidate-sha'].type, 'string');
  assert.equal(inputs['candidate-sha'].required, false);
  assert.equal(inputs['operation-id'].type, 'string');
  assert.equal(inputs['operation-id'].required, false);
});

test('release-validation.yml: inputs are validated before any job consumes them (validated argv)', async () => {
  const doc = await readWorkflow(VALIDATION);
  const jobs = walkJobs(doc, () => {});
  assert.ok(jobs['validate-inputs'], 'release-validation.yml must contain a validate-inputs gate job');
  assert.equal(jobs['validate-inputs']['runs-on'], 'ubuntu-24.04');
  const texts = runTextsOf(jobs['validate-inputs']);
  assert.ok(texts.length >= 1, 'validate-inputs must run validation logic');
  const gate = texts.join('\n');
  assert.ok(gate.includes('publish') && gate.includes('withdraw'), 'gate must reject unknown modes');
  assert.ok(gate.includes('[0-9a-f]{40}'), 'gate must require full 40-hex SHAs');
  assert.ok(gate.includes('exit 1'), 'gate must fail closed');
  // every dependent job waits for the gate
  for (const [jobId, job] of Object.entries(jobs)) {
    if (jobId === 'validate-inputs') continue;
    const needs = Array.isArray(job?.needs) ? job.needs : [job?.needs].filter(Boolean);
    assert.ok(needs.includes('validate-inputs'), `job ${jobId} must depend on validate-inputs`);
  }
});

test('release-validation.yml: top-level read-only permissions, no publish rights', async () => {
  const doc = await readWorkflow(VALIDATION);
  assert.equal(doc.permissions?.contents, 'read');
  assert.ok(doc.permissions?.contents !== 'write-all');
  walkJobs(doc, (jobId, job) => {
    const jobPerms = job?.permissions ?? {};
    for (const [scope, level] of Object.entries(jobPerms)) {
      if (scope === 'security-events') {
        assert.equal(level, 'write', `job ${jobId}: only security-events may be write`);
      } else {
        assert.notEqual(level, 'write', `job ${jobId}: scope ${scope} must not be write`);
      }
    }
    const inherited = { ...(doc.permissions ?? {}), ...jobPerms };
    assert.notEqual(inherited.contents, 'write', `job ${jobId}: must not gain contents write`);
    assert.equal(inherited.packages, undefined, `job ${jobId}: must not request packages scope at all`);
  });
});

test('release-validation.yml: full publish matrix present with exact platform/node jobs', async () => {
  const doc = await readWorkflow(VALIDATION);
  const jobs = doc.jobs ?? {};
  for (const jobId of PUBLISH_MATRIX_JOBS) {
    assert.ok(jobs[jobId], `release-validation.yml must contain matrix job ${jobId}`);
  }
  assert.equal(jobs['quality-security-ubuntu-node24']['runs-on'], 'ubuntu-24.04');
  assert.equal(jobs['native-windows-node24']['runs-on'], 'windows-latest');
  assert.equal(jobs['keyring-linux-windows-node24']['runs-on'], '${{ matrix.os }}');
  assert.deepEqual(jobs['keyring-linux-windows-node24'].strategy.matrix.os, ['ubuntu-latest', 'windows-latest']);
  assert.equal(jobs['codeql-ubuntu']['runs-on'], 'ubuntu-latest');
  assertNode24Consistent(doc, VALIDATION);
});

test('release-validation.yml: publish-mode jobs are gated on mode=publish, never floating', async () => {
  const doc = await readWorkflow(VALIDATION);
  const publishGated = [
    'quality-security-ubuntu-node24',
    'native-windows-node24',
    'native-linux-node24-selfhosted',
    'keyring-linux-windows-node24',
    'codeql-ubuntu',
    'docker-scope',
  ];
  for (const jobId of publishGated) {
    assert.equal(
      doc.jobs[jobId].if,
      "${{ inputs.mode == 'publish' }}",
      `job ${jobId} must run only for publish mode`,
    );
  }
  // regression jobs run for every dispatch
  for (const jobId of ['release-module-tests', 'governance-docs-skills', 'pinned-tree-equality']) {
    assert.equal(doc.jobs[jobId]?.if, undefined, `job ${jobId} must not be mode-gated`);
  }
  assert.equal(doc.jobs['validation-summary'].if, '${{ always() }}', 'summary must run for every dispatch (always)');
});

test('release-validation.yml: blocked platforms fail closed with explicit BLOCKED notes', async () => {
  const doc = await readWorkflow(VALIDATION);
  for (const [jobId, marker] of Object.entries(BLOCKED_JOBS)) {
    const job = doc.jobs[jobId];
    assert.ok(job, `blocked job ${jobId} must exist`);
    assert.equal(job.if, "${{ inputs.mode == 'publish' }}");
    const texts = runTextsOf(job).join('\n');
    assert.ok(texts.includes(marker), `job ${jobId} must carry explicit ${marker} note`);
    assert.ok(texts.includes('exit 1'), `job ${jobId} must fail closed`);
  }
});

test('release-validation.yml: summary records exact run/check identity evidence', async () => {
  const doc = await readWorkflow(VALIDATION);
  const summary = doc.jobs['validation-summary'];
  assert.ok(summary, 'release-validation.yml must contain validation-summary');
  assert.equal(summary.if, '${{ always() }}', 'summary must run even when matrix jobs fail');
  const needs = Array.isArray(summary.needs) ? summary.needs : [];
  for (const jobId of PUBLISH_MATRIX_JOBS) {
    assert.ok(needs.includes(jobId), `summary must need ${jobId}`);
  }
  const serialized = JSON.stringify(summary);
  const texts = runTextsOf(summary).join('\n');
  assert.ok(!texts.includes('${{'), 'summary run steps must not interpolate inputs into shell text');
  assert.ok(serialized.includes('github.run_id'), 'summary must reference github.run_id');
  assert.ok(JSON.stringify(summary).includes('github.run_attempt'), 'summary must reference github.run_attempt');
  const upload = summary.steps.find((step) => step?.uses === 'actions/upload-artifact@v6');
  assert.ok(upload, 'summary must upload evidence artifact');
  assert.ok(String(upload.with.path).includes('release-validation-evidence'), 'summary artifact must be named release-validation-evidence');
  assert.equal(upload.with['if-no-files-found'], 'error');
});

test('release-validation.yml: never runs publisher operations (read-only + tests only)', async () => {
  const doc = await readWorkflow(VALIDATION);
  walkJobs(doc, (jobId, job) => {
    for (const text of runTextsOf(job)) {
      assert.ok(!text.includes('scripts/release.mjs'), `job ${jobId} must not invoke the release CLI`);
      assert.ok(!text.includes('release-operations'), `job ${jobId} must not dispatch the operations workflow`);
    }
  });
});

test('release-operations.yml: single trusted writer surface with validated inputs', async () => {
  const doc = await readWorkflow(OPERATIONS);
  assertManualDispatchOnly(doc, OPERATIONS);
  const inputs = doc.on.workflow_dispatch.inputs;
  assert.equal(inputs['operation-id'].type, 'string');
  assert.equal(inputs['operation-id'].required, true);
  assert.equal(inputs.mode.type, 'choice');
  assert.deepEqual([...inputs.mode.options].sort(), ['publish', 'resume', 'rollback', 'status']);
});

test('release-operations.yml: one repository-level concurrency group, cancel-in-progress false', async () => {
  const doc = await readWorkflow(OPERATIONS);
  assert.ok(typeof doc.concurrency?.group === 'string' && doc.concurrency.group.length > 0, 'must declare a concurrency group');
  assert.equal(doc.concurrency['cancel-in-progress'], false);
});

test('release-operations.yml: finite job timeout', async () => {
  const doc = await readWorkflow(OPERATIONS);
  assertFiniteTimeouts(doc, OPERATIONS);
  assert.equal(doc.jobs.operate['timeout-minutes'], 60);
});

test('release-operations.yml: trusted minimal permissions — no write-all, only needed scopes', async () => {
  const doc = await readWorkflow(OPERATIONS);
  assert.deepEqual(doc.permissions, {
    contents: 'write',
    packages: 'write',
    actions: 'read',
  });
  assert.notEqual(doc.permissions.contents, 'write-all');
  walkJobs(doc, (jobId, job) => {
    assert.ok(!job?.permissions, `operate job must rely on workflow-level permissions`);
  });
});

test('release-operations.yml: CLI invocation passes untrusted inputs only as quoted argv via env', async () => {
  const doc = await readWorkflow(OPERATIONS);
  const operate = doc.jobs.operate;
  const step = stepsOf(operate).find((item) => typeof item?.run === 'string' && item.run.includes('scripts/release.mjs'));
  assert.ok(step, 'operate must invoke the release CLI');
  assert.equal(step.env.MODE, '${{ inputs.mode }}');
  assert.equal(step.env.OPERATION_ID, '${{ inputs.operation-id }}');
  assert.ok(step.run.includes('"$MODE"'), 'mode must be passed as a quoted argv word');
  assert.ok(step.run.includes('"$OPERATION_ID"'), 'operation-id must be passed as a quoted argv word');
  assert.ok(!step.run.includes('${{'), 'run must not interpolate workflow inputs into shell text');
  assert.ok(step.run.includes('--operation'), 'CLI must receive --operation');
});

test('release-operations.yml: outputs OperationReport and journal readback artifacts without secrets', async () => {
  const doc = await readWorkflow(OPERATIONS);
  assertNoSecretEnv(doc, OPERATIONS);
  assertNoShellInterpolation(doc, OPERATIONS);
  const uploads = stepsOf(doc.jobs.operate).filter((step) => step?.uses === 'actions/upload-artifact@v6');
  const paths = uploads.map((upload) => String(upload.with.path));
  assert.ok(paths.some((path) => path.includes('release-operation-report')), 'must upload the OperationReport');
  assert.ok(paths.some((path) => path.includes('release-operation-readback')), 'must upload the run identity readback');
  assert.ok(paths.some((path) => path.includes('ebb-release/operations')), 'must upload the journal readback');
  for (const upload of uploads) {
    assert.equal(upload.with['if-no-files-found'], 'warn');
  }
});

test('workflows: node versions consistent (24.x) across both trusted workflows', async () => {
  await assertNode24Consistent(await readWorkflow(VALIDATION), VALIDATION);
  await assertNode24Consistent(await readWorkflow(OPERATIONS), OPERATIONS);
});

test('workflows: finite timeouts on every job of both trusted workflows', async () => {
  await assertFiniteTimeouts(await readWorkflow(VALIDATION), VALIDATION);
  await assertFiniteTimeouts(await readWorkflow(OPERATIONS), OPERATIONS);
});

test('workflows: no shell interpolation or secret printing anywhere', async () => {
  await assertNoShellInterpolation(await readWorkflow(VALIDATION), VALIDATION);
  await assertNoShellInterpolation(await readWorkflow(OPERATIONS), OPERATIONS);
  await assertNoSecretEnv(await readWorkflow(VALIDATION), VALIDATION);
  await assertNoSecretEnv(await readWorkflow(OPERATIONS), OPERATIONS);
});

test('existing CI: production-gates/codeql/security-audit keep their contract (no second writer, no degradation)', async () => {
  const gates = await readWorkflow(PRODUCTION_GATES);
  assert.ok(gates.on.push.branches.includes('master') && gates.on.push.branches.includes('develop'), 'production-gates must keep push [master, develop]');
  assert.deepEqual(gates.on.pull_request.branches, ['develop']);
  assert.equal(gates.permissions?.contents, 'read');
  assert.equal(gates.concurrency, undefined, 'production-gates must not introduce a writer concurrency group');

  const codeql = await readWorkflow(CODEQL);
  assert.ok(codeql.on.push.branches.includes('master') && codeql.on.push.branches.includes('develop'));
  assert.deepEqual(codeql.on.pull_request.branches, ['develop']);
  assert.equal(codeql.jobs.analyze.steps.find((step) => step?.uses === 'github/codeql-action/init@v4').with['build-mode'], 'none', 'CodeQL must stay build-mode none');
  assert.equal(codeql.concurrency, undefined);

  const audit = await readWorkflow(AUDIT_FAILURE_PATHS);
  assert.ok(audit.on.workflow_dispatch.inputs.scenario.options.includes('upstream-failure'));
  assert.ok(audit.on.workflow_dispatch.inputs.scenario.options.includes('cancel-before-audit'));
  assert.equal(audit.concurrency, undefined);
});

test('blockers: no fake placeholder SHA or pending binding can pass as a bound writer', async () => {
  // Part 1 creates the executor surface only; the real identity binding happens
  // in Task8 part 2 and is verified by policy.mjs. Assert the workflows do not
  // claim a binding status or embed any SHA placeholder that could later be
  // mistaken for a pinned identity.
  for (const name of [VALIDATION, OPERATIONS]) {
    const doc = await readWorkflow(name);
    assert.equal(doc.bindingStatus, undefined, `${name} must not carry a config binding status`);
  }
});

test('input shapes: full-SHA fixture regex matches the gate guard', async () => {
  assert.ok(FULL_SHA_RE.test('a'.repeat(40)));
  assert.ok(!FULL_SHA_RE.test('a'.repeat(39)));
  assert.ok(!FULL_SHA_RE.test('g'.repeat(40)));
});
