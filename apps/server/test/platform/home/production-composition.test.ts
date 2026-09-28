import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createProductionComposition } from "../../../src/platform/home/production-composition.js";
import { resolveOrchestratorHome } from "../../../src/platform/home/orchestrator-home.js";
import { InMemorySecretStore } from "../../../src/platform/security/secret-store.js";
import type { Database } from "../../../src/platform/database/database.js";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { HermesRuntimeAdapter } from "../../../src/modules/runtime/hermes/hermes-runtime-adapter.js";
import { TaskWorkspaceProvisioner } from "../../../src/modules/git/task-workspace-provisioner.js";
import { ProcessExecutor } from "../../../src/platform/process/process-executor.js";
import { GitReconciler } from "../../../src/modules/git/git-reconciler.js";
import { startSystem, type SystemStatus } from "../../../src/platform/process/system-lifecycle.js";

describe("production composition", () => {
  let temporaryRoot = "";
  let database: Database | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    database?.close();
    database = undefined;
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = "";
  });

  it("builds home-bound production adapters without filesystem or process side effects", () => {
    temporaryRoot = "";
    const home = resolveOrchestratorHome({ EBB_ORCHESTRATOR_HOME: "C:/test/orchestrator" }, "win32");
    const execSpy = vi.spyOn(ProcessExecutor.prototype, "exec");

    const composition = createProductionComposition({
      database: {} as Database,
      home,
      secretStore: new InMemorySecretStore(),
      provider: { baseUrl: "https://provider.example/v1", secretName: "acceptance" },
    });

    expect(composition.paths.taskWorktreeDirectory).toBe(join(home.worktrees, "tasks"));
    expect(composition.paths.integrationWorktreeRoot).toBe(join(home.worktrees, "epic-integration"));
    expect(composition.paths.hermesResultDirectory).toBe(join(home.runtime, "hermes", "results"));
    expect(composition.paths.hermesCheckpointDirectory).toBe(join(home.runtime, "checkpoints"));
    expect(composition.runtime).toBeInstanceOf(HermesRuntimeAdapter);
    expect((composition.runtime as unknown as { databasePath: string }).databasePath).toBe(home.database);
    expect((composition.runtime as unknown as { resultDirectory: string }).resultDirectory).toBe(composition.paths.hermesResultDirectory);
    expect((composition.runtime as unknown as { checkpointDirectory: string }).checkpointDirectory).toBe(composition.paths.hermesCheckpointDirectory);
    expect(composition.taskWorkspaceProvisioner).toBeInstanceOf(TaskWorkspaceProvisioner);
    expect((composition.taskWorkspaceProvisioner as unknown as { worktrees: { worktreeDir: string } }).worktrees.worktreeDir)
      .toBe(composition.paths.taskWorktreeDirectory);
    expect((composition.artifactStore as unknown as { artifactsDir: string }).artifactsDir).toBe(home.artifacts);
    expect(typeof composition.integrationServiceFactory).toBe("function");
    expect(existsSync(home.runtime)).toBe(false);
    expect(existsSync(home.artifacts)).toBe(false);
    expect(execSpy).not.toHaveBeenCalled();
  });

  it("creates integration workspaces under the integration root supplied by production composition", async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "ebb-production-composition-"));
    const home = resolveOrchestratorHome({ EBB_ORCHESTRATOR_HOME: temporaryRoot }, "win32");
    database = createSqliteDatabase(join(temporaryRoot, "composition.db"));
    const composition = createProductionComposition({ database, home, secretStore: new InMemorySecretStore() });
    const expectedWorktree = join(composition.paths.integrationWorktreeRoot, "epic-1", "task-1");

    const integration = composition.integrationServiceFactory({
      repoPath: temporaryRoot,
      worktreeRoot: composition.paths.integrationWorktreeRoot,
      epicId: "epic-1",
      taskId: "task-1",
    });

    expect((integration as unknown as { worktreeDir: string }).worktreeDir).toBe(expectedWorktree);
    expect(existsSync(expectedWorktree)).toBe(true);
  });

  it("composes startup recovery callbacks with the configured Git reconciler", async () => {
    const events: string[] = [];
    const fakeDatabase = {
      all: vi.fn((sql: string) => {
        if (sql.includes("onboarding_configs")) {
          return [{ repository_path: "C:/repositories/project", proposed_json: '{"defaultBranch":"develop"}' }];
        }
        if (sql.includes("SELECT id FROM projects")) return [{ id: "project-1" }];
        if (sql.includes("scheduler_budgets")) return [];
        return [];
      }),
      run: vi.fn((sql: string) => { events.push(sql.includes("background_jobs") ? "jobs" : "budget"); }),
    } as unknown as Database;
    const gitReconciler = {
      initialize: vi.fn(async (repoPath: string) => { events.push(`initialize:${repoPath}`); }),
      reconcile: vi.fn(async (branch: string) => {
        events.push(`git:${branch}`);
        return { state: "IN_SYNC" as const };
      }),
    } as unknown as GitReconciler;
    temporaryRoot = await mkdtemp(join(tmpdir(), "ebb-production-recovery-"));
    const home = resolveOrchestratorHome({ EBB_ORCHESTRATOR_HOME: temporaryRoot }, "win32");
    const composition = createProductionComposition({
      database: fakeDatabase,
      home,
      secretStore: new InMemorySecretStore(),
      gitReconciler,
    });
    const startup = composition.createStartupReconciliation({
      runService: { reconcileInterruptedRuns: () => { events.push("runs"); return 0; } },
      eventDispatcher: { dispatchBatch: async () => { events.push("outbox"); return 0; } },
      status: { get: () => "RECOVERING", set: async () => { events.push("degraded"); } },
    });

    await startup.reconcileOutbox();
    await startup.reconcileJobs();
    await startup.reconcileArtifacts();
    for (const reconcile of startup.additionalReconcilers) await reconcile();

    expect(events).toEqual([
      "outbox",
      "jobs",
      "initialize:C:/repositories/project",
      "git:develop",
      "runs",
      "budget",
    ]);
    expect(gitReconciler.initialize).toHaveBeenCalledTimes(1);
    expect(gitReconciler.reconcile).toHaveBeenCalledWith("develop");
    expect(startup.additionalReconcilers).toHaveLength(1);
  });

  it("runs composed recovery after migrations and before workers become ready", async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "ebb-production-lifecycle-"));
    const events: string[] = [];
    let currentStatus: SystemStatus = "STARTING";
    let startup: ReturnType<ReturnType<typeof createProductionComposition>["createStartupReconciliation"]> | undefined;
    const fakeDatabase = {
      all: vi.fn((sql: string) => {
        if (sql.includes("onboarding_configs")) {
          return [{ repository_path: "C:/repositories/project", proposed_json: '{"defaultBranch":"main"}' }];
        }
        if (sql.includes("SELECT id FROM projects")) return [{ id: "project-1" }];
        return [];
      }),
      run: vi.fn((sql: string) => { events.push(sql.includes("background_jobs") ? "jobs" : "budget-check"); }),
    } as unknown as Database;
    const composition = createProductionComposition({
      database: fakeDatabase,
      home: resolveOrchestratorHome({ EBB_ORCHESTRATOR_HOME: temporaryRoot }, "win32"),
      secretStore: new InMemorySecretStore(),
      gitReconciler: {
        initialize: async () => { events.push("git-initialize"); },
        reconcile: async () => { events.push("git-reconcile"); return { state: "IN_SYNC" }; },
      },
    });

    await startSystem({
      instanceLock: { acquire: async () => ({ pid: 1 }), release: async () => {} },
      lockAlreadyAcquired: true,
      database: { open: async () => { events.push("database-open"); }, close: () => {} },
      migrator: { run: async () => {
        events.push("migrations");
        startup = composition.createStartupReconciliation({
          runService: { reconcileInterruptedRuns: () => { events.push("runs"); return 0; } },
          eventDispatcher: { dispatchBatch: async () => { events.push("outbox"); return 0; } },
          status: { get: () => currentStatus, set: async (next) => { currentStatus = next; events.push(`status:${next}`); } },
        });
      } },
      status: { get: () => currentStatus, set: async (next) => { currentStatus = next; events.push(`status:${next}`); } },
      reconcileOutbox: async () => { await startup!.reconcileOutbox(); },
      reconcileJobs: async () => { await startup!.reconcileJobs(); },
      reconcileArtifacts: async () => { await startup!.reconcileArtifacts(); },
      additionalReconcilers: [async () => { await startup!.additionalReconcilers[0]!(); }],
      workers: [{ start: async () => { events.push("worker-start"); }, stop: async () => {} }],
    });

    expect(events).toEqual([
      "database-open",
      "migrations",
      "status:RECOVERING",
      "outbox",
      "jobs",
      "git-initialize",
      "git-reconcile",
      "runs",
      "budget-check",
      "worker-start",
      "status:READY",
    ]);
    expect(currentStatus).toBe("READY");
  });
});
