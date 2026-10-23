/**
 * Refresh-ротация токенов (plan-24, Task 4): ротация, конкурентный lock,
 * invalid_grant → мёртвый credential, транзиентные 429/5xx с bounded retries.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  CredentialExpiredError,
  NoRefreshStrategyError,
  TokenRefreshService,
  TransientRefreshError,
} from "../../../../../src/modules/runtime/providers/auth/token-refresh.js";
import { ProviderCredentialMissingError } from "../../../../../src/modules/runtime/providers/provider-credential-store.js";
import { createAuthTestEnv, createMockGateway, type AuthTestEnv } from "./helpers.js";

let env: AuthTestEnv;

afterEach(() => {
  env?.close();
});

describe("token-refresh", () => {
  function makeRefresh(respond: (index: number) => { status: number; body?: string } | { transportError: true }) {
    const m = createMockGateway();
    m.respond((params, index) => {
      expect(params.path).toContain("/oauth/token");
      expect(params.body).toContain("grant_type=refresh_token");
      const r = respond(index);
      if ("transportError" in r) throw new Error("PROVIDER_GATEWAY_TRANSPORT");
      return { status: r.status, body: r.body ?? "" };
    });
    const service = new TokenRefreshService(m.gateway, env.credentialStore, env.repository, {
      sleepMs: async () => {},
    });
    return { service, gateway: m };
  }

  it("ротирует токены: новый access/refresh сохраняется атомарно, наружу — только метаданные", async () => {
    env = createAuthTestEnv();
    env.repository.saveProviderConfiguration({
      providerId: "chatgpt",
      enabled: true,
      selectedAuthMethod: "oauth-device-code",
      config: { endpoint: "https://api.example.com/v1" },
      modelSelection: { defaultModelId: null, roleDefaults: {} },
    });
    await env.credentialStore.saveCredential("chatgpt", "oauth-device-code", {
      oauthAccessToken: "old-at",
      oauthRefreshToken: "old-rt",
    });

    const { service, gateway } = makeRefresh(() => ({
      status: 200,
      body: JSON.stringify({ access_token: "new-at", refresh_token: "new-rt" }),
    }));

    const result = await service.refreshCredential("chatgpt", "oauth-device-code");
    expect(result.rotated).toBe(true);
    expect(result.providerId).toBe("chatgpt");
    expect(JSON.stringify(result)).not.toContain("new-at");
    expect(JSON.stringify(result)).not.toContain("new-rt");

    const payload = await env.credentialStore.readCredentialPayload("chatgpt", "oauth-device-code");
    expect(payload.oauthAccessToken).toBe("new-at");
    expect(payload.oauthRefreshToken).toBe("new-rt");
    expect(gateway.calls).toHaveLength(1);
  });

  it("конкурентный refresh дедуплицируется: один сетевой запрос", async () => {
    env = createAuthTestEnv();
    env.repository.saveProviderConfiguration({
      providerId: "chatgpt",
      enabled: true,
      selectedAuthMethod: "oauth-device-code",
      config: { endpoint: "https://api.example.com/v1" },
      modelSelection: { defaultModelId: null, roleDefaults: {} },
    });
    await env.credentialStore.saveCredential("chatgpt", "oauth-device-code", {
      oauthAccessToken: "old-at",
      oauthRefreshToken: "old-rt",
    });

    const { service, gateway } = makeRefresh(() => ({
      status: 200,
      body: JSON.stringify({ access_token: "new-at", refresh_token: "new-rt" }),
    }));

    const [a, b] = await Promise.all([
      service.refreshCredential("chatgpt", "oauth-device-code"),
      service.refreshCredential("chatgpt", "oauth-device-code"),
    ]);
    expect(a.rotated).toBe(true);
    expect(b.rotated).toBe(true);
    expect(gateway.calls).toHaveLength(1);
  });

  it("invalid_grant → CredentialExpiredError и credential помечается DISCONNECTED", async () => {
    env = createAuthTestEnv();
    env.repository.saveProviderConfiguration({
      providerId: "chatgpt",
      enabled: true,
      selectedAuthMethod: "oauth-device-code",
      config: { endpoint: "https://api.example.com/v1" },
      modelSelection: { defaultModelId: null, roleDefaults: {} },
    });
    await env.credentialStore.saveCredential("chatgpt", "oauth-device-code", {
      oauthAccessToken: "old-at",
      oauthRefreshToken: "old-rt",
    });

    const { service } = makeRefresh(() => ({
      status: 400,
      body: JSON.stringify({ error: "invalid_grant" }),
    }));

    await expect(service.refreshCredential("chatgpt", "oauth-device-code")).rejects.toBeInstanceOf(CredentialExpiredError);
    const metadata = env.repository.getCredentialMetadata("chatgpt", "oauth-device-code");
    expect(metadata?.status).toBe("DISCONNECTED");
  });

  it("транзиентный 429 повторяется и завершается успехом", async () => {
    env = createAuthTestEnv();
    env.repository.saveProviderConfiguration({
      providerId: "chatgpt",
      enabled: true,
      selectedAuthMethod: "oauth-device-code",
      config: { endpoint: "https://api.example.com/v1" },
      modelSelection: { defaultModelId: null, roleDefaults: {} },
    });
    await env.credentialStore.saveCredential("chatgpt", "oauth-device-code", {
      oauthAccessToken: "old-at",
      oauthRefreshToken: "old-rt",
    });

    const { service, gateway } = makeRefresh((index) => {
      if (index < 2) return { status: 429, body: "" };
      return { status: 200, body: JSON.stringify({ access_token: "new-at", refresh_token: "new-rt" }) };
    });

    const result = await service.refreshCredential("chatgpt", "oauth-device-code");
    expect(result.rotated).toBe(true);
    expect(gateway.calls).toHaveLength(3);
  });

  it("все 5xx после bounded retries → TransientRefreshError, credential остаётся ACTIVE", async () => {
    env = createAuthTestEnv();
    env.repository.saveProviderConfiguration({
      providerId: "chatgpt",
      enabled: true,
      selectedAuthMethod: "oauth-device-code",
      config: { endpoint: "https://api.example.com/v1" },
      modelSelection: { defaultModelId: null, roleDefaults: {} },
    });
    await env.credentialStore.saveCredential("chatgpt", "oauth-device-code", {
      oauthAccessToken: "old-at",
      oauthRefreshToken: "old-rt",
    });

    const { service, gateway } = makeRefresh(() => ({ status: 503, body: "" }));
    await expect(service.refreshCredential("chatgpt", "oauth-device-code")).rejects.toBeInstanceOf(TransientRefreshError);
    expect(gateway.calls.length).toBeGreaterThan(1);
    expect(gateway.calls.length).toBeLessThanOrEqual(4);
    const metadata = env.repository.getCredentialMetadata("chatgpt", "oauth-device-code");
    expect(metadata?.status).toBe("ACTIVE");
  });

  it("транспортный сбой после retries → TransientRefreshError", async () => {
    env = createAuthTestEnv();
    env.repository.saveProviderConfiguration({
      providerId: "chatgpt",
      enabled: true,
      selectedAuthMethod: "oauth-device-code",
      config: { endpoint: "https://api.example.com/v1" },
      modelSelection: { defaultModelId: null, roleDefaults: {} },
    });
    await env.credentialStore.saveCredential("chatgpt", "oauth-device-code", {
      oauthAccessToken: "old-at",
      oauthRefreshToken: "old-rt",
    });

    const { service } = makeRefresh(() => ({ transportError: true }));
    await expect(service.refreshCredential("chatgpt", "oauth-device-code")).rejects.toBeInstanceOf(TransientRefreshError);
  });

  it("без refreshTokenGrant (githubcopilot) → NoRefreshStrategyError", async () => {
    env = createAuthTestEnv();
    env.repository.saveProviderConfiguration({
      providerId: "githubcopilot",
      enabled: true,
      selectedAuthMethod: "oauth-device-code",
      config: { endpoint: "https://api.example.com/v1" },
      modelSelection: { defaultModelId: null, roleDefaults: {} },
    });
    await env.credentialStore.saveCredential("githubcopilot", "oauth-device-code", {
      oauthAccessToken: "old-at",
      oauthRefreshToken: "old-rt",
      bearerToken: "old-bearer",
    });
    const m = createMockGateway();
    const service = new TokenRefreshService(m.gateway, env.credentialStore, env.repository, { sleepMs: async () => {} });
    await expect(service.refreshCredential("githubcopilot", "oauth-device-code")).rejects.toBeInstanceOf(NoRefreshStrategyError);
    expect(m.calls).toHaveLength(0);
  });

  it("отсутствие refresh-токена в payload → ProviderCredentialMissingError", async () => {
    env = createAuthTestEnv();
    env.repository.saveProviderConfiguration({
      providerId: "chatgpt",
      enabled: true,
      selectedAuthMethod: "oauth-device-code",
      config: { endpoint: "https://api.example.com/v1" },
      modelSelection: { defaultModelId: null, roleDefaults: {} },
    });
    await env.credentialStore.saveCredential("chatgpt", "oauth-device-code", {
      oauthAccessToken: "old-at",
    });
    const m = createMockGateway();
    const service = new TokenRefreshService(m.gateway, env.credentialStore, env.repository, { sleepMs: async () => {} });
    await expect(service.refreshCredential("chatgpt", "oauth-device-code")).rejects.toBeInstanceOf(ProviderCredentialMissingError);
  });
});
