import { afterEach, describe, expect, it } from "vitest";
import type { Database } from "../../../src/platform/database/database.js";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../../src/platform/database/migrator.js";
import { mayCollectHermesSourceSnapshot } from "../../../src/modules/runtime/hermes/hermes-source-snapshot-gc-policy.js";
import { insertRunProcessOwnerTx, prepareRunProcessOwner } from "../../../src/modules/runtime/run-process-owner.js";
import { loadTestMigrations } from "../../helpers/migrations.js";

const cacheKey = JSON.stringify({
  formatVersion: 1,
  hermesVersion: "v0.21.5+7357.g9244275",
  manifestDigest: "a".repeat(64),
  sourceCommit: "b".repeat(40),
  sourceTree: "c".repeat(40),
});

describe("Hermes snapshot GC reference policy", () => {
  let database: Database | undefined;
  afterEach(() => { database?.close(); database = undefined; });

  function setup(): Database {
    database = createSqliteDatabase(":memory:");
    runMigrations(database, loadTestMigrations());
    return database;
  }

  function insertRun(db: Database, runId: string, status: string, key: string | null, state: string, evidence: string | null): void {
    db.run(
      "INSERT INTO agent_runs(id,role,runtime,model,status,started_at) VALUES($id,'developer','hermes','test-model',$status,'2026-10-01T00:00:00.000Z')",
      { id: runId, status },
    );
    const owner = prepareRunProcessOwner(runId, `C:/runtime/${runId}`, "windows-job", key);
    db.transaction((tx) => insertRunProcessOwnerTx(tx, owner));
    db.run("UPDATE run_process_owners SET state=$state, stop_evidence=$evidence WHERE run_id=$runId", { runId, state, evidence });
  }

  it("retains candidate references unless Run is terminal and owner has canonical STOPPED proof", () => {
    const db = setup();
    const states: Array<[string, string, string | null]> = [
      ["STARTED", "STOPPED", "SUPERVISOR_SCOPE_EMPTY"],
      ["COMPLETED", "LIVE", null],
      ["COMPLETED", "STOPPING", null],
      ["COMPLETED", "UNKNOWN", "OS_STATE_UNPROVEN"],
      ["FAILED", "STOPPED", "not canonical!"],
    ];
    for (const [status, state, evidence] of states) {
      insertRun(db, `candidate-${status}-${state}-${evidence ?? "none"}`, status, cacheKey, state, evidence);
      expect(mayCollectHermesSourceSnapshot(db, cacheKey)).toBe(false);
      db.run("DELETE FROM run_process_owners");
      db.run("DELETE FROM agent_runs");
    }
  });

  it("allows collection after every exact reference is terminal with canonical STOPPED evidence", () => {
    const db = setup();
    insertRun(db, "completed-run", "COMPLETED", cacheKey, "STOPPED", "SUPERVISOR_SCOPE_EMPTY");
    insertRun(db, "failed-run", "FAILED", cacheKey, "STOPPED", "WINDOWS_JOB_EMPTY");
    expect(mayCollectHermesSourceSnapshot(db, cacheKey)).toBe(true);
  });

  it("does not guess a historical NULL key or assign that owner to this snapshot", () => {
    const db = setup();
    insertRun(db, "legacy-null-key", "COMPLETED", null, "STOPPED", "SUPERVISOR_SCOPE_EMPTY");
    expect(mayCollectHermesSourceSnapshot(db, cacheKey)).toBe(true);
    expect(db.get<{ hermes_source_snapshot_key: string | null }>(
      "SELECT hermes_source_snapshot_key FROM run_process_owners WHERE run_id='legacy-null-key'",
    )?.hermes_source_snapshot_key).toBeNull();
  });
});
