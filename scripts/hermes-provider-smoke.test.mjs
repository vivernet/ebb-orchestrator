import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAllowlistedEnv,
  buildSmokePrompt,
  classifyProviderFailure,
  runProviderSmoke,
} from './hermes-provider-smoke.mjs';

test('provider smoke environment is explicitly allowlisted', () => {
  const env = buildAllowlistedEnv({
    PATH: 'path',
    INCEPTION_API_KEY: 'secret',
    HERMES_MODEL: 'inception',
    NODE_OPTIONS: '--require=malicious',
    REPOSITORY_SECRET: 'do-not-forward',
  });

  assert.equal(env.PATH, 'path');
  assert.equal(env.INCEPTION_API_KEY, 'secret');
  assert.equal(env.HERMES_MODEL, 'inception');
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.REPOSITORY_SECRET, undefined);
});

test('smoke prompt is synthetic and contains no repository context handle', () => {
  const prompt = buildSmokePrompt();

  assert.equal(prompt, 'Reply with exactly: SMOKE_OK');
  assert.doesNotMatch(prompt, /\.hermes|plan|worktree|MCP|repository/i);
});

test('provider failures are reduced to fixed safe categories', () => {
  assert.equal(classifyProviderFailure('401 Unauthorized: secret'), 'AUTH_FAILED');
  assert.equal(classifyProviderFailure('ECONNRESET: secret'), 'TRANSPORT_FAILED');
  assert.equal(classifyProviderFailure('provider returned an unexpected answer'), 'MODEL_FAILED');
  assert.equal(classifyProviderFailure('raw output', { timedOut: true }), 'TRANSPORT_FAILED');
});

test('provider smoke uses an empty disposable workspace and cleans it up', () => {
  const calls = [];
  const result = runProviderSmoke({
    sourceEnv: { PATH: 'path', INCEPTION_API_KEY: 'secret' },
    timeoutMs: 100,
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: args.includes('--query-file') ? 'SMOKE_OK' : '', stderr: '' };
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.marker, 'SMOKE_OK');
  assert.equal(result.redacted, true);
  assert.equal(result.cleanupVerified, true);
  assert.equal(calls.length, 5);
  assert.deepEqual(calls[2].args, [
    'config',
    'set',
    'model_aliases.inception.model',
    'mercury-2',
  ]);

  const smokeCall = calls.at(-1);
  assert.equal(smokeCall.command, 'hermes');
  assert.deepEqual(smokeCall.args.slice(0, 3), ['--in', smokeCall.args[1], 'chat']);
  assert.equal(smokeCall.options.shell, false);
  assert.equal(smokeCall.options.timeout, 100);
  assert.equal(smokeCall.options.env.INCEPTION_API_KEY, 'secret');
  assert.equal(smokeCall.options.env.REPOSITORY_SECRET, undefined);
  assert.match(smokeCall.args.at(-1), /hermes-provider-smoke-/);
});

test('provider smoke converts hard timeout to fixed redacted result', () => {
  const result = runProviderSmoke({
    sourceEnv: { PATH: 'path', INCEPTION_API_KEY: 'secret' },
    timeoutMs: 25,
    spawn: (_command, args) => ({
      status: args.includes('--query-file') ? null : 0,
      stdout: 'secret raw provider response',
      stderr: '',
      error: args.includes('--query-file') ? { code: 'ETIMEDOUT' } : undefined,
    }),
  });

  assert.equal(result.exitCode, 124);
  assert.equal(result.marker, 'TRANSPORT_FAILED');
  assert.equal(result.redacted, true);
  assert.equal(result.cleanupVerified, true);
});

test('provider auth failure exposes no raw child output', () => {
  const result = runProviderSmoke({
    sourceEnv: { PATH: 'path', INCEPTION_API_KEY: 'secret' },
    spawn: (_command, args) => ({
      status: args.includes('--query-file') ? 1 : 0,
      stdout: args.includes('--query-file') ? '401 Unauthorized secret' : '',
      stderr: '',
    }),
  });

  assert.deepEqual(result, {
    exitCode: 1,
    marker: 'AUTH_FAILED',
    redacted: true,
    cleanupVerified: true,
  });
});
