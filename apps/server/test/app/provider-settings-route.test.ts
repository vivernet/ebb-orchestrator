/**
 * Маршруты настроек провайдеров (plan-24, Task 6): защита сессии/CSRF,
 * безопасные проекции без секретов/endpoint, merge-сохранение, credential
 * write/replace/delete, проверка соединения через мок-шлюз.
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
import { ProviderNetworkGateway, ProviderGatewayError } from "../../src/modules/runtime/providers/provider-network-gateway.js";
import { PROVIDER_CATALOG_PROJECTION } from "@ebb-orchestrator/contracts";
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

interface TestApp {
  app: ReturnType<typeof createApp>;
  db: ReturnType<typeof createSqliteDatabase>;
  service: ProviderSettingsService;
  secretStore: InMemorySecretStore;
}

function makeApp(options: { gateway?: ProviderNetworkGateway } = {}): TestApp {
  const db = createSqliteDatabase(":memory:");
  runMigrations(db, loadTestMigrations());
  const scheduler = new SchedulerService(db);
  const repository = createProviderSettingsRepository(db);
  const secretStore = new InMemorySecretStore(db);
  const credentialStore = createProviderCredentialStore(secretStore, repository);
  const service = new ProviderSettingsService(repository, credentialStore, secretStore);
  const gateway = options.gateway ?? createMockGateway().gateway;
  const app = createApp({ db, scheduler, runtime: mockRuntime, authService: createTestAuthService(), providerSettings: { service, gateway } });
  return { app, db, service, secretStore };
}

const headers = { cookie: TEST_COOKIE, origin: ORIGIN, "x-csrf-token": TEST_CSRF_TOKEN };

afterEach(() => {
  // In-memory базы закрываются сами; Fastify не слушает порт.
});

describe("provider-settings routes: защита и каталог", () => {
  it("GET catalog без сессии → 401", async () => {
    const { app } = makeApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/providers/catalog" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("PUT config без Origin/CSRF → 403", async () => {
    const { app } = makeApp();
    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/providers/openai/config",
      payload: { enabled: true },
      headers: { cookie: TEST_COOKIE },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("GET catalog возвращает 86 записей без schema/секретов/endpoint", async () => {
    const { app } = makeApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/providers/catalog", headers: { cookie: TEST_COOKIE } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.contractVersion).toBe(1);
    expect(body.version).toBe(1);
    expect(body.providers).toHaveLength(86);
    expect(body.providers.length).toBe(PROVIDER_CATALOG_PROJECTION.length);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/"apiKey"\s*:/);
    expect(serialized).not.toMatch(/"endpoint"\s*:/);
    expect(serialized).not.toMatch(/"secret"\s*:/);
    expect(serialized).not.toContain("sk-");
    expect(body.providers[0]).toHaveProperty("id");
    expect(body.providers[0]).toHaveProperty("displayName");
    expect(body.providers[0]).toHaveProperty("capabilities");
    await app.close();
  });

  it("GET detail возвращает schema-метаданные и status после сохранения", async () => {
    const { app, service } = makeApp();
    service.saveSettings({
      providerId: "openai",
      enabled: true,
      selectedAuthMethod: "api-key",
      config: { endpoint: "https://api.openai.com/v1" },
      modelSelection: { defaultModelId: null, roleDefaults: {} },
    });
    const response = await app.inject({ method: "GET", url: "/api/v1/providers/openai", headers: { cookie: TEST_COOKIE } });
    expect(response.statusCode).toBe(200);
    const detail = response.json();
    expect(detail.id).toBe("openai");
    expect(detail.authMethodKinds).toEqual({ "api-key": "form" });
    expect(detail.credentialFields.some((field: { name: string }) => field.name === "apiKey")).toBe(true);
    expect(detail.status.hasCredential).toBe(false);
    expect(detail.status.enabled).toBe(true);
    expect(JSON.stringify(detail)).not.toContain("api.openai.com");

    // Для провайдера с endpoint-полем schema отдаёт его имя (без значений).
    service.saveSettings({
      providerId: "newapi",
      enabled: true,
      selectedAuthMethod: "api-key",
      config: { endpoint: "https://api.newapi.example.com/v1", fetcher: true },
      modelSelection: { defaultModelId: null, roleDefaults: {} },
    });
    const newapi = await app.inject({ method: "GET", url: "/api/v1/providers/newapi", headers: { cookie: TEST_COOKIE } });
    expect(newapi.statusCode).toBe(200);
    expect(newapi.json().configFields.some((field: { name: string }) => field.name === "endpoint")).toBe(true);
    expect(newapi.json().configFields.some((field: { name: string }) => field.name === "fetcher")).toBe(true);
    expect(JSON.stringify(newapi.json())).not.toContain("newapi.example.com");
    await app.close();
  });
});

describe("provider-settings routes: конфигурация и credentials", () => {
  it("сохранение конфигурации не возвращает endpoint/секреты; status обновляется", async () => {
    const { app } = makeApp();
    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/providers/openai/config",
      payload: {
        enabled: true,
        selectedAuthMethod: "api-key",
        config: { endpoint: "https://api.openai.com/v1" },
        modelSelection: { defaultModelId: "gpt-4o", roleDefaults: { developer: "gpt-4o-mini" } },
      },
      headers,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.providerId).toBe("openai");
    expect(body.enabled).toBe(true);
    expect(body.hasCredential).toBe(false);
    expect(body.credentialStatus).toBe("NONE");
    expect(body.defaultModelId).toBe("gpt-4o");
    expect(body.roleDefaults.developer).toBe("gpt-4o-mini");
    expect(JSON.stringify(body)).not.toContain("api.openai.com");
    expect(JSON.stringify(body)).not.toContain("endpoint");
  });

  it("merge-сохранение: отсутствующие поля сохраняют текущее значение", async () => {
    const { app } = makeApp();
    const first = await app.inject({
      method: "PUT",
      url: "/api/v1/providers/openai/config",
      payload: {
        enabled: true,
        selectedAuthMethod: "api-key",
        config: { endpoint: "https://api.openai.com/v1", fetcher: true },
        modelSelection: { defaultModelId: null, roleDefaults: {} },
      },
      headers,
    });
    const revisionAfterFirst = first.json().currentRevision;
    const second = await app.inject({
      method: "PUT",
      url: "/api/v1/providers/openai/config",
      payload: { modelSelection: { defaultModelId: "gpt-4o", roleDefaults: {} } },
      headers,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().currentRevision).toBe(revisionAfterFirst + 1);
    expect(second.json().defaultModelId).toBe("gpt-4o");
    // Идентичная повторная запись не меняет ревизию (идемпотентность).
    const third = await app.inject({
      method: "PUT",
      url: "/api/v1/providers/openai/config",
      payload: { modelSelection: { defaultModelId: "gpt-4o", roleDefaults: {} } },
      headers,
    });
    expect(third.json().currentRevision).toBe(revisionAfterFirst + 1);
  });

  it("credential write/replace/delete: значения наружу не возвращаются", async () => {
    const { app } = makeApp();
    await app.inject({
      method: "PUT",
      url: "/api/v1/providers/openai/config",
      payload: {
        enabled: true,
        selectedAuthMethod: "api-key",
        config: { endpoint: "https://api.openai.com/v1" },
        modelSelection: { defaultModelId: null, roleDefaults: {} },
      },
      headers,
    });
    const write = await app.inject({
      method: "PUT",
      url: "/api/v1/providers/openai/credential",
      payload: { authMethodId: "api-key", fields: { apiKey: "sk-secret-value-123" } },
      headers,
    });
    expect(write.statusCode).toBe(200);
    expect(JSON.stringify(write.json())).not.toContain("sk-secret-value-123");

    const status = await app.inject({ method: "GET", url: "/api/v1/providers/openai/status", headers: { cookie: TEST_COOKIE } });
    expect(status.json().hasCredential).toBe(true);
    expect(status.json().credentialStatus).toBe("ACTIVE");

    const detail = await app.inject({ method: "GET", url: "/api/v1/providers/openai", headers: { cookie: TEST_COOKIE } });
    expect(JSON.stringify(detail.json())).not.toContain("sk-secret-value-123");

    // Replace: новое значение не эхоится, статус остаётся ACTIVE.
    const replace = await app.inject({
      method: "PUT",
      url: "/api/v1/providers/openai/credential",
      payload: { authMethodId: "api-key", fields: { apiKey: "sk-replaced-456" } },
      headers,
    });
    expect(replace.statusCode).toBe(200);
    expect(JSON.stringify(replace.json())).not.toContain("sk-replaced-456");

    const remove = await app.inject({
      method: "DELETE",
      url: "/api/v1/providers/openai/credential",
      payload: { authMethodId: "api-key" },
      headers,
    });
    expect(remove.statusCode).toBe(204);
    const statusAfter = await app.inject({ method: "GET", url: "/api/v1/providers/openai/status", headers: { cookie: TEST_COOKIE } });
    expect(statusAfter.json().hasCredential).toBe(false);
    expect(statusAfter.json().credentialStatus).toBe("NONE");
  });

  it("неизвестное поле credential → 400; неизвестный провайдер → 404", async () => {
    const { app } = makeApp();
    await app.inject({
      method: "PUT",
      url: "/api/v1/providers/openai/config",
      payload: {
        enabled: true,
        selectedAuthMethod: "api-key",
        config: { endpoint: "https://api.openai.com/v1" },
        modelSelection: { defaultModelId: null, roleDefaults: {} },
      },
      headers,
    });
    const badField = await app.inject({
      method: "PUT",
      url: "/api/v1/providers/openai/credential",
      payload: { authMethodId: "api-key", fields: { evil: "x" } },
      headers,
    });
    expect(badField.statusCode).toBe(400);

    const unknown = await app.inject({
      method: "PUT",
      url: "/api/v1/providers/nope/config",
      payload: {
        enabled: true,
        selectedAuthMethod: "api-key",
        config: {},
        modelSelection: { defaultModelId: null, roleDefaults: {} },
      },
      headers,
    });
    expect(unknown.statusCode).toBe(404);
  });
});

describe("provider-settings routes: проверка соединения", () => {
  it("успешная проверка через шлюз возвращает ok и статус без тела ответа", async () => {
    const mock = createMockGateway();
    mock.respond(() => ({ status: 200, body: "ok" }));
    const { app } = makeApp({ gateway: mock.gateway });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/providers/openai/test-connection",
      headers,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe(200);
    expect(body).toEqual({ providerId: "openai", ok: true, status: 200, durationMs: expect.any(Number), errorKind: null });
    expect(JSON.stringify(body)).not.toContain("api.openai.com");
    expect(mock.calls).toHaveLength(1);
    await app.close();
  });

  it("таймаут шлюза → типизированный код timeout без сетевых деталей", async () => {
    const mock = createMockGateway();
    mock.respond(() => { throw new ProviderGatewayError("timeout"); });
    const { app } = makeApp({ gateway: mock.gateway });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/providers/openai/test-connection",
      headers,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(false);
    expect(body.errorKind).toBe("timeout");
    expect(body.status).toBeNull();
    await app.close();
  });

  it("запрещённое назначение (SSRF) → forbidden-destination", async () => {
    const mock = createMockGateway();
    mock.respond(() => { throw new ProviderGatewayError("forbidden-destination", "range"); });
    const { app } = makeApp({ gateway: mock.gateway });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/providers/openai/test-connection",
      headers,
    });
    const body = response.json();
    expect(body.errorKind).toBe("forbidden-destination");
    await app.close();
  });
});
