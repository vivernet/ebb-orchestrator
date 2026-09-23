#!/usr/bin/env node
// Запуск сервера Ebb Orchestrator
import { spawn } from 'node:child_process';

const env = { ...process.env };
env.EBB_ORCHESTRATOR_BOOTSTRAP_FILE = 
  process.env.EBB_ORCHESTRATOR_BOOTSTRAP_FILE || 
  `${process.env.APPDATA || `${process.env.USERPROFILE}\.appdata\local`}\.ebb-orchestrator\bootstrap.json`;

const child = spawn('node', ['apps/server/dist/main.js'], {
  stdio: 'inherit',
  env

  detached: true
});

child.on('exit', (code) => {
  console.log(`Server exited with code ${code}`);
  process.exit(code);
});
