const SAFE_SNAPSHOT_TREE_DIAGNOSTIC_STAGES = new Set([
  "PATH_ENUMERATION", "ENTRY_SHAPE", "FILE_ATTRIBUTES", "FILE_OPEN", "FILE_LINK_COUNT",
  "FILE_SIZE", "FILE_DACL", "CONTENT_HASH", "CONTENT_MISMATCH", "ENUMERATION_END",
  "ENUMERATION_COMPLETENESS", "PROJECTION_ENTRY_COLLISION",
]);
const SAFE_PROCESS_ERROR_NAMES = new Set([
  "Error", "TypeError", "RangeError", "ExitCodeError", "ProcessScopeLaunchNotDispatchedError",
]);
const SAFE_PROCESS_ERROR_CODES = new Set([
  "EACCES", "EBUSY", "EINVAL", "EIO", "EISDIR", "ENOENT", "ENOTDIR", "EPERM", "ETIMEDOUT",
  "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "ERR_CHILD_PROCESS_IPC_CHANNEL_CLOSED",
]);
const SAFE_NATIVE_HELPER_FAILURE_CODES = new Set([
  "ARGUMENTS_INVALID", "CHILD_ATTRIBUTE_INIT_FAILED", "CHILD_CREATE_FAILED",
  "CHILD_HANDLE_ALLOWLIST_FAILED", "CHILD_IDENTITY_PERSIST_FAILED", "CHILD_JOB_ASSIGNMENT_FAILED",
  "CHILD_JOB_BARRIER_UNAVAILABLE", "CHILD_JOB_MEMBERSHIP_UNPROVEN", "CHILD_RESUME_API_ERROR",
  "CHILD_RESUME_COUNT_GREATER_THAN_ONE", "CHILD_RESUME_COUNT_ZERO", "CHILD_STARTUP_FRAME_TOO_LARGE",
  "CHILD_STDIO_FAILED", "HERMES_TICKET_OBJECT_MISMATCH", "IDENTITY_OUTPUT_FAILED",
  "LAUNCH_TICKET_EXECUTABLE_MISMATCH", "LAUNCH_TICKET_HERMES_MISMATCH",
  "LAUNCH_TICKET_PROFILE_CHAIN_MISMATCH", "LAUNCH_TICKET_PROFILE_CHAIN_SHAPE_MISMATCH",
  "LAUNCH_TICKET_PROFILE_PATH_BINDING_MISMATCH", "LAUNCH_TICKET_PROFILE_ROOT_UNSAFE",
  "LAUNCH_TICKET_PROFILE_COMPONENT_UNSAFE", "LAUNCH_TICKET_PROFILE_TARGETS_MISMATCH",
  "LAUNCH_TICKET_SOURCE_SNAPSHOT_MISMATCH", "LAUNCH_TICKET_SOURCE_SNAPSHOT_ROOT_UNSAFE",
  "LAUNCH_TICKET_SOURCE_SNAPSHOT_PROJECTION_UNSAFE", "LAUNCH_TICKET_SOURCE_SNAPSHOT_TREE_MISMATCH",
  "JOB_ACCOUNTING_UNAVAILABLE", "JOB_ABSENT_HELPER_IDENTITY_MISSING", "JOB_ABSENT_HELPER_INVENTORY_UNAVAILABLE",
  "JOB_ABSENT_HELPER_STILL_LIVE", "JOB_ABSENT_LAUNCH_PENDING", "JOB_ABSENT_OWNER_STATE_UNKNOWN",
  "JOB_ABSENT_PREPARED_HAS_HELPER_IDENTITY", "JOB_CREATE_FAILED_OR_EXISTS", "JOB_OPEN_UNAVAILABLE",
  "JOB_POLICY_FAILED", "JOB_STOP_TIMEOUT", "JOB_TERMINATE_FAILED", "JOB_OR_IDENTITY_UNAVAILABLE",
  "LAUNCH_ACK_REJECTED", "LAUNCH_CONTROL_CHANNEL_LOST", "LAUNCH_FRAME_INVALID",
  "LAUNCH_PHASE_WRITE_FAILED", "MAPPING_CREATE_FAILED_OR_EXISTS", "MAPPING_OR_IDENTITY_UNAVAILABLE",
  "PAYLOAD_EXIT_STATUS_UNAVAILABLE", "PHASE_MAPPING_CREATE_FAILED", "PHASE_UNAVAILABLE",
]);
const SAFE_STABLE_LAUNCH_MESSAGES = new Set([
  "HERMES_TICKET_OBJECT_MISMATCH",
  "WINDOWS_PROCESS_SCOPE_LAUNCH_CANCELLED", "WINDOWS_PROCESS_SCOPE_STOP_UNPROVEN",
  "WINDOWS_PROCESS_SCOPE_TIMEOUT", "WINDOWS_PROCESS_SCOPE_LIVE_IDENTITY_MISSING",
]);

