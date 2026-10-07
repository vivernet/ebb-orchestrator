/** Возвращает ожидаемый токен только при точном совпадении; остальной payload отбрасывается. */
export function safeHermesProfileChainLaunchEvidence(error: unknown, stdout = "", stderr = ""):
  "HERMES_TICKET_OBJECT_MISMATCH" | "UNEXPECTED_LAUNCH_FAILURE" {
  const expected = "HERMES_TICKET_OBJECT_MISMATCH";
  if (error instanceof Error && error.message === expected) {
    return "HERMES_TICKET_OBJECT_MISMATCH";
  }
  if (stdout.trim() === expected || stderr.trim() === expected) return expected;
  return "UNEXPECTED_LAUNCH_FAILURE";
}
