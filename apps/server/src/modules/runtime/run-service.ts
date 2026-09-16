/**
 * Run service for managing agent run lifecycle.
 */

import type { Database, DatabaseTx } from "../../platform/database/database.js";
import type { AgentRuntime } from "./agent-runtime.js";
import type { AgentRun, RunStatus, RunTrigger } from "@orchestrator/contracts";
import type { StartRunOptions, ResumeRunOptions, RunOutcome } from "./run-types.js";
import { validateRoleOutput } from "./output-validator.js";
import { DatabaseCompletionStore, type CompletionStore } from "../execution/mcp/submit-result-tool.js";
import type { RoleName, ToolId } from "../execution/run-capability.js";

export class RunService {
  constructor(
    private readonly db: Database,
    private readonly runtime: AgentRuntime
  ) {
    // Keep databases created before capability_json usable while the migration
    // set is upgraded by the host process.
    const columns = this.db.all<{ name: string }>("PRAGMA table_info(agent_runs)");
    if (!columns.some((column) => column.name === "capability_json")) {
      this.db.exec("ALTER TABLE agent_runs ADD COLUMN capability_json TEXT");
    }
  }

  /** Adapter used by MCP. The UPDATE predicate makes acceptance atomic and one-shot. */
  completionStore(): CompletionStore {
    return new DatabaseCompletionStore(this.db);
  }

  getCapabilityReference(runId: string): string {
    const row = this.db.get<{ capability_ref: string | null }>(
      "SELECT capability_ref FROM agent_runs WHERE id = $id", { id: runId });
    if (!row?.capability_ref) throw new Error(`Run ${runId} has no active capability`);
    return row.capability_ref;
  }

  /**
   * Start a new agent run.
   */
  async startRun(options: StartRunOptions): Promise<AgentRun> {
    const record = this.db.transaction((tx) => {
      const id = crypto.randomUUID();
      const capabilityRef = crypto.randomUUID();
      const capability = { id: capabilityRef, capabilityRef, runId: id,
        role: options.role.toLowerCase() as RoleName, workspace: options.capability?.workspace ?? "",
        allowedTools: (options.capability?.allowedTools ?? ["submit_result"]) as ToolId[] };
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
          session_id, attempt, trigger_reason, context_version,
           output_schema_version, started_at, ended_at, exit_code,
            input_tokens, cached_input_tokens, output_tokens, cost, capability_ref, capability_json
        ) VALUES ($id, $role, $runtime, $model, $task_id, $epic_id, $status,
          $session_id, $attempt, $trigger_reason, $context_version,
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
    // startRun is the runtime readiness barrier: adapters resolve only after
    // their profile/config and launch have been prepared. Never expose a run
    // to callers while that asynchronous work is still in flight.
    await this.runtime.startRun(record);
    return record;
  }

  /**
   * Resume a run with session info.
   */
  async resumeRun(runId: string, options: ResumeRunOptions): Promise<AgentRun> {
    return this.db.transaction((tx) => {
      tx.run(
        `UPDATE agent_runs SET session_id = $session_id, attempt = $attempt,
          status = 'IN_PROGRESS' WHERE id = $id`,
        {
          id: runId,
          session_id: options.sessionId,
          attempt: options.attempt,
        }
      );
      return this.getRun(tx, runId);
    });
    await this.runtime.resumeRun(runId, options);
    return this.getRun(this.db, runId);
  }

  /**
   * Cancel a run.
   */
  async cancelRun(runId: string): Promise<void> {
    this.db.transaction((tx) => {
      tx.run(
        `UPDATE agent_runs SET status = 'CANCELLED', ended_at = $ended_at WHERE id = $id`,
        { id: runId, ended_at: new Date().toISOString() }
      );
      this.runtime.cancelRun(runId);
    });
  }

  /**
   * Collect result and update run status.
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
   * Update run with collected usage.
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
   * Get a run by ID.
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
       ...(row.capability_ref ? { capabilityRef: row.capability_ref as string } : {}),
    };
  }
}
