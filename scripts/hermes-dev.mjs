#!/usr/bin/env node

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { existsSync, rmSync, mkdirSync, copyFileSync, readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, posix, win32 } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { clearTimeout, setTimeout } from 'node:timers';
import { resolvePlanPath } from './hermes-dev-paths.mjs';
import { loadProjectEnv } from './project-env.mjs';

export const HERMES_EXECUTE_MARKER = 'HERMES_EXECUTE';
export const HERMES_CONFIG_MARKER = 'HERMES_CONFIG';
const DEFAULT_EXECUTE_TIMEOUT_MS = 300_000;
const DEFAULT_CONFIG_TIMEOUT_MS = 30_000;

export function resolveHermesHome(env = process.env, platformName = platform(), home = homedir()) {
  if (env.HERMES_HOME) return env.HERMES_HOME;
  const pathJoin = platformName === 'win32' ? win32.join : posix.join;
  if (platformName === 'win32' && env.LOCALAPPDATA) return pathJoin(env.LOCALAPPDATA, 'hermes');
  return pathJoin(home, '.hermes');
}

export function parseConfigTimeout(value = process.env.HERMES_CONFIG_TIMEOUT_MS) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return DEFAULT_CONFIG_TIMEOUT_MS;
  return parsed;
}

export function runHermesConfig(args, {
  spawnChild = spawn,
  terminate = terminateHermesProcessTree,
  timeoutMs = parseConfigTimeout(),
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    let stdout = '';
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    let child;
    try {
      child = spawnChild('hermes', ['config', ...args], {
        encoding: 'utf8',
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
      child.stderr?.on('data', () => {});
      child.once('error', () => finish({ ok: false, exitCode: 1, timedOut: false, terminationFailed: false, marker: 'FAILED', stdout: '' }));
      child.once('close', (code) => finish({
        ok: code === 0,
        exitCode: code === 0 ? 0 : (code ?? 1),
        timedOut: false,
        terminationFailed: false,
        marker: code === 0 ? 'COMPLETED' : 'FAILED',
        stdout: code === 0 ? stdout.trim() : '',
      }));
      timer = setTimeout(() => {
        let termination;
        try { termination = terminate(child.pid, platform()); } catch { termination = { ok: false }; }
        try { child.kill(); } catch { /* child may already be gone */ }
        const terminated = termination?.ok === true;
        finish({
          ok: false,
          exitCode: terminated ? 124 : 125,
          timedOut: true,
          terminationFailed: !terminated,
          marker: terminated ? 'TIMEOUT' : 'TERMINATION_FAILED',
          stdout: '',
        });
      }, timeoutMs);
    } catch {
      finish({ ok: false, exitCode: 1, timedOut: false, terminationFailed: false, marker: 'FAILED', stdout: '' });
    }
  });
}

async function hermesConfigSet(key, value) {
  const result = await runHermesConfig(['set', key, value]);
  if (!result.ok) {
    const error = new Error();
    error.code = result.terminationFailed
      ? 'HERMES_CONFIG_TERMINATION_FAILED'
      : result.timedOut ? 'HERMES_CONFIG_TIMEOUT' : 'HERMES_CONFIG_FAILED';
    throw error;
  }
}

async function hermesConfigGet(key) {
  const result = await runHermesConfig(['get', key]);
  return result.ok ? result.stdout : null;
}

function sha256(path) {
  const content = readFileSync(path);
  return createHash('sha256').update(content).digest('hex');
}

function throwSyncFailure() {
  const error = new Error();
  error.code = 'HERMES_SYNC_FAILED';
  throw error;
}

export function syncHermesAssets(worktreeRoot, hermesHome) {
  const sourceSkills = join(worktreeRoot, 'tools', 'hermes', 'skills');
  const targetRoot = join(hermesHome, 'skills', 'ebb-orchestrator');
  const sourceProviders = join(worktreeRoot, 'tools', 'hermes', 'providers');
  const targetProviders = join(hermesHome, 'providers', 'ebb-orchestrator');
  const sourceCapabilities = join(worktreeRoot, 'tools', 'hermes', 'capabilities.yaml');
  const targetCapabilities = join(hermesHome, 'capabilities.yaml');

  if (statSync(targetRoot, { throwIfNoEntry: false })) rmSync(targetRoot, { recursive: true, force: true });
  mkdirSync(targetRoot, { recursive: true });
  for (const dir of readdirSync(sourceSkills)) {
    const sourceDir = join(sourceSkills, dir);
    if (!statSync(sourceDir).isDirectory()) continue;
    const targetDir = join(targetRoot, dir);
    mkdirSync(targetDir, { recursive: true });
    for (const file of readdirSync(sourceDir)) {
      const sourcePath = join(sourceDir, file);
      const targetPath = join(targetDir, file);
      if (statSync(sourcePath).isFile()) copyFileSync(sourcePath, targetPath);
    }
  }

  if (statSync(targetProviders, { throwIfNoEntry: false })) rmSync(targetProviders, { recursive: true, force: true });
  mkdirSync(targetProviders, { recursive: true });
  for (const file of readdirSync(sourceProviders)) {
    const sourcePath = join(sourceProviders, file);
    if (statSync(sourcePath).isFile()) copyFileSync(sourcePath, join(targetProviders, file));
  }
  copyFileSync(sourceCapabilities, targetCapabilities);

  const verifyFile = (sourcePath, targetPath) => {
    if (!statSync(sourcePath, { throwIfNoEntry: false }) || !statSync(targetPath, { throwIfNoEntry: false })) {
      throwSyncFailure();
    }
    if (sha256(sourcePath) !== sha256(targetPath)) throwSyncFailure();
  };
  for (const dir of readdirSync(sourceSkills)) {
    const sourceDir = join(sourceSkills, dir);
    if (!statSync(sourceDir).isDirectory()) continue;
    for (const file of readdirSync(sourceDir)) {
      const sourcePath = join(sourceDir, file);
      if (statSync(sourcePath).isFile()) verifyFile(sourcePath, join(targetRoot, dir, file));
    }
  }
  for (const file of readdirSync(sourceProviders)) {
    const sourcePath = join(sourceProviders, file);
    if (statSync(sourcePath).isFile()) verifyFile(sourcePath, join(targetProviders, file));
  }
  verifyFile(sourceCapabilities, targetCapabilities);
  return { verified: true };
}

export async function runSetupWithSync({ configure, sync }) {
  let configFailure;
  try {
    await configure();
  } catch (error) {
    configFailure = error;
  }

  let syncFailure;
  let syncResult;
  try {
    syncResult = await sync();
  } catch (error) {
    syncFailure = error;
  }

  if (configFailure) throw configFailure;
  if (syncFailure) throw syncFailure;
  return syncResult;
}

export function parseExecuteTimeout(value = process.env.HERMES_EXECUTE_TIMEOUT_MS) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return DEFAULT_EXECUTE_TIMEOUT_MS;
  return parsed;
}

