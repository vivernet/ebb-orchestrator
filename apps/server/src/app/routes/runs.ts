import type { FastifyInstance } from "fastify";
import type { Database } from "../../platform/database/database.js";
import { ExecutionProjection } from "../read-models/execution-projection.js";
import type { SchedulerService } from "../../modules/scheduler/scheduler-service.js";
import type { AgentRun } from "@ebb-orchestrator/contracts";
import type { StartRunOptions } from "../../modules/runtime/run-types.js";
import type { WorkflowEngine } from "../../modules/workflow/workflow-engine.js";
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { WorktreeRepository } from "../../modules/git/worktree-repository.js";

export interface RunCommandService {
  cancelRun(id: string): unknown | Promise<unknown>;
  prepareRun?(options: StartRunOptions): AgentRun;
  executePreparedRun?(runId: string): Promise<unknown>;
  failPreparedRun?(runId: string, error: unknown): void;
}

export interface RunRouteDeps {
  db?: Database | undefined;
  runService?: RunCommandService | undefined;
  scheduler?: SchedulerService | undefined;
  workflow?: WorkflowEngine | undefined;
  worktreeRepository?: WorktreeRepository | undefined;
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
    const runService = deps.runService;
    if (!deps.db || !runService || !runService.prepareRun || !runService.executePreparedRun || !deps.scheduler || !deps.workflow) {
      return reply.code(503).send({ error: "dispatch service unavailable" });
    }

    const task = deps.db.get<{ id: string; status: string; epic_id: string | null }>(
      "SELECT id, status, epic_id FROM tasks WHERE id = $id",
      { id: request.params.id },
    );
    if (!task) return reply.code(404).send({ error: "task not found" });
    if (task.status !== "READY") {
      return reply.code(409).send({ error: "task is not READY", status: task.status });
    }

    // Выполняет соответствующую проверку или действие согласно контракту.
    const worktree = (deps.worktreeRepository ?? new WorktreeRepository(deps.db)).findTaskWorkspace(task.id);
    if (!worktree || !isAbsolute(worktree.path) || !existsSync(worktree.path) || !statIsDirectory(worktree.path)) {
      return reply.code(409).send({ error: "managed task workspace is required" });
    }

    const options = parseDispatchBody(request.body);
    if (!options) return reply.code(400).send({ error: "invalid dispatch options" });

    let run: AgentRun | undefined;
    try {
      run = runService.prepareRun({
        role: options.role,
        model: options.model,
        taskId: task.id,
        epicId: task.epic_id,
        triggerReason: "runtime-request",
        contextVersion: "runtime-request-v1",
        outputSchemaVersion: "1",
        capability: { workspace: worktree.path },
      });
      deps.scheduler.dispatchTask(task.id, deps.workflow, () => undefined, {
        triggerReason: "runtime-request",
        role: options.role,
        model: options.model,
        runId: run.id,
      });
    } catch (error) {
      if (run) runService.failPreparedRun?.(run.id, error);
      return reply.code(classifyDispatchError(error)).send({ error: "dispatch rejected" });
    }

    // Выполняет соответствующую проверку или действие согласно контракту.
    void runService.executePreparedRun(run.id).catch((error: unknown) => {
      runService.failPreparedRun?.(run.id, error);
      try { deps.scheduler!.releaseTask(task.id, 0); } catch { /* recovery reconciler owns retry */ }
    });
    return reply.code(202).send({ runId: run.id, taskId: task.id, status: run.status });
  });
  
  /**
   * Возвращает базовую информацию о запуске (run).
   */
  app.get<{ Params: { id: string } }>("/api/v1/runs/:id", async (request, reply) => {
    if (!deps.db) return reply.code(503).send({ error: "database unavailable" });
    const run = deps.db.get<{
      id: string; role: string; runtime: string; model: string; status: string; task_id: string | null; epic_id: string | null;
      trigger_reason: string | null; started_at: string | null; ended_at: string | null; input_tokens: number | null;
      cached_input_tokens: number | null; output_tokens: number | null; cost: number | null;
      capability_json: string | null;
    }>(
      `SELECT id, role, runtime, model, status, task_id, epic_id, trigger_reason, started_at, ended_at,
        input_tokens, cached_input_tokens, output_tokens, cost, capability_json
       FROM agent_runs WHERE id = $id`,
      { id: request.params.id },
    );
    if (!run) return reply.code(404).send({ error: "run not found" });
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
      usage: {
        inputTokens: run.input_tokens ?? 0,
        cachedTokens: run.cached_input_tokens ?? 0,
        outputTokens: run.output_tokens ?? 0,
        cost: run.cost ?? 0,
      },
    };
  });
  
  /**
   * Возвращает события для указанного run.
   */
  app.get<{ Params: { id: string } }>("/api/v1/runs/:id/events", async (request, reply) => {
    if (!deps.db) return reply.code(503).send({ error: "database unavailable" });
    const rows = deps.db.all<OutboxEventRow>(
      "SELECT id, type, aggregate_type, aggregate_id, payload_json, created_at, available_at, processed_at, attempts FROM outbox_events WHERE aggregate_id = $id AND aggregate_type = 'AgentRun' ORDER BY created_at",
      { id: request.params.id },
    );
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      payload: JSON.parse(row.payload_json),
      createdAt: row.created_at,
      availableAt: row.available_at,
      processedAt: row.processed_at,
      attempts: row.attempts,
    }));
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

function statIsDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function parseDispatchBody(value: unknown): { role: string; model: string } | null {
  if (value === undefined) return { role: "developer", model: "default" };
  if (!isPlainObject(value) || Object.keys(value).some((key) => key !== "role" && key !== "model")) return null;
  const role = value.role === undefined ? "developer" : value.role;
  const model = value.model === undefined ? "default" : value.model;
  if (!isNonEmptyString(role) || !isNonEmptyString(model)) return null;
  return { role, model };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function classifyDispatchError(error: unknown): 404 | 409 | 503 {
  const message = error instanceof Error ? error.message : "";
  return /not found/i.test(message) ? 404 : /runtime|unavailable|launcher/i.test(message) ? 503 : 409;
}
