/**
 * Определяет домашний каталог оркестратора и известные подпути.
 *
 * Приоритет источников:
 * 1. Переменная окружения `EBB_ORCHESTRATOR_HOME` (явное переопределение).
 * 2. `~/.ebb-orchestrator/` (platform-appropriate default)
 */

import { posix, win32 } from "node:path";
import type { Platform } from "../config/app-config.js";

/** Все известные пути внутри домашнего каталога оркестратора. */
export interface OrchestratorHomePaths {
  /** Корень домашнего каталога оркестратора. */
  root: string;
  /** Путь к файлу базы данных SQLite. */
  database: string;
  /** Каталог артефактов сборки. */
  artifacts: string;
  /** Каталог состояния runtime. */
  runtime: string;
  /** Каталог файлов журналов. */
  logs: string;
  /** Каталог резервных snapshots. */
  backups: string;
  /** Каталог Git worktrees. */
  worktrees: string;
}

/**
 * Переменные окружения, необходимые для определения домашнего каталога.
 * Читаются только относящиеся к делу ключи.
 */
export interface HomeEnv {
  EBB_ORCHESTRATOR_HOME?: string;
  /** Используется как fallback в Windows, если EBB_ORCHESTRATOR_HOME не задана. */
  USERPROFILE?: string;
  /** Используется как fallback в POSIX, если EBB_ORCHESTRATOR_HOME не задана. */
  HOME?: string;
}

/**
 * Выбирает подходящую реализацию `join` для целевой платформы.
 * posix.join всегда использует прямые слеши, а путь.join — разделители ОС.
 */
function platformJoin(platform: Platform): (a: string, b: string) => string {
  return platform === "win32" ? win32.join : posix.join;
}

function resolveHomeRoot(
  env: HomeEnv,
  platform: Platform,
  joinFn: (a: string, b: string) => string,
): string {
  if (env.EBB_ORCHESTRATOR_HOME) {
    return env.EBB_ORCHESTRATOR_HOME;
  }

  const homeBase = platform === "win32" ? env.USERPROFILE : env.HOME;

  if (!homeBase) {
    throw new Error(
      `Cannot determine home directory on ${platform}. ` +
        `Set EBB_ORCHESTRATOR_HOME or ensure the platform home env var is available.`,
    );
  }

  return joinFn(homeBase, ".ebb-orchestrator");
}

/**
 * Определяет все известные пути домашнего каталога оркестратора для указанного окружения и платформы.
 */
export function resolveOrchestratorHome(
  env: HomeEnv,
  platform: Platform,
): OrchestratorHomePaths {
  const joinFn = platformJoin(platform);
  const root = resolveHomeRoot(env, platform, joinFn);

  return {
    root,
    database: joinFn(root, "ebb-orchestrator.db"),
    artifacts: joinFn(root, "artifacts"),
    runtime: joinFn(root, "runtime"),
    logs: joinFn(root, "logs"),
    backups: joinFn(root, "backups"),
    worktrees: joinFn(root, "worktrees"),
  };
}
