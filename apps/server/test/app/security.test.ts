import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app/create-app.js";
import { createSqliteDatabase } from "../../src/platform/database/sqlite-database.js";
import { SchedulerService } from "../../src/modules/scheduler/scheduler-service.js";
import { runMigrations, type Migration } from "../../src/platform/database/migrator.js";
import { createAuthRepository } from "../../src/platform/security/auth-repository.js";
import { createAuthService } from "../../src/platform/security/auth-service.js";
import { createNodeDigestPort } from "../../src/platform/security/auth-ports.js";
import type { AgentRuntime } from "../../src/modules/runtime/agent-runtime.js";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestAuthService, TEST_COOKIE, TEST_CSRF_TOKEN } from "../helpers/auth.js";

const migrationDir = fileURLToPath(new URL("../../src/platform/database/migrations/", import.meta.url));
const migrations: Migration[] = readdirSync(migrationDir).filter((file) => file.endsWith(".sql")).map((file) => ({ version: Number(/^([0-9]+)/.exec(file)?.[1]), name: file.replace(/^[0-9]+_/, "").replace(/\.sql$/, ""), sql: readFileSync(join(migrationDir, file), "utf8") }));
const runtime: AgentRuntime = { active: 0, maxActive: 0, calls: [], async startRun() {}, async runResult() { return { version: "1", summary: "" } as never; }, async resumeRun() {}, async cancelRun() {}, async inspectRun() { throw new Error("unused"); }, async collectResult() { return {} as never; }, async collectUsage() { return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, cost: 0 }; }, async healthCheck() { return true; } };

async function setup() {
  const db = createSqliteDatabase(":memory:");
  runMigrations(db, migrations);
  let sequence = 0;
  const phc = `$argon2id$v=19$m=65536,p=4,t=3$${Buffer.alloc(16, 1).toString("base64").replace(/=+$/, "")}$${Buffer.alloc(32, 2).toString("base64").replace(/=+$/, "")}`;
  const hasher = { hash: async () => phc, verify: async (_encoded: string, password: Readonly<Uint8Array>) => Buffer.from(password).toString() === "password" };
  const authRepository = createAuthRepository(db, hasher, { randomBytes: () => { sequence += 1; return Buffer.alloc(32, sequence); } }, createNodeDigestPort());
  await authRepository.createLocalUser(Buffer.from("password"), "2030-01-01T00:00:00.000Z");
  const authService = createAuthService(authRepository, hasher, { now: () => "2030-01-01T00:00:00.000Z" });
  return { db, app: createApp({ db, scheduler: new SchedulerService(db), runtime, authService }) };
}

async function login(app: ReturnType<typeof createApp>) {
  const response = await app.inject({ method: "POST", url: "/api/v1/session/login", headers: { origin: "http://127.0.0.1:3000" }, payload: { password: "password" } });
  expect(response.statusCode).toBe(200);
  const cookie = String(response.headers["set-cookie"]).split(";", 1)[0]!;
  return { cookie, csrf: JSON.parse(response.body).csrfToken as string };
}

