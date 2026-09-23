import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolvePlanPath } from './hermes-dev-paths.mjs';

const root = resolve(import.meta.dirname, '..');
const skillsRoot = join(root, 'tools', 'hermes', 'skills');
const readme = readFileSync(join(root, 'README.md'), 'utf8');

const expectedSkills = [
  'ebb-execute-plan',
  'ebb-final-review',
  'ebb-implement-task',
  'ebb-quality-gates',
  'ebb-repository-context',
  'ebb-review-task',
  'ebb-security-review',
  'ebb-web-e2e',
];

test('canonical Hermes skills have valid discoverable frontmatter', () => {
  const actualSkills = readdirSync(skillsRoot)
    .filter((entry) => statSync(join(skillsRoot, entry)).isDirectory())
    .sort();
  assert.deepEqual(actualSkills, expectedSkills);

  for (const skill of expectedSkills) {
    const content = readFileSync(join(skillsRoot, skill, 'SKILL.md'), 'utf8');
    assert.match(content, /^---\r?\nname: [a-z0-9-]+\r?\ndescription: .+\r?\n/s);
    assert.doesNotMatch(content, /\[TODO:|your-api-key|sk-[A-Za-z0-9]/i);
  }
});

test('README documents every skill and setup commands', () => {
  for (const skill of expectedSkills) assert.match(readme, new RegExp(skill));
  assert.match(readme, /pnpm hermes:setup/);
  assert.match(readme, /pnpm hermes:check/);
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
