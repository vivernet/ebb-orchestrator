import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const skillRoot = join(root, '.agents', 'skills');
const owners = readdirSync(skillRoot).filter((name) => statSync(join(skillRoot, name)).isDirectory());

// Исторические paths не являются skill dependencies. Сейчас нет исторических
// обязательных внешних skills, требующих исключения. Будущий exception должен
// задавать exact file + exact line + date evidence, а не исключать документ целиком.
const historicalEvidence = [];

function localSkillFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = join(directory, entry.name);
    assert.ok(!entry.isSymbolicLink(), `Skill source must not be a symlink: ${filename}`);
    return entry.isDirectory() ? localSkillFiles(filename) : [relative(root, filename).replaceAll('\\', '/')];
  });
}

function trackedSourceFiles(repositoryRoot = root) {
  const result = spawnSync('git', [
    '-c', `safe.directory=${repositoryRoot.replaceAll('\\', '/')}`,
    'ls-files', '--cached', '--others', '--exclude-standard', '-z',
  ], {
    cwd: repositoryRoot, encoding: 'utf8', shell: false,
  });
  assert.equal(result.status, 0, `Cannot enumerate project source: ${result.stderr}`);
  // Canonical skills retain their independent symlink boundary validation.
  if (repositoryRoot === root) localSkillFiles(skillRoot);
  return [...new Set(result.stdout.split('\0').filter(Boolean))].sort();
}

function requiredDependencies(line) {
  if (!/companion|fallback|используй|использовать|обязательн|требует|must|mandatory|always|use|requir(?:es|ed|ing)|invoke|load/iu.test(line)) return [];
  const mentions = [...line.matchAll(/(?<![\w./])superpowers(?::[a-z\d-]+)?(?![\w/])|another\s+skill(?:\s+collection)?|external\s+skills?|друг(?:ой|ого) набор(?:а)? skills/giu)];
  for (const mention of line.matchAll(/\b[a-z][a-z\d-]*:[a-z][a-z\d-]*\b|`([a-z\d]+(?:-[a-z\d]+)+)`|\b[a-z\d]+(?:-[a-z\d]+)+\b/giu)) {
      const prefix = line.slice(0, mention.index).replace(/[`*\\]/gu, '').trimEnd();
      if (!/skills?|навык|суперсил/iu.test(line)
        && !(mention[0].includes(':') && /must|always|required|mandatory|обязательн/iu.test(prefix))) continue;
      const suffix = line.slice(mention.index + mention[0].length).replace(/[`*\\]/gu, '').trimStart();
      const isSkillInstruction = /(?:skills?|навык)\s*:\s*$|(?:required|mandatory|обязательн\S*)\s+(?:sub-)?(?:skills?|навык)\s*:?\s*$|(?:use|invoke|load|используй|используйте|использовать)\s*$/iu.test(prefix)
        && /^(?:[.,;]|$|skills?\b|as\s+(?:a\s+)?(?:required\s+)?skills?\b|для\b|to\b)/iu.test(suffix);
      if (isSkillInstruction && !owners.includes(mention[1] ?? mention[0])) mentions.push(mention);
  }
  return mentions.filter((mention) => {
    const prefix = line.slice(0, mention.index).replace(/[`*]/gu, '').trimEnd();
    return !/(?:\b(?:not|never)\s+(?:use|invoke|load|require|delegate(?:\s+to)?|depend\s+on)|\bwithout(?:\s+(?:using|invoking|loading|requiring))?|\bno(?:\s+(?:ebb\s+)?skills?\s+requires?)?|не\s+(?:используй|использовать|требует|делегируй|зависит\s+от)|без)\s*$/iu.test(prefix);
  }).map((mention) => mention[1] ?? mention[0]).filter((name, index, names) => names.indexOf(name) === index);
}

function dependencyFindings(content, filename) {
  return content.split(/\r?\n/u).flatMap((line, index) => {
    const dependencies = requiredDependencies(line);
    if (!dependencies.length) return [];
    const evidence = historicalEvidence.find((item) => item.file === filename && item.line === line);
    if (evidence) {
      assert.match(content, new RegExp(`(?:date|created): ${evidence.date}`));
      assert.match(content, /Историческ|historical|status: superseded/iu);
      return [];
    }
    return [`${filename}:${index + 1}: ${dependencies.join(', ')}: ${line}`];
  });
}

test('source inventory includes current untracked instructions and excludes ignored files', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'ebb-dependency-'));
  try {
    const initialized = spawnSync('git', ['init', '--quiet', fixture], { encoding: 'utf8', shell: false });
    assert.equal(initialized.status, 0, initialized.stderr);
    writeFileSync(join(fixture, '.gitignore'), 'ignored.md\n');
    const staged = spawnSync('git', ['-c', `safe.directory=${fixture.replaceAll('\\', '/')}`, 'add', '.gitignore'], {
      cwd: fixture, encoding: 'utf8', shell: false,
    });
    assert.equal(staged.status, 0, staged.stderr);
    const dependency = `${['super', 'powers'].join('')}:${['writing', 'skills'].join('-')}`;
    const instruction = `Must use ${dependency} as a required skill.`;
    writeFileSync(join(fixture, 'instructions.md'), instruction);
    writeFileSync(join(fixture, 'ignored.md'), instruction);
    const files = trackedSourceFiles(fixture);
    assert.ok(files.includes('.gitignore'));
    assert.ok(files.includes('instructions.md'), 'Current untracked instructions must be inspected before staging');
    assert.ok(!files.includes('ignored.md'));
    assert.equal(dependencyFindings(readFileSync(join(fixture, 'instructions.md'), 'utf8'), 'instructions.md').length, 1);
  } finally {
    assert.equal(dirname(fixture), resolve(tmpdir()));
    assert.ok(basename(fixture).startsWith('ebb-dependency-'));
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('precise expected-result prose does not invoke an external workflow owner', () => {
  const prose = 'Expected: падает на прежних требованиях внешнего workflow-набора за пределами точечного historical-evidence allowlist.';
  assert.deepEqual(dependencyFindings(prose, 'docs/architecture/plans/current.md'), []);
  const dependency = `${['super', 'powers'].join('')}:${['writing', 'skills'].join('-')}`;
  assert.equal(dependencyFindings(`${prose}\nMust use ${dependency} as a required skill.`, 'docs/architecture/plans/current.md').length, 1);
});

test('all tracked and non-ignored untracked project source is independent of required external workflow skills', () => {
  const files = trackedSourceFiles();
  assert.ok(files.includes('AGENTS.md') && files.includes('package.json'));
  const findings = [];
  let textFiles = 0;
  for (const filename of files) {
    const absolute = join(root, filename);
    // Deleted tracked paths remain in the index until coordinator staging.
    if (!existsSync(absolute)) continue;
    assert.ok(statSync(absolute).isFile(), `Tracked source is not a file: ${filename}`);
    const bytes = readFileSync(absolute);
    if (bytes.includes(0)) continue;
    textFiles += 1;
    findings.push(...dependencyFindings(bytes.toString('utf8'), filename));
  }
  console.log(`Dependency scan: ${files.length} paths, ${textFiles} text files, ${historicalEvidence.length} historical exceptions.`);
  assert.deepEqual(findings, [], `Required external workflow dependencies:\n${findings.join('\n')}`);
});

test('dependency scan detects instructions across source types and unrelated negation', () => {
  const namespace = ['super', 'powers'].join('');
  const unknownOwner = ['unknown', 'workflow'].join('-');
  const pluginOwner = ['plugin', 'workflow'].join(':');
  for (const filename of ['AGENTS.md', 'docs/plan.md', 'scripts/check.mjs', '.agents/skills/new/SKILL.md', 'workflow.yaml']) {
    assert.equal(dependencyFindings(`Do not skip review; must use ${namespace}:writing-skills as a required skill.`, filename).length, 1);
    assert.equal(dependencyFindings(`Must use \`${unknownOwner}\` skill.`, filename).length, 1);
    assert.equal(dependencyFindings(`Must use ${unknownOwner} skill.`, filename).length, 1);
    assert.equal(dependencyFindings(`MANDATORY SKILL ${unknownOwner}.`, filename).length, 1);
    assert.equal(dependencyFindings(`Must invoke ${pluginOwner}.`, filename).length, 1);
    assert.equal(dependencyFindings(`REQUIRED SKILL: \`ebb-execute-plan\`.`, filename).length, 0);
    assert.equal(dependencyFindings(`Do not use ${namespace}:writing-skills as a required skill.`, filename).length, 0);
  }
});

