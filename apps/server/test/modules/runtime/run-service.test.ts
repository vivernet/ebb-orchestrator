import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { runMigrations, type Migration } from "../../../src/platform/database/migrator.js";
import type { Database } from "../../../src/platform/database/database.js";
import { RunService } from "../../../src/modules/runtime/run-service.js";
import { FakeAgentRuntime } from "../../fakes/fake-agent-runtime.js";
import type { RunOutcome } from "../../../src/modules/runtime/run-types.js";

const migration001 = readFileSync(
  join(import.meta.dirname, "../../../src/platform/database/migrations/001_system.sql"),
  "utf-8",
);

const migration002 = readFileSync(
  join(import.meta.dirname, "../../../src/platform/database/migrations/002_work_domain.sql"),
  "utf-8",
);

const migration003 = readFileSync(
  join(import.meta.dirname, "../../../src/platform/database/migrations/003_work_control.sql"),
  "utf-8",
);

const migration004 = readFileSync(
  join(import.meta.dirname, "../../../src/platform/database/migrations/004_agent_runs.sql"),
  "utf-8",
);

const migrations: Migration[] = [
  { version: 1, name: "001_system", sql: migration001 },
  { version: 2, name: "002_work_domain", sql: migration002 },
  { version: 3, name: "003_work_control", sql: migration003 },
  { version: 4, name: "004_agent_runs", sql: migration004 },
];

