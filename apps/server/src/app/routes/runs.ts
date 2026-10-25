import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Database } from "../../platform/database/database.js";
import { ExecutionProjection } from "../read-models/execution-projection.js";
import type { SchedulerService } from "../../modules/scheduler/scheduler-service.js";
import { contextManifestProjectionSchema, type AgentRun } from "@ebb-orchestrator/contracts";
import {
  availabilityFromNullable,
  cancelAllRunsRequestSchema,
  cancelAllRunsResultSchema,
  runEventsQuerySchema,
  type CancelAllRunsResult,
  type RunControlCommandResult,
  type RunControlState,
} from "@ebb-orchestrator/contracts";
import { safeRedact } from "../../platform/security/redact.js";
import type { StartRunOptions } from "../../modules/runtime/run-types.js";
import type { WorkflowEngine } from "../../modules/workflow/workflow-engine.js";
import { WorktreeRepository } from "../../modules/git/worktree-repository.js";
import type { ArtifactStore } from "../../platform/artifacts/artifact-store.js";
import { GitCli } from "../../modules/git/git-cli.js";
import { getContextManifest } from "../../modules/context/context-manifest-repository.js";

const CONTEXT_MANIFEST_ROLES = ["coordinator", "product_manager", "architect", "developer", "reviewer", "qa", "integration"] as const;

export interface RunCommandService {
  cancelRun(id: string): unknown | Promise<unknown>;
  prepareRun?(options: StartRunOptions): AgentRun;
  prepareRunWithHermesPreflight?(options: StartRunOptions): Promise<AgentRun>;
  executePreparedRun?(runId: string): Promise<unknown>;
  failPreparedRun?(runId: string, error: unknown): boolean;
  validateTaskRequestModel?(model: string): void;
  /** Валидация модели и опциональной явной привязки провайдера (plan-24 Task 5). */
  validateTaskRequestSelection?(model: string, selection?: { providerId: string; authMethodId?: string }, role?: string): void;
  /** Run controls (plan-27 Task 3): checkpoint/pause/resume с requestId-идемпотентностью. */
  createCheckpoint?(runId: string, requestId: string): Promise<RunControlCommandResult>;
  pauseRun?(runId: string, requestId: string): Promise<RunControlCommandResult>;
  resumeRunControl?(runId: string, requestId: string): Promise<RunControlCommandResult>;
  cancelAllRuns?(expectedRunIds: string[]): Promise<CancelAllRunsResult>;
}

export interface RunRouteDeps {
  db?: Database | undefined;
  runService?: RunCommandService | undefined;
  scheduler?: SchedulerService | undefined;
  workflow?: WorkflowEngine | undefined;
  worktreeRepository?: WorktreeRepository | undefined;
  artifactStore?: Pick<ArtifactStore, "listRunArtifacts"> | undefined;
  git?: Pick<GitCli, "run"> | undefined;
}

/**
 * Интерфейс события из outbox_events.
 */
interface OutboxEventRow {
  id: string;
  type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload_json: string;
  created_at: string;
  available_at: string;
  processed_at: string | null;
  attempts: number;
}

/**
 * Интерфейс записи из audit_log.
 */
interface AuditLogRow {
  id: string;
  action: string;
  actor: string;
  aggregate_type: string;
  aggregate_id: string;
  details_json: string;
  created_at: string;
}

/**
 * Регистрирует HTTP-маршруты runs и передаёт изменяющие состояние действия backend policy.
 */
