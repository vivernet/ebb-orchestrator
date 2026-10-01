import type { FastifyInstance } from "fastify";
import type { Database } from "../../platform/database/database.js";
import { ExecutionProjection } from "../read-models/execution-projection.js";
import type { SchedulerService } from "../../modules/scheduler/scheduler-service.js";
import { contextManifestProjectionSchema, type AgentRun } from "@ebb-orchestrator/contracts";
import type { StartRunOptions } from "../../modules/runtime/run-types.js";
import type { WorkflowEngine } from "../../modules/workflow/workflow-engine.js";
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { WorktreeRepository } from "../../modules/git/worktree-repository.js";
import type { ArtifactStore } from "../../platform/artifacts/artifact-store.js";
import { assertSafeGitRef, GitCli } from "../../modules/git/git-cli.js";
import { createRunContextInput, taskDeveloperPrompt, taskQaPrompt, taskReviewerPrompt } from "../../modules/runtime/run-service.js";
import { getContextManifest } from "../../modules/context/context-manifest-repository.js";

const CONTEXT_MANIFEST_ROLES = ["coordinator", "product_manager", "architect", "developer", "reviewer", "qa", "integration"] as const;

export interface RunCommandService {
  cancelRun(id: string): unknown | Promise<unknown>;
  prepareRun?(options: StartRunOptions): AgentRun;
  executePreparedRun?(runId: string): Promise<unknown>;
  failPreparedRun?(runId: string, error: unknown): boolean;
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

    const options = parseDispatchBody(request.body);
    if (!options) return reply.code(400).send({ error: "invalid dispatch options" });

    try {
      const project = deps.db.get<{ project_id: string }>("SELECT project_id FROM tasks WHERE id=$id", { id: task.id });
      if (!project) return reply.code(404).send({ error: "task not found" });
      deps.scheduler.assertProjectDispatchable(project.project_id);
    } catch (error) {
      const code = error instanceof Error ? error.message : "PROJECT_NOT_ACTIVE";
      if (code === "ONBOARDING_NOT_ACTIVE" || code === "PROJECT_NOT_ACTIVE" || code === "PROJECT_CONFIG_DEGRADED") return reply.code(409).send({ contractVersion: 1, error: { code, message: code === "ONBOARDING_NOT_ACTIVE" ? "Онбординг проекта не активирован" : code === "PROJECT_CONFIG_DEGRADED" ? "Конфигурация проекта требует восстановления" : "Проект не активен" } });
      return reply.code(409).send({ error: "dispatch rejected" });
    }

    // Выполняет соответствующую проверку или действие согласно контракту.
    const worktree = (deps.worktreeRepository ?? new WorktreeRepository(deps.db)).findTaskWorkspace(task.id);
    if (!worktree || !isAbsolute(worktree.path) || !existsSync(worktree.path) || !statIsDirectory(worktree.path)) {
      return reply.code(409).send({ error: "managed task workspace is required" });
    }

