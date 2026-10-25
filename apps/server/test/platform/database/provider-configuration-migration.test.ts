import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import type { Database } from "../../../src/platform/database/database.js";
import { runMigrations } from "../../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../../helpers/migrations.js";
import { KeyringSecretStore } from "../../../src/platform/security/keyring-secret-store.js";
import type { KeyringBackend } from "../../../src/platform/security/keyring-secret-store.js";
import { createProviderSettingsRepository } from "../../../src/modules/runtime/providers/provider-settings-repository.js";
import { createProviderCredentialStore, PROVIDER_CREDENTIAL_SERVICE } from "../../../src/modules/runtime/providers/provider-credential-store.js";
import { createProviderSettingsService } from "../../../src/modules/runtime/providers/provider-settings-service.js";

const NOW = "2026-10-23T12:00:00.000Z";

describe("provider configuration migration 049", () => {
  let db: Database | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    db?.close();
    db = undefined;
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  function freshDb(): string {
    tmpDir = mkdtempSync(join(tmpdir(), "ebb-provider-config-migration-"));
    const path = join(tmpDir, `${randomUUID()}.sqlite`);
    db = createSqliteDatabase(path);
    return path;
  }

  describe("fresh install 001-051", () => {
    it("applies 001-051 and creates additive provider tables with integrity", () => {
      freshDb();
      const migrations = loadTestMigrations();
      expect(migrations.map(({ version }) => version)).toEqual(Array.from({ length: 55 }, (_, index) => index + 1));
      expect(migrations.at(-1)?.name).toBe("055_project_config_write_journal");
      expect(runMigrations(db!, migrations).applied).toBe(55);

      expect(db!.all<{ name: string }>("PRAGMA table_info(provider_configurations)").map(({ name }) => name))
        .toEqual(["provider_id", "enabled", "selected_auth_method", "config_json", "model_selection_json", "current_revision", "created_at", "updated_at"]);
      expect(db!.all<{ name: string }>("PRAGMA table_info(provider_config_snapshots)").map(({ name }) => name))
        .toEqual(["provider_id", "revision", "selected_auth_method", "config_json", "model_selection_json", "captured_at"]);
      expect(db!.all<{ name: string }>("PRAGMA table_info(provider_credentials)").map(({ name }) => name))
        .toEqual(["provider_id", "auth_method_id", "secret_name", "reference_id", "status", "created_at", "updated_at"]);
      expect(db!.all<{ name: string }>("PRAGMA table_info(run_provider_selections)").map(({ name }) => name))
        .toEqual(["run_id", "provider_id", "model_id", "auth_method_id", "config_revision", "created_at"]);

      const fk = db!.all<{ table: string; from: string; to: string; on_delete: string }>(
        "PRAGMA foreign_key_list(provider_config_snapshots)",
      ).map(({ table, from, to, on_delete }) => ({ table, from, to, on_delete }));
      expect(fk).toEqual([{ table: "provider_configurations", from: "provider_id", to: "provider_id", on_delete: "CASCADE" }]);

      const credFk = db!.all<{ table: string; from: string; to: string; on_delete: string }>(
        "PRAGMA foreign_key_list(provider_credentials)",
      ).map(({ table, from, to, on_delete }) => ({ table, from, to, on_delete })).sort((a, b) => a.table.localeCompare(b.table));
      expect(credFk).toEqual([
        { table: "provider_configurations", from: "provider_id", to: "provider_id", on_delete: "CASCADE" },
        { table: "secrets", from: "reference_id", to: "reference_id", on_delete: "CASCADE" },
      ].sort((a, b) => a.table.localeCompare(b.table)));

      const selFk = db!.all<{ table: string; from: string; to: string; on_delete: string }>(
        "PRAGMA foreign_key_list(run_provider_selections)",
      ).map(({ table, from, to, on_delete }) => ({ table, from, to, on_delete }));
      expect(selFk).toEqual([{ table: "agent_runs", from: "run_id", to: "id", on_delete: "CASCADE" }]);

      expect(db!.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name='idx_provider_credentials_secret_name'")?.sql)
        .toContain("provider_credentials(secret_name)");
      expect(db!.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name='idx_run_provider_selections_provider_revision'")?.sql)
        .toContain("run_provider_selections(provider_id, config_revision)");

      expect(() => db!.run(
        "INSERT INTO provider_configurations(provider_id,enabled,selected_auth_method,config_json,model_selection_json,current_revision,created_at,updated_at) VALUES('openai',2,'api-key','{}','{}',1,$now,$now)",
        { now: NOW },
      )).toThrow(/CHECK constraint failed/i);
      expect(() => db!.run(
        "INSERT INTO provider_config_snapshots(provider_id,revision,selected_auth_method,config_json,model_selection_json,captured_at) VALUES('openai',0,'api-key','{}','{}',$now)",
        { now: NOW },
      )).toThrow(/CHECK constraint failed/i);
      expect(() => db!.run(
        "INSERT INTO provider_credentials(provider_id,auth_method_id,secret_name,reference_id,status,created_at,updated_at) VALUES('openai','api-key','n','r','BOGUS',$now,$now)",
        { now: NOW },
      )).toThrow(/CHECK constraint failed/i);
      expect(() => db!.run(
        "INSERT INTO run_provider_selections(run_id,provider_id,model_id,auth_method_id,config_revision,created_at) VALUES('run','openai','m','api-key',0,$now)",
        { now: NOW },
      )).toThrow(/CHECK constraint failed/i);

      // FK: ссылка на отсутствующие строки отклоняется.
      expect(() => db!.run(
        "INSERT INTO provider_config_snapshots(provider_id,revision,selected_auth_method,config_json,model_selection_json,captured_at) VALUES('missing',1,'api-key','{}','{}',$now)",
        { now: NOW },
      )).toThrow(/FOREIGN KEY/i);
      expect(() => db!.run(
        "INSERT INTO provider_credentials(provider_id,auth_method_id,secret_name,reference_id,status,created_at,updated_at) VALUES('missing','api-key','n','missing-ref','ACTIVE',$now,$now)",
        { now: NOW },
      )).toThrow(/FOREIGN KEY/i);
      expect(() => db!.run(
        "INSERT INTO run_provider_selections(run_id,provider_id,model_id,auth_method_id,config_revision,created_at) VALUES('missing-run','openai','m','api-key',1,$now)",
        { now: NOW },
      )).toThrow(/FOREIGN KEY/i);

      expect(db!.all("PRAGMA foreign_key_check")).toEqual([]);
      expect(db!.get<{ applied: number }>("SELECT COUNT(*) AS applied FROM schema_migrations")!.applied).toBe(55);
    });
  });

  describe("populated upgrade 048 -> 049", () => {
    it("adds provider tables without touching existing rows or schema", () => {
      freshDb();
      const migrations = loadTestMigrations();
      const through048 = migrations.filter(({ version }) => version <= 48);
      expect(runMigrations(db!, through048).applied).toBe(48);

      const runId = randomUUID();
      db!.run("INSERT INTO agent_runs(id,role,runtime,model,status) VALUES($id,'developer','hermes','test-model','COMPLETED')", { id: runId });
      db!.run(
        "INSERT INTO secrets(reference_id,service,name,created_at,updated_at) VALUES('existing-ref','ai-provider','prov:openai:api-key',$now,$now)",
        { now: NOW },
      );
      const runsBefore = db!.all("SELECT * FROM agent_runs");
      const secretsBefore = db!.all("SELECT * FROM secrets");

      expect(runMigrations(db!, migrations).applied).toBe(7);
      expect(db!.all("SELECT * FROM agent_runs")).toEqual(runsBefore);
      expect(db!.all("SELECT * FROM secrets")).toEqual(secretsBefore);

      // Миграция 051 добавила таблицу пользовательских моделей без FK на provider_configurations.
      expect(db!.all<{ name: string }>("PRAGMA table_info(provider_custom_models)").map(({ name }) => name))
        .toEqual(["provider_id", "model_id", "display_name", "created_at"]);

      // Новые таблицы доступны и связаны корректно.
      db!.run(
        `INSERT INTO provider_configurations(provider_id,enabled,selected_auth_method,config_json,model_selection_json,current_revision,created_at,updated_at)
         VALUES('openai',1,'api-key','{"endpoint":"https://api.openai.com/v1"}','{"defaultModelId":"gpt-4o","roleDefaults":{"developer":"gpt-4o"}}',1,$now,$now)`,
        { now: NOW },
      );
      db!.run(
        `INSERT INTO provider_credentials(provider_id,auth_method_id,secret_name,reference_id,status,created_at,updated_at)
         VALUES('openai','api-key','prov:openai:api-key','existing-ref','ACTIVE',$now,$now)`,
        { now: NOW },
      );
      db!.run(
        "INSERT INTO run_provider_selections(run_id,provider_id,model_id,auth_method_id,config_revision,created_at) VALUES($id,'openai','gpt-4o','api-key',1,$now)",
        { id: runId, now: NOW },
      );
      expect(db!.get<{ revision: number }>("SELECT current_revision AS revision FROM provider_configurations WHERE provider_id='openai'"))
        .toEqual({ revision: 1 });
      expect(db!.all("PRAGMA foreign_key_check")).toEqual([]);
      expect(db!.get("SELECT run_id,provider_id,model_id,auth_method_id,config_revision FROM run_provider_selections"))
        .toEqual({ run_id: runId, provider_id: "openai", model_id: "gpt-4o", auth_method_id: "api-key", config_revision: 1 });

      // Каскад: удаление Run удаляет selection.
      db!.run("DELETE FROM agent_runs WHERE id=$id", { id: runId });
      expect(db!.all("SELECT * FROM run_provider_selections")).toEqual([]);
      expect(db!.all("PRAGMA foreign_key_check")).toEqual([]);
    });
  });

  describe("no plaintext and fail-closed credentials consistency", () => {
    it("stores no secret values in database rows, WAL-readable projections or files", async () => {
      const path = freshDb();
      runMigrations(db!, loadTestMigrations());

      const secretValue = "sk-THE-SECRET-VALUE-12345";
      const values = new Map<string, string>();
      const backend: KeyringBackend = {
        async setPassword(_service, account, value) {
          values.set(account, value);
        },
        async getPassword(_service, account) {
          return values.get(account);
        },
        async deletePassword(_service, account) {
          values.delete(account);
        },
      };
      const store = new KeyringSecretStore(db!, { backend });
      const repository = createProviderSettingsRepository(db!);
      const credentialStore = createProviderCredentialStore(store, repository);
      const service = createProviderSettingsService(repository, credentialStore, store);

      service.saveSettings({
        providerId: "openai",
        enabled: true,
        selectedAuthMethod: "api-key",
        config: { endpoint: "https://api.openai.com/v1" },
        modelSelection: { defaultModelId: "gpt-4o", roleDefaults: {} },
      });
      await service.saveCredential("openai", "api-key", { apiKey: secretValue });

      // Запросные проекции не содержат значения.
      const secretsRows = db!.all("SELECT * FROM secrets");
      const credentialRows = db!.all("SELECT * FROM provider_credentials");
      expect(JSON.stringify(secretsRows)).not.toContain(secretValue);
      expect(JSON.stringify(credentialRows)).not.toContain(secretValue);
      expect(JSON.stringify(service.getProviderStatus("openai")!)).not.toContain(secretValue);
      expect(JSON.stringify(repository.getProviderConfiguration("openai")!)).not.toContain(secretValue);
      expect(credentialRows).toEqual([
        expect.objectContaining({
          provider_id: "openai",
          auth_method_id: "api-key",
          secret_name: "prov:openai:api-key",
          status: "ACTIVE",
        }),
      ]);
      expect(secretsRows).toEqual([
        expect.objectContaining({ service: PROVIDER_CREDENTIAL_SERVICE, name: "prov:openai:api-key" }),
      ]);
      expect((secretsRows[0] as { reference_id: string }).reference_id).toBe(
        (credentialRows[0] as { reference_id: string }).reference_id,
      );

      // Файловые представления БД (включая WAL) не содержат plaintext-значения.
      db!.close();
      db = undefined;
      for (const suffix of ["", "-wal"]) {
        const content = await readFile(path + suffix).catch(() => Buffer.alloc(0));
        expect(content.toString("utf8")).not.toContain(secretValue);
      }
    });

    it("failed keyring write leaves prior DB metadata and credential state consistent", async () => {
      freshDb();
      runMigrations(db!, loadTestMigrations());
      const backend: KeyringBackend = {
        async setPassword() {
          throw new Error("OS keyring unavailable");
        },
        async getPassword() {
          return undefined;
        },
        async deletePassword() {},
      };
      const store = new KeyringSecretStore(db!, { backend });
      const repository = createProviderSettingsRepository(db!);
      const credentialStore = createProviderCredentialStore(store, repository);
      const service = createProviderSettingsService(repository, credentialStore, store);

      service.saveSettings({
        providerId: "openai",
        enabled: true,
        selectedAuthMethod: "api-key",
        config: {},
        modelSelection: { defaultModelId: "gpt-4o", roleDefaults: {} },
      });

      await expect(service.saveCredential("openai", "api-key", { apiKey: "should-not-persist" }))
        .rejects.toThrow(/unavailable/i);

      expect(db!.all("SELECT * FROM provider_credentials")).toEqual([]);
      expect(db!.all("SELECT * FROM secrets")).toEqual([]);
      expect(await store.listMetadata(PROVIDER_CREDENTIAL_SERVICE)).toEqual([]);
      expect(repository.getProviderConfiguration("openai")!.currentRevision).toBe(1);
      expect(db!.all("PRAGMA foreign_key_check")).toEqual([]);
    });
  });
});
