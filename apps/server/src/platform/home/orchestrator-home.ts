/**
 * Resolves the orchestrator home directory and its well-known subpaths.
 *
 * Precedence:
 * 1. `EBB_ORCHESTRATOR_HOME` env var (explicit override)
 * 2. `~/.ebb-orchestrator/` (platform-appropriate default)
 */

import { posix, win32 } from "node:path";
import type { Platform } from "../config/app-config.js";

/** All well-known paths inside the orchestrator home directory. */
export interface OrchestratorHomePaths {
  /** Root of the orchestrator home. */
  root: string;
  /** Path to the SQLite database file. */
  database: string;
  /** Directory for build artifacts. */
  artifacts: string;
  /** Directory for runtime state. */
  runtime: string;
  /** Directory for log files. */
  logs: string;
  /** Directory for backup snapshots. */
  backups: string;
  /** Directory for git worktrees. */
  worktrees: string;
}

/**
 * Environment variables required for home resolution.
 * Only the relevant keys are accessed.
 */
export interface HomeEnv {
  EBB_ORCHESTRATOR_HOME?: string;
  /** Used as fallback on Windows when EBB_ORCHESTRATOR_HOME is not set. */
  USERPROFILE?: string;
  /** Used as fallback on POSIX when EBB_ORCHESTRATOR_HOME is not set. */
  HOME?: string;
}

/**
 * Select the appropriate `join` implementation for the target platform.
 * posix.join always uses forward slashes; path.join uses OS-native separators.
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
 * Resolve all well-known orchestrator home paths for the given environment and platform.
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
