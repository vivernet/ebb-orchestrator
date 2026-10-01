import { describe, expect, it } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";

import { GitCli } from "../../../src/modules/git/git-cli.js";
import { MergeService } from "../../../src/modules/git/merge-service.js";
import { IntegrationService } from "../../../src/modules/git/integration-service.js";
import type { IntegrationAttempt } from "../../../src/modules/git/integration-service.js";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { createIntegrationTestDatabase } from "../../helpers/integration-database.js";
import type { StatementParams } from "../../../src/platform/database/database.js";

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "git-merge-"));
}

function integrationPassOutput(attempt: IntegrationAttempt): Record<string, unknown> {
  return {
    version: "1.0.0", outcome: "PASS", baseSha: attempt.expectedTargetSha, sourceSha: attempt.sourceSha,
    provenance: [`integration_attempt:${attempt.id}`], evidence: ["Verified the prepared source SHA in the integration worktree"],
  };
}

function seedApprovedEpicContext(db: ReturnType<typeof createIntegrationTestDatabase>, repoPath: string, epicId: string, displayId: string): void {
  const projectId = `project-${epicId}`;
  const onboardingApprovalId = `onboarding-approval-${epicId}`;
  db.run("INSERT INTO projects(id,status) VALUES($id,'ACTIVE')", { id: projectId });
  db.run("INSERT INTO approvals(id,type,subject_id,subject_type,status) VALUES($id,'WORKFLOW_CHANGE',$projectId,'PROJECT','APPROVED')", { id: onboardingApprovalId, projectId });
  db.run("INSERT INTO epics(id,project_id,display_id,status) VALUES($id,$projectId,$displayId,'IN_PROGRESS')", { id: epicId, projectId, displayId });
  db.run("INSERT INTO onboarding_configs(project_id,repository_path,facts_json,proposed_json,status,approval_id) VALUES($projectId,$repo,'{}',$proposed,'ACTIVE',$approvalId)", { projectId, repo: repoPath, proposed: JSON.stringify({ defaultBranch: "master" }), approvalId: onboardingApprovalId });
}

async function initGitRepo(path: string, commitMessage: string = "initial"): Promise<GitCli> {
  const git = new GitCli();
  await git.run(path, ["init"]);
  await git.run(path, ["config", "user.email", "test@example.com"]);
  await git.run(path, ["config", "user.name", "Test User"]);
  
// Создаём начальный commit в master.
  writeFileSync(join(path, "README.md"), "# Test");
  await git.run(path, ["add", "README.md"]);
  await git.run(path, ["commit", "-m", commitMessage]);
  
  return git;
}

async function successfulIntegration(repoPath: string, git: GitCli, sourceBranch = "HEAD"): Promise<IntegrationAttempt> {
  const integrationRunId = `integration-run-${Date.now()}-${Math.random()}`;
  const worktreeDir = createTempDir();
  const provenancePath = join(worktreeDir, "integration-provenance.sqlite");
  const db = createIntegrationTestDatabase(provenancePath);
  db.run("INSERT INTO agent_runs (id, role, status, output) VALUES ($id, 'Integration', 'IN_PROGRESS', NULL)", { id: integrationRunId });
  const service = new IntegrationService({ git, database: db, provenanceDatabasePath: provenancePath, worktreeDir, integrationRunId });
  const attempt = await service.prepareIntegration(sourceBranch, "master", repoPath);
  await service.runInIntegrationWorktree(attempt, async () => {
    const completedDb = createSqliteDatabase(provenancePath);
    completedDb.run("UPDATE agent_runs SET status = 'COMPLETED', output = $output WHERE id = $id", { id: integrationRunId, output: JSON.stringify(integrationPassOutput(attempt)) });
    completedDb.close();
  });
  return attempt;
}

