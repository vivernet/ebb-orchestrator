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
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSqliteDatabase } from "./platform/database/sqlite-database.js";
import { type Migration } from "./platform/database/migrator.js";
import { applyMigrationsWithVerifiedBackup } from "./platform/database/backup-service.js";
import { DiagnosticsService } from "./platform/diagnostics/diagnostics-service.js";
import { resolveOrchestratorHome } from "./platform/home/orchestrator-home.js";
import { createApplicationRecoveryReconcilers, createProductionComposition } from "./platform/home/production-composition.js";
import { SingleInstanceLock } from "./platform/process/single-instance-lock.js";
import { SchedulerService, SchedulerSafetyWorker } from "./modules/scheduler/scheduler-service.js";
import { resolveHermesProviderBridgeConfig } from "./modules/runtime/hermes/hermes-provider-bridge.js";
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
import { registerCoordinatorPlanningJob } from "./modules/planning/coordinator-planning-job.js";
import { EpicOrchestrator } from "./modules/planning/epic-orchestrator.js";
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
import { ProjectConfigService } from "./modules/projects/project-config-service.js";
import { HumanFeedbackService } from "./modules/github/human-feedback-service.js";
import { GitHubAppTokenProvider } from "./modules/github/github-app-token-provider.js";
import { GitHubAdapter } from "./modules/github/github-adapter.js";
import { GitHubSyncService, SqliteSyncState } from "./modules/github/github-sync-service.js";
import { GitHubSyncWorker, SqliteFeedbackDeliveryState } from "./modules/github/github-sync-worker.js";

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
  applyMigrationsWithVerifiedBackup(database, migrations, home.backups);
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
const projectConfigService = new ProjectConfigService(database, approvalService);
const humanFeedbackService = new HumanFeedbackService(database);
const infisicalOptions = resolveInfisicalSecretStoreOptions(process.env);
const secretStore = infisicalOptions
  ? createInfisicalSecretStore(database, infisicalOptions)
  : new KeyringSecretStore(database);
const githubAdapter = new GitHubAdapter(new GitHubAppTokenProvider(secretStore));
const githubSyncWorker = new GitHubSyncWorker(githubAdapter, new GitHubSyncService(githubAdapter, new SqliteSyncState(database)), new SqliteFeedbackDeliveryState(database), {
  persistFeedback: (comment) => Promise.resolve(humanFeedbackService.receiveComment(comment)),
});
const hermesProvider = resolveHermesProviderBridgeConfig(process.env);
const diagnostics = new DiagnosticsService(database, {
  appVersion: process.env["EBB_ORCHESTRATOR_VERSION"] ?? "development",
  schemaVersion: Math.max(0, ...migrations.map((migration) => migration.version)),
});
const production = createProductionComposition({
  database,
  home,
  secretStore,
  ...(hermesProvider ? { provider: hermesProvider } : {}),
});
const { paths: productionPaths, runtime, artifactStore, epicWorkspaceProvisioner, taskWorkspaceProvisioner, integrationServiceFactory, epicMergeAuthority } = production;
const workflowRegistry = new WorkflowRegistry();
for (const template of Object.values(templates)) workflowRegistry.register(template);
const workflowEngine = new WorkflowEngine(database, workflowRegistry);
const eventBus = new EventBus();
const eventDispatcher = new EventDispatcher(database, eventBus);
const runService = new RunService(database, runtime);
const runtimeOrchestrator = new RuntimeOrchestrator(database, workflowEngine, eventBus, eventDispatcher, scheduler, runService);
runtimeOrchestrator.initialize();
const planningService = new PlanningService(database);
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
    epicWorkspaceProvisioner,
    taskWorkspaceProvisioner,
  },
);
mkdirSync(home.artifacts, { recursive: true });

const app = createApp({ host, port, db: database, scheduler, runtime, runService, artifactStore, secretStore, epicOrchestrator, status, eventBus, authService, approvalService, onboardingService, projectConfigService, humanFeedbackService, githubSyncWorker, diagnostics, ...(existsSync(webRoot) ? { webRoot } : {}) });

// Composition собирает callbacks после migrations; lifecycle запускает их
// до workers, listener и перехода в READY.
const startupReconciliation = production.createStartupReconciliation({ runService, eventDispatcher, status, projectConfigService });

// Worker wrapper: SchedulerSafetyWorker имеет void запускать() но BackgroundWorker требует Promise<void>.
const schedulerSafetyWorker = new SchedulerSafetyWorker(scheduler);
const schedulerWorker: BackgroundWorker = {
  start: async () => { schedulerSafetyWorker.start(); },
  stop: async () => { schedulerSafetyWorker.stop(); },
};
const outboxWorker = new OutboxWorker(eventDispatcher);
const backgroundJobRegistry = new BackgroundJobRegistry();
registerCoordinatorPlanningJob(backgroundJobRegistry, { db: database, planning: planningService, runs: runService, scheduler });
const backgroundJobRunner = new JobRunner(database, backgroundJobRegistry);
const backgroundJobWorker: BackgroundWorker = new JobWorker(backgroundJobRunner);
const githubFeedbackWorker: BackgroundWorker = {
  start: async () => { githubSyncWorker.startMappedRepositories(() => humanFeedbackService.listMappedRepositories()); },
  stop: async () => { githubSyncWorker.stop(); },
};
const workers = [schedulerWorker, outboxWorker, backgroundJobWorker, githubFeedbackWorker];

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
  migrator: { run: async () => { applyMigrationsWithVerifiedBackup(database, migrations, home.backups); } },
  status,
  ...startupReconciliation,
  additionalReconcilers: [
    ...startupReconciliation.additionalReconcilers,
    ...createApplicationRecoveryReconcilers({ epicOrchestrator, scheduler, planningService }),
  ],
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
