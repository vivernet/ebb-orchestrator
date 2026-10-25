import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import type { Database } from "../../../src/platform/database/database.js";
import { runMigrations } from "../../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../../helpers/migrations.js";

const NOW = "2026-10-25T00:00:00.000Z";

/** Вставляет run и process-owner PREPARED в той же transaction, что и Run. */
function seedRun(db: Database, runId: string, role = "developer"): void {
  const now = NOW;
  const containmentId = (randomUUID() + randomUUID()).replaceAll("-", "");
  const launchNonce = (randomUUID() + randomUUID()).replaceAll("-", "");
  db.run("INSERT OR IGNORE INTO projects(id,name,display_name,status,created_at,updated_at) VALUES('p-1','p','P','ACTIVE',$now,$now)", { now });
  db.run("INSERT OR IGNORE INTO tasks(id,project_id,display_id,title,status,contract_json,created_at,updated_at) VALUES('task-1','p-1','T-1','Task','READY','{}',$now,$now)", { now });
  db.run(
    `INSERT INTO agent_runs(id,role,runtime,model,task_id,status,session_id,attempt,trigger_reason,context_version,prompt,output_schema_version,started_at,ended_at,exit_code,input_tokens,cached_input_tokens,output_tokens,cost,capability_ref,capability_json)
     VALUES($id,$role,'hermes','model','task-1','IN_PROGRESS',$sessionId,1,'DEVELOPMENT','1','prompt','1',$now,NULL,NULL,0,0,0,0,$capRef,$capJson)`,
    { id: runId, role, sessionId: `session-${runId}`, now, capRef: `cap-${runId}`, capJson: JSON.stringify({ id: `cap-${runId}`, capabilityRef: `cap-${runId}`, runId, workspace: "/ws", allowedTools: ["submit_result"] }) },
  );
  db.run(
    `INSERT INTO run_process_owner_generations(run_id,generation,run_attempt,source_tag,hermes_home,capture_state,containment_kind,containment_id,launch_nonce,state,stop_evidence,updated_at)
     VALUES($id,1,1,$tag,$home,'BOUND','darwin-process-group',$containmentId,$launchNonce,'STOPPED','DARWIN_GROUP_EMPTY',$now)`,
    { id: runId, tag: `ebb-run:${runId}`, home: `/home/${runId}`, containmentId, launchNonce, now },
  );
  db.run(
    `INSERT INTO run_process_owners(run_id,source_tag,hermes_home,containment_kind,containment_id,launch_nonce,state,stop_evidence,updated_at,current_generation)
     VALUES($id,$tag,$home,'darwin-process-group',$containmentId,$launchNonce,'STOPPED','DARWIN_GROUP_EMPTY',$now,1)`,
    { id: runId, tag: `ebb-run:${runId}`, home: `/home/${runId}`, containmentId, launchNonce, now },
  );
  db.run(
    `INSERT INTO run_resume_bindings(run_id,schema_version,baseline_jcs,context_hash,workspace_snapshot_version,workspace_snapshot_bound,workspace_snapshot_hash,resume_binding_hash,created_at)
     VALUES($id,1,'{}',$contextHash,1,1,$workspaceHash,$bindingHash,$now)`,
    { id: runId, contextHash: "a".repeat(64), workspaceHash: "b".repeat(64), bindingHash: "c".repeat(64), now },
  );
}

function seedCommand(db: Database, runId: string, requestId: string, attempt = 1): void {
  db.run(
    `INSERT INTO run_control_commands(request_id,run_id,attempt,command,expected_version,status,result_json,created_at,updated_at)
     VALUES($requestId,$runId,$attempt,'PAUSE',0,'REQUESTED',NULL,$now,$now)`,
    { requestId, runId, attempt, now: NOW },
  );
}

