import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';

const skillsRoot = fileURLToPath(new URL('../.agents/skills/', import.meta.url));
const expectedNames = [
  'ebb-curate-skills', 'ebb-debug-issue', 'ebb-design-change',
  'ebb-dispatch-agents', 'ebb-execute-plan', 'ebb-final-review',
  'ebb-finish-branch', 'ebb-handle-review-feedback', 'ebb-implement-task',
  'ebb-orchestrate-work', 'ebb-quality-gates', 'ebb-repository-context',
  'ebb-repository-maintenance', 'ebb-review-plan', 'ebb-review-task',
  'ebb-security-review', 'ebb-web-e2e', 'ebb-worktree', 'ebb-write-plan',
];

// Static contract transcribed from TRIGGER-MATRIX.md in the approved bundle.
// These assertions inspect routing documentation; they do not execute scenarios
// or prove model application of a skill.
const triggerMatrix = [
  ['Start arbitrary Ebb engineering work', 'ebb-orchestrate-work', /в начале любой инженерной работы/u],
  ['Need current Git/instructions/scope brief', 'ebb-repository-context', /актуальные инструкции/u],
  ['New cross-component architecture/API/state decision', 'ebb-design-change', /проектных решений, новой архитектуры/u, 'Неясные требования / новая архитектура'],
  ['Approved requirements need multi-task plan', 'ebb-write-plan', /утверждённые требования или design.*implementation plan/u, 'Approved multi-task change'],
  ['Plan ready for independent approval', 'ebb-review-plan', /implementation plan.*независимой.*проверке/u],
  ['Need/create/check isolated worktree', 'ebb-worktree', /проверить или создать изолированный Git worktree/u],
  ['2+ independent problem domains / scouts', 'ebb-dispatch-agents', /два или больше независимых/u, 'Несколько независимых доменов'],
  ['Execute approved dependency plan', 'ebb-execute-plan', /исполнения утверждённого implementation plan/u, 'Approved executable plan'],
  ['Implement one task/finding', 'ebb-implement-task', /одной назначенной задачи.*подтверждённого.*finding/u, 'Одна bounded task'],
  ['Review one task diff', 'ebb-review-task', /review одной реализованной задачи/u],
  ['Received review findings', 'ebb-handle-review-feedback', /после получения review findings/u],
  ['Bug/failing test/build/unexpected behavior', 'ebb-debug-issue', /bug, failing test\/build.*unexpected behavior.*root cause до исправления/u, 'Ошибка / failing test / build'],
  ['About to claim PASS/DONE/fixed', 'ebb-quality-gates', /перед любым утверждением PASS\/DONE\/fixed\/ready/u, 'Completion claim'],
  ['Whole-change final readiness', 'ebb-final-review', /после реализации всего change\/plan.*whole-change review/u, 'Whole-change readiness'],
  ['Verified branch needs PR/merge/handoff', 'ebb-finish-branch', /реализация.*завершена и проверена.*branch в PR\/merge/u, 'Branch/PR integration'],
  ['Cleanup/move/setup/docs/tooling', 'ebb-repository-maintenance', /cleanup, move\/rename, documentation restructuring, setup\/dev-script/u, 'Cleanup/move/setup/docs'],
  ['Auth/secrets/permissions/process/persistence boundary', 'ebb-security-review', /trust boundary, auth, secrets, permissions, process.*persistence/u, 'Trust boundary/auth/secrets/process'],
  ['Browser/HTTP/session/SSE behavior', 'ebb-web-e2e', /Web UI, HTTP, sessions, SSE.*browser-visible/u, 'Browser-visible HTTP/session/SSE'],
  ['Add/edit/audit Ebb skills', 'ebb-curate-skills', /создать, изменить или оценить/u, 'Skill authoring/curation'],
];

function skillDescription(name) {
  const content = readFileSync(path.join(skillsRoot, name, 'SKILL.md'), 'utf8');
  return /^description:[ \t]*(.+)$/mu.exec(content)?.[1]?.trim() ?? '';
}

function routingPrimary(content, signal) {
  const rows = content.split(/\r?\n/u).filter((line) => line.startsWith('|'))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()))
    .filter(([candidate]) => candidate === signal);
  assert.equal(rows.length, 1, `Expected one routing row: ${signal}`);
  const owners = [...rows[0][1].matchAll(/`(ebb-[a-z\d-]+)`/gu)].map((match) => match[1]);
  assert.equal(owners.length, 1, `Expected one primary skill: ${signal}`);
  return owners[0];
}

const routerContent = readFileSync(path.join(skillsRoot, 'ebb-orchestrate-work', 'references', 'workflow-router.md'), 'utf8');

test('static trigger matrix covers each approved primary owner exactly once', () => {
  assert.deepEqual(triggerMatrix.map(([, primary]) => primary).sort(), expectedNames);
});

