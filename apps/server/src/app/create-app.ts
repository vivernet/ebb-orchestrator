/**
 * Фабрика приложения сервера оркестратора.
 *
 * Создаёт экземпляр Fastify с аутентификацией local-session, валидацией origin,
 * закрытым CORS и зарегистрированными маршрутами верхнего уровня.
 *
 * @see spec §13.2 — режим только loopback, аутентификация local session,
 *                    валидация origin, защита CSRF, закрытый CORS и SSE для live-обновлений.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { AUTH_CONTRACT_VERSION, AUTH_COOKIE_CONTRACT, AUTH_TOKEN_BYTES, type AuthErrorCode } from "@ebb-orchestrator/contracts";
import type { AuthService } from "../platform/security/auth-service.js";
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
import type { EventBus } from "../platform/events/event-bus.js";

const LOCAL_SESSION_COOKIE = AUTH_COOKIE_CONTRACT.name;

export interface AppDeps {
  /** Loopback хост; по умолчанию "127.0.0.1". */
  host?: string;
  /** Порт, на котором сервер принимает соединения; по умолчанию 3000. */
  port?: number;
  db?: Database;
  projectService?: ProjectCommandService;
  workService?: WorkCommandService;
  approvalService?: ApprovalCommandService;
  onboardingService?: OnboardingCommandService;
  runService?: RunCommandService;
  dependencyService?: DependencyCommandService;
  /** Необязательная authority-bound factory; production по умолчанию использует MergeService. */
  finalMergeServiceFactory?: FinalMergeServiceFactory;
  /** Production facade для Epic planning/orchestration. */
  epicOrchestrator?: Pick<EpicOrchestrator, "start" | "approveAndRun"> & Partial<Pick<EpicOrchestrator, "approveFinalMergeAsync">>;
  /** Production должен передать единственный общий экземпляр SchedulerService. */
  scheduler: SchedulerService;
  /** Production должен передать настоящий runtime; test doubles относятся к test deps. */
  runtime?: AgentRuntime;
  github?: { worker: GitHubSyncWorker; repository: string };
  diagnostics?: DiagnosticsService;
  /** Production SecretStore; тесты могут передать явный deterministic backend. */
  secretStore?: SecretStore;
  /** Статус lifecycle, публикуемый в открытом readiness probe. */
  status?: StatusTrackerInterface;
  /** Источник потока событий только для чтения для аутентифицированных SSE-клиентов. */
  eventBus?: EventBus;
  /** Абсолютный путь к собранному Vite bundle для same-origin production UI. */
  webRoot?: string;
  /** Единственная auth authority; production не использует process-local session. */
  authService: AuthService;
}

export type OrchestratorApp = FastifyInstance;

/**
 * Создаёт и возвращает экземпляр Fastify, готовый принимать соединения.
 *
 * - Регистрирует глобальный preHandler, обеспечивающий durable cookie auth и
 *   валидацию Origin/CSRF на всех API-маршрутах, кроме health и session adapters.
 */
