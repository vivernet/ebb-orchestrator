import { GitCli } from "./git-cli.js";

/**
 * Git drift states that describe the relationship between local and remote.
 */
export type GitDriftState =
  | "IN_SYNC"
  | "LOCAL_AHEAD"
  | "REMOTE_AHEAD"
  | "DIVERGED"
  | "BRANCH_MISSING"
  | "WORKTREE_MISSING"
  | "UNCOMMITTED_CHANGES";

/**
 * Result of a git reconciliation operation.
 */
export interface GitDriftResult {
  state: GitDriftState;
  localRef?: string;
  remoteRef?: string;
  message?: string;
}

/**
 * Git reconciler that checks for drift between local and remote.
 *
 * IMPORTANT: This reconciler is local-only. It inspects existing
 * remote-tracking refs but must not implicitly fetch, push,
 * authenticate, or contact a remote.
 */
export class GitReconciler {
  private git: GitCli;
  private repoPath: string | null = null;

  constructor(git?: GitCli) {
    this.git = git ?? new GitCli();
  }

  /**
   * Initialize the reconciler with a repository path.
   */
  async initialize(repoPath: string): Promise<void> {
    this.repoPath = repoPath;
  }

  /**
   * Check if the reconciler is initialized.
   */
  isInitialized(): boolean {
    return this.repoPath !== null;
  }

  /**
   * Reconcile the given branch and return its drift state.
   *
   * This operation is local-only and does not perform network operations.
   */
  async reconcile(branch: string, worktreePath?: string): Promise<GitDriftResult> {
    if (!this.repoPath) {
      throw new Error("GitReconciler not initialized. Call initialize() first.");
    }

    const path = worktreePath ?? this.repoPath;

    // Check if worktree exists
    try {
      await this.git.run(path, ["rev-parse", "--is-inside-work-tree"]);
    } catch {
      return {
        state: "WORKTREE_MISSING",
        message: `Worktree at ${path} does not exist or is not a git repository`,
      };
    }

    // Check if branch exists locally
    try {
      await this.git.run(path, ["rev-parse", "--verify", branch]);
    } catch {
      return {
        state: "BRANCH_MISSING",
        message: `Branch ${branch} does not exist locally`,
      };
    }

    // Check for uncommitted changes
    const status = await this.git.run(path, ["status", "--porcelain"]);
    if (status.stdout.trim() !== "") {
      return {
        state: "UNCOMMITTED_CHANGES",
        localRef: await this.getHeadRef(path),
        message: "Working directory has uncommitted changes",
      };
    }

    // Get local HEAD
    const localRef = await this.getHeadRef(path);

    // Get remote tracking ref
    const remoteTrackingBranch = `refs/remotes/origin/${branch}`;
    let remoteRef: string | undefined;

    try {
      remoteRef = await this.getRef(path, remoteTrackingBranch);
    } catch {
      // No remote tracking ref exists
    }

    // Compare local and remote
    if (!remoteRef) {
      // No remote tracking - consider in sync
      return {
        state: "IN_SYNC",
        localRef,
        message: "No remote tracking ref found, considering in sync",
      };
    }

    try {
      // Check if local is ahead of remote
      const aheadCount = await this.getAheadCount(path, remoteRef, localRef);
      if (aheadCount > 0) {
        return {
          state: "LOCAL_AHEAD",
          localRef,
          remoteRef,
          message: `Local is ahead of remote by ${aheadCount} commit(s)`,
        };
      }

      // Check if remote is ahead of local
      const behindCount = await this.getAheadCount(path, localRef, remoteRef);
      if (behindCount > 0) {
        return {
          state: "REMOTE_AHEAD",
          localRef,
          remoteRef,
          message: `Remote is ahead of local by ${behindCount} commit(s)`,
        };
      }

      return {
        state: "IN_SYNC",
        localRef,
        remoteRef,
        message: "Local and remote are in sync",
      };
    } catch (error) {
      // If comparison fails, they may have diverged
      return {
        state: "DIVERGED",
        localRef,
        remoteRef,
        message: "Local and remote have diverged",
      };
    }
  }

  private async getRef(path: string, ref: string): Promise<string> {
    const result = await this.git.run(path, ["rev-parse", ref]);
    return result.stdout.trim();
  }

  private async getHeadRef(path: string): Promise<string> {
    return this.getRef(path, "HEAD");
  }

  private async getAheadCount(
    path: string,
    from: string,
    to: string
  ): Promise<number> {
    const result = await this.git.run(
      path,
      ["rev-list", "--count", `${from}..${to}`]
    );
    return parseInt(result.stdout.trim(), 10);
  }
}
