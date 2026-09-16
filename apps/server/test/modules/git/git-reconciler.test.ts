import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import * as GitCli from "../../../src/modules/git/git-cli.js";

const GitCliClass = GitCli.GitCli;

// Mock ProcessExecutor with configurable responses
class MockProcessExecutor {
  private commands: Array<{
    command: string;
    args: string[];
    cwd: string;
  }> = [];

  // Configurable return values for different scenarios
  mockReturn: {
    status: { stdout: string; stderr: string; exitCode: number };
    revList: { stdout: string; stderr: string; exitCode: number; shouldThrow?: boolean };
    branchList: { stdout: string; stderr: string; exitCode: number };
    remoteUrl: { stdout: string; stderr: string; exitCode: number };
    fetch: { stdout: string; stderr: string; exitCode: number };
    // Configurable responses for specific rev-parse commands
    isInsideWorkTree: { stdout: string; stderr: string; exitCode: number; shouldThrow?: boolean };
    verifyBranch: { stdout: string; stderr: string; exitCode: number; shouldThrow?: boolean };
    getHead: { stdout: string; stderr: string; exitCode: number };
    getRemoteRef: { stdout: string; stderr: string; exitCode: number; shouldThrow?: boolean };
  } = {
    status: { stdout: "", stderr: "", exitCode: 0 },
    revList: { stdout: "0\n", stderr: "", exitCode: 0 },
    branchList: { stdout: "* main\n", stderr: "", exitCode: 0 },
    remoteUrl: { stdout: "https://github.com/test/repo.git\n", stderr: "", exitCode: 0 },
    fetch: { stdout: "", stderr: "", exitCode: 0 },
    isInsideWorkTree: { stdout: "true\n", stderr: "", exitCode: 0 },
    verifyBranch: { stdout: "abc123\n", stderr: "", exitCode: 0 },
    getHead: { stdout: "abc123\n", stderr: "", exitCode: 0 },
    getRemoteRef: { stdout: "abc123\n", stderr: "", exitCode: 0 },
  };

  async exec(
    command: string,
    args: string[],
    options?: { cwd?: string; timeout?: number }
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    this.commands.push({ command, args, cwd: options?.cwd ?? "" });

    if (command === "git") {
      if (args.includes("status") && args.includes("--porcelain")) {
        return this.mockReturn.status;
      }
      if (args.includes("branch") && args.includes("--list")) {
        return this.mockReturn.branchList;
      }
      if (args.includes("rev-parse")) {
        // Handle different rev-parse subcommands
        if (args.includes("--is-inside-work-tree")) {
          if (this.mockReturn.isInsideWorkTree.shouldThrow) {
            throw new Error(this.mockReturn.isInsideWorkTree.stderr);
          }
          return this.mockReturn.isInsideWorkTree;
        }
        if (args.includes("--verify")) {
          if (this.mockReturn.verifyBranch.shouldThrow) {
            throw new Error(this.mockReturn.verifyBranch.stderr);
          }
          return this.mockReturn.verifyBranch;
        }
        if (args.some(a => a.includes("HEAD"))) {
          return this.mockReturn.getHead;
        }
        if (args.some(a => a.includes("refs/remotes/origin/"))) {
          if (this.mockReturn.getRemoteRef.shouldThrow) {
            throw new Error(this.mockReturn.getRemoteRef.stderr);
          }
          return this.mockReturn.getRemoteRef;
        }
        // Default rev-parse
        return this.mockReturn.getHead;
      }
      if (args.includes("rev-list") && args.includes("--count")) {
        if (this.mockReturn.revList.shouldThrow) {
          throw new Error(this.mockReturn.revList.stderr);
        }
        const revListArg = args.find(a => a.includes(".."));
        if (revListArg) {
          const parts = revListArg.split("..");
          if (parts.length === 2) {
            const [fromRef, toRef] = parts as [string, string];
            return { stdout: fromRef < toRef ? "1\n" : "0\n", stderr: "", exitCode: 0 };
          }
        }
        return this.mockReturn.revList;
      }
      if (args.includes("remote") && args.includes("get-url")) {
        return this.mockReturn.remoteUrl;
      }
      if (args.includes("fetch")) {
        return this.mockReturn.fetch;
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

  resetMockReturn() {
    this.mockReturn = {
      status: { stdout: "", stderr: "", exitCode: 0 },
      revList: { stdout: "0\n", stderr: "", exitCode: 0 },
      branchList: { stdout: "* main\n", stderr: "", exitCode: 0 },
      remoteUrl: { stdout: "https://github.com/test/repo.git\n", stderr: "", exitCode: 0 },
      fetch: { stdout: "", stderr: "", exitCode: 0 },
      isInsideWorkTree: { stdout: "true\n", stderr: "", exitCode: 0 },
      verifyBranch: { stdout: "abc123\n", stderr: "", exitCode: 0 },
      getHead: { stdout: "abc123\n", stderr: "", exitCode: 0 },
      getRemoteRef: { stdout: "abc123\n", stderr: "", exitCode: 0 },
    };
  }
}

// Import types
import type { GitDriftState } from "../../../src/modules/git/git-reconciler.js";

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

      // Setup: no uncommitted changes, both refs exist and match
      mockExecutor.mockReturn.status = { stdout: "", stderr: "", exitCode: 0 };
      mockExecutor.mockReturn.getHead = { stdout: "abc123\n", stderr: "", exitCode: 0 };
      mockExecutor.mockReturn.getRemoteRef = { stdout: "abc123\n", stderr: "", exitCode: 0 };
      mockExecutor.mockReturn.revList = { stdout: "0\n", stderr: "", exitCode: 0 };

      const result = await reconciler.reconcile("main");
      expect(result.state).toBe("IN_SYNC");
      expect(result.localRef).toBe("abc123");
      expect(result.remoteRef).toBe("abc123");
    });

