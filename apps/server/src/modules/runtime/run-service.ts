/**
 * Выполняет service for managing agent run lifecycle.
 */

import type { Database, DatabaseTx } from "../../platform/database/database.js";
import type { AgentRuntime } from "./agent-runtime.js";
import type { AgentRun, RunStatus, RunTrigger } from "@ebb-orchestrator/contracts";
import type { StartRunOptions, ResumeRunOptions, RunOutcome } from "./run-types.js";
import { validateRoleOutput } from "./output-validator.js";
import { DatabaseCompletionStore, type CompletionStore } from "../execution/mcp/submit-result-tool.js";
import { SUPPORTED_TOOL_IDS, type RoleName, type ToolId } from "../execution/run-capability.js";
import { schema, migrationColumns } from './migrations/schema.js';
import { RoleRegistry } from './role-registry.js';
import { appendOutboxEvent } from "../../platform/events/outbox-repository.js";
import { DomainEvent } from "../../platform/events/domain-event.js";

/**
 * Связывает runtime-контракт run-service с жизненным циклом agent run и структурированным результатом.
 */
export class RunService {
  private readonly roles = new RoleRegistry();

  constructor(
    private readonly db: Database,
    private readonly runtime: AgentRuntime
  ) {
    this.db.exec(schema);
    // сохранять databases created перед capability_json usable пока Объект migration
    // set является upgraded by Объект хост процесс.
    const columns = this.db.all<{ name: string }>("PRAGMA table_info(agent_runs)");
    for (const column of migrationColumns) {
      const name = column.split(" ", 1)[0];
      if (!columns.some((existing) => existing.name === name)) this.db.exec(`ALTER TABLE agent_runs ADD COLUMN ${column}`);
    }
  }

  /** Adapter используемый by MCP. Этот обновляет predicate makes acceptance atomic и one-shot. */
  completionStore(): CompletionStore {
    return new DatabaseCompletionStore(this.db);
  }

  /**
   * Помечает незавершённые runs как прерванные рестартом процесса.
   *
   * После захвата single-instance lock старый runtime уже не может продолжать
   * выполнение в этом процессе, поэтому оставлять capability активной опасно:
   * это создаёт ложное состояние и блокирует recovery scheduler.
   */
  reconcileInterruptedRuns(): number {
    const now = new Date().toISOString();
    this.db.run(
      `UPDATE agent_runs
          SET status='FAILED', ended_at=$ended_at, exit_code=-1,
              output=$output, capability_ref=NULL, capability_json=NULL
        WHERE status IN ('STARTED','IN_PROGRESS','COMPLETING')`,
      { ended_at: now, output: "Run interrupted by orchestrator restart" },
    );
    return this.db.get<{ changes: number }>("SELECT changes() AS changes")?.changes ?? 0;
  }

  getCapabilityReference(runId: string): string {
    const row = this.db.get<{ capability_ref: string | null }>(
      "SELECT capability_ref FROM agent_runs WHERE id = $id", { id: runId });
    if (!row?.capability_ref) throw new Error(`Run ${runId} has no active capability`);
    return row.capability_ref;
  }

