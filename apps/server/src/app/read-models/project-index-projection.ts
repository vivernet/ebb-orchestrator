import type { Database } from "../../platform/database/database.js";
import type { ProjectIndexPageProjection, ProjectIndexRowProjection } from "@ebb-orchestrator/contracts";

interface ProjectRow {
  id: string;
  name: string;
  display_name: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface Cursor { t: string; i: string; }

/**
 * Пагинированный проектный индекс (plan-27 Task 4), owned by Projects.
 * Читает только авторитетные rows таблицы `projects`; не раскрывает repository-пути
 * и не строит индекс на клиенте. Курсор opaque (base64url JSON), стабилен по
 * (created_at, id); страница ограничена; пустая страница отличима от ошибки.
 */
export class ProjectIndexProjection {
  constructor(private readonly db?: Database) {}

  page(cursor: string | undefined, requestedLimit: number | undefined): ProjectIndexPageProjection {
    if (!this.db) return { items: [], nextCursor: null };
    const limit = Math.min(Math.max(requestedLimit ?? 20, 1), 100);
    const parsed = cursor === undefined ? undefined : parseCursor(cursor);
    if (cursor !== undefined && !parsed) {
      const error = new Error("INVALID_CURSOR") as Error & { code?: string };
      error.code = "INVALID_CURSOR";
      throw error;
    }
    const rows = parsed
      ? this.db.all<ProjectRow>(
          `SELECT id,name,display_name,status,created_at,updated_at FROM projects
           WHERE created_at > $t OR (created_at = $t AND id > $i)
           ORDER BY created_at, id LIMIT $limit`,
          { t: parsed.t, i: parsed.i, limit: limit + 1 },
        )
      : this.db.all<ProjectRow>(
          "SELECT id,name,display_name,status,created_at,updated_at FROM projects ORDER BY created_at, id LIMIT $limit",
          { limit: limit + 1 },
        );
    if (rows.length === 0) return { items: [], nextCursor: null };
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items: ProjectIndexRowProjection[] = pageRows.map((row) => ({
      id: row.id,
      name: row.name,
      displayName: row.display_name,
      status: row.status,
      updatedAt: row.updated_at,
    }));
    const last = pageRows[pageRows.length - 1]!;
    return { items, nextCursor: hasMore ? buildCursor({ t: last.created_at, i: last.id }) : null };
  }
}

function parseCursor(cursor: string): Cursor | undefined {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const value = JSON.parse(decoded) as Cursor;
    if (!value || typeof value.t !== "string" || typeof value.i !== "string" || !value.t || !value.i) return undefined;
    return value;
  } catch { return undefined; }
}

function buildCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}