    it("should detect LOCAL_AHEAD when local has unpushed commits", async () => {
      const { GitReconciler } = await import(
        "../../../src/modules/git/git-reconciler.js"
      );
      const reconciler = new GitReconciler(new GitCliClass(mockExecutor));
      await reconciler.initialize(tempDir);

      // Setup: local at abc123, remote at abc122, local ahead by 1
      mockExecutor.mockReturn.status = { stdout: "", stderr: "", exitCode: 0 };
      mockExecutor.mockReturn.getHead = { stdout: "abc123\n", stderr: "", exitCode: 0 };
      mockExecutor.mockReturn.getRemoteRef = { stdout: "abc122\n", stderr: "", exitCode: 0 };
      mockExecutor.mockReturn.revList = { stdout: "1\n", stderr: "", exitCode: 0 }; // ahead count

      const result = await reconciler.reconcile("main");
      expect(result.state).toBe("LOCAL_AHEAD");
      expect(result.localRef).toBe("abc123");
      expect(result.remoteRef).toBe("abc122");
      expect(result.message).toContain("ahead of remote");
    });

    it("should detect REMOTE_AHEAD when remote has updates not pulled", async () => {
      const { GitReconciler } = await import(
        "../../../src/modules/git/git-reconciler.js"
      );
      const reconciler = new GitReconciler(new GitCliClass(mockExecutor));
      await reconciler.initialize(tempDir);

      // Setup: local at abc122, remote at abc123
      mockExecutor.mockReturn.status = { stdout: "", stderr: "", exitCode: 0 };
      mockExecutor.mockReturn.getHead = { stdout: "abc122\n", stderr: "", exitCode: 0 };
      mockExecutor.mockReturn.getRemoteRef = { stdout: "abc123\n", stderr: "", exitCode: 0 };
      mockExecutor.mockReturn.revList = { stdout: "1\n", stderr: "", exitCode: 0 };

      const result = await reconciler.reconcile("main");
      expect(result.state).toBe("REMOTE_AHEAD");
      expect(result.localRef).toBe("abc122");
      expect(result.remoteRef).toBe("abc123");
    });

    it("should detect DIVERGED when local and remote have diverged", async () => {
      const { GitReconciler } = await import(
        "../../../src/modules/git/git-reconciler.js"
      );
      const reconciler = new GitReconciler(new GitCliClass(mockExecutor));
      await reconciler.initialize(tempDir);

      // Setup: rev-parse succeeds but rev-list fails (divergence)
      mockExecutor.mockReturn.status = { stdout: "", stderr: "", exitCode: 0 };
      mockExecutor.mockReturn.getHead = { stdout: "abc123\n", stderr: "", exitCode: 0 };
      mockExecutor.mockReturn.getRemoteRef = { stdout: "abc122\n", stderr: "", exitCode: 0 };
      mockExecutor.mockReturn.revList = { stdout: "", stderr: "fatal: ambiguous argument\n", exitCode: 128, shouldThrow: true };

      const result = await reconciler.reconcile("main");
      expect(result.state).toBe("DIVERGED");
      expect(result.localRef).toBe("abc123");
      expect(result.remoteRef).toBe("abc122");
      expect(result.message).toContain("diverged");
    });

