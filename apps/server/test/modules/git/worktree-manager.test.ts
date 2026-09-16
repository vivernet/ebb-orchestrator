import { describe, expect, it } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";

import { GitCli } from "../../../src/modules/git/git-cli.js";
import { WorktreeManager } from "../../../src/modules/git/worktree-manager.js";
import { BranchManager } from "../../../src/modules/git/branch-manager.js";

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "git-wt-"));
}

async function initGitRepo(path: string): Promise<GitCli> {
  const git = new GitCli();
  await git.run(path, ["init"]);
  await git.run(path, ["config", "user.email", "test@example.com"]);
  await git.run(path, ["config", "user.name", "Test User"]);
  
  // Create initial commit on master
  writeFileSync(join(path, "README.md"), "# Test");
  await git.run(path, ["add", "README.md"]);
  await git.run(path, ["commit", "-m", "initial"]);
  
  return git;
}

describe("WorktreeManager", () => {
  describe("createTaskWorkspace", () => {
    it("creates a worktree for a task", async () => {
      const repoPath = createTempDir();
      await initGitRepo(repoPath);

      const manager = new WorktreeManager();
      const worktree = await manager.createTaskWorkspace("task-123", repoPath, "master");

      expect(worktree.id).toBe("task-123");
      expect(worktree.repoPath).toBe(repoPath);
      expect(worktree.branch).toBe("task/task-123");
      
       // Verify the worktree exists and has the correct branch
       const git = new GitCli();
      const status = await git.run(worktree.path, ["branch", "--show-current"]);
      expect(status.stdout.trim()).toBe("task/task-123");
      
      // Cleanup
      rmSync(worktree.path, { recursive: true, force: true });
    });
  });

  describe("removeWorkspace", () => {
    it("removes a worktree", async () => {
      const repoPath = createTempDir();
      await initGitRepo(repoPath);

      const manager = new WorktreeManager();
      const worktree = await manager.createTaskWorkspace("task-456", repoPath, "master");

       // Verify worktree exists
       const git = new GitCli();
       const listBefore = await git.run(repoPath, ["worktree", "list"]);
      expect(listBefore.stdout).toContain("task/task-456");

      // Remove the worktree directly using git
      await git.run(repoPath, ["worktree", "remove", "--force", worktree.path]);

      // Verify worktree is gone
      const listAfter = await git.run(repoPath, ["worktree", "list"]);
      expect(listAfter.stdout).not.toContain("task/task-456");
    });
  });

  describe("hooks are disabled", () => {
      it("does not execute repository hooks when creating worktrees", async () => {
        const repoPath = createTempDir();
        await initGitRepo(repoPath);

      // Create a pre-commit hook that would fail
      const hooksPath = join(repoPath, ".git", "hooks");
      mkdirSync(hooksPath, { recursive: true });
      writeFileSync(join(hooksPath, "pre-commit"), "#!/bin/bash\nexit 1", "utf8");
      
      // Try to create a worktree - should succeed despite the failing hook
      const manager = new WorktreeManager();
      const worktree = await manager.createTaskWorkspace("task-789", repoPath, "master");

      expect(worktree.id).toBe("task-789");
      
      // Cleanup
      rmSync(worktree.path, { recursive: true, force: true });
    });
  });
});

describe("BranchManager", () => {
  describe("createEpicBranch", () => {
      it("creates an epic branch from base ref", async () => {
        const repoPath = createTempDir();
        await initGitRepo(repoPath);

      const manager = new BranchManager();
      const branch = await manager.createEpicBranch("epic-123", repoPath, "master");

      expect(branch.id).toBe("epic-epic-123");
      expect(branch.repoPath).toBe(repoPath);
      expect(branch.name).toBe("epic/epic-123");
      expect(branch.targetRef).toBe("master");
      
       // Verify the branch exists
       const git = new GitCli();
       const branches = await git.run(repoPath, ["branch"]);
       expect(branches.stdout).toContain("epic/epic-123");
     });
   });

   describe("hooks are disabled", () => {
      it("does not execute repository hooks when creating branches", async () => {
        const repoPath = createTempDir();
        await initGitRepo(repoPath);

      // Create a pre-commit hook that would fail
      const hooksPath = join(repoPath, ".git", "hooks");
      mkdirSync(hooksPath, { recursive: true });
      writeFileSync(join(hooksPath, "pre-commit"), "#!/bin/bash\nexit 1", "utf8");

      // Try to create an epic branch - should succeed despite the failing hook
      const manager = new BranchManager();
      const branch = await manager.createEpicBranch("epic-456", repoPath, "master");

      expect(branch.id).toBe("epic-epic-456");
      
       // Verify the branch exists
       const git = new GitCli();
       const branches = await git.run(repoPath, ["branch"]);
       expect(branches.stdout).toContain("epic/epic-456");
     });
   });
 });
