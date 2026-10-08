const SAFE_RESTART_CHILD_ERROR_CODES = new Set([
  "PROCESS_SCOPE_ENVIRONMENT_REJECTED",
  "PROCESS_SCOPE_LAUNCH_CANCELLED",
  "PROCESS_SCOPE_LIVE_MEMBERSHIP_UNPROVEN",
  "PROCESS_SCOPE_LIVE_IDENTITY_MISSING",
  "PROCESS_SCOPE_STOP_UNPROVEN",
  "PROCESS_SCOPE_EXITED_BEFORE_MEMBERSHIP",
  "PROCESS_SCOPE_LAUNCH_IDENTITY_UNVERIFIED",
  "PROCESS_SCOPE_LAUNCH_TIMEOUT",
  "PROCESS_SCOPE_SUPERVISOR_REQUIRED",
  "PROCESS_SCOPE_STATE_UNKNOWN",
  "PROCESS_SCOPE_IDENTITY_MISMATCH",
  "WINDOWS_PROCESS_SCOPE_LAUNCH_CANCELLED",
  "WINDOWS_PROCESS_SCOPE_LIVE_IDENTITY_MISSING",
  "WINDOWS_PROCESS_SCOPE_STOP_UNPROVEN",
  "WINDOWS_PROCESS_SCOPE_TIMEOUT",
  "WINDOWS_PROCESS_SCOPE_UNSUPPORTED",
  "WINDOWS_HERMES_LAUNCH_IDENTITY_REQUIRED",
  "WINDOWS_HERMES_LAUNCH_PLATFORM_MISMATCH",
  "WINDOWS_JOB_IDENTITY_MISMATCH",
  "WINDOWS_JOB_IDENTITY_INVALID",
  "WINDOWS_JOB_OPEN_UNAVAILABLE",
  "WINDOWS_MAPPING_OR_IDENTITY_UNAVAILABLE",
  "WINDOWS_HELPER_UNEXPECTED_PRELAUNCH_OUTPUT",
  "WINDOWS_HELPER_PAYLOAD_STREAM_FAILED",
  "WINDOWS_HELPER_PAYLOAD_CALLBACK_FAILED",
  "WINDOWS_HELPER_HANDSHAKE_TIMEOUT",
  "WINDOWS_NATIVE_HELPER_GATE_FAILURE",
  "WINDOWS_HELPER_CHANNEL_FAILED",
  "WINDOWS_HELPER_PROTOCOL_BUFFER_EXCEEDED",
  "WINDOWS_HELPER_NATIVE_UNKNOWN",
  "WINDOWS_JOB_STOP_NOT_CONFIRMED",
  "WINDOWS_JOB_STOP_TIMEOUT",
  "WINDOWS_JOB_INSPECTION_UNAVAILABLE",
  "WINDOWS_JOB_INSPECTION_HELPER_INVOCATION_UNAVAILABLE",
  "WINDOWS_JOB_INSPECTION_PROCESS_EXECUTION_UNAVAILABLE",
  "WINDOWS_JOB_INSPECTION_PROCESS_TIMEOUT",
  "WINDOWS_JOB_INSPECTION_OUTPUT_LIMIT",
  "WINDOWS_JOB_INSPECTION_PROCESS_ABORTED",
  "WINDOWS_JOB_INSPECTION_PROCESS_EXIT_NONZERO",
  "WINDOWS_JOB_INSPECTION_PROCESS_SPAWN_FAILED",
  "WINDOWS_JOB_INSPECTION_HELPER_ARGUMENT_GATE_FAILED",
  "WINDOWS_JOB_INSPECTION_HELPER_PATH_GATE_FAILED",
  "WINDOWS_JOB_INSPECTION_HELPER_FILE_GATE_FAILED",
  "WINDOWS_JOB_INSPECTION_HELPER_INTEGRITY_GATE_FAILED",
  "WINDOWS_JOB_INSPECTION_HELPER_INTEGRITY_MISMATCH",
  "WINDOWS_JOB_INSPECTION_HELPER_PROCESS_START_GATE_FAILED",
  "WINDOWS_JOB_INSPECTION_NATIVE_LAUNCH_FAILED",
  "WINDOWS_JOB_INSPECTION_NATIVE_REFUSAL",
  "WINDOWS_JOB_INSPECTION_OUTPUT_PARSE_FAILED",
  "WINDOWS_PROCESS_SCOPE_LAUNCH_UNPROVEN",
  "RUN_PROCESS_OWNER_MISSING",
  "RUN_PROCESS_OWNER_NOT_PREPARED",
  "RUN_PROCESS_STOP_PROOF_INVALID",
  "RUN_PROCESS_STOP_PROOF_PERSISTENCE_FAILED",
  "RUN_PROCESS_SCOPE_STOP_UNPROVEN",
  // Exact Windows observation reasons forwarded by Run recovery; dynamic owner IDs are never accepted.
  "WINDOWS_ATTEMPT_NONCE_MISMATCH",
  "WINDOWS_ATTEMPT_JOB_STILL_LIVE",
  "WINDOWS_ATTEMPT_ABSENCE_EVIDENCE_MALFORMED",
  "WINDOWS_ATTEMPT_NEVER_LAUNCHED_CONFLICT",
  "WINDOWS_ATTEMPT_SESSION_PENDING",
  "WINDOWS_JOB_IDENTITY_UNPROVEN",
  "WINDOWS_PHASE_UNAVAILABLE",
  "WINDOWS_JOB_ABSENT_LAUNCH_PENDING",
  "WINDOWS_JOB_ABSENT_PREPARED_HAS_HELPER_IDENTITY",
  "WINDOWS_JOB_ABSENT_OWNER_STATE_UNKNOWN",
  "WINDOWS_JOB_ABSENT_HELPER_IDENTITY_MISSING",
  "WINDOWS_JOB_ABSENT_HELPER_INVENTORY_UNAVAILABLE",
  "WINDOWS_JOB_ABSENT_HELPER_STILL_LIVE",
  "WINDOWS_JOB_ACCOUNTING_UNAVAILABLE",
  "RUN_PROCESS_OWNER_UNAVAILABLE",
  // Native Windows helper report() codes.
  "ARGUMENTS_INVALID",
  "CHILD_ATTRIBUTE_INIT_FAILED",
  "CHILD_CREATE_FAILED",
  "CHILD_HANDLE_ALLOWLIST_FAILED",
  "CHILD_IDENTITY_PERSIST_FAILED",
  "CHILD_JOB_ASSIGNMENT_FAILED",
  "CHILD_JOB_BARRIER_UNAVAILABLE",
  "CHILD_JOB_MEMBERSHIP_UNPROVEN",
  "CHILD_RESUME_FAILED",
  "CHILD_RESUME_API_ERROR",
  "CHILD_RESUME_COUNT_ZERO",
  "CHILD_RESUME_COUNT_GREATER_THAN_ONE",
  "CHILD_STARTUP_FRAME_TOO_LARGE",
  "CHILD_STDIO_FAILED",
  "HERMES_TICKET_OBJECT_MISMATCH",
  "IDENTITY_OUTPUT_FAILED",
  "JOB_ACCOUNTING_UNAVAILABLE",
  "JOB_CREATE_FAILED_OR_EXISTS",
  "JOB_OR_IDENTITY_UNAVAILABLE",
  "JOB_POLICY_FAILED",
  "JOB_STOP_TIMEOUT",
  "JOB_TERMINATE_FAILED",
  "LAUNCH_ACK_REJECTED",
  "LAUNCH_CONTROL_CHANNEL_LOST",
  "LAUNCH_FRAME_INVALID",
  "LAUNCH_TICKET_EXECUTABLE_MISMATCH",
  "LAUNCH_TICKET_HERMES_MISMATCH",
  "LAUNCH_TICKET_PROFILE_TARGETS_MISMATCH",
  "MAPPING_CREATE_FAILED_OR_EXISTS",
  "PHASE_MAPPING_CREATE_FAILED",
  "LAUNCH_PHASE_WRITE_FAILED",
  "PAYLOAD_EXIT_STATUS_UNAVAILABLE",
]);

