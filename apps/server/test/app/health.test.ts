import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../../src/app/create-app.js";
import { createSqliteDatabase } from "../../src/platform/database/sqlite-database.js";
import { SchedulerService } from "../../src/modules/scheduler/scheduler-service.js";
import { runMigrations, type Migration } from "../../src/platform/database/migrator.js";
import type { AgentRuntime } from "../../src/modules/runtime/agent-runtime.js";
import { StatusTracker } from "../../src/platform/process/system-lifecycle.js";

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

function makeApp(status = new StatusTracker()) {
  const db = createSqliteDatabase(":memory:");
  runMigrations(db, migrations);
  const scheduler = new SchedulerService(db);
  return createApp({ db, scheduler, runtime: mockRuntime, status });
}

describe("GET /api/v1/health", () => {
  it("returns 200 with status ok", async () => {
    const status = new StatusTracker();
    await status.set("READY");
    const app = makeApp(status);
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", lifecycle: "READY" });
    await app.close();
  });

  it.each(["STARTING", "RECOVERING", "DEGRADED", "SHUTTING_DOWN"] as const)("does not report %s as ready", async (lifecycle) => {
    const status = new StatusTracker();
    await status.set(lifecycle);
    const app = makeApp(status);
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "unavailable", lifecycle });
    await app.close();
  });

  it("returns 503 when startup reconciliation has degraded the lifecycle", async () => {
    const status = new StatusTracker();
    await status.set("DEGRADED");
    const app = makeApp(status);
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "unavailable", lifecycle: "DEGRADED" });
    await app.close();
  });
});
