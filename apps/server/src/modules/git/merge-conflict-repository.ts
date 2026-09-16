import type { Database } from "../../platform/database/database.js";

export interface MergeConflictRecord {
  id: string;
  sourceBranch: string;
  targetBranch: string;
  files: string;
  classification: "TRIVIAL" | "RESOLVABLE" | "ARCHITECTURAL";
  status: "OPEN" | "RESOLVED";
  createdAt: string;
  resolvedAt: string | null;
}

export type MergeConflictClassification =
  | "TRIVIAL"
  | "RESOLVABLE"
  | "ARCHITECTURAL";

export type MergeConflictStatus = "OPEN" | "RESOLVED";

/**
 * MergeConflictRepository persists merge conflicts as first-class records.
 * 
 * Key properties:
 * - Each conflict is stored as a separate row
 * - Tracks classification and status for lifecycle management
 * - Supports querying by source/target branches
 */
export class MergeConflictRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Creates a new merge conflict record.
   */
  create(record: MergeConflictRecord): void {
    this.db.run(
      `INSERT INTO merge_conflicts 
       (id, source_branch, target_branch, files, classification, status, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      {
        id: record.id,
        source_branch: record.sourceBranch,
        target_branch: record.targetBranch,
        files: record.files,
        classification: record.classification,
        status: record.status,
        created_at: record.createdAt,
        resolved_at: record.resolvedAt,
      }
    );
  }

  /**
   * Finds a merge conflict by ID.
   */
  findById(id: string): MergeConflictRecord | undefined {
    const result = this.db.get<MergeConflictRecord>(
      `SELECT * FROM merge_conflicts WHERE id = ?`,
      { id }
    );
    if (result) {
      return {
        ...result,
        sourceBranch: result.source_branch,
        targetBranch: result.target_branch,
        resolvedAt: result.resolved_at,
      };
    }
    return undefined;
  }

  /**
   * Finds all open merge conflicts for a given source branch.
   */
  findBySourceBranch(sourceBranch: string): MergeConflictRecord[] {
    const results = this.db.all<MergeConflictRecord>(
      `SELECT * FROM merge_conflicts 
       WHERE source_branch = ? AND status = ? 
       ORDER BY created_at DESC`,
      { source_branch: sourceBranch, status: "OPEN" }
    );
    return results.map((r) => ({
      ...r,
      sourceBranch: r.source_branch,
      targetBranch: r.target_branch,
      resolvedAt: r.resolved_at,
    }));
  }

  /**
   * Marks a merge conflict as resolved.
   */
  resolve(id: string): void {
    this.db.run(
      `UPDATE merge_conflicts SET status = ?, resolved_at = ? WHERE id = ?`,
      { status: "RESOLVED", resolved_at: new Date().toISOString(), id }
    );
  }

  /**
   * Gets all merge conflicts for a source/target branch pair.
   */
  findByBranchPair(sourceBranch: string, targetBranch: string): MergeConflictRecord[] {
    const results = this.db.all<MergeConflictRecord>(
      `SELECT * FROM merge_conflicts 
       WHERE source_branch = ? AND target_branch = ?
       ORDER BY created_at DESC`,
      { source_branch: sourceBranch, target_branch: targetBranch }
    );
    return results.map((r) => ({
      ...r,
      sourceBranch: r.source_branch,
      targetBranch: r.target_branch,
      resolvedAt: r.resolved_at,
    }));
  }

  /**
   * Counts open merge conflicts for a source branch.
   */
  countOpenForSource(sourceBranch: string): number {
    const result = this.db.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM merge_conflicts 
       WHERE source_branch = ? AND status = ?`,
      { source_branch: sourceBranch, status: "OPEN" }
    );
    return result?.count ?? 0;
  }
}
