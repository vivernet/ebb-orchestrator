#!/usr/bin/env node
// Запуск сервера Ebb Orchestrator
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const env = process.env;
env.EBB_ORCHESTRATOR_BOOTSTRAP_FILE =
  process.env.EBB_ORCHESTRATOR_BOOTSTRAP_FILE ||
  join(process.env.USERPROFILE, '.ebb-orchestrator', 'bootstrap.json');

const child = spawn('node', ['apps/server/dist/main.js'], {
  stdio: 'inherit',
  env,
});

child.on('exit', (code) => {
  process.exit(code);
});
