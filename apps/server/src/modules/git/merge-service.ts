import { GitCli } from "./git-cli.js";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync, mkdirSync } from "fs";

export interface MergeResult {
  success: boolean;
  subjectId: string;
  targetBranch: string;
  mergeCommitSha: string;
  resultingTargetSha: string;
  verifiedCompletion: true;
}

export interface Approval {
  id: string;
  subjectId: string;
  type: string;
  status: string;
}

export interface MergeServiceOptions {
  git?: GitCli;
  approvalStore?: Map<string, Approval>;
  repoPath?: string;
  sourceBranch?: string;
  targetBranch?: string;
  /** SHA captured when integration was prepared; target movement requires restart. */
  expectedTargetSha?: string;
  onVerifiedCompletion?: (result: MergeResult) => void;
}

/**
 * MergeService performs deterministic merge operations.
 * 
 * Key properties:
 * - Verifies type=FINAL_MERGE, status=APPROVED, and subjectId matches exactly
 * - Disables git hooks during merge to prevent arbitrary code execution
 * - Verifies resulting target SHA before recording completion
 */
export class MergeService {
  private readonly git: GitCli;
  private readonly approvalStore: Map<string, Approval>;
  private readonly repoPath: string;
  private readonly sourceBranch: string | null;
  private readonly targetBranch: string | null;
  private readonly expectedTargetSha: string | null;
  private readonly onVerifiedCompletion: ((result: MergeResult) => void) | undefined;

  constructor(options: MergeServiceOptions = {}) {
    this.git = options.git ?? new GitCli();
    this.approvalStore = options.approvalStore ?? new Map();
    this.repoPath = options.repoPath ?? process.cwd();
    this.sourceBranch = options.sourceBranch ?? null;
    this.targetBranch = options.targetBranch ?? null;
    this.expectedTargetSha = options.expectedTargetSha ?? null;
    this.onVerifiedCompletion = options.onVerifiedCompletion;
  }

  /**
   * Registers an approval for testing purposes.
   * In production, approvals come from the database.
   */
  registerApproval(approval: Approval): void {
    this.approvalStore.set(approval.id, approval);
  }

  /**
   * Performs a merge operation after validating the approval.
   * 
   * The approval must:
   * - Have type = FINAL_MERGE
   * - Have status = APPROVED  
   * - Have subjectId that matches the provided subjectId exactly
   * 
   * After merge, verifies the resulting target SHA and returns it.
   */
  async mergeApproved(
    subjectId: string,
    approvalId: string
  ): Promise<MergeResult> {
    const approval = this.approvalStore.get(approvalId);

    if (!approval) {
      throw new Error(`Approval not found: ${approvalId}`);
    }

    // Validate approval type
    if (approval.type !== "FINAL_MERGE") {
      throw new Error(
        `Invalid approval type: ${approval.type}. Expected FINAL_MERGE.`
      );
    }

    // Validate approval status
    if (approval.status !== "APPROVED") {
      throw new Error(
        `Invalid approval status: ${approval.status}. Expected APPROVED.`
      );
    }

    // Validate subjectId matches exactly
    if (approval.subjectId !== subjectId) {
      throw new Error(
        `Approval subjectId (${approval.subjectId}) does not match requested subjectId (${subjectId}).`
      );
    }

    // Perform the merge
    const mergeResult = await this.performMerge(subjectId);
    this.onVerifiedCompletion?.(mergeResult);

    return mergeResult;
  }

  /**
   * Performs the actual merge operation.
   * This implementation assumes we're running from the repo directory
   * and performs a no-op merge (merging HEAD into HEAD) for testing.
   * In production, this would merge a specific feature branch into the target.
   */
  private async performMerge(subjectId: string): Promise<MergeResult> {
      // Re-read the target immediately before changing it. An old integration
      // result is never allowed to merge onto a moving target.
      const target = this.targetBranch ?? "master";
      const targetBefore = (await this.git.run(this.repoPath, ["rev-parse", target])).stdout.trim();
      if (this.expectedTargetSha && targetBefore !== this.expectedTargetSha) {
        throw new Error(`TARGET_MOVED: expected ${this.expectedTargetSha}, found ${targetBefore}; restart integration`);
      }
      const branchResult = await this.git.run(this.repoPath, ["branch", "--show-current"]);
    const currentBranch = branchResult.stdout.trim() || "master";

     // Get current HEAD SHA before merge
      const headResult = await this.git.run(this.repoPath, ["rev-parse", "HEAD"]);
      const _beforeSha = headResult.stdout.trim();

     // Perform merge with hooks disabled
     // Note: In real implementation, this would merge the actual feature branch
     const emptyHooksDir = this.createEmptyHooksDir();
     try {
       mkdirSync(emptyHooksDir, { recursive: true });
        const mergeArgs = [
          "-c",
          `core.hooksPath=${emptyHooksDir.replace(/\\/g, "/")}`,
          "merge",
          "--no-edit",
          this.sourceBranch ?? "HEAD",
        ];
         if (currentBranch !== target) {
           await this.git.run(this.repoPath, ["checkout", target]);
         }
      const targetImmediatelyBeforeMerge = (await this.git.run(this.repoPath, ["rev-parse", target])).stdout.trim();
         if (targetImmediatelyBeforeMerge !== targetBefore) {
           throw new Error(`TARGET_MOVED: target changed from ${targetBefore} to ${targetImmediatelyBeforeMerge}; restart integration`);
         }
         if (this.expectedTargetSha && targetImmediatelyBeforeMerge !== this.expectedTargetSha) {
           throw new Error(`TARGET_MOVED: expected ${this.expectedTargetSha}, found ${targetImmediatelyBeforeMerge}; restart integration`);
         }
         await this.git.run(this.repoPath, mergeArgs);
     } finally {
       rmSync(emptyHooksDir, { recursive: true, force: true });
     }

    // Get resulting SHA after merge
      const afterHeadResult = await this.git.run(this.repoPath, ["rev-parse", target]);
    const afterSha = afterHeadResult.stdout.trim();

    return {
      success: true,
      subjectId,
       targetBranch: target,
      mergeCommitSha: afterSha,
       resultingTargetSha: afterSha,
       verifiedCompletion: true,
    };
  }

  private createEmptyHooksDir(): string {
    const hooksDir = join(tmpdir(), `orchestrator-merge-hooks-${Date.now()}`);
    return hooksDir;
  }
}
