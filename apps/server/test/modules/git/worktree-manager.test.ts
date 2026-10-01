import { describe, expect, it } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";

import { GitCli } from "../../../src/modules/git/git-cli.js";
import { WorktreeManager } from "../../../src/modules/git/worktree-manager.js";
import { BranchManager } from "../../../src/modules/git/branch-manager.js";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "git-wt-"));
}

async function initGitRepo(path: string): Promise<GitCli> {
  const git = new GitCli();
  await git.run(path, ["init"]);
  await git.run(path, ["config", "user.email", "test@example.com"]);
  await git.run(path, ["config", "user.name", "Test User"]);
  
  // Создаём начальный commit в master.
  writeFileSync(join(path, "README.md"), "# Test");
  await git.run(path, ["add", "README.md"]);
  await git.run(path, ["commit", "-m", "initial"]);
  
  return git;
}

class FailOnceDuringWorktreeVerificationGitCli extends GitCli {
  constructor(private readonly taskId: string) {
    super();
  }

  override async run(repoPath: string, args: string[]) {
    if (args.includes(`refs/heads/task/${this.taskId}^{commit}`)) {
      throw new Error("simulated verification interruption after git worktree add");
    }
    return super.run(repoPath, args);
  }
}

class FailOnceBeforeWorktreeAddGitCli extends GitCli {
  private failed = false;

  override async run(repoPath: string, args: string[]) {
    if (!this.failed && args.includes("worktree") && args.includes("add")) {
      this.failed = true;
      throw new Error("simulated interruption before git worktree add");
    }
    return super.run(repoPath, args);
  }
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
      
       // Проверяем наличие worktree и правильность его ветки.
       const git = new GitCli();
      const status = await git.run(worktree.path, ["branch", "--show-current"]);
      expect(status.stdout.trim()).toBe("task/task-123");
      
