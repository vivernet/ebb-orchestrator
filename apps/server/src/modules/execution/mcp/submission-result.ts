import { validateRoleOutput, type RoleOutput } from '../../runtime/output-validator.js';

/**
 * Extracts and validates the direct role-output JSON in a successful MCP tools/call response.
 * @param response - JSON-RPC response returned for a submit_result call.
 * @param role - Capability-bound role whose canonical output contract must validate the result.
 * @returns Validated role output only for a successful MCP tool response.
 */
export function extractSuccessfulSubmission(response: unknown, role: string): RoleOutput | undefined {
  if (!isRecord(response) || !isRecord(response.result) || response.result.isError === true) return undefined;
  const content = response.result.content;
  if (!Array.isArray(content)) return undefined;
  const textBlock = content.find((item) => isRecord(item) && typeof item.text === 'string');
  if (!isRecord(textBlock) || typeof textBlock.text !== 'string') return undefined;

  let envelope: unknown;
  try {
    envelope = JSON.parse(textBlock.text) as unknown;
  } catch {
    return undefined;
  }
  const validated = validateRoleOutput(role, envelope);
  return validated.valid && validated.output && typeof validated.outcome === 'string'
    ? validated.output
    : undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
