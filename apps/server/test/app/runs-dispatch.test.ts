import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app/create-app.js";
import { createSqliteDatabase } from "../../src/platform/database/sqlite-database.js";
import { runMigrations, type Migration } from "../../src/platform/database/migrator.js";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createTestAuthService, TEST_COOKIE, TEST_CSRF_TOKEN } from "../helpers/auth.js";
import type { StartRunOptions } from "../../src/modules/runtime/run-types.js";

const migrationDir = fileURLToPath(new URL("../../src/platform/database/migrations/", import.meta.url));
const migrations: Migration[] = readdirSync(migrationDir).filter((file) => file.endsWith(".sql")).map((file) => ({
  version: Number(/^([0-9]+)/.exec(file)?.[1]),
  name: file.replace(/^[0-9]+_/, "").replace(/\.sql$/, ""),
  sql: readFileSync(join(migrationDir, file), "utf8"),
}));

function setup() {
  const db = createSqliteDatabase(":memory:");
  runMigrations(db, migrations);
  const run = {
    id: "run-1", role: "developer", runtime: "hermes", model: "default", taskId: "task-1", epicId: null,
    status: "STARTED", sessionId: null, attempt: null, triggerReason: "runtime-request", contextVersion: "runtime-request-v1",
    outputSchemaVersion: "1", startedAt: new Date(), endedAt: null, exitCode: null, inputTokens: null,
    cachedInputTokens: null, outputTokens: null, cost: null,
  } as never;
  const runService = {
    cancelRun: vi.fn(),
    prepareRun: vi.fn((_options: StartRunOptions) => run),
    executePreparedRun: vi.fn(async () => ({ run, outcome: { success: true } })),
    failPreparedRun: vi.fn().mockReturnValue(true),
  };
  const scheduler = {
    assertProjectDispatchable: vi.fn(),
    dispatchTask: vi.fn(),
    releaseTask: vi.fn(),
    projectProjection: vi.fn(() => ({ global: { active: 0, max: 1 }, projects: [] })),
  };
  const app = createApp({ db, scheduler: scheduler as never, runService, authService: createTestAuthService() });
  const now = new Date().toISOString();
  const workspace = mkdtempSync(join(tmpdir(), "dispatch-workspace-"));
  execFileSync("git", ["init", "--quiet"], { cwd: workspace, windowsHide: true });
  execFileSync("git", ["checkout", "--quiet", "-b", "task/task-1"], { cwd: workspace, windowsHide: true });
  writeFileSync(join(workspace, "fixture.txt"), "managed dispatch test\n", "utf8");
  execFileSync("git", ["add", "fixture.txt"], { cwd: workspace, windowsHide: true });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "fixture"], { cwd: workspace, windowsHide: true });
  db.run(
    `INSERT INTO worktrees (id,repo_path,path,branch,created_at,removed_at)
     VALUES ('task-1',$workspace, $workspace, 'task/task-1', $now, NULL)`,
    { workspace, now },
  );
  db.run(
    `INSERT INTO git_operations(id,type,status,repo_path,branch_name,worktree_id,target_ref,created_at,verified_at)
     VALUES('dispatch-op','CREATE_WORKTREE','VERIFIED',$workspace,'task/task-1','task-1','HEAD',$now,$now)`,
    { workspace, now },
  );
  db.run("INSERT INTO projects (id,name,display_name,status,created_at,updated_at) VALUES ('project-1','p','P','ACTIVE',$now,$now)", { now });
  db.run(
    `INSERT INTO tasks (id,project_id,display_id,title,status,contract_json,created_at,updated_at)
     VALUES ('task-1','project-1','T-1','Task','READY',$contract,$now,$now)`,
    { contract: JSON.stringify({ version: 1, goal: "run", context: "test", requirements: [], acceptanceCriteria: [], dependencies: [], nonGoals: [], definitionOfDone: [] }), now },
  );
  return { app, db, runService, scheduler, workspace };
}

function headers(_app: ReturnType<typeof createApp>) {
  return { cookie: TEST_COOKIE, origin: "http://127.0.0.1:3000", "x-csrf-token": TEST_CSRF_TOKEN };
}

