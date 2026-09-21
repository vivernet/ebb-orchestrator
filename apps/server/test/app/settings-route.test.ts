import Fastify from "fastify";
import { expect, test } from "vitest";
import { settingsRoutes } from "../../src/app/routes/settings.js";
import { createSqliteDatabase } from "../../src/platform/database/sqlite-database.js";
import { SchedulerService } from "../../src/modules/scheduler/scheduler-service.js";

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
    securitySettings: { mostRestrictiveWins: null, localModeEnabled: null },
  });
  await app.close();
});

test("settings marks scheduler and security data unavailable without a scheduler", async () => {
  const app = Fastify();
  await settingsRoutes(app);

  const response = await app.inject({ method: "GET", url: "/api/v1/settings" });

  expect(response.statusCode).toBe(200);
  const body = JSON.parse(response.body);
  expect(body.effectiveHierarchy.global).toEqual({ schemaVersion: null, globalMax: null, projectMax: null, roleCapacity: null });
  expect(body.effectiveHierarchy.project).toBeNull();
  expect(body.securitySettings).toEqual({ mostRestrictiveWins: null, localModeEnabled: null });
  await app.close();
});

test("settings fails closed when the persisted scheduler configuration is invalid", async () => {
  const app = Fastify();
  await settingsRoutes(app, { scheduler: { getConfig: () => { throw new Error("malformed persisted scheduler configuration"); } } });

  const response = await app.inject({ method: "GET", url: "/api/v1/settings" });

  expect(response.statusCode).toBe(503);
  expect(JSON.parse(response.body)).toEqual({ error: "scheduler configuration unavailable" });
  await app.close();
});
