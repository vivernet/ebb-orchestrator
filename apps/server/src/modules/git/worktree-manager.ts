import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { isAbsolute, join, relative, resolve } from "path";
import { tmpdir } from "os";
import { GitCli } from "./git-cli.js";
import type { Database } from "../../platform/database/database.js";
import { WorktreeRepository } from "./worktree-repository.js";

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
  private readonly worktreeRepo: WorktreeRepository | null;
  private readonly worktreeDir: string;

  constructor(options: WorktreeManagerOptions = {}) {
    this.git = options.git ?? new GitCli();
    this.worktreeRepo = options.db ? new WorktreeRepository(options.db) : null;
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
    const worktreePath = join(this.worktreeDir, `task-${taskId}`);
    
    // Гарантирует существование родительской директории worktree
    try {
      mkdirSync(this.worktreeDir, { recursive: true });
    } catch {
      // Пропускаем если директория уже существует или не может быть создана
    }
    
    // Создаёт пустую директорию hooks для отключения hooks
    const emptyHooksDir = this.createEmptyHooksDir();

    try {
      // Создаёт worktree с отключёнными hooks через опцию -c перед подкомандой worktree
      await this.git.run(repoPath, [
        "-c",
        `core.hooksPath=${emptyHooksDir.replace(/\\/g, "/")}`,
        "worktree",
        "add",
        "-B",
        `task/${taskId}`,
        worktreePath,
        targetRef,
      ]);

      const record: WorktreeRecord = {
        id: taskId,
        repoPath,
        path: worktreePath,
        branch: `task/${taskId}`,
        createdAt: new Date().toISOString(),
        removedAt: null,
      };

      // Сохраняет в базу данных если доступна
      if (this.worktreeRepo) {
        this.worktreeRepo.create(record);
      }

      return record;
    } catch (error) {
      // Очищает частичный worktree при ошибке
      try {
        rmSync(worktreePath, { recursive: true, force: true });
      } catch {
        // Пропускаем ошибки очистки
      }
      throw error;
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
}
