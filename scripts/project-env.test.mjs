import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeProjectEnv, parseDotEnv } from './project-env.mjs';

test('parses a local dotenv file', () => {
  assert.deepEqual(parseDotEnv(`
# local provider credential
INCEPTION_API_KEY="from-file"
export HERMES_MODEL=mercury-2.5
EMPTY=
`), {
    INCEPTION_API_KEY: 'from-file',
    HERMES_MODEL: 'mercury-2.5',
    EMPTY: '',
  });
});

test('local dotenv values take precedence over stale inherited values', () => {
  const env = mergeProjectEnv(
    { INCEPTION_API_KEY: 'from-file', HERMES_MODEL: 'mercury-2.5' },
    { INCEPTION_API_KEY: 'stale-process-key', PATH: 'path' },
  );

  assert.deepEqual(env, {
    INCEPTION_API_KEY: 'from-file',
    HERMES_MODEL: 'mercury-2.5',
    PATH: 'path',
  });
});

test('ignores malformed lines and never treats comments as values', () => {
  assert.deepEqual(parseDotEnv('not an assignment\n# COMMENT=value\nINCEPTION_API_KEY=from-file'), {
    INCEPTION_API_KEY: 'from-file',
  });
});
