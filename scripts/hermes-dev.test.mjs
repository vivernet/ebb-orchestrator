import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { resolvePlanPath } from './hermes-dev-paths.mjs';
import { isHermesProjectDiscoveryEnabled, isHermesProjectTrusted, resolveRepositoryRoot, runHermesConfig, runHermesProjectSetup, terminateHermesProcessTree, validateCanonicalSkills } from './hermes-dev.mjs';

const root = resolve(import.meta.dirname, '..');
const skillsRoot = join(root, '.agents', 'skills');
const readme = readFileSync(join(root, 'README.md'), 'utf8');

const expectedSkills = [
  'ebb-curate-skills', 'ebb-database-engineering', 'ebb-debug-issue', 'ebb-design-change', 'ebb-dispatch-agents',
  'ebb-execute-plan', 'ebb-final-review', 'ebb-finish-branch', 'ebb-handle-review-feedback',
  'ebb-implement-task', 'ebb-orchestrate-work', 'ebb-quality-gates', 'ebb-repository-context',
  'ebb-repository-maintenance', 'ebb-review-plan', 'ebb-review-task', 'ebb-security-review',
  'ebb-web-e2e', 'ebb-worktree', 'ebb-write-plan',
];

const canonicalSkills = expectedSkills;

test('project setup checks Hermes health before trust or config writes', async () => {
  const calls = [];
  let configured = false;
  await assert.rejects(runHermesProjectSetup({
    worktreeRoot: '/disposable/project',
    run: (command, args) => {
      calls.push([command, args]);
      return { status: args[0] === '--version' ? 7 : 0, stderr: args[0] === '--version' ? 'token=private-token failed at C:\\Users\\alex\\hermes.exe' : 'Hermes failed' };
    },
    configure: async () => { configured = true; },
  }), (error) => {
    assert.equal(error.code, 'HERMES_CLI_UNAVAILABLE');
    assert.equal(error.exitCode, 7);
    assert.match(error.diagnostic, /token=\[REDACTED\]/);
    assert.doesNotMatch(error.diagnostic, /private-token|C:\\Users\\alex/);
    return true;
  });
  assert.deepEqual(calls, [['hermes', ['--version']]]);
  assert.equal(configured, false);
});

test('timed out Hermes health check fails before trust or config writes', async () => {
  const calls = [];
  let configured = false;
  await assert.rejects(runHermesProjectSetup({
    worktreeRoot: '/disposable/project',
    run: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: null, error: Object.assign(new Error('spawnSync hermes ETIMEDOUT'), { code: 'ETIMEDOUT' }), stderr: '' };
    },
    configure: async () => { configured = true; },
  }), (error) => error.code === 'HERMES_CLI_TIMEOUT' && error.exitCode === 124);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['--version']);
  assert.ok(Number.isFinite(calls[0].options.timeout) && calls[0].options.timeout > 0);
  assert.equal(configured, false);
});

test('Hermes subprocess diagnostics preserve exit status and redact secrets and paths', async () => {
  const child = new EventEmitter();
  child.pid = 4321;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  const pending = runHermesConfig(['get', 'fixture'], { spawnChild: () => child });
  child.stderr.emit('data', 'API_KEY=sk-supersecret failed at C:\\Users\\alex\\.hermes\\config.yaml');
  child.emit('close', 9);
  const result = await pending;
  assert.equal(result.exitCode, 9);
  assert.match(result.diagnostic, /API_KEY=\[REDACTED\]/);
  assert.match(result.diagnostic, /\[PATH\]/);
  assert.doesNotMatch(result.diagnostic, /supersecret|C:\\Users\\alex/);

  const unavailable = await runHermesConfig(['get', 'fixture'], {
    spawnChild: () => { throw new Error('spawn failed at C:\\Users\\alex\\hermes.exe'); },
  });
  assert.equal(unavailable.exitCode, 1);
  assert.match(unavailable.diagnostic, /spawn failed at \[PATH\]/);
  assert.doesNotMatch(unavailable.diagnostic, /C:\\Users\\alex/);
});

