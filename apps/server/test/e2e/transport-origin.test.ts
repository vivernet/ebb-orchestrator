import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app/create-app.js";
import { createSqliteDatabase } from "../../src/platform/database/sqlite-database.js";
import { runMigrations, type Migration } from "../../src/platform/database/migrator.js";
import { SchedulerService } from "../../src/modules/scheduler/scheduler-service.js";
import type { AgentRuntime } from "../../src/modules/runtime/agent-runtime.js";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { readFileSync, readdirSync } from "node:fs";

const migrationDir = fileURLToPath(new URL("../../src/platform/database/migrations/", import.meta.url));
const migrations: Migration[] = readdirSync(migrationDir).filter((file) => file.endsWith(".sql")).map((file) => {
  const match = /^(\d+)_([^.]*)\.sql$/.exec(file);
  if (!match) throw new Error(`Invalid migration filename: ${file}`);
  return { version: Number(match[1]), name: match[2]!, sql: readFileSync(join(migrationDir, file), "utf8") };
});

const runtime: AgentRuntime = {
  active: 0,
  maxActive: 0,
  calls: [],
  async startRun() {},
  async runResult() { return { version: "1.0", summary: "" } as never; },
  async resumeRun() {},
  async cancelRun() {},
  async inspectRun() { throw new Error("not implemented"); },
  async collectResult() { return {} as never; },
  async collectUsage() { return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, cost: 0 }; },
  async healthCheck() { return true; },
};

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, _reject) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to reserve a TCP port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

describe("real HTTP transport origin contract", () => {
  it("uses the canonical loopback hostname in the generated launch link", () => {
    const launcher = readFileSync(resolve(migrationDir, "../../../../../..", "get-link.html"), "utf8");
    expect(launcher).toContain("http://127.0.0.1:3000/#ebb-bootstrap=");
    expect(launcher).not.toContain("http://localhost:3000/#ebb-bootstrap=");
  });

  it("bootstraps, preserves Set-Cookie for reload, and closes mutation origins", async () => {
    const port = await reservePort();
    const database = createSqliteDatabase(":memory:");
    runMigrations(database, migrations);
    const app = createApp({ host: "127.0.0.1", port, db: database, scheduler: new SchedulerService(database), runtime });
    await app.listen({ host: "127.0.0.1", port });
    const origin = `http://127.0.0.1:${port}`;

    try {
      const bootstrapToken = app.bootstrapToken;
      if (!bootstrapToken) throw new Error("Expected a bootstrap token");
      const bootstrap = await fetch(`${origin}/api/v1/session/bootstrap`, {
        headers: { "x-ebb-bootstrap-token": bootstrapToken },
      });
      expect(bootstrap.status).toBe(200);
      const setCookie = bootstrap.headers.get("set-cookie");
      expect(setCookie).toContain("ebb_local_session=");
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("Path=/api/v1");
      const cookie = setCookie?.split(";", 1)[0];
      if (!cookie) throw new Error("Expected session cookie");

      const restored = await fetch(`${origin}/api/v1/session`, { headers: { cookie } });
      expect(restored.status).toBe(200);
      const csrfToken = (await restored.json() as { csrfToken: string }).csrfToken;

      const mutation = await fetch(`${origin}/api/v1/protected-test`, {
        method: "POST",
        headers: { cookie, origin, "x-csrf-token": csrfToken },
      });
      expect(mutation.status).toBe(200);

      for (const disallowedOrigin of ["http://localhost:3000", "http://127.0.0.1:4173", "https://other.example"]) {
        const rejected = await fetch(`${origin}/api/v1/protected-test`, {
          method: "POST",
          headers: { cookie, origin: disallowedOrigin, "x-csrf-token": csrfToken },
        });
        expect(rejected.status, disallowedOrigin).toBe(403);
      }
    } finally {
      await app.close();
      database.close();
    }
  });
});
