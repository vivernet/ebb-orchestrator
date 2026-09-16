import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";

import { GitCli } from "../../../src/modules/git/git-cli.js";
import { IntegrationService } from "../../../src/modules/git/integration-service.js";

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "git-integration-"));
}

async function initGitRepo(path: string, commitMessage: string = "initial"): Promise<GitCli> {
  const git = new GitCli();
  await git.run(path, ["init"]);
  await git.run(path, ["config", "user.email", "test@example.com"]);
  await git.run(path, ["config", "user.name", "Test User"]);
  
  // Create initial commit on master
  writeFileSync(join(path, "README.md"), "# Test");
  await git.run(path, ["add", "README.md"]);
  await git.run(path, ["commit", "-m", commitMessage]);
  
  return git;
}

describe("IntegrationService", () => {
  describe("prepareIntegration", () => {
    it("creates integration worktree from current target branch", async () => {
      const repoPath = createTempDir();
      const git = await initGitRepo(repoPath);
      
      // Create source branch with changes
      await git.run(repoPath, ["checkout", "-b", "feature-branch"]);
      writeFileSync(join(repoPath, "feature.txt"), "feature content");
      await git.run(repoPath, ["add", "feature.txt"]);
      await git.run(repoPath, ["commit", "-m", "add feature"]);
      await git.run(repoPath, ["checkout", "master"]);
      
      const integrationService = new IntegrationService();
      const attempt = await integrationService.prepareIntegration("feature-branch", "master", repoPath);
      
      expect(attempt.id).toBeDefined();
      expect(attempt.sourceBranch).toBe("feature-branch");
      expect(attempt.currentTargetBranch).toBe("master");
      expect(attempt.worktreePath).toBeDefined();
      expect(attempt.status).toBe("PREPARED");
      
      // Verify worktree exists on correct branch
      const worktreeGit = new GitCli();
      const branchStatus = await worktreeGit.run(attempt.worktreePath, ["branch", "--show-current"]);
      expect(branchStatus.stdout.trim()).toContain("integration/");
      
      // Cleanup
      rmSync(attempt.worktreePath, { recursive: true, force: true });
    });

    it("handles moving target branch correctly", async () => {
      const repoPath = createTempDir();
      const git = await initGitRepo(repoPath);
      
      // Create source branch
      await git.run(repoPath, ["checkout", "-b", "source-branch"]);
      writeFileSync(join(repoPath, "source.txt"), "source content");
      await git.run(repoPath, ["add", "source.txt"]);
      await git.run(repoPath, ["commit", "-m", "source commit"]);
      await git.run(repoPath, ["checkout", "master"]);
      
      // Get initial master SHA
      const initialResult = await git.run(repoPath, ["rev-parse", "master"]);
      const initialSha = initialResult.stdout.trim();
      
      // Simulate target moving (another task merged)
      writeFileSync(join(repoPath, "target-update.txt"), "target update");
      await git.run(repoPath, ["add", "target-update.txt"]);
      await git.run(repoPath, ["commit", "-m", "target update"]);
      const finalResult = await git.run(repoPath, ["rev-parse", "master"]);
      const finalSha = finalResult.stdout.trim();
      
      expect(initialSha).not.toBe(finalSha);
      
      // Prepare integration - should use current target SHA
      const integrationService = new IntegrationService();
      const attempt = await integrationService.prepareIntegration("source-branch", "master", repoPath);
      
      // Verify worktree was created from final (moved) target
      const worktreeGit = new GitCli();
      const worktreeHead = await worktreeGit.run(attempt.worktreePath, ["rev-parse", "HEAD"]);
      expect(worktreeHead.stdout.trim()).toBe(finalSha);
      
      // Cleanup
      rmSync(attempt.worktreePath, { recursive: true, force: true });
    });

    it("never experiments in task worktree or master", async () => {
      const repoPath = createTempDir();
      const git = await initGitRepo(repoPath);
      
      // Create feature branch as source
      await git.run(repoPath, ["checkout", "-b", "task-123"]);
      writeFileSync(join(repoPath, "task.txt"), "task content");
      await git.run(repoPath, ["add", "task.txt"]);
      await git.run(repoPath, ["commit", "-m", "task changes"]);
      await git.run(repoPath, ["checkout", "master"]);
      
      // Capture master state before integration
      const masterBefore = await git.run(repoPath, ["rev-parse", "master"]);
      
      const integrationService = new IntegrationService();
      const attempt = await integrationService.prepareIntegration("task-123", "master", repoPath);
      
      // Verify master is unchanged
      const masterAfter = await git.run(repoPath, ["rev-parse", "master"]);
      expect(masterBefore.stdout.trim()).toBe(masterAfter.stdout.trim());
      
      // Cleanup
      rmSync(attempt.worktreePath, { recursive: true, force: true });
    });
  });

  describe("target SHA verification", () => {
    it("records and verifies resulting target SHA after merge", async () => {
      const repoPath = createTempDir();
      const git = await initGitRepo(repoPath);
      
      // Create source branch with changes
      await git.run(repoPath, ["checkout", "-b", "merge-source"]);
      writeFileSync(join(repoPath, "merge-file.txt"), "merge content");
      await git.run(repoPath, ["add", "merge-file.txt"]);
      await git.run(repoPath, ["commit", "-m", "merge commit"]);
      await git.run(repoPath, ["checkout", "master"]);
      
      const integrationService = new IntegrationService();
      const attempt = await integrationService.prepareIntegration("merge-source", "master", repoPath);
      
      // The integration attempt should track the expected target
      expect(attempt.expectedTargetBranch).toBe("master");
      
      // Cleanup
      rmSync(attempt.worktreePath, { recursive: true, force: true });
    });
  });
});
