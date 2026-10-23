import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import type { Database } from "../../../src/platform/database/database.js";
import { runMigrations } from "../../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../../helpers/migrations.js";

const PH = "a".repeat(64);
const CH = "b".repeat(64);
const NOW = "2026-10-23T12:00:00.000Z";

describe("run traces migration", () => {
  let db: Database | undefined;
  let tmpDir: string;

  afterEach(async () => {
    db?.close();
    db = undefined;
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  function insertRun(runId: string, triggerReason?: string): void {
    db!.run(
      triggerReason === undefined
        ? "INSERT INTO agent_runs(id,role,runtime,model,status) VALUES($id,'developer','hermes','test-model','COMPLETED')"
        : "INSERT INTO agent_runs(id,role,runtime,model,status,trigger_reason) VALUES($id,'developer','hermes','test-model','COMPLETED',$triggerReason)",
      { id: runId, ...(triggerReason === undefined ? {} : { triggerReason }) },
    );
  }

  describe("fresh install through 051", () => {
    it("applies 001-051 and creates an additive run_traces table", async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "ebb-run-traces-fresh-"));
      db = createSqliteDatabase(join(tmpDir, `${randomUUID()}.sqlite`));
      const migrations = loadTestMigrations();
      expect(migrations.map(({ version }) => version)).toEqual(Array.from({ length: 51 }, (_, index) => index + 1));
      expect(migrations.at(-1)?.name).toBe("051_provider_custom_models");
      expect(runMigrations(db, migrations).applied).toBe(51);

      const columns = db.all<{ name: string; type: string; notnull: number; pk: number }>("PRAGMA table_info(run_traces)");
      expect(columns.map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk }))).toEqual([
        { name: "run_id", type: "TEXT", notnull: 1, pk: 1 },
        { name: "scenario", type: "TEXT", notnull: 0, pk: 0 },
        { name: "prompt_hash", type: "TEXT", notnull: 1, pk: 0 },
        { name: "context_hash", type: "TEXT", notnull: 1, pk: 0 },
        { name: "usage_json", type: "TEXT", notnull: 0, pk: 0 },
        { name: "created_at", type: "TEXT", notnull: 1, pk: 0 },
        { name: "version", type: "TEXT", notnull: 1, pk: 0 },
      ]);

      const insertTrace = (runId: string, overrides: Record<string, unknown> = {}): void => {
        db!.run(
          `INSERT INTO run_traces(run_id,scenario,prompt_hash,context_hash,usage_json,created_at,version)
           VALUES($runId,$scenario,$promptHash,$contextHash,$usageJson,$createdAt,$version)`,
          { runId, scenario: null, promptHash: PH, contextHash: CH, usageJson: null, createdAt: NOW, version: "1.0", ...overrides },
        );
      };

      const runId = randomUUID();
      insertRun(runId);
      insertTrace(runId);

      expect(() => insertTrace(runId)).toThrow(/UNIQUE|PRIMARY KEY/);
      expect(() => insertTrace(randomUUID(), { scenario: "bogus" })).toThrow(/CHECK constraint failed/i);
      expect(() => insertTrace(randomUUID(), { promptHash: "bad" })).toThrow(/CHECK constraint failed/i);
      expect(() => insertTrace(randomUUID(), { contextHash: "B".repeat(64) })).toThrow(/CHECK constraint failed/i);
      expect(() => insertTrace(randomUUID(), { usageJson: "x".repeat(513) })).toThrow(/CHECK constraint failed/i);
      expect(() => insertTrace(randomUUID(), { version: "2.0" })).toThrow(/CHECK constraint failed/i);
      expect(() => insertTrace(randomUUID())).toThrow(/FOREIGN KEY/);

      db!.run("DELETE FROM agent_runs WHERE id=$runId", { runId });
      expect(db!.all("SELECT * FROM run_traces")).toEqual([]);
      expect(db!.all("PRAGMA foreign_key_check")).toEqual([]);
      expect(db!.get<{ applied: number }>("SELECT COUNT(*) AS applied FROM schema_migrations")!.applied).toBe(51);
    });
  });

  describe("populated upgrade 047 -> 048", () => {
    it("adds run_traces without touching existing rows or schema", async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "ebb-run-traces-upgrade-"));
      db = createSqliteDatabase(join(tmpDir, `${randomUUID()}.sqlite`));
      const migrations = loadTestMigrations();
      const through047 = migrations.filter(({ version }) => version <= 47);
      expect(runMigrations(db, through047).applied).toBe(47);

      const projectId = randomUUID();
      const taskId = randomUUID();
      const runId = randomUUID();
      db!.run("INSERT INTO projects(id,name,display_name,created_at,updated_at) VALUES($id,'P','P',$now,$now)", { id: projectId, now: NOW });
      db!.run("INSERT INTO tasks(id,project_id,display_id,title,status,contract_json,created_at,updated_at) VALUES($id,$projectId,'T-1','Task','READY','{}',$now,$now)", { id: taskId, projectId, now: NOW });
      db!.run(
        "INSERT INTO agent_runs(id,role,runtime,model,task_id,status,trigger_reason,started_at,ended_at) VALUES($id,'developer','hermes','test-model',$taskId,'COMPLETED','task-assignment',$now,$now)",
        { id: runId, taskId, now: NOW },
      );
      const runRowsBefore = db!.all("SELECT * FROM agent_runs");
      const taskRowsBefore = db!.all("SELECT * FROM tasks");

      expect(runMigrations(db, migrations).applied).toBe(4);
      expect(db!.all("SELECT * FROM agent_runs")).toEqual(runRowsBefore);
      expect(db!.all("SELECT * FROM tasks")).toEqual(taskRowsBefore);

      db!.run(
        `INSERT INTO run_traces(run_id,scenario,prompt_hash,context_hash,created_at,version)
         VALUES($runId,'task-assignment',$ph,$ch,$now,'1.0')`,
        { runId, ph: PH, ch: CH, now: NOW },
      );
      expect(db!.get("SELECT scenario,prompt_hash,context_hash,version FROM run_traces"))
        .toEqual({ scenario: "task-assignment", prompt_hash: PH, context_hash: CH, version: "1.0" });

      expect(() => db!.transaction((tx) => {
        tx.run(
          `INSERT INTO run_traces(run_id,scenario,prompt_hash,context_hash,created_at,version)
           VALUES($runId,'bogus',$ph,$ch,$now,'1.0')`,
          { runId, ph: PH, ch: CH, now: NOW },
        );
      })).toThrow(/CHECK constraint failed/i);
      expect(db!.all("SELECT * FROM run_traces")).toHaveLength(1);
      expect(db!.all("PRAGMA foreign_key_check")).toEqual([]);
    });
  });
});
