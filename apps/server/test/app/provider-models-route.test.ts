/**
 * Маршруты модельного каталога провайдеров (plan-24, Task 6): список моделей
 * (каталог + custom), add/remove пользовательских моделей с валидацией,
 * refresh из API через мок-шлюз без возврата секретов/тел ответов.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app/create-app.js";
import { createSqliteDatabase } from "../../src/platform/database/sqlite-database.js";
import { runMigrations } from "../../src/platform/database/migrator.js";
import { SchedulerService } from "../../src/modules/scheduler/scheduler-service.js";
import { createTestAuthService, TEST_COOKIE, TEST_CSRF_TOKEN } from "../helpers/auth.js";
import { loadTestMigrations } from "../helpers/migrations.js";
import { createProviderSettingsRepository } from "../../src/modules/runtime/providers/provider-settings-repository.js";
import { createProviderCredentialStore } from "../../src/modules/runtime/providers/provider-credential-store.js";
import { ProviderSettingsService } from "../../src/modules/runtime/providers/provider-settings-service.js";
import { InMemorySecretStore } from "../../src/platform/security/secret-store.js";
import { createMockGateway } from "../modules/runtime/providers/auth/helpers.js";
import { createProviderCustomModelsRepository } from "../../src/modules/runtime/providers/provider-management.js";
import { ProviderNetworkGateway, ProviderGatewayError } from "../../src/modules/runtime/providers/provider-network-gateway.js";
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

function makeApp(options: { gateway?: ProviderNetworkGateway } = {}) {
  const db = createSqliteDatabase(":memory:");
  runMigrations(db, loadTestMigrations());
  const scheduler = new SchedulerService(db);
  const repository = createProviderSettingsRepository(db);
  const secretStore = new InMemorySecretStore(db);
  const credentialStore = createProviderCredentialStore(secretStore, repository);
  const service = new ProviderSettingsService(repository, credentialStore, secretStore);
  const gateway = options.gateway ?? createMockGateway().gateway;
  const customModels = createProviderCustomModelsRepository(db);
  const app = createApp({
    db, scheduler, runtime: mockRuntime, authService: createTestAuthService(),
    providerSettings: { service, gateway },
    providerModels: { service, gateway, customModels, credentialStore },
  });
  return { app, db, service, customModels, credentialStore };
}

const headers = { cookie: TEST_COOKIE, origin: ORIGIN, "x-csrf-token": TEST_CSRF_TOKEN };

afterEach(() => {
  // In-memory базы закрываются сами.
});

describe("provider-models routes: список и пользовательские модели", () => {
  it("GET models для openai возвращает каталог; неизвестный провайдер → 404", async () => {
    const { app } = makeApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/providers/openai/models", headers: { cookie: TEST_COOKIE } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.providerId).toBe("openai");
    expect(body.source).toBe("catalog");
    expect(body.entries.length).toBeGreaterThan(0);
    expect(body.entries.every((entry: { origin: string }) => entry.origin === "catalog")).toBe(true);

    const unknown = await app.inject({ method: "GET", url: "/api/v1/providers/nope/models", headers: { cookie: TEST_COOKIE } });
    expect(unknown.statusCode).toBe(404);
    await app.close();
  });

  it("добавление/удаление пользовательской модели с валидацией формата", async () => {
    const { app } = makeApp();
    const add = await app.inject({
      method: "POST",
      url: "/api/v1/providers/openai/models/custom",
      payload: { modelId: "my-custom-model", displayName: "Моя модель" },
      headers,
    });
    expect(add.statusCode).toBe(201);
    expect(add.json().modelId).toBe("my-custom-model");

    const list = await app.inject({ method: "GET", url: "/api/v1/providers/openai/models", headers: { cookie: TEST_COOKIE } });
    const custom = list.json().entries.find((entry: { modelId: string }) => entry.modelId === "my-custom-model");
    expect(custom).toBeTruthy();
    expect(custom.origin).toBe("custom");
    expect(custom.displayName).toBe("Моя модель");

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/v1/providers/openai/models/custom",
      payload: { modelId: "my-custom-model" },
      headers,
    });
    expect(duplicate.statusCode).toBe(400);

    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/providers/openai/models/custom",
      payload: { modelId: "has space" },
      headers,
    });
    expect(invalid.statusCode).toBe(400);

    const remove = await app.inject({ method: "DELETE", url: "/api/v1/providers/openai/models/custom/my-custom-model", headers });
    expect(remove.statusCode).toBe(204);
    const again = await app.inject({ method: "DELETE", url: "/api/v1/providers/openai/models/custom/my-custom-model", headers });
    expect(again.statusCode).toBe(404);
    await app.close();
  });

  it("custom модели недоступны без репозитория → 503", async () => {
    const db = createSqliteDatabase(":memory:");
    runMigrations(db, loadTestMigrations());
    const scheduler = new SchedulerService(db);
    const app = createApp({ db, scheduler, runtime: mockRuntime, authService: createTestAuthService(), providerModels: {} });
    const response = await app.inject({ method: "GET", url: "/api/v1/providers/openai/models", headers: { cookie: TEST_COOKIE } });
    expect(response.statusCode).toBe(503);
    await app.close();
  });
});

describe("provider-models routes: refresh из API", () => {
  function configureNewApi(app: ReturnType<typeof createApp>, endpoint: string) {
    return app.inject({
      method: "PUT",
      url: "/api/v1/providers/newapi/config",
      payload: {
        enabled: true,
        selectedAuthMethod: "api-key",
        config: { endpoint },
        modelSelection: { defaultModelId: null, roleDefaults: {} },
      },
      headers,
    });
  }

  it("refresh возвращает модели из API через шлюз без секретов/тел", async () => {
    const mock = createMockGateway();
    mock.respond((_params, index) => {
      if (index === 0) return { status: 200, body: JSON.stringify({ data: [{ id: "api-model-1", display_name: "API Model 1" }] }) };
      return { status: 200, body: "{}" };
    });
    const { app } = makeApp({ gateway: mock.gateway });
    await configureNewApi(app, "https://api.newapi.example.com/v1");

    const refresh = await app.inject({ method: "POST", url: "/api/v1/providers/newapi/models/refresh", headers });
    expect(refresh.statusCode).toBe(200);
    const body = refresh.json();
    expect(body.source).toBe("api");
    expect(body.refreshedAt).toBeTruthy();
    expect(body.entries).toEqual([
      expect.objectContaining({ modelId: "api-model-1", displayName: "API Model 1", origin: "api" }),
    ]);
    expect(JSON.stringify(body)).not.toContain("newapi.example.com");
    expect(JSON.stringify(body)).not.toContain("Bearer");
    expect(mock.calls[0]?.path).toContain("/models");
    await app.close();
  });

  it("refresh использует сохранённый credential в заголовке Authorization (без эха)", async () => {
    const mock = createMockGateway();
    mock.respond(() => ({ status: 200, body: JSON.stringify({ data: [{ id: "m1" }] }) }));
    const { app } = makeApp({ gateway: mock.gateway });
    await configureNewApi(app, "https://api.newapi.example.com/v1");
    await app.inject({
      method: "PUT",
      url: "/api/v1/providers/newapi/credential",
      payload: { authMethodId: "api-key", fields: { apiKey: "sk-refresh-secret" } },
      headers,
    });
    await app.inject({ method: "POST", url: "/api/v1/providers/newapi/models/refresh", headers });
    const authorization = mock.calls[0]?.headers?.authorization;
    expect(typeof authorization).toBe("string");
    // Credential прикрепляется к запросу refresh (значение не покидает шлюз).
    expect(String(authorization).startsWith("Bearer ")).toBe(true);
    expect(String(authorization)).toContain("sk-refresh-secret");
    await app.close();
  });

  it("401 от API → типизированный auth-required", async () => {
    const mock = createMockGateway();
    mock.respond(() => ({ status: 401, body: "unauthorized" }));
    const { app } = makeApp({ gateway: mock.gateway });
    await configureNewApi(app, "https://api.newapi.example.com/v1");
    const refresh = await app.inject({ method: "POST", url: "/api/v1/providers/newapi/models/refresh", headers });
    expect(refresh.statusCode).toBe(401);
    expect(refresh.json().error.code).toBe("PROVIDER_MODELS_AUTH_REQUIRED");
    await app.close();
  });

  it("таймаут шлюза → 504; провайдер без API-каталога → 400", async () => {
    const mock = createMockGateway();
    mock.respond(() => { throw new ProviderGatewayError("timeout"); });
    const { app } = makeApp({ gateway: mock.gateway });
    await configureNewApi(app, "https://api.newapi.example.com/v1");
    const timeout = await app.inject({ method: "POST", url: "/api/v1/providers/newapi/models/refresh", headers });
    expect(timeout.statusCode).toBe(504);
    expect(timeout.json().error.code).toBe("PROVIDER_MODELS_TIMEOUT");
    await app.close();
  });

  it("refresh для bedrock (без providerCatalog) → 400", async () => {
    const { app } = makeApp();
    const response = await app.inject({ method: "POST", url: "/api/v1/providers/bedrock/models/refresh", headers });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("PROVIDER_MODELS_API_UNAVAILABLE");
    await app.close();
  });
});
