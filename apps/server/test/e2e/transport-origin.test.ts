import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { request as httpRequest } from "node:http";
import { createApp } from "../../src/app/create-app.js";
import { createSqliteDatabase } from "../../src/platform/database/sqlite-database.js";
import { runMigrations, type Migration } from "../../src/platform/database/migrator.js";
import { SchedulerService } from "../../src/modules/scheduler/scheduler-service.js";
import { createAuthRepository } from "../../src/platform/security/auth-repository.js";
import { createAuthService } from "../../src/platform/security/auth-service.js";
import { createNodeDigestPort } from "../../src/platform/security/auth-ports.js";
import type { AgentRuntime } from "../../src/modules/runtime/agent-runtime.js";

const migrationDir = fileURLToPath(new URL("../../src/platform/database/migrations/", import.meta.url));
const migrations: Migration[] = readdirSync(migrationDir).filter((file) => file.endsWith(".sql")).map((file) => ({ version: Number(/^([0-9]+)/.exec(file)?.[1]), name: file.replace(/^[0-9]+_/, "").replace(/\.sql$/, ""), sql: readFileSync(join(migrationDir, file), "utf8") }));
const runtime: AgentRuntime = { active: 0, maxActive: 0, calls: [], async startRun() {}, async runResult() { return {} as never; }, async resumeRun() {}, async cancelRun() {}, async inspectRun() { throw new Error("unused"); }, async collectResult() { return {} as never; }, async collectUsage() { return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, cost: 0 }; }, async healthCheck() { return true; } };
const phc = `$argon2id$v=19$m=65536,p=4,t=3$${Buffer.alloc(16, 1).toString("base64").replace(/=+$/, "")}$${Buffer.alloc(32, 2).toString("base64").replace(/=+$/, "")}`;
const hasher = { hash: async () => phc, verify: async (_encoded: string, password: Readonly<Uint8Array>) => Buffer.from(password).toString() === "password" };

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("port unavailable");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function makeApp(databasePath: string, port: number, now = "2030-01-01T00:00:00.000Z") {
  const db = createSqliteDatabase(databasePath);
  runMigrations(db, migrations);
  const repository = createAuthRepository(db, hasher, { randomBytes: (() => { let n = 0; return () => Buffer.alloc(32, ++n); })() }, createNodeDigestPort());
  if (!(await repository.hasLocalUser())) await repository.createLocalUser(Buffer.from("password"), "2030-01-01T00:00:00.000Z");
  const authService = createAuthService(repository, hasher, { now: () => now });
  const app = createApp({ host: "127.0.0.1", port, db, scheduler: new SchedulerService(db), runtime, authService });
  await app.ready();
  await new Promise<void>((resolve, reject) => app.server.listen(port, "127.0.0.1", () => resolve()).once("error", reject));
  return { app, db };
}