describe("run control checkpoints migration 054", () => {
  let db: Database | undefined;
  let freshDir: string;
  let dbPath: string;

  afterEach(async () => {
    db?.close();
    db = undefined;
    if (freshDir) await rm(freshDir, { recursive: true, force: true });
  });

  async function openNewDatabase(): Promise<Database> {
    freshDir = await mkdtemp(join(tmpdir(), "ebb-run-control-migration-"));
    dbPath = join(freshDir, `test-${randomUUID()}.sqlite`);
    db = createSqliteDatabase(dbPath);
    return db;
  }

  it("fresh install 001-054 applies the run control migration exactly once", () => {
    db = createSqliteDatabase(":memory:");
    const migrations = loadTestMigrations();

    expect(migrations.map(({ version }) => version)).toEqual(Array.from({ length: 55 }, (_, index) => index + 1));
    expect(migrations.at(-1)?.name).toBe("055_project_config_write_journal");
    expect(runMigrations(db, migrations).applied).toBe(55);
    expect(db.all<{ version: number; name: string }>("SELECT version, name FROM schema_migrations ORDER BY version"))
      .toEqual(migrations.map(({ version, name }) => ({ version, name })));
    expect(runMigrations(db, migrations).applied).toBe(0);
  });

  it("creates run_control_commands with command/status/attempt constraints and UNIQUE dedupe", () => {
    db = createSqliteDatabase(":memory:");
    runMigrations(db, loadTestMigrations());
    seedRun(db, "run-1");

    const columns = db.all<{ name: string; type: string; notnull: number }>("PRAGMA table_info(run_control_commands)")
      .map(({ name, type, notnull }) => ({ name, type, notnull }));
    expect(columns).toEqual(expect.arrayContaining([
      { name: "request_id", type: "TEXT", notnull: 0 },
      { name: "run_id", type: "TEXT", notnull: 1 },
      { name: "attempt", type: "INTEGER", notnull: 1 },
      { name: "command", type: "TEXT", notnull: 1 },
      { name: "expected_version", type: "INTEGER", notnull: 1 },
      { name: "status", type: "TEXT", notnull: 1 },
      { name: "result_json", type: "TEXT", notnull: 0 },
      { name: "created_at", type: "TEXT", notnull: 1 },
      { name: "updated_at", type: "TEXT", notnull: 1 },
    ]));

    const tableSql = db.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type='table' AND name='run_control_commands'")?.sql ?? "";
    expect(tableSql).toMatch(/CHECK\s*\(\s*attempt\s+>\s+0\s*\)/i);
    expect(tableSql).toMatch(/CHECK\s*\(\s*command\s+IN\s*\(\s*'CHECKPOINT',\s*'PAUSE',\s*'RESUME'\s*\)\s*\)/i);
    expect(tableSql).toMatch(/CHECK\s*\(\s*status\s+IN\s*\(\s*'REQUESTED',\s*'COMPLETED',\s*'FAILED'\s*\)\s*\)/i);
    expect(tableSql).toMatch(/CHECK\s*\(\s*expected_version\s+>=\s+0\s*\)/i);

    db.run(
      `INSERT INTO run_control_commands(request_id,run_id,attempt,command,expected_version,status,created_at,updated_at)
       VALUES('req-1','run-1',1,'PAUSE',0,'REQUESTED',$now,$now)`,
      { now: NOW },
    );
    // Точный replay того же request_id отклоняется UNIQUE (run_id,attempt,request_id).
    expect(() => db!.run(
      `INSERT INTO run_control_commands(request_id,run_id,attempt,command,expected_version,status,created_at,updated_at)
       VALUES('req-1','run-1',1,'PAUSE',0,'REQUESTED',$now,$now)`,
      { now: NOW },
    )).toThrow(/UNIQUE|PRIMARY KEY/);
    // attempt=0 отклоняется CHECK.
    expect(() => db!.run(
      `INSERT INTO run_control_commands(request_id,run_id,attempt,command,expected_version,status,created_at,updated_at)
       VALUES('req-2','run-1',0,'PAUSE',0,'REQUESTED',$now,$now)`,
      { now: NOW },
    )).toThrow(/CHECK constraint failed/i);
    // Неизвестная команда отклоняется CHECK.
    expect(() => db!.run(
      `INSERT INTO run_control_commands(request_id,run_id,attempt,command,expected_version,status,created_at,updated_at)
       VALUES('req-3','run-1',1,'KILL',0,'REQUESTED',$now,$now)`,
      { now: NOW },
    )).toThrow(/CHECK constraint failed/i);
    // Чужой run_id отклоняется FK.
    expect(() => db!.run(
      `INSERT INTO run_control_commands(request_id,run_id,attempt,command,expected_version,status,created_at,updated_at)
       VALUES('req-4','run-missing',1,'PAUSE',0,'REQUESTED',$now,$now)`,
      { now: NOW },
    )).toThrow(/FOREIGN KEY constraint failed/i);
  });

  it("creates run_checkpoints with provenance columns, FK to commands and UNIQUE pairs", () => {
    db = createSqliteDatabase(":memory:");
    runMigrations(db, loadTestMigrations());
    seedRun(db, "run-1");
    seedCommand(db, "run-1", "req-1");

    const columns = db.all<{ name: string; type: string; notnull: number }>("PRAGMA table_info(run_checkpoints)")
      .map(({ name, type, notnull }) => ({ name, type, notnull }));
    expect(columns).toEqual(expect.arrayContaining([
      { name: "id", type: "TEXT", notnull: 0 },
      { name: "run_id", type: "TEXT", notnull: 1 },
      { name: "attempt", type: "INTEGER", notnull: 1 },
      { name: "request_id", type: "TEXT", notnull: 1 },
      { name: "session_id", type: "TEXT", notnull: 1 },
      { name: "owner_generation", type: "INTEGER", notnull: 1 },
      { name: "containment_ref", type: "TEXT", notnull: 1 },
      { name: "launch_nonce_hash", type: "TEXT", notnull: 1 },
      { name: "context_hash", type: "TEXT", notnull: 1 },
      { name: "workspace_snapshot_hash", type: "TEXT", notnull: 1 },
      { name: "event_cursor", type: "TEXT", notnull: 1 },
      { name: "checkpoint_hash", type: "TEXT", notnull: 1 },
      { name: "created_at", type: "TEXT", notnull: 1 },
    ]));

    db.run(
      `INSERT INTO run_checkpoints(id,run_id,attempt,request_id,session_id,owner_generation,containment_ref,launch_nonce_hash,context_hash,workspace_snapshot_hash,event_cursor,checkpoint_hash,created_at)
       VALUES($id,'run-1',1,'req-1','session-run-1',1,'darwin-process-group:1111111111111111111111111111111111111111111111111111111111111111','eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','evt-1','ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',$now)`,
      { id: randomUUID(), now: NOW },
    );
    // Checkpoint без существующей команды отклоняется FK.
    expect(() => db!.run(
      `INSERT INTO run_checkpoints(id,run_id,attempt,request_id,session_id,owner_generation,containment_ref,launch_nonce_hash,context_hash,workspace_snapshot_hash,event_cursor,checkpoint_hash,created_at)
       VALUES($id,'run-1',1,'req-unknown','session-run-1',1,'ref','eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','evt-1','ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',$now)`,
      { id: randomUUID(), now: NOW },
    )).toThrow(/FOREIGN KEY constraint failed/i);
  });

  it("creates run_control_state with state/version CHECKs and paused/resume_pending requiring a checkpoint", () => {
    db = createSqliteDatabase(":memory:");
    runMigrations(db, loadTestMigrations());
    seedRun(db, "run-1");
    seedCommand(db, "run-1", "req-1");
    const checkpointId = randomUUID();
    db.run(
      `INSERT INTO run_checkpoints(id,run_id,attempt,request_id,session_id,owner_generation,containment_ref,launch_nonce_hash,context_hash,workspace_snapshot_hash,event_cursor,checkpoint_hash,created_at)
       VALUES($id,'run-1',1,'req-1','session-run-1',1,'ref','eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','evt-1','ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',$now)`,
      { id: checkpointId, now: NOW },
    );

    const columns = db.all<{ name: string; type: string; notnull: number }>("PRAGMA table_info(run_control_state)")
      .map(({ name, type, notnull }) => ({ name, type, notnull }));
    expect(columns).toEqual(expect.arrayContaining([
      { name: "run_id", type: "TEXT", notnull: 0 },
      { name: "attempt", type: "INTEGER", notnull: 1 },
      { name: "state", type: "TEXT", notnull: 1 },
      { name: "checkpoint_id", type: "TEXT", notnull: 0 },
      { name: "version", type: "INTEGER", notnull: 1 },
      { name: "updated_at", type: "TEXT", notnull: 1 },
    ]));

    const tableSql = db.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type='table' AND name='run_control_state'")?.sql ?? "";
    expect(tableSql).toMatch(/CHECK\s*\(\s*state\s+IN\s*\(\s*'ACTIVE',\s*'PAUSE_REQUESTED',\s*'PAUSED',\s*'RESUME_PENDING',\s*'CLOSED'\s*\)\s*\)/i);
    expect(tableSql).toMatch(/CHECK\s*\(\s*version\s+>=\s+0\s*\)/i);
    expect(tableSql).toMatch(/CHECK\s*\(\s*state\s+NOT\s+IN\s*\(\s*'PAUSED',\s*'RESUME_PENDING'\s*\)\s+OR\s+checkpoint_id\s+IS\s+NOT\s+NULL\s*\)/i);

    db.run("INSERT INTO run_control_state(run_id,attempt,state,checkpoint_id,version,updated_at) VALUES('run-1',1,'ACTIVE',NULL,0,$now)", { now: NOW });
    // PAUSED без checkpoint_id отклоняется CHECK.
    expect(() => db!.run("INSERT INTO run_control_state(run_id,attempt,state,checkpoint_id,version,updated_at) VALUES('run-2',1,'PAUSED',NULL,0,$now)", { now: NOW }))
      .toThrow(/CHECK constraint failed/i);
    // PAUSED с валидным checkpoint_id того же Run допустим; чужой checkpoint_id отклоняется FK.
    seedRun(db, "run-2");
    seedCommand(db, "run-2", "req-2");
    const checkpointForRun2 = randomUUID();
    db.run(
      `INSERT INTO run_checkpoints(id,run_id,attempt,request_id,session_id,owner_generation,containment_ref,launch_nonce_hash,context_hash,workspace_snapshot_hash,event_cursor,checkpoint_hash,created_at)
       VALUES($id,'run-2',1,'req-2','session-run-2',1,'ref','eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','evt-1','ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',$now)`,
      { id: checkpointForRun2, now: NOW },
    );
    db.run("INSERT INTO run_control_state(run_id,attempt,state,checkpoint_id,version,updated_at) VALUES('run-2',1,'PAUSED',$cp,0,$now)", { cp: checkpointForRun2, now: NOW });
    expect(() => db!.run("INSERT INTO run_control_state(run_id,attempt,state,checkpoint_id,version,updated_at) VALUES('run-3',1,'PAUSED','cp-unknown',0,$now)", { now: NOW }))
      .toThrow(/FOREIGN KEY constraint failed/i);
    // Неизвестный state отклоняется CHECK.
    expect(() => db!.run("INSERT INTO run_control_state(run_id,attempt,state,checkpoint_id,version,updated_at) VALUES('run-4',1,'PAUSING',NULL,0,$now)", { now: NOW }))
      .toThrow(/CHECK constraint failed/i);
  });

  it("upgrades a populated v052 database to v054 preserving existing rows and foreign key integrity", async () => {
    const database = await openNewDatabase();
    const migrations = loadTestMigrations();
    const through052 = migrations.filter((migration) => migration.version <= 52);

    expect(runMigrations(database, through052).applied).toBe(52);

    const now = NOW;
    database.run("INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES('p-1','p','P','ACTIVE',$now,$now)", { now });
    database.run("INSERT INTO tasks(id,project_id,display_id,title,status,contract_json,created_at,updated_at) VALUES('task-1','p-1','T-1','Task','READY','{}',$now,$now)", { now });
    database.run(
      `INSERT INTO agent_runs(id,role,runtime,model,task_id,status,trigger_reason,context_version,prompt,output_schema_version,started_at,capability_ref,capability_json)
       VALUES('run-1','developer','hermes','model','task-1','IN_PROGRESS','DEVELOPMENT','1','prompt','1',$now,'cap-1','{}')`,
      { now },
    );
    database.run("INSERT INTO scheduler_reservations(id,kind,subject_id,project_id,owner_id,reserved_at,estimate_cost,status,role,model,run_id) VALUES('res-1','TASK','task-1','p-1','task:task-1',$now,5,'RESERVED','developer','model','run-1')", { now });
    database.run("INSERT INTO scheduler_resource_locks(resource_key,reservation_id,project_id,owner_id,locked_at) VALUES('task:task-1','res-1','p-1','task:task-1',$now)", { now });

    const upgraded = runMigrations(database, migrations);
    expect(upgraded.applied).toBe(3);

    expect(database.get("SELECT id,status,run_id FROM scheduler_reservations WHERE id='res-1'"))
      .toEqual({ id: "res-1", status: "RESERVED", run_id: "run-1" });
    expect(database.get("SELECT resource_key,reservation_id FROM scheduler_resource_locks WHERE reservation_id='res-1'"))
      .toEqual({ resource_key: "task:task-1", reservation_id: "res-1" });
    expect(database.all("PRAGMA foreign_key_check")).toEqual([]);
    expect(database.all("SELECT * FROM run_control_commands")).toEqual([]);
    expect(database.all("SELECT * FROM run_checkpoints")).toEqual([]);
    expect(database.all("SELECT * FROM run_control_state")).toEqual([]);
  });

  it("persists run control state across a full database restart", async () => {
    const database = await openNewDatabase();
    const migrations = loadTestMigrations();
    runMigrations(database, migrations);
    seedRun(database, "run-1");
    seedCommand(database, "run-1", "req-1");
    const checkpointId = randomUUID();
    database.run(
      `INSERT INTO run_checkpoints(id,run_id,attempt,request_id,session_id,owner_generation,containment_ref,launch_nonce_hash,context_hash,workspace_snapshot_hash,event_cursor,checkpoint_hash,created_at)
       VALUES($id,'run-1',1,'req-1','session-run-1',1,'ref','eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','evt-1','ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',$now)`,
      { id: checkpointId, now: NOW },
    );
    database.run("INSERT INTO run_control_state(run_id,attempt,state,checkpoint_id,version,updated_at) VALUES('run-1',1,'PAUSED',$cp,2,$now)", { cp: checkpointId, now: NOW });

    database.close();
    db = undefined;

    db = createSqliteDatabase(dbPath);
    expect(runMigrations(db, migrations).applied).toBe(0);
    expect(db.get("SELECT run_id,state,version,checkpoint_id FROM run_control_state WHERE run_id='run-1'"))
      .toEqual({ run_id: "run-1", state: "PAUSED", version: 2, checkpoint_id: checkpointId });
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
  });
});
