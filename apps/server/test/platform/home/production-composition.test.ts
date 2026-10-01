import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createProductionComposition } from "../../../src/platform/home/production-composition.js";
import { resolveOrchestratorHome } from "../../../src/platform/home/orchestrator-home.js";
import { InMemorySecretStore } from "../../../src/platform/security/secret-store.js";
import type { Database } from "../../../src/platform/database/database.js";
import { createSqliteDatabase } from "../../../src/platform/database/sqlite-database.js";
import { HermesRuntimeAdapter } from "../../../src/modules/runtime/hermes/hermes-runtime-adapter.js";
import { TaskWorkspaceProvisioner } from "../../../src/modules/git/task-workspace-provisioner.js";
import { EpicWorkspaceProvisioner } from "../../../src/modules/git/epic-workspace-provisioner.js";
import { ProcessExecutor } from "../../../src/platform/process/process-executor.js";
import { GitReconciler } from "../../../src/modules/git/git-reconciler.js";
import { startSystem, type SystemStatus } from "../../../src/platform/process/system-lifecycle.js";
import { runMigrations } from "../../../src/platform/database/migrator.js";
import { loadTestMigrations } from "../../helpers/migrations.js";
import { createRunContextInput, RunService, taskDeveloperPrompt } from "../../../src/modules/runtime/run-service.js";
import { seedApprovedProjectConfig } from "../../helpers/approved-project-config.js";
import { FakeAgentRuntime } from "../../fakes/fake-agent-runtime.js";
import { SchedulerService } from "../../../src/modules/scheduler/scheduler-service.js";

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
    expect(composition.paths.epicWorktreeDirectory).toBe(join(home.worktrees, "epics"));
    expect(composition.paths.integrationWorktreeRoot).toBe(join(home.worktrees, "epic-integration"));
    expect(composition.paths.hermesResultDirectory).toBe(join(home.runtime, "hermes", "results"));
    expect(composition.paths.hermesCheckpointDirectory).toBe(join(home.runtime, "checkpoints"));
    expect(composition.runtime).toBeInstanceOf(HermesRuntimeAdapter);
    expect((composition.runtime as unknown as { databasePath: string }).databasePath).toBe(home.database);
    expect((composition.runtime as unknown as { resultDirectory: string }).resultDirectory).toBe(composition.paths.hermesResultDirectory);
    expect((composition.runtime as unknown as { checkpointDirectory: string }).checkpointDirectory).toBe(composition.paths.hermesCheckpointDirectory);
    expect(composition.taskWorkspaceProvisioner).toBeInstanceOf(TaskWorkspaceProvisioner);
    expect(composition.epicWorkspaceProvisioner).toBeInstanceOf(EpicWorkspaceProvisioner);
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
      integrationRunId: "integration-run-1",
      finalizeRunFailure: () => false,
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
      transaction: vi.fn((callback: (tx: unknown) => unknown) => callback({
        all: (sql: string) => { if (sql.includes("background_jobs")) events.push("jobs"); return []; },
        run: (sql: string) => { events.push(sql.includes("background_jobs") ? "jobs" : "budget"); },
        get: () => undefined,
        exec: () => {},
      })),
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
      projectConfigService: { reconcileActiveOnStartup: () => { events.push("project-config"); } },
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
      transaction: vi.fn((callback: (tx: unknown) => unknown) => callback({
        all: (sql: string) => { if (sql.includes("background_jobs")) events.push("jobs"); return []; },
        run: (sql: string) => { events.push(sql.includes("background_jobs") ? "jobs" : "budget-check"); },
        get: () => undefined,
        exec: () => {},
      })),
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
          projectConfigService: { reconcileActiveOnStartup: () => { events.push("project-config"); } },
          status: { get: () => currentStatus, set: async (next) => { currentStatus = next; events.push(`status:${next}`); } },
        });
      } },
      status: { get: () => currentStatus, set: async (next) => { currentStatus = next; events.push(`status:${next}`); } },
      preflightRecovery: async () => { await startup!.preflightRecovery(); },
      reconcileProjectConfig: async () => { await startup!.reconcileProjectConfig(); },
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
      "project-config",
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

  it("reconciles run reservations after interrupted runs and before approved Epic resume", async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "ebb-production-scheduler-recovery-"));
    const events: string[] = [];
    let currentStatus: SystemStatus = "STARTING";
    let startup: ReturnType<ReturnType<typeof createProductionComposition>["createStartupReconciliation"]> | undefined;
    database = createSqliteDatabase(join(temporaryRoot, "startup.db"));
    runMigrations(database, loadTestMigrations());

    const now = new Date().toISOString();
    const projectId = randomUUID();
    const taskId = randomUUID();
    const approvalId = randomUUID();
    database.run(
      "INSERT INTO projects(id,name,display_name,status,created_at,updated_at) VALUES($id,'startup-test','Startup Test','ACTIVE',$now,$now)",
      { id: projectId, now },
    );
    database.run(
      "INSERT INTO approvals(id,type,subject_id,subject_type,status,requested_by,created_at) VALUES($approvalId,'WORKFLOW_CHANGE',$projectId,'PROJECT','APPROVED','test',$now)",
      { approvalId, projectId, now },
    );
    database.run(
      "INSERT INTO onboarding_configs(project_id,repository_path,facts_json,proposed_json,status,approval_id,created_at,updated_at) VALUES($projectId,$path,'{}','{}','ACTIVE',$approvalId,$now,$now)",
      { projectId, path: temporaryRoot, approvalId, now },
    );
    database.run(
      "INSERT INTO tasks(id,project_id,display_id,title,status,contract_json,required,created_at,updated_at) VALUES($taskId,$projectId,'TASK-STARTUP','Startup task','READY',$contract,1,$now,$now)",
      { taskId, projectId, contract: JSON.stringify({ version: 1, goal: "Startup recovery", context: "Scheduler recovery fixture", requirements: [], acceptanceCriteria: [], dependencies: [], nonGoals: [], definitionOfDone: [] }), now },
    );
    seedApprovedProjectConfig(database, projectId);

    const scheduler = new SchedulerService(database);
    database.run(
      "UPDATE scheduler_config SET config_json=$config WHERE id=1",
      { config: JSON.stringify({ globalMax: 1, projectMax: 1, roleCapacity: { developer: 1 } }) },
    );
    const runService = new RunService(database, new FakeAgentRuntime());
    const prompt = taskDeveloperPrompt();
    const runOptions = {
      runId: "interrupted-non-epic-run",
      role: "developer",
      model: "test",
      taskId,
      epicId: null,
      triggerReason: "task-assignment",
      contextVersion: "1",
      outputSchemaVersion: "1",
      capability: { workspace: temporaryRoot },
    } as const;
    const interruptedRun = runService.prepareRun({
      ...runOptions,
      prompt,
      contextInput: createRunContextInput(runOptions, {
        prompt,
        workspaceIdentity: { repository: temporaryRoot, workspace: temporaryRoot, worktree: taskId },
        targetHead: null,
        targetBranch: null,
      }),
    });
    scheduler.dispatchAgentRun(interruptedRun.id, projectId, "developer", "test");
    database.run("UPDATE agent_runs SET status='IN_PROGRESS' WHERE id=$id", { id: interruptedRun.id });
    expect(() => scheduler.dispatchAgentRun("probe-before-startup", projectId, "developer", "test"))
      .toThrow(/WAITING_FOR_CAPACITY/);

    const composition = createProductionComposition({
      database,
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
      database: { open: async () => {}, close: () => {} },
      migrator: { run: async () => {
        startup = composition.createStartupReconciliation({
          runService: { reconcileInterruptedRuns: () => {
            events.push("runs");
            return runService.reconcileInterruptedRuns();
          } },
          eventDispatcher: { dispatchBatch: async () => 0 },
          projectConfigService: { reconcileActiveOnStartup: () => { events.push("project-config"); } },
          status: { get: () => currentStatus, set: async (next) => { currentStatus = next; events.push(`status:${next}`); } },
        });
      } },
      status: { get: () => currentStatus, set: async (next) => { currentStatus = next; events.push(`status:${next}`); } },
      preflightRecovery: async () => { await startup!.preflightRecovery(); },
      reconcileProjectConfig: async () => { await startup!.reconcileProjectConfig(); },
      reconcileOutbox: async () => {},
      reconcileJobs: async () => {},
      reconcileArtifacts: async () => {},
      additionalReconcilers: [
        async () => { await startup!.additionalReconcilers[0]!(); },
        async () => { events.push("epic-reconcile"); },
        async () => { events.push("scheduler-reconcile"); scheduler.reconcile(); },
        async () => { events.push("planning-reconcile"); },
        async () => { events.push("execution-claims-reconcile"); },
        async () => {
          events.push("resume-approved-epics");
          expect(database!.get<{ status: string }>("SELECT status FROM scheduler_reservations WHERE run_id=$runId", { runId: interruptedRun.id })?.status)
            .toBe("RELEASED");
          scheduler.dispatchAgentRun("recovery-run", projectId, "developer", "test");
        },
      ],
      workers: [{ start: async () => { events.push("worker-start"); }, stop: async () => {} }],
    });

    expect(events).toEqual([
      "status:RECOVERING",
      "project-config",
      "git-initialize",
      "git-reconcile",
      "runs",
      "epic-reconcile",
      "scheduler-reconcile",
      "planning-reconcile",
      "execution-claims-reconcile",
      "resume-approved-epics",
      "worker-start",
      "status:READY",
    ]);
    expect(currentStatus).toBe("READY");
    expect(database.get<{ status: string }>("SELECT status FROM agent_runs WHERE id=$id", { id: interruptedRun.id })?.status)
      .toBe("FAILED");
    expect(database.get<{ status: string }>("SELECT status FROM scheduler_reservations WHERE subject_id='recovery-run'")?.status)
      .toBe("RESERVED");

    const mainSource = await readFile(join(import.meta.dirname, "../../../src/main.ts"), "utf8");
    expect(mainSource).toMatch(/additionalReconcilers:\s*\[\s*\.\.\.startupReconciliation\.additionalReconcilers,\s*async \(\) => \{\s*epicOrchestrator\.reconcileInterruptedRuns\(\);\s*\},\s*async \(\) => \{\s*scheduler\.reconcile\(\);\s*\},\s*async \(\) => \{\s*planningService\.reconcileInterruptedRequests\(\);/s);
    const runRecoveryIndex = mainSource.indexOf("...startupReconciliation.additionalReconcilers");
    const epicRecoveryIndex = mainSource.indexOf("epicOrchestrator.reconcileInterruptedRuns()");
    const schedulerRecoveryIndex = mainSource.indexOf("scheduler.reconcile()");
    const planningRecoveryIndex = mainSource.indexOf("planningService.reconcileInterruptedRequests()");
    const executionClaimsRecoveryIndex = mainSource.indexOf("epicOrchestrator.reconcileInterruptedExecutionClaims()");
    const resumeApprovedEpicsIndex = mainSource.indexOf("epicOrchestrator.resumeApprovedEpics()");
    expect(runRecoveryIndex).toBeGreaterThanOrEqual(0);
    expect(epicRecoveryIndex).toBeGreaterThan(runRecoveryIndex);
    expect(schedulerRecoveryIndex).toBeGreaterThan(epicRecoveryIndex);
    expect(planningRecoveryIndex).toBeGreaterThan(schedulerRecoveryIndex);
    expect(executionClaimsRecoveryIndex).toBeGreaterThan(planningRecoveryIndex);
    expect(resumeApprovedEpicsIndex).toBeGreaterThan(executionClaimsRecoveryIndex);
  });
});
