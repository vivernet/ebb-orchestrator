import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolvePlanPath } from './hermes-dev-paths.mjs';
import { isHermesProjectDiscoveryEnabled, isHermesProjectTrusted, resolveRepositoryRoot, runHermesProjectSetup, validateCanonicalSkills } from './hermes-dev.mjs';

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
    assert.deepEqual(calls[0], ['hermes', ['skills', 'trust', '--help'], { encoding: 'utf8', shell: false }]);
    assert.deepEqual(calls[1], ['hermes', ['skills', 'trust', root], { encoding: 'utf8', shell: false }]);
    assert.equal(calls.filter(([first]) => first === 'configure').length, 2);
    assert.equal(statSync(join(fakeHome, 'skills', 'ebb-orchestrator'), { throwIfNoEntry: false }), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
