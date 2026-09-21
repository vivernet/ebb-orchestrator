import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, isAbsolute, join, resolve, win32 } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const auditCommand = 'pnpm audit --prod --json';

/**
 * Формирует provenance envelope для dependency-audit evidence.
 * Envelope связывает raw результат с конкретной revision и lockfile.
 */
export function buildAuditEvidence({
  auditOutput,
  command,
  toolVersion,
  nodeVersion,
  runAt,
  revision,
  branch,
  lockfileSha256,
  exitCode,
}) {
  let raw = auditOutput;
  try {
    raw = JSON.parse(auditOutput);
  } catch {
    // Сохраняем исходный вывод, чтобы failure evidence не терял диагностику.
  }

  return {
    command,
    tool: 'pnpm',
    toolVersion,
    nodeVersion,
    runAt,
    revision,
    branch,
    lockfileSha256,
    exitCode,
    raw,
  };
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', shell: false });
  if (result.error) throw result.error;
  return result;
}

function gitValue(args) {
  const result = run('git', args);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

/**
 * На Windows разрешает цепочку pnpm.cmd shim-ов до native pnpm.exe.
 * Это сохраняет shell:false и не передаёт command line через cmd.exe.
 */
export function resolveWindowsPnpmExecutable(shimPath, {
  readShim = (path) => readFileSync(path, 'utf8'),
  fileExists = existsSync,
  seen = new Set(),
} = {}) {
  const normalizedShimPath = win32.normalize(shimPath);
  if (seen.has(normalizedShimPath)) throw new Error(`Cyclic pnpm shim: ${normalizedShimPath}`);
  seen.add(normalizedShimPath);

  const contents = readShim(normalizedShimPath);
  const shimDirectory = win32.dirname(normalizedShimPath);
  const targets = [...contents.matchAll(/"([^"]+\.(?:cmd|exe))"/gi)].map((match) => {
    const expanded = match[1]
      .replace(/%~dp0%/gi, shimDirectory)
      .replace(/%dp0%/gi, shimDirectory);
    return win32.normalize(win32.isAbsolute(expanded) ? expanded : win32.resolve(shimDirectory, expanded));
  });

  for (const target of targets) {
    if (!fileExists(target)) continue;
    if (target.toLowerCase().endsWith('.exe')) return target;
    if (target.toLowerCase().endsWith('.cmd')) {
      try {
        return resolveWindowsPnpmExecutable(target, { readShim, fileExists, seen });
      } catch {
        // Пробуем следующий candidate из shim-а.
      }
    }
  }

  throw new Error(`Unable to resolve native pnpm executable from ${normalizedShimPath}`);
}

function pnpmExecutable() {
  if (process.platform !== 'win32') return 'pnpm';

  const where = spawnSync('where.exe', ['pnpm.cmd'], { encoding: 'utf8', shell: false });
  if (where.error) throw where.error;
  if (where.status !== 0) throw new Error('where.exe pnpm.cmd failed');

  for (const candidate of where.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
    try {
      return resolveWindowsPnpmExecutable(candidate);
    } catch {
      // Пробуем следующий shim, если предыдущий недоступен или повреждён.
    }
  }

  throw new Error('Unable to resolve native pnpm executable on Windows');
}

function outputPath(argv, revision) {
  const index = argv.indexOf('--output');
  const requested = index >= 0 ? argv[index + 1] : undefined;
  if (index >= 0 && !requested) throw new Error('--output requires a path');
  const value = requested ?? join('artifacts', 'security', `pnpm-audit-prod-${revision}.json`);
  return isAbsolute(value) ? value : resolve(root, value);
}

function main() {
  const revision = gitValue(['rev-parse', 'HEAD']);
  const branch = gitValue(['branch', '--show-current']) || null;
  const lockfile = readFileSync(resolve(root, 'pnpm-lock.yaml'));
  const lockfileSha256 = createHash('sha256').update(lockfile).digest('hex');
  const tool = run(pnpmExecutable(), ['--version']);
  if (tool.status !== 0) throw new Error('pnpm --version failed');

  const audit = run(pnpmExecutable(), ['audit', '--prod', '--json']);
  const auditOutput = (audit.stdout || audit.stderr || '').trim();
  const evidence = buildAuditEvidence({
    auditOutput,
    command: auditCommand,
    toolVersion: tool.stdout.trim(),
    nodeVersion: process.version,
    runAt: new Date().toISOString(),
    revision,
    branch,
    lockfileSha256,
    exitCode: audit.status ?? 1,
  });
  const target = outputPath(process.argv.slice(2), revision);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  process.exitCode = evidence.exitCode;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) main();