  /**
   * Persist Объект новый agent run without invoking Объект runtime.
   *
   * Callers который должен reserve scheduler capacity перед запуск использовать этот as
   * Объект durable identity boundary, followed by executePreparedRun().
   */
  prepareRun(options: StartRunOptions): AgentRun {
    return this.db.transaction((tx) => {
      const id = options.runId ?? crypto.randomUUID();
      const capabilityRef = crypto.randomUUID();
      const role = options.role.toLowerCase();
      const contract = this.roles.get(role);
      // Legacy/internal runtime fixtures may использовать Объект роль without Объект публичный contract.
      // Such runs получать Объект smallest безопасный capability rather thОбъект caller инструменты.
      const requested = options.capability?.allowedTools;
      const supportedTools = new Set<string>(SUPPORTED_TOOL_IDS);
      const isSupportedToolId = (tool: string): tool is ToolId => supportedTools.has(tool);
      const roleTools: ToolId[] = Array.from(
        contract?.allowedTools ?? ['submit_result'],
        (tool) => String(tool),
      ).filter(isSupportedToolId);
      const allowedTools: ToolId[] = requested
        ? requested.filter((tool) => roleTools.includes(tool))
        : roleTools;
      if (requested && allowedTools.length === 0) throw new Error(`requested tools are not allowed for role: ${options.role}`);
      const capability = { id: capabilityRef, capabilityRef, runId: id,
        role: role as RoleName, workspace: options.capability?.workspace ?? "",
        allowedTools, ...(options.capability?.projectConfig ? { projectConfig: options.capability.projectConfig } : {}) };
      const now = new Date().toISOString();
      const record: AgentRun = {
        id,
        role: options.role,
        runtime: "default",
        model: options.model,
        taskId: options.taskId,
        epicId: options.epicId,
        status: "STARTED" as RunStatus,
        sessionId: null,
        attempt: null,
        triggerReason: options.triggerReason as RunTrigger,
        contextVersion: options.contextVersion,
        outputSchemaVersion: options.outputSchemaVersion,
        startedAt: new Date(now),
        endedAt: null,
        exitCode: null,
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        cost: null,
        capabilityRef,
        ...(options.prompt ? { prompt: options.prompt } : {}),
      };

      tx.run(
        `INSERT INTO agent_runs (
          id, role, runtime, model, task_id, epic_id, status,
           session_id, attempt, trigger_reason, context_version, prompt,
           output_schema_version, started_at, ended_at, exit_code,
            input_tokens, cached_input_tokens, output_tokens, cost, capability_ref, capability_json
        ) VALUES ($id, $role, $runtime, $model, $task_id, $epic_id, $status,
           $session_id, $attempt, $trigger_reason, $context_version, $prompt,
           $output_schema_version, $started_at, $ended_at, $exit_code,
           $input_tokens, $cached_input_tokens, $output_tokens, $cost, $capability_ref, $capability_json)`,
        {
          id: record.id,
          role: record.role,
          runtime: record.runtime,
          model: record.model,
          task_id: record.taskId,
          epic_id: record.epicId,
          status: record.status,
          session_id: record.sessionId,
          attempt: record.attempt,
           trigger_reason: record.triggerReason,
           context_version: record.contextVersion,
           prompt: options.prompt ?? null,
          output_schema_version: record.outputSchemaVersion,
          started_at: record.startedAt?.toISOString() ?? null,
          ended_at: record.endedAt?.toISOString() ?? null,
          exit_code: record.exitCode,
          input_tokens: record.inputTokens,
          cached_input_tokens: record.cachedInputTokens,
          output_tokens: record.outputTokens,
          cost: record.cost,
          capability_ref: capabilityRef,
          capability_json: JSON.stringify(capability),
        }
      );

      return record;
    });
  }

  /** запускать Объект новый run и make it runtime-ready. */
  async startRun(options: StartRunOptions): Promise<AgentRun> {
    const record = this.prepareRun(options);
    // startRun является Объект runtime readiness barrier: adapters resolve только после
    // their profile/config и запуск have been prepared. Never expose Объект run
    // to callers пока который asynchronous работа является still in flight.
    try {
      await this.runtime.startRun(record);
    } catch (error) {
      this.failRun(record.id, error);
      throw error;
    }
    return record;
  }

  /**
   * Execute Объект уже сохранённый run. Этот never создаёт another AgentRun.
   */
  async executePreparedRun(runId: string): Promise<{ run: AgentRun; outcome: RunOutcome }> {
    const run = this.getRun(this.db, runId);
    if (run.status !== "STARTED") {
      throw new Error(`Run ${runId} is not prepared for execution: ${run.status}`);
    }
    try {
      await this.runtime.startRun(run);
      const outcome = await this.runtime.collectResult(run.id);
      await this.collectResult(run.id, outcome);
      try {
        await this.collectUsage(run.id, await this.runtime.collectUsage(run.id));
      } catch {
        // использование является optional для runtimes который не expose it.
      }
      return { run: this.getRun(this.db, run.id), outcome };
    } catch (error) {
      this.failRun(run.id, error);
      throw error;
    }
  }

