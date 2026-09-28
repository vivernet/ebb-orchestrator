#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const statuses = new Set(['proposed', 'planned', 'in_progress', 'blocked', 'completed', 'superseded', 'cancelled']);
const nonPlanKinds = new Set(['roadmap', 'spec', 'audit', 'proposal', 'guideline', 'ledger', 'reference', 'index', 'governance-evidence']);
function calendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0); date.setUTCHours(0, 0, 0, 0); date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
function parsePlan(content, source) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) throw new Error(`${source}: missing YAML frontmatter`);
  const metadata = yaml.load(match[1], { schema: yaml.JSON_SCHEMA });
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error(`${source}: metadata must be an object`);
  const required = ['id', 'kind', 'status', 'title', 'created', 'updated'];
  const optional = ['summary', 'depends_on', 'specs', 'evidence'];
  for (const field of [...required, ...optional]) {
    if (!Object.hasOwn(metadata, field)) continue;
    if (['id', 'title', 'summary'].includes(field) && typeof metadata[field] !== 'string') throw new Error(`${source}: ${field} must be a string`);
    if (['depends_on', 'specs', 'evidence'].includes(field) && (!Array.isArray(metadata[field]) || !metadata[field].every((value) => typeof value === 'string'))) throw new Error(`${source}: ${field} must be a string array`);
  }
  for (const field of required) if (!Object.hasOwn(metadata, field)) throw new Error(`${source}: missing ${field}`);
  for (const field of Object.keys(metadata)) if (![...required, ...optional].includes(field)) throw new Error(`${source}: unknown field ${field}`);
  if (metadata.kind !== 'plan') throw new Error(`${source}: kind must be plan`);
  if (!statuses.has(metadata.status)) throw new Error(`${source}: invalid Plan status`);
  for (const field of ['created', 'updated']) if (!calendarDate(metadata[field])) throw new Error(`${source}: invalid ${field} date`);
  return metadata;
}
function collectPlans(dir) {
  const plans = [];
  function scan(folder) {
    for (const entry of readdirSync(folder)) {
      const path = join(folder, entry); const stat = statSync(path);
      if (stat.isDirectory()) scan(path);
      else if (entry.endsWith('.md')) {
        const text = readFileSync(path, 'utf8');
        const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        if (!match) throw new Error(`${path}: missing YAML frontmatter`);
        let raw;
        try {
          raw = yaml.load(match[1], { schema: yaml.JSON_SCHEMA });
        } catch (error) {
          throw new Error(`${path}: invalid YAML: ${error.message}`, { cause: error });
        }
        if (raw && typeof raw === 'object' && !Array.isArray(raw) && (nonPlanKinds.has(raw.kind) || raw.type === 'evidence')) continue;
        plans.push(parsePlan(text, path));
      }
    }
  }
  scan(dir); return plans;
}
function generateRoadmap(plans) {
  const rows = plans.map((plan) => `| ${plan.id} | ${plan.status} | ${plan.title} |`);
  const deps = plans.flatMap((plan) => (plan.depends_on ?? []).map((dep) => `${dep} → ${plan.id}`));
  const updated = plans.reduce((latest, plan) => plan.updated > latest ? plan.updated : latest, '2026-09-16');
  return [
    '---',
    'id: roadmap-01',
    'status: generated',
    'kind: roadmap',
    'title: Ebb Orchestrator Roadmap',
    'summary: Generated from Plan metadata and dependencies',
    'created: 2026-09-16',
    `updated: ${updated}`,
    '---',
    '',
    '# Ebb Orchestrator Roadmap',
    '',
    'Актуальная последовательность сверки и закрытия работ: [current-state roadmap](02-current-state.md). Реестр статусов и зависимостей ниже генерируется из Plan metadata.',
    '',
    '## Plan Register',
    '',
    '| ID | Status | Title |',
    '|----|--------|-------|',
    ...rows,
    '',
    '## Dependency Graph',
    '',
    ...(deps.length ? deps : ['No dependencies.']),
  ].join('\n') + '\n';
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const plansArg = args.find((arg) => arg.startsWith('--plans-root='));
const outputArg = args.find((arg) => arg.startsWith('--output='));
const plansDir = plansArg ? resolve(plansArg.slice('--plans-root='.length)) : join(ROOT, 'docs/architecture/plans');
const outputPath = outputArg ? outputArg.slice('--output='.length) : 'docs/roadmap/generated.md';
const plans = collectPlans(plansDir);
const content = generateRoadmap(plans);
if (dryRun) {
  console.log('=== DRY RUN MODE ===\n'); console.log(`Plans collected: ${plans.length}`); console.log(`Output: ${outputPath}`); console.log('\n--- Generated content preview ---\n'); console.log(content.slice(0, 500) + (content.length > 500 ? '...' : ''));
} else {
  const output = resolve(ROOT, outputPath); mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, content, 'utf8');
  console.log(`Roadmap generated: ${outputPath}`); console.log(`Plans included: ${plans.length}`);
}
