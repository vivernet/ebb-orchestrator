import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import type { Database } from "../../../src/platform/database/database.js";
import { runMigrations } from "../../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../../helpers/migrations.js";

describe("scheduler RunRequest migration", () => {
  let db: Database | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    db?.close();
    db = undefined;
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it("upgrades populated schema 043 without changing existing task or context schema", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ebb-run-request-migration-"));
    db = createSqliteDatabase(join(tmpDir, `${randomUUID()}.sqlite`));
    const migrations = loadTestMigrations().filter(({ version }) => version <= 44);
    const through043 = migrations.filter(({ version }) => version <= 43);
    expect(runMigrations(db, through043).applied).toBe(43);

    const projectId = randomUUID();
    const taskId = randomUUID();
    const now = "2026-10-14T00:00:00.000Z";
    db.run("INSERT INTO projects(id,name,display_name,created_at,updated_at) VALUES($id,'Project','Project',$now,$now)", { id: projectId, now });
    db.run("INSERT INTO tasks(id,project_id,display_id,title,status,contract_json,created_at,updated_at) VALUES($id,$projectId,'T-1','Task','READY','{}',$now,$now)", { id: taskId, projectId, now });
    const runId = randomUUID();
    const manifestId = randomUUID();
    const deltaId = randomUUID();
    db.run("INSERT INTO agent_runs(id,role,runtime,model,task_id,status,started_at) VALUES($id,'developer','test','default',$taskId,'STARTED',$now)", { id: runId, taskId, now });
    db.run(`INSERT INTO context_manifests_legacy_v1(id,run_id,task_id,role,task_contract_version,created_at)
      VALUES($id,$runId,$taskId,'developer','1',$now)`, { id: manifestId, runId, taskId, now });
    db.run("INSERT INTO context_deltas(id,manifest_id,added_ids,updated_ids,removed_ids,resume_safe,created_at) VALUES($id,$manifestId,'[\"added\"]','[]','[]',1,$now)", { id: deltaId, manifestId, now });
    const contextRowsBefore = db.all("SELECT * FROM context_deltas");

    const contextSchemaBefore = db.all<{ name: string; sql: string | null }>(
      "SELECT name,sql FROM sqlite_master WHERE name IN ('context_deltas','context_manifests','idx_context_deltas_manifest') ORDER BY name",
    );
    const contextForeignKeysBefore = db.all("PRAGMA foreign_key_list(context_deltas)");
    const applied = runMigrations(db, migrations);

    expect(migrations.at(-1)?.version).toBe(44);
    expect(migrations.at(-1)?.name).toBe("044_scheduler_run_requests");
    expect(applied.applied).toBe(1);
    expect(db.get("SELECT id,status FROM tasks WHERE id=$id", { id: taskId })).toEqual({ id: taskId, status: "READY" });
    expect(db.all<{ name: string }>("PRAGMA table_info(scheduler_run_requests)").map(({ name }) => name)).toEqual([
      "id", "task_id", "idempotency_key", "role", "model", "origin_type", "origin_id", "status",
      "created_at", "updated_at", "run_id", "failure_code",
    ]);
    expect(db.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name='idx_scheduler_run_requests_idempotency'")?.sql).toContain("UNIQUE");
    expect(db.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name='idx_scheduler_run_requests_pending_task'")?.sql)
      .toContain("WHERE status = 'PENDING'");

    const requestId = randomUUID();
    db.run(`INSERT INTO scheduler_run_requests
      (id,task_id,idempotency_key,role,model,origin_type,origin_id,status,created_at,updated_at)
      VALUES($id,$taskId,'stable-key','developer','model-x','TASK_API',$taskId,'PENDING',$now,$now)`,
    { id: requestId, taskId, now });
    expect(() => db!.run(`INSERT INTO scheduler_run_requests
      (id,task_id,idempotency_key,role,model,origin_type,origin_id,status,created_at,updated_at)
      VALUES($id,$taskId,'other-key','developer','model-x','TASK_API',$taskId,'PENDING',$now,$now)`,
    { id: randomUUID(), taskId, now })).toThrow();
    expect(() => db!.run(`INSERT INTO scheduler_run_requests
      (id,task_id,idempotency_key,role,model,origin_type,origin_id,status,created_at,updated_at)
      VALUES($id,$taskId,'stable-key','developer','model-x','TASK_API',$taskId,'FAILED',$now,$now)`,
    { id: randomUUID(), taskId, now })).toThrow();
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
    expect(db.all("SELECT * FROM context_deltas")).toEqual(contextRowsBefore);
    expect(db.all("SELECT name,sql FROM sqlite_master WHERE name IN ('context_deltas','context_manifests','idx_context_deltas_manifest') ORDER BY name"))
      .toEqual(contextSchemaBefore);
    expect(db.all("PRAGMA foreign_key_list(context_deltas)")).toEqual(contextForeignKeysBefore);
    expect(db.all<{ table: string; from: string; on_delete: string }>("PRAGMA foreign_key_list(scheduler_run_requests)")
      .map(({ table, from, on_delete }) => ({ table, from, on_delete }))).toEqual([
      { table: "agent_runs", from: "run_id", on_delete: "RESTRICT" },
      { table: "tasks", from: "task_id", on_delete: "CASCADE" },
    ]);

    db.run("UPDATE scheduler_run_requests SET status='DISPATCHED',run_id=$runId,updated_at=$now WHERE id=$id", { id: requestId, runId, now });
    expect(() => db!.run("DELETE FROM agent_runs WHERE id=$runId", { runId })).toThrow();
    const requestRowsBefore = db.all("SELECT * FROM scheduler_run_requests");
    expect(runMigrations(db, loadTestMigrations()).applied).toBe(4);
    expect(db.all("SELECT * FROM scheduler_run_requests")).toEqual(requestRowsBefore);
    expect(db.all("SELECT * FROM context_deltas")).toEqual(contextRowsBefore);
    expect(db.all("SELECT name,sql FROM sqlite_master WHERE name IN ('context_deltas','context_manifests','idx_context_deltas_manifest') ORDER BY name")).toEqual(contextSchemaBefore);
    expect(db.all("PRAGMA foreign_key_list(context_deltas)")).toEqual(contextForeignKeysBefore);
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
    db.run(`INSERT INTO scheduler_run_requests(id,task_id,idempotency_key,role,model,origin_type,origin_id,status,created_at,updated_at)
      VALUES($id,$taskId,'stage-key','reviewer','default','TASK_STAGE',$runId,'PENDING',$now,$now)`, { id: randomUUID(), taskId, runId, now });
    expect(() => db!.run("INSERT INTO run_completion_projections(run_id,projected_at) VALUES('missing-run',$now)", { now })).toThrow(/FOREIGN KEY/);
    db.run("INSERT INTO run_completion_projections(run_id,projected_at) VALUES($runId,$now)", { runId, now });
    expect(() => db!.run("INSERT INTO run_completion_projections(run_id,projected_at) VALUES($runId,$now)", { runId, now })).toThrow(/UNIQUE/);
    expect(() => db!.run("DELETE FROM agent_runs WHERE id=$runId", { runId })).toThrow();
    db.run("DELETE FROM tasks WHERE id=$taskId", { taskId });
    expect(db.get("SELECT id FROM scheduler_run_requests WHERE id=$id", { id: requestId })).toBeUndefined();
  });
});
