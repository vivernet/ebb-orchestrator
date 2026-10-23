import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import type { Database } from "../../../src/platform/database/database.js";
import { runMigrations } from "../../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../../helpers/migrations.js";

describe("scheduler RunRequest provider selection migration 050", () => {
  let db: Database | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    db?.close();
    db = undefined;
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  async function freshDb(): Promise<void> {
    tmpDir = await mkdtemp(join(tmpdir(), "ebb-run-request-provider-selection-"));
    db = createSqliteDatabase(join(tmpDir, `${randomUUID()}.sqlite`));
  }

  it("applies 001-050 and adds nullable provider binding columns to scheduler_run_requests", async () => {
    await freshDb();
    const migrations = loadTestMigrations();
    expect(migrations.map(({ version }) => version)).toEqual(Array.from({ length: 50 }, (_, index) => index + 1));
    expect(migrations.at(-1)?.name).toBe("050_scheduler_run_request_provider_selection");
    expect(runMigrations(db!, migrations).applied).toBe(50);

    expect(db!.all<{ name: string }>("PRAGMA table_info(scheduler_run_requests)").map(({ name }) => name))
      .toEqual(expect.arrayContaining(["provider_id", "auth_method_id"]));
    const providerColumn = db!.all<{ name: string; notnull: number; dflt_value: unknown }>(
      "PRAGMA table_info(scheduler_run_requests)",
    ).find(({ name }) => name === "provider_id");
    expect(providerColumn).toMatchObject({ notnull: 0, dflt_value: null });
    expect(db!.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name='idx_scheduler_run_requests_provider'")?.sql)
      .toContain("scheduler_run_requests(provider_id)");
    expect(db!.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("upgrades populated schema 049 without touching existing rows or schema", async () => {
    await freshDb();
    const migrations = loadTestMigrations();
    const through049 = migrations.filter(({ version }) => version <= 49);
    expect(runMigrations(db!, through049).applied).toBe(49);

    const now = "2026-10-23T00:00:00.000Z";
    const projectId = randomUUID();
    const taskId = randomUUID();
    const runId = randomUUID();
    db!.run("INSERT INTO projects(id,name,display_name,created_at,updated_at) VALUES($id,'P','P',$now,$now)", { id: projectId, now });
    db!.run("INSERT INTO tasks(id,project_id,display_id,title,status,contract_json,created_at,updated_at) VALUES($id,$projectId,'T-1','Task','READY','{}',$now,$now)", { id: taskId, projectId, now });
    db!.run("INSERT INTO agent_runs(id,role,runtime,model,task_id,status,started_at) VALUES($id,'developer','hermes','default',$taskId,'STARTED',$now)", { id: runId, taskId, now });
    db!.run(`INSERT INTO scheduler_run_requests(id,task_id,idempotency_key,role,model,origin_type,origin_id,status,created_at,updated_at)
      VALUES($id,$taskId,'legacy-key','developer','default','TASK_API',$taskId,'PENDING',$now,$now)`, { id: randomUUID(), taskId, now });

    const rowsBefore = db!.all("SELECT id,task_id,idempotency_key,role,model,origin_type,origin_id,status,created_at,updated_at,run_id,failure_code FROM scheduler_run_requests");
    const queueIndexBefore = db!.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name='idx_scheduler_run_requests_queue'")?.sql;
    expect(runMigrations(db!, migrations).applied).toBe(1);
    expect(db!.all("SELECT id,task_id,idempotency_key,role,model,origin_type,origin_id,status,created_at,updated_at,run_id,failure_code FROM scheduler_run_requests")).toEqual(rowsBefore);
    // Существующие индексы не изменяются; новые столбцы добавляются как nullable.
    expect(db!.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name='idx_scheduler_run_requests_queue'")?.sql).toBe(queueIndexBefore);
    expect(db!.get("SELECT provider_id,auth_method_id FROM scheduler_run_requests")).toEqual({ provider_id: null, auth_method_id: null });
    expect(db!.all("PRAGMA foreign_key_check")).toEqual([]);
  });
});
