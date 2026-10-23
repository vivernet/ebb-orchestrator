/**
 * Маршруты авторизации провайдеров (plan-24, Task 4): защита сессии/CSRF,
 * безопасные проекции, lifecycle-маршруты.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app/create-app.js";
import { createSqliteDatabase } from "../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../src/platform/database/migrator.js";
import { SchedulerService } from "../../src/modules/scheduler/scheduler-service.js";
import { createTestAuthService, TEST_COOKIE, TEST_CSRF_TOKEN } from "../helpers/auth.js";
import { loadTestMigrations } from "../helpers/migrations.js";
import { ProviderAuthFlowService } from "../../src/modules/runtime/providers/auth/provider-auth-flow.js";
import { createProviderSettingsRepository } from "../../src/modules/runtime/providers/provider-settings-repository.js";
import { createProviderCredentialStore } from "../../src/modules/runtime/providers/provider-credential-store.js";
import { InMemorySecretStore } from "../../src/platform/security/secret-store.js";
import { createMockGateway } from "../modules/runtime/providers/auth/helpers.js";
import type { AgentRuntime } from "../../src/modules/runtime/agent-runtime.js";

const ORIGIN = "http://127.0.0.1:3000";

const mockRuntime: AgentRuntime = {
  active: 0,
  maxActive: 0,
  calls: [],
  async startRun() {},
  async runResult(_runId: string) { return { version: "1.0", summary: "" } as never; },
  async resumeRun() {},
  async cancelRun() {},
  async inspectRun() { throw new Error("not implemented"); },
  async collectResult() { return { success: true, exitCode: 0, output: "", validatedSubmission: false, diagnostics: { runId: "", sessionId: null, stderr: "", exitCode: 0, artifactReferences: [] } } as never; },
  async collectUsage() { return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, cost: 0 }; },
  async healthCheck() { return true; },
};

function deviceStartResponse() {
  return {
    status: 200,
    body: JSON.stringify({
      device_code: "device-code-1",
      user_code: "ABCD-EFGH",
      verification_uri: "https://auth.example.com/device",
      expires_in: 1800,
      interval: 8,
    }),
  };
}

function makeApp(respond?: (index: number) => { status: number; body?: string }) {
  const db = createSqliteDatabase(":memory:");
  runMigrations(db, loadTestMigrations());
  const scheduler = new SchedulerService(db);
  const repository = createProviderSettingsRepository(db);
  const credentialStore = createProviderCredentialStore(new InMemorySecretStore(db), repository);
  repository.saveProviderConfiguration({
    providerId: "chatgpt",
    enabled: true,
    selectedAuthMethod: "oauth-device-code",
    config: { endpoint: "https://api.example.com/v1" },
    modelSelection: { defaultModelId: null, roleDefaults: {} },
  });
  const gateway = createMockGateway();
  if (respond) {
    gateway.respond((_params, index) => {
      const r = respond(index);
      return { status: r.status, body: r.body ?? "" };
    });
  }
  const service = new ProviderAuthFlowService({
    gateway: gateway.gateway,
    credentialStore,
    settingsRepository: repository,
    sleepMs: async () => {},
  });
  const app = createApp({ db, scheduler, runtime: mockRuntime, authService: createTestAuthService(), providerAuthFlows: service });
  return { app, db, service, gateway };
}

afterEach(() => {
  // Базы закрываются сами (in-memory), Fastify не слушает порт.
});

describe("provider-auth routes: защита", () => {
  it("GET без сессии → 401", async () => {
    const { app } = makeApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/providers/auth/status/chatgpt" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("POST без Origin/CSRF → 403", async () => {
    const { app } = makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/providers/auth/start",
      payload: { providerId: "chatgpt", methodId: "oauth-device-code" },
      headers: { cookie: TEST_COOKIE },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("POST без сессии → 401", async () => {
    const { app } = makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/providers/auth/start",
      payload: { providerId: "chatgpt", methodId: "oauth-device-code" },
      headers: { origin: ORIGIN, "x-csrf-token": TEST_CSRF_TOKEN },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });
});

describe("provider-auth routes: lifecycle", () => {
  it("start → 201 с безопасной проекцией; poll → COMPLETE; проекции без токенов", async () => {
    const { app } = makeApp((index) => index === 0 ? deviceStartResponse() : { status: 200, body: JSON.stringify({ access_token: "at-final", refresh_token: "rt-final" }) });
    const headers = { cookie: TEST_COOKIE, origin: ORIGIN, "x-csrf-token": TEST_CSRF_TOKEN };

    const start = await app.inject({
      method: "POST",
      url: "/api/v1/providers/auth/start",
      payload: { providerId: "chatgpt", methodId: "oauth-device-code" },
      headers,
    });
    expect(start.statusCode).toBe(201);
    const body = start.json();
    expect(body.flowId).toBeTruthy();
    expect(body.userCode).toBe("ABCD-EFGH");
    expect(body.verificationUrl).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain("device-code-1");

    const status = await app.inject({ method: "GET", url: `/api/v1/providers/auth/${body.flowId}`, headers });
    expect(status.json().status).toBe("PENDING");

    const poll = await app.inject({ method: "POST", url: `/api/v1/providers/auth/${body.flowId}/poll`, headers });
    expect(poll.statusCode).toBe(200);
    expect(poll.json().status).toBe("COMPLETE");
    expect(JSON.stringify(poll.json())).not.toContain("at-final");
    expect(JSON.stringify(poll.json())).not.toContain("rt-final");

    const providerStatus = await app.inject({ method: "GET", url: "/api/v1/providers/auth/status/chatgpt", headers });
    expect(providerStatus.json().credentialStatus).toBe("ACTIVE");
    expect(providerStatus.json().hasCredential).toBe(true);
    expect(JSON.stringify(providerStatus.json())).not.toContain("at-final");
    await app.close();
  });

  it("cancel → 204; повторный cancel → 409", async () => {
    const { app } = makeApp(() => deviceStartResponse());
    const headers = { cookie: TEST_COOKIE, origin: ORIGIN, "x-csrf-token": TEST_CSRF_TOKEN };
    const start = await app.inject({ method: "POST", url: "/api/v1/providers/auth/start", payload: { providerId: "chatgpt", methodId: "oauth-device-code" }, headers });
    const flowId = start.json().flowId as string;
    const cancel = await app.inject({ method: "POST", url: `/api/v1/providers/auth/${flowId}/cancel`, headers });
    expect(cancel.statusCode).toBe(204);
    const cancelAgain = await app.inject({ method: "POST", url: `/api/v1/providers/auth/${flowId}/cancel`, headers });
    expect(cancelAgain.statusCode).toBe(409);
    await app.close();
  });

  it("disconnect → LOCAL_DISCONNECTED и удаление credential-метаданных", async () => {
    const { app } = makeApp(() => deviceStartResponse());
    const headers = { cookie: TEST_COOKIE, origin: ORIGIN, "x-csrf-token": TEST_CSRF_TOKEN };
    const disconnect = await app.inject({ method: "POST", url: "/api/v1/providers/auth/disconnect", payload: { providerId: "chatgpt" }, headers });
    expect(disconnect.statusCode).toBe(200);
    expect(disconnect.json()).toMatchObject({ localDisconnected: true, remoteRevoke: "LOCAL_DISCONNECTED" });
    const providerStatus = await app.inject({ method: "GET", url: "/api/v1/providers/auth/status/chatgpt", headers });
    expect(providerStatus.json().hasCredential).toBe(false);
    await app.close();
  });

  it("неизвестный провайдер → 404; неинтерактивный метод → 400", async () => {
    const { app } = makeApp();
    const headers = { cookie: TEST_COOKIE, origin: ORIGIN, "x-csrf-token": TEST_CSRF_TOKEN };
    const unknown = await app.inject({ method: "POST", url: "/api/v1/providers/auth/start", payload: { providerId: "nope", methodId: "oauth-device-code" }, headers });
    expect(unknown.statusCode).toBe(404);
    const nonInteractive = await app.inject({ method: "POST", url: "/api/v1/providers/auth/start", payload: { providerId: "openai", methodId: "api-key" }, headers });
    expect(nonInteractive.statusCode).toBe(400);
    await app.close();
  });

  it("несуществующий поток → 404", async () => {
    const { app } = makeApp();
    const headers = { cookie: TEST_COOKIE, origin: ORIGIN, "x-csrf-token": TEST_CSRF_TOKEN };
    const missing = await app.inject({ method: "GET", url: "/api/v1/providers/auth/00000000-0000-0000-0000-000000000000", headers });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });
});
