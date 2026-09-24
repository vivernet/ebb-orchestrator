#!/usr/bin/env node
/**
 * docs-governance.mjs - Documentation governance CLI
 * 
 * Commands: inventory, check, roadmap, rename:check
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'fs';
import { join, relative, extname, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';

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
  
  for (const file of files) {
    if (!file.metadata || !file.metadata.id) {
      issues.push({
        file: file.path,
        severity: 'error',
        message: 'Missing YAML frontmatter or id field'
      });
    }
    
    // Check filename pattern (allow README.md)
    const fileName = file.path.split('/').pop();
    if (fileName !== 'README.md' && !fileName.match(/^\d\d-/)) {
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
 * Check command
 */
function checkCommand() {
  const files = scanDocs(DOCS_ROOT);
  const issues = checkDocs(files);
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
 * Parse plan from file (inline YAML parsing)
 */
function parsePlanFile(path) {
  const content = readFileSync(path, 'utf8');
  const delimiter = '---';
  const parts = content.split(delimiter);
  
  if (parts.length < 3) {
    throw new Error(`File ${path} does not contain valid YAML frontmatter`);
  }
  
  try {
    const yamlContent = parts[1].trim();
    const metadata = yaml.load(yamlContent);
    
    if (!metadata.id || !metadata.kind || !metadata.roadmap) {
      throw new Error(`Plan in ${path} is missing required fields`);
    }
    
    return metadata;
  } catch (e) {
    const err = new Error(`Error parsing YAML from ${path}: ${e.message}`);
    err.cause = e;
    throw err;
  }
}

/**
 * Collect all plan files from directory
 */
function collectPlans(dir) {
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
      console.warn(`Failed to parse plan file: ${filePath}`, error.message);
    }
  }
  
  return plans;
}

/**
 * Group plans by stage
 */
function groupByStage(plans) {
  const grouped = new Map();
  
  for (const plan of plans) {
    const stage = plan.stage || 'unknown';
    if (!grouped.has(stage)) {
      grouped.set(stage, []);
    }
    grouped.get(stage).push(plan);
  }
  
  return grouped;
}

/**
 * Validate plans for uniqueness and circular dependencies
 */
function validatePlans(plans) {
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
  const sections = [
    '# Автоматический роадмап',
    '',
    'Этот роадмап автоматически сгенерирован из метаданных планов.',
    '',
    '## Stage Register',
    '',
  ];
  
  const stageGroups = groupByStage(plans);
  const sortedStages = Array.from(stageGroups.keys()).sort();
  
  sections.push('| Stage | Total | Done | Progress |');
  sections.push('|-------|-------|------|----------|');
  
  for (const stageId of sortedStages) {
    const stagePlans = stageGroups.get(stageId);
    const done = stagePlans.filter(p => p.status === 'completed' || p.status === 'done').length;
    const total = stagePlans.length;
    const progress = done === total ? '100%' : `${Math.round((done / total) * 100)}%`;
    sections.push(`| ${stageId} | ${total} | ${done} | ${progress} |`);
  }
  
  sections.push('');
  sections.push('## Plan Register');
  sections.push('');
  sections.push('| ID | Stage | Status | Title |');
  sections.push('|----|-------|--------|-------|');
  
  for (const plan of plans) {
    sections.push(`| ${plan.id} | ${plan.stage} | ${plan.status} | ${plan.title} |`);
  }
  
  sections.push('');
  sections.push('## Dependency Graph');
  sections.push('');
  
  const deps = [];
  for (const plan of plans) {
    if (plan.depends_on && plan.depends_on.length > 0) {
      for (const depId of plan.depends_on) {
        deps.push(`${plan.id} → ${depId}`);
      }
    }
  }
  
  if (deps.length === 0) {
    sections.push('No dependencies.');
  } else {
    sections.push(...deps);
  }
  
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
const command = process.argv[2];
const args = process.argv.slice(3);
switch (command) {
  case 'inventory': {
    const files = scanDocs(DOCS_ROOT);
    inventoryDocs(files);
    break;
  }
  case 'check':
    checkCommand();
    break;
  case 'roadmap':
    roadmapCommand(args);
    break;
  case 'rename:check':
    console.log('Rename check not yet implemented');
    break;
  default:
    console.log('Usage: node docs-governance.mjs <command> [options]');
    console.log('Commands: inventory, check, roadmap, rename:check');
    console.log('Roadmap options: --dry-run, --output=<path>');
    process.exit(1);
}