const SAFE_NATIVE_HELPER_FAILURE_DETAILS = new Set([
  "JOB_OR_IDENTITY_UNAVAILABLE",
  "JOB_OPEN_UNAVAILABLE",
  "MAPPING_OR_IDENTITY_UNAVAILABLE",
  "JOB_ABSENT_LAUNCH_PENDING",
  "JOB_ABSENT_PREPARED_HAS_HELPER_IDENTITY",
  "JOB_ABSENT_OWNER_STATE_UNKNOWN",
  "JOB_ABSENT_HELPER_IDENTITY_MISSING",
  "JOB_ABSENT_HELPER_INVENTORY_UNAVAILABLE",
  "JOB_ABSENT_HELPER_STILL_LIVE",
  "JOB_ACCOUNTING_UNAVAILABLE",
  "JOB_CREATE_FAILED_OR_EXISTS",
  "PHASE_UNAVAILABLE",
  // Native Windows helper report() codes.
  "ARGUMENTS_INVALID",
  "CHILD_ATTRIBUTE_INIT_FAILED",
  "CHILD_CREATE_FAILED",
  "CHILD_HANDLE_ALLOWLIST_FAILED",
  "CHILD_IDENTITY_PERSIST_FAILED",
  "CHILD_JOB_ASSIGNMENT_FAILED",
  "CHILD_JOB_BARRIER_UNAVAILABLE",
  "CHILD_JOB_MEMBERSHIP_UNPROVEN",
  "CHILD_RESUME_FAILED",
  "CHILD_RESUME_API_ERROR",
  "CHILD_RESUME_COUNT_ZERO",
  "CHILD_RESUME_COUNT_GREATER_THAN_ONE",
  "CHILD_STARTUP_FRAME_TOO_LARGE",
  "CHILD_STDIO_FAILED",
  "HERMES_TICKET_OBJECT_MISMATCH",
  "IDENTITY_OUTPUT_FAILED",
  "LAUNCH_TICKET_EXECUTABLE_MISMATCH",
  "LAUNCH_TICKET_HERMES_MISMATCH",
  "LAUNCH_TICKET_PROFILE_TARGETS_MISMATCH",
  "JOB_POLICY_FAILED",
  "JOB_STOP_TIMEOUT",
  "JOB_TERMINATE_FAILED",
  "LAUNCH_ACK_REJECTED",
  "LAUNCH_CONTROL_CHANNEL_LOST",
  "LAUNCH_FRAME_INVALID",
  "MAPPING_CREATE_FAILED_OR_EXISTS",
  "PHASE_MAPPING_CREATE_FAILED",
  "LAUNCH_PHASE_WRITE_FAILED",
  "PAYLOAD_EXIT_STATUS_UNAVAILABLE",
]);

