/**
 * Точка входа сервера.
 *
 * Запускает приложение Fastify и начинает принимать соединения на loopback.
 * Экземпляр random session token is generated at startup and printed to the
 * console so Объект developer cОбъект authenticate API requests.
 *
 * Этот startup lifecycle follows the spec (§19.5):
 * 1. Acquire single-instance lock
 * 2. Open database & run migrations
 * 3. Set RECOVERING
 * 4. Reconcile runs, Git/worktrees, budgets, outbox/jobs
 * 5. Start workers (including scheduler)
 * 6. Set READY
 * 7. Start HTTP server
 */
import { createApp } from "./app/create-app.js";
import { listActiveApprovedOnboardingRepositories } from "./modules/projects/onboarding-service.js";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSqliteDatabase } from "./platform/database/sqlite-database.js";
import { runMigrations, type Migration } from "./platform/database/migrator.js";
import { resolveOrchestratorHome } from "./platform/home/orchestrator-home.js";
import { createProductionPaths } from "./platform/home/production-paths.js";
import { SingleInstanceLock } from "./platform/process/single-instance-lock.js";
import { SchedulerService, SchedulerSafetyWorker } from "./modules/scheduler/scheduler-service.js";
import { HermesRuntimeAdapter } from "./modules/runtime/hermes/hermes-runtime-adapter.js";
import { resolveHermesProviderBridgeConfig } from "./modules/runtime/hermes/hermes-provider-bridge.js";
import { ProcessExecutor } from "./platform/process/process-executor.js";
import {
  StatusTracker,
  startSystem,
  shutdownSystem,
  type BackgroundWorker,
} from "./platform/process/system-lifecycle.js";
import { BackgroundJobRegistry } from "./platform/jobs/background-job-registry.js";
import { JobRunner } from "./platform/jobs/job-runner.js";
import { JobWorker } from "./platform/jobs/job-worker.js";
import { RuntimeOrchestrator } from "./modules/runtime/run-orchestrator.js";
import { RunService } from "./modules/runtime/run-service.js";
import { EventBus } from "./platform/events/event-bus.js";
import { EventDispatcher } from "./platform/events/event-dispatcher.js";
import { OutboxWorker } from "./platform/events/outbox-worker.js";
import { WorkflowEngine } from "./modules/workflow/workflow-engine.js";
import { WorkflowRegistry } from "./modules/workflow/workflow-registry.js";
import { templates } from "./modules/workflow/templates.js";
import { KeyringSecretStore } from "./platform/security/keyring-secret-store.js";
import { createInfisicalSecretStore, resolveInfisicalSecretStoreOptions } from "./platform/security/infisical-secret-store.js";
import { PlanningService } from "./modules/planning/planning-service.js";
import { EpicOrchestrator, type IntegrationServiceFactory } from "./modules/planning/epic-orchestrator.js";
import { IntegrationService } from "./modules/git/integration-service.js";
import { MergeService, type MergeResult } from "./modules/git/merge-service.js";
import { GitReconciler } from "./modules/git/git-reconciler.js";
import { ArtifactRepository } from "./platform/artifacts/artifact-repository.js";
import { ArtifactStore } from "./platform/artifacts/artifact-store.js";
import { WorktreeManager } from "./modules/git/worktree-manager.js";
import { TaskWorkspaceProvisioner } from "./modules/git/task-workspace-provisioner.js";
import { StartupReconciler, failClosedStartupReconciliation } from "./platform/process/startup-reconciler.js";
import {
  createStartupCleanup,
  createStartupSignalHandler,
  runStartupBoundary,
} from "./platform/process/startup-boundary.js";
import { createAuthRepository } from "./platform/security/auth-repository.js";
import { createNodeDigestPort, createNodeRandomTokenPort } from "./platform/security/auth-ports.js";
import { createArgon2PasswordHasher } from "./platform/security/password-hasher.js";
import { createAuthService } from "./platform/security/auth-service.js";
import { ensureLocalUser } from "./platform/security/local-user-wizard.js";
import { ApprovalService } from "./modules/approvals/approval-service.js";
import { OnboardingService } from "./modules/projects/onboarding-service.js";