/** Формирует test assertion context из стабильного native code и, если доступен, allowlisted stage. */
export function safeHermesLaunchFailureAssertionContext(error: unknown): string {
  if (!(error instanceof Error)) return "NON_CANONICAL_LAUNCH_ERROR";
  if (!isSafeStableLaunchMessage(error.message)) return safeProcessFailureMetadata(error);
  const diagnosticStage = (error as Error & { readonly diagnosticStage?: unknown }).diagnosticStage;
  return typeof diagnosticStage === "string" && SAFE_SNAPSHOT_TREE_DIAGNOSTIC_STAGES.has(diagnosticStage)
    ? `${error.message}:${diagnosticStage}`
    : error.message;
}

function isSafeStableLaunchMessage(message: string): boolean {
  if (SAFE_STABLE_LAUNCH_MESSAGES.has(message)) return true;
  const prefix = "WINDOWS_HELPER_NATIVE_UNKNOWN:";
  return message.startsWith(prefix) && SAFE_NATIVE_HELPER_FAILURE_CODES.has(message.slice(prefix.length));
}

function safeProcessFailureMetadata(error: Error): string {
  const parts: string[] = [];
  let current: unknown = error;
  const seen = new Set<object>();
  for (let depth = 0; depth < 3 && isObject(current) && !seen.has(current); depth += 1) {
    seen.add(current);
    const record = current as Record<string, unknown>;
    const name = typeof record.name === "string" && SAFE_PROCESS_ERROR_NAMES.has(record.name)
      ? record.name
      : "Error";
    const fields = [`name=${name}`];
    const status = record.status;
    if (typeof status === "number" && Number.isSafeInteger(status) && status >= 0 && status <= 255) {
      fields.push(`status=${status}`);
    }
    const exitCode = record.exitCode;
    if (typeof exitCode === "number" && Number.isSafeInteger(exitCode) && exitCode >= 0 && exitCode <= 255) {
      fields.push(`exit=${exitCode}`);
    }
    if (typeof record.code === "string" && SAFE_PROCESS_ERROR_CODES.has(record.code)) {
      fields.push(`code=${record.code}`);
    }
    parts.push(fields.join(","));
    current = record.cause;
  }
  return parts.length ? `UNEXPECTED_LAUNCH_FAILURE:${parts.join(":cause:")}` : "NON_CANONICAL_LAUNCH_ERROR";
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

/** Возвращает ожидаемый токен только при точном совпадении; остальной payload отбрасывается. */
export function safeHermesProfileChainLaunchEvidence(error: unknown, stdout = "", _stderr = "", exitCode?: number):
  "HERMES_TICKET_OBJECT_MISMATCH" | "LAUNCH_TICKET_PROFILE_COMPONENT_UNSAFE" | "UNEXPECTED_LAUNCH_FAILURE" {
  const trustedRefusalCodes = [
    "HERMES_TICKET_OBJECT_MISMATCH",
    "LAUNCH_TICKET_PROFILE_COMPONENT_UNSAFE",
  ] as const;
  if (error instanceof Error) {
    for (const code of trustedRefusalCodes) {
      if (error.message === code || error.message === `WINDOWS_HELPER_NATIVE_UNKNOWN:${code}`) return code;
    }
  }
  const expected = "HERMES_TICKET_OBJECT_MISMATCH";
  const nativeRecord = `UNKNOWN\t${expected}`;
  const exactNativeRecord = stdout === nativeRecord
    || stdout === `${nativeRecord}\n`
    || stdout === `${nativeRecord}\r\n`;
  if (exitCode === 3 && exactNativeRecord) return expected;
  return "UNEXPECTED_LAUNCH_FAILURE";
}
