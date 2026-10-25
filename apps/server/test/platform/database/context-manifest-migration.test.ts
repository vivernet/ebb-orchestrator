import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations, type Migration } from "../../../src/platform/database/migrator.js";
import type { Database } from "../../../src/platform/database/database.js";
import {
  getContextManifest,
  insertContextManifestTx,
} from "../../../src/modules/context/context-manifest-repository.js";
import {
  getRunProcessOwner,
  insertRunProcessOwnerTx,
  prepareRunProcessOwner,
} from "../../../src/modules/runtime/run-process-owner.js";
import { digestRunPromptBytesV1 } from "../../../src/modules/context/context-provenance.js";
import type { ContextManifestRoleV1, PreparedRunContext } from "../../../src/modules/context/context-types.js";
import type { RunProcessOwner } from "../../../src/modules/runtime/run-process-owner.js";
import { loadTestMigrations } from "../../helpers/migrations.js";

type Row = Record<string, string | number | null>;

describe("context manifest v2 migration", () => {
  let db: Database | undefined;
  let dbPath: string;
  let tmpDir: string;

  afterEach(async () => {
    db?.close();
    db = undefined;
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it("preserves populated context storage during additive scheduler migration 043", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ebb-scheduler-capacity-migration-"));
    dbPath = join(tmpDir, `migration-${randomUUID()}.sqlite`);
    db = createSqliteDatabase(dbPath);
    const migrations = loadTestMigrations();
    runMigrations(db, migrations.filter(({ version }) => version <= 36));
    seedLegacyRows(db);
    runMigrations(db, migrations.filter(({ version }) => version <= 42));
    const before = ["context_deltas", "context_manifests"].map((table) => ({
      table, rows: db!.all<Row>(`SELECT * FROM ${table} ORDER BY id`), bytes: storedBytes(db!, table),
      sql: tableSql(db!, table), columns: tableColumns(db!, table), indexes: indexes(db!, table),
      foreignKeys: foreignKeys(db!, table),
    }));
    const migration = migrations.find(({ version }) => version === 43)!;
    expect(migration.name).toBe("043_scheduler_capacity_wait_started_at");
    expect(migration.sql.trim()).toBe("ALTER TABLE tasks ADD COLUMN capacity_wait_started_at TEXT;");
    expect(runMigrations(db, migrations.filter(({ version }) => version <= 43)).applied).toBe(1);
    for (const prior of before) {
      expect(db!.all<Row>(`SELECT * FROM ${prior.table} ORDER BY id`)).toEqual(prior.rows);
      expect(storedBytes(db!, prior.table)).toEqual(prior.bytes);
      expect(tableSql(db!, prior.table)).toBe(prior.sql);
      expect(tableColumns(db!, prior.table)).toEqual(prior.columns);
      expect(indexes(db!, prior.table)).toEqual(prior.indexes);
      expect(foreignKeys(db!, prior.table)).toEqual(prior.foreignKeys);
    }
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
    expect(db.all("PRAGMA table_info(tasks)")).toContainEqual(expect.objectContaining({ name: "capacity_wait_started_at", type: "TEXT", notnull: 0 }));
  });

  it("adds Darwin containment kinds in 047 without changing durable owner or context storage", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ebb-darwin-owner-migration-"));
    dbPath = join(tmpDir, `migration-${randomUUID()}.sqlite`);
    db = createSqliteDatabase(dbPath);
    const migrations = loadTestMigrations();
    runMigrations(db, migrations.filter(({ version }) => version <= 36));
    seedLegacyRows(db);
    runMigrations(db, migrations.filter(({ version }) => version <= 46));
    db.transaction((tx) => insertRunProcessOwnerTx(tx, prepareRunProcessOwner(
      "legacy-run-a", "C:\\legacy\\hermes", "windows-job")));
    const ownerRows = db.all<Row>("SELECT * FROM run_process_owners ORDER BY run_id");
    const generationRows = db.all<Row>("SELECT * FROM run_process_owner_generations ORDER BY run_id,generation");
    const ownerSchema = ["run_process_owners", "run_process_owner_generations"].map((table) => ({
      table,
      columns: tableColumns(db!, table),
      indexes: indexes(db!, table),
      foreignKeys: foreignKeys(db!, table),
      sql: tableSql(db!, table),
    }));
    const ownerTriggers = db.all<Row>(`SELECT name,sql FROM sqlite_master WHERE type='trigger'
      AND tbl_name IN ('run_process_owners','run_process_owner_generations') ORDER BY name`);
    const deltasBefore = deltaStorage(db);
    const migrationsThrough046 = migrations.filter(({ version }) => version <= 46);
    const migration047 = migrations.find(({ version }) => version === 47)!;
    expect(migration047.name).toBe("047_darwin_process_group");

    const failed = { ...migration047, sql: `${migration047.sql}\nSELECT intentionally_invalid_darwin_migration_sql;` };
    expect(() => runMigrations(db!, [...migrationsThrough046, failed])).toThrow(/intentionally_invalid_darwin_migration_sql/);
    expect(db.all<Row>("SELECT * FROM run_process_owners ORDER BY run_id")).toEqual(ownerRows);
    expect(db.all<Row>("SELECT * FROM run_process_owner_generations ORDER BY run_id,generation")).toEqual(generationRows);
    for (const before of ownerSchema) {
      expect(normalizedOwnerTableSql(before.table, tableSql(db, before.table)))
        .toBe(normalizedOwnerTableSql(before.table, before.sql));
      expect(tableColumns(db, before.table)).toEqual(before.columns);
      expect(indexes(db, before.table)).toEqual(before.indexes);
      expect(foreignKeys(db, before.table)).toEqual(before.foreignKeys);
    }
    expect(db.all<Row>(`SELECT name,sql FROM sqlite_master WHERE type='trigger'
      AND tbl_name IN ('run_process_owners','run_process_owner_generations') ORDER BY name`)).toEqual(ownerTriggers);
    for (const before of ownerSchema) expect(tableSql(db, before.table)).toBe(before.sql);
    expect(deltaStorage(db)).toEqual(deltasBefore);
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
    expect(db.get("SELECT version FROM schema_migrations WHERE version=47")).toBeUndefined();

    expect(runMigrations(db, migrations).applied).toBe(9);
    expect(db.all<Row>("SELECT * FROM run_process_owners ORDER BY run_id")).toEqual(ownerRows);
    expect(db.all<Row>("SELECT * FROM run_process_owner_generations ORDER BY run_id,generation")).toEqual(generationRows);
    for (const before of ownerSchema) {
      expect(normalizedOwnerTableSql(before.table, tableSql(db, before.table)))
        .toBe(normalizedOwnerTableSql(before.table, before.sql));
      expect(tableColumns(db, before.table)).toEqual(before.columns);
      expect(indexes(db, before.table)).toEqual(before.indexes);
      expect(foreignKeys(db, before.table)).toEqual(before.foreignKeys);
    }
    expect(db.all<Row>(`SELECT name,sql FROM sqlite_master WHERE type='trigger'
      AND tbl_name IN ('run_process_owners','run_process_owner_generations') ORDER BY name`)).toEqual(ownerTriggers);
    expect(deltaStorage(db)).toEqual(deltasBefore);
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
    expect(() => db!.run("UPDATE run_process_owners SET containment_kind='unsupported' WHERE run_id='legacy-run-a'"))
      .toThrow(/CHECK constraint failed/i);
    db.run("UPDATE run_process_owner_generations SET containment_kind='darwin-process-group' WHERE run_id='legacy-run-a' AND generation=1");
    db.run("UPDATE run_process_owners SET containment_kind='darwin-process-group' WHERE run_id='legacy-run-a'");
    expect(db.get("SELECT containment_kind FROM run_process_owners WHERE run_id='legacy-run-a'"))
      .toEqual({ containment_kind: "darwin-process-group" });
    expect(db.get("SELECT containment_kind FROM run_process_owner_generations WHERE run_id='legacy-run-a' AND generation=1"))
      .toEqual({ containment_kind: "darwin-process-group" });
    expect(getRunProcessOwner(db, "legacy-run-a")?.containmentKind).toBe("darwin-process-group");

    db.close();
    db = createSqliteDatabase(dbPath);
    expect(runMigrations(db, migrations).applied).toBe(0);
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
    expect(deltaStorage(db)).toEqual(deltasBefore);
  });

  it("preserves historical manifests and delta storage through populated v036 to v042 upgrade", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ebb-context-manifest-migration-"));
    dbPath = join(tmpDir, `migration-${randomUUID()}.sqlite`);
    db = createSqliteDatabase(dbPath);
    const migrations = loadTestMigrations();
    const migration037 = migrations.find((migration) => migration.version === 37);
    const migration039 = migrations.find((migration) => migration.version === 39);
    const migration040 = migrations.find((migration) => migration.version === 40);
    const migration041 = migrations.find((migration) => migration.version === 41);
    expect(migration037?.name).toBe("037_context_manifest_v2");
    expect(migration039?.name).toBe("039_run_session_capture_state");
    expect(migration040?.name).toBe("040_run_hermes_source_snapshot");
    expect(migration041?.name).toBe("041_shared_hermes_home");
    expect(migration040?.sql.trim()).toBe("ALTER TABLE run_process_owners ADD COLUMN hermes_source_snapshot_key TEXT;");
    const migrationsThrough042 = migrations.filter(({ version }) => version <= 42);
    expect(migrationsThrough042.map(({ version }) => version)).toEqual(
      Array.from({ length: 42 }, (_, index) => index + 1),
    );

    runMigrations(db, migrations.filter((migration) => migration.version <= 36));
    seedLegacyRows(db);
    db.run("UPDATE agent_runs SET session_id='legacy-session-id' WHERE id='legacy-run-a'");
    const oldManifestRows = db.all<Row>("SELECT * FROM context_manifests ORDER BY id");
    const oldDeltaRows = db.all<Row>("SELECT * FROM context_deltas ORDER BY id");
    const oldDeltaBytes = storedBytes(db, "context_deltas");
    const oldManifestColumns = tableColumns(db, "context_manifests");
    const oldDeltaColumns = tableColumns(db, "context_deltas");
    const oldManifestIndexes = indexes(db, "context_manifests");
    const oldDeltaIndexes = indexes(db, "context_deltas");
    const oldDeltaRootPage = rootPage(db, "context_deltas");
    const originalDeltaForeignKeys = foreignKeys(db, "context_deltas");

    expect(originalDeltaForeignKeys.map(({ table, from, to, on_delete }) => ({ table, from, to, on_delete }))).toEqual([
      { table: "context_manifests", from: "previous_manifest_id", to: "id", on_delete: "SET NULL" },
      { table: "context_manifests", from: "manifest_id", to: "id", on_delete: "CASCADE" },
    ]);

    expect(runMigrations(db, migrations.filter((migration) => migration.version <= 38)).applied).toBe(2);

    const deltaRowsBefore039 = db.all<Row>("SELECT * FROM context_deltas ORDER BY id");
    const deltaColumnsBefore039 = tableColumns(db, "context_deltas");
    const deltaIndexesBefore039 = indexes(db, "context_deltas");
    const deltaRootPageBefore039 = rootPage(db, "context_deltas");
    const deltaSqlBefore039 = tableSql(db, "context_deltas");
    const deltaForeignKeysBefore039 = foreignKeys(db, "context_deltas").map(({ table, from, to, on_delete }) => ({ table, from, to, on_delete }));
    const foreignKeyViolationsBefore039 = db.all("PRAGMA foreign_key_check");
    expect(foreignKeyViolationsBefore039).toEqual([]);
    insertRawOwner(db, prepareRunProcessOwner("legacy-run-a", "C:\\legacy\\hermes\\legacy-run-a", "windows-job"));

    expect(runMigrations(db, migrations.filter((migration) => migration.version <= 39)).applied).toBe(1);
    const ownersBefore040 = db.all<Row>("SELECT * FROM run_process_owners ORDER BY run_id");
    const ownerColumnsBefore040 = tableColumns(db, "run_process_owners");
    expect(ownerColumnsBefore040).toContainEqual({
      name: "capture_state", type: "TEXT", notnull: 1, dflt_value: "'UNBOUND'", pk: 0,
    });
    expect(tableSql(db, "run_process_owners")).toMatch(
      /capture_state\s+TEXT\s+NOT NULL\s+DEFAULT 'UNBOUND'\s+CHECK\s*\(\s*capture_state IN\s*\('UNBOUND',\s*'BOUND',\s*'INVALID'\)\s*\)/,
    );
    const contextTablesBefore040 = ["context_deltas", "context_manifests", "context_manifests_legacy_v1"].map((table) => ({
      table, rows: db!.all<Row>(`SELECT * FROM ${table} ORDER BY id`),
      bytes: storedBytes(db!, table), columns: tableColumns(db!, table),
      indexes: indexes(db!, table), sql: tableSql(db!, table),
      rootPage: rootPage(db!, table), foreignKeys: foreignKeys(db!, table),
    }));
    expect(runMigrations(db, migrations.filter(({ version }) => version <= 42)).applied).toBe(3);
    expect(db.all("SELECT version, name FROM schema_migrations ORDER BY version"))
      .toEqual(migrations.filter(({ version }) => version <= 42).map(({ version, name }) => ({ version, name })));
    expect(tableColumns(db, "run_process_owners")).toEqual([
      ...ownerColumnsBefore040,
      { name: "hermes_source_snapshot_key", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "current_generation", type: "INTEGER", notnull: 1, dflt_value: "1", pk: 0 },
    ]);
    expect(db.all<Row>("SELECT * FROM run_process_owners ORDER BY run_id"))
      .toEqual(ownersBefore040.map((owner) => ({ ...owner, hermes_source_snapshot_key: null, current_generation: 1 })));
    expect(db.all("SELECT run_id,generation,run_attempt FROM run_process_owner_generations"))
      .toEqual([{ run_id: "legacy-run-a", generation: 1, run_attempt: null }]);
    expect(db.all("SELECT * FROM run_resume_bindings")).toEqual([]);
    for (const before of contextTablesBefore040) {
      expect(db.all<Row>(`SELECT * FROM ${before.table} ORDER BY id`)).toEqual(before.rows);
      expect(storedBytes(db, before.table)).toEqual(before.bytes);
      expect(tableColumns(db, before.table)).toEqual(before.columns);
      expect(indexes(db, before.table)).toEqual(before.indexes);
      expect(tableSql(db, before.table)).toBe(before.sql);
      expect(rootPage(db, before.table)).toBe(before.rootPage);
      expect(foreignKeys(db, before.table)).toEqual(before.foreignKeys);
    }

    expect(db.all<Row>("SELECT * FROM context_manifests_legacy_v1 ORDER BY id")).toEqual(oldManifestRows);
    expect(db.all<Row>("SELECT * FROM context_deltas ORDER BY id")).toEqual(oldDeltaRows);
    expect(storedBytes(db, "context_deltas")).toEqual(oldDeltaBytes);
    expect(tableColumns(db, "context_manifests_legacy_v1")).toEqual(oldManifestColumns);
    expect(tableColumns(db, "context_deltas")).toEqual(oldDeltaColumns);
    expect(indexes(db, "context_manifests_legacy_v1")).toEqual(oldManifestIndexes);
    expect(indexes(db, "context_deltas")).toEqual(oldDeltaIndexes);
    expect(rootPage(db, "context_deltas")).toBe(oldDeltaRootPage);
    expect(foreignKeys(db, "context_deltas").map(({ table, from, to, on_delete }) => ({ table, from, to, on_delete }))).toEqual([
      { table: "context_manifests_legacy_v1", from: "previous_manifest_id", to: "id", on_delete: "SET NULL" },
      { table: "context_manifests_legacy_v1", from: "manifest_id", to: "id", on_delete: "CASCADE" },
    ]);
    expect(db.all("PRAGMA foreign_key_check")).toEqual(foreignKeyViolationsBefore039);
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM context_manifests")?.count).toBe(0);
    expect(db.all<Row>("SELECT * FROM context_deltas ORDER BY id")).toEqual(deltaRowsBefore039);
    expect(tableColumns(db, "context_deltas")).toEqual(deltaColumnsBefore039);
    expect(indexes(db, "context_deltas")).toEqual(deltaIndexesBefore039);
    expect(rootPage(db, "context_deltas")).toBe(deltaRootPageBefore039);
    expect(tableSql(db, "context_deltas")).toBe(deltaSqlBefore039);
    expect(foreignKeys(db, "context_deltas").map(({ table, from, to, on_delete }) => ({ table, from, to, on_delete })))
      .toEqual(deltaForeignKeysBefore039);
    expect(db.get<{ capture_state: string }>("SELECT capture_state FROM run_process_owners WHERE run_id='legacy-run-a'"))
      .toEqual({ capture_state: "UNBOUND" });
    expect(db.get("SELECT hermes_source_snapshot_key FROM run_process_owners WHERE run_id='legacy-run-a'"))
      .toEqual({ hermes_source_snapshot_key: null });
    expect(db.get<{ session_id: string }>("SELECT session_id FROM agent_runs WHERE id='legacy-run-a'"))
      .toEqual({ session_id: "legacy-session-id" });
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM run_process_owners")?.count).toBe(1);
    expect(db.get<{ resume_reason: string; resume_safe: number }>(
      "SELECT resume_reason, resume_safe FROM context_deltas WHERE id='legacy-delta-b'",
    )).toEqual({ resume_reason: "historical diagnostic only", resume_safe: 0 });
    expect(getContextManifest(db, "legacy-run-a")).toEqual({
      availability: "unavailable",
      reason: "LEGACY_PROVENANCE_UNAVAILABLE",
    });

    // Restart/reopen must preserve all bytes represented by historical SQLite values.
    db.close();
    db = createSqliteDatabase(dbPath);
    expect(runMigrations(db, migrations.filter(({ version }) => version <= 42)).applied).toBe(0);
    expect(db.all<Row>("SELECT * FROM context_manifests_legacy_v1 ORDER BY id")).toEqual(oldManifestRows);
    expect(db.all<Row>("SELECT * FROM context_deltas ORDER BY id")).toEqual(oldDeltaRows);
    expect(storedBytes(db, "context_deltas")).toEqual(oldDeltaBytes);
    expect(db.get<{ capture_state: string }>("SELECT capture_state FROM run_process_owners WHERE run_id='legacy-run-a'"))
      .toEqual({ capture_state: "UNBOUND" });
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);

    // The renamed manifest remains the diagnostic-only owner of both historical FKs.
    db.run("DELETE FROM context_manifests_legacy_v1 WHERE id = $id", { id: "legacy-manifest-a" });
    expect(db.all<{ id: string; previous_manifest_id: string | null }>(
      "SELECT id, previous_manifest_id FROM context_deltas ORDER BY id",
    )).toEqual([
      { id: "legacy-delta-b", previous_manifest_id: null },
      { id: "legacy-delta-c", previous_manifest_id: "legacy-manifest-b" },
    ]);
    db.run("DELETE FROM context_manifests_legacy_v1 WHERE id = $id", { id: "legacy-manifest-b" });
    expect(db.all<{ id: string; previous_manifest_id: string | null }>(
      "SELECT id, previous_manifest_id FROM context_deltas ORDER BY id",
    )).toEqual([{ id: "legacy-delta-c", previous_manifest_id: null }]);
  });

  it("copies populated v041 owner identities exactly and preserves immutable stopped generations across reopen", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ebb-run-recovery-upgrade-"));
    dbPath = join(tmpDir, "upgrade.sqlite");
    db = createSqliteDatabase(dbPath);
    const migrations = loadTestMigrations();
    const migrationsThrough042 = migrations.filter(({ version }) => version <= 42);
    runMigrations(db, migrations.filter(({ version }) => version <= 36));
    seedLegacyRows(db);
    runMigrations(db, migrations.filter(({ version }) => version <= 41));
    const states = ["PREPARED", "LAUNCHING", "LIVE", "STOPPING", "STOPPED", "UNKNOWN"] as const;
    for (const [index, state] of states.entries()) {
      const runId = `generation-run-${index}`;
      insertRun(db, runId, "migration-task", "migration-epic", "developer");
      const owner = prepareRunProcessOwner(runId, "C:\\shared\\hermes", index % 2 === 0 ? "windows-job" : "systemd-user-service");
      insertRawOwner(db, state === "PREPARED" ? owner : {
        ...owner, state, systemdInvocationId: index % 2 === 1 ? `invocation-${index}` : null,
        supervisorPid: 100 + index, supervisorStartIdentity: `supervisor-${index}`, pid: 200 + index,
        platform: index % 2 === 0 ? "win32" : "linux", processStartIdentity: `process-${index}`,
        executableIdentity: `executable-${index}`, stopEvidence: state === "STOPPED" ? "EXACT_SCOPE_STOPPED" : null,
      });
      db.run("UPDATE run_process_owners SET capture_state=$capture,systemd_control_group=$cgroup,hermes_source_snapshot_key=$source WHERE run_id=$runId", {
        runId, capture: ["UNBOUND", "BOUND", "INVALID"][index % 3]!,
        cgroup: index % 2 === 1 ? `/user.slice/fixture-${index}` : null, source: index === 2 ? "historical-source-key" : null,
      });
      db.run("UPDATE agent_runs SET attempt=$attempt,session_id=$session WHERE id=$runId", {
        runId, attempt: index + 1, session: index === 1 ? "original-session" : null,
      });
    }
    const owners = db.all<Row>("SELECT * FROM run_process_owners ORDER BY run_id");
    const runs = db.all<Row>("SELECT * FROM agent_runs ORDER BY id");
    const deltaBefore = deltaStorage(db);
    const ownerRoot = rootPage(db, "run_process_owners");
    expect(runMigrations(db, migrationsThrough042).applied).toBe(1);
    expect(rootPage(db, "run_process_owners")).toBe(ownerRoot);
    expect(db.all<Row>("SELECT * FROM run_process_owners ORDER BY run_id"))
      .toEqual(owners.map((owner) => ({ ...owner, current_generation: 1 })));
    const generationColumns = tableColumns(db, "run_process_owner_generations").map(({ name }) => String(name));
    expect(generationColumns).toEqual(expect.arrayContaining([
      "source_tag", "hermes_home", "hermes_source_snapshot_key", "capture_state",
    ]));
    const expected = owners.map((owner) => Object.fromEntries(generationColumns.map((name) => [name,
      name === "generation" ? 1 : name === "run_attempt" ? null : owner[name],
    ])));
    expect(db.all("SELECT * FROM run_process_owner_generations ORDER BY run_id")).toEqual(expected);
    expect(db.all<Row>("SELECT * FROM agent_runs ORDER BY id")).toEqual(runs);
    expect(db.all("SELECT * FROM run_resume_bindings")).toEqual([]);
    expect(deltaStorage(db)).toEqual(deltaBefore);
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
    expect(() => db!.run("UPDATE run_process_owner_generations SET stop_evidence='changed' WHERE state='STOPPED'"))
      .toThrow(/STOPPED generation is immutable/);
    expect(() => db!.run("DELETE FROM run_process_owner_generations WHERE state='STOPPED'"))
      .toThrow(/STOPPED generation is immutable/);
    expect(() => db!.run("UPDATE run_process_owners SET current_generation=999 WHERE run_id='generation-run-0'"))
      .toThrow(/Current generation does not exist/);
    expect(() => db!.run("DELETE FROM run_process_owner_generations WHERE run_id='generation-run-0'"))
      .toThrow(/Current generation is referenced/);
    expect(() => db!.run("UPDATE run_process_owner_generations SET generation=999 WHERE run_id='generation-run-0'"))
      .toThrow(/Current generation is referenced/);
    db.exec("PRAGMA recursive_triggers=OFF");
    for (const identity of ["containment_id", "launch_nonce"]) {
      for (const protectedRun of ["generation-run-4", "generation-run-1"]) {
        expect(() => db!.run(
          `UPDATE OR REPLACE run_process_owner_generations
           SET ${identity}=(SELECT ${identity} FROM run_process_owner_generations WHERE run_id=$protectedRun)
           WHERE run_id='generation-run-0'`,
          { protectedRun },
        )).toThrow(/Generation identity conflict/);
      }
    }
    expect(db.all("SELECT * FROM run_process_owner_generations ORDER BY run_id")).toEqual(expected);
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
    for (const replacementGeneration of ["generation", "2"]) {
      expect(() => db!.run(
        `INSERT OR REPLACE INTO run_process_owner_generations(${generationColumns.join(",")})
         SELECT ${generationColumns.map((column) => column === "generation" ? replacementGeneration : column).join(",")}
         FROM run_process_owner_generations WHERE run_id='generation-run-4'`,
      )).toThrow(/STOPPED generation is immutable/);
    }
    expect(() => db!.run(
      `INSERT OR REPLACE INTO run_process_owner_generations(${generationColumns.join(",")})
       SELECT ${generationColumns.map((column) => column === "generation" ? "2" : column).join(",")}
       FROM run_process_owner_generations WHERE run_id='generation-run-0'`,
    )).toThrow(/UNIQUE conflict would orphan current generation/);
    const bindingHash = "a".repeat(64);
    for (const [runId, sessionId] of [["generation-run-0", null], ["generation-run-1", "original-session"]] as const) {
      db.run(
        `INSERT INTO run_resume_bindings (
           run_id, schema_version, baseline_jcs, context_hash, workspace_snapshot_version,
           workspace_snapshot_hash, resume_binding_hash, original_session_id, created_at
         ) VALUES ($runId, 1, '{}', $hash, 1, $hash, $hash, $sessionId, '2026-10-11T00:00:00.000Z')`,
        { runId, hash: bindingHash, sessionId },
      );
    }
    expect(() => db!.run(
      `UPDATE OR REPLACE run_resume_bindings SET run_id='generation-run-1'
       WHERE run_id='generation-run-0'`,
    )).toThrow(/Resume binding Run identity is immutable/);
    expect(db.all<Row>("SELECT run_id, original_session_id FROM run_resume_bindings ORDER BY run_id")).toEqual([
      { run_id: "generation-run-0", original_session_id: null },
      { run_id: "generation-run-1", original_session_id: "original-session" },
    ]);
    expect(() => db!.run("UPDATE run_resume_bindings SET context_hash=$hash WHERE run_id='generation-run-0'", { hash: "b".repeat(64) }))
      .toThrow(/Resume context baseline is immutable/);
    expect(() => db!.run("UPDATE run_resume_bindings SET workspace_snapshot_hash=$hash WHERE run_id='generation-run-0'", { hash: "b".repeat(64) }))
      .toThrow(/Initial workspace snapshot binding is immutable/);
    for (const suffix of ["initial", "late", "partial"]) {
      const runId = `pending-integration-${suffix}`;
      insertRun(db, runId, "migration-task", "migration-epic", "integration");
      db.run("UPDATE agent_runs SET status='STARTED' WHERE id=$runId", { runId });
      db.transaction((tx) => insertRunProcessOwnerTx(tx, prepareRunProcessOwner(runId, "C:\\shared\\hermes", "windows-job")));
      db.run(`INSERT INTO run_resume_bindings(run_id,schema_version,baseline_jcs,context_hash,workspace_snapshot_version,
        workspace_snapshot_bound,workspace_snapshot_hash,resume_binding_hash,created_at)
        VALUES($runId,1,'{}',$hash,1,0,NULL,NULL,'2026-10-11T00:00:00.000Z')`, { runId, hash: bindingHash });
    }
    expect(() => db!.run(`UPDATE run_resume_bindings SET workspace_snapshot_bound=1,workspace_snapshot_hash=$hash
      WHERE run_id='pending-integration-partial'`, { hash: bindingHash })).toThrow(/CHECK/);
    expect(db.get("SELECT workspace_snapshot_bound,workspace_snapshot_hash,resume_binding_hash FROM run_resume_bindings WHERE run_id='pending-integration-partial'"))
      .toEqual({ workspace_snapshot_bound: 0, workspace_snapshot_hash: null, resume_binding_hash: null });
    db.run(`UPDATE run_resume_bindings SET workspace_snapshot_bound=1,workspace_snapshot_hash=$hash,resume_binding_hash=$hash
      WHERE run_id='pending-integration-initial'`, { hash: bindingHash });
    expect(() => db!.run(`UPDATE run_resume_bindings SET workspace_snapshot_bound=0,workspace_snapshot_hash=NULL,resume_binding_hash=NULL
      WHERE run_id='pending-integration-initial'`)).toThrow(/Initial workspace snapshot binding is immutable/);
    expect(() => db!.run(`UPDATE OR REPLACE run_resume_bindings SET workspace_snapshot_hash=$hash
      WHERE run_id='pending-integration-initial'`, { hash: "b".repeat(64) })).toThrow(/Initial workspace snapshot binding is immutable/);
    for (const state of ["LAUNCHING", "STOPPED"]) {
      db.run("UPDATE run_process_owners SET state=$state WHERE run_id='pending-integration-late'", { state });
      expect(() => db!.run(`UPDATE run_resume_bindings SET workspace_snapshot_bound=1,workspace_snapshot_hash=$hash,resume_binding_hash=$hash
        WHERE run_id='pending-integration-late'`, { hash: bindingHash })).toThrow(/no longer prepared/);
    }
    db.run("UPDATE run_process_owners SET state='PREPARED' WHERE run_id='pending-integration-late'");
    db.run("UPDATE agent_runs SET attempt=1 WHERE id='pending-integration-late'");
    expect(() => db!.run(`UPDATE run_resume_bindings SET workspace_snapshot_bound=1,workspace_snapshot_hash=$hash,resume_binding_hash=$hash
      WHERE run_id='pending-integration-late'`, { hash: bindingHash })).toThrow(/no longer prepared/);
    for (const suffix of ["initial", "late", "partial"]) db.run("DELETE FROM agent_runs WHERE id=$runId", { runId: `pending-integration-${suffix}` });
    expect(deltaStorage(db)).toEqual(deltaBefore);
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
    const original = db.get<Row>("SELECT * FROM run_process_owner_generations WHERE run_id='generation-run-0'")!;
    expect(() => db!.run(
      `INSERT INTO run_process_owner_generations(${generationColumns.join(",")})
       SELECT ${generationColumns.map((column) => column === "generation" ? "2" : column).join(",")}
       FROM run_process_owner_generations WHERE run_id='generation-run-0'`,
    )).toThrow(/UNIQUE/);
    expect(db.get<Row>("SELECT * FROM run_process_owner_generations WHERE run_id='generation-run-0'")).toEqual(original);
    db.close();
    db = createSqliteDatabase(dbPath);
    expect(runMigrations(db, migrationsThrough042).applied).toBe(0);
    expect(db.all("SELECT * FROM run_process_owner_generations ORDER BY run_id")).toEqual(expected);
    expect(deltaStorage(db)).toEqual(deltaBefore);
    db.run("DELETE FROM agent_runs WHERE id='generation-run-4'");
    expect(db.get("SELECT * FROM run_process_owner_generations WHERE run_id='generation-run-4'")).toBeUndefined();
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("rolls back the new generation copy, owner pointer and resume schema together when recovery migration fails", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ebb-run-recovery-rollback-"));
    dbPath = join(tmpDir, "rollback.sqlite");
    db = createSqliteDatabase(dbPath);
    const migrations = loadTestMigrations();
    const previous = migrations.filter(({ version }) => version <= 41);
    runMigrations(db, previous.filter(({ version }) => version <= 36));
    seedLegacyRows(db);
    runMigrations(db, previous);
    insertRawOwner(db, prepareRunProcessOwner("legacy-run-a", "C:\\shared\\hermes", "windows-job"));
    const ownersBefore = db.all("SELECT * FROM run_process_owners");
    const ownerSqlBefore = tableSql(db, "run_process_owners");
    const deltaBefore = deltaStorage(db);
    const migration = migrations.find(({ version }) => version === 42);
    expect(migration?.name).toBe("042_durable_run_recovery");
    const failing: Migration = { ...migration!, sql: `${migration!.sql}\nSELECT intentionally_invalid_recovery_migration_sql;` };
    expect(() => runMigrations(db!, [...previous, failing])).toThrow(/intentionally_invalid/);
    expect(db.all("SELECT * FROM run_process_owners")).toEqual(ownersBefore);
    expect(tableSql(db, "run_process_owners")).toBe(ownerSqlBefore);
    expect(deltaStorage(db)).toEqual(deltaBefore);
    expect(db.all("SELECT name FROM sqlite_master WHERE name IN ('run_process_owner_generations','run_resume_bindings')")).toEqual([]);
    expect(db.get("SELECT version FROM schema_migrations WHERE version=42")).toBeUndefined();
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
    expect(runMigrations(db, migrations.filter(({ version }) => version <= 42)).applied).toBe(1);
  });

  it("adds process-owner cgroup identity without rebuilding or changing ContextDelta storage", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ebb-process-owner-migration-"));
    dbPath = join(tmpDir, `migration-${randomUUID()}.sqlite`);
    db = createSqliteDatabase(dbPath);
    const migrations = loadTestMigrations();
    runMigrations(db, migrations.filter((migration) => migration.version <= 36));
    seedLegacyRows(db);
    runMigrations(db, migrations.filter((migration) => migration.version <= 37));
    const deltas = db.all<Row>("SELECT * FROM context_deltas ORDER BY id");
    const columns = tableColumns(db, "context_deltas");
    const deltaIndexes = indexes(db, "context_deltas");
    const deltaRootPage = rootPage(db, "context_deltas");
    const deltaForeignKeys = foreignKeys(db, "context_deltas").map(({ table, from, to, on_delete }) => ({ table, from, to, on_delete }));

    const migration038 = migrations.find((migration) => migration.version === 38);
    expect(migration038?.name).toBe("038_run_process_owner_cgroup");
    expect(runMigrations(db, migrations.filter((migration) => migration.version <= 39)).applied).toBe(2);

    expect(tableColumns(db, "run_process_owners").map((column) => column.name)).toContain("systemd_control_group");
    expect(db.all<Row>("SELECT * FROM context_deltas ORDER BY id")).toEqual(deltas);
    expect(tableColumns(db, "context_deltas")).toEqual(columns);
    expect(indexes(db, "context_deltas")).toEqual(deltaIndexes);
    expect(rootPage(db, "context_deltas")).toBe(deltaRootPage);
    expect(foreignKeys(db, "context_deltas").map(({ table, from, to, on_delete }) => ({ table, from, to, on_delete })))
      .toEqual(deltaForeignKeys);
    expect(deltaForeignKeys).toEqual([
      { table: "context_manifests_legacy_v1", from: "previous_manifest_id", to: "id", on_delete: "SET NULL" },
      { table: "context_manifests_legacy_v1", from: "manifest_id", to: "id", on_delete: "CASCADE" },
    ]);

    db.run("DELETE FROM context_manifests_legacy_v1 WHERE id = $id", { id: "legacy-manifest-a" });
    expect(db.get<{ previous_manifest_id: string | null }>(
      "SELECT previous_manifest_id FROM context_deltas WHERE id='legacy-delta-b'",
    )?.previous_manifest_id).toBeNull();
    expect(db.get("SELECT id FROM context_deltas WHERE id='legacy-delta-a'")).toBeUndefined();
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("rolls back a failed v2 rename and table creation as one migration transaction", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ebb-context-manifest-rollback-"));
    dbPath = join(tmpDir, `rollback-${randomUUID()}.sqlite`);
    db = createSqliteDatabase(dbPath);
    const migrations = loadTestMigrations();
    runMigrations(db, migrations.filter((migration) => migration.version <= 36));
    seedLegacyRows(db);
    const manifestRows = db.all<Row>("SELECT * FROM context_manifests ORDER BY id");
    const deltaRows = db.all<Row>("SELECT * FROM context_deltas ORDER BY id");
    const migration037 = migrations.find((migration) => migration.version === 37);
    expect(migration037).toBeDefined();
    const failingMigration: Migration = {
      ...migration037!,
      sql: `${migration037!.sql}\nSELECT intentionally_invalid_context_manifest_migration_sql;`,
    };

    expect(() => runMigrations(db!, [...migrations.filter((migration) => migration.version <= 36), failingMigration])).toThrow();
    expect(db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'context_manifests_legacy_v1'")).toBeUndefined();
    expect(db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'run_process_owners'")).toBeUndefined();
    expect(db.all<Row>("SELECT * FROM context_manifests ORDER BY id")).toEqual(manifestRows);
    expect(db.all<Row>("SELECT * FROM context_deltas ORDER BY id")).toEqual(deltaRows);
    expect(foreignKeys(db, "context_deltas").every(({ table }) => table === "context_manifests")).toBe(true);
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 37")?.count).toBe(0);
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("stores all manifest roles and subjects, keeps unknown history unavailable, and enforces owner constraints", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ebb-context-manifest-v2-constraints-"));
    dbPath = join(tmpDir, `constraints-${randomUUID()}.sqlite`);
    db = createSqliteDatabase(dbPath);
    const migrations = loadTestMigrations();
    runMigrations(db, migrations.filter((migration) => migration.version <= 36));
    seedLegacyRows(db);
    runMigrations(db, migrations);
    seedNewSubjectRuns(db);

    const roles: ContextManifestRoleV1[] = [
      "coordinator", "product_manager", "architect", "developer", "reviewer", "qa", "integration",
    ];
    for (const [index, role] of roles.entries()) {
      const runId = `task-role-run-${index}`;
      insertRun(db, runId, "migration-task", "migration-epic", role);
      const prepared = preparedContext({ type: "TASK", id: "migration-task" }, role);
      db.transaction((tx) => insertContextManifestTx(tx, prepared, runId));
      const result = getContextManifest(db, runId);
      expect(result.availability).toBe("available");
      if (result.availability === "available") {
        expect(result.manifest.subject).toEqual({ type: "TASK", id: "migration-task" });
        expect(result.manifest.role).toBe(role);
        expect(result.manifest.items).toEqual([{ id: "guideline-1", version: 3, digest: "a".repeat(64) }]);
      }
    }

    insertRun(db, "epic-review-run", null, "migration-epic", "reviewer");
    db.transaction((tx) => insertContextManifestTx(
      tx,
      preparedContext({ type: "EPIC", id: "migration-epic" }, "reviewer"),
      "epic-review-run",
    ));

    insertRun(db, "request-coordinator-run", null, null, "coordinator");
    insertRun(db, "request-pm-run", null, null, "product_manager");
    db.run(
      `INSERT INTO planning_requests(id,project_id,request,requested_by,created_at,coordinator_run_id)
       VALUES('migration-request','migration-project','request body','local-user','2026-09-30T12:34:56.789Z','request-coordinator-run')`,
    );
    db.run(
      `INSERT INTO planning_request_role_runs(request_id,role,run_id,created_at)
       VALUES('migration-request','product_manager','request-pm-run','2026-09-30T12:34:56.789Z')`,
    );
    db.transaction((tx) => {
      insertContextManifestTx(tx, preparedContext({ type: "REQUEST", id: "migration-request" }, "coordinator"), "request-coordinator-run");
      insertContextManifestTx(tx, preparedContext({ type: "REQUEST", id: "migration-request" }, "product_manager"), "request-pm-run");
    });
    expect(getContextManifest(db, "epic-review-run").availability).toBe("available");
    expect(getContextManifest(db, "request-coordinator-run").availability).toBe("available");
    expect(getContextManifest(db, "request-pm-run").availability).toBe("available");

    insertRun(db, "unlinked-request-run", null, null, "coordinator");
    expect(() => insertRawManifest(db!, {
      id: "unlinked-request-manifest", runId: "unlinked-request-run", subjectType: "REQUEST",
      taskId: null, epicId: null, requestId: "migration-request", role: "coordinator",
    })).toThrow(/request does not match Run/i);
    insertRun(db, "wrong-epic-run", null, "other-epic", "reviewer");
    expect(() => insertRawManifest(db!, {
      id: "wrong-epic-manifest", runId: "wrong-epic-run", subjectType: "EPIC",
      taskId: null, epicId: "migration-epic", requestId: null, role: "reviewer",
    })).toThrow(/epic does not match Run/i);

    const legacy = getContextManifest(db, "legacy-run-a");
    expect(legacy).toEqual({ availability: "unavailable", reason: "LEGACY_PROVENANCE_UNAVAILABLE" });
    const knownEmptyRun = "known-empty-run";
    insertRun(db, knownEmptyRun, "migration-task", "migration-epic", "qa");
    const knownEmpty = preparedContext({ type: "TASK", id: "migration-task" }, "qa", []);
    db.transaction((tx) => insertContextManifestTx(tx, knownEmpty, knownEmptyRun));
    const availableEmpty = getContextManifest(db, knownEmptyRun);
    expect(availableEmpty.availability).toBe("available");
    if (availableEmpty.availability === "available") expect(availableEmpty.manifest.items).toEqual([]);

    expect(() => db!.transaction((tx) => insertContextManifestTx(tx, knownEmpty, knownEmptyRun))).toThrow(/UNIQUE|unique/i);
    insertRun(db, "invalid-role-run", "migration-task", "migration-epic", "developer");
    expect(() => insertRawManifest(db!, {
      id: "invalid-role-manifest", runId: "invalid-role-run", subjectType: "TASK",
      taskId: "migration-task", epicId: null, requestId: null, role: "intern",
    })).toThrow(/CHECK constraint failed/i);

    const rawRunId = "raw-constraint-run";
    insertRun(db, rawRunId, "migration-task", "migration-epic", "developer");
    expect(() => insertRawManifest(db!, {
      id: "mismatched-subject", runId: rawRunId, subjectType: "TASK", taskId: "other-task", epicId: null, requestId: null, role: "developer",
    })).toThrow(/does not match Run/i);
    // Isolate the table CHECK from the stronger insert trigger for these two cardinality probes.
    db.exec("DROP TRIGGER context_manifests_subject_matches_run_insert");
    expect(() => insertRawManifest(db!, {
      id: "zero-subjects", runId: rawRunId, subjectType: "TASK", taskId: null, epicId: null, requestId: null, role: "developer",
    })).toThrow(/CHECK constraint failed/i);
    expect(() => insertRawManifest(db!, {
      id: "multiple-subjects", runId: rawRunId, subjectType: "TASK", taskId: "migration-task", epicId: "migration-epic", requestId: null, role: "developer",
    })).toThrow(/CHECK constraint failed/i);
    expect(() => insertRawManifest(db!, {
      id: "missing-run-fk", runId: "no-such-run", subjectType: "TASK", taskId: "migration-task", epicId: null, requestId: null, role: "developer",
    })).toThrow(/FOREIGN KEY constraint failed/i);
    insertRun(db, "missing-subject-run", "no-such-task", null, "developer");
    expect(() => insertRawManifest(db!, {
      id: "missing-subject-fk", runId: "missing-subject-run", subjectType: "TASK", taskId: "no-such-task", epicId: null, requestId: null, role: "developer",
    })).toThrow(/FOREIGN KEY constraint failed/i);

    const ownerRun = "owner-run";
    insertRun(db, ownerRun, "migration-task", "migration-epic", "developer");
    const owner = prepareRunProcessOwner(ownerRun, "C:\\ebb\\runtime\\hermes\\owner-run", "windows-job");
    const secondOwner = prepareRunProcessOwner("owner-run-2", "C:\\ebb\\runtime\\hermes\\owner-run-2", "systemd-user-service");
    insertRun(db, "owner-run-2", "migration-task", "migration-epic", "developer");
    expect(owner.sourceTag).toBe(`ebb-run:${ownerRun}`);
    expect(owner.containmentId).toMatch(/^[a-f0-9]{64}$/);
    expect(owner.launchNonce).toMatch(/^[a-f0-9]{64}$/);
    expect(owner.containmentId).not.toBe(secondOwner.containmentId);
    expect(owner.launchNonce).not.toBe(secondOwner.launchNonce);
    db.transaction((tx) => insertRunProcessOwnerTx(tx, owner));
    expect(db.get<{ run_id: string; source_tag: string; containment_kind: string; state: string }>(
      "SELECT run_id,source_tag,containment_kind,state FROM run_process_owners WHERE run_id=$runId",
      { runId: ownerRun },
    )).toEqual({ run_id: ownerRun, source_tag: `ebb-run:${ownerRun}`, containment_kind: "windows-job", state: "PREPARED" });
    const ownerDetails = db.get<{ systemd_invocation_id: string | null; supervisor_pid: number | null; supervisor_start_identity: string | null; pid: number | null; platform: string | null; process_start_identity: string | null; executable_identity: string | null; stop_evidence: string | null }>(
      "SELECT systemd_invocation_id,supervisor_pid,supervisor_start_identity,pid,platform,process_start_identity,executable_identity,stop_evidence FROM run_process_owners WHERE run_id=$runId",
      { runId: ownerRun },
    );
    expect(ownerDetails).toEqual({
      systemd_invocation_id: null,
      supervisor_pid: null,
      supervisor_start_identity: null,
      pid: null,
      platform: null,
      process_start_identity: null,
      executable_identity: null,
      stop_evidence: null,
    });
    expect(() => db!.transaction((tx) => insertRunProcessOwnerTx(tx, {
      ...secondOwner,
      containmentId: owner.containmentId,
    }))).toThrow(/UNIQUE|unique/i);
    expect(() => db!.transaction((tx) => insertRunProcessOwnerTx(tx, {
      ...secondOwner,
      launchNonce: owner.launchNonce,
    }))).toThrow(/UNIQUE|unique/i);
    expect(() => db!.transaction((tx) => insertRunProcessOwnerTx(
      tx,
      prepareRunProcessOwner(ownerRun, "C:\\ebb\\runtime\\hermes\\duplicate", "windows-job"),
    ))).toThrow(/UNIQUE|unique/i);
    insertRunProcessOwnerTx(db!, { ...secondOwner, hermesHome: owner.hermesHome });
    expect(db!.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM run_process_owners WHERE hermes_home=$hermesHome",
      { hermesHome: owner.hermesHome },
    )).toEqual({ count: 2 });
    expect(() => insertRawOwner(db!, { ...owner, sourceTag: "not-the-deterministic-tag" })).toThrow(/CHECK constraint failed/i);
    expect(() => insertRawOwner(db!, { ...secondOwner, containmentId: "predictable" })).toThrow(/CHECK constraint failed/i);
    expect(() => insertRawOwner(db!, { ...secondOwner, pid: 123 })).toThrow(/CHECK constraint failed/i);
    expect(() => insertRawOwner(db!, { ...secondOwner, state: "RUNNING" })).toThrow(/CHECK constraint failed/i);
    expect(() => insertRawOwner(db!, { ...secondOwner, containmentKind: "process-group" })).toThrow(/CHECK constraint failed/i);
    expect(() => insertRawOwner(db!, {
      ...secondOwner,
      runId: "missing-owner-run",
      sourceTag: "ebb-run:missing-owner-run",
      containmentId: "e".repeat(64),
      launchNonce: "f".repeat(64),
    })).toThrow(/FOREIGN KEY constraint failed/i);

    db.exec("PRAGMA ignore_check_constraints = ON");
    db.run("UPDATE context_manifests SET items_json='not-json' WHERE run_id=$runId", { runId: knownEmptyRun });
    db.exec("PRAGMA ignore_check_constraints = OFF");
    expect(getContextManifest(db, knownEmptyRun)).toEqual({ availability: "unavailable", reason: "INVALID_PERSISTED_PROVENANCE" });
  });
});

