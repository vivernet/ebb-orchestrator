/**
 * Restart-safe migration runner.
 *
 * Each migration is executed inside its own transaction so that a failure
 * in migration N+1 does not undo the already-applied migration N.
 * The runner is idempotent: calling `runMigrations` twice with the same
 * list produces exactly the same database state and returns
 * `{ applied: 0 }` on the second call.
 */

import type { Database } from "./database.js";
import { createHash } from "node:crypto";

export interface Migration {
  /** Monotonically increasing version number (start at 1). */
  version: number;
  /** Human-readable name (e.g. `001_system`). */
  name: string;
  /** Raw SQL to execute. */
  sql: string;
}

export interface MigrationResult {
  /** Number of migrations applied in this call. */
  applied: number;
}

/**
 * Compute a SHA-256 hex digest of a migration's SQL content.
 */
function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

/**
 * Ensure the `schema_migrations` tracking table exists.
 */
function ensureSchemaTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

/**
 * Return the highest version that has already been applied.
 */
function currentVersion(db: Database): number {
  const row = db.get<{ version: number }>(
    "SELECT MAX(version) as version FROM schema_migrations",
  );
  return row?.version ?? 0;
}

/**
 * Run an ordered list of migrations against `db`.
 *
 * - Migrations with `version <= currentVersion` are skipped.
 * - Each new migration is wrapped in its own transaction; on failure
 *   the transaction is rolled back and the error is re-thrown.
 * - After a successful migration the `schema_migrations` row is inserted
 *   **in the same transaction** so that the apply + record are atomic.
 */
export function runMigrations(
  db: Database,
  migrations: Migration[],
): MigrationResult {
  ensureSchemaTable(db);

  const applied = currentVersion(db);
  const pending = migrations
    .filter((m) => m.version > applied)
    .sort((a, b) => a.version - b.version);

  for (const migration of pending) {
    db.transaction((tx) => {
      // Execute the migration DDL/DML.
      tx.exec(migration.sql);

      // Record the migration atomically.
      tx.run(
        `INSERT INTO schema_migrations (version, name, checksum, applied_at)
         VALUES ($version, $name, $checksum, $applied_at)`,
        {
          $version: migration.version,
          $name: migration.name,
          $checksum: checksum(migration.sql),
          $applied_at: new Date().toISOString(),
        },
      );
    });
  }

  return { applied: pending.length };
}