    let targetHead: string;
    let actualBranch: string;
    try {
      const git = deps.git ?? new GitCli();
      targetHead = (await git.run(worktree.path, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"])).stdout.trim();
      actualBranch = (await git.run(worktree.path, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim();
      if (!/^[a-f0-9]{40}$/i.test(targetHead) || actualBranch !== worktree.branch) throw new Error("TASK_WORKTREE_SNAPSHOT_UNAVAILABLE");
    } catch {
      return reply.code(409).send({ error: "managed task workspace snapshot is unavailable" });
    }

    let roleInputs: unknown;
    let prompt: string;
    try {
      if (options.role === "developer") {
        prompt = taskDeveloperPrompt();
      } else if (options.role === "reviewer") {
        const operation = deps.db.get<{ target_ref: string | null }>(
          `SELECT target_ref FROM git_operations WHERE type='CREATE_WORKTREE' AND status='VERIFIED'
             AND repo_path=$repoPath AND branch_name=$branch AND worktree_id=$taskId ORDER BY verified_at DESC LIMIT 1`,
          { repoPath: worktree.repoPath, branch: worktree.branch, taskId: task.id },
        );
        if (!operation?.target_ref) throw new Error("TASK_REVIEW_BASE_UNAVAILABLE");
        assertSafeGitRef(operation.target_ref);
        const gitDiff = (await (deps.git ?? new GitCli()).run(worktree.path, [
          "diff", "--no-ext-diff", "--no-textconv", `${operation.target_ref}...HEAD`, "--",
        ])).stdout;
        roleInputs = { gitDiff, checks: [] };
        prompt = taskReviewerPrompt();
      } else if (options.role === "qa") {
        roleInputs = { environment: `Managed task worktree branch ${actualBranch} at target SHA ${targetHead} on ${process.platform}.` };
        prompt = taskQaPrompt();
      } else {
        throw new Error("TASK_INTEGRATION_REQUIRES_PREPARED_ATTEMPT");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "TASK_ROLE_INPUT_UNAVAILABLE";
      return reply.code(409).send({ error: message });
    }

    let run: AgentRun | undefined;
    try {
      const runOptions: StartRunOptions = {
        role: options.role,
        model: options.model,
        taskId: task.id,
        epicId: task.epic_id,
        triggerReason: "runtime-request",
        contextVersion: "runtime-request-v1",
        outputSchemaVersion: "1",
        capability: { workspace: worktree.path },
      };
      run = runService.prepareRun({
        ...runOptions,
        contextInput: createRunContextInput(runOptions, {
          prompt,
          ...(roleInputs !== undefined ? { roleInputs } : {}),
          workspaceIdentity: { repository: worktree.repoPath, workspace: worktree.path, worktree: worktree.id },
          targetHead,
          targetBranch: actualBranch,
        }),
      });
      deps.scheduler.dispatchTask(task.id, deps.workflow, () => undefined, {
        triggerReason: "runtime-request",
        role: options.role,
        model: options.model,
        runId: run.id,
      });
    } catch (error) {
      if (run && runService.failPreparedRun?.(run.id, error) === true) {
        try { deps.scheduler.releaseTask(task.id, 0); } catch { /* recovery reconciler owns retry */ }
      }
      return reply.code(classifyDispatchError(error)).send({ error: "dispatch rejected" });
    }

    // Выполняет соответствующую проверку или действие согласно контракту.
    void runService.executePreparedRun(run.id).catch((error: unknown) => {
      if (runService.failPreparedRun?.(run.id, error) === true) {
        try { deps.scheduler!.releaseTask(task.id, 0); } catch { /* recovery reconciler owns retry */ }
      }
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

  app.get<{ Params: { id: string } }>("/api/v1/runs/:id/artifacts", async (request, reply) => {
    if (!deps.db) return reply.code(503).send({ error: "database unavailable" });
    const run = deps.db.get<{ id: string }>("SELECT id FROM agent_runs WHERE id = $id", { id: request.params.id });
    if (!run) return reply.code(404).send({ error: "run not found" });
    if (!deps.artifactStore) return reply.code(503).send({ error: "artifact metadata unavailable" });
    return deps.artifactStore.listRunArtifacts(run.id);
  });

  app.get<{ Params: { id: string } }>("/api/v1/runs/:id/context-manifests", async (request, reply) => {
    if (!deps.db) return reply.code(503).send({ error: "database unavailable" });
    const run = deps.db.get<{ id: string; task_id: string | null; epic_id: string | null; role: string; capability_json: string | null }>(
      "SELECT id, task_id, epic_id, role, capability_json FROM agent_runs WHERE id = $id",
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

function readRunManifestSubject(
  db: Database,
  run: { id: string; task_id: string | null; epic_id: string | null; capability_json: string | null },
): { type: "TASK" | "EPIC" | "REQUEST"; id: string } | null {
  if (run.task_id !== null) {
    const task = db.get<{ id: string }>("SELECT id FROM tasks WHERE id = $id", { id: run.task_id });
    return task ? { type: "TASK", id: task.id } : null;
  }
  if (run.epic_id !== null) {
    const epic = db.get<{ id: string }>("SELECT id FROM epics WHERE id = $id", { id: run.epic_id });
    return epic ? { type: "EPIC", id: epic.id } : null;
  }
  if (!run.capability_json) return null;
  try {
    const capability: unknown = JSON.parse(run.capability_json);
    if (!isPlainObject(capability) || !isNonEmptyString(capability.requestId)) return null;
    const request = db.get<{ id: string }>(
      `SELECT p.id FROM planning_requests p
        WHERE p.id = $requestId AND (
          p.coordinator_run_id = $runId OR EXISTS (
            SELECT 1 FROM planning_request_role_runs pr WHERE pr.request_id = p.id AND pr.run_id = $runId
          )
        )`,
      { requestId: capability.requestId, runId: run.id },
    );
    return request ? { type: "REQUEST", id: request.id } : null;
  } catch {
    return null;
  }
}

function normalizeContextManifestRole(value: string): (typeof CONTEXT_MANIFEST_ROLES)[number] | "unknown" {
  return CONTEXT_MANIFEST_ROLES.find((role) => role === value) ?? "unknown";
}

function statIsDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function parseDispatchBody(value: unknown): { role: "developer" | "reviewer" | "qa" | "integration"; model: string } | null {
  if (value === undefined) return { role: "developer", model: "default" };
  if (!isPlainObject(value) || Object.keys(value).some((key) => key !== "role" && key !== "model")) return null;
  const role = value.role === undefined ? "developer" : value.role;
  const model = value.model === undefined ? "default" : value.model;
  if (!isNonEmptyString(role) || !["developer", "reviewer", "qa", "integration"].includes(role.toLowerCase()) || !isNonEmptyString(model)) return null;
  return { role: role.toLowerCase() as "developer" | "reviewer" | "qa" | "integration", model };
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