export function terminateHermesProcessTree(pid, platformName = platform(), run = spawnSync) {
  if (!pid) return { ok: false };
  if (platformName === 'win32') {
    const result = run('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    });
    return { ok: !result?.error && result?.status === 0 };
  }
  try {
    process.kill(pid, 'SIGTERM');
    return { ok: true };
  } catch {
    // Процесс мог завершиться между timeout и попыткой termination.
    return { ok: false };
  }
}

function fixedExecuteResult(exitCode, marker, cleanupVerified) {
  return { exitCode, marker, redacted: true, cleanupVerified };
}

export async function runHermesExecute({
  worktreeRoot,
  planPath,
  tmpDir = process.env.TEMP || process.env.TMPDIR || join(homedir(), 'tmp'),
  timeoutMs = parseExecuteTimeout(),
  spawnChild = spawn,
  terminate = terminateHermesProcessTree,
  write = writeFileSync,
  remove = rmSync,
  exists = existsSync,
  makeDirectory = mkdirSync,
  now = Date.now,
} = {}) {
  const tmpFile = join(tmpDir, `hermes-prompt-${now()}.txt`);
  let result = fixedExecuteResult(1, 'SPAWN_ERROR', false);
  makeDirectory(tmpDir, { recursive: true });

  try {
    const promptContent = `You are executing trusted Ebb Orchestrator development work.

Read .hermes.md for project instructions.
Use ebb-execute-plan skill to execute the plan.
Plan path: ${planPath}
EXECUTE the plan, do not only summarize.
Max 2 concurrent subagents.
No nested delegation.
`;
    write(tmpFile, promptContent);

    result = await new Promise((resolve) => {
      let settled = false;
      let timer;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(value);
      };

      let child;
      try {
        child = spawnChild('hermes', [
          '--in', worktreeRoot,
          'chat',
          '--query-file',
          tmpFile,
        ], {
          cwd: worktreeRoot,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
          windowsHide: true,
        });
        child.stdout?.on('data', () => {});
        child.stderr?.on('data', () => {});
        child.once('error', () => finish(fixedExecuteResult(1, 'SPAWN_ERROR', false)));
        child.once('close', (code) => {
          finish(fixedExecuteResult(code === 0 ? 0 : (code ?? 1), code === 0 ? 'COMPLETED' : 'FAILED', false));
        });
        timer = setTimeout(() => {
          let termination;
          try { termination = terminate(child.pid, platform()); } catch { termination = { ok: false }; }
          try { child.kill(); } catch { /* child may already be gone */ }
          finish(fixedExecuteResult(termination?.ok === true ? 124 : 125, termination?.ok === true ? 'TIMEOUT' : 'TERMINATION_FAILED', false));
        }, timeoutMs);
      } catch {
        finish(fixedExecuteResult(1, 'SPAWN_ERROR', false));
      }
    });
  } finally {
    try {
      remove(tmpFile, { force: true });
      result.cleanupVerified = !exists(tmpFile);
      if (!result.cleanupVerified) {
        result.exitCode = 1;
        result.marker = 'CLEANUP_FAILED';
      }
    } catch {
      result.exitCode = 1;
      result.marker = 'CLEANUP_FAILED';
      result.cleanupVerified = false;
    }
  }
  return result;
}

