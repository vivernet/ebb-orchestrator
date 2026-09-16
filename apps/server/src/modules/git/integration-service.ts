import { GitCli } from "./git-cli.js";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync, mkdirSync } from "fs";

export interface IntegrationAttempt {
  id: string;
  sourceBranch: string;
  currentTargetBranch: string;
  expectedTargetBranch: string;
  worktreePath: string;
  expectedTargetSha: string | null;
  status: "PREPARED" | "MERGING" | "MERGED" | "FAILED";
  createdAt: string;
}

export interface IntegrationServiceOptions {
  git?: GitCli;
  worktreeDir?: string;
}

/**
 * IntegrationService manages the preparation of integration workspaces.
 * 
 * Key properties:
 * - Uses temporary integration branch/worktree owned by the integration attempt
 * - Never experiments in the Task worktree or master
 * - Verifies current target SHA before preparing integration
 */
export class IntegrationService {
  private readonly git: GitCli;
  private readonly worktreeDir: string;

  constructor(options: IntegrationServiceOptions = {}) {
    this.git = options.git ?? new GitCli();
    this.worktreeDir = options.worktreeDir ?? join(tmpdir(), "orchestrator-integration");
  }

  /**
   * Prepares an integration workspace for merging sourceBranch into currentTargetBranch.
   * 
   * Creates a dedicated integration worktree that:
   * - Is based on the current target branch (handles moving target)
   * - Can safely perform merge operations without affecting master or task worktrees
   * - Is owned by this integration attempt and should be cleaned up after use
   */
  async prepareIntegration(
    sourceBranch: string,
    currentTargetBranch: string,
    repoPath: string
  ): Promise<IntegrationAttempt> {
    const attemptId = `integration-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const integrationBranch = `integration/${attemptId}`;
    const worktreePath = join(this.worktreeDir, attemptId);

    // Ensure worktree directory exists
    mkdirSync(this.worktreeDir, { recursive: true });

    // Get current target SHA to verify we're working from the right base
    const targetShaResult = await this.git.run(repoPath, ["rev-parse", currentTargetBranch]);
    const expectedTargetSha = targetShaResult.stdout.trim();

    // Create empty hooks directory to disable hooks
    const emptyHooksDir = join(this.worktreeDir, `hooks-${Date.now()}`);
    mkdirSync(emptyHooksDir, { recursive: true });

    try {
      // Create worktree with integration branch directly from target branch
      // Using -B to force creation/checkout if branch exists
      await this.git.run(repoPath, [
        "-c",
        `core.hooksPath=${emptyHooksDir.replace(/\\/g, "/")}`,
        "worktree",
        "add",
        "-B",
        integrationBranch,
        worktreePath,
        currentTargetBranch,
      ]);

      const attempt: IntegrationAttempt = {
        id: attemptId,
        sourceBranch,
        currentTargetBranch,
        expectedTargetBranch: currentTargetBranch,
        worktreePath,
        expectedTargetSha,
        status: "PREPARED",
        createdAt: new Date().toISOString(),
      };

      return attempt;
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
   * Cleans up an integration attempt by removing its worktree.
   */
  async cleanupIntegration(attempt: IntegrationAttempt): Promise<void> {
    try {
      // Remove worktree directory
      rmSync(attempt.worktreePath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}