  /** запускать, collect, и durably accept один runtime результат. */
  async execute(options: StartRunOptions): Promise<{ run: AgentRun; outcome: RunOutcome }> {
    const run = this.prepareRun(options);
    return this.executePreparedRun(run.id);
  }

  /** Mark Объект prepared run не выполнен когда dispatch itself cannot be completed. */
  failPreparedRun(runId: string, error: unknown): void {
    this.failRun(runId, error);
  }

  /**
   * Возобновление a run with session info.
   * Terminal runs (COMPLETED, FAILED, CANCELLED) cannot be reopened.
   * Validates status, capability, attempt before writing IN_PROGRESS.
   */
  async resumeRun(runId: string, options: ResumeRunOptions): Promise<AgentRun> {
    // Get current run state for validation
    const currentRun = this.getRun(this.db, runId);

    // Validate status: terminal states are immutable and cannot be reopened
    if (this.isTerminalState(currentRun.status)) {
      throw new Error(
        `Run ${runId} is in terminal state '${currentRun.status}' and cannot be reopened. ` +
        `Only runs in STARTED or IN_PROGRESS states can be resumed.`
      );
    }

    // Validate capability: run must have an active capability
    if (!currentRun.capabilityRef) {
      throw new Error(`Run ${runId} has no active capability and cannot be resumed.`);
    }

    // Validate attempt: must be a positive integer
    if (options.attempt <= 0) {
      throw new Error(`Attempt must be a positive integer, got: ${options.attempt}`);
    }

    // Transition to IN_PROGRESS atomically
    this.db.transaction((tx) => {
      tx.run(
        `UPDATE agent_runs SET session_id = $session_id, attempt = $attempt,
          status = 'IN_PROGRESS' WHERE id = $id`,
        {
          id: runId,
          session_id: options.sessionId,
          attempt: options.attempt,
        }
      );
    });

    // Resume with runtime
    try {
      await this.runtime.resumeRun(runId, options);
    } catch (error) {
      this.failRun(runId, error);
      throw error;
    }

    return this.getRun(this.db, runId);
  }

  /** Check if a status is terminal (immutable). */
  private isTerminalState(status: RunStatus): boolean {
    return status === "COMPLETED" || status === "FAILED" || status === "CANCELLED";
  }

  private failRun(runId: string, error: unknown): void {
    const diagnostics = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    this.db.transaction((tx) => {
      tx.run(`UPDATE agent_runs SET status = 'FAILED', ended_at = $ended_at,
        exit_code = $exit_code, output = $output, capability_ref = NULL, capability_json = NULL
        WHERE id = $id`, { id: runId, ended_at: new Date().toISOString(), exit_code: -1, output: diagnostics });
    });
  }

  /**
   * Отмена a run atomically with state, outbox event, and audit log.
   */
  async cancelRun(runId: string): Promise<void> {
    return this.db.transaction((tx) => {
      const stored = tx.get<{ id: string; status: string; task_id: string | null }>(
        "SELECT id, status, task_id FROM agent_runs WHERE id = $id", { id: runId },
      );
      if (!stored) throw new Error(`Run ${runId} not found`);
      if (stored.status === "CANCELLED" || stored.status === "FAILED" || stored.status === "COMPLETED") {
        return; // Idempotent: already terminal.
      }
      const now = new Date().toISOString();
      tx.run(
        `UPDATE agent_runs SET status = 'CANCELLED', ended_at = $ended_at WHERE id = $id AND status IN ('STARTED','IN_PROGRESS','COMPLETING')`,
        { id: runId, ended_at: now },
      );
      // Добавляет durable outbox event.
      const event = DomainEvent.create({
        type: "RunCancelled",
        aggregateType: "AgentRun",
        aggregateId: runId,
        payload: { runId, previousStatus: stored.status, taskId: stored.task_id, cancelledAt: now },
      });
      appendOutboxEvent(tx, event);
      // Добавляет audit log entry.
      tx.run(
        `INSERT INTO audit_log(id,action,actor,aggregate_type,aggregate_id,details_json,created_at) VALUES($id,$action,$actor,$aggregate_type,$aggregate_id,$details,$created_at)`,
        { id: crypto.randomUUID(), action: "RUN_CANCELLED", actor: "local-user", aggregate_type: "AgentRun", aggregate_id: runId, details: JSON.stringify({ runId, status: "CANCELLED", previousStatus: stored.status }), created_at: now },
      );
    });
  }