export function createApp(deps: AppDeps): OrchestratorApp {
  const host = deps.host ?? "127.0.0.1";
  const port = deps.port ?? 3000;

  const allowedOrigin = `http://${host}:${port}`;
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

  // Невалидный JSON Fastify отклоняет до route handler; login всё равно обязан
  // вернуть тот же versioned `AUTH_INVALID_REQUEST`, что и ручная валидация DTO.
  app.setErrorHandler((error, request, reply) => {
    const path = new URL(request.url, allowedOrigin).pathname;
    const statusCode = error instanceof Error ? (error as Error & { statusCode?: number }).statusCode : undefined;
    if (path === "/api/v1/session/login" && statusCode === 400) {
      sendAuthError(reply, 400, "AUTH_INVALID_REQUEST");
      return;
    }
    reply.send(error);
  });

  // Проверяем Origin login до разбора тела: parser не должен раскрывать формат
  // запроса для cross-origin отправителя.
  app.addHook("onRequest", async (request, reply) => {
    const url = new URL(request.url, allowedOrigin).pathname;
    if (url === "/api/v1/session/login" && request.headers.origin !== allowedOrigin) {
      return sendAuthError(reply, 403, "AUTH_ORIGIN_INVALID");
    }
  });

  // ── Глобальный security hook ───────────────────────────────────────
  // Пропускает аутентификацию для health endpoint; все остальные маршруты требуют
  // корректный bearer token или HttpOnly cookie браузерной сессии. Изменяющие методы также
  // требуют совпадающий Origin header для предотвращения CSRF.
  app.addHook("preHandler", async (request, reply) => {
    const url = new URL(request.url, allowedOrigin).pathname;

    // Собранные assets Web UI не несут authority. Каждый API-маршрут остаётся
    // за границей local session ниже.
    if (!url.startsWith("/api/v1/")) return;
    if (!request.routeOptions.url) return reply.code(404).send({ error: "not found" });

    if (url === "/api/v1/health" || url === "/api/v1/session" || url === "/api/v1/session/login" || url === "/api/v1/session/logout") return;

    // ── 1. Аутентификация ─────────────────────────────────────────────
    const sessionCookie = readCookie(request.headers.cookie, LOCAL_SESSION_COOKIE);
    const rawSessionToken = decodeToken(sessionCookie);
    if (!rawSessionToken) {
      sendAuthError(reply, 401, sessionCookie === null ? "AUTH_SESSION_REQUIRED" : "AUTH_SESSION_INVALID");
      return reply;
    }

    let rawCsrfToken: Uint8Array | null = null;
    try {
      // ── 2. Валидация origin (только для изменяющих методов) ─────────
      const mutating = request.method !== "GET" && request.method !== "HEAD";
      if (mutating) {
        // Bearer токен сам по себе не является CSRF токен: браузерные запросы также
        // должны подтвердить происхождение из этого локального приложения.
        if (request.headers.origin !== allowedOrigin) {
          sendAuthError(reply, 403, "AUTH_ORIGIN_INVALID");
          return reply;
        }
        rawCsrfToken = decodeToken(typeof request.headers["x-csrf-token"] === "string" ? request.headers["x-csrf-token"] : null);
        const authenticated = await deps.authService.authenticateCsrfAndTouch(rawSessionToken, rawCsrfToken);
        if (!authenticated.ok) {
          sendAuthError(reply, authenticated.code === "UNAVAILABLE" ? 503 : authenticated.code === "SESSION_INVALID" ? 401 : 403, authenticated.code === "UNAVAILABLE" ? "AUTH_UNAVAILABLE" : authenticated.code === "SESSION_INVALID" ? "AUTH_SESSION_INVALID" : "AUTH_CSRF_INVALID");
          return reply;
        }
        return;
      }

      const authenticated = await deps.authService.authenticateAndTouch(rawSessionToken);
      if (!authenticated.ok) {
        sendAuthError(reply, authenticated.code === "UNAVAILABLE" ? 503 : 401, authenticated.code === "UNAVAILABLE" ? "AUTH_UNAVAILABLE" : "AUTH_SESSION_INVALID");
        return reply;
      }
    } finally {
      rawCsrfToken?.fill(0);
      rawSessionToken.fill(0);
    }
  });

  // ── Маршруты ───────────────────────────────────────────────────────
  // Открытые
  app.register(async (instance) => healthRoutes(instance, deps.status));
  app.post<{ Body: unknown }>("/api/v1/session/login", async (request, reply) => {
    if (request.headers.origin !== allowedOrigin) return sendAuthError(reply, 403, "AUTH_ORIGIN_INVALID");
    const body = request.body;
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || typeof (body as { password?: unknown }).password !== "string") {
      return sendAuthError(reply, 400, "AUTH_INVALID_REQUEST");
    }
    const password = Buffer.from((body as { password: string }).password, "utf8");
    let rawSessionToken: Uint8Array | undefined;
    let rawCsrfToken: Uint8Array | undefined;
    try {
      const result = await deps.authService.login(password);
      if (!result.ok) return sendAuthError(reply, result.code === "UNAVAILABLE" ? 503 : 401, result.code === "UNAVAILABLE" ? "AUTH_UNAVAILABLE" : "AUTH_INVALID_CREDENTIALS");
      rawSessionToken = result.value.rawSessionToken;
      rawCsrfToken = result.value.rawCsrfToken;
      reply.header("set-cookie", createSessionCookie(rawSessionToken, result.value.session.absoluteExpiresAt));
      return result.value.response;
    } finally {
      password.fill(0);
      rawSessionToken?.fill(0);
      rawCsrfToken?.fill(0);
    }
  });

  app.get("/api/v1/session", async (request, reply) => {
    const sessionCookie = readCookie(request.headers.cookie, LOCAL_SESSION_COOKIE);
    const rawSessionToken = decodeToken(sessionCookie);
    if (!rawSessionToken) return sendAuthError(reply, 401, sessionCookie === null ? "AUTH_SESSION_REQUIRED" : "AUTH_SESSION_INVALID");
    let rawCsrfToken: Uint8Array | undefined;
    try {
      const result = await deps.authService.restoreAndRotateCsrf(rawSessionToken);
      if (!result.ok) return sendAuthError(reply, result.code === "UNAVAILABLE" ? 503 : 401, result.code === "UNAVAILABLE" ? "AUTH_UNAVAILABLE" : "AUTH_SESSION_INVALID");
      rawCsrfToken = result.value.rawCsrfToken;
      return result.value.response;
    } finally {
      rawSessionToken.fill(0);
      rawCsrfToken?.fill(0);
    }
  });

  app.post("/api/v1/session/logout", async (request, reply) => {
    if (request.headers.origin !== allowedOrigin) return sendAuthError(reply, 403, "AUTH_ORIGIN_INVALID");
    let rawSessionToken: Uint8Array | null = null;
    let rawCsrfToken: Uint8Array | null = null;
    try {
      // Оба decode находятся под одной cleanup ownership boundary: второй decode
      // не может оставить первый сырой токен необнулённым при исключении.
      rawSessionToken = decodeToken(readCookie(request.headers.cookie, LOCAL_SESSION_COOKIE));
      rawCsrfToken = decodeToken(typeof request.headers["x-csrf-token"] === "string" ? request.headers["x-csrf-token"] : null);
      const result = await deps.authService.logout(rawSessionToken, rawCsrfToken);
      if (!result.ok) return sendAuthError(reply, result.code === "UNAVAILABLE" ? 503 : 403, result.code === "UNAVAILABLE" ? "AUTH_UNAVAILABLE" : "AUTH_CSRF_INVALID");
      reply.header("set-cookie", createClearingCookie());
      return reply.code(204).send();
    } finally {
      rawSessionToken?.fill(0);
      rawCsrfToken?.fill(0);
    }
  });

  // Аутентифицированные
  app.register(async (instance) => eventRoutes(instance, deps.eventBus));
  app.register(async (instance) => schedulerRoutes(instance, scheduler));
  app.register(async (instance) => {
    instance.get("/api/v1/dashboard", async () => new DashboardProjection(deps.db, scheduler).get());
    await projectRoutes(instance, { db: deps.db, scheduler, projectService });
    await workRoutes(instance, { db: deps.db, workService, scheduler });
    await dependencyRoutes(instance, { db: deps.db, dependencyService });
    await finalMergeRoutes(instance, { db: deps.db, mergeServiceFactory: deps.finalMergeServiceFactory, workflow, epicOrchestrator: deps.epicOrchestrator });
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
    await settingsRoutes(instance, { scheduler: deps.scheduler });
    await usageRoutes(instance, { db: deps.db });
    await secretsRoutes(instance, {
      db: deps.db,
      ...(deps.secretStore ? { store: deps.secretStore } : {}),
    });
    if (deps.github) await githubRoutes(instance, deps.github);
    if (deps.diagnostics) await diagnosticsRoutes(instance, deps.diagnostics);
  });

  // Защищённый тестовый маршрут (используется security-тестами).
  app.post("/api/v1/protected-test", async () => {
    return { ok: true };
  });

  if (deps.webRoot) registerWebUiRoutes(app, deps.webRoot);

  return app;
}