function seedLegacyRows(database: Database): void {
  seedMigrationBase(database);
  const createdAt = "2026-09-30T12:34:56.789Z";
  database.run(
    `INSERT INTO context_manifests(
      id,run_id,task_id,role,task_contract_version,guideline_ids,decision_ids,finding_ids,defect_ids,context_builder_version,initial_token_size,created_at
    ) VALUES
      ('legacy-manifest-a','legacy-run-a','migration-task','developer','known-contract-v2','["guide-1", "guide-2"]','["decision-1"]','["finding-1", "finding-2"]','["defect-1"]','builder-1',41,'${createdAt}'),
      ('legacy-manifest-b','legacy-run-a','migration-task','reviewer','legacy-unknown','[]','["decision-legacy"]','[]','[]','builder-legacy',NULL,'${createdAt}'),
      ('legacy-manifest-c','legacy-run-b','migration-task','qa','known-contract-v3','["guide-3"]','[]','["finding-3"]','["defect-3"]','builder-3',0,'${createdAt}')`,
  );
  database.run(
    `INSERT INTO context_deltas(
      id,manifest_id,previous_manifest_id,added_ids,updated_ids,removed_ids,resume_safe,resume_reason,created_at
    ) VALUES
      ('legacy-delta-a','legacy-manifest-a',NULL,'["add-a"]','["update-a"]','["remove-a"]',1,NULL,'${createdAt}'),
      ('legacy-delta-b','legacy-manifest-b','legacy-manifest-a','[]','["update-b"]','[]',0,'historical diagnostic only','${createdAt}'),
      ('legacy-delta-c','legacy-manifest-c','legacy-manifest-b','["add-c"]','[]','["remove-c"]',1,'safe diagnostic','${createdAt}')`,
  );
}

