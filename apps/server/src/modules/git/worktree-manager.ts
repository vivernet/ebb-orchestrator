import { rmSync, mkdirSync } from "fs";
import { join } from "path";
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
   * Creates a managed worktree for a task.
   * Uses disabled hooks to prevent arbitrary code execution.
   */
  async createTaskWorkspace(
    taskId: string,
    repoPath: string,
    targetRef: string
  ): Promise<WorktreeRecord> {
    const worktreePath = join(this.worktreeDir, `task-${taskId}`);
    
    // Ensure the parent worktree directory exists
    try {
      mkdirSync(this.worktreeDir, { recursive: true });
    } catch {
      // Ignore if directory already exists or can't be created
    }
    
    // Create empty hooks directory to disable hooks
    const emptyHooksDir = this.createEmptyHooksDir();

    try {
      // Create worktree with hooks disabled using -c option before worktree subcommand
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

      // Persist to database if available
      if (this.worktreeRepo) {
        this.worktreeRepo.create(record);
      }

      return record;
    } catch (error) {
      // Clean up partial worktree on failure
      try {
        rmSync(worktreePath, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    } finally {
      // Clean up empty hooks directory
      try {
        rmSync(emptyHooksDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Removes a managed worktree by ID.
   */
  async removeWorkspace(worktreeId: string): Promise<void> {
    const worktree = this.worktreeRepo?.findById(worktreeId);
    
    if (!worktree) {
      throw new Error(`Worktree not found: ${worktreeId}`);
    }

    try {
      // Remove the worktree from git
      await this.git.run(worktree.repoPath, [
        "worktree",
        "remove",
        "--force",
        worktree.path,
      ]);

      // Update database record
      if (this.worktreeRepo) {
        this.worktreeRepo.remove(worktreeId);
      }
    } catch (error) {
      // If git command fails, still clean up local directory
      try {
        rmSync(worktree.path, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }
  }

  /**
   * Creates an empty directory for disabling git hooks.
   */
  private createEmptyHooksDir(): string {
    const hooksDir = join(tmpdir(), `orchestrator-hooks-${Date.now()}`);
    return hooksDir;
  }
}