export async function runRoutes(app: FastifyInstance, deps: RunRouteDeps = {}): Promise<void> {
  const projection = new ExecutionProjection(deps.db, deps.scheduler);
  app.get("/api/v1/execution", async () => projection.get());
  
  app.post<{ Params: { id: string }; Body: unknown }>("/api/v1/tasks/:id/dispatch", async (request, reply) => {
    if (!deps.scheduler) return reply.code(503).send({ error: "dispatch service unavailable" });
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !/^[\x21-\x7e]{1,256}$/.test(key)) {
      return reply.code(400).send({ error: { code: "RUN_REQUEST_IDEMPOTENCY_KEY_REQUIRED" } });
    }
    const options = parseDispatchBody(request.body);
    if (!options) return reply.code(400).send({ error: { code: "RUN_REQUEST_OPTIONS_INVALID" } });
    const validateNew = deps.runService?.validateTaskRequestSelection
      ? () => deps.runService?.validateTaskRequestSelection?.(options.model,
          options.providerId ? { providerId: options.providerId, ...(options.authMethodId ? { authMethodId: options.authMethodId } : {}) } : undefined, options.role)
      : () => deps.runService?.validateTaskRequestModel?.(options.model);
    try {
      const accepted = deps.scheduler.enqueueRunRequest({ taskId: request.params.id, ...options,
        idempotencyKey: key, originType: "TASK_API", originId: `task-api:${request.params.id}` }, validateNew);
      return reply.code(202).send(dispatchProjection(accepted));
    } catch (error) {
      const code = error instanceof Error ? error.message : "RUN_REQUEST_UNAVAILABLE";
      const providerError = PROVIDER_SELECTION_ERROR_MESSAGES[code];
      if (providerError) return reply.code(400).send({ error: { code, message: providerError } });
      if (code === "RUN_REQUEST_MODEL_UNSUPPORTED") return reply.code(400).send({ error: { code, message: "Неизвестная модель. Доступные модели указаны в настройках." } });
      if (code === "RUN_REQUEST_TASK_NOT_READY") return reply.code(409).send({ error: { code } });
      if (code === "RUN_REQUEST_EPIC_TASK_UNSUPPORTED") return reply.code(409).send({ error: { code } });
      if (code === "RUN_REQUEST_TASK_NOT_FOUND") return reply.code(404).send({ error: { code } });
      if (code === "RUN_REQUEST_IDEMPOTENCY_CONFLICT" || code === "RUN_REQUEST_ALREADY_PENDING") return reply.code(409).send({ error: { code } });
      return reply.code(503).send({ error: { code: "RUN_REQUEST_UNAVAILABLE" } });
    }
  });

  app.get<{ Params: { taskId: string; requestId: string } }>("/api/v1/tasks/:taskId/dispatch-requests/:requestId", async (request, reply) => {
    if (!deps.scheduler) return reply.code(503).send({ error: { code: "RUN_REQUEST_UNAVAILABLE" } });
    const durable = deps.scheduler.getRunRequest(request.params.taskId, request.params.requestId);
    if (!durable) return reply.code(404).send({ error: { code: "RUN_REQUEST_NOT_FOUND" } });
    return dispatchProjection(durable);
  });

  /**
   * Возвращает базовую информацию о запуске (run) с null-vs-zero usage проекцией
   * и orthogonal run_control_state overlay (plan-27 Task 3).
   */
  app.get<{ Params: { id: string } }>("/api/v1/runs/:id", async (request, reply) => {
    if (!deps.db) return reply.code(503).send({ error: "database unavailable" });
    const run = deps.db.get<{
      id: string; role: string; runtime: string; model: string; status: string; task_id: string | null; epic_id: string | null;
      trigger_reason: string | null; started_at: string | null; ended_at: string | null; input_tokens: number | null;
      cached_input_tokens: number | null; output_tokens: number | null; cost: number | null;
      session_id: string | null; attempt: number | null; exit_code: number | null;
    }>(
      `SELECT id, role, runtime, model, status, task_id, epic_id, trigger_reason, started_at, ended_at,
        input_tokens, cached_input_tokens, output_tokens, cost, session_id, attempt, exit_code
       FROM agent_runs WHERE id = $id`,
      { id: request.params.id },
    );
    if (!run) return reply.code(404).send({ error: "run not found" });
    const providerSelection = deps.db.get<{
      provider_id: string; model_id: string; auth_method_id: string; config_revision: number;
    }>(
      `SELECT provider_id, model_id, auth_method_id, config_revision
         FROM run_provider_selections WHERE run_id = $id`,
      { id: run.id },
    );
    const controlRow = deps.db.get<{ state: string; checkpoint_id: string | null; version: number; updated_at: string }>(
      "SELECT state,checkpoint_id,version,updated_at FROM run_control_state WHERE run_id=$id",
      { id: run.id },
    );
    return {
      id: run.id,
      role: run.role,
      runtime: run.runtime,
      model: run.model,
      status: run.status,
      taskId: run.task_id,
      epicId: run.epic_id,
      triggerReason: run.trigger_reason,
      startedAt: run.started_at,
      endedAt: run.ended_at,
      sessionId: run.session_id,
      attempt: run.attempt,
      exitCode: run.exit_code,
      usage: {
        inputTokens: availabilityFromNullable(run.input_tokens),
        cachedInputTokens: availabilityFromNullable(run.cached_input_tokens),
        outputTokens: availabilityFromNullable(run.output_tokens),
        effectiveCost: availabilityFromNullable(run.cost),
      },
      control: controlRow ? runControlProjection(controlRow) : null,
      providerSelection: providerSelection
        ? {
            providerId: providerSelection.provider_id,
            modelId: providerSelection.model_id,
            authMethodId: providerSelection.auth_method_id,
            configRevision: providerSelection.config_revision,
          }
        : null,
    };
  });

  app.get<{ Params: { id: string } }>("/api/v1/runs/:id/artifacts", async (request, reply) => {
    if (!deps.db) return reply.code(503).send({ error: "database unavailable" });
    const run = deps.db.get<{ id: string }>("SELECT id FROM agent_runs WHERE id = $id", { id: request.params.id });
    if (!run) return reply.code(404).send({ error: "run not found" });
    if (!deps.artifactStore) return reply.code(503).send({ error: "artifact metadata unavailable" });
    return deps.artifactStore.listRunArtifacts(run.id);
  });

  app.get<{ Params: { id: string } }>("/api/v1/runs/:id/context-manifests", async (request, reply) => {
    if (!deps.db) return reply.code(503).send({ error: "database unavailable" });
    const run = deps.db.get<{ id: string; task_id: string | null; epic_id: string | null; role: string }>(
      "SELECT id, task_id, epic_id, role FROM agent_runs WHERE id = $id",
      { id: request.params.id },
    );
    if (!run) return reply.code(404).send({ error: "run not found" });
    const subject = readRunManifestSubject(deps.db, run);
    const role = normalizeContextManifestRole(run.role);
    const readResult = getContextManifest(deps.db, run.id);
    if (readResult.availability === "unavailable") {
      return contextManifestProjectionSchema.parse({
        availability: "unavailable", runId: run.id, subject, role, reason: readResult.reason,
      });
    }

    const manifest = readResult.manifest;
    if (!subject || manifest.subject.type !== subject.type || manifest.subject.id !== subject.id || manifest.role !== role) {
      return contextManifestProjectionSchema.parse({
        availability: "unavailable", runId: run.id, subject, role, reason: "INVALID_PERSISTED_PROVENANCE",
      });
    }
    return contextManifestProjectionSchema.parse({
      availability: "available",
      id: manifest.id,
      runId: manifest.runId,
      subject: manifest.subject,
      role: manifest.role,
      contractRequestDigest: manifest.contractRequestDigest,
      items: manifest.items,
      promptHash: manifest.promptHash,
      contextHash: manifest.contextHash,
      contextBuilderVersion: manifest.contextBuilderVersion,
      initialTokenSize: manifest.initialTokenSize,
    });
  });
  
  /**
   * Возвращает события для указанного run: durable, Run-scoped outbox страница
   * с bounded cursor (afterId) и порядком (created_at,id). Не SSE и не терминальный вывод.
   */
  app.get<{ Params: { id: string } }>("/api/v1/runs/:id/events", async (request, reply) => {
    if (!deps.db) return reply.code(503).send({ error: "database unavailable" });
    const query = request.query as { afterId?: string; limit?: string };
    const parsed = runEventsQuerySchema.safeParse({
      afterId: query.afterId,
      limit: query.limit === undefined ? undefined : Number(query.limit),
    });
    if (!parsed.success) return reply.code(400).send({ error: { code: "INVALID_CURSOR" } });
    const { afterId, limit } = parsed.data;
    const run = deps.db.get<{ id: string }>("SELECT id FROM agent_runs WHERE id=$id", { id: request.params.id });
    if (!run) return reply.code(404).send({ error: "run not found" });
    const cursor = afterId === undefined ? undefined : deps.db.get<{ id: string }>(
      "SELECT id FROM outbox_events WHERE id=$afterId AND aggregate_id=$runId AND aggregate_type='AgentRun'",
      { afterId, runId: request.params.id },
    );
    if (afterId !== undefined && !cursor) return reply.code(400).send({ error: { code: "INVALID_CURSOR" } });
    const pageSize = limit ?? 50;
    let cursorParams: Record<string, string> = {};
    if (cursor) {
      const cursorCreatedAt = deps.db.get<{ created_at: string }>("SELECT created_at FROM outbox_events WHERE id=$cursorId", { cursorId: cursor.id })?.created_at;
      cursorParams = { cursorCreatedAt: cursorCreatedAt ?? "", cursorId: cursor.id };
    }
    const rows = deps.db.all<OutboxEventRow>(
      `SELECT id, type, aggregate_type, aggregate_id, payload_json, created_at, available_at, processed_at, attempts
         FROM outbox_events
        WHERE aggregate_id = $id AND aggregate_type = 'AgentRun'
          ${cursor ? `AND (created_at > $cursorCreatedAt OR (created_at = $cursorCreatedAt AND id > $cursorId))` : ""}
        ORDER BY created_at, id
        LIMIT $limit`,
      { id: request.params.id, limit: pageSize + 1, ...cursorParams },
    );
    const paged = rows.slice(0, pageSize);
    const nextCursor = rows.length > pageSize && paged.length > 0 ? paged[paged.length - 1]!.id : null;
    return {
      items: paged.map((row) => ({
        id: row.id,
        type: row.type,
        createdAt: row.created_at,
        payload: redactEventPayload(row.payload_json),
      })),
      nextCursor,
    };
  });

  /**
   * Возвращает sanitized terminal: только persisted-источник, явно назначенный
   * владельцем Run как sanitized. Такого источника нет — typed unavailable.
   */
  app.get<{ Params: { id: string } }>("/api/v1/runs/:id/terminal", async (request, reply) => {
    if (!deps.db) return reply.code(503).send({ error: "database unavailable" });
    const run = deps.db.get<{ id: string }>("SELECT id FROM agent_runs WHERE id=$id", { id: request.params.id });
    if (!run) return reply.code(404).send({ error: "run not found" });
    return { availability: "unavailable", reason: "NO_SANITIZED_PERSISTED_SOURCE" };
  });

  /** Общий обработчик run-control команд (checkpoint/pause/resume). */
  const runControl = (command: "createCheckpoint" | "pauseRun" | "resumeRunControl") =>
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      if (!deps.runService) return reply.code(503).send({ error: { code: "RUN_SERVICE_UNAVAILABLE" } });
      const fn = deps.runService[command];
      if (typeof fn !== "function") return reply.code(503).send({ error: { code: "RUN_CONTROL_UNSUPPORTED_BY_RUNTIME" } });
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string" || !/^[\x21-\x7e]{1,256}$/.test(key)) {
        return reply.code(400).send({ error: { code: "RUN_REQUEST_IDEMPOTENCY_KEY_REQUIRED" } });
      }
      const runId = request.params.id;
      if (command === "resumeRunControl") {
        // Pre-launch scheduler admission (plan-27 Task 3, F1): capacity/project/scope
        // gates run BEFORE the service relaunches the paused run. Rejection aborts
        // resume (run stays PAUSED, failure recorded durably), never swallows it.
        if (deps.scheduler) {
          try {
            deps.scheduler.reacquirePausedRunHold(runId);
          } catch (error) {
            const code = error instanceof Error ? error.message : "WAITING_FOR_CAPACITY";
            recordFailedRunControlCommand(deps.db, runId, key, "RESUME", code);
            return reply.code(409).send({ error: { code } });
          }
        }
      }
      try {
        const result = await fn.call(deps.runService, runId, key);
        if (command === "createCheckpoint" && result.status === "FAILED") {
          return reply.code(503).send({ error: { code: result.failureCode ?? "CHECKPOINT_UNPROVEN" } });
        }
        if (command === "pauseRun" && result.status === "COMPLETED" && result.control?.state === "PAUSED") {
          try { deps.scheduler?.releasePausedRunHold(runId); } catch { /* locks остаются, reservation сохранена; reconcile восстановит */ }
        }
        if (command === "resumeRunControl" && (result.status === "FAILED" || result.control?.state !== "ACTIVE")) {
          try { deps.scheduler?.releasePausedRunHold(runId); } catch { /* reconcile восстановит */ }
        }
        return result;
      } catch (error) {
        if (command === "resumeRunControl") {
          try { deps.scheduler?.releasePausedRunHold(runId); } catch { /* reconcile восстановит */ }
        }
        const code = error instanceof Error ? error.message : "RUN_CONTROL_COMMAND_FAILED";
        if (RUN_CONTROL_CONFLICT_CODES.has(code)) {
          return reply.code(409).send({ error: { code } });
        }
        if (/not found/i.test(code)) return reply.code(404).send({ error: { code: "RUN_NOT_FOUND" } });
        return reply.code(503).send({ error: { code } });
      }
    };

  app.post<{ Params: { id: string } }>("/api/v1/runs/:id/checkpoint", runControl("createCheckpoint"));
  app.post<{ Params: { id: string } }>("/api/v1/runs/:id/pause", runControl("pauseRun"));
  app.post<{ Params: { id: string } }>("/api/v1/runs/:id/resume", runControl("resumeRunControl"));

  /** Подтверждённый cancel-all: только expectedRunIds, упорядоченные per-ID исходы. */
  app.post<{ Body: unknown }>("/api/v1/runs/cancel-all", async (request, reply) => {
    if (!deps.runService || typeof deps.runService.cancelAllRuns !== "function") {
      return reply.code(503).send({ error: { code: "RUN_SERVICE_UNAVAILABLE" } });
    }
    const parsed = cancelAllRunsRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: "CANCEL_ALL_INVALID_REQUEST" } });
    const result = await deps.runService.cancelAllRuns(parsed.data.expectedRunIds);
    return cancelAllRunsResultSchema.parse(result);
  });
  
  /**
   * Возвращает список инструментов (tools) для указанного run.
   */
  app.get<{ Params: { id: string } }>("/api/v1/runs/:id/tools", async (request, reply) => {
    if (!deps.db) return reply.code(503).send({ error: "database unavailable" });
    const row = deps.db.get<{ capability_json: string | null }>(
      "SELECT capability_json FROM agent_runs WHERE id = $id",
      { id: request.params.id },
    );
    if (!row || !row.capability_json) return reply.code(404).send({ error: "run not found" });
    try {
      const capability = JSON.parse(row.capability_json);
      return {
        runId: request.params.id,
        tools: capability.allowedTools ?? [],
      };
    } catch {
      return reply.code(500).send({ error: "invalid capability data" });
    }
  });
  
  /**
   * Возвращает записи аудита (permissions/audit log) для указанного run.
   */
  app.get<{ Params: { id: string } }>("/api/v1/runs/:id/permissions", async (request, reply) => {
    if (!deps.db) return reply.code(503).send({ error: "database unavailable" });
    const rows = deps.db.all<AuditLogRow>(
      "SELECT id, action, actor, aggregate_type, aggregate_id, details_json, created_at FROM audit_log WHERE aggregate_id = $id AND aggregate_type = 'AgentRun' ORDER BY created_at",
      { id: request.params.id },
    );
    return rows.map((row) => ({
      id: row.id,
      action: row.action,
      actor: row.actor,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      details: JSON.parse(row.details_json),
      createdAt: row.created_at,
    }));
  });
  
  /**
   * Возвращает данные восстановления (recovery) для run.
   */
  app.get<{ Params: { id: string } }>("/api/v1/runs/:id/recovery", async (request, reply) => {
    if (!deps.db) return reply.code(503).send({ error: "database unavailable" });
    const runRow = deps.db.get<{ task_id: string | null; status: string }>(
      "SELECT task_id, status FROM agent_runs WHERE id = $id",
      { id: request.params.id },
    );
    if (!runRow) return reply.code(404).send({ error: "run not found" });
    
    const taskId = runRow.task_id;
    if (!taskId) return { runId: request.params.id, taskId: null, recovery: null };
    
    const recoveryAttempts = deps.db.all<{
      id: string; task_id: string; role_level: string; failure_type: string; attempt_count: number; recorded_at: string; fingerprint: string | null;
    }>(
      "SELECT id, task_id, role_level, failure_type, attempt_count, recorded_at, fingerprint FROM recovery_attempts WHERE task_id = $task_id ORDER BY recorded_at",
      { task_id: taskId },
    );
    
    const recoveryRequests = deps.db.all<{
      id: string; task_id: string; role_level: string; failure_type: string; attempt_count: number; created_at: string; resolved_at: string | null;
    }>(
      "SELECT id, task_id, role_level, failure_type, attempt_count, created_at, resolved_at FROM recovery_scheduler_requests WHERE task_id = $task_id ORDER BY created_at",
      { task_id: taskId },
    );
    
    const recoveryState = deps.db.get<{ id: string; task_id: string; status: string; reason: string; created_at: string; updated_at: string }>(
      "SELECT id, task_id, status, reason, created_at, updated_at FROM recovery_state WHERE task_id = $task_id",
      { task_id: taskId },
    );
    
    return {
      runId: request.params.id,
      taskId: taskId,
      runStatus: runRow.status,
      recovery: {
        attempts: recoveryAttempts.map((row) => ({
          id: row.id,
          roleLevel: row.role_level,
          failureType: row.failure_type,
          attemptCount: row.attempt_count,
          timestamp: row.recorded_at,
          fingerprint: row.fingerprint ? JSON.parse(row.fingerprint) : null,
        })),
        schedulerRequests: recoveryRequests.map((row) => ({
          id: row.id,
          roleLevel: row.role_level,
          failureType: row.failure_type,
          attemptCount: row.attempt_count,
          createdAt: row.created_at,
          resolvedAt: row.resolved_at,
        })),
        state: recoveryState ? {
          id: recoveryState.id,
          status: recoveryState.status,
          reason: recoveryState.reason,
          createdAt: recoveryState.created_at,
          updatedAt: recoveryState.updated_at,
        } : null,
      },
    };
  });
  
  app.post<{ Params: { id: string } }>("/api/v1/runs/:id/cancel", async (request, reply) => {
    if (!deps.runService) return reply.code(503).send({ error: "run service unavailable" });
    await deps.runService.cancelRun(request.params.id);
    return { status: "CANCELLED", runId: request.params.id };
  });
}

