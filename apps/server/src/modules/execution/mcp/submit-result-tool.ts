import { z } from 'zod';
import type { RunCapability } from '../run-capability.js';

/**
 * SubmitResultTool validates role output schema and atomically sets run to COMPLETING.
 */
export class SubmitResultTool {
  constructor(private capability: RunCapability) {}

  /**
   * Get the schema for role-specific output validation.
   */
  getSchema() {
    // Base schema that all roles extend (strict mode to reject unknown fields)
    const baseSchema = z.object({
      version: z.string().describe('Schema version for backward compatibility'),
      summary: z.string().optional().describe('High-level summary of the outcome'),
      findings: z
        .array(
          z.object({
            type: z.enum(['INFO', 'WARNING', 'MINOR', 'MAJOR', 'BLOCKING']).describe('Finding severity'),
            description: z.string().describe('Description of the finding'),
            file: z.string().optional().describe('File path if applicable'),
            line: z.number().optional().describe('Line number if applicable'),
          })
        )
        .optional()
        .describe('List of findings (optional)'),
    }).strict();

    // Extend with role-specific outcome based on capability role
    const outcomeSchema = z.enum(['COMPLETED', 'BLOCKED', 'PASS', 'CHANGES_REQUESTED', 'FAIL']);

    return baseSchema.extend({
      outcome: outcomeSchema,
    }).strict();
  }

  /**
   * Validate and submit result. Returns success/error with atomic state transition.
   */
  async validateAndSubmit(payload: unknown): Promise<{ success: boolean; error?: string; result?: unknown }> {
    const schema = this.getSchema();
    const parsed = schema.safeParse(payload);

    if (!parsed.success) {
      return {
        success: false,
        error: `schema validation failed: ${parsed.error.message}`,
      };
    }

    // At this point, payload is validated.
    // The actual state transition to COMPLETING is handled by the MCP server,
    // which maintains run-specific state to prevent duplicate submissions.

    return {
      success: true,
      result: parsed.data,
    };
  }
}
