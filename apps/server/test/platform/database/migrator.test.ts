import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations, type Migration } from "../../../src/platform/database/migrator.js";
import type { Database } from "../../../src/platform/database/database.js";

const migration001 = readFileSync(
  join(import.meta.dirname, "../../../src/platform/database/migrations/001_system.sql"),
  "utf-8",
);

const goodMigrations: Migration[] = [
  { version: 1, name: "001_system", sql: migration001 },
];

describe("migrator", () => {
  let db: Database | undefined;
  let tmpDir: string;

  afterEach(async () => {
    db?.close();
    db = undefined;
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("runs migrations idempotently and sets WAL mode", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "orch-test-"));
    const dbPath = join(tmpDir, `test-${randomUUID()}.db`);
    db = createSqliteDatabase(dbPath);

    // Запускаем migrations дважды.
    const first = runMigrations(db, goodMigrations);
    const second = runMigrations(db, goodMigrations);

    // Первый запуск должен применить одну migration.
    expect(first.applied).toBe(1);
    // Второй запуск должен применить 0 migrations (идемпотентность).
    expect(second.applied).toBe(0);

    // Должна быть ровно одна запись migration.
    expect(db.all<{ version: number }>("SELECT version FROM schema_migrations")).toEqual([
      { version: 1 },
    ]);

    // Режим WAL journal.
    expect(
      db.get<{ journal_mode: string }>("PRAGMA journal_mode")?.journal_mode.toLowerCase(),
    ).toBe("wal");
  });

  it("rolls back partial state on failing migration", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "orch-test-"));
    const dbPath = join(tmpDir, `test-${randomUUID()}.db`);
    db = createSqliteDatabase(dbPath);

    const failingSql =
      "CREATE TABLE should_not_exist (id INTEGER PRIMARY KEY); " +
      "SELECT failing_intentionally_bad_sql_syntax;";

    const failingMigration: Migration[] = [
      { version: 1, name: "001_system", sql: migration001 },
      { version: 2, name: "002_fail", sql: failingSql },
    ];

    // При ошибочной migration должна возникнуть ошибка.
    expect(() => runMigrations(db!, failingMigration)).toThrow();

    // Первая migration должна быть применена.
    const migrations = db.all<{ version: number; name: string }>(
      "SELECT version, name FROM schema_migrations ORDER BY version",
    );
    expect(migrations).toEqual([{ version: 1, name: "001_system" }]);

    // Неполной таблицы ошибочной migration быть НЕ должно.
    const tables = db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='should_not_exist'",
    );
    expect(tables).toEqual([]);
  });

  it("applies a 025 to 026 upgrade once and remains idempotent", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "orch-auth-upgrade-"));
    db = createSqliteDatabase(join(tmpDir, `test-${randomUUID()}.db`));
    const migrations = (await import("../../helpers/migrations.js")).loadTestMigrations();
    const beforeAuth = migrations.filter((migration) => migration.version <= 25);

    expect(runMigrations(db, beforeAuth).applied).toBe(25);
    expect(runMigrations(db, migrations).applied).toBe(1);
    expect(runMigrations(db, migrations).applied).toBe(0);
    expect(db.all<{ version: number }>("SELECT version FROM schema_migrations ORDER BY version")).toHaveLength(26);
  });

  it("rejects a gap in applied migration history before changing the database", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "orch-migration-gap-"));
    db = createSqliteDatabase(join(tmpDir, `test-${randomUUID()}.db`));
    const migrations: Migration[] = [
      { version: 1, name: "001_system", sql: migration001 },
      { version: 2, name: "002_gap", sql: "CREATE TABLE gap_two (id INTEGER PRIMARY KEY);" },
      { version: 3, name: "003_gap", sql: "CREATE TABLE gap_three (id INTEGER PRIMARY KEY);" },
    ];
    runMigrations(db, migrations);
    db.run("DELETE FROM schema_migrations WHERE version = 2");

    expect(() => runMigrations(db!, migrations)).toThrow(/gap|пропуск|разрыв/i);
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM schema_migrations")?.count).toBe(2);
  });

  it("rejects an applied migration that is outside the supplied catalog", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "orch-migration-catalog-drift-"));
    db = createSqliteDatabase(join(tmpDir, `test-${randomUUID()}.db`));
    const migrations: Migration[] = [
      ...goodMigrations,
      { version: 2, name: "002_catalog_drift", sql: "CREATE TABLE catalog_drift (id INTEGER PRIMARY KEY);" },
    ];
    runMigrations(db, migrations);

    expect(() => runMigrations(db!, goodMigrations)).toThrow(/outside|catalog|каталог/i);
  });

  it("rejects an applied in-range migration missing from the catalog before pending migrations", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "orch-migration-catalog-gap-"));
    db = createSqliteDatabase(join(tmpDir, `test-${randomUUID()}.db`));
    const appliedMigrations: Migration[] = [
      ...goodMigrations,
      { version: 2, name: "002_catalog_gap", sql: "CREATE TABLE catalog_gap (id INTEGER PRIMARY KEY);" },
    ];
    runMigrations(db, appliedMigrations);
    const catalogWithPendingMigration: Migration[] = [
      ...goodMigrations,
      { version: 3, name: "003_catalog_gap", sql: "CREATE TABLE should_not_run (id INTEGER PRIMARY KEY);" },
    ];

    expect(() => runMigrations(db!, catalogWithPendingMigration)).toThrow(/catalog|missing|отсутств/i);
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='should_not_run'")?.count).toBe(0);
    expect(db!.all<{ version: number }>("SELECT version FROM schema_migrations ORDER BY version")).toEqual([
      { version: 1 },
      { version: 2 },
    ]);
  });

  it.each([
    ["name", "UPDATE schema_migrations SET name = '001_tampered' WHERE version = 1"],
    ["checksum", "UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 1"],
  ])("rejects an applied migration with a tampered %s", async (_field, tamperSql) => {
    tmpDir = await mkdtemp(join(tmpdir(), "orch-migration-tamper-"));
    db = createSqliteDatabase(join(tmpDir, `test-${randomUUID()}.db`));
    runMigrations(db, goodMigrations);
    db.exec(tamperSql);

    expect(() => runMigrations(db!, goodMigrations)).toThrow(/integrity|имя|контрольн/i);
  });

  it("applies the append-only auth migration exactly once with the contract schema", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "orch-auth-migration-"));
    const dbPath = join(tmpDir, `test-${randomUUID()}.db`);
    db = createSqliteDatabase(dbPath);
    const migrations = (await import("../../helpers/migrations.js")).loadTestMigrations();

    expect(migrations.map((migration) => migration.version)).toEqual(
      Array.from({ length: 26 }, (_, index) => index + 1),
    );
    expect(runMigrations(db, migrations).applied).toBe(26);
    expect(runMigrations(db, migrations).applied).toBe(0);
    expect(db.get<{ version: number }>("SELECT MAX(version) AS version FROM schema_migrations")?.version).toBe(26);
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='local_users'")?.count).toBe(1);
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='auth_sessions'")?.count).toBe(1);

    const localUserColumns = db.all<{ name: string; type: string; notnull: number }>("PRAGMA table_info(local_users)");
    expect(localUserColumns.map(({ name, type, notnull }) => [name, type, notnull])).toEqual([
      ["id", "INTEGER", 0],
      ["password_hash", "TEXT", 1],
      ["hash_algorithm", "TEXT", 1],
      ["hash_parameters_json", "TEXT", 1],
      ["created_at", "TEXT", 1],
      ["updated_at", "TEXT", 1],
    ]);
    const authSessionColumns = db.all<{ name: string; type: string; notnull: number }>("PRAGMA table_info(auth_sessions)");
    expect(authSessionColumns.map(({ name, type, notnull }) => [name, type, notnull])).toEqual([
      ["id", "TEXT", 0],
      ["token_hash", "TEXT", 1],
      ["csrf_token_hash", "TEXT", 1],
      ["created_at", "TEXT", 1],
      ["last_seen_at", "TEXT", 1],
      ["idle_expires_at", "TEXT", 1],
      ["absolute_expires_at", "TEXT", 1],
      ["revoked_at", "TEXT", 0],
    ]);
    expect(db.all<{ name: string }>("PRAGMA index_list(auth_sessions)").map(({ name }) => name)).toEqual(expect.arrayContaining([
      "idx_auth_sessions_token_hash",
      "idx_auth_sessions_revoked_at",
      "idx_auth_sessions_absolute_expires_at",
    ]));
    expect(db.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'local_users'")?.sql).toContain("CHECK (id = 1)");
    expect(db.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'auth_sessions'")?.sql).toContain("token_hash TEXT NOT NULL UNIQUE");
  });

  it("rolls back a failed appended auth migration without partial auth state", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "orch-auth-rollback-"));
    db = createSqliteDatabase(join(tmpDir, `test-${randomUUID()}.db`));
    const failingSql = "CREATE TABLE local_users (id INTEGER PRIMARY KEY); SELECT invalid_auth_sql;";
    const migrations = (await import("../../helpers/migrations.js")).loadTestMigrations();
    migrations[migrations.length - 1] = { version: 26, name: "026_local_auth", sql: failingSql };
    expect(() => runMigrations(db!, migrations)).toThrow();
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='local_users'")?.count).toBe(0);
    expect(db!.get<{ count: number }>("SELECT COUNT(*) AS count FROM schema_migrations WHERE version=26")?.count).toBe(0);
  });
});
