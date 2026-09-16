/**
 * Server entry point.
 *
 * Bootstraps the Fastify application and starts listening on loopback.
 * A random session token is generated at startup and printed to the
 * console so the developer can authenticate API requests.
 */
import { createApp } from "./app/create-app.js";

const host = "127.0.0.1";
const port = Number(process.env["PORT"] ?? 3000);

const app = createApp({ host, port });

await app.listen({ host, port });

// Print the token so it's available for curl / API client usage.
console.log(`[orchestrator] listening on http://${host}:${port}`);
console.log(`[orchestrator] session token: ${app.sessionToken}`);
