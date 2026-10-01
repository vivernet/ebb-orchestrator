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

  it("preserves all historical manifests and deltas while moving both delta foreign keys in place", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ebb-context-manifest-migration-"));
    dbPath = join(tmpDir, `migration-${randomUUID()}.sqlite`);
    db = createSqliteDatabase(dbPath);
    const migrations = loadTestMigrations();
    const migration037 = migrations.find((migration) => migration.version === 37);
    expect(migration037?.name).toBe("037_context_manifest_v2");
    expect(migrations.map(({ version }) => version)).toEqual(
      Array.from({ length: 38 }, (_, index) => index + 1),
    );

    runMigrations(db, migrations.filter((migration) => migration.version <= 36));
    seedLegacyRows(db);
    const oldManifestRows = db.all<Row>("SELECT * FROM context_manifests ORDER BY id");
    const oldDeltaRows = db.all<Row>("SELECT * FROM context_deltas ORDER BY id");
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

    expect(runMigrations(db, migrations).applied).toBe(2);

    expect(db.all<Row>("SELECT * FROM context_manifests_legacy_v1 ORDER BY id")).toEqual(oldManifestRows);
    expect(db.all<Row>("SELECT * FROM context_deltas ORDER BY id")).toEqual(oldDeltaRows);
    expect(tableColumns(db, "context_manifests_legacy_v1")).toEqual(oldManifestColumns);
    expect(tableColumns(db, "context_deltas")).toEqual(oldDeltaColumns);
    expect(indexes(db, "context_manifests_legacy_v1")).toEqual(oldManifestIndexes);
    expect(indexes(db, "context_deltas")).toEqual(oldDeltaIndexes);
    expect(rootPage(db, "context_deltas")).toBe(oldDeltaRootPage);
    expect(foreignKeys(db, "context_deltas").map(({ table, from, to, on_delete }) => ({ table, from, to, on_delete }))).toEqual([
      { table: "context_manifests_legacy_v1", from: "previous_manifest_id", to: "id", on_delete: "SET NULL" },
      { table: "context_manifests_legacy_v1", from: "manifest_id", to: "id", on_delete: "CASCADE" },
    ]);
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM context_manifests")?.count).toBe(0);
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM run_process_owners")?.count).toBe(0);

    // Restart/reopen must preserve all bytes represented by historical SQLite values.
    db.close();
    db = createSqliteDatabase(dbPath);
    expect(runMigrations(db, migrations).applied).toBe(0);
    expect(db.all<Row>("SELECT * FROM context_manifests_legacy_v1 ORDER BY id")).toEqual(oldManifestRows);
    expect(db.all<Row>("SELECT * FROM context_deltas ORDER BY id")).toEqual(oldDeltaRows);
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
    expect(runMigrations(db, migrations).applied).toBe(1);

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
    expect(() => insertRunProcessOwnerTx(db!, {
      ...secondOwner,
      hermesHome: owner.hermesHome,
    })).toThrow(/UNIQUE|unique/i);
    expect(() => insertRawOwner(db!, { ...owner, sourceTag: "not-the-deterministic-tag" })).toThrow(/CHECK constraint failed/i);
    expect(() => insertRawOwner(db!, { ...secondOwner, containmentId: "predictable" })).toThrow(/CHECK constraint failed/i);
    expect(() => insertRawOwner(db!, { ...secondOwner, pid: 123 })).toThrow(/CHECK constraint failed/i);
    expect(() => insertRawOwner(db!, { ...secondOwner, state: "RUNNING" })).toThrow(/CHECK constraint failed/i);
    expect(() => insertRawOwner(db!, { ...secondOwner, containmentKind: "process-group" })).toThrow(/CHECK constraint failed/i);
    expect(() => insertRawOwner(db!, { ...secondOwner, runId: "missing-owner-run", sourceTag: "ebb-run:missing-owner-run" })).toThrow(/FOREIGN KEY constraint failed/i);

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
