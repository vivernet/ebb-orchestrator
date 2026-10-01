#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, rmSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, posix, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { clearTimeout, setTimeout } from 'node:timers';
import { resolvePlanPath } from './hermes-dev-paths.mjs';
import { parsePlanFile } from './docs-governance.mjs';
import { loadProjectEnv } from './project-env.mjs';

export const HERMES_EXECUTE_MARKER = 'HERMES_EXECUTE';
export const HERMES_CONFIG_MARKER = 'HERMES_CONFIG';
const DEFAULT_EXECUTE_TIMEOUT_MS = 300_000;
const DEFAULT_CONFIG_TIMEOUT_MS = 30_000;
const MAX_HERMES_DIAGNOSTIC_LENGTH = 240;
const ANSI_ESCAPE_SEQUENCE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-?]*[ -/]*[@-~]`, 'g');
const CONTROL_CHARACTERS = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}]+`, 'g');

export function sanitizeHermesDiagnostic(value) {
  return String(value ?? '')
    .replace(ANSI_ESCAPE_SEQUENCE, '')
    .replace(CONTROL_CHARACTERS, ' ')
    .replace(/\b([A-Za-z0-9_]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|authorization))\b(["']?\s*[:=]\s*["']?)(?:Bearer\s+)?([^"'\s,;}]+)(["']?)/gi, '$1$2[REDACTED]$4')
    .replace(/\b(?:sk|rk|pk|gh[pousr]|xox[baprs])[-_][A-Za-z0-9_-]{8,}|Bearer\s+[^\s,;]+/gi, '[REDACTED]')
    .replace(/\b(https?:\/\/)[^/@\s]+@/gi, '$1[REDACTED]@')
    .replace(/\b[A-Za-z]:[\\/][^\s"'<>]+|\\\\[^\s"'<>]+/g, '[PATH]')
    .replace(/\/(?:[^\s"'<>/]+\/)+[^\s"'<>]+/g, '[PATH]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_HERMES_DIAGNOSTIC_LENGTH);
}

export function checkHermesVersion(run = spawnSync, timeoutMs = DEFAULT_CONFIG_TIMEOUT_MS) {
  let result;
  try {
    result = run('hermes', ['--version'], { encoding: 'utf8', shell: false, timeout: timeoutMs });
  } catch (error) {
    const timedOut = error?.code === 'ETIMEDOUT';
    return {
      ok: false,
      exitCode: timedOut ? 124 : Number.isInteger(error?.status) ? error.status : 1,
      timedOut,
      diagnostic: sanitizeHermesDiagnostic(error?.stderr || (timedOut ? 'hermes --version timed out' : error?.message)),
    };
  }
  const timedOut = result?.error?.code === 'ETIMEDOUT';
  const exitCode = Number.isInteger(result?.status) ? result.status : 1;
  return {
    ok: !result?.error && exitCode === 0,
    exitCode: timedOut ? 124 : exitCode,
    timedOut,
    diagnostic: sanitizeHermesDiagnostic(result?.stderr || (timedOut ? 'hermes --version timed out' : result?.error?.message)),
  };
}

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
  command = 'config',
  captureStdout = true,
  requireCloseOnTimeout = false,
  terminationGraceMs = 1_000,
  detached = false,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    let graceTimer;
    let timedOut = false;
    let stdout = '';
    let stderr = '';
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve(result);
    };

    let child;
    try {
      child = spawnChild('hermes', [command, ...args], {
        encoding: 'utf8',
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        ...(detached ? { detached: true } : {}),
      });
      child.stdout?.on('data', (chunk) => { if (captureStdout) stdout += String(chunk); });
      child.stderr?.on('data', (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-4_096); });
      child.once('error', (error) => { if (!timedOut) finish({ ok: false, exitCode: 1, timedOut: false, terminationFailed: false, marker: 'FAILED', stdout: '', diagnostic: sanitizeHermesDiagnostic(stderr || error?.message) }); });
      child.once('close', (code) => finish(timedOut && requireCloseOnTimeout
        ? { ok: false, exitCode: 124, timedOut: true, terminationFailed: false, marker: 'TIMEOUT', stdout: '', diagnostic: sanitizeHermesDiagnostic(stderr) }
        : {
        ok: code === 0,
        exitCode: code === 0 ? 0 : (code ?? 1),
        timedOut: false,
        terminationFailed: false,
        marker: code === 0 ? 'COMPLETED' : 'FAILED',
        stdout: code === 0 ? stdout.trim() : '',
        diagnostic: code === 0 ? '' : sanitizeHermesDiagnostic(stderr),
      }));
      timer = setTimeout(() => {
        timedOut = true;
        let termination;
        try { termination = terminate(child.pid, platform()); } catch { termination = { ok: false }; }
        try { child.kill(); } catch { /* child may already be gone */ }
        const terminated = termination?.ok === true;
        if (requireCloseOnTimeout && terminated) {
          graceTimer = setTimeout(() => finish({ ok: false, exitCode: 125, timedOut: true, terminationFailed: true, marker: 'TERMINATION_FAILED', stdout: '', diagnostic: sanitizeHermesDiagnostic(stderr) }), terminationGraceMs);
          return;
        }
        finish({
          ok: false,
          exitCode: terminated ? 124 : 125,
          timedOut: true,
          terminationFailed: !terminated,
          marker: terminated ? 'TIMEOUT' : 'TERMINATION_FAILED',
          stdout: '',
          diagnostic: sanitizeHermesDiagnostic(stderr),
        });
      }, timeoutMs);
    } catch (error) {
      finish({ ok: false, exitCode: 1, timedOut: false, terminationFailed: false, marker: 'FAILED', stdout: '', diagnostic: sanitizeHermesDiagnostic(error?.stderr || error?.message) });
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
    error.exitCode = result.exitCode;
    error.diagnostic = result.diagnostic;
    throw error;
  }
}

async function hermesConfigGet(key) {
  return runHermesConfig(['get', key]);
}

const CANONICAL_EBB_SKILLS = [
  'ebb-curate-skills', 'ebb-database-engineering', 'ebb-debug-issue', 'ebb-design-change', 'ebb-dispatch-agents',
  'ebb-execute-plan', 'ebb-final-review', 'ebb-finish-branch', 'ebb-handle-review-feedback',
  'ebb-implement-task', 'ebb-orchestrate-work', 'ebb-quality-gates', 'ebb-repository-context',
  'ebb-repository-maintenance', 'ebb-review-plan', 'ebb-review-task', 'ebb-security-review',
  'ebb-web-e2e', 'ebb-worktree', 'ebb-write-plan',
];

export function validateCanonicalSkills(skillsRoot) {
  const skills = readdirSync(skillsRoot)
    .filter((entry) => statSync(join(skillsRoot, entry)).isDirectory())
    .sort();
  const valid = skills.length === CANONICAL_EBB_SKILLS.length
    && skills.every((skill, index) => skill === CANONICAL_EBB_SKILLS[index])
    && skills.every((skill) => statSync(join(skillsRoot, skill, 'SKILL.md'), { throwIfNoEntry: false })?.isFile());
  return { skills, valid };
}

export function resolveRepositoryRoot(run = spawnSync) {
  const result = run('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', shell: false });
  if (result.error || result.status !== 0 || !result.stdout?.trim()) throw new Error('Not in a Git repository');
  return result.stdout.trim();
}

export function isHermesProjectTrusted(configValue, worktreeRoot) {
  let entries = configValue?.split(/[\r\n,;]/).map((entry) => entry.trim()) ?? [];
  try {
    const parsed = JSON.parse(configValue);
    if (Array.isArray(parsed)) entries = parsed.map(String);
  } catch { /* Hermes may render list values as plain text. */ }
  const normalize = (value) => value.trim()
    .replace(/^-\s*/, '')
    .replace(/^['"]|['"]$/g, '')
    .replace(/[\\/]+$/, '')
    .replace(/\\/g, '/')
    .toLowerCase();
  return entries.some((entry) => normalize(entry) === normalize(worktreeRoot));
}

export function isHermesProjectDiscoveryEnabled(configValue) {
  return configValue?.trim().toLowerCase() === 'true';
}

export async function runHermesProjectSetup({
  worktreeRoot,
  run,
  spawnChild = spawn,
  terminate = terminateHermesProcessTree,
  timeoutMs = parseConfigTimeout(),
  terminationGraceMs = 1_000,
  checkVersion = checkHermesVersion,
  configure = async () => {},
}) {
  const health = checkVersion(run ?? spawnSync);
  if (!health.ok) {
    const error = new Error('Hermes CLI health check failed before project setup.');
    error.code = health.timedOut ? 'HERMES_CLI_TIMEOUT' : 'HERMES_CLI_UNAVAILABLE';
    error.exitCode = health.exitCode;
    error.diagnostic = health.diagnostic;
    throw error;
  }
  const invoke = async (args) => run
    ? run('hermes', ['skills', ...args], { encoding: 'utf8', shell: false })
    : runHermesConfig(args, {
      command: 'skills', captureStdout: false, requireCloseOnTimeout: true,
      detached: platform() !== 'win32', spawnChild,
      terminate: terminate === terminateHermesProcessTree
        ? (pid, platformName) => terminateHermesProcessTree(pid, platformName, spawnSync, platformName !== 'win32')
        : terminate,
      timeoutMs, terminationGraceMs,
    });
  const assertBounded = (result) => {
    if (!result?.timedOut) return;
    const error = new Error();
    error.code = result.terminationFailed ? 'HERMES_CONFIG_TERMINATION_FAILED' : 'HERMES_CONFIG_TIMEOUT';
    error.exitCode = result.exitCode;
    error.diagnostic = result.diagnostic;
    throw error;
  };
  const help = await invoke(['trust', '--help']);
  assertBounded(help);
  if (help.error || (run ? help.status !== 0 : !help.ok)) {
    const error = new Error('Installed Hermes CLI does not support `hermes skills trust`; update Hermes and retry.');
    error.code = 'HERMES_PROJECT_TRUST_UNSUPPORTED';
    error.exitCode = run ? (help.status ?? 1) : help.exitCode;
    error.diagnostic = sanitizeHermesDiagnostic(run ? help.stderr || help.error?.message : help.diagnostic);
    throw error;
  }
  const trusted = await invoke(['trust', worktreeRoot]);
  assertBounded(trusted);
  if (trusted.error || (run ? trusted.status !== 0 : !trusted.ok)) {
    const error = new Error('Hermes could not trust the current project. Run `hermes skills trust <repo-root>` and retry.');
    error.code = 'HERMES_PROJECT_TRUST_FAILED';
    error.exitCode = run ? (trusted.status ?? 1) : trusted.exitCode;
    error.diagnostic = sanitizeHermesDiagnostic(run ? trusted.stderr || trusted.error?.message : trusted.diagnostic);
    throw error;
  }
  await configure();
  return { trusted: true };
}

export function parseExecuteTimeout(value = process.env.HERMES_EXECUTE_TIMEOUT_MS) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return DEFAULT_EXECUTE_TIMEOUT_MS;
  return parsed;
}

export function terminateHermesProcessTree(pid, platformName = platform(), run = spawnSync, processGroup = false, signal = process.kill) {
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
    signal(processGroup ? -pid : pid, 'SIGTERM');
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
    console.error('Usage: hermes-dev.js <setup|check|execute> [args...]');
    process.exit(1);
  }

  switch (command) {
    case 'setup':
      await doSetup();
      break;
    case 'check':
      await doCheck();
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
  if (docsInventory.status !== 0 || docsCheck.status !== 0) {
    console.error('Documentation checks failed:');
    console.error(docsInventory.stdout || docsInventory.stderr);
    console.error(docsCheck.stdout || docsCheck.stderr);
    process.exit(1);
  }

  // 1. Получаем корень Git worktree.
  let worktreeRoot;
  try { worktreeRoot = resolveRepositoryRoot(); } catch {
    console.error('Not in a Git repository');
    process.exit(1);
  }

  console.log('Configuring Hermes...');
  const setup = await runHermesProjectSetup({
    worktreeRoot,
    configure: async () => {
      await hermesConfigSet('delegation.max_concurrent_children', '2');
      await hermesConfigSet('delegation.max_spawn_depth', '1');
      await hermesConfigSet('delegation.orchestrator_enabled', 'false');
      await hermesConfigSet('skills.project_discovery', 'true');
    },
  });
  console.log(`${HERMES_CONFIG_MARKER} marker=SETUP_CONFIGURED trusted=${setup.trusted} redacted=true`);

  console.log('Setup complete.');
}

async function doCheck() {
  console.log('Checking Hermes development environment...');

  const checks = [];
  let allPass = true;
  const worktreeRoot = resolveRepositoryRoot();

  // 1. Проверяем hermes --version и сохраняем безопасную диагностику сбоя.
  const health = checkHermesVersion();
  checks.push({ name: 'hermes --version', pass: health.ok, detail: health.diagnostic, exitCode: health.exitCode });
  if (!health.ok) allPass = false;

  // 2. Проверяем наличие .hermes.md.
  const hermesMdPath = join(worktreeRoot, '.hermes.md');
  checks.push({
    name: '.hermes.md exists',
    pass: statSync(hermesMdPath, { throwIfNoEntry: false }) !== undefined
  });
  if (!checks[1].pass) allPass = false;

  // Validate the canonical inventory and Hermes project-discovery prerequisites.
  const sourceSkills = join(worktreeRoot, '.agents', 'skills');
  const inventory = validateCanonicalSkills(sourceSkills);
  checks.push({ name: 'Canonical project skills (20)', pass: inventory.valid });
  if (!inventory.valid) allPass = false;
  const trustedProjects = await hermesConfigGet('skills.trusted_project_dirs');
  const trusted = trustedProjects.ok && isHermesProjectTrusted(trustedProjects.stdout, worktreeRoot);
  checks.push({ name: 'Hermes trusted project', pass: trusted, detail: trustedProjects.diagnostic, exitCode: trustedProjects.exitCode });
  if (!trusted) allPass = false;
  const projectDiscovery = await hermesConfigGet('skills.project_discovery');
  const projectDiscoveryEnabled = projectDiscovery.ok && isHermesProjectDiscoveryEnabled(projectDiscovery.stdout);
  checks.push({ name: 'Hermes project discovery enabled', pass: projectDiscoveryEnabled, detail: projectDiscovery.diagnostic, exitCode: projectDiscovery.exitCode });
  if (!projectDiscoveryEnabled) allPass = false;

  // Проверяем конфигурацию Hermes.
  const configChecks = [
    ['delegation.max_concurrent_children', '2'],
    ['delegation.max_spawn_depth', '1'],
    ['delegation.orchestrator_enabled', 'false']
  ];
  for (const [key, expected] of configChecks) {
    const result = await hermesConfigGet(key);
    checks.push({ name: `Config: ${key}`, pass: result.ok && result.stdout === expected, detail: result.diagnostic, exitCode: result.exitCode });
    if (!result.ok || result.stdout !== expected) allPass = false;
  }

  // Выводим результаты.
  console.log('');
  console.log('Check results:');
  for (const check of checks) {
    console.log(`  ${check.pass ? 'PASS' : 'FAIL'}: ${check.name}`);
    if (!check.pass && check.exitCode !== undefined) console.log(`    exit_code=${check.exitCode}`);
    if (!check.pass && check.detail) console.log(`    diagnostic: ${check.detail}`);
  }

  if (!allPass) {
    console.log('');
    console.log(`${HERMES_CONFIG_MARKER} marker=CHECK_FAILED exit_code=1 redacted=true`);
    console.log('Some checks failed. Run `pnpm hermes:setup`; if project trust failed, run `hermes skills trust <repo-root>`.');
    process.exit(1);
  }
  console.log('');
  console.log('All checks passed.');
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

  // Перед dispatch к Hermes принимается только Plan с metadata, прошедшими каноническую проверку docs governance.
  try {
    parsePlanFile(finalPlan, { requirePlan: true });
  } catch (error) {
    console.error(`Invalid Plan metadata: ${error.message}`);
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
    const timeout = error?.code === 'HERMES_CONFIG_TIMEOUT' || error?.code === 'HERMES_CLI_TIMEOUT';
    const errorMarker = terminationFailed ? 'TERMINATION_FAILED' : timeout ? 'TIMEOUT' : 'FAILED';
    const exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : terminationFailed ? 125 : timeout ? 124 : 1;
    const diagnostic = sanitizeHermesDiagnostic(error?.diagnostic);
    if (diagnostic) console.error(`Hermes diagnostic: ${diagnostic}`);
    console.log(`${marker} marker=${errorMarker} exit_code=${exitCode} redacted=true`);
    process.exitCode = exitCode;
  });
}
