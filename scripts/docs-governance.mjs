#!/usr/bin/env node
/**
 * docs-governance.mjs - Documentation governance CLI
 * 
 * Commands: inventory, check, roadmap, rename:check
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'fs';
import { join, relative, extname, dirname, resolve, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';
import { loadMigrationMap, validateLinks, validatePlanLifecycle } from './docs-governance-lib.mjs';

const PLAN_STATUSES = new Set(['proposed', 'planned', 'in_progress', 'blocked', 'completed', 'superseded', 'cancelled']);
const PLAN_REQUIRED = ['id', 'kind', 'status', 'title', 'created', 'updated'];
const PLAN_OPTIONAL = ['summary', 'depends_on', 'specs', 'evidence'];
const NON_PLAN_KINDS = new Set(['roadmap', 'spec', 'audit', 'proposal', 'guideline', 'ledger', 'reference', 'index', 'governance-evidence']);
/** Ошибка, указывающая на нарушение контракта metadata документа Plan. */
export class PlanMetadataError extends Error {
  /**
   * Создаёт ошибку проверки metadata с указанием источника.
   * @param {string} source Путь файла или метка входных metadata.
   * @param {string} message Причина отклонения metadata.
   */
  constructor(source, message) { super(`${source}: ${message}`); this.name = 'PlanMetadataError'; this.source = source; }
}
function validCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number); const date = new Date(0); date.setUTCHours(0, 0, 0, 0); date.setUTCFullYear(y, m - 1, d);
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}
/**
 * Проверяет объект frontmatter согласно единому контракту Plan metadata.
 * @param {unknown} metadata Разобранные, но ещё не доверенные YAML metadata.
 * @param {string} [source='<metadata>'] Источник metadata для диагностики.
 * @returns {Record<string, unknown>} Исходный объект без преобразований, если он допустим.
 * @throws {PlanMetadataError} Если структура, типы или значения не соответствуют контракту.
 */
export function validatePlanMetadata(metadata, source = '<metadata>') {
  const fail = (message) => { throw new PlanMetadataError(source, message); };
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) fail('metadata must be an object');
  for (const key of Object.keys(metadata)) if (![...PLAN_REQUIRED, ...PLAN_OPTIONAL].includes(key)) fail(`unknown field ${key}`);
  for (const key of PLAN_REQUIRED) if (!Object.hasOwn(metadata, key)) fail(`missing ${key}`);
  for (const key of ['id', 'title']) if (typeof metadata[key] !== 'string') fail(`${key} must be a string`);
  if (metadata.kind !== 'plan') fail('kind must be plan');
  if (typeof metadata.status !== 'string' || !PLAN_STATUSES.has(metadata.status)) fail('invalid Plan status');
  for (const key of ['created', 'updated']) if (!validCalendarDate(metadata[key])) fail(`invalid ${key} date`);
  if (Object.hasOwn(metadata, 'summary') && typeof metadata.summary !== 'string') fail('summary must be a string');
  for (const key of ['depends_on', 'specs', 'evidence']) if (Object.hasOwn(metadata, key) && (!Array.isArray(metadata[key]) || !metadata[key].every(value => typeof value === 'string'))) fail(`${key} must be a string array`);
  return metadata;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = dirname(__dirname);
const DOCS_ROOT = join(ROOT, 'docs');

/**
 * Parse YAML frontmatter from markdown content
 */
function parseFrontMatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  
  const yamlLines = match[1].split('\n').map(line => line.replace(/\r$/, ''));
  const data = {};
  
  for (const line of yamlLines) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) {
      const [, key, value] = kv;
      data[key] = value.trim() || '';
    } else if (line.match(/^ {2}- (.*)$/)) {
      const [, val] = line.match(/^ {2}- (.*)$/);
      const key = yamlLines[yamlLines.indexOf(line) - 1].replace(/:\s*$/, '');
      if (!data[key]) data[key] = [];
      data[key].push(val.trim());
    }
  }
  
  return { data, body: text.slice(match[0].length) };
}

/**
 * Scan documentation directory
 */
function scanDocs(rootDir) {
  const files = [];
  
  function scan(dir) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        scan(fullPath);
      } else if (extname(entry) === '.md') {
        const content = readFileSync(fullPath, 'utf8');
        const fm = parseFrontMatter(content);
        files.push({
          path: relative(rootDir, fullPath).replace(/\\/g, '/'),
          fullPath,
          metadata: fm?.data || null,
          body: fm?.body || content
        });
      }
    }
  }
  
  scan(rootDir);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Check documentation for issues
 */