  // Очищаем ресурсы.
      await new GitCli().run(repoPath, ["worktree", "remove", "--force", worktree.path]);
    });

    it("refuses to reset a pre-existing task branch", async () => {
      const repoPath = createTempDir();
      const git = await initGitRepo(repoPath);
      await git.run(repoPath, ["branch", "task/task-existing"]);
      await git.run(repoPath, ["checkout", "task/task-existing"]);
      writeFileSync(join(repoPath, "task-change.txt"), "preserve branch history");
      await git.run(repoPath, ["add", "task-change.txt"]);
      await git.run(repoPath, ["commit", "-m", "task change"]);
      const originalHead = (await git.run(repoPath, ["rev-parse", "task/task-existing"])).stdout.trim();
      await git.run(repoPath, ["checkout", "--detach", "master"]);

      await expect(new WorktreeManager().createTaskWorkspace("task-existing", repoPath, "master")).rejects.toThrow();

      expect((await git.run(repoPath, ["rev-parse", "task/task-existing"])).stdout.trim()).toBe(originalHead);
      expect((await git.run(repoPath, ["branch", "--show-current"])).stdout.trim()).toBe("");
    });

    it("reconciles a STARTED create only when the worktree still matches its target", async () => {
      const repoPath = createTempDir();
      const git = await initGitRepo(repoPath);
      const worktreeDir = createTempDir();
      const databaseRoot = createTempDir();
      const db = createSqliteDatabase(join(databaseRoot, "worktrees.sqlite"));
      db.exec(readFileSync(new URL("../../../src/platform/database/migrations/007_git.sql", import.meta.url), "utf8"));
      const taskId = "task-interrupted";
      const worktreePath = join(worktreeDir, `task-${taskId}`);
      const hooksPath = createTempDir();
      try {
        await git.run(repoPath, ["-c", `core.hooksPath=${hooksPath.replace(/\\/g, "/")}`, "worktree", "add", "-b", `task/${taskId}`, worktreePath, "master"]);
        db.run("INSERT INTO git_operations(id,type,status,repo_path,branch_name,worktree_id,target_ref,created_at) VALUES('task-operation','CREATE_WORKTREE','STARTED',$repo,$branch,$taskId,'master',$now)", {
          repo: repoPath,
          branch: `task/${taskId}`,
          taskId,
          now: new Date().toISOString(),
        });

        const recovered = await new WorktreeManager({ db, worktreeDir }).createTaskWorkspace(taskId, repoPath, "master");

        expect(recovered.path).toBe(worktreePath);
        expect(db.get<{ status: string }>("SELECT status FROM git_operations WHERE id='task-operation'")?.status).toBe("VERIFIED");
        expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM worktrees WHERE id=$taskId AND removed_at IS NULL", { taskId })?.count).toBe(1);
      } finally {
        db.close();
        rmSync(repoPath, { recursive: true, force: true });
        rmSync(worktreeDir, { recursive: true, force: true });
        rmSync(databaseRoot, { recursive: true, force: true });
        rmSync(hooksPath, { recursive: true, force: true });
      }
    });

    it("preserves and reconciles Git state after post-create verification fails", async () => {
      const repoPath = createTempDir();
      const git = await initGitRepo(repoPath);
      const worktreeDir = createTempDir();
      const databaseRoot = createTempDir();
      const db = createSqliteDatabase(join(databaseRoot, "worktrees.sqlite"));
      db.exec(readFileSync(new URL("../../../src/platform/database/migrations/007_git.sql", import.meta.url), "utf8"));
      const taskId = "task-recoverable";
      const worktreePath = join(worktreeDir, `task-${taskId}`);
      try {
        const interruptedManager = new WorktreeManager({
          db,
          git: new FailOnceDuringWorktreeVerificationGitCli(taskId),
          worktreeDir,
        });

        await expect(interruptedManager.createTaskWorkspace(taskId, repoPath, "master"))
          .rejects.toThrow("simulated verification interruption");

        expect(existsSync(worktreePath)).toBe(true);
        expect((await git.run(repoPath, ["worktree", "list"])).stdout.replace(/\\/g, "/").toLowerCase())
          .toContain(worktreePath.replace(/\\/g, "/").toLowerCase());
        expect((await git.run(repoPath, ["show-ref", "--verify", `refs/heads/task/${taskId}`])).stdout).toContain(`refs/heads/task/${taskId}`);
        expect(db.get<{ status: string }>("SELECT status FROM git_operations WHERE worktree_id=$taskId", { taskId })?.status).toBe("STARTED");

        const recovered = await new WorktreeManager({ db, worktreeDir }).createTaskWorkspace(taskId, repoPath, "master");

        expect(recovered.path).toBe(worktreePath);
        expect(db.get<{ status: string }>("SELECT status FROM git_operations WHERE worktree_id=$taskId", { taskId })?.status).toBe("VERIFIED");
        expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM worktrees WHERE id=$taskId AND removed_at IS NULL", { taskId })?.count).toBe(1);
      } finally {
        await git.run(repoPath, ["worktree", "remove", "--force", worktreePath]).catch(() => undefined);
        db.close();
        rmSync(repoPath, { recursive: true, force: true });
        rmSync(worktreeDir, { recursive: true, force: true });
        rmSync(databaseRoot, { recursive: true, force: true });
      }
    });

    it("retries the exact STARTED operation when no Git mutation occurred", async () => {
      const repoPath = createTempDir();
      const git = await initGitRepo(repoPath);
      const worktreeDir = createTempDir();
      const databaseRoot = createTempDir();
      const db = createSqliteDatabase(join(databaseRoot, "worktrees.sqlite"));
      db.exec(readFileSync(new URL("../../../src/platform/database/migrations/007_git.sql", import.meta.url), "utf8"));
      const taskId = "task-no-mutation";
      const worktreePath = join(worktreeDir, `task-${taskId}`);
      try {
        const interruptedManager = new WorktreeManager({
          db,
          git: new FailOnceBeforeWorktreeAddGitCli(),
          worktreeDir,
        });

        await expect(interruptedManager.createTaskWorkspace(taskId, repoPath, "master"))
          .rejects.toThrow("simulated interruption before git worktree add");
        expect(db.get<{ status: string }>("SELECT status FROM git_operations WHERE worktree_id=$taskId", { taskId })?.status).toBe("STARTED");
        expect(existsSync(worktreePath)).toBe(false);
        expect((await git.run(repoPath, ["for-each-ref", "--format=%(refname)", `refs/heads/task/${taskId}`])).stdout.trim()).toBe("");

        const recovered = await new WorktreeManager({ db, worktreeDir }).createTaskWorkspace(taskId, repoPath, "master");

        expect(recovered.path).toBe(worktreePath);
        expect(db.get<{ status: string }>("SELECT status FROM git_operations WHERE worktree_id=$taskId", { taskId })?.status).toBe("VERIFIED");
        expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM worktrees WHERE id=$taskId AND removed_at IS NULL", { taskId })?.count).toBe(1);
      } finally {
        await git.run(repoPath, ["worktree", "remove", "--force", worktreePath]).catch(() => undefined);
        db.close();
        rmSync(repoPath, { recursive: true, force: true });
        rmSync(worktreeDir, { recursive: true, force: true });
        rmSync(databaseRoot, { recursive: true, force: true });
      }
    });
  });

  describe("removeWorkspace", () => {
    it("keeps a dirty managed worktree when removal is rejected", async () => {
      const repoPath = createTempDir();
      await initGitRepo(repoPath);
      const worktreeDir = createTempDir();
      const db = createSqliteDatabase(join(createTempDir(), "worktrees.sqlite"));
      db.exec(readFileSync(new URL("../../../src/platform/database/migrations/007_git.sql", import.meta.url), "utf8"));
      const manager = new WorktreeManager({ db, worktreeDir });
      const worktree = await manager.createTaskWorkspace("dirty", repoPath, "master");

      writeFileSync(join(worktree.path, "uncommitted.txt"), "keep me");

      await expect(manager.removeWorkspace(worktree.id)).rejects.toThrow("Cannot remove dirty worktree");
      expect(readFileSync(join(worktree.path, "uncommitted.txt"), "utf8")).toBe("keep me");
      expect(existsSync(worktree.path)).toBe(true);

      await new GitCli().run(repoPath, ["worktree", "remove", "--force", worktree.path]);
      db.close();
      rmSync(worktreeDir, { recursive: true, force: true });
    });

    it("removes a worktree", async () => {
      const repoPath = createTempDir();
      await initGitRepo(repoPath);

      const manager = new WorktreeManager();
      const worktree = await manager.createTaskWorkspace("task-456", repoPath, "master");

  // Проверяем наличие worktree.
       const git = new GitCli();
       const listBefore = await git.run(repoPath, ["worktree", "list"]);
      expect(listBefore.stdout).toContain("task/task-456");

  // Удаляем worktree напрямую через git.
      await git.run(repoPath, ["worktree", "remove", "--force", worktree.path]);

  // Проверяем, что worktree удалён.
      const listAfter = await git.run(repoPath, ["worktree", "list"]);
      expect(listAfter.stdout).not.toContain("task/task-456");
    });
  });

  describe("failed creation recovery", () => {
    it("preserves an ambiguous pre-existing managed-path candidate without adopting it", async () => {
      const repoPath = createTempDir();
      const git = await initGitRepo(repoPath);
      const worktreeDir = createTempDir();
      const databaseRoot = createTempDir();
      const db = createSqliteDatabase(join(databaseRoot, "worktrees.sqlite"));
      db.exec(readFileSync(new URL("../../../src/platform/database/migrations/007_git.sql", import.meta.url), "utf8"));
      const taskId = "task-existing-path";
      const worktreePath = join(worktreeDir, `task-${taskId}`);
      mkdirSync(worktreePath);
      const marker = join(worktreePath, "keep.txt");
      writeFileSync(marker, "preserve ambiguous candidate");

      try {
        const manager = new WorktreeManager({ db, worktreeDir });
        await expect(manager.createTaskWorkspace(taskId, repoPath, "master"))
          .rejects.toThrow("already exists without a verified managed journal");

        expect(existsSync(marker)).toBe(true);
        expect(readFileSync(marker, "utf8")).toBe("preserve ambiguous candidate");
        expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM git_operations WHERE worktree_id=$taskId", { taskId })?.count).toBe(0);
        expect((await git.run(repoPath, ["for-each-ref", "--format=%(refname)", `refs/heads/task/${taskId}`])).stdout.trim()).toBe("");
      } finally {
        db.close();
        rmSync(repoPath, { recursive: true, force: true });
        rmSync(worktreeDir, { recursive: true, force: true });
        rmSync(databaseRoot, { recursive: true, force: true });
      }
    });
  });

  describe("hooks are disabled", () => {
      it("does not execute repository hooks when creating worktrees", async () => {
        const repoPath = createTempDir();
        await initGitRepo(repoPath);

      // Создаём pre-commit hook, который завершился бы ошибкой.
      const hooksPath = join(repoPath, ".git", "hooks");
      mkdirSync(hooksPath, { recursive: true });
      writeFileSync(join(hooksPath, "pre-commit"), "#!/bin/bash\nexit 1", "utf8");
      
      // Пытаемся создать worktree — операция должна пройти несмотря на ошибочный hook.
      const manager = new WorktreeManager();
      const worktree = await manager.createTaskWorkspace("task-789", repoPath, "master");

      expect(worktree.id).toBe("task-789");
      
  // Очищаем ресурсы.
      await new GitCli().run(repoPath, ["worktree", "remove", "--force", worktree.path]);
    });
  });
});

