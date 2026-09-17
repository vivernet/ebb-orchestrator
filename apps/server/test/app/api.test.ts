import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../../src/app/create-app.js";
import { createSqliteDatabase } from "../../src/platform/database/sqlite-database.js";
import { SchedulerService } from "../../src/modules/scheduler/scheduler-service.js";
import { runMigrations, type Migration } from "../../src/platform/database/migrator.js";
import type { AgentRuntime } from "../../src/modules/runtime/agent-runtime.js";

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

describe("orchestrator read API", () => {
  it.each([
    "/api/v1/dashboard",
    "/api/v1/projects/project-1",
    "/api/v1/epics/epic-1",
    "/api/v1/tasks/task-1",
    "/api/v1/execution",
    "/api/v1/approvals",
  ])("exposes %s as an authenticated read endpoint", async (url) => {
    const app = makeApp();
    const response = await app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${app.sessionToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    await app.close();
  });

  it.each([
    ["/api/v1/approvals/approval-1/approve", "POST"],
    ["/api/v1/tasks/task-1/pause", "POST"],
    ["/api/v1/runs/run-1/cancel", "POST"],
  ] as const)("rejects unauthenticated mutation %s", async (url, method) => {
    const app = makeApp();
    const response = await app.inject({ method, url });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects an authenticated mutation from an untrusted origin", async () => {
    const app = makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/approvals/approval-1/approve",
      headers: {
        authorization: `Bearer ${app.sessionToken}`,
        origin: "https://evil.example",
      },
    });

    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("rejects an authenticated mutation without an Origin header", async () => {
    const app = makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/approvals/approval-1/approve",
      headers: { authorization: `Bearer ${app.sessionToken}` },
    });

    expect(response.statusCode).toBe(403);
    await app.close();
  });
});
