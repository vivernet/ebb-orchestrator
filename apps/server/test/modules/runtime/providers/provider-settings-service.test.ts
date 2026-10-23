import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDatabase } from "../../../../src/platform/database/sqlite-database.js";
import type { Database } from "../../../../src/platform/database/database.js";
import { runMigrations } from "../../../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../../../helpers/migrations.js";
import { KeyringSecretStore } from "../../../../src/platform/security/keyring-secret-store.js";
import type { KeyringBackend } from "../../../../src/platform/security/keyring-secret-store.js";
import { createProviderSettingsRepository, ProviderConfigurationMissingError } from "../../../../src/modules/runtime/providers/provider-settings-repository.js";
import { createProviderCredentialStore, PROVIDER_CREDENTIAL_SERVICE } from "../../../../src/modules/runtime/providers/provider-credential-store.js";
import { createProviderSettingsService, type ProviderSettingsService } from "../../../../src/modules/runtime/providers/provider-settings-service.js";

describe("provider settings service", () => {
  let db: Database;
  let service: ProviderSettingsService;
  let values: Map<string, string>;
  let keyring: KeyringSecretStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ebb-provider-settings-service-"));
    db = createSqliteDatabase(join(tmpDir, `${randomUUID()}.sqlite`));
    runMigrations(db, loadTestMigrations());
    const repository = createProviderSettingsRepository(db);
    values = new Map();
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
    keyring = new KeyringSecretStore(db, { backend });
    const credentialStore = createProviderCredentialStore(keyring, repository);
    service = createProviderSettingsService(repository, credentialStore, keyring);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("saveSettings", () => {
    it("requires complete data on first save and rejects unknown providers/auth methods", () => {
      expect(() => service.saveSettings({ providerId: "openai" })).toThrow(/Initial provider save requires/i);
      expect(() => service.saveSettings({
        providerId: "not-a-provider",
        enabled: true,
        selectedAuthMethod: "api-key",
        config: {},
        modelSelection: { defaultModelId: null, roleDefaults: {} },
      })).toThrow("PROVIDER_UNKNOWN");
      expect(() => service.saveSettings({
        providerId: "openai",
        enabled: true,
        selectedAuthMethod: "bogus-method",
        config: {},
        modelSelection: { defaultModelId: null, roleDefaults: {} },
      })).toThrow("AUTH_METHOD_UNKNOWN");
      expect(db.all("SELECT * FROM provider_configurations")).toEqual([]);
    });

    it("merges partial updates and bumps revision on change", () => {
      service.saveSettings({
        providerId: "openai",
        enabled: true,
        selectedAuthMethod: "api-key",
        config: { endpoint: "https://api.openai.com/v1" },
        modelSelection: { defaultModelId: "gpt-4o", roleDefaults: { developer: "gpt-4o" } },
      });
      const updated = service.saveSettings({
        providerId: "openai",
        config: { endpoint: "https://api.openai.com/v1", region: "us" },
      });
      expect(updated.currentRevision).toBe(2);
      expect(updated.enabled).toBe(true);
      expect(updated.selectedAuthMethod).toBe("api-key");
      expect(updated.config).toEqual({ endpoint: "https://api.openai.com/v1", region: "us" });
      expect(service.getSettings("openai")).toEqual(updated);
      expect(service.listSettings()).toEqual([updated]);
    });
  });

  describe("saveCredential", () => {
    it("rejects undeclared fields and unknown auth methods; returns metadata only", async () => {
      service.saveSettings({
        providerId: "openai",
        enabled: true,
        selectedAuthMethod: "api-key",
        config: {},
        modelSelection: { defaultModelId: "gpt-4o", roleDefaults: {} },
      });
      await expect(service.saveCredential("openai", "api-key", { apiKey: "sk-abc", notDeclared: "x" }))
        .rejects.toThrow(/not declared/i);
      await expect(service.saveCredential("openai", "bogus", { apiKey: "sk-abc" }))
        .rejects.toThrow("AUTH_METHOD_UNKNOWN");
      await expect(service.saveCredential("not-a-provider", "api-key", { apiKey: "sk-abc" }))
        .rejects.toThrow("PROVIDER_UNKNOWN");

      const result = await service.saveCredential("openai", "api-key", { apiKey: "sk-abc" });
      expect(JSON.stringify(result)).not.toContain("sk-abc");
      expect(result.secretName).toBe("prov:openai:api-key");
    });
  });

  describe("run selection", () => {
    it("creates and reads a run selection through the service", () => {
      service.saveSettings({
        providerId: "openai",
        enabled: true,
        selectedAuthMethod: "api-key",
        config: {},
        modelSelection: { defaultModelId: "gpt-4o", roleDefaults: {} },
      });
      db.run("INSERT INTO agent_runs(id,role,runtime,model,status) VALUES('run-1','developer','hermes','gpt-4o','STARTED')");

      const selection = service.createRunSelection("run-1", {
        providerId: "openai",
        modelId: "gpt-4o",
        authMethodId: "api-key",
        configRevision: 1,
      });
      expect(selection.configRevision).toBe(1);
      expect(service.getRunSelection("run-1")).toEqual(selection);
    });

    it("rejects unknown provider/auth method, empty model and invalid revision", () => {
      expect(() => service.createRunSelection("run-1", {
        providerId: "missing", modelId: "gpt-4o", authMethodId: "api-key", configRevision: 1,
      })).toThrow("PROVIDER_UNKNOWN");
      expect(() => service.createRunSelection("run-1", {
        providerId: "openai", modelId: "gpt-4o", authMethodId: "bogus", configRevision: 1,
      })).toThrow("AUTH_METHOD_UNKNOWN");
      expect(() => service.createRunSelection("run-1", {
        providerId: "openai", modelId: "", authMethodId: "api-key", configRevision: 1,
      })).toThrow(/Model id must not be empty/i);
      expect(() => service.createRunSelection("run-1", {
        providerId: "openai", modelId: "gpt-4o", authMethodId: "api-key", configRevision: 0,
      })).toThrow(/positive integer/i);
    });
  });

  describe("disconnectProvider", () => {
    it("clears local credentials, metadata and configuration; keeps run selections", async () => {
      service.saveSettings({
        providerId: "openai",
        enabled: true,
        selectedAuthMethod: "api-key",
        config: { endpoint: "https://api.openai.com/v1" },
        modelSelection: { defaultModelId: "gpt-4o", roleDefaults: {} },
      });
      await service.saveCredential("openai", "api-key", { apiKey: "sk-abc" });
      db.run("INSERT INTO agent_runs(id,role,runtime,model,status) VALUES('run-1','developer','hermes','gpt-4o','STARTED')");
      service.createRunSelection("run-1", {
        providerId: "openai", modelId: "gpt-4o", authMethodId: "api-key", configRevision: 1,
      });

      const result = await service.disconnectProvider("openai");
      expect(result).toEqual({
        providerId: "openai",
        localDisconnected: true,
        remoteRevoke: "NOT_ATTEMPTED",
        revokedCredentialRefs: [expect.stringMatching(/^keyring_/)],
      });

      expect(values.size).toBe(0);
      expect(await keyring.listMetadata(PROVIDER_CREDENTIAL_SERVICE)).toEqual([]);
      expect(db.all("SELECT * FROM secrets")).toEqual([]);
      expect(db.all("SELECT * FROM provider_credentials")).toEqual([]);
      expect(db.all("SELECT * FROM provider_configurations")).toEqual([]);
      expect(db.all("SELECT * FROM provider_config_snapshots")).toEqual([]);
      // Run-selection snapshot сохраняется (история Run), но разрешение теперь fail-closed.
      expect(service.getRunSelection("run-1")?.providerId).toBe("openai");
      expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
      expect(service.getProviderStatus("openai")).toBeUndefined();

      await expect(service.disconnectProvider("openai")).rejects.toThrow(ProviderConfigurationMissingError);
    });

    it("does not claim remote revocation and reports revoked references", async () => {
      service.saveSettings({
        providerId: "openai",
        enabled: false,
        selectedAuthMethod: "api-key",
        config: {},
        modelSelection: { defaultModelId: null, roleDefaults: {} },
      });
      await service.saveCredential("openai", "api-key", { apiKey: "sk-abc" });
      const result = await service.disconnectProvider("openai");
      expect(result.remoteRevoke).toBe("NOT_ATTEMPTED");
      expect(result.revokedCredentialRefs).toHaveLength(1);
    });
  });

  describe("status projections", () => {
    it("exposes no secret values and reflects credential status", async () => {
      service.saveSettings({
        providerId: "openai",
        enabled: true,
        selectedAuthMethod: "api-key",
        config: { endpoint: "https://api.openai.com/v1" },
        modelSelection: { defaultModelId: "gpt-4o", roleDefaults: { developer: "gpt-4o" } },
      });
      const secretValue = "sk-THE-SECRET-42";
      await service.saveCredential("openai", "api-key", { apiKey: secretValue });

      const status = service.getProviderStatus("openai")!;
      expect(JSON.stringify(status)).not.toContain(secretValue);
      expect(status).toMatchObject({
        providerId: "openai",
        enabled: true,
        selectedAuthMethod: "api-key",
        currentRevision: 1,
        hasCredential: true,
        credentialStatus: "ACTIVE",
        defaultModelId: "gpt-4o",
        roleDefaults: { developer: "gpt-4o" },
      });
      expect(service.listProviderStatuses()).toEqual([status]);
    });

    it("reports NONE when no credential configured", () => {
      service.saveSettings({
        providerId: "openai",
        enabled: true,
        selectedAuthMethod: "api-key",
        config: {},
        modelSelection: { defaultModelId: null, roleDefaults: {} },
      });
      expect(service.getProviderStatus("openai")?.credentialStatus).toBe("NONE");
      expect(service.getProviderStatus("openai")?.hasCredential).toBe(false);
    });
  });
});
