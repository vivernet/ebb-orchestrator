import { describe, expect, it } from "vitest";
import {
  AUTH_METHODS_ALLOWING_NO_SECRET,
  REQUIRED_ROLE_MODEL_CAPABILITIES,
  resolveRunProviderSelection,
  RunProviderSelectionError,
  type ProviderSelectionReader,
} from "../../../../src/modules/runtime/providers/run-provider-selection.js";
import type {
  ProviderConfigurationRecord,
  ProviderCredentialMetadataRecord,
} from "../../../../src/modules/runtime/providers/provider-settings-repository.js";

function config(overrides: Partial<ProviderConfigurationRecord> = {}): ProviderConfigurationRecord {
  return {
    providerId: "openai",
    enabled: true,
    selectedAuthMethod: "api-key",
    config: {},
    modelSelection: { defaultModelId: "gpt-4o", roleDefaults: {} },
    currentRevision: 3,
    createdAt: "2026-10-23T00:00:00.000Z",
    updatedAt: "2026-10-23T00:00:00.000Z",
    ...overrides,
  };
}

function credential(overrides: Partial<ProviderCredentialMetadataRecord> = {}): ProviderCredentialMetadataRecord {
  return {
    providerId: "openai",
    authMethodId: "api-key",
    secretName: "prov:openai:api-key",
    referenceId: "ref-1",
    status: "ACTIVE",
    createdAt: "2026-10-23T00:00:00.000Z",
    updatedAt: "2026-10-23T00:00:00.000Z",
    ...overrides,
  };
}

function reader(records: { configs?: ProviderConfigurationRecord[]; credentials?: ProviderCredentialMetadataRecord[] } = {}): ProviderSelectionReader {
  const configs = records.configs ?? [];
  const credentials = records.credentials ?? [];
  return {
    getProviderConfiguration: (providerId) => configs.find((c) => c.providerId === providerId),
    listProviderConfigurations: () => [...configs],
    getCredentialMetadata: (providerId, authMethodId) =>
      credentials.find((c) => c.providerId === providerId && c.authMethodId === authMethodId),
  };
}

