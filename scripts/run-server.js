#!/usr/bin/env node
// Запускает production- или dev-сервер с корневой конфигурацией окружения.
import { spawn } from "node:child_process";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * Формирует единый cross-platform вызов Node для серверных режимов.
 * Корневой `.env` обрабатывает сам Node до entrypoint; process environment
 * передаётся без слияния и сохраняет приоритет над значениями файла.
 */
export function getLaunchConfig(argv = process.argv.slice(2)) {
  const [mode, ...forwardedArgs] = argv;
  const devMode = mode === "dev";
  const args = [
    `--env-file-if-exists=${join(repositoryRoot, ".env")}`,
    ...(devMode
      ? [
          join(repositoryRoot, "node_modules/tsx/dist/cli.mjs"),
          "watch",
          join(repositoryRoot, "apps/server/src/main.ts"),
        ]
      : [join(repositoryRoot, "apps/server/dist/main.js")]),
    ...(devMode ? forwardedArgs : argv),
  ];

  return {
    executable: "node",
    args,
    options: {
      cwd: repositoryRoot,
      env: process.env,
      shell: false,
      stdio: "inherit",
    },
  };
}

function runServer(argv) {
  const { executable, args, options } = getLaunchConfig(argv);
  const child = spawn(executable, args, options);
  child.on("error", (error) => {
    console.error(`Не удалось запустить сервер: ${error.message}`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invokedPath === pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "run-server.js")).href) {
  runServer(process.argv.slice(2));
}
