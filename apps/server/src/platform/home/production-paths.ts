import { join } from "node:path";
import type { OrchestratorHomePaths } from "./orchestrator-home.js";

/**
 * Собирает пути production adapters из уже разрешённого Orchestrator home.
 * Функция не создаёт каталоги и не запускает процессы, поэтому её результат
 * можно проверить отдельно от startup lifecycle.
 */
export function createProductionPaths(home: OrchestratorHomePaths) {
  return {
    taskWorktreeDirectory: join(home.worktrees, "tasks"),
    epicWorktreeDirectory: join(home.worktrees, "epics"),
    integrationWorktreeRoot: join(home.worktrees, "epic-integration"),
    hermesDatabasePath: home.database,
    hermesResultDirectory: join(home.runtime, "hermes", "results"),
    hermesCheckpointDirectory: join(home.runtime, "checkpoints"),
  };
}
