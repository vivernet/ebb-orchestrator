import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../../src/app/create-app.js";
import { createSqliteDatabase } from "../../src/platform/database/sqlite-database.js";
import { SchedulerService } from "../../src/modules/scheduler/scheduler-service.js";
import { runMigrations, type Migration } from "../../src/platform/database/migrator.js";
import type { AgentRuntime } from "../../src/modules/runtime/agent-runtime.js";
import type { SecretStore } from "../../src/platform/security/secret-store.js";

const migrationDir = fileURLToPath(new URL("../../src/platform/database/migrations/", import.meta.url));
const migrations: Migration[] = readdirSync(migrationDir).filter((file) => file.endsWith(".sql")).map((file) => {
  const match = /^(\d+)_([^.]*)\.sql$/.exec(file);
  if (!match) throw new Error(`Invalid migration filename: ${file}`);
  return { version: Number(match[1]), name: match[2]!, sql: readFileSync(join(migrationDir, file), "utf8") };
});

const mockRuntime: AgentRuntime = {
  active: 0, maxActive: 0, calls: [],
  async startRun() {},
  async runResult(_runId: string) { return { version: "1.0", summary: "" } as never; },
  async resumeRun() {},
  async cancelRun() {},
  async inspectRun() { throw new Error("not implemented"); },
  async collectResult() { return { success: true, exitCode: 0, output: "", validatedSubmission: false, diagnostics: { runId: "", sessionId: null, stderr: "", exitCode: 0, artifactReferences: [] } } as never; },
  async collectUsage() { return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, cost: 0 }; },
  async healthCheck() { return true; },
};

function makeApp() {
  const db = createSqliteDatabase(":memory:");
  runMigrations(db, migrations);
  const scheduler = new SchedulerService(db);
  return createApp({ db, scheduler, runtime: mockRuntime });
}

describe("local-session security", () => {
  it("returns 503 without persisting metadata when secret storage is unavailable", async () => {
    const unavailableStore: SecretStore = {
      async store() {
        const error = new Error("Secret storage is unavailable");
        error.name = "SecretStoreUnavailableError";
        throw error;
      },
      async resolveForService() { return undefined; },
      async revoke() {},
      async listMetadata() { return []; },
    };
    const db = createSqliteDatabase(":memory:");
    runMigrations(db, migrations);
    const app = createApp({
      db,
      scheduler: new SchedulerService(db),
      runtime: mockRuntime,
      secretStore: unavailableStore,
    } as Parameters<typeof createApp>[0]);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/secrets",
      payload: { service: "test", name: "token", value: "must-not-leak" },
      headers: {
        authorization: `Bearer ${app.sessionToken}`,
        origin: "http://127.0.0.1:3000",
        "x-csrf-token": app.csrfToken,
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("must-not-leak");
    expect(db.all("SELECT * FROM secrets")).toEqual([]);
    await app.close();
  });

  it("requires a one-time bootstrap token before disclosing session credentials", async () => {
    const app = makeApp();
    const rejected = await app.inject({ method: "GET", url: "/api/v1/session/bootstrap" });
    expect(rejected.statusCode).toBe(401);

    const bootstrapToken = app.bootstrapToken;
    expect(bootstrapToken).not.toBeNull();
    if (bootstrapToken === null) throw new Error("Expected a bootstrap token");
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/session/bootstrap",
      headers: { "x-ebb-bootstrap-token": bootstrapToken },
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ sessionToken: app.sessionToken, csrfToken: app.csrfToken });
    expect(app.csrfToken).not.toBe(app.sessionToken);

    const setCookie = response.headers["set-cookie"];
    expect(typeof setCookie).toBe("string");
    if (typeof setCookie !== "string") throw new Error("Expected local session cookie");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");

    const restored = await app.inject({
      method: "GET",
      url: "/api/v1/session",
      headers: { cookie: setCookie },
    });
    expect(restored.statusCode).toBe(200);
    expect(JSON.parse(restored.body)).toEqual({ csrfToken: app.csrfToken, origin: "http://127.0.0.1:3000" });

    const mutationWithRestoredSession = await app.inject({
      method: "POST",
      url: "/api/v1/protected-test",
      headers: {
        cookie: setCookie,
        origin: "http://127.0.0.1:3000",
        "x-csrf-token": app.csrfToken,
      },
    });
    expect(mutationWithRestoredSession.statusCode).toBe(200);

    const reused = await app.inject({
      method: "GET",
      url: "/api/v1/session/bootstrap",
      headers: { "x-ebb-bootstrap-token": bootstrapToken },
    });
    expect(reused.statusCode).toBe(401);
    await app.close();
  });

  it("rejects unauthenticated requests to protected routes with 401", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/protected-test",
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("requires same-origin validation for authenticated mutations", async () => {
    const app = makeApp();
    const token = app.sessionToken;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/protected-test",
        headers: { authorization: `Bearer ${token}`, origin: "http://127.0.0.1:3000", "x-csrf-token": app.csrfToken },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("rejects requests with invalid origin on mutating routes with 403", async () => {
    const app = makeApp();
    const token = app.sessionToken;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/protected-test",
      headers: {
        origin: "https://evil.example.com",
        authorization: `Bearer ${token}`,
      },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("rejects same-origin mutations without the CSRF token", async () => {
    const app = makeApp();
    const res = await app.inject({ method: "POST", url: "/api/v1/protected-test", headers: { authorization: `Bearer ${app.sessionToken}`, origin: "http://127.0.0.1:3000" } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("rejects requests without origin header to prevent CSRF", async () => {
    const app = makeApp();
    const token = app.sessionToken;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/protected-test",
      headers: { authorization: `Bearer ${token}` },
      // No origin header – should succeed (same-origin / non-CORS).
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("allows requests with matching origin", async () => {
    const app = makeApp();
    const token = app.sessionToken;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/protected-test",
      headers: {
        origin: "http://127.0.0.1:3000",
        authorization: `Bearer ${token}`,
        "x-csrf-token": app.csrfToken,
      },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
