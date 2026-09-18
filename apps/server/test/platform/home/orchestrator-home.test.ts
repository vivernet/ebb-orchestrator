import { describe, expect, it } from "vitest";
import { resolveOrchestratorHome } from "../../../src/platform/home/orchestrator-home.js";

describe("resolveOrchestratorHome", () => {
  it("resolves an explicit EBB_ORCHESTRATOR_HOME", () => {
    const paths = resolveOrchestratorHome(
      { EBB_ORCHESTRATOR_HOME: "/tmp/orch" },
      "linux",
    );
    expect(paths.root).toBe("/tmp/orch");
    expect(paths.database).toBe("/tmp/orch/ebb-orchestrator.db");
    expect(paths.artifacts).toBe("/tmp/orch/artifacts");
    expect(paths.runtime).toBe("/tmp/orch/runtime");
    expect(paths.logs).toBe("/tmp/orch/logs");
    expect(paths.backups).toBe("/tmp/orch/backups");
    expect(paths.worktrees).toBe("/tmp/orch/worktrees");
  });

  it("resolves default home on linux", () => {
    const paths = resolveOrchestratorHome({ HOME: "/home/user" }, "linux");
    expect(paths.root).toBe("/home/user/.ebb-orchestrator");
    expect(paths.database).toBe("/home/user/.ebb-orchestrator/ebb-orchestrator.db");
    expect(paths.artifacts).toBe("/home/user/.ebb-orchestrator/artifacts");
  });

  it("resolves default home on win32 using USERPROFILE", () => {
    const paths = resolveOrchestratorHome(
      { USERPROFILE: "C:\\Users\\test" },
      "win32",
    );
    expect(paths.root).toBe("C:\\Users\\test\\.ebb-orchestrator");
    expect(paths.database).toBe("C:\\Users\\test\\.ebb-orchestrator\\ebb-orchestrator.db");
    expect(paths.artifacts).toBe("C:\\Users\\test\\.ebb-orchestrator\\artifacts");
    expect(paths.runtime).toBe("C:\\Users\\test\\.ebb-orchestrator\\runtime");
    expect(paths.logs).toBe("C:\\Users\\test\\.ebb-orchestrator\\logs");
  });

  it("resolves default home on darwin", () => {
    const paths = resolveOrchestratorHome({ HOME: "/Users/alice" }, "darwin");
    expect(paths.root).toBe("/Users/alice/.ebb-orchestrator");
    expect(paths.database).toBe("/Users/alice/.ebb-orchestrator/ebb-orchestrator.db");
  });

  it("returns typed OrchestratorHomePaths", () => {
    const paths = resolveOrchestratorHome(
      { EBB_ORCHESTRATOR_HOME: "/x" },
      "linux",
    );
    // Verify all expected keys are present
    const keys: Array<keyof typeof paths> = [
      "root",
      "database",
      "artifacts",
      "runtime",
      "logs",
      "backups",
      "worktrees",
    ];
    for (const key of keys) {
      expect(typeof paths[key]).toBe("string");
    }
  });

  it("throws when no home can be determined", () => {
    expect(() => resolveOrchestratorHome({}, "linux")).toThrow(
      /Cannot determine home directory/,
    );
  });
});
