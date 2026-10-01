import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "fs";
import { isAbsolute, join, relative, resolve } from "path";
import { tmpdir } from "os";
import { GitCli, assertSafeGitRef } from "./git-cli.js";
import type { Database } from "../../platform/database/database.js";
import { WorktreeRepository } from "./worktree-repository.js";
import { GitOperationRepository } from "./git-operation-repository.js";

export interface WorktreeManagerOptions {
  git?: GitCli;
  db?: Database;
  worktreeDir?: string;
}

export interface WorktreeRecord {
  id: string;
  repoPath: string;
  path: string;
  branch: string;
  createdAt: string;
  removedAt: string | null;
}

/**
 * Инкапсулирует операцию Git worktree-manager с журналированием и проверкой целевого repository/worktree.
 */
export class WorktreeManager {
  private readonly git: GitCli;
  private readonly db: Database | undefined;
  private readonly worktreeRepo: WorktreeRepository | null;
  private readonly gitOperationRepo: GitOperationRepository | null;
  private readonly worktreeDir: string;

  constructor(options: WorktreeManagerOptions = {}) {
    this.git = options.git ?? new GitCli();
    this.db = options.db;
    this.worktreeRepo = options.db ? new WorktreeRepository(options.db) : null;
    this.gitOperationRepo = options.db ? new GitOperationRepository(options.db) : null;
    this.worktreeDir = options.worktreeDir ?? join(tmpdir(), "orchestrator-worktrees");
  }

