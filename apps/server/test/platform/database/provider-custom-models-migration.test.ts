import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import type { Database } from "../../../src/platform/database/database.js";
import { runMigrations } from "../../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../../helpers/migrations.js";

const NOW = "2026-10-24T12:00:00.000Z";

describe("provider custom models migration 051", () => {
  let db: Database | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    db?.close();
    db = undefined;
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  async function freshDb(): Promise<void> {
    tmpDir = await mkdtemp(join(tmpdir(), "ebb-provider-custom-models-migration-"));
    db = createSqliteDatabase(join(tmpDir, `${randomUUID()}.sqlite`));
  }

  describe("fresh install 001-051", () => {
    it("applies 001-051 and creates provider_custom_models with PK/index and no FK", async () => {
      await freshDb();
      const migrations = loadTestMigrations();
      expect(migrations.map(({ version }) => version)).toEqual(Array.from({ length: 51 }, (_, index) => index + 1));
      expect(migrations.at(-1)?.name).toBe("051_provider_custom_models");
      expect(runMigrations(db!, migrations).applied).toBe(51);

      const columns = db!.all<{ name: string; type: string; notnull: number; dflt_value: unknown; pk: number }>(
        "PRAGMA table_info(provider_custom_models)",
      );
      expect(columns.map(({ name, type, notnull, dflt_value, pk }) => ({ name, type, notnull, dflt_value, pk }))).toEqual([
        { name: "provider_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
        { name: "model_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 2 },
        { name: "display_name", type: "TEXT", notnull: 1, dflt_value: "''", pk: 0 },
        { name: "created_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      ]);

      // Составной PK (provider_id, model_id); отдельной автоинкрементной колонки нет.
      expect(db!.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type='table' AND name='provider_custom_models'")?.sql)
        .toMatch(/PRIMARY KEY \(provider_id,\s*model_id\)/);

      // Индекс по provider_id для выборок по провайдеру.
      expect(db!.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name='idx_provider_custom_models_provider'")?.sql)
        .toContain("provider_custom_models(provider_id)");
      expect(db!.all<{ seqno: number; cid: number; name: string }>("PRAGMA index_info(idx_provider_custom_models_provider)"))
        .toEqual([{ seqno: 0, cid: 0, name: "provider_id" }]);

      // Без FK: пользовательские модели могут существовать до конфигурации провайдера.
      expect(db!.all("PRAGMA foreign_key_list(provider_custom_models)")).toEqual([]);
      expect(db!.all("PRAGMA foreign_key_check")).toEqual([]);
      expect(db!.get<{ applied: number }>("SELECT COUNT(*) AS applied FROM schema_migrations")!.applied).toBe(51);
    });
  });

  describe("populated upgrade 050 -> 051", () => {
    it("adds provider_custom_models without touching existing rows or schema", async () => {
      await freshDb();
      const migrations = loadTestMigrations();
      const through050 = migrations.filter(({ version }) => version <= 50);
      expect(runMigrations(db!, through050).applied).toBe(50);
      expect(db!.get("SELECT name FROM sqlite_master WHERE type='table' AND name='provider_custom_models'")).toBeUndefined();

      const projectId = randomUUID();
      const taskId = randomUUID();
      const runId = randomUUID();
      db!.run("INSERT INTO projects(id,name,display_name,created_at,updated_at) VALUES($id,'P','P',$now,$now)", { id: projectId, now: NOW });
      db!.run(
        "INSERT INTO tasks(id,project_id,display_id,title,status,contract_json,created_at,updated_at) VALUES($id,$projectId,'T-1','Task','READY','{}',$now,$now)",
        { id: taskId, projectId, now: NOW },
      );
      db!.run(
        "INSERT INTO agent_runs(id,role,runtime,model,task_id,status,started_at) VALUES($id,'developer','hermes','default',$taskId,'STARTED',$now)",
        { id: runId, taskId, now: NOW },
      );
      db!.run(
        `INSERT INTO scheduler_run_requests(id,task_id,idempotency_key,role,model,origin_type,origin_id,status,created_at,updated_at)
         VALUES($id,$taskId,'legacy-key','developer','default','TASK_API',$taskId,'PENDING',$now,$now)`,
        { id: randomUUID(), taskId, now: NOW },
      );

      const runsBefore = db!.all("SELECT * FROM agent_runs");
      const tasksBefore = db!.all("SELECT * FROM tasks");
      const requestsBefore = db!.all("SELECT * FROM scheduler_run_requests");

      expect(runMigrations(db!, migrations).applied).toBe(1);
      expect(db!.all("SELECT * FROM agent_runs")).toEqual(runsBefore);
      expect(db!.all("SELECT * FROM tasks")).toEqual(tasksBefore);
      expect(db!.all("SELECT * FROM scheduler_run_requests")).toEqual(requestsBefore);

      // Модели доступны до создания конфигурации провайдера (нет FK).
      db!.run(
        "INSERT INTO provider_custom_models(provider_id,model_id,display_name,created_at) VALUES('openai','my-model','My Model',$now)",
        { now: NOW },
      );
      expect(db!.get("SELECT provider_id,model_id,display_name,created_at FROM provider_custom_models"))
        .toEqual({ provider_id: "openai", model_id: "my-model", display_name: "My Model", created_at: NOW });

      // Составной PK отклоняет дубликат (provider_id, model_id), но допускает тот же model_id у другого провайдера.
      expect(() => db!.run(
        "INSERT INTO provider_custom_models(provider_id,model_id,display_name,created_at) VALUES('openai','my-model','Dup',$now)",
        { now: NOW },
      )).toThrow(/UNIQUE|PRIMARY KEY/);
      db!.run(
        "INSERT INTO provider_custom_models(provider_id,model_id,display_name,created_at) VALUES('anthropic','my-model','Anthropic',$now)",
        { now: NOW },
      );
      expect(db!.all("PRAGMA foreign_key_check")).toEqual([]);
    });
  });

  describe("no plaintext and identifier-only storage", () => {
    it("stores only identifiers/names, no secrets, credentials or endpoints", async () => {
      await freshDb();
      runMigrations(db!, loadTestMigrations());

      // Схема не содержит секретных полей и endpoint'ов.
      const sql = db!.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type='table' AND name='provider_custom_models'")!.sql;
      expect(sql).not.toMatch(/secret|credential|token|api_key|endpoint|url/i);

      // Значения строк — только идентификаторы/имена моделей.
      db!.run(
        "INSERT INTO provider_custom_models(provider_id,model_id,display_name,created_at) VALUES('openai','gpt-4o-mini','GPT-4o mini',$now)",
        { now: NOW },
      );
      expect(db!.get("SELECT * FROM provider_custom_models")).toEqual({
        provider_id: "openai",
        model_id: "gpt-4o-mini",
        display_name: "GPT-4o mini",
        created_at: NOW,
      });
    });
  });
});
