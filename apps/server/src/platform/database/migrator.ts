/**
 * Описывает версионированную SQL-миграцию и проверяет её неизменность после применения.
 */

import { createHash } from "node:crypto";
import type { Database } from "./database.js";

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

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

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

function validateCatalog(migrations: Migration[]): Migration[] {
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  for (const [index, migration] of ordered.entries()) {
    if (!Number.isSafeInteger(migration.version) || migration.version < 1) {
      throw new Error(`Migration version must be a positive integer; found ${migration.version}`);
    }
    const previous = ordered[index - 1];
    if (previous && previous.version === migration.version) {
      throw new Error(`Migration catalog contains duplicate version ${migration.version}`);
    }
    if (migration.name.trim() === "") throw new Error(`Migration ${migration.version} must have a name`);
  }
  return ordered;
}

type AppliedMigration = {
  version: number;
  name: string;
  checksum: string;
};

function readAppliedMigrations(db: Database): AppliedMigration[] {
  return db.all<AppliedMigration>(
    "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
  );
}

function validateAppliedMigrations(migrations: Migration[], applied: AppliedMigration[]): void {
  const catalogByVersion = new Map(migrations.map((migration) => [migration.version, migration]));
  const appliedByVersion = new Map(applied.map((row) => [row.version, row]));
  const current = applied[applied.length - 1]?.version ?? 0;
  const highestCatalogVersion = migrations[migrations.length - 1]?.version ?? 0;

  if (current > highestCatalogVersion) {
    throw new Error(`Applied migration ${current} is outside the supplied catalog`);
  }

  for (const migration of migrations) {
    if (migration.version <= current && !appliedByVersion.has(migration.version)) {
      throw new Error(`Applied migration history has a gap at version ${migration.version}`);
    }
  }

  for (const row of applied) {
    const migration = catalogByVersion.get(row.version);
    if (!migration) {
      throw new Error(`Applied migration ${row.version} is missing from the supplied catalog`);
    }
    if (row.name !== migration.name) {
      throw new Error(`Migration ${row.version} name integrity check failed`);
    }
    if (row.checksum !== checksum(migration.sql)) {
      throw new Error(`Migration ${row.version} checksum integrity check failed`);
    }
  }
}

/**
 * Применяет каталог миграций вперёд и проверяет сохранённую историю.
 * Уже применённые записи нельзя переименовать, изменить или пропустить; повторный
 * запуск действующего каталога не меняет базу данных.
 */
export function runMigrations(
  db: Database,
  migrations: Migration[],
): MigrationResult {
  ensureSchemaTable(db);

  const catalog = validateCatalog(migrations);
  const applied = readAppliedMigrations(db);
  validateAppliedMigrations(catalog, applied);
  const current = applied[applied.length - 1]?.version ?? 0;
  const pending = catalog.filter((migration) => migration.version > current);

  for (const migration of pending) {
    db.transaction((tx) => {
      tx.exec(migration.sql);
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