function readRunManifestSubject(
  db: Database,
  run: { id: string; task_id: string | null; epic_id: string | null },
): { type: "TASK" | "EPIC" | "REQUEST"; id: string } | null {
  if (run.task_id !== null) {
    const task = db.get<{ id: string }>("SELECT id FROM tasks WHERE id = $id", { id: run.task_id });
    return task ? { type: "TASK", id: task.id } : null;
  }
  if (run.epic_id !== null) {
    const epic = db.get<{ id: string }>("SELECT id FROM epics WHERE id = $id", { id: run.epic_id });
    return epic ? { type: "EPIC", id: epic.id } : null;
  }
  const requests = db.all<{ id: string }>(
    `SELECT p.id FROM planning_requests p
      WHERE p.coordinator_run_id = $runId OR EXISTS (
        SELECT 1 FROM planning_request_role_runs pr WHERE pr.request_id = p.id AND pr.run_id = $runId
      )
      ORDER BY p.id LIMIT 2`,
    { runId: run.id },
  );
  return requests.length === 1 ? { type: "REQUEST", id: requests[0]!.id } : null;
}

function normalizeContextManifestRole(value: string): (typeof CONTEXT_MANIFEST_ROLES)[number] | "unknown" {
  return CONTEXT_MANIFEST_ROLES.find((role) => role === value) ?? "unknown";
}

