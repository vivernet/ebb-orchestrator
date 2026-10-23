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
import {
  createProviderSettingsRepository,
  ProviderConfigSnapshotUnknownError,
  ProviderConfigurationMissingError,
  type ProviderSettingsRepository,
} from "../../../../src/modules/runtime/providers/provider-settings-repository.js";
import {
  createProviderCredentialStore,
  PROVIDER_CREDENTIAL_SERVICE,
  ProviderCredentialMissingError,
  ProviderCredentialStoreUnavailableError,
  zeroBuffer,
  type ProviderCredentialStore,
} from "../../../../src/modules/runtime/providers/provider-credential-store.js";

function backendWithValues(values: Map<string, string>): KeyringBackend {
  return {
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
}

describe("provider credential store", () => {
  let db: Database;
  let repository: ProviderSettingsRepository;
  let values: Map<string, string>;
  let backend: KeyringBackend;
  let keyring: KeyringSecretStore;
  let store: ProviderCredentialStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ebb-provider-credential-store-"));
    db = createSqliteDatabase(join(tmpDir, `${randomUUID()}.sqlite`));
    runMigrations(db, loadTestMigrations());
    repository = createProviderSettingsRepository(db);
    values = new Map();
    backend = backendWithValues(values);
    keyring = new KeyringSecretStore(db, { backend });
    store = createProviderCredentialStore(keyring, repository);

    repository.saveProviderConfiguration({
      providerId: "openai",
      enabled: true,
      selectedAuthMethod: "api-key",
      config: { endpoint: "https://api.openai.com/v1" },
      modelSelection: { defaultModelId: "gpt-4o", roleDefaults: {} },
    });
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("saveCredential", () => {
    it("stores payload in keyring and returns metadata only", async () => {
      const result = await store.saveCredential("openai", "api-key", { apiKey: "sk-abc" });

      expect(result).toMatchObject({
        providerId: "openai",
        authMethodId: "api-key",
        secretName: "prov:openai:api-key",
        status: "ACTIVE",
      });
      expect(result.referenceId).toMatch(/^keyring_/);
      expect(JSON.stringify(result)).not.toContain("sk-abc");
      expect(values.get("ai-provider/prov:openai:api-key")).toBe(JSON.stringify({ apiKey: "sk-abc" }));

      const metadata = repository.getCredentialMetadata("openai", "api-key");
      expect(metadata?.referenceId).toBe(result.referenceId);
      expect(db.all("SELECT * FROM secrets")).toEqual([
        expect.objectContaining({ service: "ai-provider", name: "prov:openai:api-key", reference_id: result.referenceId }),
      ]);
    });

    it("rejects payloads that are not plain string records or exceed the bound", async () => {
      await expect(store.saveCredential("openai", "api-key", {} as never)).rejects.toThrow(ProviderCredentialMissingError);
      await expect(store.saveCredential("openai", "api-key", { apiKey: 42 } as never)).rejects.toThrow(ProviderCredentialMissingError);
      await expect(store.saveCredential("openai", "api-key", { apiKey: "x".repeat(16 * 1024 + 1) }))
        .rejects.toThrow(ProviderCredentialMissingError);
      expect(values.size).toBe(0);
      expect(repository.listCredentialMetadata("openai")).toEqual([]);
    });

    it("fails closed when provider configuration is missing", async () => {
      await expect(store.saveCredential("missing", "api-key", { apiKey: "sk-abc" }))
        .rejects.toThrow(ProviderConfigurationMissingError);
      expect(values.size).toBe(0);
    });

    it("rotates atomically: replaces the single keyring item and metadata row", async () => {
      const first = await store.saveCredential("openai", "api-key", { apiKey: "sk-first" });
      const second = await store.saveCredential("openai", "api-key", { apiKey: "sk-second" });

      expect(values.size).toBe(1);
      expect(values.get("ai-provider/prov:openai:api-key")).toBe(JSON.stringify({ apiKey: "sk-second" }));
      expect(repository.listCredentialMetadata("openai")).toHaveLength(1);
      expect(repository.getCredentialMetadata("openai", "api-key")?.referenceId).toBe(second.referenceId);
      expect(repository.getCredentialMetadata("openai", "api-key")?.referenceId).not.toBe(first.referenceId);
      expect(db.all("SELECT * FROM secrets")).toHaveLength(1);
    });

    it("compensates keyring revocation when metadata attach fails", async () => {
      const failingRepository = Object.create(repository) as ProviderSettingsRepository;
      failingRepository.attachCredentialMetadata = () => {
        throw new Error("metadata attach failed");
      };
      const storeWithFailingMetadata = createProviderCredentialStore(keyring, failingRepository);

      await expect(storeWithFailingMetadata.saveCredential("openai", "api-key", { apiKey: "sk-abc" }))
        .rejects.toThrow("metadata attach failed");
      expect(values.size).toBe(0);
      expect(repository.listCredentialMetadata("openai")).toEqual([]);
      expect(db.all("SELECT * FROM secrets")).toEqual([]);
    });

    it("fails closed when keyring is unavailable, without plaintext fallback", async () => {
      const unavailable: KeyringBackend = {
        async setPassword() {
          throw new Error("OS keyring unavailable");
        },
        async getPassword() {
          return undefined;
        },
        async deletePassword() {},
      };
      const unavailableStore = new KeyringSecretStore(db, { backend: unavailable });
      const storeWithUnavailableKeyring = createProviderCredentialStore(unavailableStore, repository);

      await expect(storeWithUnavailableKeyring.saveCredential("openai", "api-key", { apiKey: "sk-abc" }))
        .rejects.toThrow(ProviderCredentialStoreUnavailableError);
      expect(repository.listCredentialMetadata("openai")).toEqual([]);
      expect(db.all("SELECT * FROM secrets")).toEqual([]);
      expect(await unavailableStore.listMetadata(PROVIDER_CREDENTIAL_SERVICE)).toEqual([]);
    });
  });

  describe("resolveCredentialForRun", () => {
    beforeEach(async () => {
      await store.saveCredential("openai", "api-key", { apiKey: "sk-secret-value" });
    });

    it("returns secret bytes only for the exact snapshot revision", async () => {
      const bytes = await store.resolveCredentialForRun("openai", "api-key", 1);
      expect(Buffer.from(bytes).toString("utf8")).toBe(JSON.stringify({ apiKey: "sk-secret-value" }));
      expect(bytes).toBeInstanceOf(Uint8Array);

      // Повторное разрешение работает и не мутирует хранилище.
      const again = await store.resolveCredentialForRun("openai", "api-key", 1);
      expect(Buffer.from(again).toString("utf8")).toBe(JSON.stringify({ apiKey: "sk-secret-value" }));
      expect(values.get("ai-provider/prov:openai:api-key")).toBe(JSON.stringify({ apiKey: "sk-secret-value" }));
    });

    it("fails closed on unknown or stale revision", async () => {
      await expect(store.resolveCredentialForRun("openai", "api-key", 999))
        .rejects.toThrow(ProviderConfigSnapshotUnknownError);
      await expect(store.resolveCredentialForRun("openai", "api-key", 0))
        .rejects.toThrow(ProviderConfigSnapshotUnknownError);
    });

    it("fails closed on missing provider, disabled provider and auth method mismatch", async () => {
      await expect(store.resolveCredentialForRun("missing", "api-key", 1))
        .rejects.toThrow(ProviderConfigurationMissingError);

      repository.saveProviderConfiguration({
        providerId: "openai", enabled: false, selectedAuthMethod: "api-key",
        config: {}, modelSelection: { defaultModelId: null, roleDefaults: {} },
      });
      await expect(store.resolveCredentialForRun("openai", "api-key", 2))
        .rejects.toThrow(ProviderCredentialMissingError);

      await expect(store.resolveCredentialForRun("openai", "subscription-token", 1))
        .rejects.toThrow(ProviderCredentialMissingError);
    });

    it("fails closed when credential is not configured, inactive or keyring has no value", async () => {
      await expect(store.resolveCredentialForRun("openai", "subscription-token", 1))
        .rejects.toThrow(ProviderCredentialMissingError);

      repository.attachCredentialMetadata({
        providerId: "openai", authMethodId: "api-key",
        secretName: "prov:openai:api-key", referenceId: repository.getCredentialMetadata("openai", "api-key")!.referenceId,
        status: "DISCONNECTED", now: "2026-10-23T00:00:00.000Z",
      });
      await expect(store.resolveCredentialForRun("openai", "api-key", 1))
        .rejects.toThrow(ProviderCredentialMissingError);

      values.delete("ai-provider/prov:openai:api-key");
      await expect(store.resolveCredentialForRun("openai", "api-key", 1))
        .rejects.toThrow(ProviderCredentialMissingError);
    });

    it("fails closed when keyring is unavailable during resolution", async () => {
      const unavailable: KeyringBackend = {
        async setPassword() {},
        async getPassword() {
          throw new Error("OS keyring read error");
        },
        async deletePassword() {},
      };
      const unavailableStore = new KeyringSecretStore(db, { backend: unavailable });
      const storeWithUnavailableKeyring = createProviderCredentialStore(unavailableStore, repository);

      await expect(storeWithUnavailableKeyring.resolveCredentialForRun("openai", "api-key", 1))
        .rejects.toThrow(ProviderCredentialStoreUnavailableError);
    });
  });

  describe("deleteLocalCredential", () => {
    it("removes keyring item and metadata transactionally", async () => {
      await store.saveCredential("openai", "api-key", { apiKey: "sk-abc" });
      expect(await store.deleteLocalCredential("openai", "api-key")).toBe(true);

      expect(values.size).toBe(0);
      expect(repository.getCredentialMetadata("openai", "api-key")).toBeUndefined();
      expect(db.all("SELECT * FROM secrets")).toEqual([]);
      expect(await keyring.listMetadata(PROVIDER_CREDENTIAL_SERVICE)).toEqual([]);

      expect(await store.deleteLocalCredential("openai", "api-key")).toBe(false);
    });

    it("keeps metadata when keyring revoke fails (fail-closed)", async () => {
      await store.saveCredential("openai", "api-key", { apiKey: "sk-abc" });
      const failing: KeyringBackend = {
        async setPassword() {},
        async getPassword() {
          return undefined;
        },
        async deletePassword() {
          throw new Error("OS keyring delete error");
        },
      };
      const failingStore = new KeyringSecretStore(db, { backend: failing });
      const storeWithFailingKeyring = createProviderCredentialStore(failingStore, repository);

      await expect(storeWithFailingKeyring.deleteLocalCredential("openai", "api-key"))
        .rejects.toThrow(ProviderCredentialStoreUnavailableError);
      expect(repository.getCredentialMetadata("openai", "api-key")).toBeDefined();
    });
  });

  it("zeroBuffer clears secret bytes", () => {
    const buffer = new Uint8Array([1, 2, 3, 4]);
    zeroBuffer(buffer);
    expect(Array.from(buffer)).toEqual([0, 0, 0, 0]);
  });
});
