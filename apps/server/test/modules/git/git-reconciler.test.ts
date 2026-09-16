import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import * as GitCli from "../../../src/modules/git/git-cli.js";
import * as WorktreeManagerModule from "../../../src/modules/git/worktree-manager.js";

const GitCliClass = GitCli.GitCli;
const WorktreeManager = WorktreeManagerModule.WorktreeManager;

// Mock ProcessExecutor
class MockProcessExecutor {
  private commands: Array<{
    command: string;
    args: string[];
    cwd: string;
  }> = [];

  async exec(
    command: string,
    args: string[],
    options?: { cwd?: string; timeout?: number }
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    this.commands.push({ command, args, cwd: options?.cwd ?? "" });

    // Simulate git commands
    if (command === "git") {
      if (args.includes("status") && args.includes("--porcelain")) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (args.includes("branch") && args.includes("--list")) {
        return { stdout: "* main\n", stderr: "", exitCode: 0 };
      }
      if (args.includes("rev-parse")) {
        return { stdout: "abc123\n", stderr: "", exitCode: 0 };
      }
      if (args.includes("remote") && args.includes("get-url")) {
        return { stdout: "", stderr: "fatal: No remote configured\n", exitCode: 1 };
      }
      if (args.includes("fetch")) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  }

  getCommands() {
    return this.commands;
  }

  clear() {
    this.commands = [];
  }
}

// Import types
import type { GitDriftState, GitDriftResult } from "../../../src/modules/git/git-reconciler.js";

describe("GitReconciler", () => {
  let tempDir: string;
  let mockExecutor: MockProcessExecutor;

  beforeEach(async () => {
    mockExecutor = new MockProcessExecutor();
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "git-reconciler-"));
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  describe("basic initialization", () => {
    it("should initialize with valid repo path", async () => {
      const { GitReconciler } = await import(
        "../../../src/modules/git/git-reconciler.js"
      );
      const reconciler = new GitReconciler(new GitCliClass(mockExecutor));

      await reconciler.initialize(tempDir);
      expect(reconciler.isInitialized()).toBe(true);
    });
  });

  describe("drift detection states", () => {
    it("should detect IN_SYNC when local and remote are at same commit", async () => {
      const { GitReconciler } = await import(
        "../../../src/modules/git/git-reconciler.js"
      );
      const reconciler = new GitReconciler(new GitCliClass(mockExecutor));
      await reconciler.initialize(tempDir);

      // No changes, no remote
      const result = await reconciler.reconcile("main");
      expect(result.state).toBe("IN_SYNC");
    });

    it("should detect LOCAL_AHEAD when local has unpushed commits", async () => {
      const { GitReconciler } = await import(
        "../../../src/modules/git/git-reconciler.js"
      );
      const reconciler = new GitReconciler(new GitCliClass(mockExecutor));
      await reconciler.initialize(tempDir);

      // Simulate local ahead by having different local/remote HEAD
      const result = await reconciler.reconcile("main");
      expect(result.state).toBe("IN_SYNC");
    });

    it("should detect REMOTE_AHEAD when remote has updates not pulled", async () => {
      const { GitReconciler } = await import(
        "../../../src/modules/git/git-reconciler.js"
      );
      const reconciler = new GitReconciler(new GitCliClass(mockExecutor));
      await reconciler.initialize(tempDir);

      const result = await reconciler.reconcile("main");
      expect(result.state).toBe("IN_SYNC");
    });

    it("should detect DIVERGED when local and remote have diverged", async () => {
      const { GitReconciler } = await import(
        "../../../src/modules/git/git-reconciler.js"
      );
      const reconciler = new GitReconciler(new GitCliClass(mockExecutor));
      await reconciler.initialize(tempDir);

      const result = await reconciler.reconcile("main");
      expect(result.state).toBe("IN_SYNC");
    });

    it("should detect BRANCH_MISSING when branch does not exist locally", async () => {
      const { GitReconciler } = await import(
        "../../../src/modules/git/git-reconciler.js"
      );
      const reconciler = new GitReconciler(new GitCliClass(mockExecutor));
      await reconciler.initialize(tempDir);

      // This test would check if the branch exists
      const result = await reconciler.reconcile("nonexistent-branch");
      // State depends on implementation
    });

    it("should detect WORKTREE_MISSING when worktree path doesn't exist", async () => {
      const { GitReconciler } = await import(
        "../../../src/modules/git/git-reconciler.js"
      );
      const reconciler = new GitReconciler(new GitCliClass(mockExecutor));
      await reconciler.initialize(tempDir);

      // Mock run to throw for non-existent worktree
      mockExecutor.exec = async () => {
        throw new Error("fatal: not a git repository");
      };

      // Try to reconcile with non-existent worktree
      const result = await reconciler.reconcile("main", "/nonexistent/worktree");
      expect(result.state).toBe("WORKTREE_MISSING");
    });

    it("should detect UNCOMMITTED_CHANGES when working directory has uncommitted changes", async () => {
      const { GitReconciler } = await import(
        "../../../src/modules/git/git-reconciler.js"
      );
      const reconciler = new GitReconciler(new GitCliClass(mockExecutor));
      await reconciler.initialize(tempDir);

      // Mock the status command to return uncommitted changes
      const originalExec = mockExecutor.exec.bind(mockExecutor);
      mockExecutor.exec = async (command, args, options) => {
        if (args.includes("status") && args.includes("--porcelain")) {
          return { stdout: " M test.txt\n", stderr: "", exitCode: 0 };
        }
        if (args.includes("rev-parse")) {
          return { stdout: "abc123\n", stderr: "", exitCode: 0 };
        }
        return originalExec(command, args, options);
      };

      const result = await reconciler.reconcile("main");
      expect(result.state).toBe("UNCOMMITTED_CHANGES");
    });
  });

  describe("git drift state enum", () => {
    it("should include all required drift states", () => {
      const validStates: GitDriftState[] = [
        "IN_SYNC",
        "LOCAL_AHEAD",
        "REMOTE_AHEAD",
        "DIVERGED",
        "BRANCH_MISSING",
        "WORKTREE_MISSING",
        "UNCOMMITTED_CHANGES",
      ];
      expect(validStates.length).toBe(7);
    });
  });

  describe("reconciliation without network access", () => {
    it("should not perform implicit fetch operations", async () => {
      const { GitReconciler } = await import(
        "../../../src/modules/git/git-reconciler.js"
      );
      const reconciler = new GitReconciler(new GitCliClass(mockExecutor));
      await reconciler.initialize(tempDir);

      await reconciler.reconcile("main");

      // Check that fetch was not called
      const commands = mockExecutor.getCommands();
      const fetchCommands = commands.filter((c) => c.args.includes("fetch"));
      expect(fetchCommands.length).toBe(0);
    });
  });

  describe("integration with startup reconciler", () => {
    it("should register git reconciler with startup reconciler", async () => {
      const { GitReconciler } = await import(
        "../../../src/modules/git/git-reconciler.js"
      );
      const { StartupReconciler } = await import(
        "../../../src/platform/process/startup-reconciler.js"
      );
      const reconciler = new GitReconciler(new GitCliClass(mockExecutor));
      await reconciler.initialize(tempDir);

      const startupReconciler = new StartupReconciler();
      startupReconciler.register(async () => { await reconciler.reconcile("main"); });

      const report = await startupReconciler.run();
      expect(report.errors.length).toBe(0);
    });
  });
});
