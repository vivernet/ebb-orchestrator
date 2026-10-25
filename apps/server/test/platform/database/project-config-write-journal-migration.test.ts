import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../../helpers/migrations.js";
import type { Migration } from "../../../src/platform/database/migrator.js";
import type { Database } from "../../../src/platform/database/database.js";

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function db(): Database {
  const database = createSqliteDatabase(":memory:");
  databases.push(database);
  return database;
}

function migrationsUpTo(version: number): Migration[] {
  return loadTestMigrations().filter((migration) => migration.version <= version);
}

describe("project config write journal migration 055", () => {
  it("applies on a fresh database through the real runner (001–055)", () => {
    const database = db();
    const result = runMigrations(database, loadTestMigrations());
    expect(result.applied).toBe(55);
    const journal = database.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='project_config_write_journal'",
    );
    expect(journal?.name).toBe("project_config_write_journal");
    expect(database.get<{ version: number }>("SELECT MAX(version) AS version FROM schema_migrations")?.version).toBe(55);
  });

  it("upgrades a populated v052 database to v055 without rebuilding existing tables", () => {
    const database = db();
    runMigrations(database, migrationsUpTo(52));
    const now = new Date().toISOString();
    const projectId = randomUUID();
    database.run(
      "INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'p','P','ACTIVE',$now,$now)",
      { id: projectId, now },
    );
    const approvalId = randomUUID();
    database.run(
      "INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,created_at) VALUES($id,'WORKFLOW_CHANGE',$projectId,'PROJECT','APPROVED','t',$now)",
      { id: approvalId, projectId, now },
    );
    const manifest = JSON.stringify({ files: [{ path: ".ebb-orchestrator/project.yaml", state: "present", sha256: "a".repeat(64) }] });
    const hashA = "a".repeat(64);
    const hashB = "b".repeat(64);
    const candidateId = randomUUID();
    database.run(
      `INSERT INTO project_config_candidates(candidate_id,project_id,source_head,manifest_json,manifest_hash,source_files_json,normalized_payload_json,schema_version,status,created_at)
       VALUES($candidateId,$projectId,'head',$manifest,$hashA,'{}','{"project":{}}',1,'PENDING_REVIEW',$now)`,
      { candidateId, projectId, manifest, hashA, now },
    );
    const revisionId = randomUUID();
    database.run(
      `INSERT INTO project_config_revisions(revision_id,project_id,candidate_id,schema_version,normalized_payload_json,source_head,manifest_json,source_files_json,manifest_hash,revision_hash,approval_id,created_at)
       VALUES($revisionId,$projectId,$candidateId,1,'{"project":{}}','head',$manifest,'{}',$hashA,$hashB,$approvalId,$now)`,
      { revisionId, projectId, candidateId, manifest, hashA, hashB, approvalId, now },
    );
    database.run(
      "INSERT INTO project_config_state(project_id,current_candidate_id,active_revision_id,config_status,updated_at) VALUES($projectId,$candidateId,$revisionId,'READY',$now)",
      { projectId, candidateId, revisionId, now },
    );
    const priorTables = database.all<{ name: string }>('SELECT name FROM sqlite_master WHERE type IN (\'table\',\'index\',\'trigger\') ORDER BY name');
    const priorCandidate = database.get<{ status: string }>("SELECT status FROM project_config_candidates WHERE candidate_id=$id", { id: candidateId });
    const priorRevisions = database.get<{ count: number }>("SELECT COUNT(*) AS count FROM project_config_revisions")?.count;

    const result = runMigrations(database, migrationsUpTo(55));
    expect(result.applied).toBe(3);

    expect(database.all("PRAGMA foreign_key_check")).toEqual([]);

    database.run(
      "INSERT INTO scheduler_scope_pauses(scope,scope_id,paused_at,actor) VALUES('PROJECT',$projectId,$now,'t')",
      { projectId, now },
    );

    const tables = ["project_config_candidates", "project_config_revisions", "project_config_state", "project_config_write_journal"];
    for (const table of tables) {
      const fks = database.all<{ table: string; from: string; to: string; on_update: string; on_delete: string; match: string }>(
        `PRAGMA foreign_key_list("${table}")`,
      );
      expect(fks.length).toBeGreaterThan(0);
      for (const fk of fks) {
        expect(fk.from).toBeTruthy();
        expect(fk.to).toBeTruthy();
        expect(["NO ACTION", "CASCADE", "RESTRICT", "SET NULL"]).toContain(fk.on_update);
        expect(["NO ACTION", "CASCADE", "RESTRICT", "SET NULL"]).toContain(fk.on_delete);
        expect(fk.match).toBe("NONE");
      }
    }
    const journalFks = database.all<{ from: string; to: string; on_update: string; on_delete: string }>(
      'PRAGMA foreign_key_list("project_config_write_journal")',
    );
    const projectFk = journalFks.find((fk) => fk.from === "project_id");
    const candidateFk = journalFks.find((fk) => fk.from === "candidate_id");
    const approvalFk = journalFks.find((fk) => fk.from === "approval_id");
    expect(projectFk).toMatchObject({ table: "projects", on_delete: "CASCADE" });
    expect(candidateFk).toMatchObject({ table: "project_config_candidates", on_delete: "NO ACTION" });
    expect(approvalFk).toMatchObject({ table: "approvals", on_delete: "NO ACTION" });

    // Существующие rows/pointers и таблицы не перестраивались.
    expect(database.get<{ status: string }>("SELECT status FROM project_config_candidates WHERE candidate_id=$id", { id: candidateId })).toEqual(priorCandidate);
    expect(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM project_config_revisions")?.count).toBe(priorRevisions);
    expect(database.get<{ active_revision_id: string; current_candidate_id: string; config_status: string }>(
      "SELECT active_revision_id,current_candidate_id,config_status FROM project_config_state WHERE project_id=$id", { id: projectId },
    )).toEqual({ active_revision_id: revisionId, current_candidate_id: candidateId, config_status: "READY" });
    expect(database.get<{ scope: string; scope_id: string }>("SELECT scope,scope_id FROM scheduler_scope_pauses")).toEqual({ scope: "PROJECT", scope_id: projectId });
    // Индексы/триггеры сохранены без rebuild.
    for (const index of ["idx_project_config_candidates_project_created", "idx_project_config_revisions_project_created", "idx_project_config_write_journal_project_created", "uq_project_config_write_journal_active_project"]) {
      expect(database.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type='index' AND name=$name", { name: index })).toBeTruthy();
    }
    for (const trigger of ["trg_project_config_candidate_snapshot_immutable", "trg_project_config_revision_immutable"]) {
      expect(database.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type='trigger' AND name=$name", { name: trigger })).toBeTruthy();
    }
    // Ни одна существующая таблица/индекс/триггер не перестраивалась и не пропала.
    const afterObjects = new Set(database.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type IN ('table','index','trigger')").map((row) => row.name));
    for (const prior of priorTables) expect(afterObjects.has(prior.name)).toBe(true);
  });

  it("enforces the journal phase enum, resolution CHECK and partial unique index", () => {
    const database = db();
    runMigrations(database, loadTestMigrations());
    const now = new Date().toISOString();
    const hashA = "a".repeat(64);
    const hashB = "b".repeat(64);
    const projectId = randomUUID();
    database.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'p','P','ACTIVE',$now,$now)", { id: projectId, now });
    const approvalId = randomUUID();
    database.run("INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,created_at) VALUES($id,'WORKFLOW_CHANGE',$projectId,'PROJECT','APPROVED','t',$now)", { id: approvalId, projectId, now });
    const candidateId = randomUUID();
    database.run(
      `INSERT INTO project_config_candidates(candidate_id,project_id,source_head,manifest_json,manifest_hash,source_files_json,normalized_payload_json,schema_version,status,created_at)
       VALUES($id,$projectId,'head','{}',$hashA,'{}','{}',1,'PENDING_REVIEW',$now)`,
      { id: candidateId, projectId, hashA, now },
    );
    const insert = (id: string, phase: string) => database.run(
      `INSERT INTO project_config_write_journal(id,project_id,candidate_id,approval_id,expected_manifest_hash,old_files_json,new_files_json,phase,created_at,updated_at)
       VALUES($id,$projectId,$candidateId,$approvalId,$hashA,'{}','{}',$phase,$now,$now)`,
      { id, projectId, candidateId, approvalId, hashA, phase, now },
    );
    insert("j1", "PREPARED");
    // Partial unique: только один активный (non-terminal) журнал на проект.
    expect(() => insert("j2", "WRITING")).toThrow();
    // Phase enum.
    expect(() => insert("j3", "BOGUS")).toThrow(/CHECK/i);
    // Resolution CHECK: нельзя заполнить resolution без терминальной фазы.
    expect(() => database.run(
      `INSERT INTO project_config_write_journal(id,project_id,candidate_id,approval_id,expected_manifest_hash,old_files_json,new_files_json,phase,resolution,resolved_by,resolved_manifest_hash,resolved_at,created_at,updated_at)
       VALUES('j4',$projectId,$candidateId,$approvalId,$hashA,'{}','{}','PREPARED','ACCEPT_EXTERNAL','t',$hashB,$now,$now,$now)`,
      { projectId, candidateId, approvalId, hashA, hashB, now },
    )).toThrow(/CHECK/i);
    // Терминальная фаза обязана иметь все resolution-поля.
    expect(() => database.run(
      `INSERT INTO project_config_write_journal(id,project_id,candidate_id,approval_id,expected_manifest_hash,old_files_json,new_files_json,phase,created_at,updated_at)
       VALUES('j5',$projectId,$candidateId,$approvalId,$hashA,'{}','{}','RECONCILED_EXTERNAL',$now,$now)`,
      { projectId, candidateId, approvalId, hashA, now },
    )).toThrow(/CHECK/i);
    database.run("DELETE FROM project_config_write_journal WHERE id='j1'");
    insert("j6", "DEGRADED");
    database.run("DELETE FROM project_config_write_journal WHERE id='j6'");
    database.run(
      `INSERT INTO project_config_write_journal(id,project_id,candidate_id,approval_id,expected_manifest_hash,old_files_json,new_files_json,phase,resolution,resolved_by,resolved_manifest_hash,resolved_at,created_at,updated_at)
       VALUES('j7',$projectId,$candidateId,$approvalId,$hashA,'{}','{}','RECONCILED_RESTORED','RESTORE_APPROVED','t',$hashB,$now,$now,$now)`,
      { projectId, candidateId, approvalId, hashA, hashB, now },
    );
    expect(database.get<{ phase: string }>("SELECT phase FROM project_config_write_journal WHERE id='j7'")?.phase).toBe("RECONCILED_RESTORED");
  });
});
