#!/usr/bin/env node
// Запуск сервера Ebb Orchestrator
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const env = process.env;
// Use Windows-style path for bootstrap file
env.EBB_ORCHESTRATOR_BOOTSTRAP_FILE =
  process.env.EBB_ORCHESTRATOR_BOOTSTRAP_FILE ||
  join(process.env.LOCALAPPDATA || `${process.env.USERPROFILE}\\AppData\\Local`, 'ebb-orchestrator', 'bootstrap.json');

const child = spawn('node', ['apps/server/dist/main.js'], {
  stdio: 'inherit',
  env,
  detached: true,
});

child.on('exit', (code) => {
  console.log(`Server exited with code ${code}`);
  process.exit(code);
});