describe("RunService with FakeAgentRuntime", () => {
  let db: Database | undefined;
  let tmpDir: string;
  let runService: RunService;
  let fakeRuntime: FakeAgentRuntime;

  const _projectId = randomUUID();
  const epicId = randomUUID();
  const taskId = randomUUID();

  beforeEach(() => {
    tmpDir = "";
  });

  afterEach(async () => {
    db?.close();
    db = undefined;
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  async function setupDb(): Promise<Database> {
    tmpDir = await mkdtemp(join(tmpdir(), "orch-runtime-test-"));
    const dbPath = join(tmpDir, `test-${randomUUID()}.db`);
    const database = createSqliteDatabase(dbPath);
    runMigrations(database, migrations);
    return database;
  }

  async function setup(): Promise<void> {
    db = await setupDb();
    fakeRuntime = new FakeAgentRuntime();
    runService = new RunService(db, fakeRuntime);
  }

  it("starts a run and records it in the database", async () => {
    await setup();
    const run = await runService.startRun({
      role: "developer",
      model: "gpt-4",
      taskId,
      epicId,
      triggerReason: "task-assignment",
      contextVersion: "1.0.0",
      outputSchemaVersion: "1.0.0",
    });

    expect(run.status).toBe("STARTED");
    expect(run.role).toBe("developer");
    expect(run.model).toBe("gpt-4");
    expect(run.taskId).toBe(taskId);
    expect(run.epicId).toBe(epicId);
    expect(run.startedAt).toBeDefined();
    expect(run.capabilityRef).toEqual(expect.any(String));
    const stored = db!.get<{ capability_json: string; capability_ref: string }>(
      "SELECT capability_json, capability_ref FROM agent_runs WHERE id = $id", { id: run.id });
    expect(stored?.capability_ref).toBe(run.capabilityRef);
    expect(JSON.parse(stored!.capability_json)).toMatchObject({ runId: run.id, capabilityRef: run.capabilityRef });
  });

  it("atomically accepts one authenticated completion for the exact run", async () => {
    await setup();
    const run = await runService.startRun({
      role: "developer", model: "gpt-4", taskId, epicId, triggerReason: "task-assignment",
      contextVersion: "1", outputSchemaVersion: "1", capability: { workspace: tmpDir, allowedTools: ["submit_result"] },
    });
    const store = runService.completionStore();
    const output = { version: "1.0.0", outcome: "COMPLETED" };
    await expect(store.accept(run.capabilityRef!, { runId: run.id, role: run.role, output })).resolves.toBe(true);
    await expect(store.accept(run.capabilityRef!, { runId: run.id, role: run.role, output })).resolves.toBe(false);
    expect(db!.get<{ status: string; output: string }>("SELECT status, output FROM agent_runs WHERE id = $id", { id: run.id }))
      .toEqual({ status: "COMPLETING", output: JSON.stringify(output) });
  });

  it("resumes an in-progress run", async () => {
    await setup();
    const startedRun = await runService.startRun({
      role: "reviewer",
      model: "gpt-4o",
      taskId,
      epicId,
      triggerReason: "review-request",
      contextVersion: "2.0.0",
      outputSchemaVersion: "1.0.0",
    });

    const resumedRun = await runService.resumeRun(startedRun.id, {
      sessionId: "session-123",
      attempt: 1,
    });

    expect(resumedRun.status).toBe("IN_PROGRESS");
    expect(resumedRun.sessionId).toBe("session-123");
    expect(resumedRun.attempt).toBe(1);
    expect(fakeRuntime.resumeCalls).toEqual([{ runId: startedRun.id, options: { sessionId: "session-123", attempt: 1 } }]);
    expect(db!.get<{ status: string; session_id: string; attempt: number }>(
      "SELECT status, session_id, attempt FROM agent_runs WHERE id = $id", { id: startedRun.id },
    )).toEqual({ status: "IN_PROGRESS", session_id: "session-123", attempt: 1 });
  });

  it("collects result and marks run as completed", async () => {
    await setup();
    const startedRun = await runService.startRun({
       role: "developer",
      model: "claude-3",
      taskId,
      epicId,
      triggerReason: "planning-request",
      contextVersion: "1.0.0",
      outputSchemaVersion: "1.0.0",
    });

    const output = JSON.stringify({ version: "1.0.0", outcome: "COMPLETED" });
    await runService.completionStore().accept(startedRun.capabilityRef!, {
      runId: startedRun.id, role: startedRun.role, output: JSON.parse(output),
    });
    const outcome: RunOutcome = {
      success: true,
      exitCode: 0,
       output,
       validatedSubmission: true,
       diagnostics: { runId: startedRun.id, sessionId: null, stderr: "", exitCode: 0, artifactReferences: [] },
    };

    const collected = await runService.collectResult(startedRun.id, outcome);
    expect(collected.status).toBe("COMPLETED");
    expect(collected.outputSchemaVersion).toBe("1.0.0");
  });

  it("rejects an artifact or adapter outcome that is not the authenticated submission", async () => {
    await setup();
    const run = await runService.startRun({
      role: "developer", model: "gpt-4", taskId, epicId, triggerReason: "task-assignment",
      contextVersion: "1", outputSchemaVersion: "1",
    });
    const accepted = { version: "1.0.0", outcome: "COMPLETED" };
    await runService.completionStore().accept(run.capabilityRef!, { runId: run.id, role: run.role, output: accepted });
    await expect(runService.collectResult(run.id, {
      success: true, exitCode: 0, output: JSON.stringify({ version: "1.0.0", outcome: "FAILED" }),
      validatedSubmission: true,
      diagnostics: { runId: run.id, sessionId: null, stderr: "forged", exitCode: 0, artifactReferences: [] },
    })).rejects.toThrow(/matching the authenticated submission/);
  });

  it("requires COMPLETING status even when an outcome claims validation", async () => {
    await setup();
    const run = await runService.startRun({
      role: "developer", model: "gpt-4", taskId, epicId, triggerReason: "task-assignment",
      contextVersion: "1", outputSchemaVersion: "1",
    });
    const output = JSON.stringify({ version: "1.0.0", outcome: "COMPLETED" });
    await expect(runService.collectResult(run.id, {
      success: true, exitCode: 0, output, validatedSubmission: true,
      diagnostics: { runId: run.id, sessionId: null, stderr: "", exitCode: 0, artifactReferences: [] },
    })).rejects.toThrow(/COMPLETING/);
  });

  it("uses scripted outcomes from FakeAgentRuntime", async () => {
    await setup();
    fakeRuntime.script("developer", [
      { success: true, exitCode: 0, output: "Code generated" },
    ]);

    const run = await runService.startRun({
      role: "developer",
      model: "gpt-4",
      taskId,
      epicId,
      triggerReason: "task-assignment",
      contextVersion: "1.0.0",
      outputSchemaVersion: "1.0.0",
    });

    const result = await fakeRuntime.collectResult(run.id);
    expect(result.output).toBe("Code generated");
    expect(result.success).toBe(true);
  });

  it("fails when no scripted outcome is available", async () => {
    await setup();
    const run = await runService.startRun({
      role: "tester",
      model: "gpt-4",
      taskId,
      epicId,
      triggerReason: "test-assignment",
      contextVersion: "1.0.0",
      outputSchemaVersion: "1.0.0",
    });

    await expect(() => fakeRuntime.collectResult(run.id)).rejects.toThrow(/No scripted outcome available/);
  });
});