async function startServer(): Promise<void> {
let startupCleanup: () => Promise<void> = async () => {};
try {
const host = "127.0.0.1";
const port = Number(process.env["PORT"] ?? 3000);
let serverReady = false;
const startupAbortController = new AbortController();
const handleLifecycleSignal = createStartupSignalHandler({
  controller: startupAbortController,
  isReady: () => serverReady,
  onReadySignal: (signal) => {
    void gracefulShutdown(signal).catch(() => {
      console.error("[ebb-orchestrator] graceful shutdown failed");
      process.exit(1);
    });
  },
});
process.on("SIGINT", handleLifecycleSignal);
process.on("SIGTERM", handleLifecycleSignal);

const status = new StatusTracker();
const home = resolveOrchestratorHome(process.env, process.platform === "win32" ? "win32" : "linux");
const productionPaths = createProductionPaths(home);
mkdirSync(home.root, { recursive: true });
const lock = new SingleInstanceLock(join(home.root, "orchestrator.lock"));
startupCleanup = async () => { await lock.release(); };
try {
  await lock.acquire();
} catch {
  console.error("[Ebb Orchestrator] Could not acquire the startup lock.");
  process.exit(1);
}
const database = createSqliteDatabase(home.database);
startupCleanup = createStartupCleanup({ database, instanceLock: lock });
const migrationDir = fileURLToPath(new URL("./platform/database/migrations/", import.meta.url));
const webRoot = fileURLToPath(new URL("../../web/dist/", import.meta.url));
const migrations: Migration[] = readdirSync(migrationDir).filter((file) => file.endsWith(".sql")).map((file) => {
  const match = /^(\d+)_([^.]*)\.sql$/.exec(file);
  if (!match) throw new Error(`Invalid migration filename: ${file}`);
  const name = match[2]!;
  const migration: Migration = { version: Number(match[1]), name, sql: readFileSync(resolve(migrationDir, file), "utf8") };
  return migration.version === 27 && name === "approval_changes_requested" ? { ...migration, foreignKeys: "disabled" } : migration;
});

// Запускает migrations ДО создания любых сервисов которые зависят от таблиц.
try {
  runMigrations(database, migrations);
} catch {
  await failClosedStartup("Database migration failed; server stopped before listener and workers.");
}

// Проверяет durable singleton user после migrations, но до listener, workers и READY.
const authPasswordHasher = createArgon2PasswordHasher();
const authRepository = createAuthRepository(
  database,
  authPasswordHasher,
  createNodeRandomTokenPort(),
  createNodeDigestPort(),
);
const authService = createAuthService(authRepository, authPasswordHasher, { now: () => new Date().toISOString() });
// Проверка singleton выполняется границей запуска после полной composition,
// но до lifecycle workers, listener и READY.

// Создаёт единственный production экземпляр SchedulerService общий везде.
const scheduler = new SchedulerService(database);
const approvalService = new ApprovalService(database);
const onboardingService = new OnboardingService(database, approvalService);
const infisicalOptions = resolveInfisicalSecretStoreOptions(process.env);
const secretStore = infisicalOptions
  ? createInfisicalSecretStore(database, infisicalOptions)
  : new KeyringSecretStore(database);
const hermesProvider = resolveHermesProviderBridgeConfig(process.env);
const runtime = new HermesRuntimeAdapter(new ProcessExecutor(), undefined, {
  databasePath: productionPaths.hermesDatabasePath,
  resultDirectory: productionPaths.hermesResultDirectory,
  checkpointDirectory: productionPaths.hermesCheckpointDirectory,
  secretStore,
  ...(hermesProvider ? { provider: hermesProvider } : {}),
});
const workflowRegistry = new WorkflowRegistry();
for (const template of Object.values(templates)) workflowRegistry.register(template);
const workflowEngine = new WorkflowEngine(database, workflowRegistry);
const eventBus = new EventBus();
const eventDispatcher = new EventDispatcher(database, eventBus);
const runService = new RunService(database, runtime);
const runtimeOrchestrator = new RuntimeOrchestrator(database, workflowEngine, eventBus, eventDispatcher, scheduler, runService);
runtimeOrchestrator.initialize();
const planningService = new PlanningService(database);
const integrationServiceFactory: IntegrationServiceFactory = ({ worktreeRoot, epicId, taskId }) => new IntegrationService({
  database,
  worktreeDir: join(worktreeRoot, epicId, taskId),
});
const taskWorkspaceProvisioner = new TaskWorkspaceProvisioner({
  database,
  worktreeManager: new WorktreeManager({
    db: database,
    worktreeDir: productionPaths.taskWorktreeDirectory,
  }),
});
const epicMergeAuthority = createEpicMergeAuthority(database);
const epicOrchestrator = new EpicOrchestrator(
  database,
  workflowEngine,
  planningService,
  runService,
  epicMergeAuthority,
  scheduler,
  {
    integrationServiceFactory,
    integrationWorktreeRoot: productionPaths.integrationWorktreeRoot,
    taskWorkspaceProvisioner,
  },
);
mkdirSync(home.artifacts, { recursive: true });
const artifactStore = new ArtifactStore(home.artifacts, new ArtifactRepository(database));

const app = createApp({ host, port, db: database, scheduler, runtime, runService, secretStore, epicOrchestrator, status, eventBus, authService, approvalService, onboardingService, ...(existsSync(webRoot) ? { webRoot } : {}) });

// Регистрирует шаги reconciliation которые будут запущены после migrations.
const reconciler = new StartupReconciler();
reconciler.register(async () => {
  // Reconcile runs, Git/worktrees, budgets, outbox/jobs для активных проектов.
  // Этот запрос выполняется ПОСЛЕ завершения migrations, избегая доступа до migrations.
  const errors: string[] = [];
  const onboarding = listActiveApprovedOnboardingRepositories(database);
  for (const project of onboarding) {
    try {
      const proposed = JSON.parse(project.proposed_json) as { defaultBranch?: unknown };
      const branch = typeof proposed.defaultBranch === "string" && proposed.defaultBranch.length > 0 ? proposed.defaultBranch : "master";
      const git = new GitReconciler();
      await git.initialize(project.repository_path);
      const result = await git.reconcile(branch);
      if (result.state !== "IN_SYNC") console.warn(`[ebb-orchestrator] Git drift: ${result.state}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[ebb-orchestrator] Git reconciliation failed: ${message}`);
      errors.push(message);
    }
  }
  if (errors.length > 0) throw new Error(`Git reconciliation failed: ${errors.join("; ")}`);
});
reconciler.register(async () => {
  const interrupted = runService.reconcileInterruptedRuns();
  console.warn(`[ebb-orchestrator] Recovered interrupted runs: ${interrupted}`);
});
reconciler.register(async () => {
// Reconcile budgets: гарантирует что бюджетные строки существуют для активных проектов.
  const projectIdsQuery = database.all<{ id: string }>("SELECT id FROM projects WHERE status='ACTIVE'");
  const budgets = database.all<{ project_id: string }>("SELECT project_id FROM scheduler_budgets");
  const budgetProjectIds = new Set(budgets.map((b) => b.project_id));
  for (const p of projectIdsQuery) {
    if (!budgetProjectIds.has(p.id)) {
      database.run("INSERT OR IGNORE INTO scheduler_budgets(project_id,limit_cost,spent_cost,reserved_cost) VALUES($projectId,1000000,0,0)", { projectId: p.id });
    }
  }
});
reconciler.register(async () => {
// Flush outbox событий из предыдущих запусков.
await eventDispatcher.dispatchBatch(100);
});

// Worker wrapper: SchedulerSafetyWorker имеет void запускать() но BackgroundWorker требует Promise<void>.
const schedulerSafetyWorker = new SchedulerSafetyWorker(scheduler);
const schedulerWorker: BackgroundWorker = {
  start: async () => { schedulerSafetyWorker.start(); },
  stop: async () => { schedulerSafetyWorker.stop(); },
};
const outboxWorker = new OutboxWorker(eventDispatcher);
const backgroundJobRegistry = new BackgroundJobRegistry();
const backgroundJobRunner = new JobRunner(database, backgroundJobRegistry);
const backgroundJobWorker: BackgroundWorker = new JobWorker(backgroundJobRunner);
const workers = [schedulerWorker, outboxWorker, backgroundJobWorker];

async function gracefulShutdown(signal: string): Promise<void> {
   console.log(`\n[ebb-orchestrator] received ${signal}, shutting down…`);
   await shutdownSystem({
    status,
    workers,
    database: { open: async () => {}, close: () => database.close() },
    instanceLock: lock,
    timeoutMs: 5_000,
  });
  console.log("[ebb-orchestrator] shutdown complete");
  process.exit(0);
}

async function ensureLocalUserBeforeStartup(): Promise<void> {
  await ensureLocalUser(authRepository, process.stdin, process.stdout, {
    mode: process.argv.includes("--bootstrap-local-user-stdin") ? "stdin" : "tty",
    signal: startupAbortController.signal,
  });
}

// Полный production startup: STARTING → RECOVERING → reconciliation → READY.
async function startLifecycle(): Promise<void> {
  await startSystem({
  instanceLock: lock,
  lockAlreadyAcquired: true,
  database: { open: async () => {}, close: () => database.close() },
  migrator: { run: async () => { runMigrations(database, migrations); } },
  status,
  reconcileOutbox: async () => {
    await eventDispatcher.dispatchBatch(100);
  },
  reconcileJobs: async () => {
    // Возвращаем протухшие leases в очередь; handlers выполняются только
    // зарегистрированным JobRunner, а не произвольным runtime output.
    database.run(
      `UPDATE background_jobs
          SET status='QUEUED', lease_owner=NULL, lease_expires_at=NULL, updated_at=$now
        WHERE status='RUNNING' AND lease_expires_at < $now`,
      { now: new Date().toISOString() },
    );
  },
  reconcileArtifacts: async () => {
    await artifactStore.reconcileStagingArtifacts();
  },
  additionalReconcilers: [async () => {
    const report = await reconciler.run();
    if (report.errors.length) {
      console.error(`[ebb-orchestrator] reconciliation errors: ${report.errors.length}`);
      for (const error of report.errors) console.error(`  ${error.message}`);
    }
    await failClosedStartupReconciliation(report, status);
  }],
  workers,
  signal: startupAbortController.signal,
  });
}

startupCleanup = createStartupCleanup({
  server: { isListening: () => app.server.listening, close: () => app.close() },
  workers,
  database,
  instanceLock: lock,
});
try {
  await runStartupBoundary({
    ensureLocalUser: ensureLocalUserBeforeStartup,
    startSystem: startLifecycle,
    listen: async () => app.listen({ host, port }),
    signal: startupAbortController.signal,
    cleanupStartup: startupCleanup,
    onReady: () => { serverReady = true; },
  });
} catch {
  await failClosedStartup("Startup failed or was interrupted before READY; server stopped safely.");
}

console.log(`[ebb-orchestrator] listening on http://${host}:${port}`);
console.log(`[ebb-orchestrator] status: ${status.get()}`);

/** Завершает startup до READY без вывода исходных storage/secret errors. */
async function failClosedStartup(message: string): Promise<never> {
  console.error(`[ebb-orchestrator] ${message}`);
  try {
    await startupCleanup();
  } catch {
    console.error("[ebb-orchestrator] startup resource cleanup failed");
  }
  process.exit(1);
  throw new Error(message);
}

/**
 * Возвращает только authority-bound Epic merge facade. Репозиторий выбирается
 * из активного onboarding по Epic; клиентские refs и paths в этот слой не попадают.
 */
function createEpicMergeAuthority(db: typeof database): {
  mergeApproved(subjectId: string, approvalId: string): Promise<MergeResult>;
  mergeApprovedForIntegration(subjectId: string, approvalId: string, integrationRunId: string): Promise<MergeResult>;
} {
  const resolveRepository = (epicId: string): string => {
    const row = db.get<{ repository_path: string }>(
      `SELECT oc.repository_path
         FROM onboarding_configs oc
         JOIN approvals a ON a.id=oc.approval_id
         JOIN epics e ON e.project_id=oc.project_id
        WHERE e.id=$epicId AND oc.status='ACTIVE'
          AND a.subject_type='PROJECT' AND a.subject_id=oc.project_id
          AND a.type='WORKFLOW_CHANGE' AND a.status='APPROVED'`,
      { epicId },
    );
    if (!row?.repository_path) throw new Error("active onboarding repository is required");
    return row.repository_path;
  };
  return {
    async mergeApproved(subjectId, approvalId) {
      throw new Error(`Epic merge requires exact Integration provenance: ${subjectId}:${approvalId}`);
    },
    async mergeApprovedForIntegration(subjectId, approvalId, integrationRunId) {
      const service = new MergeService({ database: db, repoPath: resolveRepository(subjectId) });
      return service.mergeApprovedForIntegration(subjectId, approvalId, integrationRunId);
    },
  };
}
} catch {
  try {
    await startupCleanup();
  } catch {
    console.error("[ebb-orchestrator] startup resource cleanup failed");
  }
  console.error("[ebb-orchestrator] startup failed before READY; the server stopped safely");
  process.exit(1);
}
}

await startServer();