function seedMigrationBase(database: Database): void {
  const createdAt = "2026-09-30T12:34:56.789Z";
  database.run(
    "INSERT INTO projects(id,name,display_name,created_at,updated_at) VALUES('migration-project','migration','Migration',$createdAt,$createdAt)",
    { createdAt },
  );
  database.run(
    "INSERT INTO epics(id,project_id,display_id,title,contract_json,created_at,updated_at) VALUES('migration-epic','migration-project','E-1','Epic','{}',$createdAt,$createdAt)",
    { createdAt },
  );
  database.run(
    "INSERT INTO tasks(id,project_id,epic_id,display_id,title,contract_json,created_at,updated_at) VALUES('migration-task','migration-project','migration-epic','T-1','Task','{}',$createdAt,$createdAt)",
    { createdAt },
  );
  for (const id of ["legacy-run-a", "legacy-run-b"]) {
    database.run(
      "INSERT INTO agent_runs(id,role,runtime,model,task_id,epic_id,status,started_at) VALUES($id,'developer','hermes','test-model','migration-task','migration-epic','IN_PROGRESS',$createdAt)",
      { id, createdAt },
    );
  }
}

function seedNewSubjectRuns(database: Database): void {
  database.run(
    `INSERT INTO epics(id,project_id,display_id,title,contract_json,created_at,updated_at)
     VALUES('other-epic','migration-project','E-2','Other epic','{}','2026-09-30T12:34:56.789Z','2026-09-30T12:34:56.789Z')`,
  );
  database.run(
    `INSERT INTO tasks(id,project_id,epic_id,display_id,title,contract_json,created_at,updated_at)
     VALUES('other-task','migration-project','migration-epic','T-2','Other task','{}','2026-09-30T12:34:56.789Z','2026-09-30T12:34:56.789Z')`,
  );
}

