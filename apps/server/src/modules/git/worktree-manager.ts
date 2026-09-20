import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "fs";
import { isAbsolute, join, relative, resolve } from "path";
import { tmpdir } from "os";
import { GitCli } from "./git-cli.js";
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
  private readonly worktreeRepo: WorktreeRepository | null;
  private readonly gitOperationRepo: GitOperationRepository | null;
  private readonly worktreeDir: string;

  constructor(options: WorktreeManagerOptions = {}) {
    this.git = options.git ?? new GitCli();
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
    const worktreePath = join(this.worktreeDir, `task-${taskId}`);
    const worktreeExistedBeforeCreate = existsSync(worktreePath);
    
    // Гарантирует существование родительской директории worktree
    try {
      mkdirSync(this.worktreeDir, { recursive: true });
    } catch {
      // Пропускаем если директория уже существует или не может быть создана
    }
    
    // Создаёт пустую директорию hooks для отключения hooks
    const emptyHooksDir = this.createEmptyHooksDir();
    const operation = this.gitOperationRepo?.create({
      id: crypto.randomUUID(),
      type: "CREATE_WORKTREE",
      repoPath,
      branchName: `task/${taskId}`,
      worktreeId: taskId,
      targetRef,
    });

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

      // Verify the branch through Git before making the journal entry durable.
      // A successful process exit alone is not authoritative Git state.
      await this.git.run(repoPath, ["rev-parse", "--verify", "--end-of-options", record.branch]);
      // Сохраняет worktree только после проверки фактического Git state.
      if (this.worktreeRepo) {
        this.worktreeRepo.create(record);
      }
      if (operation) this.gitOperationRepo!.verify(operation.id);

      return record;
    } catch (error) {
      // Удаляет только созданный этой попыткой, чистый и path-confined orphan.
      // Уже существующий путь и dirty/symlink-содержимое остаются для recovery.
      if (!worktreeExistedBeforeCreate) {
        await this.removeCleanOrphan(worktreePath);
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
   * Удаляет частично созданный orphan только после повторной проверки границ и
   * чистоты. Любая неоднозначность оставляет данные на диске.
   */
  private async removeCleanOrphan(worktreePath: string): Promise<void> {
    try {
      this.assertManagedWorktreePath(worktreePath);
      const root = realpathSync(this.worktreeDir);
      const candidateStat = lstatSync(worktreePath);
      if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink()) return;
      const candidate = realpathSync(worktreePath);
      const candidateRelative = relative(root, candidate);
      if (!candidateRelative || candidateRelative.startsWith("..") || isAbsolute(candidateRelative)) return;
      if (this.containsSymlink(worktreePath)) return;

      const entries = readdirSync(worktreePath);
      if (entries.length > 0) {
        const status = await this.git.run(worktreePath, ["status", "--porcelain"]);
        if (status.stdout.trim() !== "") return;
      }

      // Повторяем проверки непосредственно перед destructive action.
      this.assertManagedWorktreePath(worktreePath);
      const finalStat = lstatSync(worktreePath);
      if (!finalStat.isDirectory() || finalStat.isSymbolicLink() || this.containsSymlink(worktreePath)) return;
      rmSync(worktreePath, { recursive: true, force: true });
    } catch {
      // Ошибка проверки или Git оставляет orphan для ручного recovery.
    }
  }

  private containsSymlink(directory: string): boolean {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) return true;
      if (stat.isDirectory() && this.containsSymlink(path)) return true;
    }
    return false;
  }

  /**
   * Создаёт пустую директорию для отключения git hooks.
   */
  private createEmptyHooksDir(): string {
    return mkdtempSync(join(tmpdir(), "orchestrator-hooks-"));
  }
}
