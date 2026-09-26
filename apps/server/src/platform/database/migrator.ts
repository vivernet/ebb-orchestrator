/**
 * Описывает версионированную SQL-миграцию и проверяет её неизменность после применения.
 */

import { createHash } from "node:crypto";
import type { Database, DatabaseTx } from "./database.js";

export interface Migration {
  /** Монотонно возрастающий номер версии, начиная с 1. */
  version: number;
  /** Человекочитаемое имя, например `001_system`. */
  name: string;
  /** Исходный SQL-код для выполнения. */
  sql: string;
  /** Разрешает миграции единожды отключить FK до транзакции с обязательной последующей проверкой. */
  foreignKeys?: "disabled";
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

function restoreForeignKeys(db: Database, migrationName: string): { ok: true } | { ok: false; error: unknown } {
  try {
    db.exec("PRAGMA foreign_keys=ON");
    if (db.get<{ foreign_keys: number }>("PRAGMA foreign_keys")?.foreign_keys !== 1) {
      return { ok: false, error: new Error(`Migration ${migrationName} could not restore foreign keys outside its transaction`) };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
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
    const isApprovalChangesMigration = migration.version === 27 && migration.name.replace(/^0*27_/, "") === "approval_changes_requested";
    if (migration.foreignKeys !== undefined && (migration.foreignKeys !== "disabled" || !isApprovalChangesMigration)) {
      throw new Error(`Migration ${migration.version} requests an unsupported foreign-key policy`);
    }
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
    const foreignKeysDisabled = migration.foreignKeys === "disabled"
      || (migration.version === 27 && migration.name.replace(/^0*27_/, "") === "approval_changes_requested");
    const apply = (tx: DatabaseTx): void => {
      tx.exec(migration.sql);
      if (foreignKeysDisabled) {
        const violations = tx.all("PRAGMA foreign_key_check");
        if (violations.length > 0) throw new Error(`Migration ${migration.name} failed foreign key check`);
      }
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
    };

    if (!foreignKeysDisabled) {
      db.transaction(apply);
      continue;
    }

    const foreignKeysBefore = db.get<{ foreign_keys: number }>("PRAGMA foreign_keys")?.foreign_keys;
    if (foreignKeysBefore !== 1) throw new Error(`Migration ${migration.name} requires foreign keys to be enabled`);

    let migrationFailed = false;
    let migrationFailure: unknown;
    let restorationResult: { ok: true } | { ok: false; error: unknown };
    try {
      db.exec("PRAGMA foreign_keys=OFF");
      if (db.get<{ foreign_keys: number }>("PRAGMA foreign_keys")?.foreign_keys !== 0) {
        throw new Error(`Migration ${migration.name} could not disable foreign keys before its transaction`);
      }
      db.transaction(apply);
    } catch (error) {
      migrationFailed = true;
      migrationFailure = error;
    } finally {
      restorationResult = restoreForeignKeys(db, migration.name);
    }

    if (!restorationResult.ok) {
      if (migrationFailed) {
        throw new AggregateError([migrationFailure, restorationResult.error], `Migration ${migration.name} failed and foreign-key enforcement could not be restored`);
      }
      throw restorationResult.error;
    }
    if (migrationFailed) throw migrationFailure;
  }

  return { applied: pending.length };
}
