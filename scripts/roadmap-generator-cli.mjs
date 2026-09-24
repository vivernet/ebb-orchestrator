#!/usr/bin/env node
/**
 * CLI для генерации roadmap из метаданных планов
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');

/**
 * Парсинг YAML frontmatter из markdown файла
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  
  try {
    return yaml.load(match[1]);
  } catch {
    return null;
  }
}

/**
 * Сбор всех планов из директории
 */
function collectPlans(dir) {
  const plans = [];
  
  function scan(dirPath) {
    if (!statSync(dirPath).isDirectory()) return;
    
    for (const entry of readdirSync(dirPath)) {
      const fullPath = join(dirPath, entry);
      const stat = statSync(fullPath);
      
      if (stat.isDirectory()) {
        scan(fullPath);
      } else if (entry.endsWith('.md') && entry.startsWith('plan-') === false) {
        const content = readFileSync(fullPath, 'utf8');
        const metadata = parseFrontmatter(content);
        
        if (metadata && metadata.status !== undefined) {
          plans.push({
            ...metadata,
            file_path: fullPath,
          });
        }
      }
    }
  }
  
  scan(dir);
  return plans;
}

/**
 * Генерация roadmap документа
 */
function generateRoadmap(plans) {
  const lines = [];
  
  // YAML header
  lines.push('---');
  lines.push('id: roadmap-01');
  lines.push('status: completed');
  lines.push('kind: roadmap');
  lines.push('title: Ebb Orchestrator Roadmap');
  lines.push('summary: Unified roadmap consolidating all stages and plans');
  lines.push(`created: 2026-09-16`);
  lines.push(`updated: ${new Date().toISOString().split('T')[0]}`);
  lines.push('---');
  lines.push('');
  lines.push('# Ebb Orchestrator Roadmap');
  lines.push('');
  lines.push('**Version:** Roadmap 01  ');
  lines.push(`**Last Updated:** ${new Date().toISOString().split('T')[0]}  `);
  lines.push('**Status:** Active');
  lines.push('');
  lines.push('> This document is auto-generated from plan metadata. For manual edits, see [Governance Guide](../architecture/plans/governance/00-01-documentation-governance.md).');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Table of Contents');
  lines.push('');
  lines.push('1. [Overview](#overview)');
  lines.push('2. [Global Stage Register](#global-stage-register)');
  lines.push('3. [Plan Register](#plan-register)');
  lines.push('4. [Dependency Graph](#dependency-graph)');
  lines.push('5. [Blockers and Evidence](#blockers-and-evidence)');
  lines.push('');
  lines.push('---');
  lines.push('');
  
  // Overview
  lines.push('## Overview');
  lines.push('');
  lines.push('This roadmap consolidates all stages and plans into a single canonical document.');
  lines.push('');
  
  // Stage Register
  lines.push('---');
  lines.push('');
  lines.push('## Global Stage Register');
  lines.push('');
  
  const stages = new Map();
  for (const plan of plans) {
    const stage = plan.stage;
    if (!stages.has(stage)) {
      stages.set(stage, { total: 0, completed: 0, title: plan.title || 'Plan' });
    }
    const s = stages.get(stage);
    s.total++;
    if (plan.status === 'completed') s.completed++;
  }
  
  lines.push('| Stage | Total | Done | Progress |');
  lines.push('|-------|-------|------|----------|');
  for (const [stage, data] of [...stages.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
    const progress = Math.round((data.completed / data.total) * 100);
    lines.push(`| ${stage} | ${data.total} | ${data.completed} | ${progress}% |`);
  }
  lines.push('');
  
  // Plan Register
  lines.push('---');
  lines.push('');
  lines.push('## Plan Register');
  lines.push('');
  lines.push('| ID | Stage | Status | Title |');
  lines.push('|----|-------|--------|-------|');
  
  for (const plan of plans) {
    lines.push(`| ${plan.id || 'N/A'} | ${plan.stage || 'N/A'} | ${plan.status || 'unknown'} | ${plan.title || 'Untitled'} |`);
  }
  lines.push('');
  
  // Dependency Graph
  lines.push('---');
  lines.push('');
  lines.push('## Dependency Graph');
  lines.push('');
  
  for (const plan of plans) {
    if (plan.depends_on && plan.depends_on.length > 0) {
      for (const dep of plan.depends_on) {
        lines.push(`${dep} → ${plan.id}`);
      }
    }
  }
  
  lines.push('');
  lines.push('---');
  lines.push('');
  
  // Blockers and Evidence
  lines.push('## Blockers and Evidence');
  lines.push('');
  lines.push('### Evidence Links');
  lines.push('');
  lines.push('| Evidence ID | Type | Link |');
  lines.push('|-------------|------|------|');
  lines.push('| E001 | Full Audit | docs/audit/01-full-audit.md |');
  lines.push('| E002 | Web UI Code Map | docs/audit/web-ui-code-map.md |');
  lines.push('| E003 | Web UI Gap Analysis | docs/audit/web-ui-gap-analysis.md |');
  lines.push('');
  
  return lines.join('\n');
}

// Main execution
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const outputArg = args.find(arg => arg.startsWith('--output='));
const outputPath = outputArg ? outputArg.split('=')[1] : 'docs/roadmap/generated.md';

// Collect plans
const plansDir = join(ROOT, 'docs/architecture/plans');
const plans = collectPlans(plansDir);

// Generate content
const content = generateRoadmap(plans);

if (dryRun) {
  console.log('=== DRY RUN MODE ===\n');
  console.log(`Plans collected: ${plans.length}`);
  console.log(`Output: ${outputPath}`);
  console.log('\n--- Generated content preview ---\n');
  console.log(content.slice(0, 500) + (content.length > 500 ? '...' : ''));
  process.exit(0);
}

// Ensure output directory exists
const outputDir = dirname(outputPath);
mkdirSync(outputDir, { recursive: true });

// Write output
writeFileSync(outputPath, content, 'utf8');
console.log(`Roadmap generated: ${outputPath}`);
console.log(`Plans included: ${plans.length}`);
