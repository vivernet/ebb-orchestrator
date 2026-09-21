import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseConfigTimeout,
  resolveHermesHome,
  runSetupWithSync,
  runHermesConfig,
  syncHermesAssets,
} from './hermes-dev.mjs';

test('Hermes home honors an explicit environment override', () => {
  assert.equal(
    resolveHermesHome({ HERMES_HOME: 'D:/hermes' }, 'win32', 'C:/Users/alex'),
    'D:/hermes',
  );
});

test('Hermes home follows the Windows LOCALAPPDATA convention', () => {
  assert.equal(
    resolveHermesHome({ LOCALAPPDATA: 'C:/Users/alex/AppData/Local' }, 'win32', 'C:/Users/alex'),
    'C:\\Users\\alex\\AppData\\Local\\hermes',
  );
});

test('Hermes home follows the POSIX home convention', () => {
  assert.equal(resolveHermesHome({}, 'linux', '/home/alex'), '/home/alex/.hermes');
});

test('Hermes config timeout has a bounded safe default', () => {
  assert.equal(parseConfigTimeout('invalid'), 30_000);
  assert.equal(parseConfigTimeout('0'), 30_000);
  assert.equal(parseConfigTimeout('25'), 25);
});

test('Hermes config runner preserves command semantics with safe spawn options', async () => {
  let invocation;
  const child = new EventEmitter();
  child.pid = 1234;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  const resultPromise = runHermesConfig(['set', 'delegation.max_concurrent_children', '2'], {
    timeoutMs: 100,
    spawnChild: (command, args, options) => {
      invocation = { command, args, options };
      process.nextTick(() => child.emit('close', 0));
      return child;
    },
  });
  const result = await resultPromise;

  assert.deepEqual(result, {
    ok: true,
    exitCode: 0,
    timedOut: false,
    terminationFailed: false,
    marker: 'COMPLETED',
    stdout: '',
  });
  assert.deepEqual(invocation.args, ['config', 'set', 'delegation.max_concurrent_children', '2']);
  assert.equal(invocation.command, 'hermes');
  assert.equal(invocation.options.shell, false);
  assert.deepEqual(invocation.options.stdio, ['ignore', 'pipe', 'pipe']);
});

test('Hermes config runner terminates a hanging child and returns no raw output', async () => {
  const child = new EventEmitter();
  child.pid = 9876;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  const termination = [];
  const result = await runHermesConfig(['set', 'delegation.max_concurrent_children', '2'], {
    timeoutMs: 5,
    spawnChild: () => child,
    terminate: (pid, platformName) => {
      termination.push({ pid, platformName });
      return { ok: true };
    },
  });

  assert.deepEqual(result, {
    ok: false,
    exitCode: 124,
    timedOut: true,
    terminationFailed: false,
    marker: 'TIMEOUT',
    stdout: '',
  });
  assert.deepEqual(termination, [{ pid: 9876, platformName: process.platform }]);
});

test('Hermes config timeout reports termination failure without claiming cleanup', async () => {
  const child = new EventEmitter();
  child.pid = 1111;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};

  const result = await runHermesConfig(['set', 'delegation.max_concurrent_children', '2'], {
    timeoutMs: 5,
    spawnChild: () => child,
    terminate: () => ({ ok: false }),
  });

  assert.deepEqual(result, {
    ok: false,
    exitCode: 125,
    timedOut: true,
    terminationFailed: true,
    marker: 'TERMINATION_FAILED',
    stdout: '',
  });
});

test('Hermes setup syncs canonical assets and verifies target hashes', () => {
  const root = mkdtempSync(join(tmpdir(), 'hermes-sync-test-'));
  const source = join(root, 'source');
  const home = join(root, 'home');
  const skill = join(source, 'tools', 'hermes', 'skills', 'demo');
  const providers = join(source, 'tools', 'hermes', 'providers');
  try {
    mkdirSync(skill, { recursive: true });
    mkdirSync(providers, { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), 'name: demo\n', 'utf8');
    writeFileSync(join(providers, 'inception.yaml'), 'model: mercury-2\n', 'utf8');
    writeFileSync(join(source, 'tools', 'hermes', 'capabilities.yaml'), 'version: 1\n', 'utf8');

    const result = syncHermesAssets(source, home);

    assert.equal(result.verified, true);
    assert.equal(readFileSync(join(home, 'providers', 'ebb-orchestrator', 'inception.yaml'), 'utf8'), 'model: mercury-2\n');
    assert.equal(readFileSync(join(home, 'capabilities.yaml'), 'utf8'), 'version: 1\n');
    assert.equal(readFileSync(join(home, 'skills', 'ebb-orchestrator', 'demo', 'SKILL.md'), 'utf8'), 'name: demo\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Hermes setup syncs assets after config timeout and preserves failure code', async () => {
  let synced = false;
  const failure = Object.assign(new Error(), { code: 'HERMES_CONFIG_TIMEOUT' });

  await assert.rejects(
    runSetupWithSync({
      configure: () => { throw failure; },
      sync: () => {
        synced = true;
        return { verified: true };
      },
    }),
    (error) => error === failure,
  );
  assert.equal(synced, true);
});
