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
  assert.doesNotMatch(JSON.stringify(job), /\$\{\{\s*secrets\./i, 'keyring smoke must not receive provider secrets');
});