test('project trust failure preserves sanitized Hermes stderr and exit code', async () => {
  const calls = [];
  await assert.rejects(runHermesProjectSetup({
    worktreeRoot: 'C:\\private\\repo',
    run: (command, args) => {
      calls.push(args);
      if (args[0] === '--version') return { status: 0 };
      if (args.at(-1) === '--help') return { status: 0 };
      return { status: 17, stderr: 'token=private-token failed for C:\\Users\\alex\\repo' };
    },
  }), (error) => {
    assert.equal(error.code, 'HERMES_PROJECT_TRUST_FAILED');
    assert.equal(error.exitCode, 17);
    assert.match(error.diagnostic, /token=\[REDACTED\]/);
    assert.doesNotMatch(error.diagnostic, /private-token|C:\\Users\\alex/);
    return true;
  });
  assert.deepEqual(calls.map((args) => args[0]), ['--version', 'skills', 'skills']);
});

test('project setup trusts the resolved repository without writing skill copies', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hermes-project-'));
  const fakeHome = join(root, 'home');
  const calls = [];
  try {
    const options = {
      worktreeRoot: root,
      hermesHome: fakeHome,
      run: (...args) => { calls.push(args); return { status: 0, stdout: '' }; },
      configure: async () => { calls.push(['configure']); },
    };
    const result = await runHermesProjectSetup(options);
    await runHermesProjectSetup(options);
    assert.equal(result.trusted, true);
    assert.deepEqual(calls[0], ['hermes', ['--version'], { encoding: 'utf8', shell: false, timeout: 30_000 }]);
    assert.deepEqual(calls[1], ['hermes', ['skills', 'trust', '--help'], { encoding: 'utf8', shell: false }]);
    assert.deepEqual(calls[2], ['hermes', ['skills', 'trust', root], { encoding: 'utf8', shell: false }]);
    assert.equal(calls.filter(([first]) => first === 'configure').length, 2);
    assert.equal(statSync(join(fakeHome, 'skills', 'ebb-orchestrator'), { throwIfNoEntry: false }), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('project setup bounds hanging skills trust and verifies child close before reporting timeout', async () => {
  const invocations = [];
  const terminations = [];
  let configured = false;
  const child = new EventEmitter();
  child.pid = 4321;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};

  await assert.rejects(runHermesProjectSetup({
    worktreeRoot: '/disposable/project',
    checkVersion: () => ({ ok: true, exitCode: 0, diagnostic: '' }),
    timeoutMs: 5,
    terminationGraceMs: 20,
    spawnChild: (command, args, options) => {
      invocations.push({ command, args, options });
      if (args.at(-1) === '--help') {
        process.nextTick(() => child.emit('close', 0));
      }
      return child;
    },
    terminate: (pid, platformName) => {
      terminations.push({ pid, platformName });
      process.nextTick(() => child.emit('close', null));
      return { ok: true };
    },
    configure: async () => { configured = true; },
  }), (error) => error.code === 'HERMES_CONFIG_TIMEOUT' && !error.message.includes('/disposable/project'));

  assert.equal(invocations.length, 2);
  assert.deepEqual(invocations.map(({ args }) => args), [
    ['skills', 'trust', '--help'], ['skills', 'trust', '/disposable/project'],
  ]);
  assert.ok(invocations.every(({ command, options }) => command === 'hermes' && options.shell === false));
  if (process.platform !== 'win32') assert.ok(invocations.every(({ options }) => options.detached === true));
  assert.deepEqual(terminations, [{ pid: 4321, platformName: process.platform }]);
  assert.equal(configured, false);
});

test('POSIX project trust termination signals the detached process group', () => {
  const signals = [];
  const result = terminateHermesProcessTree(5432, 'linux', undefined, true, (...args) => { signals.push(args); });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(signals, [[-5432, 'SIGTERM']]);
});

test('project setup reports termination failure when a timed out child never closes', async () => {
  const child = new EventEmitter();
  child.pid = 1234;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  await assert.rejects(runHermesProjectSetup({
    worktreeRoot: '/disposable/project',
    checkVersion: () => ({ ok: true, exitCode: 0, diagnostic: '' }),
    timeoutMs: 5,
    terminationGraceMs: 10,
    spawnChild: () => child,
    terminate: () => ({ ok: true }),
  }), (error) => error.code === 'HERMES_CONFIG_TERMINATION_FAILED');
});

test('repository root resolution uses Git top-level rather than caller cwd', () => {
  const result = resolveRepositoryRoot((...args) => {
    assert.deepEqual(args.slice(0, 2), ['git', ['rev-parse', '--show-toplevel']]);
    assert.equal(args[2].shell, false);
    return { status: 0, stdout: 'C:/repo\n' };
  });
  assert.equal(result, 'C:/repo');
});

test('Hermes dev script does not expose provider-addition behavior', () => {
  const script = readFileSync(join(root, 'scripts', 'hermes-dev.mjs'), 'utf8');
  assert.doesNotMatch(script, /doProvider|hermes-dev\.js provider|providers\.inception/);
});

test('Hermes dev setup and check do not manage unsupported worktree isolation config', () => {
  const script = readFileSync(join(root, 'scripts', 'hermes-dev.mjs'), 'utf8');
  assert.doesNotMatch(script, /delegation\.worktree_isolation/);
});

test('project trust accepts Hermes list output and rejects a different repository', () => {
  assert.equal(isHermesProjectTrusted('["C:\\\\repo"]', 'c:/repo/'), true);
  assert.equal(isHermesProjectTrusted('  - C:\\repo  ', 'c:/repo/'), true);
  assert.equal(isHermesProjectTrusted('/other/repo', 'C:/repo'), false);
});

test('Hermes project discovery check requires the documented enabled setting', () => {
  assert.equal(isHermesProjectDiscoveryEnabled('true'), true);
  assert.equal(isHermesProjectDiscoveryEnabled('false'), false);
  assert.equal(isHermesProjectDiscoveryEnabled(undefined), false);
});

test('Hermes setup and check do not copy or hash profile assets', () => {
  const source = readFileSync(join(root, 'scripts', 'hermes-dev.mjs'), 'utf8');
  assert.doesNotMatch(source, /copyFileSync|createHash|sha256|skills\.create_dir/);
  assert.match(source, /Canonical project skills \(20\)/);
});

test('canonical skill validation enforces the 20-skill project inventory', () => {
  const result = validateCanonicalSkills(join(root, '.agents', 'skills'));
  assert.deepEqual(result.skills, canonicalSkills);
  assert.equal(result.valid, true);
});

test('canonical skill validation rejects missing, extra and incomplete skills', () => {
  const temp = mkdtempSync(join(tmpdir(), 'hermes-inventory-'));
  try {
    for (const skill of expectedSkills) {
      mkdirSync(join(temp, skill));
      writeFileSync(join(temp, skill, 'SKILL.md'), '---\n');
    }
    assert.equal(validateCanonicalSkills(temp).valid, true);
    rmSync(join(temp, expectedSkills[0], 'SKILL.md'));
    assert.equal(validateCanonicalSkills(temp).valid, false);
    writeFileSync(join(temp, expectedSkills[0], 'SKILL.md'), '---\n');
    mkdirSync(join(temp, 'unexpected-skill'));
    assert.equal(validateCanonicalSkills(temp).valid, false);
    rmSync(join(temp, 'unexpected-skill'), { recursive: true });
    rmSync(join(temp, expectedSkills[0]), { recursive: true });
    assert.equal(validateCanonicalSkills(temp).valid, false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('canonical Hermes skills have valid discoverable frontmatter', () => {
  const actualSkills = readdirSync(skillsRoot)
    .filter((entry) => statSync(join(skillsRoot, entry)).isDirectory())
    .sort();
  assert.deepEqual(actualSkills, expectedSkills);

  for (const skill of expectedSkills) {
    const content = readFileSync(join(skillsRoot, skill, 'SKILL.md'), 'utf8');
    assert.match(content, /^---\r?\nname: [a-z0-9-]+\r?\ndescription: .+\r?\n/s);
    assert.doesNotMatch(content, /\[TODO:|your-api-key|(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9]/i);
  }
});

test('README inventory lists all 20 skills exactly once', () => {
  const documentedSkills = [...readme.matchAll(/^- `([a-z\d-]+)` —/gmu)]
    .map((match) => match[1]).filter((name) => name.startsWith('ebb-')).sort();
  assert.deepEqual(documentedSkills, expectedSkills);
});

test('README points to Hermes guide and canonical skills', () => {
  assert.match(readme, /\]\(docs\/development\/05-hermes\.md\)/);
  assert.match(readme, /`\.agents\/skills\/`/);
  assert.doesNotMatch(readme, /tools\/hermes\/README\.md/);
  assert.match(readme, /20 repository-local Ebb skills/);
  const documentedSkills = [...readme.matchAll(/^- `([a-z\d-]+)` —/gmu)]
    .map((match) => match[1]).filter((name) => name.startsWith('ebb-')).sort();
  assert.deepEqual(documentedSkills, expectedSkills);
  assert.match(readme, /pnpm hermes:setup/);
  assert.match(readme, /pnpm hermes:check/);
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.scripts['hermes:setup'], 'node scripts/hermes-dev.mjs setup');
  assert.equal(manifest.scripts['hermes:check'], 'node scripts/hermes-dev.mjs check');
  assert.equal(manifest.scripts['skills:dependencies:test'], 'node --test scripts/ebb-skill-dependencies.test.mjs');
  const guide = readFileSync(join(root, 'docs', 'development', '05-hermes.md'), 'utf8');
  assert.match(guide, /\]\(\.\.\/\.\.\/README\.md#hermes-development-skills\)/);
});

test('plan path resolution rejects traversal and sibling-prefix escapes', () => {
  const root = join('C:', 'repo', 'worktree');
  assert.equal(resolvePlanPath(root, 'docs/plan.md'), resolve(root, 'docs/plan.md'));
  assert.equal(resolvePlanPath(root, '../outside.md'), null);
  assert.equal(resolvePlanPath(root, `${root}-sibling/plan.md`), null);
  assert.equal(resolvePlanPath(root, join('C:', 'other', 'plan.md')), null);
});

test('Hermes execute rejects invalid Plan YAML, status, and kind before runtime dispatch', (t) => {
  const gitLookup = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['git'], { encoding: 'utf8' });
  const gitPath = gitLookup.stdout.split(/\r?\n/).find((line) => line.trim())?.trim();
  assert.ok(gitPath, 'git is required to create a disposable repository');
  const isolatedPath = [dirname(gitPath), ...(process.platform === 'win32' ? [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')] : ['/bin', '/usr/bin'])].join(process.platform === 'win32' ? ';' : ':');
  const script = join(root, 'scripts', 'hermes-dev.mjs');
  const fixtures = [
    ['invalid YAML', '---\nid: [broken\n---\n# invalid\n'],
    ['invalid status', '---\nid: plan-91\nkind: plan\nstatus: draft\ntitle: Fixture\ncreated: 2026-09-25\nupdated: 2026-09-26\n---\n# invalid\n'],
    ['non-Plan kind', '---\nid: spec-91\nkind: spec\nstatus: planned\ntitle: Fixture\ncreated: 2026-09-25\nupdated: 2026-09-26\n---\n# not an implementation Plan\n'],
  ];

  for (const [name, content] of fixtures) {
    const repo = mkdtempSync(join(tmpdir(), 'hermes-invalid-plan-'));
    t.after(() => rmSync(repo, { recursive: true, force: true }));
    const initialized = spawnSync('git', ['init', '--quiet'], { cwd: repo, env: { ...process.env, PATH: isolatedPath }, encoding: 'utf8' });
    assert.equal(initialized.status, 0, initialized.stderr);
    const planPath = join('docs', 'architecture', 'plans', 'nested');
    mkdirSync(join(repo, planPath), { recursive: true });
    writeFileSync(join(repo, planPath, 'fixture.md'), content);

    const result = spawnSync(process.execPath, [script, 'execute', join(planPath, 'fixture.md')], {
      cwd: repo,
      env: { ...process.env, PATH: isolatedPath, TEMP: repo, TMPDIR: repo },
      encoding: 'utf8',
    });

    assert.notEqual(result.status, 0, `${name} must fail closed`);
    assert.match(result.stderr, /Invalid Plan metadata/);
    assert.doesNotMatch(result.stdout, /HERMES_EXECUTE marker=/, `${name} must fail before Hermes dispatch`);
  }
});

test('Hermes execute cleans its temporary prompt before process exit', () => {
  const source = readFileSync(join(root, 'scripts', 'hermes-dev.mjs'), 'utf8');
  assert.match(source, /HERMES_EXECUTE_TIMEOUT_MS/);
  assert.match(source, /setTimeout\(/);
  assert.match(source, /shell: false/);
  assert.match(source, /HERMES_EXECUTE/);
  assert.match(source, /HERMES_CONFIG/);
  assert.match(source, /HERMES_CONFIG_TIMEOUT_MS/);
  assert.doesNotMatch(source, /stdio: 'inherit'/);
});

test('Hermes execute terminates the Windows process tree on timeout', () => {
  const source = readFileSync(join(root, 'scripts', 'hermes-dev.mjs'), 'utf8');
  assert.match(source, /taskkill\.exe/);
  assert.match(source, /\/T/);
  assert.match(source, /\/F/);
});
