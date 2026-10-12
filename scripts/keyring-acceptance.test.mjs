import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as yaml from 'js-yaml';

const root = resolve(import.meta.dirname, '..');

test('production gates run a credential-free real keyring smoke on Windows and Ubuntu', () => {
  const workflow = yaml.load(
    readFileSync(resolve(root, '.github/workflows/production-gates.yml'), 'utf8'),
    { schema: yaml.JSON_SCHEMA },
  );
  const job = workflow.jobs?.['keyring-acceptance'];

  assert.ok(job, 'production workflow must define a separate keyring acceptance job');
  assert.deepEqual(
    job.strategy?.matrix?.include?.map((entry) => entry.os),
    ['ubuntu-latest', 'windows-latest'],
    'keyring acceptance must exercise Ubuntu and Windows runners',
  );
  assert.ok(
    job.steps?.some((step) => step.run === 'node --test scripts/keyring-acceptance.test.mjs'),
    'matrix job must validate its own workflow contract',
  );
  assert.ok(
    job.steps?.some((step) => step.run === 'pnpm exec tsx apps/server/scripts/keyring-smoke.ts'),
    'matrix job must run the real KeyringSecretStore acceptance script',
  );
  const projectConfigSteps = (job.steps ?? [])
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step.run === 'pnpm plan06:project-config:acceptance');
  assert.equal(projectConfigSteps.length, 1, 'keyring matrix must define exactly one Project Config acceptance step');
  const keyringStepIndex = job.steps?.findIndex(
    (step) => step.run === 'pnpm exec tsx apps/server/scripts/keyring-smoke.ts',
  ) ?? -1;
  assert.ok(
    projectConfigSteps[0].index > keyringStepIndex,
    'Project Config acceptance must run after the real OS keyring acceptance',
  );
  assert.equal(
    projectConfigSteps[0].step.if,
    "${{ matrix.os == 'ubuntu-latest' }}",
    'Project Config acceptance must run only on Ubuntu',
  );
  const allProjectConfigCommands = Object.values(workflow.jobs ?? {})
    .flatMap((workflowJob) => workflowJob.steps ?? [])
    .filter((step) => step.run === 'pnpm plan06:project-config:acceptance');
  assert.equal(allProjectConfigCommands.length, 1, 'workflow must not launch Project Config acceptance elsewhere');
  assert.doesNotMatch(JSON.stringify(job), /\$\{\{\s*secrets\./i, 'keyring smoke must not receive provider secrets');
});