const SAFE_WRAPPER_NATIVE_DETAILS = new Map<string, ReadonlySet<string>>([
  ["WINDOWS_HELPER_HANDSHAKE_TIMEOUT", new Set(["EBB_HELPER_READY", "EBB_SCOPE_READY"])],
  ["WINDOWS_NATIVE_HELPER_GATE_FAILURE", new Set([
    "ARGUMENT_DECODE", "ARGUMENT_JSON", "ARGUMENT_VALIDATION", "ARGUMENT_TYPE", "ARGUMENT_NUL",
    "PATH_NORMALIZATION", "PARENT_DIRECTORY_LOCK", "PARENT_DIRECTORY_OPEN", "PARENT_DIRECTORY_CHECK",
    "HELPER_FILE_LOCK", "HELPER_FILE_OPEN", "INTEGRITY_CHECK", "PROCESS_START",
  ])],
  ["WINDOWS_HELPER_NATIVE_UNKNOWN", SAFE_NATIVE_HELPER_FAILURE_DETAILS],
  ["WINDOWS_PROCESS_SCOPE_LAUNCH_UNPROVEN", new Set([
    "WINDOWS_JOB_STOP_NOT_CONFIRMED",
    "WINDOWS_JOB_STOP_TIMEOUT",
    "WINDOWS_JOB_INSPECTION_UNAVAILABLE",
    "WINDOWS_JOB_INSPECTION_HELPER_INVOCATION_UNAVAILABLE",
    "WINDOWS_JOB_INSPECTION_PROCESS_EXECUTION_UNAVAILABLE",
    "WINDOWS_JOB_INSPECTION_PROCESS_TIMEOUT",
    "WINDOWS_JOB_INSPECTION_OUTPUT_LIMIT",
    "WINDOWS_JOB_INSPECTION_PROCESS_ABORTED",
    "WINDOWS_JOB_INSPECTION_PROCESS_EXIT_NONZERO",
    "WINDOWS_JOB_INSPECTION_PROCESS_SPAWN_FAILED",
    "WINDOWS_JOB_INSPECTION_HELPER_ARGUMENT_GATE_FAILED",
    "WINDOWS_JOB_INSPECTION_HELPER_PATH_GATE_FAILED",
    "WINDOWS_JOB_INSPECTION_HELPER_FILE_GATE_FAILED",
    "WINDOWS_JOB_INSPECTION_HELPER_INTEGRITY_GATE_FAILED",
    "WINDOWS_JOB_INSPECTION_HELPER_INTEGRITY_MISMATCH",
    "WINDOWS_JOB_INSPECTION_HELPER_PROCESS_START_GATE_FAILED",
    "WINDOWS_JOB_INSPECTION_NATIVE_LAUNCH_FAILED",
    "WINDOWS_JOB_INSPECTION_NATIVE_REFUSAL",
    "WINDOWS_JOB_INSPECTION_OUTPUT_PARSE_FAILED",
    "WINDOWS_JOB_OR_IDENTITY_UNAVAILABLE",
    "WINDOWS_JOB_OPEN_UNAVAILABLE",
    "WINDOWS_MAPPING_OR_IDENTITY_UNAVAILABLE",
    "WINDOWS_JOB_ABSENT_LAUNCH_PENDING",
    "WINDOWS_JOB_ABSENT_PREPARED_HAS_HELPER_IDENTITY",
    "WINDOWS_JOB_ABSENT_OWNER_STATE_UNKNOWN",
    "WINDOWS_JOB_ABSENT_HELPER_IDENTITY_MISSING",
    "WINDOWS_JOB_ABSENT_HELPER_INVENTORY_UNAVAILABLE",
    "WINDOWS_JOB_ABSENT_HELPER_STILL_LIVE",
    "WINDOWS_JOB_ACCOUNTING_UNAVAILABLE",
  ])],
]);

