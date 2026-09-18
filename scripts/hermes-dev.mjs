#!/usr/bin/env node

import { spawnSync, execFileSync } from 'node:child_process';
import { rmSync, mkdirSync, copyFileSync, readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';

function hermesConfigSet(key, value) {
  const result = spawnSync('hermes', ['config', 'set', key, value], { encoding: 'utf8' });
  if (result.status !== 0) {
    console.error(`Failed to set hermes config ${key}:`, result.stderr);
    process.exit(1);
  }
}

function hermesConfigGet(key) {
  const result = spawnSync('hermes', ['config', 'get', key], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

function sha256(path) {
  const content = readFileSync(path);
  return createHash('sha256').update(content).digest('hex');
}

function main() {
  const command = process.argv[2];
  if (!command) {
    console.error('Usage: hermes-dev.js <setup|check|execute> [args...]');
    process.exit(1);
  }

  switch (command) {
    case 'setup':
      doSetup();
      break;
    case 'check':
      doCheck();
      break;
    case 'execute':
      doExecute(process.argv.slice(3));
      break;
    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}

function doSetup() {
  console.log('Setting up Hermes development environment...');

  // 1. Get Git worktree root
  const gitResult = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (gitResult.status !== 0) {
    console.error('Not in a Git repository');
    process.exit(1);
  }
  const worktreeRoot = gitResult.stdout.trim();

  // 2. Resolve HERMES_HOME
  const hermesHome = process.env.HERMES_HOME || join(homedir(), '.hermes');

  // 3. Source and target paths
  const sourceSkills = join(worktreeRoot, 'tools', 'hermes', 'skills');
  const targetRoot = join(hermesHome, 'skills', 'ebb-orchestrator');

  // 4. Remove and recreate target
  if (statSync(targetRoot, { throwIfNoEntry: false })) {
    rmSync(targetRoot, { recursive: true, force: true });
  }
  mkdirSync(targetRoot, { recursive: true });

  // 5. Copy skills
  const skillDirs = readdirSync(sourceSkills);
  for (const dir of skillDirs) {
    const sourceDir = join(sourceSkills, dir);
    const targetDir = join(targetRoot, dir);
    if (statSync(sourceDir).isDirectory()) {
      mkdirSync(targetDir, { recursive: true });
      const files = readdirSync(sourceDir);
      for (const file of files) {
        copyFileSync(join(sourceDir, file), join(targetDir, file));
      }
    }
  }

  // 6. Configure Hermes
  console.log('Configuring Hermes...');
  hermesConfigSet('delegation.max_concurrent_children', '2');
  hermesConfigSet('delegation.max_spawn_depth', '1');
  hermesConfigSet('delegation.orchestrator_enabled', 'false');
  hermesConfigSet('delegation.worktree_isolation', 'false');

  console.log('Setup complete.');
}

function doCheck() {
  console.log('Checking Hermes development environment...');

  const checks = [];
  let allPass = true;

  // 1. hermes --version
  try {
    execFileSync('hermes', ['--version'], { stdio: 'pipe' });
    checks.push({ name: 'hermes --version', pass: true });
  } catch {
    checks.push({ name: 'hermes --version', pass: false });
    allPass = false;
  }

  // 2. .hermes.md exists
  const hermesMdPath = join(process.cwd(), '.hermes.md');
  checks.push({
    name: '.hermes.md exists',
    pass: statSync(hermesMdPath, { throwIfNoEntry: false }) !== undefined
  });
  if (!checks[1].pass) allPass = false;

  // 3-6. Source skill files exist
  const sourceSkills = join(process.cwd(), 'tools', 'hermes', 'skills');
  const skills = ['ebb-execute-plan', 'ebb-implement-task', 'ebb-review-task', 'ebb-final-review'];
  for (const skill of skills) {
    const path = join(sourceSkills, skill, 'SKILL.md');
    const pass = statSync(path, { throwIfNoEntry: false }) !== undefined;
    checks.push({ name: `Source: ${skill}`, pass });
    if (!pass) allPass = false;
  }

  // 7-10. Target skill files exist and match hash
  const hermesHome = process.env.HERMES_HOME || join(homedir(), '.hermes');
  const targetRoot = join(hermesHome, 'skills', 'ebb-orchestrator');
  for (const skill of skills) {
    const sourcePath = join(sourceSkills, skill, 'SKILL.md');
    const targetPath = join(targetRoot, skill, 'SKILL.md');
    const sourceExists = statSync(sourcePath, { throwIfNoEntry: false }) !== undefined;
    const targetExists = statSync(targetPath, { throwIfNoEntry: false }) !== undefined;
    const hashMatch = sourceExists && targetExists && sha256(sourcePath) === sha256(targetPath);
    checks.push({ name: `Target match: ${skill}`, pass: hashMatch });
    if (!hashMatch) allPass = false;
  }

  // 11-14. Hermes config
  const configChecks = [
    ['delegation.max_concurrent_children', '2'],
    ['delegation.max_spawn_depth', '1'],
    ['delegation.orchestrator_enabled', 'false'],
    ['delegation.worktree_isolation', 'false']
  ];
  for (const [key, expected] of configChecks) {
    const value = hermesConfigGet(key);
    checks.push({ name: `Config: ${key}`, pass: value === expected });
    if (value !== expected) allPass = false;
  }

  // Print results
  console.log('');
  console.log('Check results:');
  for (const check of checks) {
    console.log(`  ${check.pass ? 'PASS' : 'FAIL'}: ${check.name}`);
  }

  if (!allPass) {
    console.log('');
    console.log('Some checks failed. Run `pnpm hermes:setup` to fix.');
    process.exit(1);
  }
  console.log('');
  console.log('All checks passed.');
}

function doExecute(args) {
  // Handle -- separator that may be passed by package managers
  args = args.filter(a => a !== '--');
  if (args.length === 0) {
    console.error('Usage: hermes-dev.js execute <plan-path>');
    process.exit(1);
  }

  const planPath = args[0];
  const worktreeRoot = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim();

  // Normalize paths - convert to Windows native format for comparison
  const normalizePath = (p) => {
    // Handle MSYS-style paths (/c/Users/...) -> Windows (C:\Users\...)
    if (p.startsWith('/') && p.match(/^\/[a-z]\//i)) {
      p = p.replace(/^\/([a-z])\//i, '$1:\\')
        .replace(/\//g, '\\');
    }
    // Normalize backslashes to forward slashes for comparison
    return p.replace(/\\/g, '/');
  };

  const resolvedPlan = normalizePath(planPath);
  const normalizedWorktree = normalizePath(worktreeRoot);

  // Resolve plan path relative to worktree unless absolute
  const finalPlan = resolvedPlan.match(/^([a-z]:|[\\/])/i)
    ? resolvedPlan
    : `${normalizedWorktree}/${resolvedPlan}`;

  // Validate path doesn't escape worktree
  if (!finalPlan.startsWith(normalizedWorktree.replace(/\\/g, '/'))) {
    console.error('Error: plan path escapes current worktree');
    process.exit(1);
  }

  // Validate plan file exists
  if (!statSync(resolvedPlan, { throwIfNoEntry: false })) {
    console.error(`Error: plan file not found: ${resolvedPlan}`);
    process.exit(1);
  }

  // Create temporary prompt file
  const tmpDir = process.env.TEMP || process.env.TMPDIR || join(homedir(), 'tmp');
  const tmpFile = join(tmpDir, `hermes-prompt-${Date.now()}.txt`);

  try {
    const promptContent = `You are executing trusted Ebb Orchestrator development work.

Read .hermes.md for project instructions.
Use ebb-execute-plan skill to execute the plan.
Plan path: ${planPath}
EXECUTE the plan, do not only summarize.
Max 2 concurrent subagents.
No nested delegation.
`;

    writeFileSync(tmpFile, promptContent);

    // Spawn hermes in one-shot mode
    const result = spawnSync('hermes', [
      '-z', promptContent,
      '--in', worktreeRoot
    ], {
      stdio: 'inherit',
      encoding: 'utf8'
    });

    process.exit(result.status);
  } finally {
    rmSync(tmpFile, { force: true });
  }
}

main();