    it("should detect BRANCH_MISSING when branch does not exist locally", async () => {
      const { GitReconciler } = await import(
        "../../../src/modules/git/git-reconciler.js"
      );
      const reconciler = new GitReconciler(new GitCliClass(mockExecutor));
      await reconciler.initialize(tempDir);

      // Setup: isInsideWorkTree succeeds but verifyBranch fails for branch verification
      mockExecutor.mockReturn.status = { stdout: "", stderr: "", exitCode: 0 };
      mockExecutor.mockReturn.isInsideWorkTree = { stdout: "true\n", stderr: "", exitCode: 0 };
      mockExecutor.mockReturn.verifyBranch = { stdout: "", stderr: "fatal: Needed a single revision\n", exitCode: 128, shouldThrow: true };

      const result = await reconciler.reconcile("nonexistent-branch");
      expect(result.state).toBe("BRANCH_MISSING");
      expect(result.message).toContain("does not exist locally");
    });

    it("should detect WORKTREE_MISSING when worktree path doesn't exist", async () => {
      const { GitReconciler } = await import(
        "../../../src/modules/git/git-reconciler.js"
      );
      const reconciler = new GitReconciler(new GitCliClass(mockExecutor));
      await reconciler.initialize(tempDir);

      // Setup: isInsideWorkTree fails for non-existent worktree
      mockExecutor.mockReturn.isInsideWorkTree = { stdout: "", stderr: "fatal: not a git repository\n", exitCode: 128, shouldThrow: true };

      // Try to reconcile with non-existent worktree
      const result = await reconciler.reconcile("main", "/nonexistent/worktree");
      expect(result.state).toBe("WORKTREE_MISSING");
      expect(result.message).toContain("does not exist or is not a git repository");
    });