/** Коды конфликтов run-control/адмиссии, проецируемые в HTTP 409. */
const RUN_CONTROL_CONFLICT_CODES = new Set([
  "RUN_CONTROL_STATE_CONFLICT",
  "RUN_CONTROL_COMMAND_CONFLICT",
  "RUN_CONTROL_TERMINAL",
  "RUN_CONTROL_ALREADY_PAUSED",
  "RUN_CONTROL_NOT_PAUSED",
  "WAITING_FOR_CAPACITY",
  "WAITING_FOR_ROLE_CAPACITY",
  "WAITING_FOR_PAUSE",
  "WAITING_FOR_RESOURCE_LOCK",
  "WAITING_FOR_BUDGET",
  "BLOCKED_BY_PROJECT_STATE",
  "PROJECT_NOT_ACTIVE",
  "ONBOARDING_NOT_ACTIVE",
  "PROJECT_CONFIG_DEGRADED",
  "DISPATCH_PAUSED_GLOBAL",
  "DISPATCH_PAUSED_PROJECT",
  "DISPATCH_PAUSED_EPIC",
]);

/**
 * Записывает durable FAILED run-control команду при отклонении resume-адмиссии
 * до запуска runtime (best-effort; idempotent по request_id).
 */
function recordFailedRunControlCommand(
  db: Database | undefined,
  runId: string,
  requestId: string,
  command: "PAUSE" | "RESUME" | "CHECKPOINT",
  failureCode: string,
): void {
  if (!db) return;
  try {
    if (db.get("SELECT request_id FROM run_control_commands WHERE request_id=$requestId", { requestId })) return;
    const control = db.get<{ attempt: number; version: number }>("SELECT attempt,version FROM run_control_state WHERE run_id=$runId", { runId });
    const attempt = control?.attempt ?? db.get<{ attempt: number | null }>("SELECT attempt FROM agent_runs WHERE id=$runId", { runId })?.attempt ?? 1;
    const now = new Date().toISOString();
    db.run(
      "INSERT INTO run_control_commands(request_id,run_id,attempt,command,expected_version,status,result_json,created_at,updated_at) VALUES($requestId,$runId,$attempt,$command,$expectedVersion,'FAILED',$result,$now,$now)",
      { requestId, runId, attempt: attempt ?? 1, command, expectedVersion: control?.version ?? 0, result: JSON.stringify({ failureCode }), now },
    );
  } catch { /* best-effort audit row; no throw from the route */ }
}

