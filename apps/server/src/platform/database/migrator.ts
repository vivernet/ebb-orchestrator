/**
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 *
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 */

import type { Database } from "./database.js";
import { createHash } from "node:crypto";

export interface Migration {
  /** Монотонно возрастающий номер версии, начиная с 1. */
  version: number;
  /** Человекочитаемое имя, например `001_system`. */
  name: string;
  /** Исходный SQL-код для выполнения. */
  sql: string;
}

export interface MigrationResult {
  /** Количество миграций, применённых в этом вызове. */
  applied: number;
}

/**
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 */
function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

/**
 * Описывает соответствующий контракт, инвариант или этап выполнения.
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
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 */
function currentVersion(db: Database): number {
  const row = db.get<{ version: number }>(
    "SELECT MAX(version) as version FROM schema_migrations",
  );
  return row?.version ?? 0;
}

/**
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 *
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 * Описывает соответствующий контракт, инвариант или этап выполнения.
 * Описывает соответствующий контракт, инвариант или этап выполнения.
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
      // Выполняет соответствующую проверку или действие согласно контракту.
      tx.exec(migration.sql);

      // Выполняет соответствующую проверку или действие согласно контракту.
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
