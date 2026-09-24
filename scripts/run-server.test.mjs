import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';

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