async function main() {
  Object.assign(process.env, loadProjectEnv({
    envFilePath: join(dirname(fileURLToPath(import.meta.url)), '..', '.env'),
  }));
  const command = process.argv[2];
  if (!command) {
    console.error('Usage: hermes-dev.js <setup|check|provider|execute> [args...]');
    process.exit(1);
  }

  switch (command) {
    case 'setup':
      await doSetup();
      break;
    case 'check':
      await doCheck();
      break;
    case 'provider':
      await doProvider(process.argv.slice(3));
      break;
    case 'execute':
      await doExecute(process.argv.slice(3));
      break;
    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}

async function doSetup() {
  console.log('Setting up Hermes development environment...');

  // 0. Run docs inventory and check for governance integration
  console.log('Running documentation governance checks...');
  const docsInventory = spawnSync('node', ['scripts/docs-governance.mjs', 'inventory'], { encoding: 'utf8' });
  const docsCheck = spawnSync('node', ['scripts/docs-governance.mjs', 'check'], { encoding: 'utf8' });
  const docsLinkSync = spawnSync('node', ['scripts/docs-governance.mjs', 'link:sync'], { encoding: 'utf8' });
  const docsRenameCheck = spawnSync('node', ['scripts/docs-governance.mjs', 'rename:check'], { encoding: 'utf8' });
  if (docsInventory.status !== 0 || docsCheck.status !== 0 || docsLinkSync.status !== 0 || docsRenameCheck.status !== 0) {
    console.error('Documentation checks failed:');
    console.error(docsInventory.stdout || docsInventory.stderr);
    console.error(docsCheck.stdout || docsCheck.stderr);
    console.error(docsLinkSync.stdout || docsLinkSync.stderr);
    console.error(docsRenameCheck.stdout || docsRenameCheck.stderr);
    process.exit(1);
  }

  // 1. Получаем корень Git worktree.
  const gitResult = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (gitResult.status !== 0) {
    console.error('Not in a Git repository');
    process.exit(1);
  }
  const worktreeRoot = gitResult.stdout.trim();

  // 2. Определяем HERMES_HOME.
  const hermesHome = resolveHermesHome();

  // Сначала настраиваем Hermes: CLI может переписать profile при первом config set.
  // Даже при failure config canonical assets всё равно должны быть синхронизированы.
  console.log('Configuring Hermes...');
  const sync = await runSetupWithSync({
    configure: async () => {
      await hermesConfigSet('delegation.max_concurrent_children', '2');
      await hermesConfigSet('delegation.max_spawn_depth', '1');
      await hermesConfigSet('delegation.orchestrator_enabled', 'false');
      await hermesConfigSet('delegation.worktree_isolation', 'false');
    },
    sync: () => syncHermesAssets(worktreeRoot, hermesHome),
  });
  console.log(`${HERMES_CONFIG_MARKER} marker=SETUP_SYNCED verified=${sync.verified} redacted=true`);

  console.log('Setup complete.');
}

async function doCheck() {
  console.log('Checking Hermes development environment...');

  const checks = [];
  let allPass = true;
  const hermesHome = resolveHermesHome();

  // 1. Проверяем hermes --version.
  try {
    execFileSync('hermes', ['--version'], { stdio: 'pipe' });
    checks.push({ name: 'hermes --version', pass: true });
  } catch {
    checks.push({ name: 'hermes --version', pass: false });
    allPass = false;
  }

  // 2. Проверяем наличие .hermes.md.
  const hermesMdPath = join(process.cwd(), '.hermes.md');
  checks.push({
    name: '.hermes.md exists',
    pass: statSync(hermesMdPath, { throwIfNoEntry: false }) !== undefined
  });
  if (!checks[1].pass) allPass = false;

  // 3-6. Проверяем наличие исходных skill-файлов.
  const sourceSkills = join(process.cwd(), 'tools', 'hermes', 'skills');
  const skills = readdirSync(sourceSkills).filter((entry) => statSync(join(sourceSkills, entry)).isDirectory()).sort();
  for (const skill of skills) {
    const path = join(sourceSkills, skill, 'SKILL.md');
    const pass = statSync(path, { throwIfNoEntry: false }) !== undefined;
    checks.push({ name: `Source: ${skill}`, pass });
    if (!pass) allPass = false;
  }

  const sourceCapabilities = join(process.cwd(), 'tools', 'hermes', 'capabilities.yaml');
  const targetCapabilities = join(hermesHome, 'capabilities.yaml');
  const capabilitiesMatch = statSync(sourceCapabilities, { throwIfNoEntry: false }) !== undefined
    && statSync(targetCapabilities, { throwIfNoEntry: false }) !== undefined
    && sha256(sourceCapabilities) === sha256(targetCapabilities);
  checks.push({ name: 'Capabilities registry match', pass: capabilitiesMatch });
  if (!capabilitiesMatch) allPass = false;

  const sourceProviders = join(process.cwd(), 'tools', 'hermes', 'providers');
  const targetProviders = join(hermesHome, 'providers', 'ebb-orchestrator');
  for (const provider of readdirSync(sourceProviders).filter((entry) => entry.endsWith('.yaml')).sort()) {
    const sourcePath = join(sourceProviders, provider);
    const targetPath = join(targetProviders, provider);
    const providerMatch = statSync(sourcePath, { throwIfNoEntry: false }) !== undefined
      && statSync(targetPath, { throwIfNoEntry: false }) !== undefined
      && sha256(sourcePath) === sha256(targetPath);
    checks.push({ name: `Provider match: ${provider}`, pass: providerMatch });
    if (!providerMatch) allPass = false;
  }

  // 7-10. Проверяем наличие target skill-файлов и совпадение hash.
  const targetRoot = join(hermesHome, 'skills', 'ebb-orchestrator');
  for (const skill of skills) {
    const sourcePath = join(sourceSkills, skill, 'SKILL.md');
    const targetPath = join(targetRoot, skill, 'SKILL.md');
    const sourceExists = statSync(sourcePath, { throwIfNoEntry: false }) !== undefined;
    const targetExists = statSync(targetPath, { throwIfNoEntry: false }) !== undefined;
    const hashMatch = sourceExists && targetExists && sha256(sourcePath) === sha256(targetPath);
    checks.push({ name: `Target match: ${skill}`, pass: hashMatch });
    if (!hashMatch) allPass = false;
  }

  // 11-14. Проверяем конфигурацию Hermes.
  const configChecks = [
    ['delegation.max_concurrent_children', '2'],
    ['delegation.max_spawn_depth', '1'],
    ['delegation.orchestrator_enabled', 'false'],
    ['delegation.worktree_isolation', 'false']
  ];
  for (const [key, expected] of configChecks) {
    const value = await hermesConfigGet(key);
    checks.push({ name: `Config: ${key}`, pass: value === expected });
    if (value !== expected) allPass = false;
  }

  // Выводим результаты.
  console.log('');
  console.log('Check results:');
  for (const check of checks) {
    console.log(`  ${check.pass ? 'PASS' : 'FAIL'}: ${check.name}`);
  }

  if (!allPass) {
    console.log('');
    console.log(`${HERMES_CONFIG_MARKER} marker=CHECK_FAILED exit_code=1 redacted=true`);
    console.log('Some checks failed. Run `pnpm hermes:setup` to fix.');
    process.exit(1);
  }
  console.log('');
  console.log('All checks passed.');
}

async function doProvider(args) {
  const provider = args.filter((arg) => arg !== '--')[0];
  if (provider !== 'inception') {
    console.error('Usage: hermes-dev.js provider inception');
    process.exit(1);
  }

  // Hermes получает secret по имени env key; значение API key не читается и не печатается.
  await hermesConfigSet('providers.inception.api', 'https://api.inceptionlabs.ai/v1');
  await hermesConfigSet('providers.inception.base_url', 'https://api.inceptionlabs.ai/v1');
  await hermesConfigSet('providers.inception.key_env', 'INCEPTION_API_KEY');
  await hermesConfigSet('providers.inception.model', 'mercury-2.5');
  await hermesConfigSet('model.default', 'mercury-2.5');
  await hermesConfigSet('model.provider', 'inception');
  await hermesConfigSet('model.api_mode', 'chat_completions');
  console.log('Provider profile inception configured. Set INCEPTION_API_KEY in the local environment.');
  console.log('Use HERMES_MODEL=inception for an explicit Hermes development run.');
}

async function doExecute(args) {
  // Обрабатываем разделитель --, который могут передавать package managers.
  args = args.filter(a => a !== '--');
  if (args.length === 0) {
    console.error('Usage: hermes-dev.js execute <plan-path>');
    process.exit(1);
  }

  const planPath = args[0];
  const worktreeRoot = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim();

  // Нормализуем пути: переводим их в native-формат Windows для сравнения.
  const normalizePath = (p) => {
    // Обрабатываем пути MSYS (/c/Users/...) -> Windows (C:\Users\...).
    if (p.startsWith('/') && p.match(/^\/[a-z]\//i)) {
      p = p.replace(/^\/([a-z])\//i, '$1:\\')
        .replace(/\//g, '\\');
    }
    // Нормализуем обратные слеши в прямые для сравнения.
    return p.replace(/\\/g, '/');
  };

  const resolvedPlan = normalizePath(planPath);
  const finalPlan = resolvePlanPath(worktreeRoot, resolvedPlan);

  // Проверяем canonical path, а не строковый префикс worktree.
  if (!finalPlan) {
    console.error('Error: plan path escapes current worktree');
    process.exit(1);
  }

  // Проверяем существование файла плана.
  if (!statSync(finalPlan, { throwIfNoEntry: false })) {
    console.error(`Error: plan file not found: ${finalPlan}`);
    process.exit(1);
  }

  const result = await runHermesExecute({ worktreeRoot, planPath });
  console.log(`${HERMES_EXECUTE_MARKER} marker=${result.marker} exit_code=${result.exitCode} redacted=${result.redacted} cleanup_verified=${result.cleanupVerified}`);
  process.exitCode = result.exitCode;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    const isExecute = process.argv[2] === 'execute';
    const marker = isExecute ? HERMES_EXECUTE_MARKER : HERMES_CONFIG_MARKER;
    const terminationFailed = error?.code === 'HERMES_CONFIG_TERMINATION_FAILED';
    const timeout = error?.code === 'HERMES_CONFIG_TIMEOUT';
    const errorMarker = terminationFailed ? 'TERMINATION_FAILED' : timeout ? 'TIMEOUT' : 'FAILED';
    const exitCode = terminationFailed ? 125 : timeout ? 124 : 1;
    console.log(`${marker} marker=${errorMarker} exit_code=${exitCode} redacted=true`);
    process.exitCode = exitCode;
  });
}
