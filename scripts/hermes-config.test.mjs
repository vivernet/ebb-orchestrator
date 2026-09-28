import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL } from 'node:url';

import {
  parseConfigTimeout,
  resolveHermesHome,
  runHermesProjectSetup,
  runHermesConfig,
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

test('Hermes setup preserves a disposable profile without copying project assets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hermes-config-test-'));
  const home = join(root, 'home');
  const previousHome = process.env.HERMES_HOME;
  try {
    process.env.HERMES_HOME = home;
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'sentinel'), 'preserved\n');
    await runHermesProjectSetup({
      worktreeRoot: root,
      run: () => ({ status: 0 }),
      configure: async () => {},
    });
    assert.deepEqual(readdirSync(home), ['sentinel']);
    assert.equal(readFileSync(join(home, 'sentinel'), 'utf8'), 'preserved\n');
    const script = readFileSync(new URL('./hermes-dev.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(script, /copyFileSync|createHash|sha256|skills\.create_dir/);
  } finally {
    if (previousHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test('Hermes project setup preserves config failure and only invokes project trust', async () => {
  const calls = [];
  const failure = Object.assign(new Error(), { code: 'HERMES_CONFIG_TIMEOUT' });

  await assert.rejects(
    runHermesProjectSetup({
      worktreeRoot: '/disposable/project',
      run: (command, args) => { calls.push([command, args]); return { status: 0 }; },
      configure: () => { throw failure; },
    }),
    (error) => error === failure,
  );
  assert.deepEqual(calls, [
    ['hermes', ['skills', 'trust', '--help']],
    ['hermes', ['skills', 'trust', '/disposable/project']],
  ]);
});

test('Hermes check only reads supported configuration and setup retains supported keys', () => {
  const script = readFileSync(new URL('./hermes-dev.mjs', import.meta.url), 'utf8');
  const setup = script.slice(script.indexOf('async function doSetup()'), script.indexOf('async function doCheck()'));
  const check = script.slice(script.indexOf('async function doCheck()'), script.indexOf('async function doExecute('));
  for (const key of ['delegation.max_concurrent_children', 'delegation.max_spawn_depth', 'delegation.orchestrator_enabled', 'skills.project_discovery']) {
    assert.ok(setup.includes(key), key);
    assert.ok(check.includes(key), key);
  }
  assert.match(check, /skills\.trusted_project_dirs/);
  assert.doesNotMatch(check, /hermesConfigSet|writeFileSync|mkdirSync|rmSync|copyFileSync/);
  assert.doesNotMatch(script, /providers\.|doProvider|skills\.create_dir|delegation\.worktree_isolation/);
});
