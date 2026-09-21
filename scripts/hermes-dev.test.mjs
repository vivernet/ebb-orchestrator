import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolvePlanPath } from './hermes-dev-paths.mjs';

const root = resolve(import.meta.dirname, '..');
const skillsRoot = join(root, 'tools', 'hermes', 'skills');
const capabilities = readFileSync(join(root, 'tools', 'hermes', 'capabilities.yaml'), 'utf8');
const provider = readFileSync(join(root, 'tools', 'hermes', 'providers', 'inception.yaml'), 'utf8');
const readme = readFileSync(join(root, 'README.md'), 'utf8');
const catalog = readFileSync(join(root, 'docs', 'development', 'hermes-capabilities.md'), 'utf8');

const expectedSkills = [
  'ebb-execute-plan',
  'ebb-final-review',
  'ebb-implement-task',
  'ebb-provider-integration',
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
    assert.match(content, /^---\r?\nname: [a-z0-9-]+\r?\ndescription: Use when .+\r?\n/s);
    assert.doesNotMatch(content, /\[TODO:|your-api-key|sk-[A-Za-z0-9]/i);
  }
});

test('capability registry covers every canonical skill without secrets', () => {
  for (const skill of expectedSkills) assert.match(capabilities, new RegExp(`name: ${skill}`));
  assert.match(capabilities, /allowed_scope:/);
  assert.doesNotMatch(capabilities, /(?:api[_-]?key|token)\s*[:=]\s*[^\s]+/i);
});

test('Inception provider template is explicit and non-secret', () => {
  assert.match(provider, /^name: inception$/m);
  assert.match(provider, /^provider: custom:inception$/m);
  assert.match(provider, /^api: https:\/\/api\.inceptionlabs\.ai\/v1$/m);
  assert.match(provider, /^model: mercury-2\.5$/m);
  assert.match(provider, /^key_env: INCEPTION_API_KEY$/m);
  assert.doesNotMatch(provider, /INCEPTION_API_KEY\s*[:=]\s*[^\s{`]/);
});

test('README documents every skill, provider and setup boundary', () => {
  for (const skill of expectedSkills) assert.match(catalog, new RegExp(`\\\`${skill}\\\``));
  assert.match(readme, /pnpm hermes:setup/);
  assert.match(readme, /pnpm hermes:check/);
  assert.match(readme, /pnpm hermes:provider -- inception/);
  assert.match(readme, /INCEPTION_API_KEY/);
  assert.match(readme, /\.env\.example/);
  assert.match(catalog, /tools\/hermes\/providers\/inception\.yaml/);
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
