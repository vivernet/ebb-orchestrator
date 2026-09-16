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

interface IntegrationSnapshot {
  readonly id: string;
  readonly sourceBranch: string;
  readonly currentTargetBranch: string;
  readonly expectedTargetBranch: string;
  readonly worktreePath: string;
  readonly repoPath: string;
  readonly expectedTargetSha: string | null;
  readonly createdAt: string;
}

interface IssuedIntegration {
  readonly snapshot: IntegrationSnapshot;
  readonly identity: string;
  status: IntegrationAttempt["status"];
}

// A WeakMap makes the provenance capability unforgeable by callers that only
// have the public attempt shape. The snapshot is what downstream checks use.
const issuedIntegrations = new WeakMap<IntegrationAttempt, IssuedIntegration>();

export interface VerifiedIntegrationProvenance {
  readonly snapshot: Readonly<IntegrationSnapshot>;
  readonly identity: string;
}

export function getVerifiedIntegrationProvenance(
  attempt: IntegrationAttempt
): VerifiedIntegrationProvenance | null {
  const issued = issuedIntegrations.get(attempt);
  if (!issued || issued.status !== "MERGED" || attempt.status !== "MERGED") return null;
  return { snapshot: issued.snapshot, identity: issued.identity };
}

export interface IntegrationServiceOptions {
  git?: GitCli;
  worktreeDir?: string;
}

export type IntegrationRunner<T> = (worktreePath: string, attempt: Readonly<IntegrationAttempt>) => Promise<T>;

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

      const snapshot: IntegrationSnapshot = Object.freeze({
        id: attempt.id,
        sourceBranch: attempt.sourceBranch,
        currentTargetBranch: attempt.currentTargetBranch,
        expectedTargetBranch: attempt.expectedTargetBranch,
        worktreePath: attempt.worktreePath,
        repoPath: attempt.repoPath,
        expectedTargetSha: attempt.expectedTargetSha,
        createdAt: attempt.createdAt,
      });
      issuedIntegrations.set(attempt, {
        snapshot,
        identity: `${snapshot.id}:${snapshot.repoPath}:${snapshot.currentTargetBranch}:${snapshot.sourceBranch}`,
        status: attempt.status,
      });

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
    const issued = issuedIntegrations.get(attempt);
    if (!issued || attempt.status !== "PREPARED") throw new Error("integration attempt is not prepared");
    const { snapshot } = issued;
    attempt.status = "MERGING";
    issued.status = "MERGING";
    try {
      // Do not give the runner the live attempt record. In addition to the
      // immutable check below, this prevents an in-process runner from
      // changing the object used by the final verification.
      const runnerAttempt = Object.freeze({ ...attempt });
      let result: T;
      try {
        result = await runner(snapshot.worktreePath, runnerAttempt);
      } catch (error) {
        if (error instanceof TypeError && /read only|readonly|frozen/i.test(error.message)) {
          throw new Error("INTEGRATION_PROVENANCE_MUTATED: runner changed the integration attempt", { cause: error });
        }
        throw error;
      }
      const provenanceChanged = [
        [attempt.id, snapshot.id],
        [attempt.sourceBranch, snapshot.sourceBranch],
        [attempt.currentTargetBranch, snapshot.currentTargetBranch],
        [attempt.expectedTargetBranch, snapshot.expectedTargetBranch],
        [attempt.worktreePath, snapshot.worktreePath],
        [attempt.repoPath, snapshot.repoPath],
        [attempt.expectedTargetSha, snapshot.expectedTargetSha],
        [attempt.createdAt, snapshot.createdAt],
      ].some(([actual, expected]) => actual !== expected);
      if (provenanceChanged) {
        throw new Error("INTEGRATION_PROVENANCE_MUTATED: runner changed the integration attempt");
      }
      // The target may have moved while the integration role was running.  Do
      // this check here, rather than leaving it to an end-to-end caller.
      const currentTargetSha = (await this.git.run(snapshot.repoPath, ["rev-parse", snapshot.currentTargetBranch])).stdout.trim();
      if (!snapshot.expectedTargetSha || currentTargetSha !== snapshot.expectedTargetSha) {
        attempt.status = "FAILED";
        issued.status = "FAILED";
        throw new Error(`TARGET_MOVED: expected ${snapshot.expectedTargetSha ?? "a verified target"}, found ${currentTargetSha}; restart integration`);
      }
      attempt.status = "MERGED";
      issued.status = "MERGED";
      return result;
    } catch (error) {
      attempt.status = "FAILED";
      issued.status = "FAILED";
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
