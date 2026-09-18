import type { Database, StatementParams } from "../../platform/database/database.js";
import type { WorktreeRecord } from "./worktree-manager.js";

/**
 * Экспортируемый компонент или контракт модуля, доступный другим слоям приложения.
 */
export class WorktreeRepository {
  constructor(private readonly db: Database) {}

  create(record: WorktreeRecord): void {
    this.db.run(
      `INSERT INTO worktrees (id, repo_path, path, branch, created_at, removed_at) 
       VALUES ($id, $repo_path, $path, $branch, $created_at, $removed_at)`,
      { id: record.id, repo_path: record.repoPath, path: record.path, branch: record.branch, created_at: record.createdAt, removed_at: record.removedAt } as StatementParams
    );
  }

  findById(id: string): WorktreeRecord | undefined {
    const row = this.db.get<Record<string, unknown>>(
      `SELECT * FROM worktrees WHERE id = $id AND removed_at IS NULL`,
      { id } as StatementParams
    );
    return row ? this.toRecord(row) : undefined;
  }

  remove(id: string): void {
    this.db.run(
      `UPDATE worktrees SET removed_at = $removed_at WHERE id = $id`,
      { removed_at: new Date().toISOString(), id } as StatementParams
    );
  }

  findByRepo(repoPath: string): WorktreeRecord[] {
    return this.db.all(
      `SELECT * FROM worktrees WHERE repo_path = $repo_path AND removed_at IS NULL`,
      { repo_path: repoPath } as StatementParams
    ).map((row) => this.toRecord(row));
  }

  private toRecord(row: Record<string, unknown>): WorktreeRecord {
    return {
      id: row.id as string,
      repoPath: row.repo_path as string,
      path: row.path as string,
      branch: row.branch as string,
      createdAt: row.created_at as string,
      removedAt: row.removed_at as string | null,
    };
  }
}
