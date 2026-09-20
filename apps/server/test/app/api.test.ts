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

function makeAppWithDatabase() {
  const db = createSqliteDatabase(":memory:");
  runMigrations(db, migrations);
  const scheduler = new SchedulerService(db);
  return { app: createApp({ db, scheduler, runtime: mockRuntime }), db };
}

describe("orchestrator read API", () => {
  it("fails closed when onboarding activation has no persisted semantic approval authority", async () => {
    const { app, db } = makeAppWithDatabase();
    const now = "2026-09-20T00:00:00.000Z";
    db.run(
      "INSERT INTO projects (id, name, display_name, status, created_at, updated_at) VALUES ($id, $name, $displayName, 'ACTIVE', $now, $now)",
      { id: "project-1", name: "project", displayName: "Project", now },
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/onboarding/project-1/activate",
      headers: {
        authorization: `Bearer ${app.sessionToken}`,
        origin: "http://127.0.0.1:3000",
        "x-csrf-token": app.csrfToken,
      },
    });

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toMatchObject({ error: expect.stringContaining("semantic approval") });
    expect(db.get<{ status: string }>("SELECT status FROM projects WHERE id = $id", { id: "project-1" })?.status).toBe("ACTIVE");
    await app.close();
    db.close();
  });

  it("exposes a safe Agent Run detail projection without prompt or capability data", async () => {
    const { app, db } = makeAppWithDatabase();
    db.run(
      `INSERT INTO agent_runs (id, role, runtime, model, status, task_id, trigger_reason, started_at, input_tokens, cached_input_tokens, output_tokens, cost, prompt, capability_ref)
       VALUES ($id, $role, $runtime, $model, $status, $task_id, $trigger_reason, $started_at, $input_tokens, $cached_input_tokens, $output_tokens, $cost, $prompt, $capability_ref)`,
      {
        id: "run-1", role: "Developer", runtime: "hermes", model: "model", status: "IN_PROGRESS", task_id: "task-1",
        trigger_reason: "DEVELOPMENT", started_at: "2026-09-20T00:00:00.000Z", input_tokens: 10, cached_input_tokens: 2,
        output_tokens: 3, cost: 0.42, prompt: "sensitive prompt", capability_ref: "sensitive-capability",
      },
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/runs/run-1",
      headers: { authorization: `Bearer ${app.sessionToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      id: "run-1", role: "Developer", runtime: "hermes", model: "model", status: "IN_PROGRESS", taskId: "task-1", epicId: null,
      triggerReason: "DEVELOPMENT", startedAt: "2026-09-20T00:00:00.000Z", endedAt: null,
      usage: { inputTokens: 10, cachedTokens: 2, outputTokens: 3, cost: 0.42 },
    });
    await app.close();
    db.close();
  });

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