  /**
   * Collect результат и обновляет run статус.
   */
  async collectResult(runId: string, outcome: RunOutcome): Promise<AgentRun> {
    return this.db.transaction((tx) => {
      const stored = tx.get<{ id: string; role: string; status: string }>(
        "SELECT id, role, status FROM agent_runs WHERE id = $id", { id: runId });
      if (!stored) throw new Error(`Run ${runId} not found`);
      if (stored.status !== "COMPLETING") {
        throw new Error(`Run ${runId} requires persisted COMPLETING status from authenticated submit_result`);
      }
      const submission = this.completionStore().getSubmission?.(runId);
      if (!submission || submission.role.toLowerCase() !== stored.role.toLowerCase()) {
        throw new Error(`Run ${runId} has no authenticated completion submission`);
      }
      if (outcome.validatedSubmission !== true || outcome.diagnostics?.runId !== runId || outcome.output !== submission.output) {
        throw new Error(`Run ${runId} requires a validated submitted result matching the authenticated submission`);
      }
      let value: unknown;
      try { value = JSON.parse(submission.output) as unknown; } catch {
        throw new Error(`Run ${runId} result is not valid JSON`);
      }
      const validation = validateRoleOutput(stored.role.toLowerCase(), value);
      if (!validation.valid) throw new Error(`Run ${runId} result rejected: ${validation.error}`);
      tx.run(
        `UPDATE agent_runs SET status = 'COMPLETED', exit_code = $exit_code,
          output = $output, ended_at = $ended_at WHERE id = $id`,
        {
          id: runId,
          exit_code: outcome.exitCode,
          output: submission.output,
          ended_at: new Date().toISOString(),
        }
      );
      return this.getRun(tx, runId);
    });
  }

  /**
   * Обновляет run with collected usage.
   */
  async collectUsage(runId: string, usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    cost: number;
  }): Promise<void> {
    this.db.transaction((tx) => {
      tx.run(
        `UPDATE agent_runs SET input_tokens = $input_tokens, cached_input_tokens = $cached_input_tokens,
          output_tokens = $output_tokens, cost = $cost WHERE id = $id`,
        {
          id: runId,
          input_tokens: usage.inputTokens,
          cached_input_tokens: usage.cachedInputTokens,
          output_tokens: usage.outputTokens,
          cost: usage.cost,
        }
      );
    });
  }

  /**
   * Получает a run by ID.
   */
   private getRun(tx: DatabaseTx, runId: string): AgentRun {
    const row = tx.get(
      `SELECT * FROM agent_runs WHERE id = $id`,
      { id: runId }
    );
    if (!row) {
      throw new Error(`Run ${runId} not found`);
    }
     return {
      id: row.id as string,
      role: row.role as string,
      runtime: row.runtime as string,
      model: row.model as string,
      taskId: row.task_id as string | null,
      epicId: row.epic_id as string | null,
      status: row.status as RunStatus,
      sessionId: row.session_id as string | null,
      attempt: row.attempt as number | null,
       triggerReason: row.trigger_reason as RunTrigger | null,
      contextVersion: row.context_version as string | null,
      outputSchemaVersion: row.output_schema_version as string | null,
      startedAt: row.started_at ? new Date(row.started_at as string) : null,
      endedAt: row.ended_at ? new Date(row.ended_at as string) : null,
      exitCode: row.exit_code as number | null,
      inputTokens: row.input_tokens as number | null,
      cachedInputTokens: row.cached_input_tokens as number | null,
      outputTokens: row.output_tokens as number | null,
       cost: row.cost as number | null,
       ...(row.prompt ? { prompt: row.prompt as string } : {}),
        ...(row.capability_ref ? { capabilityRef: row.capability_ref as string } : {}),
    };
  }
}
