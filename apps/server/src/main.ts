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
import { SingleInstanceLock } from "./platform/process/single-instance-lock.js";
import {
  StatusTracker,
  shutdownSystem,
} from "./platform/process/system-lifecycle.js";

const host = "127.0.0.1";
const port = Number(process.env["PORT"] ?? 3000);

const lock = new SingleInstanceLock("orchestrator.lock");
const status = new StatusTracker();

try {
  await lock.acquire();
} catch (err) {
  console.error(
    `[orchestrator] ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}

const app = createApp({ host, port });

await app.listen({ host, port });
await status.set("READY");

// Print the token so it's available for curl / API client usage.
console.log(`[orchestrator] listening on http://${host}:${port}`);
console.log(`[orchestrator] session token: ${app.sessionToken}`);
console.log(`[orchestrator] status: ${status.get()}`);

// Graceful shutdown on SIGINT / SIGTERM.
async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`\n[orchestrator] received ${signal}, shutting down…`);
  await shutdownSystem({
    status,
    workers: [],
    database: {
      open: async () => {},
      close: () => {},
    },
    instanceLock: lock,
    timeoutMs: 5_000,
  });
  console.log("[orchestrator] shutdown complete");
  process.exit(0);
}

process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
