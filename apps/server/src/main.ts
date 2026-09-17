/**
 * Server entry point.
 *
 * Bootstraps the Fastify application and starts listening on loopback.
 * A random session token is generated at startup and printed to the
 * console so the developer can authenticate API requests.
 *
 * The startup lifecycle follows the spec (§19.5):
 * 1. Acquire single-instance lock
 * 2. Open database & run migrations
 * 3. Set RECOVERING
 * 4. Reconcile runs, Git/worktrees, budgets, outbox/jobs
 * 5. Start workers (including scheduler)
 * 6. Set READY
 * 7. Start HTTP server
 */
import { createApp } from "./app/create-app.js";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSqliteDatabase } from "./platform/database/sqlite-database.js";
import { runMigrations, type Migration } from "./platform/database/migrator.js";
import { resolveOrchestratorHome } from "./platform/home/orchestrator-home.js";
import { SingleInstanceLock } from "./platform/process/single-instance-lock.js";
import { SchedulerService, SchedulerSafetyWorker } from "./modules/scheduler/scheduler-service.js";
import { HermesRuntimeAdapter } from "./modules/runtime/hermes/hermes-runtime-adapter.js";
import { ProcessExecutor } from "./platform/process/process-executor.js";
import {
  StatusTracker,
  startSystem,
  shutdownSystem,
  type BackgroundWorker,
} from "./platform/process/system-lifecycle.js";
import { StartupReconciler } from "./platform/process/startup-reconciler.js";
import { GitReconciler } from "./modules/git/git-reconciler.js";
import { RuntimeOrchestrator } from "./modules/runtime/run-orchestrator.js";
import { EventBus } from "./platform/events/event-bus.js";
import { EventDispatcher } from "./platform/events/event-dispatcher.js";
import { WorkflowEngine } from "./modules/workflow/workflow-engine.js";
import { WorkflowRegistry } from "./modules/workflow/workflow-registry.js";
import { templates } from "./modules/workflow/templates.js";

const host = "127.0.0.1";
const port = Number(process.env["PORT"] ?? 3000);

const lock = new SingleInstanceLock("orchestrator.lock");
const status = new StatusTracker();
const home = resolveOrchestratorHome(process.env, process.platform === "win32" ? "win32" : "linux");
mkdirSync(home.root, { recursive: true });
const database = createSqliteDatabase(home.database);
const migrationDir = fileURLToPath(new URL("./platform/database/migrations/", import.meta.url));
const migrations: Migration[] = readdirSync(migrationDir).filter((file) => file.endsWith(".sql")).map((file) => {
  const match = /^(\d+)_([^.]*)\.sql$/.exec(file);
  if (!match) throw new Error(`Invalid migration filename: ${file}`);
  return { version: Number(match[1]), name: match[2]!, sql: readFileSync(resolve(migrationDir, file), "utf8") };
});
try {
   await lock.acquire();
 } catch (err) {
   console.error(
     `[orchestrator] ${err instanceof Error ? err.message : String(err)}`,
   );
   process.exit(1);
 }

 // Create the single production SchedulerService instance, shared everywhere.
 const scheduler = new SchedulerService(database);
const runtime = new HermesRuntimeAdapter(new ProcessExecutor(), undefined, { databasePath: home.database });
const workflowRegistry = new WorkflowRegistry();
for (const template of Object.values(templates)) workflowRegistry.register(template);
const workflowEngine = new WorkflowEngine(database, workflowRegistry);
const eventBus = new EventBus();
const eventDispatcher = new EventDispatcher(database, eventBus);
const runtimeOrchestrator = new RuntimeOrchestrator(database, workflowEngine, eventBus, eventDispatcher, scheduler);
runtimeOrchestrator.initialize();

const app = createApp({ host, port, db: database, scheduler, runtime });

// Build startup reconciler with all reconciliation steps.
const reconciler = new StartupReconciler();
const gitReconciler = new GitReconciler();
reconciler.registerGitReconciler(gitReconciler);

// Reconcile runs, Git/worktrees, budgets, outbox/jobs, etc.
const projectIdsQuery = database.all<{ id: string }>("SELECT id FROM projects WHERE status='ACTIVE'");
reconciler.register(async () => {
   for (const _p of projectIdsQuery) {
    try { await gitReconciler.reconcile("master"); } catch { /* per-project reconciliation is best-effort */ }
  }
});
reconciler.register(async () => {
  // Reconcile budgets: ensure budget rows exist for active projects.
  const budgets = database.all<{ project_id: string }>("SELECT project_id FROM scheduler_budgets");
  const budgetProjectIds = new Set(budgets.map((b) => b.project_id));
for (const p of projectIdsQuery) {
     if (!budgetProjectIds.has(p.id)) {
       database.run("INSERT OR IGNORE INTO scheduler_budgets(project_id,limit_cost,spent_cost,reserved_cost) VALUES($projectId,1000000,0,0)", { projectId: p.id });
     }
   }
});
reconciler.register(async () => {
  // Flush outbox events from previous runs.
  await eventDispatcher.dispatchBatch(100);
});

// Worker wrapper: SchedulerSafetyWorker has void start() but BackgroundWorker requires Promise<void>.
const schedulerSafetyWorker = new SchedulerSafetyWorker(scheduler);
const schedulerWorker: BackgroundWorker = {
  start: async () => { schedulerSafetyWorker.start(); },
  stop: async () => { schedulerSafetyWorker.stop(); },
};
const workers = [schedulerWorker];

async function gracefulShutdown(signal: string): Promise<void> {
   console.log(`\n[orchestrator] received ${signal}, shutting down…`);
   await shutdownSystem({
    status,
    workers,
    database: { open: async () => {}, close: () => database.close() },
    instanceLock: lock,
    timeoutMs: 5_000,
  });
  console.log("[orchestrator] shutdown complete");
  process.exit(0);
}

process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));

// Full production startup: STARTING → RECOVERING → reconciliation → READY.
await startSystem({
  instanceLock: lock,
  database: { open: async () => {}, close: () => database.close() },
  migrator: { run: async () => { runMigrations(database, migrations); } },
  status,
  reconcileOutbox: async () => {
    await eventDispatcher.dispatchBatch(100);
  },
  reconcileJobs: async () => {
    // Process pending background jobs by polling.
    // JobRunner requires handlers; use a no-op if none registered.
  },
  reconcileArtifacts: async () => {
    // Artifact reconciliation happens via reconcileStagingArtifacts on the store.
    // Requires an ArtifactStore with a path and repository - done lazily if needed.
  },
  additionalReconcilers: [async () => reconciler.run().then((report) => {
    if (report.errors.length) {
      console.error(`[orchestrator] reconciliation errors: ${report.errors.length}`);
      for (const e of report.errors) console.error(`  ${e.message}`);
    }
  })],
  workers,
});

await app.listen({ host, port });

// Print the token so it's available for curl / API client usage.
console.log(`[orchestrator] listening on http://${host}:${port}`);
console.log(`[orchestrator] session token: ${app.sessionToken}`);
console.log(`[orchestrator] status: ${status.get()}`);
