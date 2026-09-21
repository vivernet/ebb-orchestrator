/**
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 */

import type { Database } from "../database/database.js";

/** Значения статуса, соответствующие ограничению DB CHECK. */
export type ArtifactStatus = "STAGING" | "ACTIVE" | "EXPIRED" | "MISSING";

/** Форма строки, возвращаемой таблицей `artifacts`. */
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

/** Параметры для вставки новой строки артефакта. */
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

/**
 * Предоставляет публичный контракт модуля artifact-repository для взаимодействия слоёв приложения.
 */
export class ArtifactRepository {
  constructor(private readonly db: Database) {}

  /** Вставляет новую строку артефакта. */
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

  /** Обновляет статус артефакта по идентификатору. */
  updateStatus(id: string, status: ArtifactStatus): void {
    this.db.run("UPDATE artifacts SET status = $status WHERE id = $id", {
      $id: id,
      $status: status,
    });
  }

  /** Возвращает строку артефакта по идентификатору. */
  getById(id: string): ArtifactRow | undefined {
    return this.db.get<ArtifactRow>(
      "SELECT * FROM artifacts WHERE id = $id",
      { $id: id },
    );
  }

  /** Возвращает все артефакты с указанным статусом. */
  getByStatus(status: ArtifactStatus): ArtifactRow[] {
    return this.db.all<ArtifactRow>(
      "SELECT * FROM artifacts WHERE status = $status",
      { $status: status },
    );
  }

  /** Удаляет строку артефакта по идентификатору. */
  deleteById(id: string): void {
    this.db.run("DELETE FROM artifacts WHERE id = $id", { $id: id });
  }
}