const SAFE_NATIVE_HELPER_DIAGNOSTIC_PHASES = new Set([
  "UNCLASSIFIED", "ARGUMENT_DECODE", "ARGUMENT_JSON", "ARGUMENT_VALIDATION", "ARGUMENT_TYPE", "ARGUMENT_NUL",
  "PATH_NORMALIZATION", "PARENT_DIRECTORY_LOCK", "PARENT_DIRECTORY_OPEN", "PARENT_DIRECTORY_CHECK",
  "HELPER_FILE_LOCK", "HELPER_FILE_OPEN", "INTEGRITY_CHECK", "PROCESS_START",
]);
const SAFE_NATIVE_HELPER_DIAGNOSTIC_TYPES = new Set([
  "UNCLASSIFIED", "ARGUMENT_EXCEPTION", "BAD_IMAGE_FORMAT_EXCEPTION", "CRYPTOGRAPHIC_EXCEPTION",
  "FILE_LOAD_EXCEPTION", "FILE_NOT_FOUND_EXCEPTION", "IO_EXCEPTION", "INVALID_OPERATION_EXCEPTION",
  "METHOD_INVOCATION_EXCEPTION", "NOT_SUPPORTED_EXCEPTION", "PATH_TOO_LONG_EXCEPTION",
  "PLATFORM_NOT_SUPPORTED_EXCEPTION", "REFLECTION_TYPE_LOAD_EXCEPTION", "RUNTIME_EXCEPTION",
  "SECURITY_EXCEPTION", "SYSTEM_EXCEPTION", "TYPE_INITIALIZATION_EXCEPTION", "TYPE_LOAD_EXCEPTION",
  "UNAUTHORIZED_ACCESS_EXCEPTION", "WIN32_EXCEPTION",
]);

const MAX_CAUSE_DEPTH = 8;
const MAX_REPORTED_CODES = 2;

export type RestartChildTerminalStatus =
  | { kind: "failure"; failureCode?: string }
  | { kind: "exit"; exitCode: number };

/** Stores terminal process state beside the launch-ready marker without including output streams. */
export function restartChildTerminalStatusPath(readyMarkerPath: string): string {
  return `${readyMarkerPath}.terminal-status.json`;
}

/** Serializes only a validated allowlisted failure code or bounded unsigned process exit status. */
export function serializeRestartChildTerminalStatus(status: RestartChildTerminalStatus): string {
  const serialized = JSON.stringify(status);
  if (parseRestartChildTerminalStatus(serialized) === undefined) {
    throw new Error("PROCESS_SCOPE_TERMINAL_STATUS_INVALID");
  }
  return serialized;
}

/** Selects an allowlisted error code, falling back to a fixed status with no error text. */
export function restartChildTerminalStatusForFailure(error: unknown): RestartChildTerminalStatus {
  const failureCode = safeRestartChildFailureCode(error);
  return failureCode === undefined ? { kind: "failure" } : { kind: "failure", failureCode };
}

