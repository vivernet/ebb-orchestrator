import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';

import { signalExitCode } from './run-server.js';

const root = resolve(import.meta.dirname, '..');
const launcher = resolve(root, 'scripts', 'run-server.js');

test('run-server launcher parses without starting a server', () => {
  const result = spawnSync(process.execPath, ['--check', launcher], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });

  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
});

test('signalExitCode maps POSIX signals to 128 + signum', () => {
  assert.equal(signalExitCode('SIGINT'), 130);
  assert.equal(signalExitCode('SIGTERM'), 143);
  assert.equal(signalExitCode('SIGHUP'), 129);
  assert.equal(signalExitCode('SIGKILL'), 137);
});

test('signalExitCode falls back to 1 for unknown or empty signals', () => {
  assert.equal(signalExitCode(null), 1);
  assert.equal(signalExitCode(undefined), 1);
  assert.equal(signalExitCode('SIGUNKNOWN'), 1);
  assert.equal(signalExitCode(''), 1);
});
