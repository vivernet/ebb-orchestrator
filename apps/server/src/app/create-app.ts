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
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { timingSafeEqual } from "node:crypto";
import {
  createLocalSession,
  type LocalSession,
} from "../platform/security/local-session.js";
import { healthRoutes } from "./routes/health.js";
import { eventRoutes } from "./routes/events.js";
import { onboardingRoutes, type OnboardingApprovalService, type OnboardingCommandService } from "./routes/onboarding.js";
import { settingsRoutes } from "./routes/settings.js";
import { usageRoutes } from "./routes/usage.js";
import type { Database } from "../platform/database/database.js";
import { DashboardProjection } from "./read-models/dashboard-projection.js";
import { projectRoutes, type ProjectCommandService } from "./routes/projects.js";
import { workRoutes, type WorkCommandService } from "./routes/work.js";
import { approvalRoutes, type ApprovalCommandService } from "./routes/approvals.js";
import { runRoutes, type RunCommandService } from "./routes/runs.js";
import { WorkService } from "../modules/work/work-service.js";
import { ProjectService } from "../modules/projects/project-service.js";
import { ApprovalService } from "../modules/approvals/approval-service.js";
import { RunService } from "../modules/runtime/run-service.js";
import type { AgentRuntime } from "../modules/runtime/agent-runtime.js";
import { SchedulerService } from "../modules/scheduler/scheduler-service.js";
import { WorkflowEngine } from "../modules/workflow/workflow-engine.js";
import { WorkflowRegistry } from "../modules/workflow/workflow-registry.js";
import { templates } from "../modules/workflow/templates.js";
import { schedulerRoutes } from "./routes/scheduler.js";
import { githubRoutes } from "./routes/github.js";
import { diagnosticsRoutes } from "./routes/diagnostics.js";
import { secretsRoutes } from "./routes/secrets.js";
import type { GitHubSyncWorker } from "../modules/github/github-sync-worker.js";
import type { DiagnosticsService } from "../platform/diagnostics/diagnostics-service.js";
import type { SecretStore } from "../platform/security/secret-store.js";
import { OnboardingService } from "../modules/projects/onboarding-service.js";
import { DependencyService } from "../modules/work/dependency-service.js";
import { dependencyRoutes, type DependencyCommandService } from "./routes/dependencies.js";
import { finalMergeRoutes, type FinalMergeServiceFactory } from "./routes/final-merge.js";
import { epicRoutes } from "./routes/epics.js";
import type { EpicOrchestrator } from "../modules/planning/epic-orchestrator.js";
import type { StatusTrackerInterface } from "../platform/process/system-lifecycle.js";

const LOCAL_SESSION_COOKIE = "ebb_local_session";

export interface AppDeps {
  /** Loopback host (default "127.0.0.1"). */
  host?: string;
  /** Port the server will listen on (default 3000). */
  port?: number;
  db?: Database;
  projectService?: ProjectCommandService;
  workService?: WorkCommandService;
  approvalService?: ApprovalCommandService;
  onboardingService?: OnboardingCommandService;
  runService?: RunCommandService;
  dependencyService?: DependencyCommandService;
  /** Optional authority-bound factory; production default uses MergeService. */
  finalMergeServiceFactory?: FinalMergeServiceFactory;
  /** Production Epic planning/orchestration facade. */
  epicOrchestrator?: Pick<EpicOrchestrator, "start" | "approveAndRun">;
  /** Production must provide the single shared SchedulerService instance. */
  scheduler: SchedulerService;
  /** Production must provide the real runtime. Test doubles belong in test deps. */
  runtime?: AgentRuntime;
  github?: { worker: GitHubSyncWorker; repository: string };
  diagnostics?: DiagnosticsService;
  /** Production SecretStore; tests may inject an explicit deterministic backend. */
  secretStore?: SecretStore;
  /** Lifecycle status exposed by the public readiness probe. */
  status?: StatusTrackerInterface;
  /** Абсолютный путь к собранному Vite bundle для same-origin production UI. */
  webRoot?: string;
}

