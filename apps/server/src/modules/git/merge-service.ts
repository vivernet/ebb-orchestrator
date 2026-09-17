import { GitCli } from "./git-cli.js";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync, mkdirSync } from "fs";
import { getIntegrationProvenance } from "./integration-service.js";
import type { IntegrationAttempt } from "./integration-service.js";
import type { Database } from "../../platform/database/database.js";
import { createSqliteDatabase } from "../../platform/database/sqlite-database.js";

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
  /** Successful integration provenance required for every final merge. */
  integrationAttempt?: IntegrationAttempt;
  database?: Database;
  onVerifiedCompletion?: (result: MergeResult) => void;
  /** Persisted approval link for an Epic-specific final merge operation. */
  approvalId?: string;
}

function optionsDatabase(attempt: IntegrationAttempt | null, database?: Database): Database | null {
  if (database) return database;
  if (!attempt?.provenanceDatabasePath) return null;
  return createSqliteDatabase(attempt.provenanceDatabasePath);
}

/**
 * MergeService performs deterministic merge operations.
 * 
 * Key properties:
 * - Verifies type=FINAL_MERGE, status=APPROVED, and subjectId matches exactly
 * - Requires a successful integration attempt with a verified target SHA
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
  private integrationAttempt: IntegrationAttempt | null;
  private readonly onVerifiedCompletion: ((result: MergeResult) => void) | undefined;
  private readonly database: Database | undefined;

  constructor(options: MergeServiceOptions = {}) {
    this.git = options.git ?? new GitCli();
    this.approvalStore = options.approvalStore ?? new Map();
    this.repoPath = options.repoPath ?? process.cwd();
    this.sourceBranch = options.sourceBranch ?? null;
    this.targetBranch = options.targetBranch ?? null;
    this.expectedTargetSha = options.expectedTargetSha ?? null;
    this.integrationAttempt = options.integrationAttempt ?? null;
    this.database = options.database;
    this.onVerifiedCompletion = options.onVerifiedCompletion;
    if (this.database) {
      this.database.exec(`CREATE TABLE IF NOT EXISTS git_operations (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'STARTED',
        repo_path TEXT NOT NULL, branch_name TEXT, target_ref TEXT, created_at TEXT NOT NULL,
        verified_at TEXT, approval_id TEXT, source_sha TEXT, expected_target_sha TEXT,
        resulting_target_sha TEXT
      )`);
    }
    if (this.database) {
      for (const column of ["approval_id TEXT", "source_sha TEXT", "expected_target_sha TEXT", "resulting_target_sha TEXT"]) {
        try { this.database.exec(`ALTER TABLE git_operations ADD COLUMN ${column}`); } catch { /* already present */ }
      }
    }
  }

  /**
   * Registers an approval for testing purposes.
   * In production, approvals come from the database.
   */
  registerApproval(approval: Approval): void {
    this.approvalStore.set(approval.id, approval);
  }

  /**
   * Performs a merge operation after validating approval and integration provenance.
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
    const approval = this.approvalStore.get(approvalId) ?? this.database?.get<Approval>(
      "SELECT id,subject_id AS subjectId,type,status FROM approvals WHERE id=$approvalId",
      { approvalId },
    );

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

    const integration = this.integrationAttempt;
    const provenanceDb = optionsDatabase(this.integrationAttempt, this.database);
    const provenance = integration && provenanceDb ? getIntegrationProvenance(provenanceDb, integration) : null;
    const hasAgentRuns = Boolean(provenanceDb?.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_runs'"));
    if (!integration?.integrationRunId) {
      throw new Error("Missing verified integration provenance: associated Integration run is required");
    }
    if (!provenanceDb || !hasAgentRuns) throw new Error("Missing verified integration provenance: authoritative agent run database is required");
    if (provenance) {
      const run = provenanceDb.get<{ id: string; role: string; status: string; output: string | null }>(
        "SELECT id, role, status, output FROM agent_runs WHERE id = $id", { id: integration.integrationRunId });
      if (!run || run.role.toLowerCase() !== "integration" || run.status !== "COMPLETED" || !run.output) {
        throw new Error("Missing verified integration provenance: associated Integration run is not completed");
      }
      let output: unknown;
      try { output = JSON.parse(run.output); } catch { output = undefined; }
      if (!output || (output as { outcome?: string }).outcome !== "PASS") throw new Error("Missing verified integration provenance: stored Integration result is not PASS");
    }
    if (!integration || !provenance || !provenance.snapshot.sourceBranch || !provenance.snapshot.sourceSha ||
        !provenance.snapshot.currentTargetBranch || !provenance.snapshot.expectedTargetSha) {
      throw new Error("Missing verified integration provenance: successful integration, source branch, and expected target SHA are required");
    }
    const verified = provenance.snapshot;
    if (verified.repoPath !== this.repoPath ||
        (this.sourceBranch && this.sourceBranch !== verified.sourceBranch) ||
        (this.targetBranch && this.targetBranch !== verified.currentTargetBranch) ||
        verified.expectedTargetBranch !== verified.currentTargetBranch ||
        (this.expectedTargetSha && this.expectedTargetSha !== verified.expectedTargetSha) ||
        integration.id !== verified.id ||
        `${verified.id}:${verified.repoPath}:${verified.currentTargetBranch}:${verified.sourceBranch}` !== provenance.identity) {
      throw new Error("Missing verified integration provenance: expected target SHA does not match integration record");
    }

    // The approval supplied to this invocation is authoritative.  The
    // constructor value is retained only for compatibility with older
    // callers; it must never make the journal point at another approval.
    if (this.database) {
      const prior = this.database.get<{ target_ref: string; source_sha: string; expected_target_sha: string; resulting_target_sha: string }>(
        "SELECT target_ref,source_sha,expected_target_sha,resulting_target_sha FROM git_operations WHERE type='MERGE' AND status='VERIFIED' AND approval_id=$approvalId ORDER BY verified_at DESC LIMIT 1", { approvalId });
      if (prior && prior.target_ref === verified.currentTargetBranch && prior.source_sha === verified.sourceSha && prior.expected_target_sha === verified.expectedTargetSha && prior.resulting_target_sha) {
        return { success: true, subjectId, targetBranch: prior.target_ref, mergeCommitSha: prior.resulting_target_sha, resultingTargetSha: prior.resulting_target_sha, verifiedCompletion: true };
      }

      const started = this.database.get<{
        id: string;
        target_ref: string;
        source_sha: string;
        expected_target_sha: string;
      }>(
        "SELECT id,target_ref,source_sha,expected_target_sha FROM git_operations WHERE type='MERGE' AND status='STARTED' AND approval_id=$approvalId AND repo_path=$repo AND branch_name=$branch AND target_ref=$target AND source_sha=$source AND expected_target_sha=$expected ORDER BY created_at DESC LIMIT 1",
        {
          approvalId,
          repo: verified.repoPath,
          branch: verified.sourceBranch,
          target: verified.currentTargetBranch,
          source: verified.sourceSha,
          expected: verified.expectedTargetSha,
        },
      );
      if (started) {
        const recovered = await this.reconcileStartedMerge(started, subjectId);
        this.onVerifiedCompletion?.(recovered);
        return recovered;
      }
    }
    const operationId = this.database ? crypto.randomUUID() : null;
    if (operationId) {
      this.database!.run("INSERT INTO git_operations(id,type,status,repo_path,branch_name,target_ref,created_at,approval_id,source_sha,expected_target_sha) VALUES($id,'MERGE','STARTED',$repo,$branch,$target,$at,$approval,$source,$expected)", { id: operationId, repo: verified.repoPath, branch: verified.sourceBranch, target: verified.currentTargetBranch, at: new Date().toISOString(), approval: approvalId, source: verified.sourceSha, expected: verified.expectedTargetSha });
    }
    // Perform the merge
    try {
      const mergeResult = await this.performMerge(subjectId, verified);
      if (operationId) this.database!.run("UPDATE git_operations SET status='VERIFIED',verified_at=$at,resulting_target_sha=$result WHERE id=$id AND status='STARTED'", { id: operationId, at: new Date().toISOString(), result: mergeResult.resultingTargetSha });
      this.onVerifiedCompletion?.(mergeResult);
      return mergeResult;
    } catch (error) {
      if (operationId) this.database!.run("UPDATE git_operations SET status='FAILED' WHERE id=$id AND status='STARTED'", { id: operationId });
      throw error;
    } finally {
      if (!this.database && provenanceDb) provenanceDb.close();
    }
  }

  /**
   * Resolve a journal entry left STARTED by a process crash after git mutated
   * the target.  A target is considered completed only when both the captured
   * target and the captured source are ancestors of the observed target.  All
   * other states are terminal: retrying them could apply the merge twice or
   * merge onto an unrelated target.
   */
  private async reconcileStartedMerge(
    operation: { id: string; target_ref: string; source_sha: string; expected_target_sha: string },
    subjectId: string,
  ): Promise<MergeResult> {
    let resultingTargetSha: string | undefined;
    try {
      const source = (await this.git.run(this.repoPath, ["rev-parse", operation.source_sha])).stdout.trim();
      const target = (await this.git.run(this.repoPath, ["rev-parse", operation.target_ref])).stdout.trim();
      if (source !== operation.source_sha) throw new Error("source SHA is no longer available");

      const isAncestor = async (ancestor: string, descendant: string): Promise<boolean> => {
        try {
          await this.git.run(this.repoPath, ["merge-base", "--is-ancestor", ancestor, descendant]);
          return true;
        } catch {
          return false;
        }
      };
      if (await isAncestor(operation.expected_target_sha, target) && await isAncestor(operation.source_sha, target)) {
        resultingTargetSha = target;
      } else {
        throw new Error("observed target does not prove completion of the recorded merge");
      }
    } catch (error) {
      this.database!.run("UPDATE git_operations SET status='FAILED' WHERE id=$id AND status='STARTED'", { id: operation.id });
      const reason = error instanceof Error ? error.message : "unknown reconciliation error";
      throw new Error(`MERGE_RECOVERY_FAILED: ${reason}; manual reconciliation required`);
    }

    this.database!.run(
      "UPDATE git_operations SET status='VERIFIED',verified_at=$at,resulting_target_sha=$result WHERE id=$id AND status='STARTED'",
      { id: operation.id, at: new Date().toISOString(), result: resultingTargetSha },
    );
    return {
      success: true,
      subjectId,
      targetBranch: operation.target_ref,
      mergeCommitSha: resultingTargetSha,
      resultingTargetSha,
      verifiedCompletion: true,
    };
  }

  /**
   * Authority-bound entry point used by Epic orchestration.  It resolves the
   * exact Integration AgentRun from durable provenance before entering the
   * normal approval/SHA verification path; callers cannot supply a fabricated
   * attempt or substitute another run.
   */
  async mergeApprovedForIntegration(subjectId: string, approvalId: string, integrationRunId: string): Promise<MergeResult> {
    if (!this.database) throw new Error("Authoritative database is required for Integration provenance");
    const row = this.database.get<{
      id: string; source_branch: string; target_branch: string; repository_path: string;
      expected_target_sha: string; source_sha: string; worktree_path: string;
      integration_run_id: string; status: IntegrationAttempt["status"]; created_at: string;
    }>("SELECT * FROM integration_attempts WHERE integration_run_id=$runId AND status='MERGED'", { runId: integrationRunId });
    if (!row || row.integration_run_id !== integrationRunId) throw new Error("Missing exact Integration provenance");
    this.integrationAttempt = {
      id: row.id, sourceBranch: row.source_branch, currentTargetBranch: row.target_branch,
      expectedTargetBranch: row.target_branch, repoPath: row.repository_path,
      expectedTargetSha: row.expected_target_sha, sourceSha: row.source_sha,
      worktreePath: row.worktree_path, status: row.status, createdAt: row.created_at,
      integrationRunId,
    };
    return this.mergeApproved(subjectId, approvalId);
  }

  /**
   * Performs the actual merge operation.
    * The source and target come from the verified integration attempt.
   */
  private async performMerge(subjectId: string, integration: Readonly<{
    sourceBranch: string;
    currentTargetBranch: string;
    repoPath: string;
    expectedTargetSha: string | null;
    sourceSha: string;
  }>): Promise<MergeResult> {
    // Re-read the target immediately before changing it. An old integration
    // result is never allowed to merge onto a moving target.
    const target = integration.currentTargetBranch;
    if (integration.sourceBranch !== "HEAD") {
      const sourceBefore = (await this.git.run(integration.repoPath, ["rev-parse", integration.sourceBranch])).stdout.trim();
      if (sourceBefore !== integration.sourceSha) throw new Error(`SOURCE_MOVED: expected ${integration.sourceSha}, found ${sourceBefore}; restart integration`);
    }
    const targetBefore = (await this.git.run(integration.repoPath, ["rev-parse", target])).stdout.trim();
    if (targetBefore !== integration.expectedTargetSha) {
      throw new Error(`TARGET_MOVED: expected ${integration.expectedTargetSha}, found ${targetBefore}; restart integration`);
    }
    const branchResult = await this.git.run(integration.repoPath, ["branch", "--show-current"]);
    const currentBranch = branchResult.stdout.trim() || "master";

    // Get current HEAD SHA before merge
    const headResult = await this.git.run(integration.repoPath, ["rev-parse", "HEAD"]);
    const _beforeSha = headResult.stdout.trim();

    // Perform merge with hooks disabled
    const emptyHooksDir = this.createEmptyHooksDir();
    try {
      mkdirSync(emptyHooksDir, { recursive: true });
      const mergeArgs = [
        "-c",
        `core.hooksPath=${emptyHooksDir.replace(/\\/g, "/")}`,
        "merge",
        "--no-edit",
        integration.sourceSha,
      ];
      if (currentBranch !== target) {
        await this.git.run(integration.repoPath, ["checkout", target]);
      }
      const targetImmediatelyBeforeMerge = (await this.git.run(integration.repoPath, ["rev-parse", target])).stdout.trim();
      if (targetImmediatelyBeforeMerge !== targetBefore) {
        throw new Error(`TARGET_MOVED: target changed from ${targetBefore} to ${targetImmediatelyBeforeMerge}; restart integration`);
      }
      if (targetImmediatelyBeforeMerge !== integration.expectedTargetSha) {
        throw new Error(`TARGET_MOVED: expected ${integration.expectedTargetSha}, found ${targetImmediatelyBeforeMerge}; restart integration`);
      }
      await this.git.run(integration.repoPath, mergeArgs);
    } finally {
      rmSync(emptyHooksDir, { recursive: true, force: true });
    }

    // Get resulting SHA after merge
    const afterHeadResult = await this.git.run(integration.repoPath, ["rev-parse", target]);
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