    it("should detect UNCOMMITTED_CHANGES when working directory has uncommitted changes", async () => {
      const { GitReconciler } = await import(
        "../../../src/modules/git/git-reconciler.js"
      );
      const reconciler = new GitReconciler(new GitCliClass(mockExecutor));
      await reconciler.initialize(tempDir);

      // Setup: status shows uncommitted changes
      mockExecutor.mockReturn.status = { stdout: " M test.txt\n", stderr: "", exitCode: 0 };
      mockExecutor.mockReturn.getHead = { stdout: "abc123\n", stderr: "", exitCode: 0 };

      const result = await reconciler.reconcile("main");
      expect(result.state).toBe("UNCOMMITTED_CHANGES");
      expect(result.message).toContain("uncommitted changes");
    });
  });

  describe("comprehensive drift state scenarios", () => {
    it("should handle all 7 drift states with proper mocking", async () => {
      const { GitReconciler } = await import(
        "../../../src/modules/git/git-reconciler.js"
      );
      const reconciler = new GitReconciler(new GitCliClass(mockExecutor));
      await reconciler.initialize(tempDir);

      // Test all states with distinct mock configurations
      const testCases: Array<{
        name: string;
        setup: () => void;
        expectedState: GitDriftState;
        branch: string;
      }> = [
        {
          name: "WORKTREE_MISSING",
          setup: () => {
            mockExecutor.mockReturn.isInsideWorkTree = { stdout: "", stderr: "fatal: not a git repository\n", exitCode: 128, shouldThrow: true };
          },
          expectedState: "WORKTREE_MISSING",
          branch: "main",
        },
        {
          name: "BRANCH_MISSING",
          setup: () => {
            mockExecutor.mockReturn.isInsideWorkTree = { stdout: "true\n", stderr: "", exitCode: 0 };
            mockExecutor.mockReturn.verifyBranch = { stdout: "", stderr: "fatal: Needed a single revision\n", exitCode: 128, shouldThrow: true };
          },
          expectedState: "BRANCH_MISSING",
          branch: "nonexistent",
        },
        {
          name: "UNCOMMITTED_CHANGES",
          setup: () => {
            mockExecutor.mockReturn.status = { stdout: " M file.txt\n", stderr: "", exitCode: 0 };
            mockExecutor.mockReturn.isInsideWorkTree = { stdout: "true\n", stderr: "", exitCode: 0 };
          },
          expectedState: "UNCOMMITTED_CHANGES",
          branch: "main",
        },
        {
          name: "IN_SYNC",
          setup: () => {
            mockExecutor.mockReturn.status = { stdout: "", stderr: "", exitCode: 0 };
            mockExecutor.mockReturn.getHead = { stdout: "abc123\n", stderr: "", exitCode: 0 };
            mockExecutor.mockReturn.getRemoteRef = { stdout: "abc123\n", stderr: "", exitCode: 0 };
            mockExecutor.mockReturn.revList = { stdout: "0\n", stderr: "", exitCode: 0 };
          },
          expectedState: "IN_SYNC",
          branch: "main",
        },
        {
          name: "LOCAL_AHEAD",
          setup: () => {
            mockExecutor.mockReturn.status = { stdout: "", stderr: "", exitCode: 0 };
            mockExecutor.mockReturn.getHead = { stdout: "abc123\n", stderr: "", exitCode: 0 };
            mockExecutor.mockReturn.getRemoteRef = { stdout: "abc122\n", stderr: "", exitCode: 0 };
            mockExecutor.mockReturn.revList = { stdout: "2\n", stderr: "", exitCode: 0 };
          },
          expectedState: "LOCAL_AHEAD",
          branch: "main",
        },
        {
          name: "REMOTE_AHEAD",
          setup: () => {
            mockExecutor.mockReturn.status = { stdout: "", stderr: "", exitCode: 0 };
            mockExecutor.mockReturn.getHead = { stdout: "abc122\n", stderr: "", exitCode: 0 };
            mockExecutor.mockReturn.getRemoteRef = { stdout: "abc123\n", stderr: "", exitCode: 0 };
            mockExecutor.mockReturn.revList = { stdout: "3\n", stderr: "", exitCode: 0 };
          },
          expectedState: "REMOTE_AHEAD",
          branch: "main",
        },
        {
          name: "DIVERGED",
          setup: () => {
            mockExecutor.mockReturn.status = { stdout: "", stderr: "", exitCode: 0 };
            mockExecutor.mockReturn.getHead = { stdout: "abc123\n", stderr: "", exitCode: 0 };
            mockExecutor.mockReturn.getRemoteRef = { stdout: "abc122\n", stderr: "", exitCode: 0 };
            mockExecutor.mockReturn.revList = { stdout: "", stderr: "fatal: diverged\n", exitCode: 128, shouldThrow: true };
          },
          expectedState: "DIVERGED",
          branch: "main",
        },
      ];

      for (const testCase of testCases) {
        mockExecutor.resetMockReturn();
        testCase.setup();
        const result = await reconciler.reconcile(testCase.branch);
        expect(result.state).toBe(testCase.expectedState);
      }
    });

    it("should differentiate between remote refs not existing vs existing but differing", async () => {
      const { GitReconciler } = await import(
        "../../../src/modules/git/git-reconciler.js"
      );
      const reconciler = new GitReconciler(new GitCliClass(mockExecutor));
      await reconciler.initialize(tempDir);

      // Case 1: Remote ref doesn't exist (no refs/remotes/origin/main)
      mockExecutor.mockReturn.status = { stdout: "", stderr: "", exitCode: 0 };
      mockExecutor.mockReturn.getHead = { stdout: "abc123\n", stderr: "", exitCode: 0 };
      mockExecutor.mockReturn.revList = { stdout: "0\n", stderr: "", exitCode: 0 };
      // Simulate no remote tracking ref by making getRemoteRef fail
      mockExecutor.mockReturn.getRemoteRef = { stdout: "", stderr: "fatal: Needed a single revision\n", exitCode: 128 };
      const resultNoRemote = await reconciler.reconcile("main");
      expect(resultNoRemote.state).toBe("IN_SYNC");
      expect(resultNoRemote.message).toContain("No remote tracking ref found");

      // Case 2: Remote ref exists but differs (remote is ahead)
      mockExecutor.resetMockReturn();
      mockExecutor.mockReturn.status = { stdout: "", stderr: "", exitCode: 0 };
      mockExecutor.mockReturn.getHead = { stdout: "abc122\n", stderr: "", exitCode: 0 };
      mockExecutor.mockReturn.getRemoteRef = { stdout: "abc123\n", stderr: "", exitCode: 0 };
      mockExecutor.mockReturn.revList = { stdout: "5\n", stderr: "", exitCode: 0 };
      const resultDifferent = await reconciler.reconcile("main");
      expect(resultDifferent.state).toBe("REMOTE_AHEAD");
      expect(resultDifferent.message).toContain("ahead of local");
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