/** Маппинг run_control_state строки в typed discriminated projection. */
function runControlProjection(row: { state: string; checkpoint_id: string | null; version: number; updated_at: string }): RunControlState {
  const base = { version: row.version, updatedAt: row.updated_at };
  switch (row.state) {
    case "ACTIVE": return { ...base, state: "ACTIVE", checkpointId: null };
    case "PAUSE_REQUESTED": return { ...base, state: "PAUSE_REQUESTED", checkpointId: null };
    case "PAUSED": return { ...base, state: "PAUSED", checkpointId: row.checkpoint_id as string };
    case "RESUME_PENDING": return { ...base, state: "RESUME_PENDING", checkpointId: row.checkpoint_id as string };
    default: return { ...base, state: "CLOSED", checkpointId: row.checkpoint_id };
  }
}

/** Редэктирует secret-shaped строки в payload события перед отдачей (никогда raw secret). */
function redactEventPayload(payloadJson: string): unknown {
  try {
    return JSON.parse(safeRedact(payloadJson)) as unknown;
  } catch {
    return {};
  }
}

/** Русские user-facing сообщения ошибок выбора провайдера (plan-24 Task 5). */
const PROVIDER_SELECTION_ERROR_MESSAGES: Record<string, string> = {
  RUN_REQUEST_PROVIDER_UNKNOWN: "Неизвестный провайдер.",
  RUN_REQUEST_PROVIDER_NOT_CONFIGURED: "Провайдер не настроен.",
  RUN_REQUEST_PROVIDER_DISABLED: "Провайдер отключен.",
  RUN_REQUEST_AUTH_METHOD_UNKNOWN: "Неизвестный способ аутентификации.",
  RUN_REQUEST_AUTH_METHOD_SNAPSHOT_MISMATCH: "Способ аутентификации не совпадает с ревизией конфигурации провайдера.",
  RUN_REQUEST_PROVIDER_CAPABILITY_UNSUPPORTED: "Модель не поддерживает требуемые возможности для выбранной роли.",
  RUN_REQUEST_PROVIDER_CREDENTIAL_MISSING: "Для провайдера не настроены учётные данные.",
};

