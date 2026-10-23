import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDatabase } from "../../../../src/platform/database/sqlite-database.js";
import type { Database } from "../../../../src/platform/database/database.js";
import { runMigrations } from "../../../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../../../helpers/migrations.js";
import {
  createProviderSettingsRepository,
  InvalidProviderConfigurationError,
  ProviderConfigSnapshotUnknownError,
  ProviderConfigurationMissingError,
  RunSelectionImmutableError,
  type ProviderSettingsRepository,
} from "../../../../src/modules/runtime/providers/provider-settings-repository.js";

describe("provider settings repository", () => {
  let db: Database;
  let repository: ProviderSettingsRepository;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ebb-provider-settings-repo-"));
    db = createSqliteDatabase(join(tmpDir, `${randomUUID()}.sqlite`));
    runMigrations(db, loadTestMigrations());
    repository = createProviderSettingsRepository(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const baseConfig = { endpoint: "https://api.openai.com/v1" };
  const baseModelSelection = { defaultModelId: "gpt-4o", roleDefaults: { developer: "gpt-4o" } };

  describe("saveProviderConfiguration", () => {
    it("creates provider configuration with revision 1 and an identical snapshot", () => {
      const record = repository.saveProviderConfiguration({
        providerId: "openai",
        enabled: true,
        selectedAuthMethod: "api-key",
        config: baseConfig,
        modelSelection: baseModelSelection,
      });
      expect(record).toMatchObject({
        providerId: "openai",
        enabled: true,
        selectedAuthMethod: "api-key",
        currentRevision: 1,
        config: baseConfig,
        modelSelection: baseModelSelection,
      });
      const snapshot = repository.getConfigSnapshot("openai", 1);
      expect(snapshot).toMatchObject({
        providerId: "openai",
        revision: 1,
        selectedAuthMethod: "api-key",
        config: baseConfig,
        modelSelection: baseModelSelection,
      });
      expect(repository.getProviderConfiguration("openai")).toEqual(record);
      expect(repository.listProviderConfigurations()).toEqual([record]);
    });

    it("is idempotent: identical re-save does not bump revision or add snapshots", () => {
      repository.saveProviderConfiguration({
        providerId: "openai", enabled: true, selectedAuthMethod: "api-key",
        config: baseConfig, modelSelection: baseModelSelection,
      });
      const again = repository.saveProviderConfiguration({
        providerId: "openai", enabled: true, selectedAuthMethod: "api-key",
        config: baseConfig, modelSelection: baseModelSelection,
      });
      expect(again.currentRevision).toBe(1);
      expect(db.all("SELECT revision FROM provider_config_snapshots WHERE provider_id='openai'")).toEqual([{ revision: 1 }]);
    });

    it("bumps revision on config change and retains old snapshots immutable", () => {
      repository.saveProviderConfiguration({
        providerId: "openai", enabled: true, selectedAuthMethod: "api-key",
        config: baseConfig, modelSelection: baseModelSelection,
      });
      const updated = repository.saveProviderConfiguration({
        providerId: "openai", enabled: true, selectedAuthMethod: "api-key",
        config: { endpoint: "https://api.openai.com/v1", region: "us" },
        modelSelection: baseModelSelection,
      });
      expect(updated.currentRevision).toBe(2);

      // Старая ревизия сохраняется и не мутируется.
      const snapshot1 = repository.getConfigSnapshot("openai", 1);
      expect(snapshot1?.config).toEqual(baseConfig);
      expect(snapshot1?.capturedAt).toBeDefined();
      expect(repository.getConfigSnapshot("openai", 2)?.config).toEqual({ endpoint: "https://api.openai.com/v1", region: "us" });
      expect(db.all("SELECT revision FROM provider_config_snapshots WHERE provider_id='openai' ORDER BY revision"))
        .toEqual([{ revision: 1 }, { revision: 2 }]);
    });

    it("bumps revision when enabled toggles", () => {
      repository.saveProviderConfiguration({
        providerId: "openai", enabled: false, selectedAuthMethod: "api-key",
        config: baseConfig, modelSelection: baseModelSelection,
      });
      const enabled = repository.saveProviderConfiguration({
        providerId: "openai", enabled: true, selectedAuthMethod: "api-key",
        config: baseConfig, modelSelection: baseModelSelection,
      });
      expect(enabled.currentRevision).toBe(2);
      expect(enabled.enabled).toBe(true);
    });

    it("rejects invalid shapes and empty ids fail-closed", () => {
      expect(() => repository.saveProviderConfiguration({
        providerId: "", enabled: true, selectedAuthMethod: "api-key",
        config: baseConfig, modelSelection: baseModelSelection,
      })).toThrow(InvalidProviderConfigurationError);
      expect(() => repository.saveProviderConfiguration({
        providerId: "openai", enabled: true, selectedAuthMethod: "",
        config: baseConfig, modelSelection: baseModelSelection,
      })).toThrow(InvalidProviderConfigurationError);
      expect(() => repository.saveProviderConfiguration({
        providerId: "openai", enabled: true, selectedAuthMethod: "api-key",
        config: [] as unknown as Record<string, unknown>, modelSelection: baseModelSelection,
      })).toThrow(InvalidProviderConfigurationError);
      expect(() => repository.saveProviderConfiguration({
        providerId: "openai", enabled: true, selectedAuthMethod: "api-key",
        config: baseConfig, modelSelection: { defaultModelId: 42, roleDefaults: {} } as never,
      })).toThrow(InvalidProviderConfigurationError);
      expect(db.all("SELECT * FROM provider_configurations")).toEqual([]);
      expect(db.all("SELECT * FROM provider_config_snapshots")).toEqual([]);
    });
  });

  describe("credential metadata", () => {
    it("attaches, upserts, lists and removes metadata without values", () => {
      repository.saveProviderConfiguration({
        providerId: "openai", enabled: true, selectedAuthMethod: "api-key",
        config: baseConfig, modelSelection: baseModelSelection,
      });
      db.run("INSERT INTO secrets(reference_id,service,name,created_at,updated_at) VALUES('ref-1','ai-provider','prov:openai:api-key',0,0)");
      db.run("INSERT INTO secrets(reference_id,service,name,created_at,updated_at) VALUES('ref-2','ai-provider','prov:openai:api-key-rotated',0,0)");
      const attached = repository.attachCredentialMetadata({
        providerId: "openai", authMethodId: "api-key",
        secretName: "prov:openai:api-key", referenceId: "ref-1",
        status: "ACTIVE", now: "2026-10-23T00:00:00.000Z",
      });
      expect(attached).toEqual({
        providerId: "openai", authMethodId: "api-key",
        secretName: "prov:openai:api-key", referenceId: "ref-1",
        status: "ACTIVE", createdAt: "2026-10-23T00:00:00.000Z", updatedAt: "2026-10-23T00:00:00.000Z",
      });
      expect(repository.getCredentialMetadata("openai", "api-key")).toEqual(attached);
      expect(repository.listCredentialMetadata("openai")).toEqual([attached]);
      expect(repository.listCredentialMetadata()).toEqual([attached]);

      // Upsert: reference заменяется, createdAt сохраняется, updatedAt обновляется.
      const rotated = repository.attachCredentialMetadata({
        providerId: "openai", authMethodId: "api-key",
        secretName: "prov:openai:api-key", referenceId: "ref-2",
        status: "ACTIVE", now: "2026-10-23T01:00:00.000Z",
      });
      expect(rotated).toMatchObject({ referenceId: "ref-2", createdAt: "2026-10-23T00:00:00.000Z", updatedAt: "2026-10-23T01:00:00.000Z" });
      expect(repository.listCredentialMetadata("openai")).toHaveLength(1);

      expect(repository.removeCredentialMetadata("openai", "api-key")).toBe(true);
      expect(repository.removeCredentialMetadata("openai", "api-key")).toBe(false);
      expect(repository.listCredentialMetadata("openai")).toEqual([]);
    });

    it("fails closed when provider or secret reference row is missing", () => {
      expect(() => repository.attachCredentialMetadata({
        providerId: "missing", authMethodId: "api-key",
        secretName: "prov:missing:api-key", referenceId: "ref-1",
        status: "ACTIVE", now: "2026-10-23T00:00:00.000Z",
      })).toThrow(/FOREIGN KEY/i);

      repository.saveProviderConfiguration({
        providerId: "openai", enabled: true, selectedAuthMethod: "api-key",
        config: baseConfig, modelSelection: baseModelSelection,
      });
      expect(() => repository.attachCredentialMetadata({
        providerId: "openai", authMethodId: "api-key",
        secretName: "prov:openai:api-key", referenceId: "no-such-ref",
        status: "ACTIVE", now: "2026-10-23T00:00:00.000Z",
      })).toThrow(/FOREIGN KEY/i);
      expect(repository.listCredentialMetadata("openai")).toEqual([]);
    });
  });

  describe("run selection snapshots", () => {
    it("creates and reads a run selection bound to an existing config revision", () => {
      repository.saveProviderConfiguration({
        providerId: "openai", enabled: true, selectedAuthMethod: "api-key",
        config: baseConfig, modelSelection: baseModelSelection,
      });
      db.run("INSERT INTO agent_runs(id,role,runtime,model,status) VALUES('run-1','developer','hermes','gpt-4o','STARTED')");

      const selection = repository.createRunSelection({
        runId: "run-1",
        providerId: "openai",
        modelId: "gpt-4o",
        authMethodId: "api-key",
        configRevision: 1,
      });
      expect(selection).toMatchObject({
        runId: "run-1", providerId: "openai", modelId: "gpt-4o",
        authMethodId: "api-key", configRevision: 1,
      });
      expect(repository.getRunSelection("run-1")).toEqual(selection);
    });

    it("fails closed on unknown revision, missing provider and missing run", () => {
      repository.saveProviderConfiguration({
        providerId: "openai", enabled: true, selectedAuthMethod: "api-key",
        config: baseConfig, modelSelection: baseModelSelection,
      });
      db.run("INSERT INTO agent_runs(id,role,runtime,model,status) VALUES('run-1','developer','hermes','gpt-4o','STARTED')");

      expect(() => repository.createRunSelection({
        runId: "run-1", providerId: "openai", modelId: "gpt-4o",
        authMethodId: "api-key", configRevision: 999,
      })).toThrow(ProviderConfigSnapshotUnknownError);
      expect(() => repository.createRunSelection({
        runId: "run-1", providerId: "openai", modelId: "gpt-4o",
        authMethodId: "subscription-token", configRevision: 1,
      })).toThrow(InvalidProviderConfigurationError);
      expect(() => repository.createRunSelection({
        runId: "run-1", providerId: "missing", modelId: "gpt-4o",
        authMethodId: "api-key", configRevision: 1,
      })).toThrow(ProviderConfigurationMissingError);
      expect(() => repository.createRunSelection({
        runId: "missing-run", providerId: "openai", modelId: "gpt-4o",
        authMethodId: "api-key", configRevision: 1,
      })).toThrow(/FOREIGN KEY/i);
      expect(repository.getRunSelection("run-1")).toBeUndefined();
      expect(db.all("SELECT * FROM run_provider_selections")).toEqual([]);
    });

    it("is immutable: second selection for the same run is rejected", () => {
      repository.saveProviderConfiguration({
        providerId: "openai", enabled: true, selectedAuthMethod: "api-key",
        config: baseConfig, modelSelection: baseModelSelection,
      });
      db.run("INSERT INTO agent_runs(id,role,runtime,model,status) VALUES('run-1','developer','hermes','gpt-4o','STARTED')");
      const first = repository.createRunSelection({
        runId: "run-1", providerId: "openai", modelId: "gpt-4o",
        authMethodId: "api-key", configRevision: 1,
      });
      expect(() => repository.createRunSelection({
        runId: "run-1", providerId: "openai", modelId: "other-model",
        authMethodId: "api-key", configRevision: 1,
      })).toThrow(RunSelectionImmutableError);
      expect(repository.getRunSelection("run-1")).toEqual(first);
    });
  });
});
