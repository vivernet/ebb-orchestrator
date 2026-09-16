import type { Database, StatementParams } from "../../platform/database/database.js";
import type { WorktreeRecord } from "./worktree-manager.js";

export class WorktreeRepository {
  constructor(private readonly db: Database) {}

  create(record: WorktreeRecord): void {
    this.db.run(
      `INSERT INTO worktrees (id, repo_path, path, branch, created_at, removed_at) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      { id: record.id, repo_path: record.repoPath, path: record.path, branch: record.branch, created_at: record.createdAt, removed_at: record.removedAt } as StatementParams
    );
  }

  findById(id: string): WorktreeRecord | undefined {
    const result = this.db.get(
      `SELECT * FROM worktrees WHERE id = ? AND removed_at IS NULL`,
      { id } as StatementParams
    ) as WorktreeRecord | undefined;
    return result;
  }

  remove(id: string): void {
    this.db.run(
      `UPDATE worktrees SET removed_at = ? WHERE id = ?`,
      { removed_at: new Date().toISOString(), id } as StatementParams
    );
  }

  findByRepo(repoPath: string): WorktreeRecord[] {
    return this.db.all(
      `SELECT * FROM worktrees WHERE repo_path = ? AND removed_at IS NULL`,
      { repo_path: repoPath } as StatementParams
    ) as WorktreeRecord[];
  }
}
