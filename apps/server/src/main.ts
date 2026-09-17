/**
 * Server entry point.
 *
 * Bootstraps the Fastify application and starts listening on loopback.
 * A random session token is generated at startup and printed to the
 * console so the developer can authenticate API requests.
 *
 * The startup lifecycle is:
 * 1. Acquire single-instance lock
 * 2. Open database & run migrations
 * 3. Reconcile outbox / jobs / artifacts
 * 4. Set status to READY
 * 5. Start HTTP server and workers
 */
import { createApp } from "./app/create-app.js";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSqliteDatabase } from "./platform/database/sqlite-database.js";
import { runMigrations, type Migration } from "./platform/database/migrator.js";
import { resolveOrchestratorHome } from "./platform/home/orchestrator-home.js";
import { SingleInstanceLock } from "./platform/process/single-instance-lock.js";
import { SchedulerSafetyWorker, SchedulerService } from "./modules/scheduler/scheduler-service.js";
import {
  StatusTracker,
  shutdownSystem,
} from "./platform/process/system-lifecycle.js";

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
runMigrations(database, migrations);

try {
  await lock.acquire();
} catch (err) {
  console.error(
    `[orchestrator] ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}

const scheduler = new SchedulerService(database);
const app = createApp({ host, port, db: database, scheduler });

// Use the production scheduler instance for restart recovery and the periodic
// safety pass. Ambiguous ownership is intentionally preserved by reconcile().
scheduler.reconcile();
const schedulerSafetyWorker = new SchedulerSafetyWorker(scheduler);
schedulerSafetyWorker.start();

await app.listen({ host, port });
await status.set("READY");

// Print the token so it's available for curl / API client usage.
console.log(`[orchestrator] listening on http://${host}:${port}`);
console.log(`[orchestrator] session token: ${app.sessionToken}`);
console.log(`[orchestrator] status: ${status.get()}`);

// Graceful shutdown on SIGINT / SIGTERM.
async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`\n[orchestrator] received ${signal}, shutting down…`);
  schedulerSafetyWorker.stop();
  await shutdownSystem({
    status,
    workers: [],
    database: { open: async () => {}, close: () => database.close() },
    instanceLock: lock,
    timeoutMs: 5_000,
  });
  console.log("[orchestrator] shutdown complete");
  process.exit(0);
}

process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