/** Parses the provider-free sidecar shape and rejects arbitrary fields or untrusted error text. */
export function parseRestartChildTerminalStatus(value: string): RestartChildTerminalStatus | undefined {
  if (value.length > 1_024) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { return undefined; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;

  const status = parsed as Record<string, unknown>;
  const keys = Object.keys(status).sort().join(",");
  if (status.kind === "failure" && keys === "kind") {
    return { kind: "failure" };
  }
  if (status.kind === "failure" && keys === "failureCode,kind" &&
      typeof status.failureCode === "string" && isSafeRestartChildFailureCode(status.failureCode)) {
    return { kind: "failure", failureCode: status.failureCode };
  }
  if (status.kind === "exit" && keys === "exitCode,kind" &&
      typeof status.exitCode === "number" && Number.isSafeInteger(status.exitCode) &&
      status.exitCode >= 0 && status.exitCode <= 0xFFFF_FFFF) {
    return { kind: "exit", exitCode: status.exitCode };
  }
  return undefined;
}

/** Formats only validated terminal status fields; malformed file contents are never echoed. */
export function formatRestartChildTerminalStatusDiagnostic(value: string): string {
  const status = parseRestartChildTerminalStatus(value);
  if (status === undefined) return "PROCESS_SCOPE_TERMINAL_STATUS_INVALID";
  if (status.kind === "failure") {
    return status.failureCode === undefined
      ? "PROCESS_SCOPE_TERMINAL_FAILURE"
      : `PROCESS_SCOPE_TERMINAL_FAILURE:${status.failureCode}`;
  }
  return `PROCESS_SCOPE_TERMINAL_EXIT_CODE:${status.exitCode}`;
}

/** Returns only exact allowlisted process-scope/native error identifiers from an Error cause chain. */
export function safeRestartChildFailureCode(error: unknown): string | undefined {
  const codes: string[] = [];
  const seen = new Set<Error>();
  let current: unknown = error;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error && !seen.has(current); depth += 1) {
    seen.add(current);
    const code = parseSafeErrorCode(current.message);
    if (code !== undefined && !codes.includes(code)) codes.push(code);
    if (codes.length >= MAX_REPORTED_CODES) break;
    current = current.cause;
  }

  return codes.length > 0 ? codes.join(">") : undefined;
}

/** Validates a bounded sequence previously emitted by safeRestartChildFailureCode. */
export function isSafeRestartChildFailureCode(value: string): boolean {
  const codes = value.split(">");
  return codes.length > 0 && codes.length <= MAX_REPORTED_CODES && codes.every(isAllowlistedCode);
}

/** Formats only an allowlisted failure marker and whether each worker stream had content. */
export function formatRestartChildOutputDiagnostic(stdout: string, stderr: string): string {
  const failureDiagnostic = extractRestartChildFailureDiagnostic(stdout)
    ?? extractRestartChildFailureDiagnostic(stderr)
    ?? "PROCESS_SCOPE_RESTART_CHILD_FAILED";
  const stdoutState = stdout.length === 0 ? "empty" : "present-redacted";
  const stderrState = stderr.length === 0 ? "empty" : "present-redacted";
  return `${failureDiagnostic} workerStdout=${stdoutState} workerStderr=${stderrState}`;
}

/** Preserves the recovery exit code while excluding raw child output from a missing-marker error. */
export function formatRestartChildRecoveryMarkerFailure(
  exitCode: number | null,
  stdout: string,
  stderr: string,
): string {
  return `PROCESS_SCOPE_RECOVERY_MARKER_MISSING:${exitCode}:${formatRestartChildOutputDiagnostic(stdout, stderr)}`;
}

/** Formats only an allowlisted recovery marker code and a bounded worker exit status. */
export function formatRestartChildRecoveryFailureDiagnostic(
  exitCode: number | null,
  result: unknown,
): string {
  const boundedExitCode = Number.isSafeInteger(exitCode) && exitCode !== null && exitCode >= 0 && exitCode <= 0xFFFF_FFFF
    ? exitCode
    : "UNKNOWN";
  if (typeof result === "object" && result !== null && !Array.isArray(result)) {
    const failureCode = (result as Record<string, unknown>).failureCode;
    if ((result as Record<string, unknown>).ok === false && typeof failureCode === "string" && isSafeRestartChildFailureCode(failureCode)) {
      return `PROCESS_SCOPE_RECOVERY_FAILED:${failureCode}:EXIT_${boundedExitCode}`;
    }
  }
  return `PROCESS_SCOPE_RECOVERY_FAILED:UNKNOWN:EXIT_${boundedExitCode}`;
}

