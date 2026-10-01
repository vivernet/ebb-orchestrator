import { describe, it, expect, vi } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { GitCli } from "../../../src/modules/git/git-cli.js";
import { IntegrationService } from "../../../src/modules/git/integration-service.js";
import { createIntegrationTestDatabase } from "../../helpers/integration-database.js";

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "git-integration-"));
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

function createIntegrationService(options: { git?: GitCli; worktreeDir?: string; integrationRunId?: string; finalizeRunFailure?: (runId: string, error: unknown) => boolean } = {}): { service: IntegrationService; database: ReturnType<typeof createIntegrationTestDatabase> } {
  const provenanceDatabasePath = join(createTempDir(), "provenance.sqlite");
  const database = createIntegrationTestDatabase(provenanceDatabasePath);
  return { service: new IntegrationService({ ...options, database, provenanceDatabasePath }), database };
}

function boundService(git: GitCli, finalizeRunFailure?: (runId: string, error: unknown) => boolean): { service: IntegrationService; database: ReturnType<typeof createIntegrationTestDatabase> } {
  const { service, database } = createIntegrationService({ git, integrationRunId: "integration-run", ...(finalizeRunFailure ? { finalizeRunFailure } : {}) });
  database.run("INSERT INTO agent_runs (id, role, status) VALUES ('integration-run', 'Integration', 'STARTED')");
  return { service, database };
}

class MoveTargetDuringWorktreeCreationGit extends GitCli {
  private moved = false;
  constructor(private readonly targetSha: string) { super(); }
  override async run(repoPath: string, args: string[]) {
    if (!this.moved && args.includes("worktree") && args.includes("add")) {
      this.moved = true;
      await super.run(repoPath, ["update-ref", "refs/heads/master", this.targetSha]);
    }
    return super.run(repoPath, args);
  }
}