test('dated historical documents and test files cannot hide new active requirements', () => {
  const dependency = `${['super', 'powers'].join('')}:writing-skills`;
  const instruction = `Must use ${dependency} as a required skill.`;
  assert.equal(dependencyFindings(`---\ndate: 2026-09-23\nstatus: completed\n---\nHistorical evidence.\n${instruction}`, 'docs/audit/05-hermes-development-workflow-parity.md').length, 1);
  const probe = `for (const content of [\n  '${instruction}',\n]) assert.throws(() => validateAutonomy(content, 'probe'));`;
  assert.equal(dependencyFindings(probe, 'scripts/guard.test.mjs').length, 1);
  assert.equal(dependencyFindings(`${probe}\n// ${instruction}`, 'scripts/guard.test.mjs').length, 2);
  assert.equal(dependencyFindings(probe, 'scripts/prompt.mjs').length, 1);
});

for (const [sourceKind, opening, closing] of [
  ['prompt template', 'const prompt = `', '`;'],
  ['block comment', '/*', '*/'],
]) {
  test(`deceptive harness text inside ${sourceKind} cannot exempt dependencies`, () => {
    const dependency = `${['super', 'powers'].join('')}:${['writing', 'skills'].join('-')}`;
    const instruction = `Must use ${dependency} as a required skill.`;
    const harness = `for (const content of [\n  '${instruction}',\n]) assert.throws(() => validateAutonomy(content, 'probe'));`;
    assert.equal(dependencyFindings([opening, harness, closing].join('\n'), 'scripts/guard.test.mjs').length, 1);
  });
}
