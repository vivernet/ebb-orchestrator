/**
 * Hermes session ID parser - extracts session IDs from hermes output.
 */

/**
 * Extracts session ID from hermes stdout output.
 *
 * Этот session ID appears in the format "session: <id>" in the output.
 * Returns null if no valid session ID is found.
 */
export function parseSessionId(stdout: string): string | null {
  const sessionPattern = /session:\s*([a-zA-Z0-9_-]+)/;
  const match = stdout.match(sessionPattern);
  return match?.[1] ?? null;
}

/**
 * Checks if stdout indicates a successful session start.
 */
export function hasValidSessionStart(stdout: string): boolean {
  return parseSessionId(stdout) !== null;
}
