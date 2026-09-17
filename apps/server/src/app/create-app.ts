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
import { SchedulerService } from "../modules/scheduler/scheduler-service.js";
import { WorkflowEngine } from "../modules/workflow/workflow-engine.js";
import { WorkflowRegistry } from "../modules/workflow/workflow-registry.js";
import { templates } from "../modules/workflow/templates.js";
import { schedulerRoutes } from "./routes/scheduler.js";

export interface AppDeps {
  /** Loopback host (default "127.0.0.1"). */
  host?: string;
  /** Port the server will listen on (default 3000). */
  port?: number;
  db?: Database;
  workService?: WorkCommandService;
  approvalService?: ApprovalCommandService;
  runService?: RunCommandService;
  scheduler?: SchedulerService;
  /** Production must provide the real runtime. Test doubles belong in test deps. */
  runtime?: AgentRuntime;
}

export interface OrchestratorApp extends FastifyInstance {
  /** The bearer token required for protected routes. */
  sessionToken: string;
  csrfToken: string;
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
  const workflowRegistry = new WorkflowRegistry();
  for (const template of Object.values(templates)) workflowRegistry.register(template);
  const workflow = deps.db ? new WorkflowEngine(deps.db, workflowRegistry) : undefined;
  const scheduler = deps.scheduler ?? (deps.db ? new SchedulerService(deps.db) : undefined);
  const workService = deps.workService ?? (deps.db ? new WorkService(deps.db, workflow) : undefined);
  const approvalService = deps.approvalService ?? (deps.db ? new ApprovalService(deps.db) : undefined);
  if (deps.db && !deps.runtime && !deps.runService) throw new Error("production runtime is required");
  const runService = deps.runService ?? (deps.db && deps.runtime ? new RunService(deps.db, deps.runtime) : undefined);

  const app = Fastify({ logger: false }) as unknown as OrchestratorApp;

  // Expose the token on the instance so callers (tests, main) can read it.
  app.sessionToken = session.token;
  app.csrfToken = session.csrfToken;

  // ── Global security hook ───────────────────────────────────────────
  // Skip authentication for the health endpoint; everything else requires
  // a valid bearer token.  Mutating methods (POST/PUT/PATCH/DELETE) also
  // require a matching Origin header to prevent CSRF.
  app.addHook("preHandler", async (request, reply) => {
    const url: string = request.url;

    // Health is public – no auth, no origin check.
    if (url === "/api/v1/health" || url === "/api/v1/session/bootstrap") return;

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
      if (request.headers["x-csrf-token"] !== session.csrfToken) {
        reply.code(403).send({ error: "invalid csrf token" });
        return reply;
      }
    }
  });

  // ── Routes ─────────────────────────────────────────────────────────
  // Public
  app.register(healthRoutes);
  app.get("/api/v1/session/bootstrap", async () => ({
    sessionToken: session.token,
    csrfToken: session.csrfToken,
    origin: session.allowedOrigin,
  }));

  // Authenticated
  app.register(eventRoutes);
  app.register(async (instance) => schedulerRoutes(instance, scheduler));
  app.register(async (instance) => {
    instance.get("/api/v1/dashboard", async () => new DashboardProjection(deps.db, scheduler).get());
     await projectRoutes(instance, { db: deps.db, scheduler });
     await workRoutes(instance, { db: deps.db, workService, scheduler });
    await approvalRoutes(instance, { db: deps.db, approvalService });
     await runRoutes(instance, { db: deps.db, runService, scheduler });
  });

  // Protected test route (used by security tests)
  app.post("/api/v1/protected-test", async () => {
    return { ok: true };
  });

  return app;
}
