import { describe, it, expect, vi } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { GitCli } from "../../../src/modules/git/git-cli.js";
import { ExitCodeError } from "../../../src/platform/process/process-executor.js";
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

function integrationPassOutput(attempt: Awaited<ReturnType<IntegrationService["prepareIntegration"]>>): Record<string, unknown> {
  return { version: "1.0.0", outcome: "PASS", baseSha: attempt.expectedTargetSha, sourceSha: attempt.sourceSha,
    provenance: [`integration_attempt:${attempt.id}`], evidence: ["Verified integration worktree"] };
}

class MoveTargetBeforePromotionCasGit extends GitCli {
  private moved = false;
  constructor(private readonly raceSha: string, private readonly expectedSha: string) { super(); }
  override async run(repoPath: string, args: string[]) {
    const updateRefAt = args.indexOf("update-ref");
    if (!this.moved && updateRefAt >= 0 && args[updateRefAt + 1] === "refs/heads/master" && args[updateRefAt + 3] === this.expectedSha) {
      this.moved = true;
      await super.run(repoPath, ["update-ref", "refs/heads/master", this.raceSha]);
    }
    return super.run(repoPath, args);
  }
}

class FailOnceBeforeTargetWorktreeSyncGit extends GitCli {
  private failed = false;
  override async run(repoPath: string, args: string[]) {
    if (!this.failed && args[0] === "read-tree" && args.includes("-u")) {
      this.failed = true;
      throw new Error("simulated interruption before target worktree synchronization");
    }
    return super.run(repoPath, args);
  }
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
  it("hides filesystem details when creating the managed integration root fails", () => {
    const root = createTempDir();
    const occupiedPath = join(root, "occupied");
    writeFileSync(occupiedPath, "private filesystem detail");
    const database = createIntegrationTestDatabase(join(root, "database.sqlite"));
    try {
      let thrown: unknown;
      try { new IntegrationService({ database, worktreeDir: occupiedPath }); } catch (error) { thrown = error; }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe("INTEGRATION_PREPARE_ROOT_CREATE_FAILED");
    } finally {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("hides filesystem details when prepareIntegration cannot create its root", async () => {
    const root = createTempDir();
    const worktreeDir = join(root, "worktrees");
    const database = createIntegrationTestDatabase(join(root, "database.sqlite"));
    const service = new IntegrationService({ database, worktreeDir });
    rmSync(worktreeDir, { recursive: true, force: true });
    writeFileSync(worktreeDir, "private filesystem detail");
    try {
      const thrown = await service.prepareIntegration("source", "target", "private-repository-path").catch((error: unknown) => error);
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe("INTEGRATION_PREPARE_ROOT_CREATE_FAILED");
      expect(database.all("SELECT id FROM integration_attempts")).toEqual([]);
    } finally {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

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
    it("hides hooks-directory creation errors before an integration attempt is persisted", async () => {
      const root = createTempDir();
      const worktreeDir = join(root, "worktrees");
      const database = createIntegrationTestDatabase(join(root, "database.sqlite"));
      let refCalls = 0;
      const git = { run: vi.fn(async () => {
        refCalls += 1;
        if (refCalls === 2) rmSync(worktreeDir, { recursive: true, force: true });
        return { exitCode: 0, stdout: "a".repeat(40), stderr: "" };
      }) } as unknown as GitCli;
      const service = new IntegrationService({ database, git, worktreeDir });
      try {
        const thrown = await service.prepareIntegration("source", "target", "private-repository-path").catch((error: unknown) => error);
        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toBe("INTEGRATION_PREPARE_HOOKS_DIR_CREATE_FAILED");
        expect((thrown as Error).cause).toBeInstanceOf(Error);
        expect(database.all("SELECT id FROM integration_attempts")).toEqual([]);
      } finally {
        database.close();
        rmSync(root, { recursive: true, force: true });
      }
    });

    it.each(["master", "source"])("reports safe ref-resolution diagnostics for %s", async (failedRef) => {
      const git = new GitCli();
      const original = new ExitCodeError("git secret-path", 128, "secret-output", "fatal: secret-path is unknown");
      const calls = vi.spyOn(git, "run").mockImplementation(async (_path, args) => {
        if (args[1] === failedRef) throw original;
        return { exitCode: 0, stdout: "a".repeat(40), stderr: "" };
      });
      const { service, database } = createIntegrationService({ git, worktreeDir: createTempDir() });
      await expect(service.prepareIntegration("source", "master", "secret-path")).rejects.toMatchObject({
        message: "INTEGRATION_PREPARE_REFS_FAILED:GIT_EXIT_128:OTHER", cause: original,
      });
      expect(calls).not.toHaveBeenCalledWith(expect.anything(), expect.arrayContaining(["worktree"]));
      expect(database.all("SELECT id FROM integration_attempts")).toEqual([]);
      database.close();
    });

    it.each([
      ["fatal: filename too long: secret-path", "PATH_TOO_LONG"],
      ["fatal: could not create worktree dir '/private/worktree': Filename too long", "PATH_TOO_LONG"],
      ["fatal: could not create worktree dir '/private/worktree': path too long", "PATH_TOO_LONG"],
      ["fatal: a branch named 'secret-branch' already exists", "BRANCH_EXISTS"],
      ["fatal: '$GIT_DIR' too big", "GIT_DIR_TOO_BIG"],
      ["fatal: permission denied", "PERMISSION"],
      ["fatal: could not create leading directories of '/private/worktree': Permission denied", "PERMISSION"],
      ["fatal: could not create worktree dir '/private/worktree': access is denied", "PERMISSION"],
      ["fatal: '/private/worktree' already exists", "WORKTREE_PATH_EXISTS"],
      ["fatal: could not create leading directories of '/private/worktree': File exists", "WORKTREE_PATH_EXISTS"],
      ["fatal: 'secret-branch' is already checked out at '/private/worktree'", "BRANCH_IN_USE"],
      ["fatal: invalid reference: secret-ref", "REF_NOT_FOUND"],
      ["fatal: invalid object name 'secret-ref'", "INVALID_OBJECT"],
      ["fatal: 'secret-ref' is not a commit and a branch 'integration/test' cannot be created from it", "INVALID_OBJECT"],
      ["fatal: not a git repository (or any of the parent directories): .git", "REPOSITORY_UNAVAILABLE"],
      ["fatal: '/private/worktree' is locked", "WORKTREE_LOCKED"],
      ["fatal: refusing to create a worktree within another worktree", "NESTED_WORKTREE"],
      ["fatal: '/private/worktree' is a nested worktree", "NESTED_WORKTREE"],
      ["fatal: could not create directory '/private/path/token': custom failure", "CREATE_REJECTED"],
      ["fatal: unable to add worktree '/private/token': custom failure", "CREATE_REJECTED"],
      ["fatal: write-lock failed for secret-ref", "LOCK_REJECTED"],
      ["fatal: unresolved reference 'secret-token'", "REFERENCE_REJECTED"],
      ["fatal: operation rejected for secret-token worktree", "WORKTREE_REJECTED"],
      ["fatal: branch secret-branch already exists", "OTHER"],
      ["fatal: worktree secret-path is locked by secret-token", "WORKTREE_REJECTED"],
      ["fatal: secret-provider-token", "OTHER"],
    ])("reports allowlisted worktree failure category for %s", async (stderr, category) => {
      const git = new GitCli();
      const original = new ExitCodeError("git secret-path", 128, "secret-output", stderr);
      vi.spyOn(git, "run").mockImplementation(async (_path, args) => {
        if (args.includes("worktree")) throw original;
        return { exitCode: 0, stdout: "a".repeat(40), stderr: "" };
      });
      const { service, database } = createIntegrationService({ git, worktreeDir: createTempDir() });
      const thrown = await service.prepareIntegration("source", "master", "secret-path").catch((error: unknown) => error);
      expect(thrown).toMatchObject({
        message: `INTEGRATION_PREPARE_WORKTREE_FAILED:GIT_EXIT_128:${category}`, cause: original,
      });
      expect(thrown).toBeInstanceOf(Error);
      if (thrown instanceof Error) {
        expect(thrown.message).not.toMatch(/secret|private|token/iu);
      }
      expect(database.all("SELECT id FROM integration_attempts")).toEqual([]);
      database.close();
    });

    it("reports safe persistence failure and still removes a clean newly-created orphan", async () => {
      const repoPath = createTempDir();
      const worktreeDir = createTempDir();
      const git = await initGitRepo(repoPath);
      const { service, database } = createIntegrationService({ git, worktreeDir });
      const original = Object.assign(new Error("secret-path: secret-SQL"), { code: "ERR_SQLITE_ERROR" });
      const dbRun = database.run.bind(database);
      vi.spyOn(database, "run").mockImplementation((sql, params) => {
        if (sql.startsWith("INSERT INTO integration_attempts")) throw original;
        dbRun(sql, params);
      });
      const calls = vi.spyOn(git, "run");
      await expect(service.prepareIntegration("master", "master", repoPath)).rejects.toMatchObject({
        message: "INTEGRATION_PREPARE_PERSISTENCE_FAILED:ERR_SQLITE_ERROR", cause: original,
      });
      const createArgs = calls.mock.calls.find(([, args]) => args.includes("add") && args.includes("worktree"))?.[1];
      expect(createArgs).toBeDefined();
      expect(existsSync(createArgs?.[createArgs.indexOf("-b") + 2] ?? "")).toBe(false);
      expect(database.all("SELECT id FROM integration_attempts")).toEqual([]);
      database.close();
      rmSync(repoPath, { recursive: true, force: true });
      rmSync(worktreeDir, { recursive: true, force: true });
    });

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
          message: expect.stringMatching(/^INTEGRATION_PREPARE_WORKTREE_FAILED:GIT_EXIT_\d+:BRANCH_EXISTS$/),
          cause: { stderr: expect.stringMatching(/already exists/i) },
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
    it("advances the target ref only to the verified integration HEAD", async () => {
      const repoPath = createTempDir();
      const setupGit = await initGitRepo(repoPath);
      const git = new FailOnceBeforeTargetWorktreeSyncGit();
      await setupGit.run(repoPath, ["config", "user.email", "test@example.com"]);
      await git.run(repoPath, ["checkout", "-b", "source"]);
      writeFileSync(join(repoPath, "task.txt"), "task change");
      await git.run(repoPath, ["add", "task.txt"]);
      await git.run(repoPath, ["commit", "-m", "task change"]);
      await git.run(repoPath, ["checkout", "master"]);
      const { service, database } = boundService(git);
      const attempt = await service.prepareIntegration("source", "master", repoPath);
      await service.mergePreparedSource(attempt);
      const advancingService = new IntegrationService({ database, git, worktreeDir: createTempDir(), integrationRunId: "integration-run", advanceTargetBranch: true, targetWorktreePath: repoPath });
      const expectedTarget = attempt.expectedTargetSha;
      const gitCalls = vi.spyOn(git, "run");
      let integrationHead = "";

      await expect(advancingService.runInIntegrationWorktree(attempt, async (workspace) => {
        integrationHead = (await git.run(workspace, ["rev-parse", "HEAD"])).stdout.trim();
        database.run("UPDATE agent_runs SET status='COMPLETED',exit_code=0,ended_at='done',output=$output WHERE id='integration-run'", { output: JSON.stringify(integrationPassOutput(attempt)) });
      })).rejects.toThrow("INTEGRATION_TARGET_WORKTREE_RECONCILIATION_REQUIRED");

      expect((await git.run(repoPath, ["rev-parse", "master"])).stdout.trim()).toBe(integrationHead);
      expect(integrationHead).not.toBe(expectedTarget);
      expect(existsSync(join(repoPath, "task.txt"))).toBe(false);
      const promotion = gitCalls.mock.calls.find(([, args]) => args[0] === "-c" && args.includes("update-ref"));
      expect(promotion?.[1]).toEqual(expect.arrayContaining(["update-ref", "refs/heads/master", integrationHead, expectedTarget]));
      expect(database.get<{ status: string }>("SELECT status FROM integration_attempts WHERE id=$id", { id: attempt.id })?.status).toBe("MERGING");
      const restarted = new IntegrationService({ database, git, worktreeDir: createTempDir(), integrationRunId: "integration-run", advanceTargetBranch: true, targetWorktreePath: repoPath });
      await restarted.completeRecoveredAttempt("integration-run");
      expect(existsSync(join(repoPath, "task.txt"))).toBe(true);
      expect(database.get<{ status: string }>("SELECT status FROM integration_attempts WHERE id=$id", { id: attempt.id })?.status).toBe("MERGED");
      database.close();
    }, 15_000);

    it("does not overwrite a target ref that moves before the compare-and-swap", async () => {
      const repoPath = createTempDir();
      const setupGit = await initGitRepo(repoPath);
      await setupGit.run(repoPath, ["checkout", "-b", "source"]);
      writeFileSync(join(repoPath, "task.txt"), "task change");
      await setupGit.run(repoPath, ["add", "task.txt"]);
      await setupGit.run(repoPath, ["commit", "-m", "task change"]);
      await setupGit.run(repoPath, ["checkout", "master"]);
      await setupGit.run(repoPath, ["checkout", "-b", "race"]);
      writeFileSync(join(repoPath, "race.txt"), "race");
      await setupGit.run(repoPath, ["add", "race.txt"]);
      await setupGit.run(repoPath, ["commit", "-m", "target race"]);
      const raceSha = (await setupGit.run(repoPath, ["rev-parse", "HEAD"])).stdout.trim();
      await setupGit.run(repoPath, ["checkout", "master"]);
      const expectedSha = (await setupGit.run(repoPath, ["rev-parse", "master"])).stdout.trim();
      const git = new MoveTargetBeforePromotionCasGit(raceSha, expectedSha);
      const { service, database } = boundService(git);
      const attempt = await service.prepareIntegration("source", "master", repoPath);
      await service.mergePreparedSource(attempt);
      const advancingService = new IntegrationService({ database, git, worktreeDir: createTempDir(), integrationRunId: "integration-run", advanceTargetBranch: true, targetWorktreePath: repoPath });

      await expect(advancingService.runInIntegrationWorktree(attempt, async () => {
        database.run("UPDATE agent_runs SET status='COMPLETED',exit_code=0,ended_at='done',output=$output WHERE id='integration-run'", { output: JSON.stringify(integrationPassOutput(attempt)) });
      })).rejects.toThrow("TARGET_MOVED");
      expect((await setupGit.run(repoPath, ["rev-parse", "master"])).stdout.trim()).toBe(raceSha);
      expect(database.get<{ status: string }>("SELECT status FROM integration_attempts WHERE id=$id", { id: attempt.id })?.status).toBe("FAILED");
      database.close();
    });

    it("does not overwrite a target rewind racing the expected-OID promotion CAS", async () => {
      const repoPath = createTempDir();
      const setupGit = await initGitRepo(repoPath);
      writeFileSync(join(repoPath, "target.txt"), "second target commit");
      await setupGit.run(repoPath, ["add", "target.txt"]);
      await setupGit.run(repoPath, ["commit", "-m", "advance target"]);
      const expectedSha = (await setupGit.run(repoPath, ["rev-parse", "master"])).stdout.trim();
      await setupGit.run(repoPath, ["checkout", "-b", "source"]);
      writeFileSync(join(repoPath, "task.txt"), "task change");
      await setupGit.run(repoPath, ["add", "task.txt"]);
      await setupGit.run(repoPath, ["commit", "-m", "task change"]);
      const integrationHeadSource = (await setupGit.run(repoPath, ["rev-parse", "HEAD"])).stdout.trim();
      await setupGit.run(repoPath, ["checkout", "master"]);
      const ancestorSha = (await setupGit.run(repoPath, ["rev-parse", "HEAD^"])).stdout.trim();
      const git = new MoveTargetBeforePromotionCasGit(ancestorSha, expectedSha);
      const { service, database } = boundService(git);
      const attempt = await service.prepareIntegration("source", "master", repoPath);
      await service.mergePreparedSource(attempt);
      const advancingService = new IntegrationService({ database, git, worktreeDir: createTempDir(), integrationRunId: "integration-run", advanceTargetBranch: true, targetWorktreePath: repoPath });
      await expect(advancingService.runInIntegrationWorktree(attempt, async () => {
        database.run("UPDATE agent_runs SET status='COMPLETED',exit_code=0,ended_at='done',output=$output WHERE id='integration-run'", { output: JSON.stringify(integrationPassOutput(attempt)) });
      })).rejects.toThrow("TARGET_MOVED");
      expect((await setupGit.run(repoPath, ["rev-parse", "master"])).stdout.trim()).toBe(ancestorSha);
      expect((await setupGit.run(repoPath, ["rev-parse", "HEAD"])).stdout.trim()).toBe(ancestorSha);
      expect(existsSync(join(repoPath, "task.txt"))).toBe(false);
      expect((await setupGit.run(repoPath, ["rev-parse", integrationHeadSource])).stdout.trim()).toBe(integrationHeadSource);
      expect(database.get<{ status: string }>("SELECT status FROM integration_attempts WHERE id=$id", { id: attempt.id })?.status).toBe("FAILED");
      database.close();
    });

    it("preserves a case-only ignored-path collision before target promotion", async () => {
      const repoPath = createTempDir();
      const git = await initGitRepo(repoPath);
      await git.run(repoPath, ["config", "core.ignoreCase", "true"]);
      writeFileSync(join(repoPath, ".gitignore"), "artifact.txt\n");
      await git.run(repoPath, ["add", ".gitignore"]);
      await git.run(repoPath, ["commit", "-m", "ignore local artifact"]);
      await git.run(repoPath, ["checkout", "-b", "source"]);
      writeFileSync(join(repoPath, "Artifact.txt"), "integrated file");
      await git.run(repoPath, ["add", "-f", "Artifact.txt"]);
      await git.run(repoPath, ["commit", "-m", "add artifact"]);
      await git.run(repoPath, ["checkout", "master"]);
      writeFileSync(join(repoPath, "artifact.txt"), "preserve user data");
      const expectedSha = (await git.run(repoPath, ["rev-parse", "HEAD"])).stdout.trim();
      const { service, database } = boundService(git);
      const attempt = await service.prepareIntegration("source", "master", repoPath);
      await service.mergePreparedSource(attempt);
      const advancingService = new IntegrationService({ database, git, worktreeDir: createTempDir(), integrationRunId: "integration-run", advanceTargetBranch: true, targetWorktreePath: repoPath });

      await expect(advancingService.runInIntegrationWorktree(attempt, async () => {
        database.run("UPDATE agent_runs SET status='COMPLETED',exit_code=0,ended_at='done',output=$output WHERE id='integration-run'", { output: JSON.stringify(integrationPassOutput(attempt)) });
      })).rejects.toThrow("INTEGRATION_TARGET_WORKTREE_COLLISION");
      expect((await git.run(repoPath, ["rev-parse", "master"])).stdout.trim()).toBe(expectedSha);
      expect(readFileSync(join(repoPath, "artifact.txt"), "utf8")).toBe("preserve user data");
      expect(database.get<{ status: string }>("SELECT status FROM integration_attempts WHERE id=$id", { id: attempt.id })?.status).toBe("FAILED");
      database.close();
    });

    it("does not advance the target ref when the Integration run fails", async () => {
      const repoPath = createTempDir();
      const git = await initGitRepo(repoPath);
      await git.run(repoPath, ["checkout", "-b", "source"]);
      writeFileSync(join(repoPath, "task.txt"), "task change");
      await git.run(repoPath, ["add", "task.txt"]);
      await git.run(repoPath, ["commit", "-m", "task change"]);
      await git.run(repoPath, ["checkout", "master"]);
      const { service, database } = boundService(git);
      const attempt = await service.prepareIntegration("source", "master", repoPath);
      await service.mergePreparedSource(attempt);
      const advancingService = new IntegrationService({ database, git, worktreeDir: createTempDir(), integrationRunId: "integration-run", advanceTargetBranch: true, targetWorktreePath: repoPath });

      await expect(advancingService.runInIntegrationWorktree(attempt, async () => { throw new Error("integration failed"); }))
        .rejects.toThrow("integration failed");
      expect((await git.run(repoPath, ["rev-parse", "master"])).stdout.trim()).toBe(attempt.expectedTargetSha);
      expect(database.get<{ status: string }>("SELECT status FROM integration_attempts WHERE id=$id", { id: attempt.id })?.status).toBe("FAILED");
      database.close();
    });
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

  describe("completeRecoveredAttempt", () => {
    async function fixture() {
      const root = createTempDir();
      const git = await initGitRepo(root);
      const database = createIntegrationTestDatabase(join(root, "provenance.sqlite"));
      const worktreeDir = join(root, "integration-worktrees");
      const service = new IntegrationService({ database, git, integrationRunId: "integration-run", worktreeDir });
      database.run("INSERT INTO agent_runs(id,role,status) VALUES('integration-run','integration','STARTED')");
      return { root, repoPath: root, git, database, service, worktreeDir };
    }

    it("finishes the existing MERGING attempt only after the same Run completed against the unchanged Git target", async () => {
      const { root, repoPath, git, database, service, worktreeDir } = await fixture();
      try {
      await git.run(repoPath, ["checkout", "-b", "merge-source"]);
      writeFileSync(join(repoPath, "recovered-source.txt"), "source");
      await git.run(repoPath, ["add", "recovered-source.txt"]);
      await git.run(repoPath, ["commit", "-m", "source"]);
      await git.run(repoPath, ["checkout", "master"]);

      const attempt = await service.prepareIntegration("merge-source", "master", repoPath);
      await service.mergePreparedSource(attempt);
      database.run("UPDATE integration_attempts SET status='MERGING' WHERE id=$id", { id: attempt.id });
      database.run("UPDATE agent_runs SET status='COMPLETED',output=$output,ended_at='done',exit_code=0 WHERE id='integration-run'", {
        output: JSON.stringify({ version: "1.0.0", outcome: "PASS", baseSha: attempt.expectedTargetSha, sourceSha: attempt.sourceSha,
          provenance: [`integration_attempt:${attempt.id}`], evidence: ["Verified source and target"] }),
      });

      const restarted = new IntegrationService({ database, git, integrationRunId: "integration-run", worktreeDir });
      const gitCalls = vi.spyOn(git, "run");
      await restarted.completeRecoveredAttempt("integration-run");
      await restarted.completeRecoveredAttempt("integration-run");
      expect(gitCalls.mock.calls.every(([, args]) => args[0] === "merge-base" || args[0] === "rev-parse")).toBe(true);

      expect(database.get<{ status: string }>("SELECT status FROM integration_attempts WHERE id=$id", { id: attempt.id }))
        .toEqual({ status: "MERGED" });
      await expect(git.run(attempt.worktreePath, ["merge-base", "--is-ancestor", attempt.sourceSha, "HEAD"]))
        .resolves.toMatchObject({ exitCode: 0 });
      await service.cleanupIntegration({ ...attempt, status: "MERGED" });
      expect(existsSync(attempt.worktreePath)).toBe(false);
      } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
    });

    it("keeps the existing attempt MERGING when the target moved after Run recovery", async () => {
      const { root, repoPath, git, database, service, worktreeDir } = await fixture();
      try {
      await git.run(repoPath, ["checkout", "-b", "merge-source"]);
      writeFileSync(join(repoPath, "recovered-source.txt"), "source");
      await git.run(repoPath, ["add", "recovered-source.txt"]);
      await git.run(repoPath, ["commit", "-m", "source"]);
      await git.run(repoPath, ["checkout", "master"]);

      const attempt = await service.prepareIntegration("merge-source", "master", repoPath);
      await service.mergePreparedSource(attempt);
      database.run("UPDATE integration_attempts SET status='MERGING' WHERE id=$id", { id: attempt.id });
      database.run("UPDATE agent_runs SET status='COMPLETED',output=$output,ended_at='done',exit_code=0 WHERE id='integration-run'", {
        output: JSON.stringify({ version: "1.0.0", outcome: "PASS", baseSha: attempt.expectedTargetSha, sourceSha: attempt.sourceSha,
          provenance: [`integration_attempt:${attempt.id}`], evidence: ["Verified source and target"] }),
      });
      writeFileSync(join(repoPath, "moved.txt"), "target moved");
      await git.run(repoPath, ["add", "moved.txt"]);
      await git.run(repoPath, ["commit", "-m", "move target"]);

      const restarted = new IntegrationService({ database, git, integrationRunId: "integration-run", worktreeDir });
      await expect(restarted.completeRecoveredAttempt("integration-run")).rejects.toThrow(/TARGET_MOVED/);
      expect(database.get<{ status: string }>("SELECT status FROM integration_attempts WHERE id=$id", { id: attempt.id }))
        .toEqual({ status: "MERGING" });
      expect(existsSync(attempt.worktreePath)).toBe(true);
      await service.cleanupIntegration({ ...attempt, status: "PREPARED" });
      expect(existsSync(attempt.worktreePath)).toBe(false);
      } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
    });

    it.each(["invalid-output", "wrong-output-provenance", "failed-run", "wrong-role", "prepared", "failed-attempt", "duplicate-attempt", "wrong-target-binding", "missing-ancestry"])(
      "preserves the existing attempt when recovery evidence is invalid: %s", async (variant) => {
        const root = createTempDir();
        const database = createIntegrationTestDatabase(join(root, "provenance.sqlite"));
        const git = new GitCli();
        const gitCalls = vi.spyOn(git, "run").mockRejectedValue(new Error("missing ancestry"));
        const attemptId = "recovery-attempt";
        const baseSha = "a".repeat(40);
        const sourceSha = "b".repeat(40);
        database.run("INSERT INTO agent_runs(id,role,status,output,ended_at,exit_code) VALUES('integration-run',$role,$status,$output,'done',0)", {
          role: variant === "wrong-role" ? "developer" : "integration", status: variant === "failed-run" ? "FAILED" : "COMPLETED",
          output: variant === "invalid-output" ? "{}" : JSON.stringify({ version: "1.0.0", outcome: "PASS", baseSha, sourceSha,
            provenance: [`integration_attempt:${variant === "wrong-output-provenance" ? "other" : attemptId}`], evidence: ["Verified"] }),
        });
        const status = variant === "prepared" ? "PREPARED" : variant === "failed-attempt" ? "FAILED" : "MERGING";
        database.run(`INSERT INTO integration_attempts(id,repository_path,source_branch,target_branch,expected_target_sha,source_sha,worktree_path,integration_run_id,status,created_at)
          VALUES($id,'repo','source','master',$base,$source,'workspace','integration-run',$status,'now')`, { id: attemptId, base: baseSha, source: sourceSha, status });
        if (variant === "duplicate-attempt") database.run(`INSERT INTO integration_attempts SELECT 'other',repository_path,source_branch,target_branch,expected_target_sha,source_sha,worktree_path,integration_run_id,status,created_at FROM integration_attempts WHERE id=$id`, { id: attemptId });
        const service = new IntegrationService({ database, git, integrationRunId: "integration-run", worktreeDir: join(root, "worktrees") });
        try {
          await expect(service.completeRecoveredAttempt("integration-run", {
            repoPath: "repo", sourceBranch: "source", targetBranch: variant === "wrong-target-binding" ? "other" : "master",
          })).rejects.toThrow(/INTEGRATION_(RECOVERY|SNAPSHOT)_/);
          expect(database.get("SELECT status FROM integration_attempts WHERE id=$id", { id: attemptId })).toEqual({ status });
          if (variant !== "missing-ancestry") expect(gitCalls).not.toHaveBeenCalled();
        } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
      },
    );
  });
});
