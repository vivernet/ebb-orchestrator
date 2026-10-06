import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import type { Database } from "../../../src/platform/database/database.js";
import { runMigrations } from "../../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../../helpers/migrations.js";

describe("fresh-install migration acceptance", () => {
  let db: Database | undefined;
  let tmpDir: string;

  afterEach(async () => {
    db?.close();
    db = undefined;
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it("applies migrations 001-040 with UNBOUND capture state and a nullable exact source key", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ebb-fresh-install-migrations-"));
    db = createSqliteDatabase(join(tmpDir, `fresh-${randomUUID()}.sqlite`));
    const migrations = loadTestMigrations();
    const expectedVersions = Array.from({ length: 40 }, (_, index) => index + 1);

    expect(migrations.map(({ version }) => version)).toEqual(expectedVersions);
    expect(migrations.at(-2)?.name).toBe("039_run_session_capture_state");
    expect(migrations.at(-1)?.name).toBe("040_run_hermes_source_snapshot");
    expect(runMigrations(db, migrations).applied).toBe(40);
    expect(db.all<{ version: number; name: string }>(
      "SELECT version, name FROM schema_migrations ORDER BY version",
    )).toEqual(migrations.map(({ version, name }) => ({ version, name })));

    const captureStateColumn = db.all<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>("PRAGMA table_info(run_process_owners)").find(({ name }) => name === "capture_state");
    expect(captureStateColumn).toMatchObject({
      name: "capture_state",
      type: "TEXT",
      notnull: 1,
      dflt_value: "'UNBOUND'",
    });
    expect(db.all("PRAGMA table_info(run_process_owners)")).toContainEqual(expect.objectContaining({
      name: "hermes_source_snapshot_key", type: "TEXT", notnull: 0, dflt_value: null,
    }));
    const ownerSchema = db.get<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='run_process_owners'",
    )?.sql;
    expect(ownerSchema).toMatch(
      /capture_state\s+TEXT\s+NOT NULL\s+DEFAULT 'UNBOUND'\s+CHECK\s*\(\s*capture_state IN\s*\('UNBOUND',\s*'BOUND',\s*'INVALID'\)\s*\)/,
    );

    db.run(
      "INSERT INTO agent_runs(id,role,runtime,model,status) VALUES('fresh-run','developer','hermes','test-model','STARTED')",
    );
    db.run(
      `INSERT INTO run_process_owners(
        run_id,source_tag,hermes_home,containment_kind,containment_id,launch_nonce,state,updated_at
      ) VALUES('fresh-run','ebb-run:fresh-run','C:\\fresh\\hermes','windows-job',$containmentId,$launchNonce,'PREPARED','2026-10-02T00:00:00.000Z')`,
      { containmentId: "a".repeat(64), launchNonce: "b".repeat(64) },
    );
    expect(db.get<{ capture_state: string }>(
      "SELECT capture_state FROM run_process_owners WHERE run_id='fresh-run'",
    )).toEqual({ capture_state: "UNBOUND" });
    expect(db.get("SELECT hermes_source_snapshot_key FROM run_process_owners WHERE run_id='fresh-run'"))
      .toEqual({ hermes_source_snapshot_key: null });
    const sourceKey = JSON.stringify({
      formatVersion: 1, hermesVersion: "fixture-version", manifestDigest: "a".repeat(64),
      sourceCommit: "b".repeat(40), sourceTree: "c".repeat(40),
    });
    db.run("UPDATE run_process_owners SET hermes_source_snapshot_key=$sourceKey WHERE run_id='fresh-run'", { sourceKey });
    expect(db.get("SELECT hermes_source_snapshot_key FROM run_process_owners WHERE run_id='fresh-run'"))
      .toEqual({ hermes_source_snapshot_key: sourceKey });
    expect(() => db!.run(
      "UPDATE run_process_owners SET capture_state='UNRECOGNIZED' WHERE run_id='fresh-run'",
    )).toThrow(/CHECK constraint failed/i);
    expect(db.get<{ capture_state: string }>(
      "SELECT capture_state FROM run_process_owners WHERE run_id='fresh-run'",
    )).toEqual({ capture_state: "UNBOUND" });
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
  });
});
