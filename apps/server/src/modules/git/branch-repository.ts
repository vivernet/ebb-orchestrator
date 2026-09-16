import type { Database } from "../../platform/database/database.js";
import type { BranchRecord } from "./branch-manager.js";

export class BranchRepository {
  constructor(private readonly db: Database) {}

  create(record: BranchRecord): void {
    this.db.run(
      `INSERT INTO branches (id, repo_path, name, target_ref, created_at, removed_at) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.repoPath,
        record.name,
        record.targetRef,
        record.createdAt,
        record.removedAt,
      ]
    );
  }

  findById(id: string): BranchRecord | undefined {
    const result = this.db.get(
      `SELECT * FROM branches WHERE id = ? AND removed_at IS NULL`,
      [id]
    ) as BranchRecord | undefined;
    return result;
  }

  remove(id: string): void {
    this.db.run(
      `UPDATE branches SET removed_at = ? WHERE id = ?`,
      [new Date().toISOString(), id]
    );
  }

  findByRepo(repoPath: string): BranchRecord[] {
    return this.db.all(
      `SELECT * FROM branches WHERE repo_path = ? AND removed_at IS NULL`,
      [repoPath]
    ) as BranchRecord[];
  }
}