function insertRun(database: Database, runId: string, taskId: string | null, epicId: string | null, role: string): void {
  database.run(
    "INSERT INTO agent_runs(id,role,runtime,model,task_id,epic_id,status,started_at) VALUES($runId,$role,'hermes','test-model',$taskId,$epicId,'IN_PROGRESS','2026-09-30T12:34:56.789Z')",
    { runId, role, taskId, epicId },
  );
}

function preparedContext(
  subject: PreparedRunContext["subject"],
  role: ContextManifestRoleV1,
  items: PreparedRunContext["items"] = [{ id: "guideline-1", version: 3, digest: "a".repeat(64) }],
): PreparedRunContext {
  const finalPrompt = `prompt for ${subject.type}:${subject.id}:${role}`;
  return {
    finalPrompt,
    subject,
    role,
    contractDigest: "b".repeat(64),
    items,
    contextBuilderVersion: "context-builder-v2",
    promptHash: digestRunPromptBytesV1(new TextEncoder().encode(finalPrompt)),
    contextHash: "c".repeat(64),
    initialTokenSize: null,
    workspaceFingerprint: "d".repeat(64),
  };
}

function insertRawManifest(
  database: Database,
  input: { id: string; runId: string; subjectType: "TASK" | "EPIC" | "REQUEST"; taskId: string | null; epicId: string | null; requestId: string | null; role: string },
): void {
  database.run(
    `INSERT INTO context_manifests(
      id,run_id,subject_type,task_id,epic_id,request_id,role,contract_request_digest,items_json,
      prompt_hash,context_hash,context_builder_version,initial_token_size,created_at
    ) VALUES($id,$runId,$subjectType,$taskId,$epicId,$requestId,$role,NULL,'[]',$promptHash,$contextHash,'v1',NULL,'2026-09-30T12:34:56.789Z')`,
    {
      id: input.id,
      runId: input.runId,
      subjectType: input.subjectType,
      taskId: input.taskId,
      epicId: input.epicId,
      requestId: input.requestId,
      role: input.role,
      promptHash: "e".repeat(64),
      contextHash: "f".repeat(64),
    },
  );
}