for (const [scenario, primary, descriptionTrigger, routingSignal] of triggerMatrix) {
  test(`static trigger matrix: ${scenario} => ${primary}`, () => {
    assert.match(skillDescription(primary), descriptionTrigger, `Missing description trigger: ${scenario} => ${primary}`);
    if (routingSignal) assert.equal(routingPrimary(routerContent, routingSignal), primary, `Wrong primary skill: ${scenario}`);
  });
}

test('static trigger collision boundaries preserve design, planning, debugging and review stages', () => {
  const routing = readFileSync(path.join(skillsRoot, 'ebb-orchestrate-work', 'SKILL.md'), 'utf8');
  assert.match(routing, /Утверждённые требования[^\n]*`ebb-write-plan` → `ebb-review-plan` → `ebb-execute-plan`/u);
  assert.match(routing, /Bug\/test\/build\/unexpected behavior → `ebb-debug-issue` до fix/u);
  const design = readFileSync(path.join(skillsRoot, 'ebb-design-change', 'SKILL.md'), 'utf8');
  assert.match(design, /Перед implementation-plan стадией design должен быть явно принят пользователем/u);
  const planning = readFileSync(path.join(skillsRoot, 'ebb-write-plan', 'SKILL.md'), 'utf8');
  assert.match(planning, /Если load-bearing design ещё не утверждён, вернись в `ebb-design-change`/u);
  const debugging = readFileSync(path.join(skillsRoot, 'ebb-debug-issue', 'SKILL.md'), 'utf8');
  assert.match(debugging, /Никаких fixes до root-cause investigation/u);
  assert.match(debugging, /После доказанного cause: bounded fix → `ebb-implement-task`/u);
  assert.match(skillDescription('ebb-review-task'), /одной реализованной задачи/u);
  assert.match(skillDescription('ebb-final-review'), /всего change\/plan/u);
  assert.equal(routingPrimary(routerContent, 'Completion claim'), 'ebb-quality-gates');
  assert.equal(routingPrimary(routerContent, 'Whole-change readiness'), 'ebb-final-review');
});

test('static trigger assertions reject wrong, missing and ambiguous routing primaries', () => {
  const signal = 'Ошибка / failing test / build';
  const row = `| ${signal} | \`ebb-debug-issue\` | bounded fix или plan |`;
  assert.ok(routerContent.includes(row), 'Expected debugging routing fixture');
  const wrongPrimary = routerContent.replace(row, row.replace('ebb-debug-issue', 'ebb-implement-task'));
  assert.throws(() => assert.equal(routingPrimary(wrongPrimary, signal), 'ebb-debug-issue'), /ebb-implement-task/u);
  assert.throws(() => routingPrimary(routerContent.replace(row, ''), signal), /Expected one routing row/u);
  assert.throws(() => routingPrimary(routerContent.replace(row, row.replace('`ebb-debug-issue`', '`ebb-debug-issue` `ebb-implement-task`')), signal), /Expected one primary skill/u);
});

function markdownFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    assert.ok(!entry.isSymbolicLink(), `Skill content must not use symlinks: ${filename}`);
    return entry.isDirectory() ? markdownFiles(filename) : entry.name.endsWith('.md') ? [filename] : [];
  });
}

const actualNames = readdirSync(skillsRoot, { withFileTypes: true })
  .map((entry) => {
    assert.ok(entry.isDirectory(), `Top-level skill entry must be a directory: ${entry.name}`);
    return entry.name;
  }).sort();

test('canonical workflow exposes exactly the 19 approved skill owners', () => {
  assert.deepEqual(actualNames, expectedNames);
});

test('each discovered skill has its own name and a nonempty trigger description', () => {
  for (const name of actualNames) {
    const filename = path.join(skillsRoot, name, 'SKILL.md');
    assert.ok(existsSync(filename), `Missing entrypoint: ${name}`);
    const content = readFileSync(filename, 'utf8');
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content)?.[1];
    assert.ok(frontmatter, `Missing frontmatter: ${name}`);
    assert.equal(/^name:\s*(.+)$/mu.exec(frontmatter)?.[1]?.trim(), name);
    const description = /^description:[ \t]*(.+)$/mu.exec(frontmatter)?.[1]?.trim().replace(/^(["'])(.*)\1$/u, '$2').trim();
    assert.ok(description, `Missing trigger description: ${name}`);
  }
});

function validateMarkdownLinks(content, filename) {
    // This collection uses inline links. Reject reference syntax rather than silently ignoring it.
    assert.ok(!/\[[^\]]+\]\[[^\]]*\]|^[ \t]{0,3}\[[^\]]+\]:/mu.test(content), `Unsupported reference-style Markdown: ${filename}`);
    for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
      const destination = match[1].replace(/^<|>$/gu, '').split('#')[0];
      if (!destination) continue;
      assert.ok(!/^(?:[a-z][a-z\d+.-]*:|[\\/])/iu.test(destination), `Non-local skill link: ${filename}: ${destination}`);
      const resolved = path.resolve(path.dirname(filename), decodeURIComponent(destination));
      const relative = path.relative(skillsRoot, resolved);
      assert.ok(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), `Link escapes skill collection: ${filename}: ${destination}`);
      assert.ok(existsSync(resolved), `Missing skill reference: ${filename}: ${destination}`);
    }
}

