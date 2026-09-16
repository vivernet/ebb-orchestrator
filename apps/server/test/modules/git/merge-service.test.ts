import { describe, expect, it } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";

import { GitCli } from "../../../src/modules/git/git-cli.js";
import { MergeService } from "../../../src/modules/git/merge-service.js";
import { IntegrationService } from "../../../src/modules/git/integration-service.js";
import type { IntegrationAttempt } from "../../../src/modules/git/integration-service.js";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "git-merge-"));
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

async function successfulIntegration(repoPath: string, git: GitCli, sourceBranch = "HEAD"): Promise<IntegrationAttempt> {
  const integrationRunId = `integration-run-${Date.now()}-${Math.random()}`;
  const worktreeDir = createTempDir();
  const provenancePath = join(worktreeDir, "integration-provenance.sqlite");
  const db = createSqliteDatabase(provenancePath);
  db.exec("CREATE TABLE agent_runs (id TEXT PRIMARY KEY, role TEXT, status TEXT, output TEXT)");
  db.run("INSERT INTO agent_runs (id, role, status, output) VALUES ($id, 'Integration', 'IN_PROGRESS', NULL)", { id: integrationRunId });
  const service = new IntegrationService({ git, database: db, worktreeDir, integrationRunId });
  const attempt = await service.prepareIntegration(sourceBranch, "master", repoPath);
  await service.runInIntegrationWorktree(attempt, async () => {
    const completedDb = createSqliteDatabase(provenancePath);
    completedDb.run("UPDATE agent_runs SET status = 'COMPLETED', output = $output WHERE id = $id", { id: integrationRunId, output: JSON.stringify({ version: "1", outcome: "PASS" }) });
    completedDb.close();
  });
  return attempt;
}

