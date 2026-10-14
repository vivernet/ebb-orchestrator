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

  it("applies migrations 001-046 with durable scheduler RunRequests", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ebb-fresh-install-migrations-"));
    db = createSqliteDatabase(join(tmpDir, `fresh-${randomUUID()}.sqlite`));
    const migrations = loadTestMigrations();
    const expectedVersions = Array.from({ length: 46 }, (_, index) => index + 1);

    expect(migrations.map(({ version }) => version)).toEqual(expectedVersions);
    expect(migrations.at(-7)?.name).toBe("040_run_hermes_source_snapshot");
    expect(migrations.at(-6)?.name).toBe("041_shared_hermes_home");
    expect(migrations.at(-5)?.name).toBe("042_durable_run_recovery");
    expect(migrations.at(-4)?.name).toBe("043_scheduler_capacity_wait_started_at");
    expect(migrations.at(-3)?.name).toBe("044_scheduler_run_requests");
    expect(migrations.at(-2)?.name).toBe("045_run_completion_projections");
    expect(migrations.at(-1)?.name).toBe("046_scheduler_task_stage_requests");
    expect(runMigrations(db, migrations).applied).toBe(46);
    expect(db.all("PRAGMA table_info(tasks)")).toContainEqual(expect.objectContaining({ name: "capacity_wait_started_at", type: "TEXT", notnull: 0, dflt_value: null }));
    expect(db.all("SELECT * FROM run_process_owner_generations")).toEqual([]);
    expect(db.all("SELECT * FROM run_resume_bindings")).toEqual([]);
    expect(db.all("SELECT * FROM context_deltas")).toEqual([]);
    expect(db.get("SELECT COUNT(*) AS count FROM context_deltas")).toEqual({ count: 0 });
    expect(db.get("SELECT type,tbl_name,rootpage,sql FROM sqlite_master WHERE name='context_deltas'"))
      .toMatchObject({ type: "table", tbl_name: "context_deltas", rootpage: expect.any(Number),
        sql: expect.stringContaining("resume_safe INTEGER NOT NULL DEFAULT 1") });
    expect(db.all<{ table: string; from: string; on_delete: string }>("PRAGMA foreign_key_list(context_deltas)")
      .map(({ table, from, on_delete }) => ({ table, from, on_delete }))).toEqual([
      { table: "context_manifests_legacy_v1", from: "previous_manifest_id", on_delete: "SET NULL" },
      { table: "context_manifests_legacy_v1", from: "manifest_id", on_delete: "CASCADE" },
    ]);
    expect(db.get("SELECT sql FROM sqlite_master WHERE name='idx_context_deltas_manifest'"))
      .toEqual({ sql: "CREATE INDEX idx_context_deltas_manifest ON context_deltas(manifest_id)" });
    expect(db.all("PRAGMA index_info(idx_context_deltas_manifest)"))
      .toEqual([{ seqno: 0, cid: 1, name: "manifest_id" }]);
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
    db.run(`INSERT INTO run_process_owner_generations(
      run_id,generation,source_tag,hermes_home,containment_kind,containment_id,launch_nonce,state,updated_at
    ) VALUES('fresh-run',1,'ebb-run:fresh-run','C:\\fresh\\hermes','windows-job',$containmentId,$launchNonce,'PREPARED','2026-10-02T00:00:00.000Z')`,
    { containmentId: "a".repeat(64), launchNonce: "b".repeat(64) });
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
    expect(db.get("SELECT current_generation FROM run_process_owners WHERE run_id='fresh-run'"))
      .toEqual({ current_generation: 1 });
    expect(() => db!.run("UPDATE run_process_owners SET current_generation=0 WHERE run_id='fresh-run'"))
      .toThrow(/CHECK constraint failed|Current generation does not exist/i);
    const binding = {
      runId: "fresh-run", schemaVersion: 1, baseline: '{"promptHash":"fixture-digest"}',
      contextHash: "1".repeat(64), workspaceVersion: 1, workspaceHash: "2".repeat(64), bindingHash: "3".repeat(64),
    };
    const insertBinding = (values: typeof binding): void => {
      db!.run(`INSERT INTO run_resume_bindings(
        run_id,schema_version,baseline_jcs,context_hash,workspace_snapshot_version,workspace_snapshot_hash,resume_binding_hash,created_at
      ) VALUES($runId,$schemaVersion,$baseline,$contextHash,$workspaceVersion,$workspaceHash,$bindingHash,'2026-10-11T00:00:00.000Z')`, values);
    };
    for (const invalid of [
      { schemaVersion: 2 }, { workspaceVersion: 2 }, { contextHash: "invalid" }, { workspaceHash: "A".repeat(64) },
      { bindingHash: "z".repeat(64) }, { baseline: "[]" }, { baseline: "not-json" },
      { baseline: '{"workspaceIdentity":null}' }, { baseline: '{"workspaceIdentity":{"projectId":"forbidden"}}' },
    ]) {
      expect(() => insertBinding({ ...binding, ...invalid })).toThrow();
    }
    expect(() => insertBinding({ ...binding, runId: "missing-run" })).toThrow(/FOREIGN KEY constraint failed/i);
    insertBinding(binding);
    expect(db.get("SELECT baseline_jcs,context_hash,workspace_snapshot_hash,resume_binding_hash FROM run_resume_bindings"))
      .toEqual({ baseline_jcs: binding.baseline, context_hash: binding.contextHash,
        workspace_snapshot_hash: binding.workspaceHash, resume_binding_hash: binding.bindingHash });
    expect(() => insertBinding(binding)).toThrow(/UNIQUE|Resume binding is immutable/i);
    expect(db.get("SELECT original_session_id FROM run_resume_bindings")).toEqual({ original_session_id: null });
    for (const sessionId of ["", "white space", " leading", "trailing ", "invalid!", "é", "a".repeat(257)]) {
      expect(() => db!.run("UPDATE run_resume_bindings SET original_session_id=$sessionId WHERE run_id='fresh-run'", { sessionId }))
        .toThrow(/CHECK constraint failed/i);
    }
    db.run("UPDATE run_resume_bindings SET original_session_id='original-session' WHERE run_id='fresh-run' AND original_session_id IS NULL");
    expect(db.get("SELECT changes() AS changes")).toEqual({ changes: 1 });
    db.run("UPDATE run_resume_bindings SET original_session_id='other-session' WHERE run_id='fresh-run' AND original_session_id IS NULL");
    expect(db.get("SELECT changes() AS changes")).toEqual({ changes: 0 });
    expect(() => db!.run("UPDATE run_resume_bindings SET original_session_id='other-session' WHERE run_id='fresh-run'"))
      .toThrow(/Original session is immutable/);
    expect(() => db!.run("UPDATE run_resume_bindings SET original_session_id=NULL WHERE run_id='fresh-run'"))
      .toThrow(/Original session is immutable/);
    expect(db.get("SELECT original_session_id FROM run_resume_bindings")).toEqual({ original_session_id: "original-session" });
    db.exec("PRAGMA recursive_triggers=OFF");
    expect(() => db!.run(`INSERT OR REPLACE INTO run_resume_bindings(
      run_id,schema_version,baseline_jcs,context_hash,workspace_snapshot_version,workspace_snapshot_hash,resume_binding_hash,original_session_id,created_at
    ) SELECT run_id,schema_version,baseline_jcs,context_hash,workspace_snapshot_version,workspace_snapshot_hash,resume_binding_hash,'replacement-session',created_at
      FROM run_resume_bindings WHERE run_id='fresh-run'`)).toThrow(/Resume binding is immutable/);
    expect(db.get("SELECT original_session_id FROM run_resume_bindings")).toEqual({ original_session_id: "original-session" });
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

    db.run("INSERT INTO agent_runs(id,role,runtime,model,status) VALUES('fresh-run-2','reviewer','hermes','test-model','STARTED')");
    expect(() => db!.run(`INSERT INTO run_process_owners(
      run_id,source_tag,hermes_home,containment_kind,containment_id,launch_nonce,state,updated_at
    ) VALUES('fresh-run-2','ebb-run:fresh-run-2','C:\\fresh\\hermes','windows-job',$containmentId,$launchNonce,'PREPARED','fixture')`,
    { containmentId: "c".repeat(64), launchNonce: "d".repeat(64) })).toThrow(/Current generation does not exist/);
    db.run(`INSERT INTO run_process_owner_generations(
      run_id,generation,source_tag,hermes_home,containment_kind,containment_id,launch_nonce,state,updated_at
    ) VALUES('fresh-run-2',1,'ebb-run:fresh-run-2','C:\\fresh\\hermes','windows-job',$containmentId,$launchNonce,'PREPARED','2026-10-02T00:00:01.000Z')`,
    { containmentId: "c".repeat(64), launchNonce: "d".repeat(64) });
    db.run(
      `INSERT INTO run_process_owners(
        run_id,source_tag,hermes_home,containment_kind,containment_id,launch_nonce,state,updated_at
      ) VALUES('fresh-run-2','ebb-run:fresh-run-2','C:\\fresh\\hermes','windows-job',$containmentId,$launchNonce,'PREPARED','2026-10-02T00:00:01.000Z')`,
      { containmentId: "c".repeat(64), launchNonce: "d".repeat(64) },
    );
    expect(db.all<{ hermes_home: string }>(
      "SELECT hermes_home FROM run_process_owners ORDER BY run_id",
    )).toEqual([{ hermes_home: "C:\\fresh\\hermes" }, { hermes_home: "C:\\fresh\\hermes" }]);
    db.run("INSERT INTO projects(id,name,display_name,created_at,updated_at) VALUES('delta-project','delta-project','Delta','fixture','fixture')");
    db.run("INSERT INTO tasks(id,project_id,display_id,title,contract_json,created_at,updated_at) VALUES('delta-task','delta-project','T-1','Delta','{}','fixture','fixture')");
    db.run(`INSERT INTO context_manifests_legacy_v1(id,run_id,task_id,role,task_contract_version,created_at) VALUES
      ('fresh-legacy-a','fresh-run','delta-task','developer','historical','fixture'),
      ('fresh-legacy-b','fresh-run-2','delta-task','reviewer','historical','fixture')`);
    db.run(`INSERT INTO context_deltas(id,manifest_id,previous_manifest_id,resume_safe,resume_reason,created_at)
      VALUES('fresh-diagnostic','fresh-legacy-b','fresh-legacy-a',0,'historical diagnostic only','fixture')`);
    expect(db.all("SELECT * FROM context_deltas")).toEqual([{
      id: "fresh-diagnostic", manifest_id: "fresh-legacy-b", previous_manifest_id: "fresh-legacy-a",
      added_ids: "[]", updated_ids: "[]", removed_ids: "[]", resume_safe: 0,
      resume_reason: "historical diagnostic only", created_at: "fixture",
    }]);
    expect(db.all("SELECT * FROM context_manifests")).toEqual([]);
    db.run("DELETE FROM context_manifests_legacy_v1 WHERE id='fresh-legacy-a'");
    expect(db.get("SELECT previous_manifest_id,resume_safe,resume_reason FROM context_deltas"))
      .toEqual({ previous_manifest_id: null, resume_safe: 0, resume_reason: "historical diagnostic only" });
    db.run("DELETE FROM context_manifests_legacy_v1 WHERE id='fresh-legacy-b'");
    expect(db.all("SELECT * FROM context_deltas")).toEqual([]);
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
    db.run("DELETE FROM agent_runs WHERE id='fresh-run'");
    expect(db.all("SELECT * FROM run_resume_bindings")).toEqual([]);
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
  });
});
