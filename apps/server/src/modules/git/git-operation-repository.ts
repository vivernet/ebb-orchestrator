import type { Database, DatabaseTx } from "../../platform/database/database.js";
import type { GitOperation, GitOperationStatus, GitOperationType } from "./git-types.js";

export interface CreateGitOperationParams {
  id: string;
  type: GitOperationType;
  repoPath: string;
  branchName?: string | null;
  worktreeId?: string | null;
  targetRef?: string | null;
}

export class GitOperationRepository {
  constructor(private readonly db: Database) {}

  /**
   * Create a new GitOperation with STARTED status.
   * This must be called BEFORE executing any git mutation command.
   */
  create(params: CreateGitOperationParams): GitOperation {
    const op: GitOperation = {
      id: params.id,
      type: params.type,
      status: "STARTED",
      repo_path: params.repoPath,
      branch_name: params.branchName ?? null,
      worktree_id: params.worktreeId ?? null,
      target_ref: params.targetRef ?? null,
      created_at: new Date().toISOString(),
      verified_at: null,
    };

    this.db.run(
      `INSERT INTO git_operations (
        id, type, status, repo_path, branch_name, worktree_id, target_ref, created_at, verified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        op.id,
        op.type,
        op.status,
        op.repo_path,
        op.branch_name,
        op.worktree_id,
        op.target_ref,
        op.created_at,
        op.verified_at,
      ]
    );

    return op;
  }

  /**
   * Mark an existing STARTED operation as VERIFIED after successful command execution.
   * This should only be called after inspecting actual Git state to confirm the operation succeeded.
   */
  verify(operationId: string): void {
    this.db.run(
      `UPDATE git_operations 
       SET status = 'VERIFIED', verified_at = ? 
       WHERE id = ? AND status = 'STARTED'`,
      [new Date().toISOString(), operationId]
    );
  }

  /**
   * Get an operation by ID.
   */
  findById(id: string): GitOperation | undefined {
    return this.db.get(
      `SELECT * FROM git_operations WHERE id = ?`,
      [id]
    ) as GitOperation | undefined;
  }

  /**
   * Find all STARTED operations for a repo that need reconciliation.
   * Used for crash recovery - these are operations that may have been interrupted.
   */
  findStartedOperations(repoPath: string): GitOperation[] {
    return this.db.all(
      `SELECT * FROM git_operations WHERE repo_path = ? AND status = 'STARTED'`,
      [repoPath]
    ) as GitOperation[];
  }

  /**
   * Delete an operation after successful verification.
   */
  delete(operationId: string): void {
    this.db.run(`DELETE FROM git_operations WHERE id = ?`, [operationId]);
  }
}
