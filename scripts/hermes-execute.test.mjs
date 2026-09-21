import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseExecuteTimeout,
  runHermesExecute,
  terminateHermesProcessTree,
} from './hermes-dev.mjs';

function fakeChild({ pid = 4321 } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  return child;
}

function disposableTempDir() {
  return mkdtempSync(join(tmpdir(), 'hermes-execute-test-'));
}

test('execute timeout has a safe default and rejects invalid overrides', () => {
  assert.equal(parseExecuteTimeout('invalid'), 300_000);
  assert.equal(parseExecuteTimeout('0'), 300_000);
  assert.equal(parseExecuteTimeout('25'), 25);
});

test('execute normal exit returns fixed redacted marker and cleans prompt', async () => {
  const tempDir = disposableTempDir();
  const child = fakeChild();
  let spawnOptions;
  try {
    const resultPromise = runHermesExecute({
      worktreeRoot: tempDir,
      planPath: 'tools/hermes/fixtures/parity-plan.md',
      tmpDir: tempDir,
      timeoutMs: 100,
      spawnChild: (_command, args, options) => {
        spawnOptions = { args, options };
        process.nextTick(() => child.emit('close', 0));
        return child;
      },
    });
    const result = await resultPromise;

    assert.deepEqual(result, {
      exitCode: 0,
      marker: 'COMPLETED',
      redacted: true,
      cleanupVerified: true,
    });
    assert.equal(spawnOptions.options.shell, false);
    assert.deepEqual(spawnOptions.options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(readdirSync(tempDir).length, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('execute timeout terminates the Windows process tree and never returns child output', async () => {
  const tempDir = disposableTempDir();
  const child = fakeChild({ pid: 9876 });
  const termination = [];
  try {
    const result = await runHermesExecute({
      worktreeRoot: tempDir,
      planPath: 'plan.md',
      tmpDir: tempDir,
      timeoutMs: 5,
      spawnChild: () => child,
      terminate: (pid, platformName) => {
        termination.push({ pid, platformName });
        return { ok: true };
      },
    });

    assert.deepEqual(result, {
      exitCode: 124,
      marker: 'TIMEOUT',
      redacted: true,
      cleanupVerified: true,
    });
    assert.deepEqual(termination, [{ pid: 9876, platformName: process.platform }]);
    assert.equal(readdirSync(tempDir).length, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Windows termination uses taskkill tree and force flags', () => {
  const calls = [];
  const result = terminateHermesProcessTree(1234, 'win32', (...args) => {
    calls.push(args);
    return { status: 0 };
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [[
    'taskkill.exe',
    ['/PID', '1234', '/T', '/F'],
    { shell: false, stdio: 'ignore', windowsHide: true },
  ]]);
});

test('Windows termination failure is reported instead of claiming tree termination', () => {
  const result = terminateHermesProcessTree(1234, 'win32', () => ({ status: 1 }));

  assert.deepEqual(result, { ok: false });
});