describe("MergeService", () => {
  describe("mergeApproved", () => {
    it("rejects approval-only merges without verified integration provenance", async () => {
      const repoPath = createTempDir();
      await initGitRepo(repoPath);
      const approvalStore = new Map<string, { id: string; subjectId: string; type: string; status: string }>();
      approvalStore.set("approval-456", { id: "approval-456", subjectId: "subject-123", type: "FINAL_MERGE", status: "APPROVED" });

      await expect(new MergeService({ approvalStore, repoPath }).mergeApproved("subject-123", "approval-456"))
        .rejects.toThrow(/Missing verified integration provenance/);
    });

    it("rejects merge when approval type is not FINAL_MERGE", async () => {
      const repoPath = createTempDir();
      await initGitRepo(repoPath);
      
      const originalCwd = process.cwd();
      process.chdir(repoPath);
      
      try {
        const approvalStore = new Map();
        approvalStore.set("approval-456", {
          id: "approval-456",
          subjectId: "subject-123",
          type: "CODE_REVIEW",
          status: "APPROVED",
        });
        
         const mergeService = new MergeService({ approvalStore });
        
        await expect(
          mergeService.mergeApproved("subject-123", "approval-456")
        ).rejects.toThrow(/type.*FINAL_MERGE/i);
      } finally {
        process.chdir(originalCwd);
      }
    });

    it("rejects merge when approval status is not APPROVED", async () => {
      const repoPath = createTempDir();
      await initGitRepo(repoPath);
      
      const originalCwd = process.cwd();
      process.chdir(repoPath);
      
      try {
        const approvalStore = new Map();
        approvalStore.set("approval-456", {
          id: "approval-456",
          subjectId: "subject-123",
          type: "FINAL_MERGE",
          status: "PENDING",
        });
        
         const mergeService = new MergeService({ approvalStore });
        
        await expect(
          mergeService.mergeApproved("subject-123", "approval-456")
        ).rejects.toThrow(/status.*APPROVED/i);
      } finally {
        process.chdir(originalCwd);
      }
    });

    it("rejects merge when subjectId does not match", async () => {
      const repoPath = createTempDir();
      await initGitRepo(repoPath);
      
      const originalCwd = process.cwd();
      process.chdir(repoPath);
      
      try {
        const approvalStore = new Map();
        approvalStore.set("approval-456", {
          id: "approval-456",
          subjectId: "subject-789",
          type: "FINAL_MERGE",
          status: "APPROVED",
        });
        
         const mergeService = new MergeService({ approvalStore });
        
        await expect(
          mergeService.mergeApproved("subject-123", "approval-456")
        ).rejects.toThrow(/subjectId.*subject-123/i);
      } finally {
        process.chdir(originalCwd);
      }
    });

    it("performs merge when all validations pass", async () => {
      const repoPath = createTempDir();
      const git = await initGitRepo(repoPath);
      
      // Add a file to master first (since merge is a no-op in test)
      writeFileSync(join(repoPath, "readme.txt"), "readme content");
      await git.run(repoPath, ["add", "readme.txt"]);
      await git.run(repoPath, ["commit", "-m", "add readme"]);
      
      const originalCwd = process.cwd();
      process.chdir(repoPath);
      
      try {
        const approvalStore = new Map();
        approvalStore.set("approval-456", {
          id: "approval-456",
          subjectId: "subject-123",
          type: "FINAL_MERGE",
          status: "APPROVED",
        });
        
         const mergeService = new MergeService({ approvalStore, repoPath, integrationAttempt: await successfulIntegration(repoPath, git) });
        
        // Should succeed with valid approval
        const result = await mergeService.mergeApproved("subject-123", "approval-456");
        
        expect(result.success).toBe(true);
        expect(result.subjectId).toBe("subject-123");
        expect(result.mergeCommitSha).toBeDefined();
        
        // Verify file exists in master after merge
        const content = await git.run(repoPath, ["show", "master:readme.txt"]);
        expect(content.stdout.trim()).toBe("readme content");
      } finally {
        process.chdir(originalCwd);
      }
    });

    it("verifies target SHA after merge", async () => {
      const repoPath = createTempDir();
      const git = await initGitRepo(repoPath);
      
      // Add a file to master first
      writeFileSync(join(repoPath, "readme.txt"), "readme content");
      await git.run(repoPath, ["add", "readme.txt"]);
      await git.run(repoPath, ["commit", "-m", "add readme"]);
      
      const originalCwd = process.cwd();
      process.chdir(repoPath);
      
      try {
        const approvalStore = new Map();
        approvalStore.set("approval-456", {
          id: "approval-456",
          subjectId: "subject-123",
          type: "FINAL_MERGE",
          status: "APPROVED",
        });
        
         const mergeService = new MergeService({ approvalStore, repoPath, integrationAttempt: await successfulIntegration(repoPath, git) });
        const result = await mergeService.mergeApproved("subject-123", "approval-456");
        
        // Verify resulting SHA is recorded
        expect(result.resultingTargetSha).toBeDefined();
        expect(result.resultingTargetSha).toBeTruthy();
        
        // Verify SHA matches what git reports
        const actualHead = await git.run(repoPath, ["rev-parse", "HEAD"]);
        expect(actualHead.stdout.trim()).toBe(result.resultingTargetSha);
      } finally {
        process.chdir(originalCwd);
      }
    });

    it("rejects a target that moved after integration was captured", async () => {
      const repoPath = createTempDir();
      const git = await initGitRepo(repoPath);
      const expectedTargetSha = (await git.run(repoPath, ["rev-parse", "master"])).stdout.trim();
      const approvalStore = new Map();
      approvalStore.set("approval-456", { id: "approval-456", subjectId: "subject-123", type: "FINAL_MERGE", status: "APPROVED" });
      const integrationAttempt = await successfulIntegration(repoPath, git);
      integrationAttempt.expectedTargetSha = expectedTargetSha;
      const mergeService = new MergeService({ approvalStore, git, repoPath, integrationAttempt });

      writeFileSync(join(repoPath, "moved.txt"), "target moved");
      await git.run(repoPath, ["add", "moved.txt"]);
      await git.run(repoPath, ["commit", "-m", "move target"]);

      await expect(mergeService.mergeApproved("subject-123", "approval-456"))
        .rejects.toThrow(/TARGET_MOVED/);
    });

    it("rejects fabricated and cross-repository provenance", async () => {
      const repoPath = createTempDir();
      const otherRepoPath = createTempDir();
      const git = await initGitRepo(repoPath);
      await initGitRepo(otherRepoPath);
      const issued = await successfulIntegration(repoPath, git);
      const approvalStore = new Map();
      approvalStore.set("approval-456", { id: "approval-456", subjectId: "subject-123", type: "FINAL_MERGE", status: "APPROVED" });

      const fabricated = { ...issued };
      await expect(new MergeService({ approvalStore, repoPath, integrationAttempt: fabricated })
        .mergeApproved("subject-123", "approval-456"))
        .rejects.toThrow(/Missing verified integration provenance/);

      await expect(new MergeService({ approvalStore, repoPath: otherRepoPath, integrationAttempt: issued })
        .mergeApproved("subject-123", "approval-456"))
        .rejects.toThrow(/Missing verified integration provenance/);
    });

    it("merges without executing hooks", async () => {
      const repoPath = createTempDir();
      const git = await initGitRepo(repoPath);
      
      // Add a file to master first
      writeFileSync(join(repoPath, "readme.txt"), "readme content");
      await git.run(repoPath, ["add", "readme.txt"]);
      await git.run(repoPath, ["commit", "-m", "add readme"]);
      
      // Add a pre-commit hook that would fail
      const hooksPath = join(repoPath, ".git", "hooks");
      mkdirSync(hooksPath, { recursive: true });
      writeFileSync(join(hooksPath, "pre-commit"), "#!/bin/bash\nexit 1", "utf8");
      
      const originalCwd = process.cwd();
      process.chdir(repoPath);
      
      try {
        const approvalStore = new Map();
        approvalStore.set("approval-456", {
          id: "approval-456",
          subjectId: "subject-123",
          type: "FINAL_MERGE",
          status: "APPROVED",
        });
        
         const mergeService = new MergeService({ approvalStore, repoPath, integrationAttempt: await successfulIntegration(repoPath, await new GitCli()) });
        
        // Should succeed despite failing hook (hooks are disabled)
        const result = await mergeService.mergeApproved("subject-123", "approval-456");
        
        expect(result.success).toBe(true);
      } finally {
        process.chdir(originalCwd);
      }
    });
  });
});
