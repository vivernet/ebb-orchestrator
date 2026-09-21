#!/usr/bin/env node

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SMOKE_MARKER = 'HERMES_PROVIDER_SMOKE';
const SUCCESS_TOKEN = 'SMOKE_OK';
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Возвращает только environment keys, необходимые для disposable provider run.
 * Значение API key разрешено пройти в child process, но никогда не попадает в
 * результат, prompt или диагностический вывод этого harness.
 */
export function buildAllowlistedEnv(sourceEnv = process.env, secretEnvName = 'INCEPTION_API_KEY') {
  const allowedNames = new Set([
    'PATH',
    'Path',
    'PATHEXT',
    'SystemRoot',
    'WINDIR',
    'HOME',
    'USERPROFILE',
    'TEMP',
    'TMP',
    'TMPDIR',
    secretEnvName,
  ]);
  const result = {};
  for (const name of allowedNames) {
    if (typeof sourceEnv[name] === 'string') result[name] = sourceEnv[name];
  }
  result.HERMES_MODEL = 'inception';
  return result;
}

/** Возвращает единственный synthetic prompt без repository-derived context. */
export function buildSmokePrompt() {
  return `Reply with exactly: ${SUCCESS_TOKEN}`;
}

/** Классифицирует failure по безопасным категориям без возврата raw output. */
export function classifyProviderFailure(output, { timedOut = false } = {}) {
  if (timedOut) return 'TRANSPORT_FAILED';
  if (/\b401\b|unauthorized|authentication failed|invalid api key/i.test(output)) {
    return 'AUTH_FAILED';
  }
  if (/ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|timeout|connection|network|\b502\b|\b503\b|\b504\b/i.test(output)) {
    return 'TRANSPORT_FAILED';
  }
  return 'MODEL_FAILED';
}

function childOptions(env, cwd, timeoutMs) {
  return {
    cwd,
    env,
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    windowsHide: true,
  };
}

function isTimeout(result) {
  return result?.error?.code === 'ETIMEDOUT' || (result?.status === null && result?.signal);
}

function runChild(spawn, command, args, options) {
  const result = spawn(command, args, options);
  if (isTimeout(result)) return { kind: 'timeout', exitCode: 124 };
  if (result.error) return { kind: 'error', exitCode: 1 };
  return { kind: 'exit', exitCode: result.status ?? 1, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
}

function fixedResult(exitCode, marker, cleanupVerified) {
  return { exitCode, marker, redacted: true, cleanupVerified };
}

/**
 * Запускает provider smoke в пустом worktree и disposable HERMES_HOME.
 * Функция не выводит child stdout/stderr и не возвращает raw provider output.
 */
export function runProviderSmoke({
  sourceEnv = process.env,
  secretEnvName = 'INCEPTION_API_KEY',
  command = 'hermes',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  spawn = spawnSync,
} = {}) {
  if (!sourceEnv[secretEnvName]) return fixedResult(2, 'SMOKE_CONFIG_ERROR', true);

  const tempRoot = mkdtempSync(join(tmpdir(), 'hermes-provider-smoke-'));
  const workspace = join(tempRoot, 'workspace');
  const hermesHome = join(tempRoot, 'hermes-home');
  const promptFile = join(tempRoot, 'query.txt');
  mkdirSync(workspace);
  mkdirSync(hermesHome);

  const env = {
    ...buildAllowlistedEnv(sourceEnv, secretEnvName),
    HERMES_HOME: hermesHome,
    HERMES_MODEL: 'inception',
  };
  const options = childOptions(env, workspace, timeoutMs);
  let result = fixedResult(1, 'SMOKE_ERROR', false);

  try {
    const configuration = [
      ['config', 'set', 'providers.inception.api', 'https://api.inceptionlabs.ai/v1'],
      ['config', 'set', 'providers.inception.key_env', secretEnvName],
      ['config', 'set', 'model_aliases.inception.model', 'mercury-2'],
      ['config', 'set', 'model_aliases.inception.provider', 'custom:inception'],
    ];
    for (const args of configuration) {
      const setup = runChild(spawn, command, args, options);
      if (setup.kind === 'timeout') {
        result = fixedResult(124, 'SMOKE_TIMEOUT', false);
        return result;
      }
      if (setup.kind !== 'exit' || setup.exitCode !== 0) {
        result = fixedResult(1, 'SMOKE_CONFIG_ERROR', false);
        return result;
      }
    }

    writeFileSync(promptFile, buildSmokePrompt(), { encoding: 'utf8', mode: 0o600 });
    const smoke = runChild(
      spawn,
      command,
      ['--in', workspace, 'chat', '--query-file', promptFile],
      options,
    );
    if (smoke.kind === 'timeout') {
      result = fixedResult(124, classifyProviderFailure('', { timedOut: true }), false);
    } else if (smoke.kind !== 'exit') {
      result = fixedResult(1, 'SMOKE_ERROR', false);
    } else if (smoke.exitCode !== 0) {
      result = fixedResult(smoke.exitCode, classifyProviderFailure(smoke.output), false);
    } else if (smoke.output.includes(SUCCESS_TOKEN)) {
      result = fixedResult(0, SUCCESS_TOKEN, false);
    } else {
      result = fixedResult(1, 'MODEL_FAILED', false);
    }
    return result;
  } finally {
    try {
      rmSync(tempRoot, { recursive: true, force: true });
      result.cleanupVerified = !existsSync(tempRoot);
      if (!result.cleanupVerified) {
        result.exitCode = 1;
        result.marker = 'SMOKE_CLEANUP_FAILED';
      }
    } catch {
      result.exitCode = 1;
      result.marker = 'SMOKE_CLEANUP_FAILED';
      result.cleanupVerified = false;
    }
  }
}

function main() {
  const result = runProviderSmoke();
  process.stdout.write(
    `${SMOKE_MARKER} marker=${result.marker} exit_code=${result.exitCode} redacted=${result.redacted} cleanup_verified=${result.cleanupVerified}\n`,
  );
  process.exitCode = result.exitCode;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url || invokedPath === pathToFileURL(fileURLToPath(import.meta.url)).href) main();