test('Markdown references resolve inside the local skill collection', () => {
  for (const filename of markdownFiles(skillsRoot)) {
    const content = readFileSync(filename, 'utf8');
    validateMarkdownLinks(content, filename);
    for (const match of content.matchAll(/(?<![\w/])ebb-[a-z\d]+(?:-[a-z\d]+)*(?![\w/-])/gu)) {
      // The project identifier is metadata, not a skill dependency.
      if (match[0] === 'ebb-orchestrator') continue;
      assert.ok(actualNames.includes(match[0]), `Missing Ebb skill owner: ${filename}: ${match[0]}`);
    }
  }
});

function validateAutonomy(content, filename) {
  for (const line of content.split(/\r?\n/u)) {
    const hasDirective = /companion|fallback|используй|использовать|обязательн|требует|must|use|requir(?:es|ed|ing)|invoke|load/iu.test(line);
    if (!hasDirective) continue;
    const mentions = [...line.matchAll(/superpowers(?::[a-z\d-]+)?|another\s+skill(?:\s+collection)?|external\s+skills?|друг(?:ой|ого) набор(?:а)? skills/giu)];
    if (/skills?|навык/iu.test(line)) {
      mentions.push(...line.matchAll(/\b[a-z][a-z\d-]*:[a-z][a-z\d-]*\b/giu));
      for (const token of line.matchAll(/`([a-z\d]+(?:-[a-z\d]+)+)`/gu)) {
        if (!(token[1].startsWith('ebb-') && actualNames.includes(token[1]))) mentions.push(token);
      }
    }
    for (const mention of mentions) {
      // Only a negated action immediately governing this mention exempts it.
      // A negative action with a different object cannot exempt later dependencies.
      const prefix = line.slice(0, mention.index).replace(/[`*]/gu, '').trimEnd();
      const deniesThisDependency = /(?:\b(?:not|never)\s+(?:use|invoke|load|require|delegate(?:\s+to)?|depend\s+on)|\bwithout(?:\s+(?:using|invoking|loading|requiring))?|\bno(?:\s+(?:ebb\s+)?skills?\s+requires?)?|не\s+(?:используй|использовать|требует|делегируй|зависит\s+от)|без)\s*$/iu.test(prefix);
      assert.ok(deniesThisDependency, `External workflow dependency: ${filename}: ${mention[0]}: ${line}`);
    }
  }
}

test('required workflow mechanics do not delegate to an external' + ' skill collection', () => {
  for (const filename of markdownFiles(skillsRoot)) {
    validateAutonomy(readFileSync(filename, 'utf8'), filename);
  }
});

test('unrelated negation cannot hide a required external' + ' skill dependency', () => {
  const authoring = `${['super', 'powers'].join('')}:${['writing', 'skills'].join('-')}`;
  const planning = `${['super', 'powers'].join('')}:${['writing', 'plans'].join('-')}`;
  for (const content of [
    `Do not skip review; must use ${authoring} as a required skill.`,
    `No findings; must use ${authoring} as a required skill.`,
    `Never skip review; must use ${authoring} as a required skill.`,
    `Without skipping review, must use ${authoring} as a required skill.`,
    `Do not use logs and must use ${authoring} as a required skill.`,
    `Do not use logs, always use ${authoring} as a required skill.`,
    `Do not use ${planning}, always use ${authoring} as a required skill.`,
  ]) assert.throws(() => validateAutonomy(content, 'reviewer probe'), /External workflow dependency/u);
});

test('negative independence language does not require external skills', () => {
  const authoring = `${['super', 'powers'].join('')}:${['writing', 'skills'].join('-')}`;
  for (const content of [
    `Do not use ${authoring} as a required skill.`,
    'No Ebb skill requires another skill collection as a companion.',
    `Never invoke ${authoring}; workflow works without external skills.`,
    `Не используй ${authoring} как обязательный skill.`,
    'Work without requiring another skill as a companion.',
  ]) assert.doesNotThrow(() => validateAutonomy(content, 'independence probe'));
});

test('reference-style Markdown cannot hide a missing protocol file', () => {
  assert.throws(() => validateMarkdownLinks(
    '[protocol][required]\n\n[required]: references/missing.md',
    path.join(skillsRoot, 'ebb-implement-task', 'SKILL.md'),
  ), /Missing skill reference|Unsupported reference-style Markdown/u);
});