function insertRawOwner(
  database: Database,
  owner: Omit<RunProcessOwner, "containmentKind" | "state"> & { containmentKind: string; state: string },
): void {
  database.run(
    `INSERT INTO run_process_owners(
      run_id,source_tag,hermes_home,containment_kind,containment_id,launch_nonce,
      systemd_invocation_id,supervisor_pid,supervisor_start_identity,pid,platform,
      process_start_identity,executable_identity,state,stop_evidence,updated_at
    ) VALUES($runId,$sourceTag,$hermesHome,$containmentKind,$containmentId,$launchNonce,
      $systemdInvocationId,$supervisorPid,$supervisorStartIdentity,$pid,$platform,
      $processStartIdentity,$executableIdentity,$state,$stopEvidence,$updatedAt)`,
    {
      runId: owner.runId,
      sourceTag: owner.sourceTag,
      hermesHome: owner.hermesHome,
      containmentKind: owner.containmentKind,
      containmentId: owner.containmentId,
      launchNonce: owner.launchNonce,
      systemdInvocationId: owner.systemdInvocationId,
      supervisorPid: owner.supervisorPid,
      supervisorStartIdentity: owner.supervisorStartIdentity,
      pid: owner.pid,
      platform: owner.platform,
      processStartIdentity: owner.processStartIdentity,
      executableIdentity: owner.executableIdentity,
      state: owner.state,
      stopEvidence: owner.stopEvidence,
      updatedAt: owner.updatedAt,
    },
  );
}

