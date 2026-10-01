import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Проверяет статус только у записей Plan, не изменяя исходную запись.
 * @param {{kind?: string, status?: unknown} | null | undefined} record Проверяемая запись.
 * @returns {Array<{field: string, message: string}>} Найденные ошибки статуса либо пустой список.
 */
function validatePlanLifecycle(record) {
  if (record?.kind !== 'plan') return [];
  const statuses = ['proposed', 'planned', 'in_progress', 'blocked', 'completed', 'superseded', 'cancelled'];
  if (typeof record.status !== 'string' || !statuses.includes(record.status)) {
    return [{ field: 'status', message: `Invalid Plan lifecycle status: ${record.status ?? 'missing'}` }];
  }
  return [];
}

function parseFrontMatter(text) {
  if (!text.startsWith('---')) {
    return { data: {}, body: text.trim() };
  }
  const endMatch = text.indexOf('\n---\n', 1);
  if (endMatch === -1) {
    return { data: {}, body: text.trim() };
  }
  const yamlBlock = text.slice(4, endMatch);
  const body = text.slice(endMatch + 5).trim();
  const data = {};
  yamlBlock.split('\n').forEach(line => {
    line = line.trim();
    if (!line || line.startsWith('#')) return;
    const keyMatch = line.match(/^([^:]+):\s*/);
    if (keyMatch) {
      const key = keyMatch[1].trim();
      const value = line.slice(keyMatch[0].length).trim();
      data[key] = value;
    }
  });
  return { data, body };
}

function parseDocument(filePath, text) {
  const { data, body } = parseFrontMatter(text);
  return {
    id: data.id || null,
    kind: data.kind || null,
    title: data.title || null,
    status: data.status || null,
    created: data.created || null,
    updated: data.updated || null,
    depends_on: parseList(data.depends_on),
    specs: parseList(data.specs),
    evidence: parseList(data.evidence),
    body,
    filePath
  };
}

function parseList(value) {
  if (!value || typeof value !== 'string') return [];
  return value.split(/[,;]\s*/).filter(s => s.trim().length > 0);
}

const ID_REGEX = /^(roadmap|spec|plan|audit|proposal|guideline|ledger|reference|index)-[0-9]{2}(-[0-9]{2})?$/;
const KINDS = ['roadmap', 'spec', 'plan', 'audit', 'proposal', 'guideline', 'ledger', 'reference', 'index'];
const STATUSES = ['draft', 'in-progress', 'approved', 'deprecated', 'archived'];
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function validateDocument(record, catalog) {
  const issues = [];
  if (!record.id || !ID_REGEX.test(record.id)) issues.push({ field: 'id', message: 'Invalid or missing id' });
  if (!record.kind || !KINDS.includes(record.kind)) issues.push({ field: 'kind', message: 'Invalid or missing kind' });
  if (!record.title) issues.push({ field: 'title', message: 'Missing title' });
  if (!record.status || !STATUSES.includes(record.status)) issues.push({ field: 'status', message: 'Invalid or missing status' });
  if (!record.created || !DATE_REGEX.test(record.created)) issues.push({ field: 'created', message: 'Invalid or missing created date (YYYY-MM-DD)' });
  if (!record.updated || !DATE_REGEX.test(record.updated)) issues.push({ field: 'updated', message: 'Invalid or missing updated date (YYYY-MM-DD)' });
  return issues;
}

async function scanDocs(rootDir) {
  const { readdir, readFile, stat } = await import('fs/promises');
  const { join } = await import('path');
  const catalog = [];
  async function scan(dir) {
    try {
      const files = await readdir(dir);
      for (const f of files) {
        const filePath = join(dir, f);
        const isDir = (await stat(filePath)).isDirectory();
        if (isDir && f !== 'node_modules') {
          await scan(filePath);
        } else if (f.endsWith('.md') || f.endsWith('.mdx')) {
          const text = await readFile(filePath, 'utf-8');
          catalog.push(parseDocument(filePath, text));
        }
      }
    } catch (e) {
      // Silently ignore directory scan errors
    }
  }
  await scan(rootDir);
  return catalog;
}