function parseDispatchBody(value: unknown): {
  role: "developer" | "reviewer" | "qa" | "integration";
  model: string;
  providerId?: string;
  authMethodId?: string;
} | null {
  if (value === undefined) return { role: "developer", model: "default" };
  if (!isPlainObject(value) || Object.keys(value).some((key) => key !== "role" && key !== "model" && key !== "providerId" && key !== "authMethodId")) return null;
  const role = value.role === undefined ? "developer" : value.role;
  const model = value.model === undefined ? "default" : value.model;
  if (!isNonEmptyString(role) || !["developer", "reviewer", "qa", "integration"].includes(role.toLowerCase()) || !isNonEmptyString(model)) return null;
  const providerId = value.providerId === undefined ? undefined : value.providerId;
  const authMethodId = value.authMethodId === undefined ? undefined : value.authMethodId;
  if (providerId !== undefined && !isNonEmptyString(providerId)) return null;
  if (authMethodId !== undefined && !isNonEmptyString(authMethodId)) return null;
  if (authMethodId !== undefined && providerId === undefined) return null;
  return {
    role: role.toLowerCase() as "developer" | "reviewer" | "qa" | "integration",
    model,
    ...(providerId !== undefined ? { providerId } : {}),
    ...(authMethodId !== undefined ? { authMethodId } : {}),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function dispatchProjection(request: import("../../modules/scheduler/scheduler-run-request-repository.js").SchedulerRunRequest) {
  return { requestId: request.id, taskId: request.taskId, status: request.status, runId: request.runId,
    role: request.role, model: request.model, failureCode: request.failureCode,
    ...(request.providerId ? { providerId: request.providerId, authMethodId: request.authMethodId } : {}) };
}