async function request(origin: string, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, origin);
    const request = httpRequest(url, { method: options.method ?? "GET", headers: { connection: "close", ...(options.headers ?? {}) } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

describe("real HTTP transport origin contract", () => {
  it("persists cookie sessions across app restart and enforces exact Origin/CSRF", async () => {
    const root = mkdtempSync(join(tmpdir(), "ebb-auth-"));
    const databasePath = join(root, "orchestrator.sqlite");
    const port = await reservePort();
    const origin = `http://127.0.0.1:${port}`;
    const first = await makeApp(databasePath, port);
    const cookieRef = { value: "" };
    try {
      const login = await request(origin, "/api/v1/session/login", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ password: "password" }) });
      expect(login.status).toBe(200);
      const setCookie = Array.isArray(login.headers["set-cookie"]) ? login.headers["set-cookie"][0] ?? "" : String(login.headers["set-cookie"] ?? "");
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Strict");
      expect(setCookie).toContain("Max-Age=86400");
      expect(setCookie).toContain("Expires=");
      expect(setCookie).not.toContain("Secure");
      expect(setCookie).not.toContain("Domain=");
      cookieRef.value = setCookie.split(";", 1)[0]!;
      const session = await request(origin, "/api/v1/session", { headers: { cookie: cookieRef.value } });
      expect(session.status).toBe(200);
      const csrf = (JSON.parse(session.body) as { csrfToken: string }).csrfToken;
      expect((await request(origin, "/api/v1/session/logout", { method: "POST", headers: { cookie: cookieRef.value, origin: "https://evil.example", "x-csrf-token": csrf } })).status).toBe(403);
    } finally {
      await first.app.close(); first.db.close();
    }
    const second = await makeApp(databasePath, port);
    try {
      const restored = await request(origin, "/api/v1/session", { headers: { cookie: cookieRef.value } });
      expect(restored.status).toBe(200);
      const restoredCsrf = (JSON.parse(restored.body) as { csrfToken: string }).csrfToken;
      expect((await request(origin, "/api/v1/session/logout", { method: "POST", headers: { cookie: cookieRef.value, origin, "x-csrf-token": restoredCsrf } })).status).toBe(204);
      expect((await request(origin, "/api/v1/session", { headers: { cookie: cookieRef.value } })).status).toBe(401);
    } finally {
      await second.app.close(); second.db.close(); rmSync(root, { recursive: true, force: true });
    }
  });
  it("rejects SSE without a valid cookie and preserves durable state at exact TTL boundaries", async () => {
    const root = mkdtempSync(join(tmpdir(), "ebb-auth-boundary-"));
    const databasePath = join(root, "orchestrator.sqlite");
    const port = await reservePort();
    const origin = `http://127.0.0.1:${port}`;
    const first = await makeApp(databasePath, port);
    let cookie!: string;
    let absoluteCookie!: string;
    try {
      const login = await request(origin, "/api/v1/session/login", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ password: "password" }) });
      const setCookie = Array.isArray(login.headers["set-cookie"]) ? login.headers["set-cookie"][0] ?? "" : String(login.headers["set-cookie"] ?? "");
      cookie = setCookie.split(";", 1)[0]!;
      const secondLogin = await request(origin, "/api/v1/session/login", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ password: "password" }) });
      const secondSetCookie = Array.isArray(secondLogin.headers["set-cookie"]) ? secondLogin.headers["set-cookie"][0] ?? "" : String(secondLogin.headers["set-cookie"] ?? "");
      absoluteCookie = secondSetCookie.split(";", 1)[0]!;
    } finally {
      await first.app.close();
      first.db.close();
    }
    const atIdleBoundary = await makeApp(databasePath, port, "2030-01-01T00:30:00.000Z");
    try {
      const before = atIdleBoundary.db.get("SELECT revoked_at, last_seen_at, idle_expires_at, csrf_token_hash, absolute_expires_at FROM auth_sessions");
      expect((await request(origin, "/api/v1/events")).status).toBe(401);
      expect((await request(origin, "/api/v1/events", { headers: { cookie: "ebb_local_session=malformed" } })).status).toBe(401);
      const expired = await request(origin, "/api/v1/session", { headers: { cookie } });
      expect(expired.status).toBe(401);
      expect(atIdleBoundary.db.get("SELECT revoked_at, last_seen_at, idle_expires_at, csrf_token_hash, absolute_expires_at FROM auth_sessions")).toEqual(before);
    } finally {
      await atIdleBoundary.app.close();
      atIdleBoundary.db.close();
    }
    const atAbsoluteBoundary = await makeApp(databasePath, port, "2030-01-02T00:00:00.000Z");
    try {
      const before = atAbsoluteBoundary.db.get("SELECT revoked_at, last_seen_at, idle_expires_at, csrf_token_hash, absolute_expires_at FROM auth_sessions");
      const expired = await request(origin, "/api/v1/session", { headers: { cookie: absoluteCookie } });
      expect(expired.status).toBe(401);
      expect(atAbsoluteBoundary.db.get("SELECT revoked_at, last_seen_at, idle_expires_at, csrf_token_hash, absolute_expires_at FROM auth_sessions")).toEqual(before);
    } finally {
      await atAbsoluteBoundary.app.close();
      atAbsoluteBoundary.db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("covers real-transport logout Origin/session/CSRF matrix and clearing flags", async () => {
    const root = mkdtempSync(join(tmpdir(), "ebb-auth-logout-matrix-"));
    const databasePath = join(root, "orchestrator.sqlite");
    const port = await reservePort();
    const origin = `http://127.0.0.1:${port}`;
    const instance = await makeApp(databasePath, port);
    const cookieOf = (response: { headers: Record<string, string | string[] | undefined> }) => {
      const value = Array.isArray(response.headers["set-cookie"]) ? response.headers["set-cookie"][0] ?? "" : String(response.headers["set-cookie"] ?? "");
      return value.split(";", 1)[0]!;
    };
    const flags = (response: { headers: Record<string, string | string[] | undefined> }) => {
      const value = Array.isArray(response.headers["set-cookie"]) ? response.headers["set-cookie"][0] ?? "" : String(response.headers["set-cookie"] ?? "");
      expect(value).toContain("HttpOnly");
      expect(value).toContain("SameSite=Strict");
      expect(value).toContain("Path=/api/v1");
      expect(value).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
      expect(value).toContain("Max-Age=0");
      expect(value).not.toContain("Secure");
      expect(value).not.toContain("Domain=");
    };
    const login = async () => {
      const response = await request(origin, "/api/v1/session/login", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ password: "password" }) });
      expect(response.status).toBe(200);
      return { cookie: cookieOf(response), csrf: (JSON.parse(response.body) as { csrfToken: string }).csrfToken };
    };
    try {
      const active = await login();
      const idle = await login();
      const absolute = await login();
      const revoked = await login();
      const digest = createNodeDigestPort();
      const hash = (cookie: string) => digest.sha256Hex(Buffer.from(cookie.split("=", 2)[1]!, "base64url"));
      instance.db.run("UPDATE auth_sessions SET idle_expires_at = $expired WHERE token_hash = $tokenHash", { expired: "2029-01-01T00:00:00.000Z", tokenHash: hash(idle.cookie) });
      instance.db.run("UPDATE auth_sessions SET absolute_expires_at = $expired WHERE token_hash = $tokenHash", { expired: "2029-01-01T00:00:00.000Z", tokenHash: hash(absolute.cookie) });
      const revoke = await request(origin, "/api/v1/session/logout", { method: "POST", headers: { cookie: revoked.cookie, origin, "x-csrf-token": revoked.csrf } });
      expect(revoke.status).toBe(204);
      flags(revoke);
      const snapshot = () => instance.db.all("SELECT revoked_at, last_seen_at, idle_expires_at, csrf_token_hash, absolute_expires_at FROM auth_sessions");
      const baseline = snapshot();
      for (const headers of [
        { cookie: active.cookie, "x-csrf-token": active.csrf },
        { cookie: idle.cookie, "x-csrf-token": idle.csrf },
        { cookie: absolute.cookie, "x-csrf-token": absolute.csrf },
        { cookie: revoked.cookie, "x-csrf-token": revoked.csrf },
      ]) {
        const response = await request(origin, "/api/v1/session/logout", { method: "POST", headers });
        expect(response.status).toBe(403);
        expect(JSON.parse(response.body).error.code).toBe("AUTH_ORIGIN_INVALID");
        expect(response.headers["set-cookie"]).toBeUndefined();
        expect(snapshot()).toEqual(baseline);
      }
      for (const headers of [
        {},
        { cookie: "ebb_local_session=malformed", "x-csrf-token": "malformed" },
        { cookie: `ebb_local_session=${Buffer.alloc(32, 9).toString("base64url")}`, "x-csrf-token": active.csrf },
        { cookie: idle.cookie, "x-csrf-token": idle.csrf },
        { cookie: absolute.cookie, "x-csrf-token": absolute.csrf },
        { cookie: revoked.cookie, "x-csrf-token": revoked.csrf },
      ]) {
        const response = await request(origin, "/api/v1/session/logout", { method: "POST", headers: { origin, ...headers } });
        expect(response.status).toBe(204);
        flags(response);
      }
      expect(snapshot()).toEqual(baseline);
      const wrong = await request(origin, "/api/v1/session/logout", { method: "POST", headers: { cookie: active.cookie, origin, "x-csrf-token": Buffer.alloc(32, 9).toString("base64url") } });
      expect(wrong.status).toBe(403);
      expect(JSON.parse(wrong.body).error.code).toBe("AUTH_CSRF_INVALID");
      expect(wrong.headers["set-cookie"]).toBeUndefined();
      expect(snapshot()).toEqual(baseline);
      const success = await request(origin, "/api/v1/session/logout", { method: "POST", headers: { cookie: active.cookie, origin, "x-csrf-token": active.csrf } });
      expect(success.status).toBe(204);
      flags(success);
      const repeated = await request(origin, "/api/v1/session/logout", { method: "POST", headers: { cookie: active.cookie, origin } });
      expect(repeated.status).toBe(204);
      flags(repeated);
    } finally {
      await instance.app.close();
      instance.db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
