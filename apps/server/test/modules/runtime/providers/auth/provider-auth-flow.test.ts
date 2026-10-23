/**
 * Жизненный цикл авторизации провайдеров и покрытие стратегий по всем 86
 * провайдерам инвентаризации (plan-24, Task 4).
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  ProviderAuthFlowService,
} from "../../../../../src/modules/runtime/providers/auth/provider-auth-flow.js";
import { PROVIDER_DEFINITIONS, listProviders } from "../../../../../src/modules/runtime/providers/provider-catalog.js";
import {
  INTERACTIVE_AUTH_METHODS,
  PROVIDER_DEVICE_CODE_SPECS,
  listDeviceCodeProviderIds,
} from "../../../../../src/modules/runtime/providers/auth/provider-auth-flow-specs.js";
import type { ProviderAuthFlowSpec, OAuthPkceSpec } from "../../../../../src/modules/runtime/providers/auth/provider-auth-flow-specs.js";
import { ProviderConfigurationMissingError } from "../../../../../src/modules/runtime/providers/provider-settings-repository.js";
import { createAuthTestEnv, createMockGateway, installProviderConfig, type AuthTestEnv } from "./helpers.js";

const SESSION_A = "session-a";
const SESSION_B = "session-b";

const PKCE_SPEC: OAuthPkceSpec = {
  kind: "oauth-pkce",
  clientId: "pkce-client-1",
  authorizationEndpoint: "https://auth.example.com/authorize",
  tokenEndpoint: "https://auth.example.com/token",
  scopes: ["read"],
  redirectUri: "http://127.0.0.1:3000/api/v1/providers/auth/callback",
};

let env: AuthTestEnv;

afterEach(() => {
  env?.close();
});

function makeService(overrides: { now?: () => Date; flowSpecResolver?: (providerId: string, methodId: string) => ProviderAuthFlowSpec | undefined } = {}) {
  const gateway = createMockGateway();
  const service = new ProviderAuthFlowService({
    gateway: gateway.gateway,
    credentialStore: env.credentialStore,
    settingsRepository: env.repository,
    ...(overrides.now ? { now: overrides.now } : {}),
    ...(overrides.flowSpecResolver ? { flowSpecResolver: overrides.flowSpecResolver } : {}),
    sleepMs: async () => {},
  });
  return { service, gateway };
}

function deviceStartResponse() {
  return {
    status: 200,
    body: JSON.stringify({
      device_code: "device-code-1",
      user_code: "ABCD-EFGH",
      verification_uri: "https://auth.example.com/device",
      verification_uri_complete: "https://auth.example.com/device?user_code=ABCD-EFGH",
      expires_in: 1800,
      interval: 8,
    }),
  };
}

describe("инвентаризация: стратегия для каждого auth-метода всех 86 провайдеров", () => {
  it("каждый провайдер имеет ровно одну строку и хотя бы одну стратегию", () => {
    expect(PROVIDER_DEFINITIONS).toHaveLength(86);
    const ids = new Set(PROVIDER_DEFINITIONS.map((p) => p.id));
    expect(ids.size).toBe(86);
    const allMethods = new Set(["api-key", "credential-fields", "subscription-token", "oauth-device-code", "oauth-pkce", "cloud-identity", "local-endpoint"]);
    for (const provider of listProviders()) {
      expect(provider.authMethods.length).toBeGreaterThan(0);
      for (const method of provider.authMethods) {
        expect(allMethods.has(method)).toBe(true);
      }
    }
  });

  it("все device-code провайдеры имеют спецификацию, и наоборот", () => {
    const deviceProviders = PROVIDER_DEFINITIONS.filter((p) => p.authMethods.includes("oauth-device-code")).map((p) => p.id);
    expect([...deviceProviders].sort()).toEqual([...listDeviceCodeProviderIds()].sort());
    for (const id of deviceProviders) {
      expect(PROVIDER_DEVICE_CODE_SPECS[id]).toBeDefined();
    }
    expect(deviceProviders).toEqual(["chatgpt", "githubcopilot", "supergrok"]);
  });

  it("PKCE не объявлен ни одной карточкой; движок покрыт фикстурой", () => {
    const pkceProviders = PROVIDER_DEFINITIONS.filter((p) => p.authMethods.includes("oauth-pkce"));
    expect(pkceProviders).toHaveLength(0);
  });

  it("неинтерактивные методы (api-key/subscription-token/credential-fields/cloud-identity/local-endpoint) не имеют интерактивного begin", () => {
    for (const provider of PROVIDER_DEFINITIONS) {
      for (const method of provider.authMethods) {
        if (INTERACTIVE_AUTH_METHODS.includes(method)) continue;
        // Стратегия для неинтерактивных методов — Task 2 credential store
        // (api-key/subscription-token/credential-fields/cloud-identity) и
        // локальный endpoint; beginAuthorization отклоняет их явно.
        expect(method).toMatch(/^(api-key|subscription-token|credential-fields|cloud-identity|local-endpoint)$/);
      }
    }
  });
});

describe("provider-auth-flow: beginAuthorization", () => {
  it("device: возвращает только публичные данные и сохраняет состояние PENDING", async () => {
    env = createAuthTestEnv();
    installProviderConfig(env.repository, "chatgpt", "oauth-device-code");
    const { service, gateway } = makeService();
    gateway.respond(() => deviceStartResponse());

    const result = await service.beginAuthorization({ providerId: "chatgpt", methodId: "oauth-device-code", sessionBinding: SESSION_A });
    expect(result.flowId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.userCode).toBe("ABCD-EFGH");
    expect(result.verificationUrl).toContain("user_code=ABCD-EFGH");
    expect(result.expiresAt).toBeTruthy();
    expect(result.pollIntervalSeconds).toBe(8);
    expect(JSON.stringify(result)).not.toContain("device-code-1");
    expect(JSON.stringify(result)).not.toContain("token");

    const status = service.getFlowStatus(result.flowId, SESSION_A);
    expect(status.status).toBe("PENDING");
    expect(status.methodId).toBe("oauth-device-code");
    expect(status.providerId).toBe("chatgpt");
  });

  it("unknown provider / unknown method / неинтерактивный метод отклоняются fail-closed", async () => {
    env = createAuthTestEnv();
    const { service } = makeService();
    await expect(service.beginAuthorization({ providerId: "nope", methodId: "oauth-device-code", sessionBinding: SESSION_A }))
      .rejects.toMatchObject({ kind: "PROVIDER_UNKNOWN" });
    await expect(service.beginAuthorization({ providerId: "openai", methodId: "api-key", sessionBinding: SESSION_A }))
      .rejects.toMatchObject({ kind: "AUTH_METHOD_NOT_INTERACTIVE" });
    await expect(service.beginAuthorization({ providerId: "chatgpt", methodId: "oauth-pkce", sessionBinding: SESSION_A }))
      .rejects.toMatchObject({ kind: "AUTH_METHOD_UNKNOWN" });
  });
});

describe("provider-auth-flow: pollAuthorization (device)", () => {
  it("полный цикл pending → complete: токены сохраняются в SecretStore, наружу — нет", async () => {
    env = createAuthTestEnv();
    installProviderConfig(env.repository, "chatgpt", "oauth-device-code");
    const { service, gateway } = makeService();
    gateway.respond((_params, index) => {
      if (index === 0) return deviceStartResponse();
      return { status: 200, body: JSON.stringify({ access_token: "at-final", refresh_token: "rt-final" }) };
    });

    const started = await service.beginAuthorization({ providerId: "chatgpt", methodId: "oauth-device-code", sessionBinding: SESSION_A });
    const pending = await service.pollAuthorization(started.flowId, SESSION_A);
    expect(pending.status).toBe("COMPLETE");

    const credential = env.repository.getCredentialMetadata("chatgpt", "oauth-device-code");
    expect(credential?.status).toBe("ACTIVE");
    const payload = await env.credentialStore.readCredentialPayload("chatgpt", "oauth-device-code");
    expect(payload.oauthAccessToken).toBe("at-final");
    expect(payload.oauthRefreshToken).toBe("rt-final");
    expect(JSON.stringify(pending)).not.toContain("at-final");
    expect(JSON.stringify(pending)).not.toContain("rt-final");
  });

  it("githubcopilot: после токенов обменивается bearer-токен", async () => {
    env = createAuthTestEnv();
    installProviderConfig(env.repository, "githubcopilot", "oauth-device-code");
    const { service, gateway } = makeService();
    gateway.respond((_params, index) => {
      if (index === 0) {
        return { status: 200, body: JSON.stringify({ device_code: "d", user_code: "u", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 }) };
      }
      if (index === 1) {
        return { status: 200, body: JSON.stringify({ access_token: "at-copilot", refresh_token: "rt-copilot" }) };
      }
      return { status: 200, body: JSON.stringify({ token: "bearer-copilot" }) };
    });

    const started = await service.beginAuthorization({ providerId: "githubcopilot", methodId: "oauth-device-code", sessionBinding: SESSION_A });
    const polled = await service.pollAuthorization(started.flowId, SESSION_A);
    expect(polled.status).toBe("COMPLETE");
    const payload = await env.credentialStore.readCredentialPayload("githubcopilot", "oauth-device-code");
    expect(payload.bearerToken).toBe("bearer-copilot");
  });

  it("authorization_pending → PENDING без смены состояния", async () => {
    env = createAuthTestEnv();
    installProviderConfig(env.repository, "chatgpt", "oauth-device-code");
    const { service, gateway } = makeService();
    gateway.respond((_params, index) => {
      if (index === 0) return deviceStartResponse();
      return { status: 400, body: JSON.stringify({ error: "authorization_pending" }) };
    });
    const started = await service.beginAuthorization({ providerId: "chatgpt", methodId: "oauth-device-code", sessionBinding: SESSION_A });
    const result = await service.pollAuthorization(started.flowId, SESSION_A);
    expect(result.status).toBe("PENDING");
  });

  it("access_denied → DENIED", async () => {
    env = createAuthTestEnv();
    installProviderConfig(env.repository, "chatgpt", "oauth-device-code");
    const { service, gateway } = makeService();
    gateway.respond((_params, index) => {
      if (index === 0) return deviceStartResponse();
      return { status: 400, body: JSON.stringify({ error: "access_denied" }) };
    });
    const started = await service.beginAuthorization({ providerId: "chatgpt", methodId: "oauth-device-code", sessionBinding: SESSION_A });
    const result = await service.pollAuthorization(started.flowId, SESSION_A);
    expect(result.status).toBe("DENIED");
    expect(result.failureKind).toBe("denied");
  });

  it("expiry enforcement: после expiresAt опрос переводит в EXPIRED без сети", async () => {
    env = createAuthTestEnv();
    installProviderConfig(env.repository, "chatgpt", "oauth-device-code");
    let nowMs = Date.parse("2030-01-01T00:00:00.000Z");
    const { service, gateway } = makeService({ now: () => new Date(nowMs) });
    gateway.respond((_params, index) => {
      if (index === 0) return deviceStartResponse();
      throw new Error("не должен вызываться после истечения");
    });
    const started = await service.beginAuthorization({ providerId: "chatgpt", methodId: "oauth-device-code", sessionBinding: SESSION_A });
    nowMs += 3600 * 1000;
    const result = await service.pollAuthorization(started.flowId, SESSION_A);
    expect(result.status).toBe("EXPIRED");
    expect(result.failureKind).toBe("expired");
    expect(gateway.calls).toHaveLength(1);
  });

  it("replay: после COMPLETE повторный опрос не выполняет сетевых вызовов", async () => {
    env = createAuthTestEnv();
    installProviderConfig(env.repository, "chatgpt", "oauth-device-code");
    const { service, gateway } = makeService();
    gateway.respond((_params, index) => {
      if (index === 0) return deviceStartResponse();
      return { status: 200, body: JSON.stringify({ access_token: "at", refresh_token: "rt" }) };
    });
    const started = await service.beginAuthorization({ providerId: "chatgpt", methodId: "oauth-device-code", sessionBinding: SESSION_A });
    const first = await service.pollAuthorization(started.flowId, SESSION_A);
    expect(first.status).toBe("COMPLETE");
    const second = await service.pollAuthorization(started.flowId, SESSION_A);
    expect(second.status).toBe("COMPLETE");
    // begin (1) + token poll (1); повторный опрос не выполняет запросов.
    expect(gateway.calls).toHaveLength(2);
  });
});

describe("provider-auth-flow: привязка к сессии", () => {
  it("poll/cancel/getFlowStatus чужой сессией запрещены", async () => {
    env = createAuthTestEnv();
    installProviderConfig(env.repository, "chatgpt", "oauth-device-code");
    const { service, gateway } = makeService();
    gateway.respond(() => deviceStartResponse());
    const started = await service.beginAuthorization({ providerId: "chatgpt", methodId: "oauth-device-code", sessionBinding: SESSION_A });

    await expect(service.pollAuthorization(started.flowId, SESSION_B)).rejects.toMatchObject({ kind: "AUTH_FLOW_SESSION_MISMATCH" });
    expect(() => service.getFlowStatus(started.flowId, SESSION_B)).toThrowError(expect.objectContaining({ kind: "AUTH_FLOW_SESSION_MISMATCH" }));
    expect(() => service.cancelAuthorization(started.flowId, SESSION_B)).toThrowError(expect.objectContaining({ kind: "AUTH_FLOW_SESSION_MISMATCH" }));
  });

  it("cancelAuthorization: PENDING → CANCELLED; терминальный поток не отменяется", async () => {
    env = createAuthTestEnv();
    installProviderConfig(env.repository, "chatgpt", "oauth-device-code");
    const { service, gateway } = makeService();
    gateway.respond(() => deviceStartResponse());
    const started = await service.beginAuthorization({ providerId: "chatgpt", methodId: "oauth-device-code", sessionBinding: SESSION_A });

    expect(service.cancelAuthorization(started.flowId, SESSION_A)).toBe(true);
    expect(service.getFlowStatus(started.flowId, SESSION_A).status).toBe("CANCELLED");
    expect(service.cancelAuthorization(started.flowId, SESSION_A)).toBe(false);
  });

  it("срок действия потока из getFlowStatus переводит в EXPIRED", async () => {
    env = createAuthTestEnv();
    installProviderConfig(env.repository, "chatgpt", "oauth-device-code");
    let nowMs = Date.parse("2030-01-01T00:00:00.000Z");
    const { service, gateway } = makeService({ now: () => new Date(nowMs) });
    gateway.respond(() => deviceStartResponse());
    const started = await service.beginAuthorization({ providerId: "chatgpt", methodId: "oauth-device-code", sessionBinding: SESSION_A });
    nowMs += 3600 * 1000;
    expect(service.getFlowStatus(started.flowId, SESSION_A).status).toBe("EXPIRED");
  });
});

describe("provider-auth-flow: PKCE через резолвер спецификаций", () => {
  function pkceService() {
    env = createAuthTestEnv();
    installProviderConfig(env.repository, "chatgpt", "oauth-device-code");
    return makeService({
      flowSpecResolver: (providerId, methodId) => {
        if (methodId === "oauth-pkce") return PKCE_SPEC;
        return undefined;
      },
    });
  }

  it("begin возвращает authorizationUrl; complete с верным origin сохраняет токены", async () => {
    const { service, gateway } = pkceService();
    gateway.respond((params, index) => {
      if (index === 0) return { status: 200, body: JSON.stringify({ access_token: "at-pkce", refresh_token: "rt-pkce" }) };
      throw new Error("неожиданный вызов");
    });
    const started = await service.beginAuthorization({ providerId: "chatgpt", methodId: "oauth-pkce", sessionBinding: SESSION_A });
    expect(started.verificationUrl).toContain("code_challenge=");
    expect(started.userCode).toBeUndefined();
    expect(started.pollIntervalSeconds).toBe(0);

    const completed = await service.completeAuthorization(
      started.flowId,
      SESSION_A,
      { code: "code-1", state: new URL(started.verificationUrl!).searchParams.get("state") ?? "" },
      "http://127.0.0.1:3000",
    );
    expect(completed.status).toBe("COMPLETE");
    const payload = await env.credentialStore.readCredentialPayload("chatgpt", "oauth-pkce");
    expect(payload.oauthAccessToken).toBe("at-pkce");
  });

  it("callback-origin mismatch → FAILED callback-origin, без сети", async () => {
    const { service, gateway } = pkceService();
    const started = await service.beginAuthorization({ providerId: "chatgpt", methodId: "oauth-pkce", sessionBinding: SESSION_A });
    const completed = await service.completeAuthorization(
      started.flowId,
      SESSION_A,
      { code: "code-1", state: new URL(started.verificationUrl!).searchParams.get("state") ?? "" },
      "https://evil.example.com",
    );
    expect(completed.status).toBe("FAILED");
    expect(completed.failureKind).toBe("callback-origin");
    expect(gateway.calls).toHaveLength(0);
  });

  it("replay: повторный callback после COMPLETE не обменивает код повторно", async () => {
    const { service, gateway } = pkceService();
    gateway.respond(() => ({ status: 200, body: JSON.stringify({ access_token: "at-pkce", refresh_token: "rt-pkce" }) }));
    const started = await service.beginAuthorization({ providerId: "chatgpt", methodId: "oauth-pkce", sessionBinding: SESSION_A });
    const state = new URL(started.verificationUrl!).searchParams.get("state") ?? "";
    const first = await service.completeAuthorization(started.flowId, SESSION_A, { code: "code-1", state }, "http://127.0.0.1:3000");
    expect(first.status).toBe("COMPLETE");
    const second = await service.completeAuthorization(started.flowId, SESSION_A, { code: "code-1", state }, "http://127.0.0.1:3000");
    expect(second.status).toBe("COMPLETE");
    expect(gateway.calls).toHaveLength(1);
  });

  it("state mismatch после старта → FAILED state-mismatch", async () => {
    const { service, gateway } = pkceService();
    const started = await service.beginAuthorization({ providerId: "chatgpt", methodId: "oauth-pkce", sessionBinding: SESSION_A });
    const completed = await service.completeAuthorization(
      started.flowId,
      SESSION_A,
      { code: "code-1", state: "wrong-state" },
      "http://127.0.0.1:3000",
    );
    expect(completed.status).toBe("FAILED");
    expect(completed.failureKind).toBe("state-mismatch");
    expect(gateway.calls).toHaveLength(0);
  });

  it("complete чужой сессией запрещён", async () => {
    const { service } = pkceService();
    const started = await service.beginAuthorization({ providerId: "chatgpt", methodId: "oauth-pkce", sessionBinding: SESSION_A });
    await expect(
      service.completeAuthorization(started.flowId, SESSION_B, { code: "code-1", state: "s" }, "http://127.0.0.1:3000"),
    ).rejects.toMatchObject({ kind: "AUTH_FLOW_SESSION_MISMATCH" });
  });
});

describe("provider-auth-flow: disconnect", () => {
  it("удаляет локальные credentials и отменяет активные потоки; remoteRevoke = LOCAL_DISCONNECTED", async () => {
    env = createAuthTestEnv();
    installProviderConfig(env.repository, "chatgpt", "oauth-device-code");
    await env.credentialStore.saveCredential("chatgpt", "oauth-device-code", {
      oauthAccessToken: "at",
      oauthRefreshToken: "rt",
    });
    const { service, gateway } = makeService();
    gateway.respond(() => deviceStartResponse());
    const started = await service.beginAuthorization({ providerId: "chatgpt", methodId: "oauth-device-code", sessionBinding: SESSION_A });

    const result = await service.disconnectProvider("chatgpt", SESSION_A);
    expect(result.localDisconnected).toBe(true);
    expect(result.remoteRevoke).toBe("LOCAL_DISCONNECTED");
    expect(result.revokedCredentialRefs).toHaveLength(1);
    expect(env.repository.getCredentialMetadata("chatgpt", "oauth-device-code")).toBeUndefined();
    expect(service.getFlowStatus(started.flowId, SESSION_A).status).toBe("CANCELLED");
  });

  it("disconnect без конфигурации → ProviderConfigurationMissingError", async () => {
    env = createAuthTestEnv();
    const { service } = makeService();
    await expect(service.disconnectProvider("chatgpt", SESSION_A)).rejects.toBeInstanceOf(ProviderConfigurationMissingError);
  });
});

describe("provider-auth-flow: status-проекция", () => {
  it("getProviderAuthStatus не содержит секретов и показывает credential/потоки", async () => {
    env = createAuthTestEnv();
    installProviderConfig(env.repository, "chatgpt", "oauth-device-code");
    await env.credentialStore.saveCredential("chatgpt", "oauth-device-code", {
      oauthAccessToken: "at-secret-value-7f3a",
      oauthRefreshToken: "rt-secret-value-9c2e",
    });
    const { service, gateway } = makeService();
    gateway.respond(() => deviceStartResponse());
    const started = await service.beginAuthorization({ providerId: "chatgpt", methodId: "oauth-device-code", sessionBinding: SESSION_A });

    const status = service.getProviderAuthStatus("chatgpt", SESSION_A);
    expect(status.hasCredential).toBe(true);
    expect(status.credentialStatus).toBe("ACTIVE");
    expect(status.activeFlows).toHaveLength(1);
    expect(status.activeFlows[0]!.flowId).toBe(started.flowId);
    expect(JSON.stringify(status)).not.toContain("at-secret-value-7f3a");
    expect(JSON.stringify(status)).not.toContain("rt-secret-value-9c2e");
  });
});