export interface OrchestratorApp extends FastifyInstance {
  /** Bearer-токен для programmatic callers; browser использует HttpOnly cookie. */
  sessionToken: string;
  csrfToken: string;
  /** Одноразовый capability, который trusted launcher передаёт UI через URL fragment. */
  bootstrapToken: string | null;
}

/**
 * Build and return a Fastify instance ready to listen.
 *
 * - Registers a global preHandler that enforces local-session auth and
 *   origin validation on every route except `GET /api/v1/health`.
 * - Attaches `sessionToken` on the returned instance for programmatic
 *   access (used by tests and by main.ts for startup logging).
 */
export function createApp(deps: AppDeps): OrchestratorApp {
  const host = deps.host ?? "127.0.0.1";
  const port = deps.port ?? 3000;

  const session: LocalSession = createLocalSession({ host, port });
  const workflowRegistry = new WorkflowRegistry();
  for (const template of Object.values(templates)) workflowRegistry.register(template);
  const workflow = deps.db ? new WorkflowEngine(deps.db, workflowRegistry) : undefined;
  const scheduler = deps.scheduler;
  const workService = deps.workService ?? (deps.db ? new WorkService(deps.db, workflow) : undefined);
  const projectService = deps.projectService ?? (deps.db ? new ProjectService(deps.db) : undefined);
  const approvalService = deps.approvalService ?? (deps.db ? new ApprovalService(deps.db) : undefined);
  const onboardingService = deps.onboardingService ?? (deps.db ? new OnboardingService() : undefined);
  if (deps.db && !deps.runtime && !deps.runService) throw new Error("production runtime is required");
  const runService = deps.runService ?? (deps.db && deps.runtime ? new RunService(deps.db, deps.runtime) : undefined);
  const dependencyService = deps.dependencyService ?? (deps.db ? new DependencyService(deps.db) : undefined);

  const app = Fastify({ logger: false }) as unknown as OrchestratorApp;

  // Expose the token on the instance so callers (tests, main) can read it.
  app.sessionToken = session.token;
  app.csrfToken = session.csrfToken;
  app.bootstrapToken = session.bootstrapToken;

  // ── Global security hook ───────────────────────────────────────────
  // Skip authentication for the health endpoint; everything else requires
  // a valid bearer token or the HttpOnly browser session cookie. Mutating methods also
  // require a matching Origin header to prevent CSRF.
  app.addHook("preHandler", async (request, reply) => {
    const url = new URL(request.url, session.allowedOrigin).pathname;

    // Built Web UI assets do not carry authority. Every API route remains
    // behind the local session boundary below.
    if (!url.startsWith("/api/v1/")) return;

    // Health is public – no auth, no origin check.
    if (url === "/api/v1/health" || url === "/api/v1/session/bootstrap") return;

    // ── 1. Authentication ────────────────────────────────────────────
    const auth = request.headers.authorization;
    const sessionCookie = readCookie(request.headers.cookie, LOCAL_SESSION_COOKIE);
    if (auth !== `Bearer ${session.token}` && sessionCookie !== session.token) {
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
  app.register(async (instance) => healthRoutes(instance, deps.status));
  app.get("/api/v1/session/bootstrap", async (request, reply) => {
    const supplied = request.headers["x-ebb-bootstrap-token"];
    if (typeof supplied !== "string" || !session.bootstrapToken || !safeEquals(supplied, session.bootstrapToken)) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    session.bootstrapToken = null;
    app.bootstrapToken = null;
    reply.header("set-cookie", createSessionCookie(session.token));
    return {
      sessionToken: session.token,
      csrfToken: session.csrfToken,
      origin: session.allowedOrigin,
    };
  });
  app.get("/api/v1/session", async () => ({
    csrfToken: session.csrfToken,
    origin: session.allowedOrigin,
  }));

  // Authenticated
  app.register(eventRoutes);
  app.register(async (instance) => schedulerRoutes(instance, scheduler));
  app.register(async (instance) => {
    instance.get("/api/v1/dashboard", async () => new DashboardProjection(deps.db, scheduler).get());
    await projectRoutes(instance, { db: deps.db, scheduler, projectService });
    await workRoutes(instance, { db: deps.db, workService, scheduler });
    await dependencyRoutes(instance, { db: deps.db, dependencyService });
    await finalMergeRoutes(instance, { db: deps.db, mergeServiceFactory: deps.finalMergeServiceFactory, workflow });
    await epicRoutes(instance, { db: deps.db, epicOrchestrator: deps.epicOrchestrator });
    await approvalRoutes(instance, { db: deps.db, approvalService });
    await runRoutes(instance, { db: deps.db, runService, scheduler, workflow });
    await onboardingRoutes(instance, {
      db: deps.db,
      onboardingService,
      approvalService: approvalService && "request" in approvalService
        ? approvalService as OnboardingApprovalService
        : undefined,
    });
    await settingsRoutes(instance, { db: deps.db });
    await usageRoutes(instance, { db: deps.db });
    await secretsRoutes(instance, {
      db: deps.db,
      ...(deps.secretStore ? { store: deps.secretStore } : {}),
    });
    if (deps.github) await githubRoutes(instance, deps.github);
    if (deps.diagnostics) await diagnosticsRoutes(instance, deps.diagnostics);
  });

  // Protected test route (used by security tests)
  app.post("/api/v1/protected-test", async () => {
    return { ok: true };
  });

  if (deps.webRoot) registerWebUiRoutes(app, deps.webRoot);

  return app;
}

function safeEquals(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

/** Создаёт неперсистентную browser-session cookie, недоступную JavaScript. */
function createSessionCookie(token: string): string {
  return `${LOCAL_SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/api/v1`;
}

/** Извлекает известную cookie без интерпретации остальных недоверенных значений. */
function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return null;
}

function registerWebUiRoutes(app: FastifyInstance, webRoot: string): void {
  if (!existsSync(webRoot)) return;
  let root: string;
  try {
    if (!lstatSync(webRoot).isDirectory()) return;
    root = realpathSync(webRoot);
  } catch {
    return;
  }

  const serveIndex = (reply: { type(contentType: string): { send(value: string | Buffer): unknown } }) =>
    reply.type("text/html; charset=utf-8").send(readFileSync(resolve(root, "index.html")));

  app.get("/", async (_request, reply) => serveIndex(reply));
  app.get<{ Params: { "*": string } }>("/*", async (request, reply) => {
    const rawPath = request.params["*"];
    if (rawPath.startsWith("api/")) return reply.code(404).send({ error: "not found" });

    let requested: string;
    try {
      requested = decodeURIComponent(rawPath);
    } catch {
      return reply.code(400).send({ error: "invalid path" });
    }
    const candidate = resolve(root, requested);
    if (!isWithinRoot(root, candidate)) return reply.code(404).send({ error: "not found" });

    try {
      const canonicalCandidate = realpathSync(candidate);
      if (!isWithinRoot(root, canonicalCandidate) || !lstatSync(canonicalCandidate).isFile()) {
        return reply.code(404).send({ error: "not found" });
      }
      return reply.type(contentTypeFor(canonicalCandidate)).send(readFileSync(canonicalCandidate));
    } catch {
      if (extname(requested)) return reply.code(404).send({ error: "not found" });
      return serveIndex(reply);
    }
  });
}

function isWithinRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (
    pathFromRoot !== ".."
    && !pathFromRoot.startsWith(`..${sep}`)
    && !isAbsolute(pathFromRoot)
  );
}

function contentTypeFor(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".css": return "text/css; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".json": return "application/json; charset=utf-8";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".ico": return "image/x-icon";
    default: return "application/octet-stream";
  }
}