function tableColumns(database: Database, table: string): Row[] {
  return database.all<Row>(`PRAGMA table_info("${table}")`).map(({ name, type, notnull, dflt_value, pk }) => ({
    name: name as string,
    type: type as string,
    notnull: notnull as number,
    dflt_value: dflt_value as string | null,
    pk: pk as number,
  }));
}

function deltaStorage(database: Database): unknown {
  return {
    rows: database.all("SELECT * FROM context_deltas ORDER BY id"), bytes: storedBytes(database, "context_deltas"),
    columns: tableColumns(database, "context_deltas"), indexes: indexes(database, "context_deltas"),
    sql: tableSql(database, "context_deltas"), rootPage: rootPage(database, "context_deltas"),
    foreignKeys: foreignKeys(database, "context_deltas"),
  };
}

function storedBytes(database: Database, table: string): Row[] {
  const expressions = tableColumns(database, table).flatMap(({ name }) => [
    `typeof("${name}") AS "${name}_type"`,
    `hex(CAST("${name}" AS BLOB)) AS "${name}_bytes"`,
  ]);
  return database.all<Row>(`SELECT ${expressions.join(",")} FROM "${table}" ORDER BY id`);
}

function indexes(database: Database, table: string): Array<{
  name: string;
  unique: number;
  origin: string;
  partial: number;
  sql: string | null;
  columns: Array<{ column: string | null; desc: number; coll: string }>;
}> {
  return database.all<{ name: string; unique: number; origin: string; partial: number }>(`PRAGMA index_list("${table}")`)
    .map(({ name, unique, origin, partial }) => {
      const sql = database.get<{ sql: string | null }>(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name=$name",
        { name },
      )?.sql ?? null;
      const columns = database.all<{ name: string | null; desc: number; coll: string; key: number }>(
        `PRAGMA index_xinfo("${name}")`,
      ).filter(({ key }) => key === 1).map(({ name: column, desc, coll }) => ({ column, desc, coll }));
      return {
        name: origin === "c" ? name : `sqlite-${origin}-index`,
        unique,
        origin,
        partial,
        sql: sql?.replace(/ON (?:"[^"]+"|[a-z_][a-z0-9_]*)\(/i, "ON <table>(") ?? null,
        columns,
      };
    })
    .sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

function foreignKeys(database: Database, table: string): Array<{
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
  match: string;
}> {
  return database.all(`PRAGMA foreign_key_list("${table}")`);
}

function rootPage(database: Database, table: string): number {
  return database.get<{ rootpage: number }>("SELECT rootpage FROM sqlite_master WHERE type='table' AND name=$table", { table })!.rootpage;
}

function tableSql(database: Database, table: string): string {
  return database.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type='table' AND name=$table", { table })!.sql;
}

function normalizedOwnerTableSql(table: string, sql: string): string {
  return sql
    .replace(new RegExp(`^CREATE TABLE "?${table}"?`, "u"), `CREATE TABLE ${table}`)
    .replace(", 'darwin-process-group'", "");
}
