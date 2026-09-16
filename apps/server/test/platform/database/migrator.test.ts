import { describe, expect, it, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
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

    // Run migrations twice
    const first = runMigrations(db, goodMigrations);
    const second = runMigrations(db, goodMigrations);

    // First run should apply 1 migration
    expect(first.applied).toBe(1);
    // Second run should apply 0 (idempotent)
    expect(second.applied).toBe(0);

    // Exactly one migration record
    expect(db.all<{ version: number }>("SELECT version FROM schema_migrations")).toEqual([
      { version: 1 },
    ]);

    // WAL journal mode
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

    // Should throw on the failing migration
    expect(() => runMigrations(db!, failingMigration)).toThrow();

    // First migration should have been applied
    const migrations = db.all<{ version: number; name: string }>(
      "SELECT version, name FROM schema_migrations ORDER BY version",
    );
    expect(migrations).toEqual([{ version: 1, name: "001_system" }]);

    // Partial table from failed migration must NOT exist
    const tables = db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='should_not_exist'",
    );
    expect(tables).toEqual([]);
  });
});