describe("BranchManager", () => {
  describe("createEpicBranch", () => {
      it("rejects malformed generated branch refs before git", async () => {
        const repoPath = createTempDir();
        await initGitRepo(repoPath);
        await expect(new BranchManager().createEpicBranch("bad/.id", repoPath, "master"))
          .rejects.toThrow("Invalid Git ref");
      });

      it("creates an epic branch from base ref", async () => {
        const repoPath = createTempDir();
        await initGitRepo(repoPath);

      const manager = new BranchManager();
      const branch = await manager.createEpicBranch("epic-123", repoPath, "master");

      expect(branch.id).toBe("epic-epic-123");
      expect(branch.repoPath).toBe(repoPath);
      expect(branch.name).toBe("epic/epic-123");
      expect(branch.targetRef).toBe("master");
      
       // Проверяем наличие ветки.
       const git = new GitCli();
       const branches = await git.run(repoPath, ["branch"]);
       expect(branches.stdout).toContain("epic/epic-123");
     });
   });

   describe("hooks are disabled", () => {
      it("does not execute repository hooks when creating branches", async () => {
        const repoPath = createTempDir();
        await initGitRepo(repoPath);

      // Создаём pre-commit hook, который завершился бы ошибкой.
      const hooksPath = join(repoPath, ".git", "hooks");
      mkdirSync(hooksPath, { recursive: true });
      writeFileSync(join(hooksPath, "pre-commit"), "#!/bin/bash\nexit 1", "utf8");

      // Пытаемся создать epic branch — операция должна пройти несмотря на ошибочный hook.
      const manager = new BranchManager();
      const branch = await manager.createEpicBranch("epic-456", repoPath, "master");

      expect(branch.id).toBe("epic-epic-456");
      
       // Проверяем наличие ветки.
       const git = new GitCli();
       const branches = await git.run(repoPath, ["branch"]);
       expect(branches.stdout).toContain("epic/epic-456");
     });
   });
 });