function stripMarkdownCode(source) {
  let fence = null;
  return source.split(/\r?\n/).map((line) => {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      const token = marker[1];
      if (!fence) fence = { character: token[0], length: token.length };
      else if (token[0] === fence.character && token.length >= fence.length) fence = null;
      return '';
    }
    return fence || /^(?: {4}|\t)/.test(line) ? '' : line;
  }).join('\n');
}

function markdownHeadingAnchors(source) {
  const anchors = new Set();
  const occurrences = new Map();
  const visible = stripMarkdownCode(source);
  for (const match of visible.matchAll(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const explicit = match[1].match(/\s*\{#([^}]+)\}\s*$/);
    let heading = explicit ? match[1].slice(0, explicit.index) : match[1];
    heading = heading
      .replace(/`([^`]+)`/g, '$1')
      .replace(/!?\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]*>/g, '')
      .trim();
    const slug = heading.toLowerCase().replace(/[^\p{L}\p{N}_\- ]/gu, '').replace(/\s+/g, '-');
    const occurrence = occurrences.get(slug) ?? 0;
    occurrences.set(slug, occurrence + 1);
    anchors.add(explicit?.[1] ?? (occurrence === 0 ? slug : `${slug}-${occurrence}`));
  }
  for (const match of visible.matchAll(/\b(?:id|name)\s*=\s*(["'])(.*?)\1/gi)) anchors.add(match[2]);
  return anchors;
}

function extractMarkdownTargets(source) {
  const visible = stripMarkdownCode(source).replace(/(?<!\\)(`+)([\s\S]*?)\1/g, '');
  const targets = [];
  const definitions = new Map();
  for (const match of visible.matchAll(/^\s{0,3}\[([^\]]+)\]:\s*<?([^\s>]+)>?/gm)) {
    definitions.set(match[1].trim().toLowerCase().replace(/\s+/g, ' '), match[2]);
    targets.push(match[2]);
  }

  const inlinePattern = /!?\[[^\]]*\]\(\s*/g;
  for (const match of visible.matchAll(inlinePattern)) {
    let cursor = match.index + match[0].length;
    if (visible[cursor] === '<') {
      const end = visible.indexOf('>', cursor + 1);
      if (end !== -1) targets.push(visible.slice(cursor + 1, end));
      continue;
    }
    let value = '';
    let depth = 0;
    while (cursor < visible.length) {
      const character = visible[cursor];
      if (character === '\\' && cursor + 1 < visible.length) {
        value += visible[cursor + 1];
        cursor += 2;
        continue;
      }
      if (character === '(') depth += 1;
      else if (character === ')') {
        if (depth === 0) break;
        depth -= 1;
      } else if (/\s/.test(character) && depth === 0) break;
      value += character;
      cursor += 1;
    }
    if (value) targets.push(value);
  }

  const referencePattern = /!?\[([^\]]+)\](?:\[([^\]]*)\])?/g;
  for (const match of visible.matchAll(referencePattern)) {
    const label = (match[2] || match[1]).trim().toLowerCase().replace(/\s+/g, ' ');
    const target = definitions.get(label);
    if (target) targets.push(target);
  }

  for (const match of visible.matchAll(/\b(?:href|src)\s*=\s*(["'])(.*?)\1/gi)) targets.push(match[2]);
  return [...new Set(targets)];
}

/**
 * Проверяет относительные Markdown/HTML-ссылки на существование файла и якоря.
 * @param {Array<{filePath?: string, fullPath?: string, body?: string}>} catalog Документы с путём и текстом.
 * @returns {Array<{filePath: string, target: string, field: string, message: string}>} Найденные неразрешимые ссылки.
 */
function validateLinks(catalog) {
  const issues = [];
  for (const document of catalog) {
    const filePath = document.filePath ?? document.fullPath;
    if (typeof filePath !== 'string') continue;
    const source = typeof document.body === 'string' ? document.body : '';
    for (const target of extractMarkdownTargets(source)) {
      if (!target || target.startsWith('//') || target.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(target)) continue;
      let decodedTarget;
      try { decodedTarget = decodeURIComponent(target); } catch {
        issues.push({ filePath, target, field: 'link', message: `Broken relative link target: ${target}` });
        continue;
      }
      const hashIndex = decodedTarget.indexOf('#');
      const pathAndQuery = hashIndex === -1 ? decodedTarget : decodedTarget.slice(0, hashIndex);
      const rawFragment = hashIndex === -1 ? '' : decodedTarget.slice(hashIndex + 1).split('?')[0];
      const relativePath = pathAndQuery.split('?')[0];
      let fragment;
      try { fragment = decodeURIComponent(rawFragment); } catch { fragment = rawFragment; }
      const targetPath = relativePath ? resolve(dirname(filePath), relativePath) : filePath;
      if (!existsSync(targetPath)) {
        issues.push({ filePath, target, field: 'link', message: `Broken relative link target: ${target}` });
        continue;
      }
      if (!fragment || !/\.(?:md|mdx|html?)$/i.test(targetPath)) continue;
      let targetSource;
      try { targetSource = readFileSync(targetPath, 'utf8'); } catch { continue; }
      if (!markdownHeadingAnchors(targetSource).has(fragment)) {
        issues.push({ filePath, target, field: 'link', message: `Broken relative link anchor: ${target}` });
      }
    }
  }
  return issues;
}

/**
 * Разбирает таблицы migration map без обязательного legacy-столбца `roadmap/stage`.
 * @param {string} path Путь к Markdown-документу migration map.
 * @returns {Promise<{entries: Array<Record<string, string>>, path: string}>} Распознанные записи и исходный путь.
 * @throws {Error} Если файл невозможно прочитать.
 */
async function loadMigrationMap(path) {
  const { readFileSync } = await import('fs');
  const text = readFileSync(path, 'utf-8');
  const entries = [];
  const requiredHeaders = ['old path', 'new path', 'action', 'kind', 'source date', 'canonical target', 'conflict decision', 'dependent links to update', 'evidence preservation rule'];
  let headers = null;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) {
      headers = null;
      continue;
    }
    const columns = trimmed.replace(/^\||\|$/g, '').split('|').map(column => column.trim());
    const normalized = columns.map(column => column.toLowerCase().replace(/\s+/g, ' '));
    if (requiredHeaders.every(header => normalized.includes(header))) {
      headers = normalized;
      continue;
    }
    if (!headers || columns.every(column => /^:?-{3,}:?$/.test(column))) continue;
    if (columns.length !== headers.length) continue;
    const value = header => columns[headers.indexOf(header)];
    entries.push({
      oldPath: value('old path'),
      newPath: value('new path'),
      action: value('action'),
      kind: value('kind'),
      sourceDate: value('source date'),
      canonicalTarget: value('canonical target'),
      conflictDecision: value('conflict decision'),
      dependentLinksUpdate: value('dependent links to update'),
      evidencePreservation: value('evidence preservation rule')
    });
  }
  return { entries, path };
}

async function validateMigrationMap(map, inventory) {
  const issues = [];
  const oldPaths = new Set(map.entries.map(e => e.oldPath));
  const targetPaths = new Set();
  
  for (const entry of map.entries) {
    const hasEntry = inventory.some(i => i.filePath === entry.oldPath);
    if (!hasEntry) {
      issues.push({
        field: 'source_path',
        message: `Source path does not exist: ${entry.oldPath}`
      });
    }
    
    if (targetPaths.has(entry.newPath)) {
      if (entry.action !== 'merge') {
        issues.push({
          field: 'target_conflict',
          message: `Target path duplicated without merge action: ${entry.newPath}`
        });
      }
    } else {
      targetPaths.add(entry.newPath);
    }
  }
  
  const newInventory = inventory.filter(i => !oldPaths.has(i.filePath));
  if (newInventory.length > 0) {
    issues.push({
      field: 'incomplete_mapping',
      message: `Files not in migration map: ${newInventory.map(i => i.filePath).join(', ')}`
    });
  }
  
  return issues;
}

async function resolveCanonicalDocument(oldPath) {
  const { readFileSync } = await import('fs');
  const path = await import('path');
  const { fileURLToPath } = await import('url');
  const { dirname } = await import('path');
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const text = readFileSync(path.join(__dirname, '../docs/architecture/plans/governance/evidence/03-document-migration-map.md'), 'utf-8');
  const lines = text.split('\n');
  let inTable = false;
  
  // Strip backticks from oldPath if present
  const normalizedOldPath = oldPath.replace(/^`|`$/g, '');
  
  for (const line of lines) {
    if (line.startsWith('|')) {
      if (!inTable && line.includes('old path') && line.includes('new path')) {
        inTable = true;
        continue;
      }
      if (inTable && (line.startsWith('---') || line.trim() === '')) {
        inTable = false;
        continue;
      }
      if (inTable) {
        const cols = line.split('|').map(c => c.trim()).filter(c => c);
        if (cols.length >= 3) {
          // Strip backticks from oldPath in the table
          const tableOldPath = cols[0].replace(/^`|`$/g, '');
          if (tableOldPath === normalizedOldPath) {
            const action = cols[2];
            const target = cols[1].replace(/^`|`$/g, '');
            return { action, target };
          }
        }
      }
    }
  }
  return { action: 'keep', target: oldPath };
}

/**
 * Формирует модель роадмапа только из Plan и их зависимостей.
 * @param {Array<Record<string, unknown>>} catalog Проверяемые метаданные документов.
 * @returns {{generatedAt: string, plans: Array<{id: string, status: string, title: string, depends_on: string[]}>}} Модель Plan-реестра и зависимостей.
 */
function buildRoadmapModel(catalog) {
  return {
    generatedAt: new Date().toISOString().split('T')[0],
    plans: catalog.filter(record => record.kind === 'plan').map(({ id, status, title, depends_on }) => ({ id, status, title, depends_on: depends_on || [] }))
  };
}

/**
 * Рендерит канонический роадмап из Plan-реестра и зависимостей.
 * @param {{generatedAt: string, plans: Array<{id: string, status: string, title: string, depends_on?: string[]}>}} model Проверенная модель Plan-данных.
 * @returns {string} Содержимое Markdown-роадмапа.
 */
function renderRoadmap(model) {
  const { generatedAt, plans = [] } = model;
  
  let output = '# Единая дорожная карта проекта\n\n';
  output += `> Сгенерировано: ${generatedAt}\n\n`;
  
  output += '## Назначение и правила\n\n';
  output += 'Этот документ является единственным каноническим roadmap проекта. Его сводные таблицы и графы генерируются из metadata планов. Ручной текст ограничивается целями, решениями и правилами.\n\n';
  
  output += '<!-- BEGIN GENERATED: roadmap-summary -->\n\n';
  output += '## Plan Register\n\n| ID | Status | Title |\n|---|---|---|\n';
  plans.forEach(plan => { output += `| ${plan.id} | ${plan.status} | ${plan.title} |\n`; });
  output += '\n## Dependency Graph\n\n';
  const dependencies = plans.flatMap(plan => (plan.depends_on || []).map(dep => `${dep} → ${plan.id}`));
  output += dependencies.length ? `${dependencies.join('\n')}\n\n` : 'No dependencies.\n\n';
  
  output += '<!-- END GENERATED: roadmap-summary -->\n\n';
  
  output += '## Правила добавления нового Plan\n\n';
  output += '1. Создайте файл с числовым префиксом в `docs/architecture/plans/`\n';
  output += '2. Добавьте metadata-блок с обязательными полями: id, kind, title, status, created, updated\n';
  output += '3. Укажите зависимости через Plan IDs в поле depends_on\n';
  output += '4. Ссылайтесь на спецификации в поле specs\n';
  output += '5. Проверьте валидность через `pnpm docs:check`\n\n';
  
  output += '## Ссылки\n\n';
  output += '- [Документация](../README.md)\n';
  output += '- [Гайд по governance](/architecture/plans/governance/00-01-documentation-governance.md)\n';
  
  return output;
}

async function writeGeneratedRoadmap(path, content) {
  const { writeFileSync } = await import('fs');
  writeFileSync(path, content, 'utf-8');
}

async function isGeneratedRoadmapUpToDate(path, expected) {
  const { readFileSync } = await import('fs');
  try {
    const existing = readFileSync(path, 'utf-8');
    return existing === expected;
  } catch {
    return false;
  }
}


export {
  parseFrontMatter,
  validatePlanLifecycle,
  parseDocument,
  validateDocument,
  scanDocs,
  renderRoadmap,
  validateLinks,
  loadMigrationMap,
  validateMigrationMap,
  resolveCanonicalDocument,
  buildRoadmapModel,
  writeGeneratedRoadmap,
  isGeneratedRoadmapUpToDate
};