describe("durable server auth boundary", () => {
  it("rejects legacy bootstrap/query paths and exposes no process-local credentials", async () => {
    const { app, db } = await setup();
    expect((app as object)).not.toHaveProperty("sessionToken");
    expect((app as object)).not.toHaveProperty("csrfToken");
    const legacyBootstrap = await app.inject({ method: "GET", url: "/api/v1/session/bootstrap" });
    const legacyNew = await app.inject({ method: "POST", url: "/api/v1/session/new?local=true" });
    expect(legacyBootstrap.statusCode, legacyBootstrap.body).toBe(404);
    expect(legacyNew.statusCode, legacyNew.body).toBe(404);
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM auth_sessions")?.count).toBe(0);
    await app.close(); db.close();
  });

  it("does not bypass auth when the legacy environment variable is present", async () => {
    const { app, db } = await setup();
    const previous = process.env.EBB_DISABLE_AUTH;
    process.env.EBB_DISABLE_AUTH = "1";
    try {
      expect((await app.inject({ method: "POST", url: "/api/v1/protected-test" })).statusCode).toBe(401);
    } finally {
      if (previous === undefined) delete process.env.EBB_DISABLE_AUTH;
      else process.env.EBB_DISABLE_AUTH = previous;
      await app.close(); db.close();
    }
  });

  it("requires exact Origin for login and does not require CSRF", async () => {
    const { app, db } = await setup();
    expect((await app.inject({ method: "POST", url: "/api/v1/session/login", payload: { password: "password" } })).statusCode).toBe(403);
    const malformed = await app.inject({ method: "POST", url: "/api/v1/session/login", headers: { origin: "http://127.0.0.1:3000" }, payload: { password: "password", extra: true } });
    expect(JSON.parse(malformed.body).error.code).toBe("AUTH_INVALID_REQUEST");
    const malformedJson = await app.inject({ method: "POST", url: "/api/v1/session/login", headers: { origin: "http://127.0.0.1:3000", "content-type": "application/json" }, payload: "{" });
    expect(JSON.parse(malformedJson.body).error.code).toBe("AUTH_INVALID_REQUEST");
    const crossOriginMalformedJson = await app.inject({ method: "POST", url: "/api/v1/session/login", headers: { origin: "https://evil.example", "content-type": "application/json" }, payload: "{" });
    expect(crossOriginMalformedJson.statusCode).toBe(403);
    expect(JSON.parse(crossOriginMalformedJson.body).error.code).toBe("AUTH_ORIGIN_INVALID");
    await app.close(); db.close();
  });

  it("authenticates through DB-backed cookie, rotates CSRF, and protects mutations", async () => {
    const { app, db } = await setup();
    const first = await login(app);
    const session = await app.inject({ method: "GET", url: "/api/v1/session", headers: { cookie: first.cookie } });
    expect(session.statusCode).toBe(200);
    const secondCsrf = JSON.parse(session.body).csrfToken as string;
    expect(secondCsrf).not.toBe(first.csrf);
    expect((await app.inject({ method: "POST", url: "/api/v1/protected-test", headers: { cookie: first.cookie, origin: "http://127.0.0.1:3000", "x-csrf-token": first.csrf } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/v1/protected-test", headers: { cookie: first.cookie, origin: "http://127.0.0.1:3000", "x-csrf-token": secondCsrf } })).statusCode).toBe(200);
    await app.close(); db.close();
  });

  it("applies logout precedence and idempotent clearing", async () => {
    const { app, db } = await setup();
    const { cookie, csrf } = await login(app);
    const snapshot = () => db.get("SELECT revoked_at, last_seen_at, idle_expires_at, csrf_token_hash, absolute_expires_at FROM auth_sessions");
    const baseline = snapshot();
    const wrongOrigin = await app.inject({ method: "POST", url: "/api/v1/session/logout", headers: { cookie, origin: "https://evil.example", "x-csrf-token": csrf } });
    expect(JSON.parse(wrongOrigin.body).error.code).toBe("AUTH_ORIGIN_INVALID");
    expect(wrongOrigin.headers["set-cookie"]).toBeUndefined();
    expect(snapshot()).toEqual(baseline);
    const wrongCsrf = await app.inject({ method: "POST", url: "/api/v1/session/logout", headers: { cookie, origin: "http://127.0.0.1:3000", "x-csrf-token": Buffer.alloc(32, 9).toString("base64url") } });
    expect(JSON.parse(wrongCsrf.body).error.code).toBe("AUTH_CSRF_INVALID");
    expect(wrongCsrf.headers["set-cookie"]).toBeUndefined();
    expect(snapshot()).toEqual(baseline);
    const loggedOut = await app.inject({ method: "POST", url: "/api/v1/session/logout", headers: { cookie, origin: "http://127.0.0.1:3000", "x-csrf-token": csrf } });
    expect(loggedOut.statusCode).toBe(204);
    expect(String(loggedOut.headers["set-cookie"])).toContain("Max-Age=0");
    const revoked = snapshot();
    expect(revoked).toMatchObject({ last_seen_at: baseline?.last_seen_at, idle_expires_at: baseline?.idle_expires_at, csrf_token_hash: baseline?.csrf_token_hash, absolute_expires_at: baseline?.absolute_expires_at });
    expect(revoked).toMatchObject({ revoked_at: "2030-01-01T00:00:00.000Z" });
    const repeated = await app.inject({ method: "POST", url: "/api/v1/session/logout", headers: { cookie, origin: "http://127.0.0.1:3000" } });
    expect(repeated.statusCode).toBe(204);
    expect(String(repeated.headers["set-cookie"])).toContain("Max-Age=0");
    expect(snapshot()).toEqual(revoked);
    await app.close(); db.close();
  });

  it("covers the complete logout matrix with durable no-mutation rows and locked clearing flags", async () => {
    const { app, db } = await setup();
    const active = await login(app);
    const idle = await login(app);
    const absolute = await login(app);
    const revoked = await login(app);
    const digest = createNodeDigestPort();
    const sessionHash = (cookie: string) => digest.sha256Hex(Buffer.from(cookie.split("=", 2)[1]!, "base64url"));
    db.run("UPDATE auth_sessions SET idle_expires_at = $expired WHERE token_hash = $tokenHash", { expired: "2029-01-01T00:00:00.000Z", tokenHash: sessionHash(idle.cookie) });
    db.run("UPDATE auth_sessions SET absolute_expires_at = $expired WHERE token_hash = $tokenHash", { expired: "2029-01-01T00:00:00.000Z", tokenHash: sessionHash(absolute.cookie) });
    const revokedBefore = await app.inject({ method: "POST", url: "/api/v1/session/logout", headers: { cookie: revoked.cookie, origin: "http://127.0.0.1:3000", "x-csrf-token": revoked.csrf } });
    expect(revokedBefore.statusCode).toBe(204);
    const rows = () => db.all("SELECT revoked_at, last_seen_at, idle_expires_at, csrf_token_hash, absolute_expires_at FROM auth_sessions ORDER BY created_at, id");
    const baseline = rows();
    const clearing = (response: { headers: Record<string, unknown> }) => {
      const value = String(response.headers["set-cookie"] ?? "");
      expect(value).toContain("HttpOnly");
      expect(value).toContain("SameSite=Strict");
      expect(value).toContain("Path=/api/v1");
      expect(value).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
      expect(value).toContain("Max-Age=0");
      expect(value).not.toContain("Secure");
      expect(value).not.toContain("Domain=");
    };
    try {
      const invalidOriginRows = [
        { cookie: undefined, csrf: undefined },
        { cookie: "ebb_local_session=malformed", csrf: undefined },
        { cookie: TEST_COOKIE, csrf: TEST_CSRF_TOKEN },
        { cookie: active.cookie, csrf: active.csrf },
        { cookie: idle.cookie, csrf: idle.csrf },
        { cookie: absolute.cookie, csrf: absolute.csrf },
        { cookie: revoked.cookie, csrf: revoked.csrf },
      ];
      for (const headers of invalidOriginRows) {
        const response = await app.inject({ method: "POST", url: "/api/v1/session/logout", headers: { ...(headers.cookie ? { cookie: headers.cookie } : {}), ...(headers.csrf ? { "x-csrf-token": headers.csrf } : {}) } });
        expect(response.statusCode).toBe(403);
        expect(JSON.parse(response.body).error.code).toBe("AUTH_ORIGIN_INVALID");
        expect(response.headers["set-cookie"]).toBeUndefined();
        expect(rows()).toEqual(baseline);
      }
      for (const headers of [
        {},
        { cookie: "ebb_local_session=malformed", "x-csrf-token": "malformed" },
        { cookie: `ebb_local_session=${Buffer.alloc(32, 9).toString("base64url")}`, "x-csrf-token": TEST_CSRF_TOKEN },
        { cookie: idle.cookie, "x-csrf-token": idle.csrf },
        { cookie: absolute.cookie, "x-csrf-token": absolute.csrf },
        { cookie: revoked.cookie, "x-csrf-token": revoked.csrf },
      ]) {
        const response = await app.inject({ method: "POST", url: "/api/v1/session/logout", headers: { origin: "http://127.0.0.1:3000", ...headers } });
        expect(response.statusCode).toBe(204);
        clearing(response);
      }
      expect(rows()).toEqual(baseline);
      const wrongCsrf = await app.inject({ method: "POST", url: "/api/v1/session/logout", headers: { cookie: active.cookie, origin: "http://127.0.0.1:3000", "x-csrf-token": Buffer.alloc(32, 9).toString("base64url") } });
      expect(wrongCsrf.statusCode).toBe(403);
      expect(JSON.parse(wrongCsrf.body).error.code).toBe("AUTH_CSRF_INVALID");
      expect(wrongCsrf.headers["set-cookie"]).toBeUndefined();
      expect(rows()).toEqual(baseline);
      const successful = await app.inject({ method: "POST", url: "/api/v1/session/logout", headers: { cookie: active.cookie, origin: "http://127.0.0.1:3000", "x-csrf-token": active.csrf } });
      expect(successful.statusCode).toBe(204);
      clearing(successful);
      const afterRevoke = rows();
      expect(afterRevoke.filter((row) => row.revoked_at !== null)).toHaveLength(2);
      const repeat = await app.inject({ method: "POST", url: "/api/v1/session/logout", headers: { cookie: active.cookie, origin: "http://127.0.0.1:3000" } });
      expect(repeat.statusCode).toBe(204);
      clearing(repeat);
      expect(rows()).toEqual(afterRevoke);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("uses exactly one atomic mutation auth operation on every protected mutation route", async () => {
    const { app, db } = await setup();
    const authService = createTestAuthService();
    const countedApp = createApp({
      db,
      scheduler: new SchedulerService(db),
      runtime,
      authService,
      github: { worker: { syncIssues: async () => "ok" } as never, repository: "owner/repo" },
      epicOrchestrator: { start: async () => ({ id: "plan-1" }), approveAndRun: async () => ({ runId: "run-1" }) } as never,
    });
    const routes: Array<{ method: "POST" | "PUT" | "PATCH" | "DELETE"; url: string; payload?: unknown }> = [
      { method: "POST", url: "/api/v1/projects", payload: { name: "project", displayName: "Project" } },
      { method: "POST", url: "/api/v1/projects/project-1/tasks", payload: { title: "Task", description: "Task" } },
      { method: "POST", url: "/api/v1/projects/project-1/epics", payload: { title: "Epic", goal: "Goal" } },
      { method: "POST", url: "/api/v1/epics/epic-1/tasks", payload: { title: "Task", description: "Task" } },
      { method: "POST", url: "/api/v1/tasks/task-1/dependencies", payload: { dependsOnTaskId: "task-2" } },
      { method: "DELETE", url: "/api/v1/tasks/task-1/dependencies/task-2" },
      { method: "POST", url: "/api/v1/tasks/task-1/dispatch", payload: { role: "developer", model: "test" } },
      { method: "POST", url: "/api/v1/tasks/task-1/pause" },
      { method: "POST", url: "/api/v1/runs/run-1/cancel" },
      { method: "POST", url: "/api/v1/approvals/approval-1/approve" },
      { method: "POST", url: "/api/v1/approvals/approval-1/reject", payload: { note: "no" } },
      { method: "POST", url: "/api/v1/approvals/approval-1/request-changes", payload: { note: "change" } },
      { method: "POST", url: "/api/v1/onboarding/discover", payload: {} },
      { method: "POST", url: "/api/v1/onboarding/project-1/approval", payload: { note: "approve" } },
      { method: "POST", url: "/api/v1/onboarding/project-1/approve", payload: {} },
      { method: "POST", url: "/api/v1/onboarding/project-1/activate" },
      { method: "PUT", url: "/api/v1/scheduler/config", payload: {} },
      { method: "POST", url: "/api/v1/secrets", payload: { service: "test", name: "token", value: "value" } },
      { method: "DELETE", url: "/api/v1/secrets/test/token" },
      { method: "POST", url: "/api/v1/final-merges/subject-1", payload: { approvalId: "approval-1", integrationRunId: "run-1" } },
      { method: "POST", url: "/api/v1/projects/project-1/epics/plans", payload: { tasks: [{ ref: "task-1", title: "Task", role: "developer", workflow: "implementation", acceptanceCriteria: ["done"] }], epic: { title: "Epic" } } },
      { method: "POST", url: "/api/v1/projects/project-1/epics/plans/plan-1/approve-run", payload: {} },
      { method: "POST", url: "/api/v1/github/sync" },
      { method: "POST", url: "/api/v1/protected-test" },
    ];
    try {
      for (const route of routes) {
        authService.resetAuthOperationCounts();
        await countedApp.inject({ method: route.method, url: route.url, headers: { cookie: TEST_COOKIE, origin: "http://127.0.0.1:3000", "x-csrf-token": TEST_CSRF_TOKEN }, payload: route.payload as never });
        expect(authService.authOperationCounts.authenticateCsrfAndTouch, route.url).toBe(1);
        expect(authService.authOperationCounts.authenticateAndTouch, route.url).toBe(0);
        expect(authService.authOperationCounts.restoreAndRotateCsrf, route.url).toBe(0);
      }
      for (const route of routes) {
        authService.resetAuthOperationCounts();
        await countedApp.inject({ method: route.method, url: route.url, headers: { cookie: TEST_COOKIE, origin: "https://evil.example", "x-csrf-token": TEST_CSRF_TOKEN }, payload: {} });
        expect(authService.authOperationCounts.authenticateCsrfAndTouch, route.url).toBe(0);
        expect(authService.authOperationCounts.authenticateAndTouch, route.url).toBe(0);
        expect(authService.authOperationCounts.restoreAndRotateCsrf, route.url).toBe(0);
      }
    } finally {
      await countedApp.close();
      await app.close();
      db.close();
    }
  });
});
