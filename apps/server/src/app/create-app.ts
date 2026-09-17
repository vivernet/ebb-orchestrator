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
import type { Database } from "../platform/database/database.js";
import { DashboardProjection } from "./read-models/dashboard-projection.js";
import { projectRoutes } from "./routes/projects.js";
import { workRoutes, type WorkCommandService } from "./routes/work.js";
import { approvalRoutes, type ApprovalCommandService } from "./routes/approvals.js";
import { runRoutes, type RunCommandService } from "./routes/runs.js";
import { WorkService } from "../modules/work/work-service.js";
import { ApprovalService } from "../modules/approvals/approval-service.js";
import { RunService } from "../modules/runtime/run-service.js";
import type { AgentRuntime } from "../modules/runtime/agent-runtime.js";

const localRuntime: AgentRuntime = {
  async startRun() {}, async resumeRun() {}, async cancelRun() {},
  async inspectRun() { throw new Error("runtime inspection is unavailable"); },
  async collectResult() { throw new Error("runtime result collection is unavailable"); },
  async collectUsage() { return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, cost: 0 }; },
  async healthCheck() { return true; },
};

export interface AppDeps {
  /** Loopback host (default "127.0.0.1"). */
  host?: string;
  /** Port the server will listen on (default 3000). */
  port?: number;
  db?: Database;
  workService?: WorkCommandService;
  approvalService?: ApprovalCommandService;
  runService?: RunCommandService;
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
  const workService = deps.workService ?? (deps.db ? new WorkService(deps.db) : undefined);
  const approvalService = deps.approvalService ?? (deps.db ? new ApprovalService(deps.db) : undefined);
  const runService = deps.runService ?? (deps.db ? new RunService(deps.db, localRuntime) : undefined);

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
      // A bearer token is not a CSRF token by itself: browser requests must
      // also prove they originated from this local application.
      if (origin !== session.allowedOrigin) {
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
  app.register(async (instance) => {
    instance.get("/api/v1/dashboard", async () => new DashboardProjection(deps.db).get());
    await projectRoutes(instance, { db: deps.db });
    await workRoutes(instance, { db: deps.db, workService });
    await approvalRoutes(instance, { db: deps.db, approvalService });
    await runRoutes(instance, { db: deps.db, runService });
  });

  // Protected test route (used by security tests)
  app.post("/api/v1/protected-test", async () => {
    return { ok: true };
  });

  return app;
}
