import Fastify from "fastify";
import { expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settingsRoutes } from "../../src/app/routes/settings.js";
import { createSqliteDatabase } from "../../src/platform/database/sqlite-database.js";
import { SchedulerService } from "../../src/modules/scheduler/scheduler-service.js";
import { listSupportedModels } from "../../src/modules/runtime/hermes/hermes-provider-registry.js";

const originalEnv = {
  home: process.env.EBB_ORCHESTRATOR_HOME,
  openai: process.env.OPENAI_API_KEY,
  anthropic: process.env.ANTHROPIC_API_KEY,
};

function restoreOrchestratorEnv(): void {
  if (originalEnv.home === undefined) delete process.env.EBB_ORCHESTRATOR_HOME;
  else process.env.EBB_ORCHESTRATOR_HOME = originalEnv.home;
  if (originalEnv.openai === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalEnv.openai;
  if (originalEnv.anthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalEnv.anthropic;
}

/**
 * Направляет `loadOrchestratorEnv` во временный `EBB_ORCHESTRATOR_HOME`
 * (детерминированно, без зависимости от машины разработчика) с опциональным
 * содержимым `.env`. Значения ключей приходят только в загрузчик и никогда не
 * попадают в ответ роута.
 */
async function withOrchestratorHome(envContent: string | null, fn: () => void | Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "ebb-settings-home-"));
  try {
    process.env.EBB_ORCHESTRATOR_HOME = home;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    if (envContent !== null) writeFileSync(join(home, ".env"), envContent, "utf8");
    await fn();
  } finally {
    restoreOrchestratorEnv();
    rmSync(home, { recursive: true, force: true });
  }
}

const expectedProviderSelection = {
  defaultModel: "default",
  models: listSupportedModels().map((entry) => ({
    model: entry.model,
    provider: entry.provider,
    keyConfigured: entry.envKey === "OPENAI_API_KEY",
  })),
};

test("settings reads scheduler fields from the database-backed SchedulerService", async () => {
  const db = createSqliteDatabase(":memory:");
  db.exec("CREATE TABLE system_state (key TEXT PRIMARY KEY, value_json TEXT NOT NULL)");
  db.exec("CREATE TABLE scheduler_config (id INTEGER PRIMARY KEY, schema_version INTEGER NOT NULL, config_json TEXT NOT NULL, updated_at TEXT NOT NULL)");
  db.run("INSERT INTO scheduler_config(id,schema_version,config_json,updated_at) VALUES (1,1,$config,$updated)", {
    config: JSON.stringify({ globalMax: 8, projectMax: 2, roleCapacity: { developer: 5 } }),
    updated: "2026-09-21T00:00:00.000Z",
  });
  const app = Fastify();
  await settingsRoutes(app, { scheduler: new SchedulerService(db) });

  const response = await app.inject({ method: "GET", url: "/api/v1/settings" });

  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body).effectiveHierarchy.global).toMatchObject({ schemaVersion: 1, globalMax: 8, projectMax: 2, roleCapacity: { developer: 5 } });
  await app.close();
  db.close();
});

test("settings exposes only the scheduler fields confirmed by getConfig", async () => {
  await withOrchestratorHome("OPENAI_API_KEY=secret-value\n", async () => {
    const app = Fastify();
    await settingsRoutes(app, { scheduler: { getConfig: () => ({ schemaVersion: 1, globalMax: 7, projectMax: 3, roleCapacity: { developer: 4 } }) } });

    const response = await app.inject({ method: "GET", url: "/api/v1/settings" });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      effectiveHierarchy: {
        global: { schemaVersion: 1, globalMax: 7, projectMax: 3, roleCapacity: { developer: 4 } },
        project: null,
        role: null,
        taskEpic: null,
      },
      securitySettings: { mostRestrictiveWins: true, localModeEnabled: true },
      providerSelection: expectedProviderSelection,
    });
    await app.close();
  });
});

test("settings never returns provider API key values", async () => {
  await withOrchestratorHome("OPENAI_API_KEY=secret-value\nANTHROPIC_API_KEY=anthropic-secret\n", async () => {
    const app = Fastify();
    await settingsRoutes(app, { scheduler: { getConfig: () => ({ schemaVersion: 1, globalMax: 1, projectMax: 1, roleCapacity: {} }) } });

    const response = await app.inject({ method: "GET", url: "/api/v1/settings" });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("secret-value");
    expect(response.body).not.toContain("anthropic-secret");
    expect(response.body).not.toContain("OPENAI_API_KEY=");
    expect(response.body).not.toContain("ANTHROPIC_API_KEY=");
    expect(response.body).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
    await app.close();
  });
});

test("settings marks scheduler and security data unavailable without a scheduler", async () => {
  await withOrchestratorHome("OPENAI_API_KEY=secret-value\n", async () => {
    const app = Fastify();
    await settingsRoutes(app);

    const response = await app.inject({ method: "GET", url: "/api/v1/settings" });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.effectiveHierarchy.global).toEqual({ schemaVersion: null, globalMax: null, projectMax: null, roleCapacity: null });
    expect(body.effectiveHierarchy.project).toBeNull();
    expect(body.securitySettings).toEqual({ mostRestrictiveWins: true, localModeEnabled: true });
    expect(body.providerSelection).toEqual(expectedProviderSelection);
    await app.close();
  });
});

test("settings fails closed when the persisted scheduler configuration is invalid", async () => {
  const app = Fastify();
  await settingsRoutes(app, { scheduler: { getConfig: () => { throw new Error("malformed persisted scheduler configuration"); } } });

  const response = await app.inject({ method: "GET", url: "/api/v1/settings" });

  expect(response.statusCode).toBe(503);
  expect(JSON.parse(response.body)).toEqual({ error: "scheduler configuration unavailable" });
  await app.close();
});
