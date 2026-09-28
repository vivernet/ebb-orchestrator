import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { resolveOrchestratorHome } from "../src/platform/home/orchestrator-home.js";
import { createProductionPaths } from "../src/platform/home/production-paths.js";

describe("production path composition", () => {
  it("derives Git, integration, and Hermes paths from the configured Orchestrator home", () => {
    const home = resolveOrchestratorHome({ EBB_ORCHESTRATOR_HOME: "C:/test/orchestrator" }, "win32");

    expect(createProductionPaths(home)).toEqual({
      taskWorktreeDirectory: join(home.worktrees, "tasks"),
      integrationWorktreeRoot: join(home.worktrees, "epic-integration"),
      hermesDatabasePath: home.database,
      hermesResultDirectory: join(home.runtime, "hermes", "results"),
      hermesCheckpointDirectory: join(home.runtime, "checkpoints"),
    });
  });
});