describe("resolveRunProviderSelection", () => {
  it("returns null when no provider configuration exists (legacy path preserved)", () => {
    expect(resolveRunProviderSelection({ model: "default", role: "developer" }, reader())).toBeNull();
  });

  it("returns null when no enabled provider declares a default for the role", () => {
    const r = reader({ configs: [config({ providerId: "openai", enabled: false })] });
    expect(resolveRunProviderSelection({ model: "default", role: "developer" }, r)).toBeNull();
  });

  it("resolves the global default deterministically and requires an active credential", () => {
    const r = reader({ configs: [config()], credentials: [credential()] });
    const resolved = resolveRunProviderSelection({ model: "default", role: "developer" }, r);
    expect(resolved).toEqual({
      source: "global-default",
      providerId: "openai",
      modelId: "gpt-4o",
      authMethodId: "api-key",
      configRevision: 3,
    });
  });

  it("prefers the exact role default over the global default", () => {
    const r = reader({
      configs: [config({ modelSelection: { defaultModelId: "gpt-4o", roleDefaults: { developer: "gpt-4o-mini" } } })],
      credentials: [credential()],
    });
    const resolved = resolveRunProviderSelection({ model: "default", role: "developer" }, r);
    expect(resolved).toMatchObject({ source: "role-default", modelId: "gpt-4o-mini" });
  });

  it("scans enabled providers in provider_id order and picks the first valid default", () => {
    const r = reader({
      configs: [
        config({ providerId: "anthropic", modelSelection: { defaultModelId: "claude-sonnet-4-6", roleDefaults: {} } }),
        config({ providerId: "openai" }),
      ],
      credentials: [credential(), credential({ providerId: "anthropic" })],
    });
    const resolved = resolveRunProviderSelection({ model: "default", role: "developer" }, r);
    expect(resolved).toMatchObject({ providerId: "anthropic", modelId: "claude-sonnet-4-6", source: "global-default" });
  });

  it("fails closed when the first default-carrying provider has a broken candidate", () => {
    // anthropic стоит раньше openai и несёт дефолт без credential -> fail-closed,
    // а не молчаливый переход к следующему провайдеру.
    const r = reader({
      configs: [
        config({ providerId: "anthropic", modelSelection: { defaultModelId: "claude-sonnet-4-6", roleDefaults: {} } }),
        config(),
      ],
      credentials: [credential()],
    });
    try {
      resolveRunProviderSelection({ model: "default", role: "developer" }, r);
      expect.unreachable();
    } catch (error) {
      expect((error as RunProviderSelectionError).code).toBe("RUN_REQUEST_PROVIDER_CREDENTIAL_MISSING");
    }
  });

  it("explicit override wins over defaults and validates the full binding", () => {
    const r = reader({ configs: [config()], credentials: [credential()] });
    const resolved = resolveRunProviderSelection(
      { explicit: { providerId: "openai", modelId: "gpt-4o-mini" }, model: "default", role: "reviewer" },
      r,
    );
    expect(resolved).toMatchObject({ source: "explicit", modelId: "gpt-4o-mini" });
  });

  it("resolves unknown provider for explicit override as a typed fail-closed error", () => {
    const r = reader({ configs: [config()], credentials: [credential()] });
    try {
      resolveRunProviderSelection({ explicit: { providerId: "nope" }, model: "default", role: "developer" }, r);
      expect.unreachable();
    } catch (error) {
      expect((error as RunProviderSelectionError).code).toBe("RUN_REQUEST_PROVIDER_UNKNOWN");
    }
  });

  it("rejects a disabled provider with a typed error", () => {
    const r = reader({ configs: [config({ enabled: false })], credentials: [credential()] });
    try {
      resolveRunProviderSelection({ explicit: { providerId: "openai" }, model: "default", role: "developer" }, r);
      expect.unreachable();
    } catch (error) {
      expect((error as RunProviderSelectionError).code).toBe("RUN_REQUEST_PROVIDER_DISABLED");
    }
  });

  it("rejects an unknown model for the provider, keeping RUN_REQUEST_MODEL_UNSUPPORTED", () => {
    const r = reader({ configs: [config()], credentials: [credential()] });
    try {
      resolveRunProviderSelection({ explicit: { providerId: "openai", modelId: "no-such-model" }, model: "default", role: "developer" }, r);
      expect.unreachable();
    } catch (error) {
      expect((error as RunProviderSelectionError).code).toBe("RUN_REQUEST_MODEL_UNSUPPORTED");
    }
  });

  it("rejects a model that lacks capabilities required for the role", () => {
    // cloudflare @cf/qwen/qwq-32b существует в каталоге, но не поддерживает toolCalling.
    const r = reader({
      configs: [config({ providerId: "cloudflare", selectedAuthMethod: "api-key", modelSelection: { defaultModelId: "@cf/qwen/qwq-32b", roleDefaults: {} } })],
      credentials: [credential({ providerId: "cloudflare" })],
    });
    try {
      resolveRunProviderSelection({ model: "default", role: "developer" }, r);
      expect.unreachable();
    } catch (error) {
      expect((error as RunProviderSelectionError).code).toBe("RUN_REQUEST_PROVIDER_CAPABILITY_UNSUPPORTED");
    }
  });

  it("rejects an undeclared auth method", () => {
    const r = reader({ configs: [config()], credentials: [credential()] });
    // openai объявляет только api-key; oauth-device-code не объявлен.
    try {
      resolveRunProviderSelection({ explicit: { providerId: "openai", authMethodId: "oauth-device-code" }, model: "default", role: "developer" }, r);
      expect.unreachable();
    } catch (error) {
      expect((error as RunProviderSelectionError).code).toBe("RUN_REQUEST_AUTH_METHOD_UNKNOWN");
    }
  });

  it("rejects a missing active credential for secret-bound auth methods", () => {
    const r = reader({ configs: [config()] });
    try {
      resolveRunProviderSelection({ model: "default", role: "developer" }, r);
      expect.unreachable();
    } catch (error) {
      expect((error as RunProviderSelectionError).code).toBe("RUN_REQUEST_PROVIDER_CREDENTIAL_MISSING");
    }
  });

  it("allows local-endpoint auth without a credential", () => {
    const r = reader({
      configs: [config({ providerId: "ollama", selectedAuthMethod: "local-endpoint", modelSelection: { defaultModelId: "qwen2.5", roleDefaults: {} } })],
    });
    const resolved = resolveRunProviderSelection({ model: "default", role: "developer" }, r);
    expect(resolved).toMatchObject({ providerId: "ollama", authMethodId: "local-endpoint" });
  });

  it("does not resolve legacy explicit non-provider models (Hermes built-in path)", () => {
    const r = reader({ configs: [config()], credentials: [credential()] });
    expect(resolveRunProviderSelection({ model: "gpt-4o", role: "developer" }, r)).toBeNull();
  });

  it("declares the required role capabilities and the no-secret auth set", () => {
    expect(REQUIRED_ROLE_MODEL_CAPABILITIES).toEqual(["chat", "toolCalling"]);
    expect(AUTH_METHODS_ALLOWING_NO_SECRET.has("local-endpoint")).toBe(true);
  });
});