describe("MergeService", () => {
  describe("mergeApproved", () => {
    it("uses the method approval and persists a verified provenance-bound operation", async () => {
      const repoPath = createTempDir();
      const git = await initGitRepo(repoPath);
      await git.run(repoPath, ["branch", "epic/EPIC-1"]);
      const db = createIntegrationTestDatabase(join(repoPath, "orchestrator.sqlite"));
       seedApprovedEpicContext(db, repoPath, "epic-1", "EPIC-1");
       const runId = "integration-real-run";
       db.run("INSERT INTO epic_orchestrations (epic_id) VALUES ('epic-1')");
       db.run("INSERT INTO orchestration_phase_runs (agent_run_id,epic_id,phase,validated) VALUES ($id,'epic-1','integration',1)", { id: runId });
       db.run("INSERT INTO agent_runs (id,role,status,output,epic_id) VALUES ($id,'Integration','STARTED',NULL,'epic-1')", { id: runId });
      const integration = new IntegrationService({ git, database: db, provenanceDatabasePath: join(repoPath, "orchestrator.sqlite"), worktreeDir: createTempDir(), integrationRunId: runId });
      const attempt = await integration.prepareIntegration("epic/EPIC-1", "master", repoPath);
      db.run("UPDATE agent_runs SET capability_json=$capability WHERE id=$id", { id: runId, capability: JSON.stringify({ workspace: attempt.worktreePath }) });
      await integration.runInIntegrationWorktree(attempt, async () => {
        db.run("UPDATE agent_runs SET status='COMPLETED',output=$output WHERE id=$id", { id: runId, output: JSON.stringify(integrationPassOutput(attempt)) });
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
      for (const invalid of [
        { ...integrationPassOutput(attempt), baseSha: "wrong-target-sha" },
        { ...integrationPassOutput(attempt), sourceSha: "wrong-source-sha" },
        { ...integrationPassOutput(attempt), provenance: ["integration_attempt:other-attempt"] },
      ]) {
        db.run("UPDATE agent_runs SET output=$output WHERE id=$id", { id: runId, output: JSON.stringify(invalid) });
        await expect(service.mergeApprovedForIntegration("epic-1", "method-approval", runId))
          .rejects.toThrow(/exact attempt and SHAs/);
      }
       db.close();
     });

    it("rejects a MERGED attempt on a ref other than the approved Epic target before Git mutation", async () => {
      const repoPath = createTempDir();
      const git = await initGitRepo(repoPath);
      await git.run(repoPath, ["checkout", "-b", "epic/EPIC-1"]);
      writeFileSync(join(repoPath, "epic.txt"), "epic change");
      await git.run(repoPath, ["add", "epic.txt"]);
      await git.run(repoPath, ["commit", "-m", "epic change"]);
      await git.run(repoPath, ["checkout", "master"]);
      await git.run(repoPath, ["branch", "release"]);
      const db = createIntegrationTestDatabase(join(repoPath, "orchestrator.sqlite"));
      seedApprovedEpicContext(db, repoPath, "epic-1", "EPIC-1");
      db.run("INSERT INTO epic_orchestrations(epic_id) VALUES('epic-1')");
      const runId = "integration-wrong-target-run";
      db.run("INSERT INTO orchestration_phase_runs(agent_run_id,epic_id,task_id,phase,validated) VALUES($id,'epic-1',NULL,'integration',1)", { id: runId });
      db.run("INSERT INTO agent_runs(id,role,status,epic_id) VALUES($id,'Integration','STARTED','epic-1')", { id: runId });
      const integration = new IntegrationService({ git, database: db, provenanceDatabasePath: join(repoPath, "orchestrator.sqlite"), worktreeDir: createTempDir(), integrationRunId: runId });
      const attempt = await integration.prepareIntegration("epic/EPIC-1", "release", repoPath);
      db.run("UPDATE agent_runs SET capability_json=$capability WHERE id=$id", { id: runId, capability: JSON.stringify({ workspace: attempt.worktreePath }) });
      await integration.mergePreparedSource(attempt);
      await integration.runInIntegrationWorktree(attempt, async () => {
        db.run("UPDATE agent_runs SET status='COMPLETED',output=$output WHERE id=$id", { id: runId, output: JSON.stringify(integrationPassOutput(attempt)) });
      });
      const service = new MergeService({
        database: db,
        git,
        repoPath,
        approvalStore: new Map([["epic-1-approval", { id: "epic-1-approval", subjectId: "epic-1", type: "FINAL_MERGE", status: "APPROVED" }]]),
      });
      const before = (await git.run(repoPath, ["rev-parse", "master"])).stdout.trim();

      await expect(service.mergeApprovedForIntegration("epic-1", "epic-1-approval", runId))
        .rejects.toThrow(/approved Epic configuration/);
      expect((await git.run(repoPath, ["rev-parse", "master"])).stdout.trim()).toBe(before);
      expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM git_operations WHERE type='MERGE'")?.count).toBe(0);
      db.close();
    });

    it("rejects an Epic from using another Epic's Integration run and SHA", async () => {
       const repoPath = createTempDir();
       const git = await initGitRepo(repoPath);
       const db = createIntegrationTestDatabase(join(repoPath, "orchestrator.sqlite"));
       const runId = "epic-b-integration-run";
       db.run("INSERT INTO epic_orchestrations (epic_id) VALUES ('epic-a'),('epic-b')");
       db.run("INSERT INTO agent_runs (id,role,status,output,epic_id) VALUES ($id,'Integration','COMPLETED',NULL,'epic-b')", { id: runId });
       db.run("INSERT INTO orchestration_phase_runs (agent_run_id,epic_id,phase,validated) VALUES ($id,'epic-b','integration',1)", { id: runId });
       const integration = new IntegrationService({ git, database: db, provenanceDatabasePath: join(repoPath, "orchestrator.sqlite"), worktreeDir: createTempDir(), integrationRunId: runId });
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

     it("rejects a child Integration run as the Epic final merge source", async () => {
       const repoPath = createTempDir();
       const git = await initGitRepo(repoPath);
       const db = createIntegrationTestDatabase(join(repoPath, "orchestrator.sqlite"));
       const runId = "epic-child-integration-run";
       db.run("INSERT INTO epic_orchestrations (epic_id) VALUES ('epic-a')");
       db.run("INSERT INTO agent_runs (id,role,status,output,epic_id) VALUES ($id,'Integration','COMPLETED','{\"outcome\":\"PASS\"}','epic-a')", { id: runId });
       db.run("INSERT INTO orchestration_phase_runs (agent_run_id,epic_id,task_id,phase,validated) VALUES ($id,'epic-a','task-child','integration',1)", { id: runId });
       const integration = new IntegrationService({ git, database: db, provenanceDatabasePath: join(repoPath, "orchestrator.sqlite"), worktreeDir: createTempDir(), integrationRunId: runId });
       const attempt = await integration.prepareIntegration("HEAD", "master", repoPath);
       db.run("UPDATE integration_attempts SET status='MERGED' WHERE id=$id", { id: attempt.id });
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
      await git.run(repoPath, ["checkout", "-b", "epic/EPIC-RECOVERY"]);
      writeFileSync(join(repoPath, "feature.txt"), "feature");
      await git.run(repoPath, ["add", "feature.txt"]);
      await git.run(repoPath, ["commit", "-m", "feature"]);
      await git.run(repoPath, ["checkout", "master"]);

      const databasePath = join(repoPath, "orchestrator.sqlite");
      let db = createIntegrationTestDatabase(databasePath);
      seedApprovedEpicContext(db, repoPath, "epic-recovery", "EPIC-RECOVERY");
      const runId = "integration-recovery-run";
       db.run("INSERT INTO epic_orchestrations (epic_id) VALUES ('epic-recovery')");
       db.run("INSERT INTO orchestration_phase_runs (agent_run_id,epic_id,phase,validated) VALUES ($id,'epic-recovery','integration',1)", { id: runId });
       db.run("INSERT INTO agent_runs (id,role,status,output,epic_id) VALUES ($id,'Integration','STARTED',NULL,'epic-recovery')", { id: runId });
      const integration = new IntegrationService({ git, database: db, provenanceDatabasePath: join(repoPath, "orchestrator.sqlite"), worktreeDir: createTempDir(), integrationRunId: runId });
      const attempt = await integration.prepareIntegration("epic/EPIC-RECOVERY", "master", repoPath);
      db.run("UPDATE agent_runs SET capability_json=$capability WHERE id=$id", { id: runId, capability: JSON.stringify({ workspace: attempt.worktreePath }) });
      await integration.mergePreparedSource(attempt);
      await integration.runInIntegrationWorktree(attempt, async () => {
        db.run("UPDATE agent_runs SET status='COMPLETED',output=$output WHERE id=$id", { id: runId, output: JSON.stringify(integrationPassOutput(attempt)) });
      });
      const approvalStore = new Map([["approval-recovery", { id: "approval-recovery", subjectId: "epic-recovery", type: "FINAL_MERGE", status: "APPROVED" }]]);
      const originalRun = db.run.bind(db);
      const failJournalWrite = true;
      db.run = (sql: string, params?: StatementParams): void => {
        if (failJournalWrite && (sql.includes("SET status='VERIFIED'") || sql.includes("SET status='FAILED'"))) {
          throw new Error("simulated journal crash");
        }
        originalRun(sql, params);
      };
      const firstService = new MergeService({ database: db, git, repoPath, approvalStore });
      await expect(firstService.mergeApprovedForIntegration("epic-recovery", "approval-recovery", runId)).rejects.toThrow("simulated journal crash");
      expect(db.get<{ status: string }>("SELECT status FROM git_operations")).toEqual({ status: "STARTED" });
      db.close();
      db = createSqliteDatabase(databasePath);
      expect(db.get<{ status: string }>("SELECT status FROM git_operations")).toEqual({ status: "STARTED" });
      const mergeHeadBeforeRecovery = (await git.run(repoPath, ["rev-parse", "master"])).stdout.trim();

      const secondService = new MergeService({ database: db, git, repoPath, approvalStore });
      const result = await secondService.mergeApprovedForIntegration("epic-recovery", "approval-recovery", runId);
      expect(result.verifiedCompletion).toBe(true);
      expect(db.get<{ status: string; resulting_target_sha: string }>("SELECT status,resulting_target_sha FROM git_operations")).toMatchObject({
        status: "VERIFIED",
        resulting_target_sha: result.resultingTargetSha,
      });
      expect((await git.run(repoPath, ["show", "master:feature.txt"])).stdout.trim()).toBe("feature");
      expect((await git.run(repoPath, ["rev-parse", "master"])).stdout.trim()).toBe(mergeHeadBeforeRecovery);
      expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM git_operations")).toEqual({ count: 1 });
      db.close();
    });

    it("rejects retry after a STARTED reconciliation detects target drift", async () => {
      const repoPath = createTempDir();
      const git = await initGitRepo(repoPath);
      await git.run(repoPath, ["checkout", "-b", "epic/EPIC-DRIFT"]);
      writeFileSync(join(repoPath, "feature.txt"), "feature");
      await git.run(repoPath, ["add", "feature.txt"]);
      await git.run(repoPath, ["commit", "-m", "feature"]);
      await git.run(repoPath, ["checkout", "master"]);

      const db = createIntegrationTestDatabase(join(repoPath, "orchestrator.sqlite"));
      seedApprovedEpicContext(db, repoPath, "epic-drift", "EPIC-DRIFT");
      const runId = "integration-drift-run";
       db.run("INSERT INTO epic_orchestrations (epic_id) VALUES ('epic-drift')");
       db.run("INSERT INTO orchestration_phase_runs (agent_run_id,epic_id,phase,validated) VALUES ($id,'epic-drift','integration',1)", { id: runId });
       db.run("INSERT INTO agent_runs (id,role,status,output,epic_id) VALUES ($id,'Integration','STARTED',NULL,'epic-drift')", { id: runId });
      const integration = new IntegrationService({ git, database: db, provenanceDatabasePath: join(repoPath, "orchestrator.sqlite"), worktreeDir: createTempDir(), integrationRunId: runId });
      const attempt = await integration.prepareIntegration("epic/EPIC-DRIFT", "master", repoPath);
      db.run("UPDATE agent_runs SET capability_json=$capability WHERE id=$id", { id: runId, capability: JSON.stringify({ workspace: attempt.worktreePath }) });
      await integration.mergePreparedSource(attempt);
      await integration.runInIntegrationWorktree(attempt, async () => {
        db.run("UPDATE agent_runs SET status='COMPLETED',output=$output WHERE id=$id", { id: runId, output: JSON.stringify(integrationPassOutput(attempt)) });
      });
      db.run("INSERT INTO git_operations (id,type,status,repo_path,branch_name,target_ref,created_at,approval_id,source_sha,expected_target_sha) VALUES ('drift-op','MERGE','STARTED',$repo,'epic/EPIC-DRIFT','master',$at,'approval-drift',$source,$expected)", {
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
      
      // Сначала добавляем файл в master, поскольку в тесте merge ничего не меняет.
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
      
      // Операция должна пройти при корректном approval.
      const result = await mergeService.mergeApproved("subject-123", "approval-456");
      
      expect(result.success).toBe(true);
      expect(result.subjectId).toBe("subject-123");
      expect(result.mergeCommitSha).toBeDefined();
      
      // Проверяем наличие файла в master после merge.
      const content = await git.run(repoPath, ["show", "master:readme.txt"]);
      expect(content.stdout.trim()).toBe("readme content");
    });

    it("verifies target SHA after merge", async () => {
      const repoPath = createTempDir();
      const git = await initGitRepo(repoPath);
      
      // Сначала добавляем файл в master.
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
      
      // Проверяем, что итоговый SHA записан.
      expect(result.resultingTargetSha).toBeDefined();
      expect(result.resultingTargetSha).toBeTruthy();
      
      // Проверяем соответствие SHA значению, которое сообщает git.
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
      
      // Сначала добавляем файл в master.
      writeFileSync(join(repoPath, "readme.txt"), "readme content");
      await git.run(repoPath, ["add", "readme.txt"]);
      await git.run(repoPath, ["commit", "-m", "add readme"]);
      
      // Добавляем pre-commit hook, который завершился бы ошибкой.
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
      
      // Операция должна пройти несмотря на ошибочный hook, поскольку hooks отключены.
      const result = await mergeService.mergeApproved("subject-123", "approval-456");
      
      expect(result.success).toBe(true);
    });
  });
});
