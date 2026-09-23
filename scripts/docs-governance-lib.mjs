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

function validateLinks(catalog) {
  const issues = [];
  return issues;
}

async function loadMigrationMap(path) {
  const { readFileSync } = await import('fs');
  const text = readFileSync(path, 'utf-8');
  const entries = [];
  const lines = text.split('\n');
  let inTable = false;
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
        if (cols.length >= 10) {
          entries.push({
            oldPath: cols[0],
            newPath: cols[1],
            action: cols[2],
            kind: cols[3],
            roadmapStage: cols[4],
            sourceDate: cols[5],
            canonicalTarget: cols[6],
            conflictDecision: cols[7],
            dependentLinksUpdate: cols[8],
            evidencePreservation: cols[9]
          });
        }
      }
    }
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

function buildRoadmapModel(catalog) {
  const roadmap = catalog.filter(r => r.kind === 'roadmap');
  const plans = catalog.filter(r => r.kind === 'plan');
  const proposals = catalog.filter(r => r.kind === 'proposal');
  
  const stagesMap = {};
  plans.forEach(plan => {
    const stage = plan.stage || '00';
    if (!stagesMap[stage]) {
      stagesMap[stage] = { stage, plans: [] };
    }
    stagesMap[stage].plans.push({
      id: plan.id,
      title: plan.title,
      status: plan.status,
      depends_on: plan.depends_on || []
    });
  });
  
  const stages = Object.values(stagesMap).sort((a, b) => a.stage.localeCompare(b.stage));
  
  const model = {
    generatedAt: new Date().toISOString().split('T')[0],
    stages,
    plans: plans.map(p => ({ id: p.id, status: p.status, title: p.title })),
    proposals: proposals.map(p => ({ id: p.id, status: p.status, title: p.title })),
    roadmap
  };
  
  return model;
}

function renderRoadmap(model) {
  const { generatedAt, stages, plans, proposals } = model;
  
  let output = '# Единая дорожная карта проекта\n\n';
  output += `> Сгенерировано: ${generatedAt}\n\n`;
  
  output += '## Назначение и правила\n\n';
  output += 'Этот документ является единственным каноническим roadmap проекта. Его сводные таблицы и графы генерируются из metadata планов. Ручной текст ограничивается целями, решениями и правилами.\n\n';
  
  output += '<!-- BEGIN GENERATED: roadmap-summary -->\n\n';
  output += '## Roadmap 01\n\n';
  
  stages.forEach(stage => {
    output += `### Stage ${stage.stage}\n\n`;
    stage.plans.forEach(plan => {
      output += `- [${plan.status}] ${plan.title} (${plan.id})\n`;
    });
    output += '\n';
  });
  
  output += '<!-- END GENERATED: roadmap-summary -->\n\n';
  
  if (proposals.length > 0) {
    output += '## Предложения\n\n';
    proposals.forEach(p => {
      output += `- [${p.status}] ${p.title} (${p.id})\n`;
    });
    output += '\n';
  }
  
  output += '## Правила добавления нового Stage/Plan\n\n';
  output += '1. Создайте файл с числовым префиксом в `docs/architecture/plans/`\n';
  output += '2. Добавьте metadata-блок с обязательными полями: id, kind, title, status, created, updated\n';
  output += '3. Укажите roadmap и stage номера\n';
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