function checkDocs(files) {
  const issues = [];
  const kindCounts = new Map();
  for (const file of files) {
    const kind = file.metadata?.kind;
    if (typeof kind === 'string') kindCounts.set(kind, (kindCounts.get(kind) || 0) + 1);
  }
  
  for (const file of files) {
    const repoPath = file.path.replace(/\\/g, '/').replace(/^\//, '');
    const isReadme = repoPath === 'README.md' || repoPath === 'docs/README.md';
    if ((!file.metadata || !file.metadata.id) && !isReadme) {
      issues.push({ file: repoPath, severity: 'error', message: 'Missing YAML frontmatter or id field' });
    }
    for (const lifecycleIssue of validatePlanLifecycle({ kind: file.metadata?.kind, status: file.metadata?.status })) {
      issues.push({ file: repoPath, severity: 'error', message: lifecycleIssue.message });
    }
    
    const fileName = repoPath.split('/').pop();
    const isCanonicalRoadmap = repoPath === 'docs/roadmap/generated.md';
    const isUniqueDocumentKind = typeof file.metadata?.kind === 'string' && kindCounts.get(file.metadata.kind) === 1;
    if (fileName !== 'README.md' && !isCanonicalRoadmap && !isUniqueDocumentKind && !fileName.match(/^\d\d-/)) {
      issues.push({
        file: file.path,
        severity: 'warning',
        message: 'Filename does not start with numeric prefix'
      });
    }
  }
  
  return issues;
}

/**
 * Generate inventory
 */
function inventoryDocs(files) {
  console.log('=== Documentation Inventory ===\n');
  console.log(`Total files: ${files.length}`);
  console.log();
  
  for (const file of files) {
    const status = file.metadata?.status || 'unknown';
    const kind = file.metadata?.kind || 'unknown';
    console.log(`${file.path} [${kind}] ${status}`);
  }
}

/**
 * Проверяет документы в указанном корне репозитория и печатает ошибки и предупреждения.
 * @param {string} [repositoryRoot=ROOT] Корень репозитория, по умолчанию текущий проект.
 */
function checkCommand(repositoryRoot = ROOT) {
  const files = scanDocs(join(repositoryRoot, 'docs')).map(file => ({ ...file, path: `docs/${file.path}` }));
  const readmePath = join(repositoryRoot, 'README.md');
  if (existsSync(readmePath)) {
    const content = readFileSync(readmePath, 'utf8'); const fm = parseFrontMatter(content);
    files.push({ path: 'README.md', fullPath: readmePath, metadata: fm?.data || null, body: fm?.body || content });
  }
  const issues = checkDocs(files);
  for (const linkIssue of validateLinks(files.map(file => ({ filePath: file.fullPath, body: file.body })))) {
    const sourceFile = files.find(file => file.fullPath === linkIssue.filePath);
    issues.push({
      file: sourceFile?.path ?? relative(repositoryRoot, linkIssue.filePath).replace(/\\/g, '/'),
      severity: 'error',
      message: linkIssue.message,
    });
  }
  const errors = issues.filter(issue => issue.severity === 'error');
  const warnings = issues.filter(issue => issue.severity === 'warning');
  
  if (warnings.length > 0) {
    console.log(`Found ${warnings.length} warning(s):\n`);
    for (const issue of warnings) {
      console.log(`[${issue.severity.toUpperCase()}] ${issue.file}`);
      console.log(`  ${issue.message}\n`);
    }
  }
  
  if (errors.length > 0) {
    console.log(`Found ${errors.length} error(s):\n`);
    for (const issue of errors) {
      console.log(`[${issue.severity.toUpperCase()}] ${issue.file}`);
      console.log(`  ${issue.message}\n`);
    }
    process.exit(1);
  } else if (warnings.length === 0) {
    console.log('All documentation files pass checks.');
  }
}

/**
 * Разбирает YAML frontmatter файла и проверяет его, если документ имеет тип Plan.
 * @param {string} path Путь к Markdown-файлу.
 * @returns {unknown} Проверенные metadata Plan либо исходные metadata другого типа документа.
 * @throws {PlanMetadataError} Если metadata Plan не соответствуют контракту.
 */
export function parsePlanFile(path, { requirePlan = false } = {}) {
  const content = readFileSync(path, 'utf8');
  const delimiter = '---';
  const parts = content.split(delimiter);
  
  if (parts.length < 3) {
    throw new Error(`File ${path} does not contain valid YAML frontmatter`);
  }
  
  try {
    const yamlContent = parts[1].trim();
    const metadata = yaml.load(yamlContent, { schema: yaml.JSON_SCHEMA });
    if (!requirePlan && metadata && typeof metadata === 'object' && (NON_PLAN_KINDS.has(metadata.kind) || metadata.type === 'evidence')) return metadata;
    return validatePlanMetadata(metadata, path);
  } catch (e) {
    if (e instanceof PlanMetadataError) throw e;
    const err = new Error(`Error parsing YAML from ${path}: ${e.message}`);
    err.cause = e;
    throw err;
  }
}

/**
 * Проверяет migration map, активные относительные ссылки и отсутствие оставленных переименованных источников.
 * @param {string} repositoryRoot Корень репозитория, переданный CLI.
 */
async function renameCheckCommand(repositoryRoot) {
  const migrationMapPath = join(repositoryRoot, 'docs', 'architecture', 'plans', 'governance', 'evidence', '03-document-migration-map.md');
  const errors = [];
  if (!existsSync(migrationMapPath)) {
    console.log(`Migration map not found: ${relative(repositoryRoot, migrationMapPath).replace(/\\/g, '/')}`);
    process.exitCode = 1;
    return;
  }

  const { entries } = await loadMigrationMap(migrationMapPath);
  if (entries.length === 0) errors.push('Migration map contains no entries');
  const cleanMapPath = value => String(value ?? '').trim().replace(/^`|`$/g, '').replace(/^['"]|['"]$/g, '').replace(/\\/g, '/');
  const resolveLegacyPath = mapPath => {
    const cleaned = cleanMapPath(mapPath);
    if (!cleaned || /^n\/a$/i.test(cleaned)) return null;
    const absolutePath = resolve(repositoryRoot, cleaned);
    const repositoryRelative = relative(repositoryRoot, absolutePath);
    if (repositoryRelative === '..' || repositoryRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(repositoryRelative)) {
      errors.push(`Legacy source path escapes repository root: ${mapPath}`);
      return null;
    }
    return absolutePath;
  };

  for (const entry of entries) {
    const oldPath = cleanMapPath(entry.oldPath);
    const canonical = cleanMapPath(entry.canonicalTarget);
    const oldAbsolute = resolveLegacyPath(oldPath);
    if (oldAbsolute && oldPath.toLowerCase() !== canonical.toLowerCase() && existsSync(oldAbsolute)) {
      errors.push(`Legacy source path still exists: ${oldPath}`);
    }
  }

  const docs = scanDocs(join(repositoryRoot, 'docs'));
  const readmePath = join(repositoryRoot, 'README.md');
  if (existsSync(readmePath)) docs.push({ fullPath: readmePath, body: readFileSync(readmePath, 'utf8') });
  for (const issue of validateLinks(docs.map(file => ({ filePath: file.fullPath, body: file.body })))) {
    errors.push(`Broken link in ${relative(repositoryRoot, issue.filePath).replace(/\\/g, '/')}: ${issue.message}`);
  }

  if (errors.length > 0) {
    for (const error of errors) console.log(`[ERROR] ${error}`);
    process.exitCode = 1;
    return;
  }
  const entryLabel = entries.length === 1 ? 'entry' : 'entries';
  console.log(`Rename check passed: ${entries.length} migration ${entryLabel}, no retained legacy sources or broken relative links.`);
}

/**
 * Собирает проверенные Plan из непосредственных Markdown-файлов каталога.
 * Известные типы документов, отличные от Plan, пропускаются; ошибки Plan metadata журналируются.
 * @param {string} dir Каталог с Plan-файлами.
 * @returns {Array<Record<string, unknown>>} Проверенные Plan в порядке чтения файлов.
 */
export function collectPlans(dir) {
  if (!existsSync(dir)) {
    return [];
  }
  
  const plans = [];
  const files = readdirSync(dir);
  
  for (const file of files) {
    if (!file.endsWith('.md')) {
      continue;
    }
    
    const filePath = join(dir, file);
    
    try {
      const plan = parsePlanFile(filePath);
      if (plan.kind === 'plan') {
        plans.push(plan);
      }
    } catch (error) {
      if (error instanceof PlanMetadataError) console.warn(`Failed to parse plan file: ${filePath}: ${error.message}`);
      else throw error;
    }
  }
  
  return plans;
}

/**
 * Validate plans for uniqueness and circular dependencies
 */
export function validatePlans(plans) {
  const errors = [];
  
  // Check for duplicate plan IDs
  const idCounts = new Map();
  for (const plan of plans) {
    idCounts.set(plan.id, (idCounts.get(plan.id) || 0) + 1);
  }
  for (const [id, count] of idCounts.entries()) {
    if (count > 1) {
      errors.push(`Duplicate plan ID found: ${id} (${count} times)`);
    }
  }
  
  // Check for circular dependencies
  const depGraph = new Map();
  for (const plan of plans) {
    depGraph.set(plan.id, plan.depends_on || []);
  }
  
  const hasCycle = (start, visited = new Set(), recStack = new Set()) => {
    visited.add(start);
    recStack.add(start);
    
    const deps = depGraph.get(start) || [];
    for (const dep of deps) {
      if (!visited.has(dep)) {
        if (hasCycle(dep, visited, recStack)) return true;
      } else if (recStack.has(dep)) {
        return true;
      }
    }
    
    recStack.delete(start);
    return false;
  };
  
  const checked = new Set();
  for (const plan of plans) {
    if (!checked.has(plan.id)) {
      if (hasCycle(plan.id)) {
        errors.push(`Circular dependency detected involving plan: ${plan.id}`);
      }
      checked.add(plan.id);
    }
  }
  
  return errors;
}

/**
 * Generate roadmap markdown content
 */
function generateRoadmapContent(plans) {
  const sections = ['# Автоматический роадмап', '', 'Этот роадмап автоматически сгенерирован из метаданных планов.', '', '## Plan Register', '', '| ID | Status | Title |', '|----|--------|-------|'];
  for (const plan of plans) sections.push(`| ${plan.id} | ${plan.status} | ${plan.title} |`);
  sections.push('', '## Dependency Graph', '');
  const deps = plans.flatMap(plan => (plan.depends_on || []).map(dep => `${dep} → ${plan.id}`));
  sections.push(...(deps.length ? deps : ['No dependencies.']));
  return sections.join('\n');
}

/**
 * Roadmap command handler
 */
function roadmapCommand(args) {
  // Parse arguments
  const dryRun = args.includes('--dry-run');
  const outputArg = args.find(arg => arg.startsWith('--output='));
  const outputPath = outputArg ? outputArg.split('=')[1] : 'docs/roadmap/generated.md';
  
  // Collect plans
  const plansDir = join(ROOT, 'docs/architecture/plans');
  const plans = collectPlans(plansDir);
  
  // Validate
  const validationErrors = validatePlans(plans);
  
  if (validationErrors.length > 0) {
    console.log('Validation errors found:');
    for (const error of validationErrors) {
      console.log(`  - ${error}`);
    }
    process.exit(1);
  }
  
  // Generate content
  const content = generateRoadmapContent(plans);
  
  if (dryRun) {
    console.log('=== DRY RUN MODE ===\n');
    console.log(`Plans collected: ${plans.length}`);
    console.log(`Validation: PASSED`);
    console.log(`Output: ${outputPath}`);
    console.log('\n--- Generated content preview ---\n');
    console.log(content.slice(0, 500) + (content.length > 500 ? '...' : ''));
    return;
  }
  
  // Ensure output directory exists
  const outputDir = dirname(outputPath);
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }
  
  // Write output
  writeFileSync(outputPath, content, 'utf8');
  console.log(`Roadmap generated: ${outputPath}`);
  console.log(`Plans included: ${plans.length}`);
}

/**
 * Main CLI handler
 */
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const command = process.argv[2];
  const args = process.argv.slice(3);
  const rootArg = args.find(arg => arg.startsWith('--root='));
  const repositoryRoot = rootArg ? resolve(rootArg.slice('--root='.length)) : ROOT;
  switch (command) {
    case 'inventory': inventoryDocs(scanDocs(join(repositoryRoot, 'docs'))); break;
    case 'check': checkCommand(repositoryRoot); break;
    case 'roadmap': roadmapCommand(args); break;
    case 'rename:check': renameCheckCommand(repositoryRoot).catch(error => { console.error(error.message); process.exitCode = 1; }); break;
    default:
      console.log('Usage: node docs-governance.mjs <command> [options]');
      console.log('Commands: inventory, check, roadmap, rename:check');
      console.log('Roadmap options: --dry-run, --output=<path>');
      process.exit(1);
  }
}
