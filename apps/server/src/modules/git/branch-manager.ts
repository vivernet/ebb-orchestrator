import { GitCli, assertSafeGitRef } from "./git-cli.js";
import type { Database } from "../../platform/database/database.js";
import { BranchRepository } from "./branch-repository.js";

import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

export interface BranchManagerOptions {
  git?: GitCli;
  db?: Database;
}

export interface BranchRecord {
  id: string;
  repoPath: string;
  name: string;
  targetRef: string;
  createdAt: string;
  removedAt: string | null;
}

/**
 * Инкапсулирует операцию Git branch-manager с журналированием и проверкой целевого repository/worktree.
 */
export class BranchManager {
  private readonly git: GitCli;
  private readonly branchRepo: BranchRepository | null;

  constructor(options: BranchManagerOptions = {}) {
    this.git = options.git ?? new GitCli();
    this.branchRepo = options.db ? new BranchRepository(options.db) : null;
  }

  /**
   * Creates an epic branch from a base reference.
   * Использует disabled hooks to prevent arbitrary code execution.
   */
  async createEpicBranch(
    epicId: string,
    repoPath: string,
    baseRef: string
  ): Promise<BranchRecord> {
    assertSafeGitRef(baseRef);
    const branchName = `epic/${epicId}`;
    assertSafeGitRef(branchName);
    
    // Создаёт empty hooks directory to disable hooks
    const emptyHooksDir = this.createEmptyHooksDir();

    try {
      // Создаёт branch with hooks disabled using -c option before command
      await this.git.run(repoPath, [
        "-c",
        `core.hooksPath=${emptyHooksDir.replace(/\\/g, "/")}`,
        "checkout",
        "-b",
        branchName,
        baseRef,
      ]);

      const record: BranchRecord = {
        id: `epic-${epicId}`,
        repoPath,
        name: branchName,
        targetRef: baseRef,
        createdAt: new Date().toISOString(),
        removedAt: null,
      };

      // Persist to database if available
      if (this.branchRepo) {
        this.branchRepo.create(record);
      }

      return record;
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
   * Creates an empty directory for disabling git hooks.
   */
  private createEmptyHooksDir(): string {
    return mkdtempSync(join(tmpdir(), "orchestrator-hooks-"));
  }
}
