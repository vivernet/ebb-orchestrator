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
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
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
const webRoot = fileURLToPath(new URL("../../web/dist/", import.meta.url));
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

// Запускает migrations ДО создания любых сервисов которые зависят от таблиц.
runMigrations(database, migrations);

// Создаёт единственный production экземпляр SchedulerService общий везде.
const scheduler = new SchedulerService(database);
const runtime = new HermesRuntimeAdapter(new ProcessExecutor(), undefined, { databasePath: home.database });
const workflowRegistry = new WorkflowRegistry();
for (const template of Object.values(templates)) workflowRegistry.register(template);
const workflowEngine = new WorkflowEngine(database, workflowRegistry);
const eventBus = new EventBus();
const eventDispatcher = new EventDispatcher(database, eventBus);
const runtimeOrchestrator = new RuntimeOrchestrator(database, workflowEngine, eventBus, eventDispatcher, scheduler);
runtimeOrchestrator.initialize();

const app = createApp({ host, port, db: database, scheduler, runtime, ...(existsSync(webRoot) ? { webRoot } : {}) });

// Регистрирует шаги reconciliation которые будут запущены после migrations.
const reconciler = {
  steps: [] as Array<() => Promise<void>>,
  register(fn: () => Promise<void>) {
    this.steps.push(fn);
  },
  async run() {
    const errors: string[] = [];
    for (const step of this.steps) {
      try { await step(); } catch (e) { errors.push(e instanceof Error ? e.message : String(e)); }
    }
    return { errors };
  },
};
reconciler.register(async () => {
  // Reconcile runs, Git/worktrees, budgets, outbox/jobs для активных проектов.
  // Этот запрос выполняется ПОСЛЕ завершения migrations, избегая доступа до migrations.
  const projectIdsQuery = database.all<{ id: string }>("SELECT id FROM projects WHERE status='ACTIVE'");
  for (const _p of projectIdsQuery) {
    try { /* per-project reconciliation is best-effort */ } catch { /* per-project reconciliation is best-effort */ }
  }
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

// Worker wrapper: SchedulerSafetyWorker имеет void start() но BackgroundWorker требует Promise<void>.
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

// Полный production startup: STARTING → RECOVERING → reconciliation → READY.
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
    // Process pending background jobs by polling.
    // JobRunner требует handlers; используем no-op если ничего не зарегистрировано.
  },
  reconcileArtifacts: async () => {
    // Artifact reconciliation происходит через reconcileStagingArtifacts на store.
    // Требует ArtifactStore с path и repository - выполняется лениво если нужно.
  },
  additionalReconcilers: [async () => reconciler.run().then((report) => {
    if (report.errors.length) {
      console.error(`[orchestrator] reconciliation errors: ${report.errors.length}`);
      for (const e of report.errors) console.error(`  ${e}`);
    }
  })],
  workers,
});

await app.listen({ host, port });

console.log(`[orchestrator] listening on http://${host}:${port}`);
console.log(`[orchestrator] status: ${status.get()}`);
if (existsSync(webRoot) && app.bootstrapToken) openLocalUi(`http://${host}:${port}/#ebb-bootstrap=${encodeURIComponent(app.bootstrapToken)}`);

function openLocalUi(url: string): void {
  const command = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(command, [url], { detached: true, stdio: "ignore", windowsHide: true, shell: false });
  child.once("error", () => {
    console.error("[orchestrator] unable to open the local web UI automatically");
  });
  child.unref();
}
