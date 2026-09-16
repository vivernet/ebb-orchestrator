import type { Database } from "../../platform/database/database.js";
import type { WorktreeRecord } from "./worktree-manager.js";

export class WorktreeRepository {
  constructor(private readonly db: Database) {}

  create(record: WorktreeRecord): void {
    this.db.run(
      `INSERT INTO worktrees (id, repo_path, path, branch, created_at, removed_at) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.repoPath,
        record.path,
        record.branch,
        record.createdAt,
        record.removedAt,
      ]
    );
  }

  findById(id: string): WorktreeRecord | undefined {
    const result = this.db.get(
      `SELECT * FROM worktrees WHERE id = ? AND removed_at IS NULL`,
      [id]
    ) as WorktreeRecord | undefined;
    return result;
  }

  remove(id: string): void {
    this.db.run(
      `UPDATE worktrees SET removed_at = ? WHERE id = ?`,
      [new Date().toISOString(), id]
    );
  }

  findByRepo(repoPath: string): WorktreeRecord[] {
    return this.db.all(
      `SELECT * FROM worktrees WHERE repo_path = ? AND removed_at IS NULL`,
      [repoPath]
    ) as WorktreeRecord[];
  }
}
