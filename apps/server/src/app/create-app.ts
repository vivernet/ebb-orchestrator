/**
 * Application factory for the orchestrator server.
 *
 * Creates a Fastify instance with local-session authentication, origin
 * validation, closed CORS, and all top-level routes registered.
 *
 * @see spec §13.2 – loopback-only, local session auth, origin validation,
 *                    CSRF protection, closed CORS, SSE for live updates.
 */
import Fastify, { type FastifyInstance } from "fastify";
import {
  createLocalSession,
  type LocalSession,
} from "../platform/security/local-session.js";
import { healthRoutes } from "./routes/health.js";
import { eventRoutes } from "./routes/events.js";

export interface AppDeps {
  /** Loopback host (default "127.0.0.1"). */
  host?: string;
  /** Port the server will listen on (default 3000). */
  port?: number;
}

export interface OrchestratorApp extends FastifyInstance {
  /** The bearer token required for protected routes. */
  sessionToken: string;
}

/**
 * Build and return a Fastify instance ready to listen.
 *
 * - Registers a global preHandler that enforces local-session auth and
 *   origin validation on every route except `GET /api/v1/health`.
 * - Attaches `sessionToken` on the returned instance for programmatic
 *   access (used by tests and by main.ts for startup logging).
 */
export function createApp(deps: AppDeps = {}): OrchestratorApp {
  const host = deps.host ?? "127.0.0.1";
  const port = deps.port ?? 3000;

  const session: LocalSession = createLocalSession({ host, port });

  const app = Fastify({ logger: false }) as unknown as OrchestratorApp;

  // Expose the token on the instance so callers (tests, main) can read it.
  app.sessionToken = session.token;

  // ── Global security hook ───────────────────────────────────────────
  // Skip authentication for the health endpoint; everything else requires
  // a valid bearer token.  Mutating methods (POST/PUT/PATCH/DELETE) also
  // require a matching Origin header to prevent CSRF.
  app.addHook("preHandler", async (request, reply) => {
    const url: string = request.url;

    // Health is public – no auth, no origin check.
    if (url === "/api/v1/health") return;

    // ── 1. Authentication ────────────────────────────────────────────
    const auth = request.headers.authorization;
    if (auth !== `Bearer ${session.token}`) {
      reply.code(401).send({ error: "unauthorized" });
      return reply;
    }

    // ── 2. Origin validation (mutating methods only) ─────────────────
    const mutating = request.method !== "GET" && request.method !== "HEAD";
    if (mutating) {
      const origin = request.headers.origin;
      // Absent origin is allowed (same-origin / non-CORS).
      if (origin !== undefined && origin !== session.allowedOrigin) {
        reply.code(403).send({ error: "forbidden" });
        return reply;
      }
    }
  });

  // ── Routes ─────────────────────────────────────────────────────────
  // Public
  app.register(healthRoutes);

  // Authenticated
  app.register(eventRoutes);

  // Protected test route (used by security tests)
  app.post("/api/v1/protected-test", async () => {
    return { ok: true };
  });

  return app;
}
