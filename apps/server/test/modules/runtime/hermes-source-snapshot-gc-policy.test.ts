import { afterEach, describe, expect, it } from "vitest";
import type { Database } from "../../../src/platform/database/database.js";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../../src/platform/database/migrator.js";
import { hasHermesSourceSnapshotReferences, mayCollectHermesSourceSnapshot } from "../../../src/modules/runtime/hermes/hermes-source-snapshot-gc-policy.js";
import { insertRunProcessOwnerTx, prepareRunProcessOwner } from "../../../src/modules/runtime/run-process-owner.js";
import { loadTestMigrations } from "../../helpers/migrations.js";

const cacheKey = JSON.stringify({
  formatVersion: 1,
  hermesVersion: "v0.21.5+9117.g08165d5",
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

  function insertRun(
    db: Database, runId: string, status: string, key: string | null, state: string, evidence: string | null,
    containmentKind: "windows-job" | "systemd-user-service" = "systemd-user-service",
  ): void {
    db.run(
      "INSERT INTO agent_runs(id,role,runtime,model,status,started_at) VALUES($id,'developer','hermes','test-model',$status,'2026-10-01T00:00:00.000Z')",
      { id: runId, status },
    );
    const owner = prepareRunProcessOwner(runId, `C:/runtime/${runId}`, containmentKind, key);
    db.transaction((tx) => insertRunProcessOwnerTx(tx, owner));
    db.run("UPDATE run_process_owners SET state=$state, stop_evidence=$evidence WHERE run_id=$runId", { runId, state, evidence });
  }

  it("retains candidate references unless Run is terminal and owner has canonical STOPPED proof", () => {
    const db = setup();
    const states: Array<[string, string, string | null]> = [
      ["STARTED", "STOPPED", "SYSTEMD_CGROUP_EMPTY"],
      ["COMPLETED", "LIVE", null],
      ["COMPLETED", "STOPPING", null],
      ["COMPLETED", "UNKNOWN", "OS_STATE_UNPROVEN"],
      ["FAILED", "STOPPED", "not canonical!"],
    ];
    for (const [status, state, evidence] of states) {
      insertRun(db, `candidate-${status}-${state}-${evidence ?? "none"}`, status, cacheKey, state, evidence);
      expect(mayCollectHermesSourceSnapshot(db, cacheKey)).toBe(false);
      expect(hasHermesSourceSnapshotReferences(db, cacheKey)).toBe(true);
      db.run("DELETE FROM run_process_owners");
      db.run("DELETE FROM agent_runs");
    }
  });

  it("allows collection after every exact reference is terminal with canonical STOPPED evidence", () => {
    const db = setup();
    insertRun(db, "completed-run", "COMPLETED", cacheKey, "STOPPED", "SYSTEMD_CGROUP_EMPTY");
    insertRun(db, "failed-run", "FAILED", cacheKey, "STOPPED", "SYSTEMD_CGROUP_EMPTY");
    insertRun(db, "linux-run", "CANCELLED", cacheKey, "STOPPED", "SYSTEMD_CGROUP_EMPTY", "systemd-user-service");
    expect(mayCollectHermesSourceSnapshot(db, cacheKey)).toBe(true);
    expect(hasHermesSourceSnapshotReferences(db, cacheKey)).toBe(true);
  });

  it("allows collection after historical NULL-key owners are terminal and durably stopped", () => {
    const db = setup();
    insertRun(db, "legacy-null-key", "COMPLETED", null, "STOPPED", "SYSTEMD_CGROUP_EMPTY");
    expect(mayCollectHermesSourceSnapshot(db, cacheKey)).toBe(true);
    expect(hasHermesSourceSnapshotReferences(db, cacheKey)).toBe(false);
    expect(db.get<{ hermes_source_snapshot_key: string | null }>(
      "SELECT hermes_source_snapshot_key FROM run_process_owners WHERE run_id='legacy-null-key'",
    )?.hermes_source_snapshot_key).toBeNull();
  });

  it.each([
    { runStatus: "STARTED", state: "STOPPED", evidence: "SYSTEMD_CGROUP_EMPTY" },
    { runStatus: "COMPLETED", state: "PREPARED", evidence: null },
    { runStatus: "COMPLETED", state: "LIVE", evidence: null },
    { runStatus: "COMPLETED", state: "STOPPED", evidence: null },
    { runStatus: "COMPLETED", state: "STOPPED", evidence: "OS_STATE_UNPROVEN" },
    { runStatus: "COMPLETED", state: "STOPPED", evidence: "UNKNOWN_STOP_PROOF" },
    { runStatus: "COMPLETED", state: "STOPPED", evidence: "SYSTEMD_CGROUP_EMPTY", containmentKind: "windows-job" as const },
    { runStatus: "FAILED", state: "STOPPED", evidence: "invalid evidence!" },
  ])("fails closed while a historical NULL-key owner lacks terminal STOPPED proof", ({ runStatus, state, evidence, containmentKind }) => {
    const db = setup();
    insertRun(db, "legacy-null-key", runStatus, null, state, evidence, containmentKind);
    expect(mayCollectHermesSourceSnapshot(db, cacheKey)).toBe(false);
    expect(hasHermesSourceSnapshotReferences(db, cacheKey)).toBe(false);
  });

  it("fails closed when an owner row has no Run row despite disabled SQLite foreign keys", () => {
    const db = setup();
    const owner = prepareRunProcessOwner("orphan-owner", "C:/runtime/orphan-owner", "systemd-user-service", cacheKey);
    db.exec("PRAGMA foreign_keys=OFF");
    db.transaction((tx) => insertRunProcessOwnerTx(tx, owner));
    db.exec("PRAGMA foreign_keys=ON");
    expect(db.get("SELECT id FROM agent_runs WHERE id='orphan-owner'")).toBeUndefined();
    expect(mayCollectHermesSourceSnapshot(db, cacheKey)).toBe(false);
  });

  it("accepts a real Windows STOPPED proof for a Windows v2 snapshot key", () => {
    const db = setup();
    const windowsKey = JSON.stringify({
      formatVersion: 1, hermesVersion: "v0.21.5+9117.g08165d5", manifestDigest: "a".repeat(64),
      materializationPolicyVersion: 2, sourceCommit: "b".repeat(40), sourceTree: "c".repeat(40),
    });
    insertRun(db, "windows-stopped-run", "COMPLETED", windowsKey, "STOPPED", "WINDOWS_JOB_EMPTY", "windows-job");
    expect(mayCollectHermesSourceSnapshot(db, windowsKey)).toBe(true);
  });

  it("accepts the typed launch-not-dispatched proof for downstream snapshot GC", () => {
    const db = setup();
    insertRun(db, "launch-not-dispatched-run", "COMPLETED", cacheKey, "STOPPED", "LAUNCH_NOT_DISPATCHED");
    expect(mayCollectHermesSourceSnapshot(db, cacheKey)).toBe(true);
  });
});
