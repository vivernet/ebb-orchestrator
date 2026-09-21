import type { RunCapability } from '../run-capability.js';
import { validateRoleOutput } from '../../runtime/output-validator.js';
import type { Database } from '../../../platform/database/database.js';

/**
 * SubmitResultTool validates role output schema and atomically sets run to COMPLETING.
 */
export class SubmitResultTool {
  constructor(private capability: RunCapability, private readonly completion?: CompletionStore) {}

  /**
   * Проверяет and submit result. Returns success/error with atomic state transition.
   */
  async validateAndSubmit(payload: unknown): Promise<{ success: boolean; error?: string; result?: unknown }> {
    const validated = validateRoleOutput(this.capability.capability.role, payload);
    if (!validated.valid || !validated.output) {
      return {
        success: false,
        error: `schema validation failed: ${validated.error ?? 'role output validation failed'}`,
      };
    }

    if (this.completion) {
      const accepted = await this.completion.accept(this.capability.reference, {
        runId: this.capability.runId,
        role: this.capability.capability.role,
        output: validated.output,
      });
      if (!accepted) return { success: false, error: 'RUN_ALREADY_COMPLETING or unauthorized capability' };
    }

    // At this point, payload is validated.
    // Этот actual state transition to COMPLETING is handled by the MCP server,
    // which maintains run-specific state to prevent duplicate submissions.

    return {
      success: true,
      result: validated.output,
    };
  }
}

export interface CompletionStore {
  /** Должен be implemented as one server-side conditional transaction. */
  accept(reference: string, value: { runId: string; role: string; output: unknown }): Promise<boolean>;
  /** Возвращает only the authenticated submission currently completing this run. */
  getSubmission?(runId: string): { runId: string; role: string; output: string } | undefined;
}

/** Atomic completion store usable by both the server and the MCP subprocess. */
export class DatabaseCompletionStore implements CompletionStore {
  constructor(private readonly db: Database) {}
  async accept(reference: string, value: { runId: string; role: string; output: unknown }): Promise<boolean> {
    return this.db.transaction((tx) => Boolean(tx.get<{ id: string }>(
      `UPDATE agent_runs SET status = 'COMPLETING', output = $output
       WHERE id = $run_id AND lower(role) = lower($role) AND capability_ref = $reference
         AND status IN ('STARTED','IN_PROGRESS') RETURNING id`,
      { run_id: value.runId, role: value.role, reference, output: JSON.stringify(value.output) },
    )));
  }

  getSubmission(runId: string): { runId: string; role: string; output: string } | undefined {
    const row = this.db.get<{ id: string; role: string; output: string | null }>(
      `SELECT id, role, output FROM agent_runs WHERE id = $run_id AND status = 'COMPLETING'`,
      { run_id: runId },
    );
    if (!row?.output) return undefined;
    return { runId: row.id, role: row.role, output: row.output };
  }
}
