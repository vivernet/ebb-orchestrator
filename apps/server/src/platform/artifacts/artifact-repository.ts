/**
 * Database repository for artifact records.
 */

import type { Database } from "../database/database.js";

/** Status values matching the DB CHECK constraint. */
export type ArtifactStatus = "STAGING" | "ACTIVE" | "EXPIRED" | "MISSING";

/** Row shape returned by the `artifacts` table. */
export interface ArtifactRow {
  id: string;
  type: string;
  relative_path: string;
  content_type: string | null;
  size_bytes: number;
  sha256: string;
  status: ArtifactStatus;
  project_id: string | null;
  task_id: string | null;
  run_id: string | null;
  created_at: string;
  expires_at: string | null;
}

/** Parameters for inserting a new artifact row. */
export interface InsertArtifactParams {
  id: string;
  type: string;
  relativePath: string;
  contentType: string | null;
  sizeBytes: number;
  sha256: string;
  status: ArtifactStatus;
  projectId: string | null;
  taskId: string | null;
  runId: string | null;
  createdAt: string;
  expiresAt: string | null;
}

export class ArtifactRepository {
  constructor(private readonly db: Database) {}

  /** Insert a new artifact row. */
  insert(params: InsertArtifactParams): void {
    this.db.run(
      `INSERT INTO artifacts (id, type, relative_path, content_type, size_bytes, sha256, status, project_id, task_id, run_id, created_at, expires_at)
       VALUES ($id, $type, $relative_path, $content_type, $size_bytes, $sha256, $status, $project_id, $task_id, $run_id, $created_at, $expires_at)`,
      {
        $id: params.id,
        $type: params.type,
        $relative_path: params.relativePath,
        $content_type: params.contentType,
        $size_bytes: params.sizeBytes,
        $sha256: params.sha256,
        $status: params.status,
        $project_id: params.projectId,
        $task_id: params.taskId,
        $run_id: params.runId,
        $created_at: params.createdAt,
        $expires_at: params.expiresAt,
      },
    );
  }

  /** Update an artifact's status by id. */
  updateStatus(id: string, status: ArtifactStatus): void {
    this.db.run("UPDATE artifacts SET status = $status WHERE id = $id", {
      $id: id,
      $status: status,
    });
  }

  /** Get an artifact row by id. */
  getById(id: string): ArtifactRow | undefined {
    return this.db.get<ArtifactRow>(
      "SELECT * FROM artifacts WHERE id = $id",
      { $id: id },
    );
  }

  /** Get all artifacts with a given status. */
  getByStatus(status: ArtifactStatus): ArtifactRow[] {
    return this.db.all<ArtifactRow>(
      "SELECT * FROM artifacts WHERE status = $status",
      { $status: status },
    );
  }

  /** Delete an artifact row by id. */
  deleteById(id: string): void {
    this.db.run("DELETE FROM artifacts WHERE id = $id", { $id: id });
  }
}
