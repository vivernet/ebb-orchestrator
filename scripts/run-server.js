#!/usr/bin/env node
// Запускает production- или dev-сервер с корневой конфигурацией окружения.
import { spawn } from "node:child_process";
import { clearTimeout, setTimeout } from "node:timers";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * Маппит POSIX-сигнал в код выхода оболочки (128 + номер сигнала).
 * Для неизвестных/пустых сигналов возвращает 1.
 */
export function signalExitCode(signal) {
  const signalNumbers = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGILL: 4,
    SIGTRAP: 5,
    SIGABRT: 6,
    SIGBUS: 7,
    SIGFPE: 8,
    SIGKILL: 9,
    SIGUSR1: 10,
    SIGSEGV: 11,
    SIGUSR2: 12,
    SIGPIPE: 13,
    SIGALRM: 14,
    SIGTERM: 15,
    SIGSTKFLT: 16,
    SIGCHLD: 17,
    SIGCONT: 18,
    SIGSTOP: 19,
    SIGTSTP: 20,
    SIGTTIN: 21,
    SIGTTOU: 22,
    SIGURG: 23,
    SIGXCPU: 24,
    SIGXFSZ: 25,
    SIGVTALRM: 26,
    SIGPROF: 27,
    SIGWINCH: 28,
    SIGIO: 29,
    SIGPWR: 30,
    SIGSYS: 31,
  };
  const number = signalNumbers[signal];
  return number === undefined ? 1 : 128 + number;
}

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
  let shutdownInProgress = false;
  let forceTimer;

  /**
   * Пересылает lifecycle-сигнал ребёнку и ждёт его выхода. Повторные сигналы
   * игнорируются; если ребёнок не завершился за грацию, он принудительно
   * завершается, чтобы лаунчер не завис навсегда.
   */
  const forwardSignal = (signal) => {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    try {
      child.kill(signal);
    } catch {
      // Ребёнок уже завершился; exit-обработчик завершит лаунчер.
    }
    forceTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Игнорируем: ребёнок уже завершился.
      }
    }, 10_000);
    child.once("exit", () => clearTimeout(forceTimer));
  };

  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));

  child.on("error", (error) => {
    console.error(`Не удалось запустить сервер: ${error.message}`);
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      // Сигнальное завершение ребёнка: воспроизводим его смысл кодом выхода.
      process.exit(signalExitCode(signal));
    }
    process.exit(code ?? 1);
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invokedPath === pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "run-server.js")).href) {
  runServer(process.argv.slice(2));
}