describe("task dispatch route", () => {
  it("prepares one durable run, binds it to scheduler, and acknowledges asynchronously", async () => {
    const { app, db, runService, scheduler, workspace } = setup();
    const response = await app.inject({ method: "POST", url: "/api/v1/tasks/task-1/dispatch", headers: headers(app) });
    expect(response.statusCode).toBe(202);
    expect(JSON.parse(response.body)).toMatchObject({ runId: "run-1", taskId: "task-1", status: "STARTED" });
    expect(runService.prepareRun).toHaveBeenCalledWith(expect.objectContaining({
      role: "developer", model: "default", taskId: "task-1", capability: { workspace },
      contextInput: expect.objectContaining({
        role: "developer", subject: { type: "TASK", id: "task-1" },
        prompt: expect.stringContaining("persisted Task Contract"),
        execution: expect.objectContaining({ targetBranch: "task/task-1", targetHead: expect.stringMatching(/^[a-f0-9]{40}$/i) }),
      }),
    }));
    expect(scheduler.dispatchTask).toHaveBeenCalledWith("task-1", expect.anything(), expect.any(Function), expect.objectContaining({ runId: "run-1" }));
    await Promise.resolve();
    expect(runService.executePreparedRun).toHaveBeenCalledWith("run-1");
    await app.close();
    db.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("retains task reservation when async dispatch fails without persisted stop proof", async () => {
    const { app, db, runService, scheduler, workspace } = setup();
    vi.mocked(runService.executePreparedRun).mockRejectedValueOnce(new Error("runtime stop is unproven"));
    vi.mocked(runService.failPreparedRun).mockReturnValueOnce(false);

    const response = await app.inject({ method: "POST", url: "/api/v1/tasks/task-1/dispatch", headers: headers(app) });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(response.statusCode).toBe(202);
    expect(runService.failPreparedRun).toHaveBeenCalledWith("run-1", expect.any(Error));
    expect(scheduler.releaseTask).not.toHaveBeenCalled();
    await app.close();
    db.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("rejects unknown fields and non-ready tasks", async () => {
    const { app, db, workspace } = setup();
    const invalid = await app.inject({ method: "POST", url: "/api/v1/tasks/task-1/dispatch", headers: headers(app), payload: { role: "developer", extra: true } });
    expect(invalid.statusCode).toBe(400);
    db.run("UPDATE tasks SET status='DRAFT' WHERE id='task-1'");
    const notReady = await app.inject({ method: "POST", url: "/api/v1/tasks/task-1/dispatch", headers: headers(app), payload: {} });
    expect(notReady.statusCode).toBe(409);
    await app.close();
    db.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("rejects an unsupported Task role before scheduler or Run preparation", async () => {
    const { app, db, workspace, runService, scheduler } = setup();
    const response = await app.inject({
      method: "POST", url: "/api/v1/tasks/task-1/dispatch", headers: headers(app), payload: { role: "coordinator" },
    });
    expect(response.statusCode).toBe(400);
    expect(runService.prepareRun).not.toHaveBeenCalled();
    expect(scheduler.assertProjectDispatchable).not.toHaveBeenCalled();
    expect(scheduler.dispatchTask).not.toHaveBeenCalled();
    await app.close();
    db.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("keeps Reviewer as a supported Task role and supplies a diff without Developer transcript", async () => {
    const { app, db, workspace, runService, scheduler } = setup();
    const response = await app.inject({ method: "POST", url: "/api/v1/tasks/task-1/dispatch", headers: headers(app), payload: { role: "reviewer" } });
    expect(response.statusCode).toBe(202);
    const options = vi.mocked(runService.prepareRun).mock.calls[0]?.[0];
    expect(options).toMatchObject({ role: "reviewer", contextInput: { role: "reviewer", roleInputs: { gitDiff: expect.any(String), checks: [] } } });
    expect(options?.contextInput?.prompt).toContain("Independently review");
    expect(options?.contextInput?.prompt).not.toContain("=== DEVELOPER TRANSCRIPT ===");
    expect(scheduler.dispatchTask).toHaveBeenCalledWith("task-1", expect.anything(), expect.any(Function), expect.objectContaining({ role: "reviewer" }));
    await app.close();
    db.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("rejects dispatch when no persisted managed workspace exists", async () => {
    const { app, db, workspace } = setup();
    db.run("UPDATE worktrees SET removed_at=$now WHERE id='task-1'", { now: new Date().toISOString() });
    const response = await app.inject({ method: "POST", url: "/api/v1/tasks/task-1/dispatch", headers: headers(app) });
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toEqual({ error: "managed task workspace is required" });
    await app.close();
    db.close();
    rmSync(workspace, { recursive: true, force: true });
  });
});
