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
  repoPath: string;
  expectedTargetSha: string | null;
  status: "PREPARED" | "MERGING" | "MERGED" | "FAILED";
  createdAt: string;
}

export interface IntegrationServiceOptions {
  git?: GitCli;
  worktreeDir?: string;
}

export type IntegrationRunner<T> = (worktreePath: string, attempt: IntegrationAttempt) => Promise<T>;

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
        repoPath,
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

  /** Run the real Integration role only after the isolated worktree is prepared. */
  async runInIntegrationWorktree<T>(attempt: IntegrationAttempt, runner: IntegrationRunner<T>): Promise<T> {
    if (attempt.status !== "PREPARED") throw new Error("integration attempt is not prepared");
    attempt.status = "MERGING";
    try {
      const result = await runner(attempt.worktreePath, attempt);
      // The target may have moved while the integration role was running.  Do
      // this check here, rather than leaving it to an end-to-end caller.
      const currentTargetSha = (await this.git.run(attempt.repoPath, ["rev-parse", attempt.currentTargetBranch])).stdout.trim();
      if (!attempt.expectedTargetSha || currentTargetSha !== attempt.expectedTargetSha) {
        attempt.status = "FAILED";
        throw new Error(`TARGET_MOVED: expected ${attempt.expectedTargetSha ?? "a verified target"}, found ${currentTargetSha}; restart integration`);
      }
      // Keep the verified base on the record consumed by the final merge
      // guard.  Do not mark an attempt successful without this provenance.
      attempt.expectedTargetSha = currentTargetSha;
      attempt.status = "MERGED";
      return result;
    } catch (error) {
      attempt.status = "FAILED";
      throw error;
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
