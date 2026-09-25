#!/usr/bin/env node
// Запуск сервера Ebb Orchestrator без bootstrap-файлов и shell-подстановок.
import { spawn } from "node:child_process";

const child = spawn(process.execPath, ["apps/server/dist/main.js"], {
  stdio: "inherit",
  env: process.env,
  shell: false,
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
