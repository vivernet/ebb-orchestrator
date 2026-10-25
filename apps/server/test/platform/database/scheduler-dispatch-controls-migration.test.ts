import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import type { Database } from "../../../src/platform/database/database.js";
import { runMigrations } from "../../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../../helpers/migrations.js";

/**
 * Миграция 053 — durable dispatch controls (plan-27 Task 2).
 *
 * RED-фаза: каталог ещё не содержит 053, поэтому все проверки новой схемы
 * падают до реализации.
 */
describe("scheduler dispatch controls migration 053", () => {
  let db: Database | undefined;
  let tmpDir: string;
  let dbPath: string;

  afterEach(async () => {
    db?.close();
    db = undefined;
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  async function openNewDatabase(): Promise<Database> {
    tmpDir = await mkdtemp(join(tmpdir(), "ebb-scheduler-dispatch-migration-"));
    dbPath = join(tmpDir, `test-${randomUUID()}.sqlite`);
    db = createSqliteDatabase(dbPath);
    return db;
  }

  it("fresh install 001-053 applies the scheduler dispatch controls migration exactly once", () => {
    db = createSqliteDatabase(":memory:");
    const migrations = loadTestMigrations();

    expect(migrations.map(({ version }) => version)).toEqual(Array.from({ length: 53 }, (_, index) => index + 1));
    expect(migrations.at(-1)?.name).toBe("053_scheduler_dispatch_controls");
    expect(runMigrations(db, migrations).applied).toBe(53);
    expect(db.all<{ version: number; name: string }>("SELECT version, name FROM schema_migrations ORDER BY version"))
      .toEqual(migrations.map(({ version, name }) => ({ version, name })));
    expect(runMigrations(db, migrations).applied).toBe(0);
  });

  it("scheduler_config gains dispatch_paused with default 0 and a 0/1 CHECK plus a durable dispatch_paused_at", () => {
    db = createSqliteDatabase(":memory:");
    runMigrations(db, loadTestMigrations());

    const columns = db.all<{ name: string; type: string; notnull: number; dflt_value: string | null }>(
      "PRAGMA table_info(scheduler_config)",
    );
    expect(columns).toContainEqual(expect.objectContaining({
      name: "dispatch_paused", type: "INTEGER", notnull: 1, dflt_value: "0",
    }));
    expect(columns).toContainEqual(expect.objectContaining({
      name: "dispatch_paused_at", type: "TEXT", notnull: 0, dflt_value: null,
    }));

    const tableSql = db.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type='table' AND name='scheduler_config'")?.sql;
    expect(tableSql).toMatch(/dispatch_paused\s+INTEGER\s+NOT NULL\s+DEFAULT 0\s+CHECK\s*\(\s*dispatch_paused\s+IN\s*\(0,\s*1\)\s*\)/i);

    // Дефолт новой колонки — 0 (dispatch не приостановлен).
    expect(db.get("SELECT dispatch_paused, dispatch_paused_at FROM scheduler_config WHERE id=1"))
      .toEqual({ dispatch_paused: 0, dispatch_paused_at: null });

    // CHECK отклоняет не-0/1 значение.
    expect(() => db!.run("UPDATE scheduler_config SET dispatch_paused=2 WHERE id=1")).toThrow(/CHECK constraint failed/i);
  });

  it("creates scheduler_scope_pauses with scope CHECK, actor and composite primary key", () => {
    db = createSqliteDatabase(":memory:");
    runMigrations(db, loadTestMigrations());

    const columns = db.all<{ name: string; type: string; notnull: number }>("PRAGMA table_info(scheduler_scope_pauses)")
      .map(({ name, type, notnull }) => ({ name, type, notnull }));
    expect(columns).toEqual(expect.arrayContaining([
      { name: "scope", type: "TEXT", notnull: 1 },
      { name: "scope_id", type: "TEXT", notnull: 1 },
      { name: "paused_at", type: "TEXT", notnull: 1 },
      { name: "actor", type: "TEXT", notnull: 1 },
    ]));

    const tableSql = db.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type='table' AND name='scheduler_scope_pauses'")?.sql;
    expect(tableSql).toMatch(/CHECK\s*\(\s*scope\s+IN\s*\(\s*'PROJECT',\s*'EPIC'\s*\)\s*\)/i);
    expect(tableSql).toMatch(/PRIMARY KEY\s*\(\s*scope,\s*scope_id\s*\)/i);

    const now = new Date().toISOString();
    db.run("INSERT INTO scheduler_scope_pauses(scope,scope_id,paused_at,actor) VALUES('PROJECT','p-1',$now,'test')", { now });

    // Повторный ключ (scope, scope_id) отклоняется.
    expect(() => db!.run("INSERT INTO scheduler_scope_pauses(scope,scope_id,paused_at,actor) VALUES('PROJECT','p-1',$now,'test')", { now }))
      .toThrow(/UNIQUE|PRIMARY KEY/);
    // Неизвестный scope отклоняется CHECK-ограничением.
    expect(() => db!.run("INSERT INTO scheduler_scope_pauses(scope,scope_id,paused_at,actor) VALUES('TASK','p-1',$now,'test')", { now }))
      .toThrow(/CHECK constraint failed/i);
  });

  it("upgrades a populated v052 database to v053 preserving existing scheduler rows and foreign key integrity", async () => {
    const database = await openNewDatabase();
    const migrations = loadTestMigrations();
    const through052 = migrations.filter((migration) => migration.version <= 52);

    expect(runMigrations(database, through052).applied).toBe(52);

    // Существующий scheduler-контекст до 053: конфигурация и активная резервация.
    const now = new Date().toISOString();
    database.run("UPDATE scheduler_config SET config_json=$config, updated_at=$at WHERE id=1", {
      config: JSON.stringify({ globalMax: 2, projectMax: 2, roleCapacity: { reviewer: 1, developer: 1 } }),
      at: now,
    });
    database.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES('p-1','p','P','ACTIVE',$now,$now)", { now });
    database.run("INSERT INTO scheduler_reservations(id,kind,subject_id,project_id,owner_id,reserved_at,estimate_cost,status,role,model) VALUES('res-1','TASK','task-1','p-1','task:task-1',$now,5,'RESERVED','developer','default')", { now });
    database.run("INSERT INTO scheduler_resource_locks(resource_key,reservation_id,project_id,owner_id,locked_at) VALUES('task:task-1','res-1','p-1','task:task-1',$now)", { now });

    const upgraded = runMigrations(database, migrations);
    expect(upgraded.applied).toBe(1);

    // Конфигурация и номер строки сохранены; dispatch_paused получает дефолт 0.
    expect(database.get("SELECT id, config_json, dispatch_paused, dispatch_paused_at FROM scheduler_config WHERE id=1"))
      .toEqual({
        id: 1,
        config_json: JSON.stringify({ globalMax: 2, projectMax: 2, roleCapacity: { reviewer: 1, developer: 1 } }),
        dispatch_paused: 0,
        dispatch_paused_at: null,
      });
    expect(database.get("SELECT id,status,project_id FROM scheduler_reservations WHERE id='res-1'"))
      .toEqual({ id: "res-1", status: "RESERVED", project_id: "p-1" });
    expect(database.get("SELECT resource_key,reservation_id FROM scheduler_resource_locks WHERE reservation_id='res-1'"))
      .toEqual({ resource_key: "task:task-1", reservation_id: "res-1" });
    expect(database.all("PRAGMA foreign_key_check")).toEqual([]);
    expect(database.all("SELECT * FROM scheduler_scope_pauses")).toEqual([]);
  });

  it("persists dispatch pause state across a full database restart", async () => {
    const database = await openNewDatabase();
    const migrations = loadTestMigrations();
    runMigrations(database, migrations);

    database.run("UPDATE scheduler_config SET dispatch_paused=1, dispatch_paused_at=$at WHERE id=1", { at: "2026-10-25T00:00:00.000Z" });
    expect(database.get("SELECT dispatch_paused, dispatch_paused_at FROM scheduler_config WHERE id=1"))
      .toEqual({ dispatch_paused: 1, dispatch_paused_at: "2026-10-25T00:00:00.000Z" });

    database.close();
    db = undefined;

    db = createSqliteDatabase(dbPath);
    // Перезапуск: migrator ничего не переприменяет, состояние сохраняется.
    expect(runMigrations(db, migrations).applied).toBe(0);
    expect(db.get("SELECT dispatch_paused, dispatch_paused_at FROM scheduler_config WHERE id=1"))
      .toEqual({ dispatch_paused: 1, dispatch_paused_at: "2026-10-25T00:00:00.000Z" });
  });
});
