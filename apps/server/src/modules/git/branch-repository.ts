import type { Database, StatementParams } from "../../platform/database/database.js";
import type { BranchRecord } from "./branch-manager.js";

export class BranchRepository {
  constructor(private readonly db: Database) {}

  create(record: BranchRecord): void {
    this.db.run(
      `INSERT INTO branches (id, repo_path, name, target_ref, created_at, removed_at) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      { id: record.id, repo_path: record.repoPath, name: record.name, target_ref: record.targetRef, created_at: record.createdAt, removed_at: record.removedAt } as StatementParams
    );
  }

  findById(id: string): BranchRecord | undefined {
    const result = this.db.get(
      `SELECT * FROM branches WHERE id = ? AND removed_at IS NULL`,
      { id } as StatementParams
    ) as BranchRecord | undefined;
    return result;
  }

  remove(id: string): void {
    this.db.run(
      `UPDATE branches SET removed_at = ? WHERE id = ?`,
      { removed_at: new Date().toISOString(), id } as StatementParams
    );
  }

  findByRepo(repoPath: string): BranchRecord[] {
    return this.db.all(
      `SELECT * FROM branches WHERE repo_path = ? AND removed_at IS NULL`,
      { repo_path: repoPath } as StatementParams
    ) as BranchRecord[];
  }
}