  /**
   * Создаёт управляемый worktree для задачи.
   * Использует отключённые hooks для предотвращения произвольного выполнения кода.
   */
  async createTaskWorkspace(
    taskId: string,
    repoPath: string,
    targetRef: string
  ): Promise<WorktreeRecord> {
    const branch = `task/${taskId}`;
    assertSafeGitRef(branch);
    assertSafeGitRef(targetRef);
    const worktreePath = join(this.worktreeDir, `task-${taskId}`);
    
    // Гарантирует существование родительской директории worktree
    try {
      mkdirSync(this.worktreeDir, { recursive: true });
    } catch {
      // Пропускаем если директория уже существует или не может быть создана
    }
    
    const targetHead = (await this.git.run(repoPath, ["rev-parse", "--verify", "--end-of-options", `${targetRef}^{commit}`])).stdout.trim();
    if (!targetHead) throw new Error("Task workspace target ref does not resolve to a commit");
    const persistedOperations = this.db?.all<{
      id: string; type: string; status: string; repo_path: string; branch_name: string | null;
      worktree_id: string | null; target_ref: string | null;
    }>("SELECT id,type,status,repo_path,branch_name,worktree_id,target_ref FROM git_operations WHERE repo_path=$repoPath AND branch_name=$branch AND worktree_id=$taskId ORDER BY created_at", {
      repoPath, branch, taskId,
    }) ?? [];
    const persistedRows = this.db?.all<{
      id: string; repo_path: string; path: string; branch: string; created_at: string; removed_at: string | null;
    }>("SELECT id,repo_path,path,branch,created_at,removed_at FROM worktrees WHERE id=$taskId", { taskId }) ?? [];
    if (persistedOperations.length || persistedRows.length) {
      if (persistedOperations.length > 1 || persistedRows.length > 1) throw new Error("Task workspace journal contains duplicate records");
      const operation = persistedOperations[0];
      const row = persistedRows[0];
      if (!operation || operation.type !== "CREATE_WORKTREE" || operation.status !== "STARTED" && operation.status !== "VERIFIED"
        || operation.repo_path !== repoPath || operation.branch_name !== branch || operation.target_ref !== targetRef || operation.worktree_id !== taskId) {
        throw new Error("Task workspace journal does not match its requested binding");
      }
      if (!row && operation.status === "VERIFIED") throw new Error("Verified task worktree journal is missing its worktree record");
      const recovered: WorktreeRecord = row ? {
        id: row.id,
        repoPath: row.repo_path,
        path: row.path,
        branch: row.branch,
        createdAt: row.created_at,
        removedAt: row.removed_at,
      } : {
        id: taskId,
        repoPath,
        path: worktreePath,
        branch,
        createdAt: new Date().toISOString(),
        removedAt: null,
      };
      if (recovered.repoPath !== repoPath || recovered.path !== worktreePath || recovered.branch !== branch || recovered.removedAt !== null) {
        throw new Error("Task workspace record does not match its managed path");
      }
      if (!row && operation.status === "STARTED" && !pathEntryExists(worktreePath)) {
        const localBranch = await this.git.run(repoPath, ["for-each-ref", "--format=%(refname)", `refs/heads/${branch}`]);
        if (localBranch.stdout.trim()) {
          throw new Error("STARTED task worktree has a branch but no managed worktree path; refusing ambiguous recovery");
        }
        const emptyHooksDir = this.createEmptyHooksDir();
        try {
          await this.git.run(repoPath, [
            "-c",
            `core.hooksPath=${emptyHooksDir.replace(/\\/g, "/")}`,
            "worktree",
            "add",
            "-b",
            branch,
            worktreePath,
            targetRef,
          ]);
        } finally {
          try {
            rmSync(emptyHooksDir, { recursive: true, force: true });
          } catch {
            // Ошибка очистки временной директории hooks не затрагивает recovery journal.
          }
        }
      }
      await this.verifyActualTaskWorktree(recovered, operation.status === "STARTED" ? targetHead : undefined);
      if (!row) this.worktreeRepo?.create(recovered);
      if (operation.status === "STARTED") {
        this.gitOperationRepo?.verify(operation.id);
        if (this.gitOperationRepo?.findById(operation.id)?.status !== "VERIFIED") throw new Error("Task workspace recovery was not durably verified");
      }
      return recovered;
    }
    if (pathEntryExists(worktreePath)) {
      throw new Error("Task workspace path already exists without a verified managed journal");
    }
    const localBranch = await this.git.run(repoPath, ["for-each-ref", "--format=%(refname)", `refs/heads/${branch}`]);
    if (localBranch.stdout.trim()) throw new Error("Task branch already exists without a verified managed worktree");
    // Создаёт пустую директорию hooks для отключения hooks.
    const emptyHooksDir = this.createEmptyHooksDir();

    try {
      const operation = this.gitOperationRepo?.create({
        id: crypto.randomUUID(),
        type: "CREATE_WORKTREE",
        repoPath,
        branchName: branch,
        worktreeId: taskId,
        targetRef,
      });
      // Создаёт worktree с отключёнными hooks через опцию -c перед подкомандой worktree
      await this.git.run(repoPath, [
        "-c",
        `core.hooksPath=${emptyHooksDir.replace(/\\/g, "/")}`,
        "worktree",
        "add",
        "-b",
        branch,
        worktreePath,
        targetRef,
      ]);

      const record: WorktreeRecord = {
        id: taskId,
        repoPath,
        path: worktreePath,
        branch,
        createdAt: new Date().toISOString(),
        removedAt: null,
      };

      // Проверяет the branch through Git before making the journal entry durable.
      // Экземпляр successful process exit alone is not authoritative Git state.
      const branchHead = (await this.git.run(repoPath, ["rev-parse", "--verify", "--end-of-options", `refs/heads/${record.branch}^{commit}`])).stdout.trim();
      const worktreeHead = (await this.git.run(worktreePath, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"])).stdout.trim();
      if (branchHead !== targetHead || worktreeHead !== targetHead) throw new Error("Task worktree Git state does not match its target ref");
      // Сохраняет worktree только после проверки фактического Git state.
      if (this.worktreeRepo) {
        this.worktreeRepo.create(record);
      }
      if (operation) this.gitOperationRepo!.verify(operation.id);

      return record;
    } finally {
      // Очищает пустую директорию hooks
      try {
        rmSync(emptyHooksDir, { recursive: true, force: true });
      } catch {
        // Пропускаем ошибки очистки
      }
    }
  }

  /**
   * Удаляет управляемый worktree по ID.
   * Проверяет наличие неоткоммиченных изменений перед удалением.
   */
  async removeWorkspace(worktreeId: string): Promise<void> {
    const worktree = this.worktreeRepo?.findById(worktreeId);
    
    if (!worktree) {
      throw new Error(`Worktree not found: ${worktreeId}`);
    }

    this.assertManagedWorktreePath(worktree.path);
    const status = await this.git.run(worktree.path, ["status", "--porcelain"]);
    if (status.stdout.trim() !== "") {
      throw new Error(
        `Cannot remove dirty worktree: ${worktree.path}. ` +
        `The worktree has uncommitted changes. Commit or stash changes before removal.`
      );
    }

    await this.git.run(worktree.repoPath, [
      "worktree",
      "remove",
      worktree.path,
    ]);

    if (this.worktreeRepo) {
      this.worktreeRepo.remove(worktreeId);
    }
  }

  /** Проверяет, что managed cleanup не выйдет за пределы назначенного корня. */
  private assertManagedWorktreePath(worktreePath: string): void {
    const root = resolve(this.worktreeDir);
    const candidate = resolve(worktreePath);
    const relativePath = relative(root, candidate);
    if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new Error(`Worktree path is outside the managed root: ${worktreePath}`);
    }
  }

  /**
   * Создаёт пустую директорию для отключения git hooks.
   */
  private createEmptyHooksDir(): string {
    return mkdtempSync(join(tmpdir(), "orchestrator-hooks-"));
  }

  private async verifyActualTaskWorktree(record: WorktreeRecord, expectedHead?: string): Promise<void> {
    const path = realpathSync(record.path);
    const canonical = resolve(record.path);
    const samePath = process.platform === "win32" ? path.toLowerCase() === canonical.toLowerCase() : path === canonical;
    const top = (await this.git.run(record.path, ["rev-parse", "--show-toplevel"])).stdout.trim();
    const branch = (await this.git.run(record.path, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim();
    const head = (await this.git.run(record.path, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"])).stdout.trim();
    const branchHead = (await this.git.run(record.repoPath, ["rev-parse", "--verify", "--end-of-options", `refs/heads/${record.branch}^{commit}`])).stdout.trim();
    if (!samePath || !samePathValue(top, record.path) || branch !== record.branch || !head || head !== branchHead
      || (expectedHead !== undefined && (head !== expectedHead || (await this.git.run(record.path, ["status", "--porcelain"])).stdout.trim() !== ""))) {
      throw new Error("Task workspace Git state does not match its managed branch");
    }
  }
}

function samePathValue(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
