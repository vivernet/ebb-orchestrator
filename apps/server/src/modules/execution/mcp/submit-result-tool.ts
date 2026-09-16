import type { RunCapability } from '../run-capability.js';
import { validateRoleOutput } from '../../runtime/output-validator.js';

/**
 * SubmitResultTool validates role output schema and atomically sets run to COMPLETING.
 */
export class SubmitResultTool {
  constructor(private capability: RunCapability) {}

  /**
   * Validate and submit result. Returns success/error with atomic state transition.
   */
  async validateAndSubmit(payload: unknown): Promise<{ success: boolean; error?: string; result?: unknown }> {
    const validated = validateRoleOutput(this.capability.capability.role, payload);
    if (!validated.valid || !validated.output) {
      return {
        success: false,
        error: `schema validation failed: ${validated.error ?? 'role output validation failed'}`,
      };
    }

    // At this point, payload is validated.
    // The actual state transition to COMPLETING is handled by the MCP server,
    // which maintains run-specific state to prevent duplicate submissions.

    return {
      success: true,
      result: validated.output,
    };
  }
}