function sendAuthError(reply: { code(status: number): { send(body: unknown): unknown }; send(body: unknown): unknown }, status: number, code: AuthErrorCode): unknown {
  const messages: Record<AuthErrorCode, string> = {
    AUTH_INVALID_REQUEST: "Некорректный запрос.",
    AUTH_INVALID_CREDENTIALS: "Неверные учётные данные.",
    AUTH_ORIGIN_INVALID: "Недопустимый Origin.",
    AUTH_UNAVAILABLE: "Аутентификация временно недоступна.",
    AUTH_SESSION_REQUIRED: "Требуется сессия.",
    AUTH_SESSION_INVALID: "Сессия недействительна.",
    AUTH_CSRF_INVALID: "Недействительный CSRF-токен.",
  };
  return reply.code(status).send({ contractVersion: AUTH_CONTRACT_VERSION, error: { code, message: messages[code] } });
}

/** Создаёт cookie с immutable absolute expiry и locked browser flags. */
function createSessionCookie(token: Readonly<Uint8Array>, expiresAt: string): string {
  return `${LOCAL_SESSION_COOKIE}=${Buffer.from(token).toString("base64url")}; HttpOnly; SameSite=Strict; Path=/api/v1; Max-Age=${AUTH_COOKIE_CONTRACT.maxAgeSeconds}; Expires=${new Date(expiresAt).toUTCString()}`;
}

/** Создаёт clearing cookie с теми же защитными атрибутами. */
function createClearingCookie(): string {
  return `${LOCAL_SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/api/v1; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

function decodeToken(value: string | null): Uint8Array | null {
  if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === AUTH_TOKEN_BYTES && decoded.toString("base64url") === value ? decoded : null;
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