function extractRestartChildFailureDiagnostic(output: string): string | undefined {
  for (const line of output.split(/\r?\n/u)) {
    if (line === "PROCESS_SCOPE_RESTART_CHILD_FAILED") return line;
    const prefix = "PROCESS_SCOPE_RESTART_CHILD_FAILED:";
    if (!line.startsWith(prefix)) continue;
    const code = line.slice(prefix.length);
    if (isSafeRestartChildFailureCode(code)) return `${prefix}${code}`;
  }
  return undefined;
}

function parseSafeErrorCode(message: string): string | undefined {
  if (message.length > 768) return undefined;
  if (SAFE_RESTART_CHILD_ERROR_CODES.has(message)) return message;
  if (isSafeNativeHelperDiagnostic(message)) return message;

  const separator = message.indexOf(":");
  if (separator <= 0 || message.indexOf(":", separator + 1) !== -1) return undefined;
  const wrapper = message.slice(0, separator);
  const detail = message.slice(separator + 1);
  if (!SAFE_RESTART_CHILD_ERROR_CODES.has(wrapper) || !SAFE_WRAPPER_NATIVE_DETAILS.get(wrapper)?.has(detail)) return undefined;
  return `${wrapper}:${detail}`;
}

function isAllowlistedCode(code: string): boolean {
  if (SAFE_RESTART_CHILD_ERROR_CODES.has(code)) return true;
  if (isSafeNativeHelperDiagnostic(code)) return true;
  const separator = code.indexOf(":");
  if (separator <= 0 || code.indexOf(":", separator + 1) !== -1) return false;
  const wrapper = code.slice(0, separator);
  const detail = code.slice(separator + 1);
  return SAFE_RESTART_CHILD_ERROR_CODES.has(wrapper) && (SAFE_WRAPPER_NATIVE_DETAILS.get(wrapper)?.has(detail) ?? false);
}

function isSafeNativeHelperDiagnostic(value: string): boolean {
  const fields = value.split(":");
  if ((fields.length !== 5 && fields.length !== 12) || fields[0] !== "WINDOWS_NATIVE_HELPER_DIAGNOSTIC") return false;
  const phase = /^PHASE_([A-Z_]+)$/u.exec(fields[1] ?? "")?.[1];
  const exceptionType = /^TYPE_([A-Z0-9_]+)$/u.exec(fields[2] ?? "")?.[1];
  const exitCode = /^EXIT_(\d{1,3}|UNAVAILABLE)$/u.exec(fields[3] ?? "")?.[1];
  if (!phase || !SAFE_NATIVE_HELPER_DIAGNOSTIC_PHASES.has(phase) || !exceptionType ||
      !SAFE_NATIVE_HELPER_DIAGNOSTIC_TYPES.has(exceptionType) || !exitCode ||
      (exitCode !== "UNAVAILABLE" && Number(exitCode) > 255) ||
      (fields[4] !== "READY_PRESENT" && fields[4] !== "READY_ABSENT")) return false;
  if (fields.length === 5) return true;

  const stagesField = /^STAGES=(.+)$/u.exec(fields[5] ?? "")?.[1];
  const stdoutCode = /^OUTCODE=(.+)$/u.exec(fields[6] ?? "")?.[1];
  if (!stagesField || !stdoutCode || !/^OUTB=[01]$/u.test(fields[7] ?? "") ||
      !/^ERRB=[01]$/u.test(fields[8] ?? "") || !/^DONE=[01]$/u.test(fields[9] ?? "") ||
      !/^OUTEND=[01]$/u.test(fields[10] ?? "") || !/^ERREND=[01]$/u.test(fields[11] ?? "")) return false;
  const stageNames = new Set(["INVOCATION", "SESSION", "OUT", "ERR", "READY", "SCOPE", "TIMEOUT", "SETTLED", "OUT_END", "ERR_END"]);
  const stageTokens = stagesField === "NONE" ? [] : stagesField.split(",");
  if (stageTokens.length > stageNames.size || stageTokens.some((token) => {
    const match = /^([A-Z_]+)@(\d{1,5})$/u.exec(token);
    return !match || !stageNames.has(match[1]!) || Number(match[2]) > 60_000;
  }) || new Set(stageTokens.map((token) => token.split("@")[0])).size !== stageTokens.length) return false;
  if (["NONE", "PARTIAL", "UNRECOGNIZED", "OVERSIZED", "READY", "SCOPE"].includes(stdoutCode)) return true;
  return stdoutCode.startsWith("UNKNOWN_") && SAFE_NATIVE_HELPER_FAILURE_DETAILS.has(stdoutCode.slice("UNKNOWN_".length));
}