describe("IntegrationService", () => {
  describe("cleanupIntegration", () => {
    it("keeps a dirty integration worktree when cleanup is rejected", async () => {
      const repoPath = createTempDir();
      const git = await initGitRepo(repoPath);
      const worktreeDir = createTempDir();
      const service = createIntegrationService({ git, worktreeDir }).service;
      const attempt = await service.prepareIntegration("master", "master", repoPath);

      writeFileSync(join(attempt.worktreePath, "uncommitted.txt"), "keep me");

      await expect(service.cleanupIntegration(attempt)).rejects.toThrow("Cannot remove dirty integration worktree");
      expect(readFileSync(join(attempt.worktreePath, "uncommitted.txt"), "utf8")).toBe("keep me");

      await git.run(repoPath, ["worktree", "remove", "--force", attempt.worktreePath]);
      rmSync(worktreeDir, { recursive: true, force: true });
    });
  });

  describe("prepareIntegration", () => {
    it("binds the immutable Run provenance at attempt creation and treats the same bind as verification", async () => {
      const repoPath = createTempDir();
      const git = await initGitRepo(repoPath);
      const { service, database } = boundService(git);
      const attempt = await service.prepareIntegration("master", "master", repoPath);

      expect(attempt.integrationRunId).toBe("integration-run");
      expect(database.get<{ integration_run_id: string }>("SELECT integration_run_id FROM integration_attempts WHERE id=$id", { id: attempt.id }))
        .toEqual({ integration_run_id: "integration-run" });
      expect(service.bindIntegrationRun(attempt, "integration-run")).toMatchObject({ integrationRunId: "integration-run" });
      expect(() => service.bindIntegrationRun(attempt, "another-run")).toThrow("integrationRunId does not match the persisted attempt");

      await service.cleanupIntegration(attempt);
    });

    it("does not move an existing integration branch when its generated name collides", async () => {
      const repoPath = createTempDir();
      const worktreeDir = createTempDir();
      const timestamp = 1_700_000_000_000;
      const randomValue = 0.5;
      const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(timestamp);
      const randomSpy = vi.spyOn(Math, "random").mockReturnValue(randomValue);

      try {
        const git = await initGitRepo(repoPath);
        await git.run(repoPath, ["checkout", "-b", "unrelated-commit"]);
        writeFileSync(join(repoPath, "unrelated.txt"), "keep existing branch commit");
        await git.run(repoPath, ["add", "unrelated.txt"]);
        await git.run(repoPath, ["commit", "-m", "unrelated branch commit"]);
        const existingCommit = (await git.run(repoPath, ["rev-parse", "HEAD"])).stdout.trim();
        await git.run(repoPath, ["checkout", "master"]);

        const generatedAttemptId = `integration-${timestamp}-${randomValue.toString(36).slice(2, 9)}`;
        const collidingBranch = `integration/${generatedAttemptId}`;
        await git.run(repoPath, ["branch", collidingBranch, existingCommit]);
        const targetCommit = (await git.run(repoPath, ["rev-parse", "master"])).stdout.trim();
        expect(existingCommit).not.toBe(targetCommit);

        const service = createIntegrationService({ git, worktreeDir }).service;
        let preparationError: unknown;
        try {
          await service.prepareIntegration("master", "master", repoPath);
        } catch (error) {
          preparationError = error;
        }

        const branchAfterPreparation = (await git.run(repoPath, ["rev-parse", collidingBranch])).stdout.trim();
        expect(branchAfterPreparation).toBe(existingCommit);
        expect(preparationError).toMatchObject({
          stderr: expect.stringMatching(/already exists/i),
        });
      } finally {
        dateNowSpy.mockRestore();
        randomSpy.mockRestore();
        if (existsSync(worktreeDir)) rmSync(worktreeDir, { recursive: true, force: true });
        rmSync(repoPath, { recursive: true, force: true });
      }
    });

    it("creates integration worktree from current target branch", async () => {
      const repoPath = createTempDir();
      const git = await initGitRepo(repoPath);

      // Создаём исходную ветку с изменениями.
      await git.run(repoPath, ["checkout", "-b", "feature-branch"]);
      writeFileSync(join(repoPath, "feature.txt"), "feature content");
      await git.run(repoPath, ["add", "feature.txt"]);
      await git.run(repoPath, ["commit", "-m", "add feature"]);
      await git.run(repoPath, ["checkout", "master"]);

      const integrationService = createIntegrationService().service;
      const attempt = await integrationService.prepareIntegration("feature-branch", "master", repoPath);

      expect(attempt.id).toBeDefined();
      expect(attempt.sourceBranch).toBe("feature-branch");
      expect(attempt.currentTargetBranch).toBe("master");
      expect(attempt.worktreePath).toBeDefined();
      expect(attempt.status).toBe("PREPARED");

      // Проверяем наличие worktree на правильной ветке.
      const worktreeGit = new GitCli();
      const branchStatus = await worktreeGit.run(attempt.worktreePath, ["branch", "--show-current"]);
      expect(branchStatus.stdout.trim()).toContain("integration/");

      // Очищаем ресурсы.
      await integrationService.cleanupIntegration(attempt);
    });

    it("handles moving target branch correctly", async () => {
      const repoPath = createTempDir();
      const git = await initGitRepo(repoPath);

      // Создаём исходную ветку.
      await git.run(repoPath, ["checkout", "-b", "source-branch"]);
      writeFileSync(join(repoPath, "source.txt"), "source content");
      await git.run(repoPath, ["add", "source.txt"]);
      await git.run(repoPath, ["commit", "-m", "source commit"]);
      await git.run(repoPath, ["checkout", "master"]);

      // Получаем исходный SHA ветки master.
      const initialResult = await git.run(repoPath, ["rev-parse", "master"]);
      const initialSha = initialResult.stdout.trim();

      // Имитируем перемещение target после merge другой задачи.
      writeFileSync(join(repoPath, "target-update.txt"), "target update");
      await git.run(repoPath, ["add", "target-update.txt"]);
      await git.run(repoPath, ["commit", "-m", "target update"]);
      const finalResult = await git.run(repoPath, ["rev-parse", "master"]);
      const finalSha = finalResult.stdout.trim();

      expect(initialSha).not.toBe(finalSha);

      // Подготавливаем интеграцию — должен использоваться текущий target SHA.
      const integrationService = createIntegrationService().service;
      const attempt = await integrationService.prepareIntegration("source-branch", "master", repoPath);

      // Проверяем, что worktree создан от итогового перемещённого target.
      const worktreeGit = new GitCli();
      const worktreeHead = await worktreeGit.run(attempt.worktreePath, ["rev-parse", "HEAD"]);
      expect(worktreeHead.stdout.trim()).toBe(finalSha);

      // Очищаем ресурсы.
      await integrationService.cleanupIntegration(attempt);
    });

    it("never experiments in task worktree or master", async () => {
      const repoPath = createTempDir();
      const git = await initGitRepo(repoPath);

      // Создаём feature branch как источник.
      await git.run(repoPath, ["checkout", "-b", "task-123"]);
      writeFileSync(join(repoPath, "task.txt"), "task content");
      await git.run(repoPath, ["add", "task.txt"]);
      await git.run(repoPath, ["commit", "-m", "task changes"]);
      await git.run(repoPath, ["checkout", "master"]);

      // Сохраняем состояние master до интеграции.
      const masterBefore = await git.run(repoPath, ["rev-parse", "master"]);

      const integrationService = createIntegrationService().service;
      const attempt = await integrationService.prepareIntegration("task-123", "master", repoPath);

      // Проверяем, что master не изменился.
      const masterAfter = await git.run(repoPath, ["rev-parse", "master"]);
      expect(masterBefore.stdout.trim()).toBe(masterAfter.stdout.trim());

      // Очищаем ресурсы.
      await integrationService.cleanupIntegration(attempt);
    });
  });

  describe("target SHA verification", () => {
    it("service-merges the prepared source before the agent runs", async () => {
      const repoPath = createTempDir();
      const git = await initGitRepo(repoPath);
      await git.run(repoPath, ["checkout", "-b", "source-branch"]);
      writeFileSync(join(repoPath, "source.txt"), "source content");
      await git.run(repoPath, ["add", "source.txt"]);
      await git.run(repoPath, ["commit", "-m", "source commit"]);
      await git.run(repoPath, ["checkout", "master"]);
      const { service } = boundService(git);
      const attempt = await service.prepareIntegration("source-branch", "master", repoPath);

      await service.mergePreparedSource(attempt);

      expect(readFileSync(join(attempt.worktreePath, "source.txt"), "utf8")).toBe("source content");
      expect((await git.run(attempt.worktreePath, ["rev-parse", "HEAD"])).stdout.trim()).not.toBe(attempt.expectedTargetSha);
      expect((await git.run(repoPath, ["rev-parse", "master"])).stdout.trim()).toBe(attempt.expectedTargetSha);
      await service.cleanupIntegration(attempt);
    });

    it("merges the source commit recorded at preparation even if its branch advances", async () => {
      const repoPath = createTempDir();
      const git = await initGitRepo(repoPath);
      await git.run(repoPath, ["checkout", "-b", "source-branch"]);
      writeFileSync(join(repoPath, "prepared.txt"), "prepared source");
      await git.run(repoPath, ["add", "prepared.txt"]);
      await git.run(repoPath, ["commit", "-m", "prepared source"]);
      await git.run(repoPath, ["checkout", "master"]);
      const { service } = boundService(git);
      const attempt = await service.prepareIntegration("source-branch", "master", repoPath);

      await git.run(repoPath, ["checkout", "source-branch"]);
      writeFileSync(join(repoPath, "later.txt"), "after preparation");
      await git.run(repoPath, ["add", "later.txt"]);
      await git.run(repoPath, ["commit", "-m", "later source change"]);
      await git.run(repoPath, ["checkout", "master"]);

      await service.mergePreparedSource(attempt);

      expect(readFileSync(join(attempt.worktreePath, "prepared.txt"), "utf8")).toBe("prepared source");
      expect(existsSync(join(attempt.worktreePath, "later.txt"))).toBe(false);
      expect((await git.run(attempt.worktreePath, ["merge-base", "--is-ancestor", attempt.sourceSha, "HEAD"])).exitCode).toBe(0);
      await service.cleanupIntegration(attempt);
    });

    it("anchors the integration worktree to the captured target when the branch moves during creation", async () => {
      const repoPath = createTempDir();
      const setupGit = await initGitRepo(repoPath);
      await setupGit.run(repoPath, ["checkout", "-b", "moved-target"]);
      writeFileSync(join(repoPath, "target-change.txt"), "new target");
      await setupGit.run(repoPath, ["add", "target-change.txt"]);
      await setupGit.run(repoPath, ["commit", "-m", "new target"]);
      const movedTargetSha = (await setupGit.run(repoPath, ["rev-parse", "HEAD"])).stdout.trim();
      await setupGit.run(repoPath, ["checkout", "master"]);
      const capturedTargetSha = (await setupGit.run(repoPath, ["rev-parse", "master"])).stdout.trim();
      const git = new MoveTargetDuringWorktreeCreationGit(movedTargetSha);
      const { service } = boundService(git);
      const attempt = await service.prepareIntegration("master", "master", repoPath);

      expect((await git.run(attempt.worktreePath, ["rev-parse", "HEAD"])).stdout.trim()).toBe(capturedTargetSha);
      await expect(service.mergePreparedSource(attempt)).rejects.toThrow("TARGET_MOVED");
      await service.cleanupIntegration(attempt);
    });

    it("records and verifies resulting target SHA after merge", async () => {
      const repoPath = createTempDir();
      const git = await initGitRepo(repoPath);

      // Создаём исходную ветку с изменениями.
      await git.run(repoPath, ["checkout", "-b", "merge-source"]);
      writeFileSync(join(repoPath, "merge-file.txt"), "merge content");
      await git.run(repoPath, ["add", "merge-file.txt"]);
      await git.run(repoPath, ["commit", "-m", "merge commit"]);
      await git.run(repoPath, ["checkout", "master"]);

      const integrationService = createIntegrationService().service;
      const attempt = await integrationService.prepareIntegration("merge-source", "master", repoPath);

      // Попытка интеграции должна отслеживать ожидаемый target.
      expect(attempt.expectedTargetBranch).toBe("master");

      // Очищаем ресурсы.
      await integrationService.cleanupIntegration(attempt);
    });

    it("rejects a target that moved before marking integration merged", async () => {
      const repoPath = createTempDir();
      const git = await initGitRepo(repoPath);
       const { service, database } = boundService(git);
      const attempt = await service.prepareIntegration("master", "master", repoPath);

      writeFileSync(join(repoPath, "moved.txt"), "target moved");
      await git.run(repoPath, ["add", "moved.txt"]);
      await git.run(repoPath, ["commit", "-m", "move target"]);

      await expect(service.runInIntegrationWorktree(attempt, async () => undefined))
        .rejects.toThrow(/TARGET_MOVED/);
      expect(attempt.status).toBe("FAILED");
       expect(database.get<{ status: string; output: string; ended_at: string; exit_code: number }>(
         "SELECT status, output, ended_at, exit_code FROM agent_runs WHERE id = 'integration-run'",
       )).toMatchObject({ status: "STARTED", output: null, ended_at: null, exit_code: null });
       await expect(git.run(attempt.worktreePath, ["rev-parse", "HEAD"])).resolves.toMatchObject({ exitCode: 0 });
       await service.cleanupIntegration(attempt);
    });

    it("delegates Run failure and removes its worktree only when the runtime command confirms terminalization", async () => {
      const repoPath = createTempDir();
      const git = await initGitRepo(repoPath);
      const finalizer = vi.fn(() => true);
      const { service, database } = boundService(git, finalizer);
      const attempt = await service.prepareIntegration("master", "master", repoPath);

      await expect(service.runInIntegrationWorktree(attempt, async () => { throw new Error("integration execution failed"); }))
        .rejects.toThrow("integration execution failed");

      expect(finalizer).toHaveBeenCalledTimes(1);
      expect(finalizer).toHaveBeenCalledWith("integration-run", expect.any(Error));
      expect(database.get<{ status: string }>("SELECT status FROM integration_attempts WHERE id=$id", { id: attempt.id }))
        .toEqual({ status: "FAILED" });
      await expect(git.run(attempt.worktreePath, ["rev-parse", "HEAD"])).rejects.toThrow();
    });

    it("rejects a runner that mutates integration provenance", async () => {
      const repoPath = createTempDir();
      const git = await initGitRepo(repoPath);
       const { service } = boundService(git);
      const attempt = await service.prepareIntegration("master", "master", repoPath);

      await expect(service.runInIntegrationWorktree(attempt, async (_path, runnerAttempt) => {
       (runnerAttempt as { expectedTargetSha: string }).expectedTargetSha = "forged-sha";
      })).rejects.toThrow(/INTEGRATION_PROVENANCE_MUTATED/);
       expect(attempt.status).toBe("FAILED");
      await service.cleanupIntegration(attempt);
     });

    it("rejects an attempt without a bound integration run", async () => {
      const repoPath = createTempDir();
      const git = await initGitRepo(repoPath);
      const service = createIntegrationService({ git }).service;
      const attempt = await service.prepareIntegration("master", "master", repoPath);

      await expect(service.runInIntegrationWorktree(attempt, async () => undefined))
        .rejects.toThrow("integrationRunId is required");
    });
  });
});
