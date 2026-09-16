import { describe, expect, it } from "vitest";
import { resolveOrchestratorHome } from "../../../src/platform/home/orchestrator-home.js";

describe("resolveOrchestratorHome", () => {
  it("resolves an explicit ORCHESTRATOR_HOME", () => {
    const paths = resolveOrchestratorHome(
      { ORCHESTRATOR_HOME: "/tmp/orch" },
      "linux",
    );
    expect(paths.root).toBe("/tmp/orch");
    expect(paths.database).toBe("/tmp/orch/orchestrator.db");
    expect(paths.artifacts).toBe("/tmp/orch/artifacts");
    expect(paths.runtime).toBe("/tmp/orch/runtime");
    expect(paths.logs).toBe("/tmp/orch/logs");
    expect(paths.backups).toBe("/tmp/orch/backups");
    expect(paths.worktrees).toBe("/tmp/orch/worktrees");
  });

  it("resolves default home on linux", () => {
    const paths = resolveOrchestratorHome({ HOME: "/home/user" }, "linux");
    expect(paths.root).toBe("/home/user/.orchestrator");
    expect(paths.database).toBe("/home/user/.orchestrator/orchestrator.db");
    expect(paths.artifacts).toBe("/home/user/.orchestrator/artifacts");
  });

  it("resolves default home on win32 using USERPROFILE", () => {
    const paths = resolveOrchestratorHome(
      { USERPROFILE: "C:\\Users\\test" },
      "win32",
    );
    expect(paths.root).toBe("C:\\Users\\test\\.orchestrator");
    expect(paths.database).toBe("C:\\Users\\test\\.orchestrator\\orchestrator.db");
    expect(paths.artifacts).toBe("C:\\Users\\test\\.orchestrator\\artifacts");
    expect(paths.runtime).toBe("C:\\Users\\test\\.orchestrator\\runtime");
    expect(paths.logs).toBe("C:\\Users\\test\\.orchestrator\\logs");
  });

  it("resolves default home on darwin", () => {
    const paths = resolveOrchestratorHome({ HOME: "/Users/alice" }, "darwin");
    expect(paths.root).toBe("/Users/alice/.orchestrator");
    expect(paths.database).toBe("/Users/alice/.orchestrator/orchestrator.db");
  });

  it("returns typed OrchestratorHomePaths", () => {
    const paths = resolveOrchestratorHome(
      { ORCHESTRATOR_HOME: "/x" },
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
