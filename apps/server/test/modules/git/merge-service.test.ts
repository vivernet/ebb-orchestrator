import { describe, expect, it } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";

import { GitCli } from "../../../src/modules/git/git-cli.js";
import { MergeService } from "../../../src/modules/git/merge-service.js";
import { IntegrationService } from "../../../src/modules/git/integration-service.js";
import type { IntegrationAttempt } from "../../../src/modules/git/integration-service.js";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import type { StatementParams } from "../../../src/platform/database/database.js";

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
       db.exec("CREATE TABLE agent_runs (id TEXT PRIMARY KEY, role TEXT, status TEXT, output TEXT, epic_id TEXT)");
       db.exec("CREATE TABLE epic_orchestrations (epic_id TEXT PRIMARY KEY)");
       db.exec("CREATE TABLE orchestration_phase_runs (agent_run_id TEXT PRIMARY KEY, epic_id TEXT, phase TEXT, validated INTEGER)");
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
    it("uses the method approval and persists a verified provenance-bound operation", async () => {
      const repoPath = createTempDir();
      const git = await initGitRepo(repoPath);
      const db = createSqliteDatabase(join(repoPath, "orchestrator.sqlite"));
       db.exec("CREATE TABLE agent_runs (id TEXT PRIMARY KEY, role TEXT, status TEXT, output TEXT, epic_id TEXT)");
       db.exec("CREATE TABLE epic_orchestrations (epic_id TEXT PRIMARY KEY)");
       db.exec("CREATE TABLE orchestration_phase_runs (agent_run_id TEXT PRIMARY KEY, epic_id TEXT, phase TEXT, validated INTEGER)");
      db.exec("CREATE TABLE git_operations (id TEXT PRIMARY KEY, type TEXT, status TEXT, repo_path TEXT, branch_name TEXT, target_ref TEXT, created_at TEXT, verified_at TEXT, approval_id TEXT, source_sha TEXT, expected_target_sha TEXT, resulting_target_sha TEXT)");
       const runId = "integration-real-run";
       db.run("INSERT INTO epic_orchestrations (epic_id) VALUES ('epic-1')");
       db.run("INSERT INTO orchestration_phase_runs (agent_run_id,epic_id,phase,validated) VALUES ($id,'epic-1','integration',1)", { id: runId });
       db.run("INSERT INTO agent_runs (id,role,status,output,epic_id) VALUES ($id,'Integration','STARTED',NULL,'epic-1')", { id: runId });
      const integration = new IntegrationService({ git, database: db, worktreeDir: createTempDir(), integrationRunId: runId });
      const attempt = await integration.prepareIntegration("HEAD", "master", repoPath);
      await integration.runInIntegrationWorktree(attempt, async () => {
        db.run("UPDATE agent_runs SET status='COMPLETED',output=$output WHERE id=$id", { id: runId, output: JSON.stringify({ outcome: "PASS" }) });
      });
      const service = new MergeService({
        database: db,
        repoPath,
        approvalId: "stale-constructor-approval",
        approvalStore: new Map([["method-approval", { id: "method-approval", subjectId: "epic-1", type: "FINAL_MERGE", status: "APPROVED" }]]),
      });

      const result = await service.mergeApprovedForIntegration("epic-1", "method-approval", runId);
      expect(result.verifiedCompletion).toBe(true);
      expect(db.get<{ status: string; approval_id: string; source_sha: string; expected_target_sha: string; resulting_target_sha: string }>("SELECT status,approval_id,source_sha,expected_target_sha,resulting_target_sha FROM git_operations")).toMatchObject({
        status: "VERIFIED",
        approval_id: "method-approval",
        source_sha: attempt.sourceSha,
        expected_target_sha: attempt.expectedTargetSha,
        resulting_target_sha: result.resultingTargetSha,
      });
       db.close();
     });

     it("rejects an Epic from using another Epic's Integration run and SHA", async () => {
       const repoPath = createTempDir();
       const git = await initGitRepo(repoPath);
       const db = createSqliteDatabase(join(repoPath, "orchestrator.sqlite"));
       db.exec("CREATE TABLE agent_runs (id TEXT PRIMARY KEY, role TEXT, status TEXT, output TEXT, epic_id TEXT)");
       db.exec("CREATE TABLE epic_orchestrations (epic_id TEXT PRIMARY KEY)");
       db.exec("CREATE TABLE orchestration_phase_runs (agent_run_id TEXT PRIMARY KEY, epic_id TEXT, phase TEXT, validated INTEGER)");
       const runId = "epic-b-integration-run";
       db.run("INSERT INTO epic_orchestrations (epic_id) VALUES ('epic-a'),('epic-b')");
       db.run("INSERT INTO agent_runs (id,role,status,output,epic_id) VALUES ($id,'Integration','COMPLETED',NULL,'epic-b')", { id: runId });
       db.run("INSERT INTO orchestration_phase_runs (agent_run_id,epic_id,phase,validated) VALUES ($id,'epic-b','integration',1)", { id: runId });
       const integration = new IntegrationService({ git, database: db, worktreeDir: createTempDir(), integrationRunId: runId });
       await integration.prepareIntegration("HEAD", "master", repoPath);
       db.run("UPDATE integration_attempts SET status='MERGED' WHERE integration_run_id=$id", { id: runId });
       const service = new MergeService({
         database: db,
         git,
         repoPath,
         approvalStore: new Map([["epic-a-approval", { id: "epic-a-approval", subjectId: "epic-a", type: "FINAL_MERGE", status: "APPROVED" }]]),
       });

       await expect(service.mergeApprovedForIntegration("epic-a", "epic-a-approval", runId))
         .rejects.toThrow("Missing exact Integration provenance");
       db.close();
     });

    it("reconciles a STARTED journal entry after git mutation before persistence", async () => {
      const repoPath = createTempDir();
      const git = await initGitRepo(repoPath);
      await git.run(repoPath, ["checkout", "-b", "feature"]);
      writeFileSync(join(repoPath, "feature.txt"), "feature");
      await git.run(repoPath, ["add", "feature.txt"]);
      await git.run(repoPath, ["commit", "-m", "feature"]);
      await git.run(repoPath, ["checkout", "master"]);

      const db = createSqliteDatabase(join(repoPath, "orchestrator.sqlite"));
       db.exec("CREATE TABLE agent_runs (id TEXT PRIMARY KEY, role TEXT, status TEXT, output TEXT, epic_id TEXT)");
       db.exec("CREATE TABLE epic_orchestrations (epic_id TEXT PRIMARY KEY)");
       db.exec("CREATE TABLE orchestration_phase_runs (agent_run_id TEXT PRIMARY KEY, epic_id TEXT, phase TEXT, validated INTEGER)");
      db.exec("CREATE TABLE git_operations (id TEXT PRIMARY KEY, type TEXT, status TEXT, repo_path TEXT, branch_name TEXT, target_ref TEXT, created_at TEXT, verified_at TEXT, approval_id TEXT, source_sha TEXT, expected_target_sha TEXT, resulting_target_sha TEXT)");
      const runId = "integration-recovery-run";
       db.run("INSERT INTO epic_orchestrations (epic_id) VALUES ('epic-recovery')");
       db.run("INSERT INTO orchestration_phase_runs (agent_run_id,epic_id,phase,validated) VALUES ($id,'epic-recovery','integration',1)", { id: runId });
       db.run("INSERT INTO agent_runs (id,role,status,output,epic_id) VALUES ($id,'Integration','STARTED',NULL,'epic-recovery')", { id: runId });
      const integration = new IntegrationService({ git, database: db, worktreeDir: createTempDir(), integrationRunId: runId });
      const attempt = await integration.prepareIntegration("feature", "master", repoPath);
      await integration.runInIntegrationWorktree(attempt, async () => {
        db.run("UPDATE agent_runs SET status='COMPLETED',output=$output WHERE id=$id", { id: runId, output: JSON.stringify({ outcome: "PASS" }) });
      });
      const approvalStore = new Map([["approval-recovery", { id: "approval-recovery", subjectId: "epic-recovery", type: "FINAL_MERGE", status: "APPROVED" }]]);
      const originalRun = db.run.bind(db);
      let failJournalWrite = true;
      db.run = (sql: string, params?: StatementParams): void => {
        if (failJournalWrite && (sql.includes("SET status='VERIFIED'") || sql.includes("SET status='FAILED'"))) {
          throw new Error("simulated journal crash");
        }
        originalRun(sql, params);
      };
      const firstService = new MergeService({ database: db, git, repoPath, approvalStore });
      await expect(firstService.mergeApprovedForIntegration("epic-recovery", "approval-recovery", runId)).rejects.toThrow("simulated journal crash");
      expect(db.get<{ status: string }>("SELECT status FROM git_operations")).toEqual({ status: "STARTED" });
      failJournalWrite = false;

      const secondService = new MergeService({ database: db, git, repoPath, approvalStore });
      const result = await secondService.mergeApprovedForIntegration("epic-recovery", "approval-recovery", runId);
      expect(result.verifiedCompletion).toBe(true);
      expect(db.get<{ status: string; resulting_target_sha: string }>("SELECT status,resulting_target_sha FROM git_operations")).toMatchObject({
        status: "VERIFIED",
        resulting_target_sha: result.resultingTargetSha,
      });
      expect((await git.run(repoPath, ["show", "master:feature.txt"])).stdout.trim()).toBe("feature");
      db.close();
    });

    it("rejects retry after a STARTED reconciliation detects target drift", async () => {
      const repoPath = createTempDir();
      const git = await initGitRepo(repoPath);
      await git.run(repoPath, ["checkout", "-b", "feature"]);
      writeFileSync(join(repoPath, "feature.txt"), "feature");
      await git.run(repoPath, ["add", "feature.txt"]);
      await git.run(repoPath, ["commit", "-m", "feature"]);
      await git.run(repoPath, ["checkout", "master"]);

      const db = createSqliteDatabase(join(repoPath, "orchestrator.sqlite"));
       db.exec("CREATE TABLE agent_runs (id TEXT PRIMARY KEY, role TEXT, status TEXT, output TEXT, epic_id TEXT)");
       db.exec("CREATE TABLE epic_orchestrations (epic_id TEXT PRIMARY KEY)");
       db.exec("CREATE TABLE orchestration_phase_runs (agent_run_id TEXT PRIMARY KEY, epic_id TEXT, phase TEXT, validated INTEGER)");
      db.exec("CREATE TABLE git_operations (id TEXT PRIMARY KEY, type TEXT, status TEXT, repo_path TEXT, branch_name TEXT, target_ref TEXT, created_at TEXT, verified_at TEXT, approval_id TEXT, source_sha TEXT, expected_target_sha TEXT, resulting_target_sha TEXT)");
      const runId = "integration-drift-run";
       db.run("INSERT INTO epic_orchestrations (epic_id) VALUES ('epic-drift')");
       db.run("INSERT INTO orchestration_phase_runs (agent_run_id,epic_id,phase,validated) VALUES ($id,'epic-drift','integration',1)", { id: runId });
       db.run("INSERT INTO agent_runs (id,role,status,output,epic_id) VALUES ($id,'Integration','STARTED',NULL,'epic-drift')", { id: runId });
      const integration = new IntegrationService({ git, database: db, worktreeDir: createTempDir(), integrationRunId: runId });
      const attempt = await integration.prepareIntegration("feature", "master", repoPath);
      await integration.runInIntegrationWorktree(attempt, async () => {
        db.run("UPDATE agent_runs SET status='COMPLETED',output=$output WHERE id=$id", { id: runId, output: JSON.stringify({ outcome: "PASS" }) });
      });
      db.run("INSERT INTO git_operations (id,type,status,repo_path,branch_name,target_ref,created_at,approval_id,source_sha,expected_target_sha) VALUES ('drift-op','MERGE','STARTED',$repo,'feature','master',$at,'approval-drift',$source,$expected)", {
        repo: repoPath,
        at: new Date().toISOString(),
        source: attempt.sourceSha,
        expected: attempt.expectedTargetSha,
      });
      writeFileSync(join(repoPath, "target.txt"), "target moved");
      await git.run(repoPath, ["add", "target.txt"]);
      await git.run(repoPath, ["commit", "-m", "move target"]);
      const approvalStore = new Map([["approval-drift", { id: "approval-drift", subjectId: "epic-drift", type: "FINAL_MERGE", status: "APPROVED" }]]);
      const service = new MergeService({ database: db, git, repoPath, approvalStore });

      await expect(service.mergeApprovedForIntegration("epic-drift", "approval-drift", runId)).rejects.toThrow(/MERGE_RECOVERY_FAILED/);
      expect(db.get<{ status: string; failure_reason: string }>("SELECT status,failure_reason FROM git_operations WHERE id='drift-op'")).toEqual({ status: "FAILED", failure_reason: "RECONCILIATION_FAILED" });
      await expect(service.mergeApprovedForIntegration("epic-drift", "approval-drift", runId)).rejects.toThrow(/terminal reconciliation failure/);
      expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM git_operations")).toEqual({ count: 1 });
      db.close();
    });

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
      
      const approvalStore = new Map();
      approvalStore.set("approval-456", {
        id: "approval-456",
        subjectId: "subject-123",
        type: "CODE_REVIEW",
        status: "APPROVED",
      });
      
      const mergeService = new MergeService({ approvalStore, repoPath });
      
      await expect(
        mergeService.mergeApproved("subject-123", "approval-456")
      ).rejects.toThrow(/type.*FINAL_MERGE/i);
    });

    it("rejects merge when approval status is not APPROVED", async () => {
      const repoPath = createTempDir();
      await initGitRepo(repoPath);
      
      const approvalStore = new Map();
      approvalStore.set("approval-456", {
        id: "approval-456",
        subjectId: "subject-123",
        type: "FINAL_MERGE",
        status: "PENDING",
      });
      
      const mergeService = new MergeService({ approvalStore, repoPath });
      
      await expect(
        mergeService.mergeApproved("subject-123", "approval-456")
      ).rejects.toThrow(/status.*APPROVED/i);
    });

    it("rejects merge when subjectId does not match", async () => {
      const repoPath = createTempDir();
      await initGitRepo(repoPath);
      
      const approvalStore = new Map();
      approvalStore.set("approval-456", {
        id: "approval-456",
        subjectId: "subject-789",
        type: "FINAL_MERGE",
        status: "APPROVED",
      });
      
      const mergeService = new MergeService({ approvalStore, repoPath });
      
      await expect(
        mergeService.mergeApproved("subject-123", "approval-456")
      ).rejects.toThrow(/subjectId.*subject-123/i);
    });

    it("performs merge when all validations pass", async () => {
      const repoPath = createTempDir();
      const git = await initGitRepo(repoPath);
      
      // Add a file to master first (since merge is a no-op in test)
      writeFileSync(join(repoPath, "readme.txt"), "readme content");
      await git.run(repoPath, ["add", "readme.txt"]);
      await git.run(repoPath, ["commit", "-m", "add readme"]);
      
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
    });

    it("verifies target SHA after merge", async () => {
      const repoPath = createTempDir();
      const git = await initGitRepo(repoPath);
      
      // Add a file to master first
      writeFileSync(join(repoPath, "readme.txt"), "readme content");
      await git.run(repoPath, ["add", "readme.txt"]);
      await git.run(repoPath, ["commit", "-m", "add readme"]);
      
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
    });
  });
});
