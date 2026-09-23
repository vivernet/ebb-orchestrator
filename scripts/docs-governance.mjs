#!/usr/bin/env node
/**
 * docs-governance.mjs - Documentation governance CLI
 * 
 * Commands: inventory, check, roadmap, rename:check
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, relative, extname } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = dirname(__dirname);
const DOCS_ROOT = join(ROOT, 'docs');

/**
 * Parse YAML frontmatter from markdown content
 */
function parseFrontMatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  
  const yamlLines = match[1].split('\n');
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
    
    // Check filename pattern
    const fileName = file.path.split('/').pop();
    if (!fileName.match(/^\d\d-/)) {
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
 * Main CLI handler
 */
const command = process.argv[2];

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
    console.log('Roadmap generation not yet implemented');
    break;
  case 'rename:check':
    console.log('Rename check not yet implemented');
    break;
  default:
    console.log('Usage: node docs-governance.mjs <command>');
    console.log('Commands: inventory, check, roadmap, rename:check');
    process.exit(1);
}
