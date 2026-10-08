import { fileURLToPath } from "node:url";
import { ExitCodeError, ProcessExecutor, type ProcessResult, type ProcessSession } from "./process-executor.js";
import type { ProcessScopeIdentity, ProcessScopeObservation } from "./process-inspector.js";
import { ProcessScopeLaunchNotDispatchedError, type ProcessScopeHandle, type ProcessScopeLaunchRequest, type ProcessScopeSupervisor } from "./run-scope-supervisor.js";
import { consumeHermesLaunchTicket, type HermesLaunchObjectIdentity, type HermesLaunchTicketInput } from "../../modules/runtime/hermes/hermes-launch-ticket.js";
import { createWindowsNativeHelperInvocation } from "./windows-native-helper-launcher.js";

const STOP_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;
const HELPER_READY_TIMEOUT_MS = 60_000;
const INSPECTION_TIMEOUT_MS = 5_000;
const WINDOWS_INSPECTION_SPAWN_ERROR_CODES = new Set([
  "EACCES", "E2BIG", "EMFILE", "ENFILE", "ENOENT", "ENOTDIR", "EPERM",
]);
const HELPER_PATH = fileURLToPath(new URL("../../../dist/native/windows-run-supervisor/ebb-run-supervisor.exe", import.meta.url));
export const WINDOWS_PATH_CHAIN_EVIDENCE_STAGES = [
  "FRAME_DECODED_EXPECTED", "SUPERVISOR_OPEN", "PRE_CREATE", "PRE_RESUME", "STOPPED_HELD",
] as const;
const EVIDENCE_FOOTER_PREFIX = Buffer.from("EBB_EVIDENCE_END_V1:", "ascii");
export type WindowsPathChainEvidenceStage = (typeof WINDOWS_PATH_CHAIN_EVIDENCE_STAGES)[number];
export interface WindowsPathChainEvidenceRecord {
  readonly stage: WindowsPathChainEvidenceStage;
  readonly commitment: string;
}
export interface WindowsPathChainEvidenceBinding {
  readonly containmentId: string;
  readonly runId: string;
  readonly launchNonce: string;
  readonly expectedDigests: Readonly<Record<WindowsPathChainEvidenceStage, string>>;
}

/** Acceptance-only parser for the bounded, post-STOPPED native identity proof. */
export class WindowsPathChainEvidenceParser {
  private readonly chunks: Buffer[] = [];
  private totalBytes = 0;
  private failed = false;
  private completedResult: { readonly records: readonly WindowsPathChainEvidenceRecord[]; readonly payloadOutput: string } | undefined;

  constructor(private readonly binding: WindowsPathChainEvidenceBinding) {
    if (!/^[a-f0-9]{64}$/u.test(binding.containmentId) || !/^[a-f0-9]{64}$/u.test(binding.launchNonce) ||
        !/^[A-Za-z0-9._-]{1,128}$/u.test(binding.runId) ||
        WINDOWS_PATH_CHAIN_EVIDENCE_STAGES.some((stage) => !/^[a-f0-9]{64}$/u.test(binding.expectedDigests[stage]))) {
      throw new Error("WINDOWS_PATH_CHAIN_EVIDENCE_EXPECTATION_INVALID");
    }
  }

  write(chunk: Uint8Array): void {
    if (this.failed || this.completedResult) throw new Error("WINDOWS_PATH_CHAIN_EVIDENCE_INVALID");
    this.totalBytes += chunk.byteLength;
    if (this.totalBytes > 10 * 1024 * 1024) this.reject();
    this.chunks.push(Buffer.from(chunk));
  }

  get result(): { readonly records: readonly WindowsPathChainEvidenceRecord[]; readonly payloadOutput: string } | undefined {
    return this.completedResult;
  }

  finish(): { readonly records: readonly WindowsPathChainEvidenceRecord[]; readonly payloadOutput: string } {
    if (this.failed || this.completedResult) throw new Error("WINDOWS_PATH_CHAIN_EVIDENCE_INVALID");
    const bytes = Buffer.concat(this.chunks, this.totalBytes);
    const footerSize = EVIDENCE_FOOTER_PREFIX.byteLength + 8;
    if (bytes.byteLength < footerSize) this.reject();
    const footerStart = bytes.byteLength - footerSize;
    const footer = bytes.subarray(footerStart);
    if (!footer.subarray(0, EVIDENCE_FOOTER_PREFIX.byteLength).equals(EVIDENCE_FOOTER_PREFIX) ||
        !/^[a-f0-9]{8}$/u.test(footer.subarray(EVIDENCE_FOOTER_PREFIX.byteLength).toString("ascii"))) this.reject();
    const recordBytes = Number.parseInt(footer.subarray(EVIDENCE_FOOTER_PREFIX.byteLength).toString("ascii"), 16);
    if (recordBytes < 1 || recordBytes > WINDOWS_PATH_CHAIN_EVIDENCE_STAGES.length * 512 || recordBytes > footerStart) this.reject();
    const evidenceStart = footerStart - recordBytes;
    const payload = bytes.subarray(0, evidenceStart);
    if (payload.includes(Buffer.from("EBB_EVIDENCE", "ascii"))) this.reject();

    const records: WindowsPathChainEvidenceRecord[] = [];
    const envelope = bytes.subarray(evidenceStart, footerStart);
    let lineStart = 0;
    for (let index = 0; index < envelope.byteLength; index += 1) {
      if (envelope[index] !== 0x0a) continue;
      records.push(parseEvidenceLine(envelope.subarray(lineStart, index), this.binding, records.length));
      if (records.length > WINDOWS_PATH_CHAIN_EVIDENCE_STAGES.length) this.reject();
      lineStart = index + 1;
    }
    if (lineStart !== envelope.byteLength || records.length !== WINDOWS_PATH_CHAIN_EVIDENCE_STAGES.length) this.reject();
    this.completedResult = {
      records,
      payloadOutput: payload.toString("utf8"),
    };
    return this.completedResult;
  }

  private reject(): never {
    this.failed = true;
    throw new Error("WINDOWS_PATH_CHAIN_EVIDENCE_INVALID");
  }
}

function parseEvidenceLine(
  line: Buffer,
  binding: WindowsPathChainEvidenceBinding,
  index: number,
): WindowsPathChainEvidenceRecord {
  if (line.byteLength > 512 || line.some((byte) => byte > 0x7f)) throw new Error("WINDOWS_PATH_CHAIN_EVIDENCE_INVALID");
  const fields = line.toString("ascii").split("\t");
  const stage = WINDOWS_PATH_CHAIN_EVIDENCE_STAGES[index];
  if (fields.length !== 7 || fields[0] !== "EBB_EVIDENCE" || fields[1] !== "V1" || !stage || fields[2] !== stage ||
      fields[3] !== binding.containmentId || fields[4] !== binding.runId || fields[5] !== binding.launchNonce ||
      fields[6] !== binding.expectedDigests[stage]) throw new Error("WINDOWS_PATH_CHAIN_EVIDENCE_INVALID");
  return { stage, commitment: fields[6] };
}
const HERMES_CHILD_ENV_KEYS = new Set([
  "HOMEDRIVE", "HOMEPATH", "SYSTEMROOT", "TEMP", "TMP", "PATH", "NODE_PATH", "NODE_ENV",
  "HOME", "HERMES_HOME", "HERMES_CONFIG", "HERMES_MODEL",
]);
interface LocalLaunchAttempt {
  session?: ProcessSession;
  completionSettled: boolean;
}
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
const SAFE_SNAPSHOT_TREE_DIAGNOSTIC_STAGES = new Set([
  "PATH_ENUMERATION", "ENTRY_SHAPE", "FILE_ATTRIBUTES", "FILE_OPEN", "FILE_LINK_COUNT",
  "FILE_SIZE", "FILE_DACL", "CONTENT_HASH", "CONTENT_MISMATCH", "ENUMERATION_END",
  "ENUMERATION_COMPLETENESS", "PROJECTION_ENTRY_COLLISION",
]);
const SAFE_NATIVE_HELPER_GATE_EXCEPTION_TYPES = new Set([
  "ArgumentException", "BadImageFormatException", "CryptographicException", "FileLoadException",
  "FileNotFoundException", "IOException", "InvalidOperationException", "MethodInvocationException",
  "NotSupportedException", "PathTooLongException", "PlatformNotSupportedException", "ReflectionTypeLoadException",
  "RuntimeException", "SecurityException", "SystemException", "TypeInitializationException", "TypeLoadException",
  "UnauthorizedAccessException", "Win32Exception",
]);

/** Закрытый протокол read-only фаз native Windows launch handshake. */
export const WINDOWS_PROCESS_SCOPE_LAUNCH_PHASES = [
  "WAITING_FOR_ACK",
  "ACK_ACCEPTED",
  "RESUME_API_ERROR",
  "RESUME_COUNT_ZERO",
  "RESUME_COUNT_ONE",
  "RESUME_COUNT_GREATER_THAN_ONE",
] as const;

/** Наблюдаемая фаза handshake; `UNAVAILABLE` означает, что exact native readback не подтверждён. */
export type WindowsProcessScopeLaunchPhase = (typeof WINDOWS_PROCESS_SCOPE_LAUNCH_PHASES)[number] | "UNAVAILABLE";

function launchKey(owner: ProcessScopeIdentity): string {
  return `${owner.containmentId}:${owner.launchNonce}`;
}

/** Reopens and controls only the private named Job associated with one Run owner. */
export class WindowsJobSupervisor implements ProcessScopeSupervisor {
  private acceptanceEvidenceUsed = false;
  private readonly pendingLaunches = new Set<string>();
  /** Keeps local attempt state so PREPARED cannot erase a spawn attempted by this supervisor. */
  private readonly launchAttempts = new Map<string, LocalLaunchAttempt>();
  private readonly launchAttemptNonces = new Map<string, string>();
  constructor(
    private readonly executor = new ProcessExecutor(),
    private readonly helperPath = HELPER_PATH,
    private readonly createHelperInvocation: typeof createWindowsNativeHelperInvocation = createWindowsNativeHelperInvocation,
    private readonly acceptanceEvidence?: { readonly binding: WindowsPathChainEvidenceBinding; readonly parser: WindowsPathChainEvidenceParser },
  ) {}

  async launch(
    owner: ProcessScopeIdentity,
    request: ProcessScopeLaunchRequest,
    persistVerifiedIdentity: (identity: ProcessScopeIdentity) => Promise<void>,
  ): Promise<ProcessScopeHandle> {
    assertWindowsOwner(owner);
    assertRequest(request);
    if (request.signal?.aborted) throw new ProcessScopeLaunchNotDispatchedError();
    const launchIdentity = consumeLaunchIdentity(owner, request);
    if (this.acceptanceEvidence && (this.acceptanceEvidenceUsed || !launchIdentity || request.onStdoutChunk || request.captureOutput === false ||
        this.acceptanceEvidence.binding.containmentId !== owner.containmentId ||
        this.acceptanceEvidence.binding.launchNonce !== owner.launchNonce ||
        this.acceptanceEvidence.binding.runId !== owner.runId || launchIdentity.runId !== owner.runId)) {
      throw new Error("WINDOWS_PATH_CHAIN_EVIDENCE_ACCEPTANCE_BINDING_INVALID");
    }
    if (this.acceptanceEvidence) this.acceptanceEvidenceUsed = true;
    const diagnosticTrace = process.env.EBB_WINDOWS_NATIVE_HANDSHAKE_TRACE === "1"
      ? new NativeHelperHandshakeTrace()
      : undefined;
    const helperInvocation = await this.createHelperInvocation(this.helperPath, "windowsRunSupervisor", [
      this.acceptanceEvidence ? "launch-evidence" : "launch", owner.containmentId, owner.launchNonce,
    ]);
    diagnosticTrace?.mark("INVOCATION");
    if (request.signal?.aborted) throw new ProcessScopeLaunchNotDispatchedError();
    const metadataFrame = encodeMetadataFrame(request, launchIdentity);
    const key = launchKey(owner);
    if (this.launchAttempts.has(key) || this.launchAttemptNonces.has(owner.containmentId)) {
      throw new Error("WINDOWS_PROCESS_SCOPE_LAUNCH_ATTEMPT_ALREADY_RECORDED");
    }
    const attempt: LocalLaunchAttempt = { completionSettled: false };
    this.launchAttempts.set(key, attempt);
    this.launchAttemptNonces.set(owner.containmentId, owner.launchNonce);
    this.pendingLaunches.add(key);
    // Keep the attempt markers if startSession throws: without a ProcessSession there is no
    // completion signal, so later observations must fail closed for this owner.
    const session = this.executor.startSession(helperInvocation.file, [...helperInvocation.args], {
      cwd: request.cwd,
      env: { ...helperInvocation.env },
      timeout: 0,
      maxBuffer: 10 * 1024 * 1024,
      captureOutput: request.captureOutput ?? true,
    });
    attempt.session = session;
    let identity: ProcessScopeIdentity | undefined;
    let stopPromise: Promise<ProcessScopeObservation> | undefined;
    const terminalFailureCapture = new NativeHelperTerminalFailureCapture();
    session.stderr.on("data", (chunk: Buffer | string) => terminalFailureCapture.write(chunk));
    session.stdout.on("data", (chunk: Buffer | string) => diagnosticTrace?.observeStdout(chunk));
    session.stderr.on("data", () => diagnosticTrace?.markStderrByte());
    session.stdout.on("end", () => diagnosticTrace?.mark("OUT_END"));
    session.stderr.on("end", () => diagnosticTrace?.mark("ERR_END"));
    diagnosticTrace?.mark("SESSION");
    let sessionSettled = false;
    void session.completion.then(
      () => { sessionSettled = true; attempt.completionSettled = true; },
      () => { sessionSettled = true; attempt.completionSettled = true; },
    );
    const requestStop = () => {
      if (!stopPromise) stopPromise = this.stop(identity ?? owner);
      return stopPromise;
    };
    const protocol = new HelperProtocol(session.stdout, request.onStdoutChunk, () => {
      void requestStop().catch(() => undefined);
    });
    const onAbort = () => {
      session.stdin.destroy();
      if (identity) void requestStop().catch(() => undefined);
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });
    let helperReady = false;
    try {
      await protocol.nextLine("EBB_HELPER_READY", HELPER_READY_TIMEOUT_MS);
      helperReady = true;
      diagnosticTrace?.mark("READY");
      // The PowerShell gate fails before READY. After the trusted helper handoff, stderr belongs
      // to the child payload and must never be considered a gate diagnostic.
      terminalFailureCapture.stop();
      if (request.signal?.aborted) throw new Error("WINDOWS_PROCESS_SCOPE_LAUNCH_CANCELLED");
      session.stdin.write(metadataFrame);
      identity = parseLiveIdentity(await protocol.nextLine("EBB_SCOPE_READY", 10_000), owner);
      diagnosticTrace?.mark("SCOPE");
      await persistVerifiedIdentity(identity);
      // ResumeThread is gated by a fixed nonce-bound ACK frame. Recheck the signal
      // after the asynchronous durable callback and before sending the frame.
      if (request.signal?.aborted) throw new Error("WINDOWS_PROCESS_SCOPE_LAUNCH_CANCELLED");
      protocol.beginPayload();
      session.stdin.write(encodeLaunchAcknowledgement(owner.launchNonce));
      this.pendingLaunches.delete(key);
    } catch (error) {
      diagnosticTrace?.mark("TIMEOUT");
      session.stdin.destroy();
      // Closing the protocol channel makes the suspended native helper reject the
      // launch ACK. Keep the pending marker until that exact helper has exited.
      const completed = await session.completion.then((result) => result, () => undefined);
      diagnosticTrace?.mark("SETTLED");
      request.signal?.removeEventListener("abort", onAbort);
      const stopOwner = identity ?? owner;
      let final: ProcessScopeObservation;
      try {
        const observed = await this.waitForStopped(stopOwner, STOP_TIMEOUT_MS);
        const stopped = observed.state === "STOPPED" ? observed : await this.stop(stopOwner);
        final = stopped.state === "STOPPED" ? stopped : await this.waitForStopped(stopOwner, STOP_TIMEOUT_MS);
      } finally {
        // Preserve the pending marker until the exact session is settled and the native
        // nonce-bound absence readback has completed (or failed closed).
        this.pendingLaunches.delete(key);
      }
      const nativeGateDiagnostic = error instanceof Error && error.message.startsWith("WINDOWS_HELPER_HANDSHAKE_TIMEOUT:")
        ? formatNativeHelperTerminalDiagnostic(
          terminalFailureCapture.failure,
          completed?.exitCode,
          helperReady,
          diagnosticTrace?.format(sessionSettled),
        )
        : undefined;
      if (final.state !== "STOPPED") {
        const reason = final.state === "UNKNOWN" ? final.reason : "WINDOWS_JOB_STOP_NOT_CONFIRMED";
        // Keep the caught failure as the direct cause; replace its generic timeout with safe terminal facts.
        if (nativeGateDiagnostic && error instanceof Error) error.message = nativeGateDiagnostic;
        throw new Error(`WINDOWS_PROCESS_SCOPE_LAUNCH_UNPROVEN:${reason}`, { cause: error });
      }
      // Retain the immutable local attempt binding after a rejected launch. Callers may
      // need a later fresh STOP inspection before tearing down their owned fixture.
      if (nativeGateDiagnostic) throw new Error(nativeGateDiagnostic, { cause: error });
      throw error;
    }

    const verifiedIdentity = identity;
    if (!verifiedIdentity) throw new Error("WINDOWS_PROCESS_SCOPE_LIVE_IDENTITY_MISSING");
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; void requestStop(); }, request.timeoutMs);
    const completion = session.completion.then(async (result) => {
      await protocol.drainPayload();
      const stopped = await this.waitForStopped(verifiedIdentity, STOP_TIMEOUT_MS);
      if (stopped.state !== "STOPPED") throw new Error("WINDOWS_PROCESS_SCOPE_STOP_UNPROVEN");
      this.launchAttempts.delete(launchKey(verifiedIdentity));
      this.launchAttemptNonces.delete(verifiedIdentity.containmentId);
      if (timedOut) throw new Error("WINDOWS_PROCESS_SCOPE_TIMEOUT");
      let stripped = stripHelperProtocol(result);
      if (this.acceptanceEvidence) {
        this.acceptanceEvidence.parser.write(Buffer.from(stripped.stdout, "utf8"));
        const evidence = this.acceptanceEvidence.parser.finish();
        stripped = { ...stripped, stdout: evidence.payloadOutput };
      }
      return request.captureOutput === false ? { ...stripped, stdout: "", stderr: "" } : stripped;
    }).catch(async (error: unknown) => {
      await protocol.drainPayload().catch(() => undefined);
      const stopped = await requestStop().catch(() => ({ state: "UNKNOWN" as const, reason: "WINDOWS_JOB_STOP_FAILED" }));
      if (stopped.state !== "STOPPED") throw new Error("WINDOWS_PROCESS_SCOPE_STOP_UNPROVEN");
      this.launchAttempts.delete(launchKey(verifiedIdentity));
      this.launchAttemptNonces.delete(verifiedIdentity.containmentId);
      throw error;
    }).finally(() => {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onAbort);
    });
    return { completion };
  }

  async inspect(owner: ProcessScopeIdentity): Promise<ProcessScopeObservation> {
    assertWindowsOwner(owner);
    const attemptedNonce = this.launchAttemptNonces.get(owner.containmentId);
    if (attemptedNonce && attemptedNonce !== owner.launchNonce) {
      return { state: "UNKNOWN", reason: "WINDOWS_ATTEMPT_NONCE_MISMATCH" };
    }
    let invocation: Awaited<ReturnType<typeof createWindowsNativeHelperInvocation>>;
    try {
      invocation = await this.createHelperInvocation(this.helperPath, "windowsRunSupervisor", [
        "inspect",
        owner.containmentId,
        owner.launchNonce,
        owner.state,
        owner.supervisorPid?.toString() ?? "-",
        owner.supervisorStartIdentity ?? "-",
        this.pendingLaunches.has(launchKey(owner)) && !this.launchAttempts.get(launchKey(owner))?.completionSettled ? "1" : "0",
        this.launchAttempts.get(launchKey(owner))?.session && this.launchAttempts.get(launchKey(owner))?.completionSettled ? "1" : "0",
      ]);
    } catch {
      return { state: "UNKNOWN", reason: "WINDOWS_JOB_INSPECTION_HELPER_INVOCATION_UNAVAILABLE" };
    }

    let result: ProcessResult;
    try {
      result = await this.executor.exec(invocation.file, [...invocation.args], {
        env: { ...invocation.env }, timeout: INSPECTION_TIMEOUT_MS, maxBuffer: 32 * 1024,
      });
    } catch (error) {
      return { state: "UNKNOWN", reason: classifyInspectionExecutionFailure(error) };
    }

    let observation: ProcessScopeObservation;
    try {
      observation = parseInspection(result.stdout, owner);
    } catch {
      return { state: "UNKNOWN", reason: "WINDOWS_JOB_INSPECTION_OUTPUT_PARSE_FAILED" };
    }

    const attempt = this.launchAttempts.get(launchKey(owner));
    if (attempt && observation.state === "LIVE" &&
        (this.pendingLaunches.has(launchKey(owner)) || !attempt.session || attempt.completionSettled)) {
      return { state: "UNKNOWN", reason: "WINDOWS_ATTEMPT_JOB_STILL_LIVE" };
    }
    if (attempt && observation.state === "STOPPED") {
      if (observation.evidence === "WINDOWS_ATTEMPT_SCOPE_ABSENT") {
        if (!attempt.session || !attempt.completionSettled || !isExactJobAbsentAttemptSettled(result.stdout)) {
          return { state: "UNKNOWN", reason: "WINDOWS_ATTEMPT_ABSENCE_EVIDENCE_MALFORMED" };
        }
      } else if (observation.evidence === "NEVER_LAUNCHED") {
        return { state: "UNKNOWN", reason: "WINDOWS_ATTEMPT_NEVER_LAUNCHED_CONFLICT" };
      } else if (!attempt.session || !attempt.completionSettled) {
        // JOB_EMPTY and helper-absent responses describe the native Job only. They do not
        // prove that this exact launcher ProcessSession has settled after a spawn attempt.
        return { state: "UNKNOWN", reason: "WINDOWS_ATTEMPT_SESSION_PENDING" };
      }
    }
    return observation;
  }

  /** Читает только nonce-связанную фазу handshake; невозможность точного readback даёт `UNAVAILABLE`. */
  async inspectLaunchPhase(owner: ProcessScopeIdentity): Promise<WindowsProcessScopeLaunchPhase> {
    assertWindowsOwner(owner);
    try {
      const invocation = await this.createHelperInvocation(this.helperPath, "windowsRunSupervisor", [
        "phase", owner.containmentId, owner.launchNonce,
      ]);
      const result = await this.executor.exec(invocation.file, [...invocation.args], {
        env: { ...invocation.env }, timeout: 5_000, maxBuffer: 4_096,
      });
      return parseWindowsProcessScopeLaunchPhase(result.stdout);
    } catch {
      return "UNAVAILABLE";
    }
  }

  async stop(owner: ProcessScopeIdentity): Promise<ProcessScopeObservation> {
    assertWindowsOwner(owner);
    const before = await this.inspect(owner);
    if (before.state !== "LIVE") return before;
    try {
      const stopInvocation = await this.createHelperInvocation(this.helperPath, "windowsRunSupervisor", [
        "stop", owner.containmentId, owner.launchNonce,
      ]);
      await this.executor.exec(stopInvocation.file, [...stopInvocation.args], {
        env: { ...stopInvocation.env }, timeout: STOP_TIMEOUT_MS, maxBuffer: 32 * 1024,
      });
    } catch {
      return await this.waitForStopped(before.identity, STOP_TIMEOUT_MS);
    }
    return this.waitForStopped(before.identity, STOP_TIMEOUT_MS);
  }

  async waitForStopped(owner: ProcessScopeIdentity, timeoutMs = STOP_TIMEOUT_MS): Promise<ProcessScopeObservation> {
    const deadline = Date.now() + timeoutMs;
    do {
      const result = await this.inspect(owner);
      if (result.state === "STOPPED" || result.state === "UNKNOWN") return result;
      if (Date.now() + POLL_INTERVAL_MS > deadline) break;
      await delay(POLL_INTERVAL_MS);
    } while (Date.now() <= deadline);
    return { state: "UNKNOWN", reason: "WINDOWS_JOB_STOP_TIMEOUT" };
  }
}

function classifyInspectionExecutionFailure(error: unknown): string {
  if (error instanceof ExitCodeError) {
    for (const line of error.stderr.split(/\r?\n/u)) {
      const gateFailure = parseNativeHelperFailureLine(line);
      if (gateFailure) {
        const gateReason = mapInspectionGateFailurePhase(gateFailure.phase);
        if (gateReason) return gateReason;
      }
    }
    if (error.stdout.split(/\r?\n/u).some((line) => {
      const match = /^UNKNOWN\t([A-Z0-9_]+)$/u.exec(line);
      return match !== null && SAFE_NATIVE_HELPER_FAILURE_CODES.has(match[1]!);
    })) return "WINDOWS_JOB_INSPECTION_NATIVE_REFUSAL";
    if (error.exitCode === 127) return "WINDOWS_JOB_INSPECTION_HELPER_INTEGRITY_MISMATCH";
    return "WINDOWS_JOB_INSPECTION_PROCESS_EXIT_NONZERO";
  }
  if (error instanceof Error) {
    if (error.message === `Process timed out after ${INSPECTION_TIMEOUT_MS}ms`) {
      return "WINDOWS_JOB_INSPECTION_PROCESS_TIMEOUT";
    }
    if (error.message === "output buffer exceeded") return "WINDOWS_JOB_INSPECTION_OUTPUT_LIMIT";
    if (error.message === "Process aborted before spawn" || error.message === "Process aborted" || error.name === "AbortError") {
      return "WINDOWS_JOB_INSPECTION_PROCESS_ABORTED";
    }
    if ("code" in error && typeof error.code === "string" && WINDOWS_INSPECTION_SPAWN_ERROR_CODES.has(error.code)) {
      return "WINDOWS_JOB_INSPECTION_PROCESS_SPAWN_FAILED";
    }
  }
  return "WINDOWS_JOB_INSPECTION_PROCESS_EXECUTION_UNAVAILABLE";
}

function mapInspectionGateFailurePhase(phase: string): string | undefined {
  if (phase.startsWith("ARGUMENT_")) return "WINDOWS_JOB_INSPECTION_HELPER_ARGUMENT_GATE_FAILED";
  if (phase === "PATH_NORMALIZATION" || phase.startsWith("PARENT_DIRECTORY_")) {
    return "WINDOWS_JOB_INSPECTION_HELPER_PATH_GATE_FAILED";
  }
  if (phase.startsWith("HELPER_FILE_")) return "WINDOWS_JOB_INSPECTION_HELPER_FILE_GATE_FAILED";
  if (phase === "INTEGRITY_CHECK") return "WINDOWS_JOB_INSPECTION_HELPER_INTEGRITY_GATE_FAILED";
  if (phase === "PROCESS_START") return "WINDOWS_JOB_INSPECTION_HELPER_PROCESS_START_GATE_FAILED";
  if (phase.startsWith("LAUNCH_")) return "WINDOWS_JOB_INSPECTION_NATIVE_LAUNCH_FAILED";
  return undefined;
}

function encodeLaunchAcknowledgement(nonce: string): Buffer {
  if (!/^[a-f0-9]{64}$/.test(nonce)) throw new Error("WINDOWS_LAUNCH_NONCE_INVALID");
  return Buffer.from(`EBBACK01${nonce}`, "ascii");
}

/** Разбирает только единственную строку phase protocol и закрытый набор native stages. */
export function parseWindowsProcessScopeLaunchPhase(output: string): WindowsProcessScopeLaunchPhase {
  const line = output.replace(/\r?\n$/u, "");
  if (line.includes("\n") || line.includes("\r")) return "UNAVAILABLE";
  const fields = line.split("\t");
  if (fields.length !== 2 || fields[0] !== "PHASE") return "UNAVAILABLE";
  return WINDOWS_PROCESS_SCOPE_LAUNCH_PHASES.includes(fields[1] as (typeof WINDOWS_PROCESS_SCOPE_LAUNCH_PHASES)[number])
    ? fields[1] as (typeof WINDOWS_PROCESS_SCOPE_LAUNCH_PHASES)[number]
    : "UNAVAILABLE";
}

function assertWindowsOwner(owner: ProcessScopeIdentity): void {
  if (process.platform !== "win32" || owner.containmentKind !== "windows-job" ||
      !/^[a-f0-9]{64}$/.test(owner.containmentId) || !/^[a-f0-9]{64}$/.test(owner.launchNonce)) {
    throw new Error("WINDOWS_PROCESS_SCOPE_UNSUPPORTED");
  }
}

function assertRequest(request: ProcessScopeLaunchRequest): void {
  if (!request.executable || !request.cwd || !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0) {
    throw new TypeError("Invalid Windows process-scope launch request.");
  }
  for (const [key, value] of Object.entries(request.environment)) {
    if (!HERMES_CHILD_ENV_KEYS.has(key) || isCredentialEnvironmentKey(key) || !/^[A-Z_][A-Z0-9_]*$/.test(key) || /[\0\r\n]/.test(value)) {
      throw new Error("PROCESS_SCOPE_ENVIRONMENT_REJECTED");
    }
  }
}

function isCredentialEnvironmentKey(key: string): boolean {
  return /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API[_-]?KEY)/i.test(key);
}

function encodeMetadataFrame(request: ProcessScopeLaunchRequest, launchIdentity?: HermesLaunchTicketInput): Buffer {
  const strings = [request.executable, request.cwd, ...request.args];
  const pairs = Object.entries(request.environment);
  if (strings.length > 512 || pairs.length > 128) throw new TypeError("Windows process-scope metadata exceeds its bound.");
  const pieces: Buffer[] = [];
  const addU32 = (value: number) => { const bytes = Buffer.allocUnsafe(4); bytes.writeUInt32BE(value); pieces.push(bytes); };
  const addString = (value: string) => {
    const bytes = Buffer.from(value, "utf8");
    if (bytes.byteLength > 16_384 || value.includes("\0")) throw new TypeError("Windows process-scope field exceeds its bound.");
    addU32(bytes.byteLength);
    pieces.push(bytes);
  };
  addU32(0x45424233);
  const frameLengthOffset = pieces.reduce((length, piece) => length + piece.byteLength, 0);
  addU32(0);
  addU32(request.args.length);
  addU32(pairs.length);
  addString(request.executable);
  addString(request.cwd);
  for (const arg of request.args) addString(arg);
  for (const [key, value] of pairs) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new TypeError("Invalid process-scope environment name.");
    addString(key);
    addString(value);
  }
  addU32(launchIdentity ? 1 : 0);
  if (launchIdentity) {
    addString(launchIdentity.profileHome);
    addString(launchIdentity.hermesExecutablePath);
    addIdentity(launchIdentity.hermesExecutableIdentity);
    addIdentity(launchIdentity.executableIdentity);
    addIdentity(launchIdentity.profileHomeIdentity);
    const profileHomeTargetIdentities = launchIdentity.profileHomeTargetIdentities;
    if (!profileHomeTargetIdentities) throw new Error("WINDOWS_HERMES_PROFILE_TARGET_IDENTITIES_REQUIRED");
    addIdentity(profileHomeTargetIdentities.home);
    addIdentity(profileHomeTargetIdentities.config);
    addString(launchIdentity.runId);
    const profileHomePathChain = launchIdentity.profileHomePathChain;
    if (!profileHomePathChain) throw new Error("WINDOWS_HERMES_PROFILE_PATH_CHAIN_REQUIRED");
    addU32(profileHomePathChain.version);
    addU32(profileHomePathChain.authRootIndex);
    addU32(profileHomePathChain.components.length);
    for (const component of profileHomePathChain.components) {
      addString(component.volumeSerial);
      addString(component.fileId);
    }
    addString(launchIdentity.hermesSourceSnapshotKey);
    addString(launchIdentity.hermesSourceSnapshotRoot);
    addIdentity(launchIdentity.hermesSourceSnapshotRootIdentity);
    addString(launchIdentity.hermesSourceManifestDigest);
    addString(launchIdentity.hermesSourceProjectionPath);
    addString(launchIdentity.hermesSourceProjectionSha256);
    addU32(launchIdentity.hermesSourceProjectionSize);
  }
  const result = Buffer.concat(pieces);
  if (result.byteLength > 256 * 1024) throw new TypeError("Windows process-scope metadata exceeds 256 KiB.");
  result.writeUInt32BE(result.byteLength, frameLengthOffset);
  return result;

  function addIdentity(identity: HermesLaunchObjectIdentity): void {
    if (identity.platform !== "win32") throw new Error("WINDOWS_HERMES_LAUNCH_IDENTITY_REQUIRED");
    addString(identity.volumeSerial);
    addString(identity.fileId);
  }
}

function consumeLaunchIdentity(
  owner: ProcessScopeIdentity,
  request: ProcessScopeLaunchRequest,
): HermesLaunchTicketInput | undefined {
  const requiresTicket = isHermesExecutable(request.executable);
  if (!requiresTicket && !request.hermesLaunchTicket) return undefined;
  const identity = consumeHermesLaunchTicket(request.hermesLaunchTicket, {
    runId: owner.runId,
    attempt: request.attempt === undefined ? -1 : request.attempt,
    executable: request.executable,
    args: request.args,
    environment: request.environment,
  });
  if (identity.platform !== "win32") throw new Error("WINDOWS_HERMES_LAUNCH_PLATFORM_MISMATCH");
  return identity;
}

function isHermesExecutable(executable: string): boolean {
  const name = executable.split(/[\\/]/u).at(-1)?.toLocaleLowerCase("en-US");
  return name === "hermes" || name === "hermes.exe";
}

function parseLiveIdentity(line: string, owner: ProcessScopeIdentity): ProcessScopeIdentity {
  const fields = line.split("\t");
  if (fields.length !== 8 || fields[0] !== "EBB_SCOPE_READY" || fields[1] !== owner.containmentId || fields[2] !== owner.launchNonce) {
    throw new Error("WINDOWS_JOB_IDENTITY_MISMATCH");
  }
  const supervisorPid = parsePid(fields[3]);
  const supervisorStartIdentity = fields[4]!;
  const pid = parsePid(fields[5]);
  const processStartIdentity = fields[6]!;
  const executableIdentity = fields[7]!;
  if (!supervisorPid || !pid || !supervisorStartIdentity || !processStartIdentity || !/^sha256:[a-f0-9]{64}$/.test(executableIdentity)) {
    throw new Error("WINDOWS_JOB_IDENTITY_INVALID");
  }
  return {
    ...owner,
    supervisorPid,
    supervisorStartIdentity,
    pid,
    platform: "win32",
    processStartIdentity,
    executableIdentity,
    state: "LIVE",
  };
}

function parseInspection(output: string, owner: ProcessScopeIdentity): ProcessScopeObservation {
  const line = output.trim().split(/\r?\n/)[0] ?? "";
  const fields = line.split("\t");
  if (fields[0] === "STOPPED" && fields[1] === "JOB_EMPTY") return { state: "STOPPED", evidence: "WINDOWS_JOB_EMPTY" };
  if (fields[0] === "STOPPED" && fields[1] === "OWNER_NEVER_LAUNCHED") return { state: "STOPPED", evidence: "NEVER_LAUNCHED" };
  if (fields[0] === "STOPPED" && fields[1] === "JOB_ABSENT_ATTEMPT_SETTLED") {
    return { state: "STOPPED", evidence: "WINDOWS_ATTEMPT_SCOPE_ABSENT" };
  }
  if (fields[0] === "STOPPED" && fields[1] === "JOB_ABSENT_NO_HELPER") {
    return { state: "STOPPED", evidence: "WINDOWS_JOB_AND_HELPER_ABSENT" };
  }
  if (fields[0] === "UNKNOWN" && fields.length === 2 && /^[A-Z0-9_]+$/.test(fields[1] ?? "")) {
    return { state: "UNKNOWN", reason: `WINDOWS_${fields[1]}` };
  }
  if (fields[0] === "LIVE" && fields[1] === owner.containmentId && fields[2] === owner.launchNonce) {
    const identity = parseLiveIdentity(`EBB_SCOPE_READY\t${fields.slice(1).join("\t")}`, owner);
    if ((owner.supervisorPid !== null && owner.supervisorPid !== identity.supervisorPid) ||
        (owner.supervisorStartIdentity !== null && owner.supervisorStartIdentity !== identity.supervisorStartIdentity) ||
        (owner.pid !== null && owner.pid !== identity.pid) ||
        (owner.processStartIdentity !== null && owner.processStartIdentity !== identity.processStartIdentity) ||
        (owner.executableIdentity !== null && owner.executableIdentity !== identity.executableIdentity)) {
      return { state: "UNKNOWN", reason: "WINDOWS_JOB_IDENTITY_MISMATCH" };
    }
    return { state: "LIVE", identity };
  }
  return { state: "UNKNOWN", reason: "WINDOWS_JOB_IDENTITY_UNPROVEN" };
}

function isExactJobAbsentAttemptSettled(output: string): boolean {
  return /^STOPPED\tJOB_ABSENT_ATTEMPT_SETTLED\r?\n?$/u.test(output);
}

function parsePid(value: string | undefined): number | null {
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const pid = Number(value);
  return Number.isSafeInteger(pid) ? pid : null;
}

function stripHelperProtocol(result: ProcessResult): ProcessResult {
  return {
    ...result,
    stdout: result.stdout.replace(/^EBB_HELPER_READY\r?\n/, "").replace(/^EBB_SCOPE_READY\t[^\r\n]*\r?\n/, ""),
  };
}

interface NativeHelperTerminalFailure {
  readonly phase: string;
  readonly exceptionType: string;
}

type NativeHelperTraceStage = "INVOCATION" | "SESSION" | "OUT" | "ERR" | "READY" | "SCOPE" | "TIMEOUT" | "SETTLED" | "OUT_END" | "ERR_END";
type NativeHelperStdoutCode = "NONE" | "PARTIAL" | "UNRECOGNIZED" | "OVERSIZED" | "READY" | "SCOPE" | `UNKNOWN_${string}`;

/** Keeps only fixed timing stages and an allowlisted first stdout marker for native acceptance diagnostics. */
class NativeHelperHandshakeTrace {
  private static readonly MAX_FIRST_LINE_BYTES = 256;
  private static readonly MAX_ELAPSED_MS = 60_000;
  private readonly startedAt = Date.now();
  private readonly stageTimes = new Map<NativeHelperTraceStage, number>();
  private firstLine: number[] = [];
  private firstLineComplete = false;
  private firstLineOverflowed = false;
  private stdoutCode: NativeHelperStdoutCode = "NONE";
  private stdoutByteSeen = false;
  private stderrByteSeen = false;

  mark(stage: NativeHelperTraceStage): void {
    if (!this.stageTimes.has(stage)) {
      this.stageTimes.set(stage, Math.min(NativeHelperHandshakeTrace.MAX_ELAPSED_MS, Math.max(0, Date.now() - this.startedAt)));
    }
  }

  observeStdout(chunk: Buffer | string): void {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    if (bytes.byteLength > 0 && !this.stdoutByteSeen) {
      this.stdoutByteSeen = true;
      this.mark("OUT");
    }
    if (this.firstLineComplete) return;
    for (const byte of bytes) {
      if (byte === 0x0a) {
        this.firstLineComplete = true;
        this.classifyFirstLine();
        return;
      }
      if (this.firstLine.length >= NativeHelperHandshakeTrace.MAX_FIRST_LINE_BYTES) {
        this.firstLineOverflowed = true;
        this.firstLine = [];
        this.firstLineComplete = true;
        this.stdoutCode = "OVERSIZED";
        return;
      }
      this.firstLine.push(byte);
    }
  }

  markStderrByte(): void {
    if (this.stderrByteSeen) return;
    this.stderrByteSeen = true;
    this.mark("ERR");
  }

  format(sessionSettled: boolean): string {
    const stages = [...this.stageTimes.entries()]
      .sort((left, right) => left[1] - right[1])
      .map(([stage, elapsed]) => `${stage}@${elapsed}`)
      .join(",") || "NONE";
    const stdoutCode = this.firstLineComplete
      ? this.stdoutCode
      : this.firstLine.length > 0 ? "PARTIAL" : "NONE";
    return [
      `STAGES=${stages}`,
      `OUTCODE=${stdoutCode}`,
      `OUTB=${this.stdoutByteSeen ? 1 : 0}`,
      `ERRB=${this.stderrByteSeen ? 1 : 0}`,
      `DONE=${sessionSettled ? 1 : 0}`,
      `OUTEND=${this.stageTimes.has("OUT_END") ? 1 : 0}`,
      `ERREND=${this.stageTimes.has("ERR_END") ? 1 : 0}`,
    ].join(":");
  }

  private classifyFirstLine(): void {
    if (this.firstLineOverflowed) {
      this.stdoutCode = "OVERSIZED";
      return;
    }
    if (this.firstLine.some((byte) => byte > 0x7f)) {
      this.stdoutCode = "UNRECOGNIZED";
      this.firstLine = [];
      return;
    }
    const line = Buffer.from(this.firstLine).toString("ascii").replace(/\r$/u, "");
    this.firstLine = [];
    if (line === "EBB_HELPER_READY") {
      this.stdoutCode = "READY";
      return;
    }
    if (line.startsWith("EBB_SCOPE_READY\t") && line.split("\t").length === 8) {
      this.stdoutCode = "SCOPE";
      return;
    }
    const unknown = /^UNKNOWN\t([A-Z0-9_]+)$/u.exec(line);
    if (unknown && SAFE_NATIVE_HELPER_FAILURE_CODES.has(unknown[1]!)) {
      this.stdoutCode = `UNKNOWN_${unknown[1]}`;
      return;
    }
    this.stdoutCode = "UNRECOGNIZED";
  }
}

class NativeHelperTerminalFailureCapture {
  private line = "";
  private lineOverflowed = false;
  private accepting = true;
  private parsedFailure: NativeHelperTerminalFailure | undefined;
  private static readonly MAX_LINE_CHARACTERS = 192;

  get failure(): NativeHelperTerminalFailure | undefined {
    return this.parsedFailure;
  }

  stop(): void {
    this.accepting = false;
    this.line = "";
    this.lineOverflowed = false;
  }

  /** Keeps only the recognized normalized marker, never retaining raw stderr after each line. */
  write(chunk: Buffer | string): void {
    if (!this.accepting) return;
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (const character of text) {
      if (character === "\n") {
        if (!this.lineOverflowed) {
          const parsed = parseNativeHelperFailureLine(this.line.replace(/\r$/u, ""));
          if (parsed) this.parsedFailure = parsed;
        }
        this.line = "";
        this.lineOverflowed = false;
        continue;
      }
      if (this.lineOverflowed) continue;
      if (this.line.length >= NativeHelperTerminalFailureCapture.MAX_LINE_CHARACTERS) {
        this.line = "";
        this.lineOverflowed = true;
        continue;
      }
      this.line += character;
    }
  }
}

function parseNativeHelperFailureLine(line: string): NativeHelperTerminalFailure | undefined {
  const match = /^NATIVE_HELPER_GATE_FAIL:([^:\r\n]+):([A-Za-z][A-Za-z0-9]*)$/u.exec(line);
  if (match && SAFE_NATIVE_HELPER_GATE_EXCEPTION_TYPES.has(match[2]!)) {
    const phase = normalizeNativeHelperGatePhase(match[1]!);
    return phase ? { phase, exceptionType: normalizeNativeHelperGateExceptionType(match[2]!) } : undefined;
  }

  const launchFailure = /^NATIVE_HELPER_LAUNCH_FAIL:([A-Z0-9_]+)$/u.exec(line);
  if (!launchFailure) return undefined;
  const code = launchFailure[1]!;
  if (!Object.prototype.hasOwnProperty.call(SAFE_NATIVE_HELPER_LAUNCH_FAILURE_PHASES, code)) return undefined;
  const phase = SAFE_NATIVE_HELPER_LAUNCH_FAILURE_PHASES[code];
  return phase ? { phase, exceptionType: "NATIVE_LAUNCH_FAILURE" } : undefined;
}

const SAFE_NATIVE_HELPER_LAUNCH_FAILURE_PHASES: Readonly<Record<string, string>> = Object.freeze({
  JOB_CREATE_FAILED_OR_EXISTS: "LAUNCH_JOB_CREATE",
  JOB_POLICY_FAILED: "LAUNCH_JOB_POLICY",
  MAPPING_CREATE_FAILED_OR_EXISTS: "LAUNCH_MAPPING_CREATE",
  HELPER_READY_WRITE_FAILED: "LAUNCH_READY_WRITE",
});

function formatNativeHelperTerminalDiagnostic(
  gateFailure: NativeHelperTerminalFailure | undefined,
  exitCode: number | undefined,
  helperReady: boolean,
  trace?: string,
): string {
  const safeExit = typeof exitCode === "number" && Number.isSafeInteger(exitCode) && exitCode >= 0 && exitCode <= 255
    ? `EXIT_${exitCode}`
    : "EXIT_UNAVAILABLE";
  const fields = [
    "WINDOWS_NATIVE_HELPER_DIAGNOSTIC",
    `PHASE_${gateFailure?.phase ?? "UNCLASSIFIED"}`,
    `TYPE_${gateFailure?.exceptionType ?? "UNCLASSIFIED"}`,
    safeExit,
    helperReady ? "READY_PRESENT" : "READY_ABSENT",
  ];
  if (trace) fields.push(trace);
  return fields.join(":");
}

function normalizeNativeHelperGateExceptionType(exceptionType: string): string {
  return exceptionType.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toUpperCase();
}

function normalizeNativeHelperGatePhase(phase: string): string | undefined {
  const fixedPhases: Record<string, string> = {
    "argument-decode": "ARGUMENT_DECODE",
    "argument-json": "ARGUMENT_JSON",
    "argument-validation": "ARGUMENT_VALIDATION",
    "argument-type": "ARGUMENT_TYPE",
    "argument-nul": "ARGUMENT_NUL",
    "path-normalization": "PATH_NORMALIZATION",
    "parent-directory-lock": "PARENT_DIRECTORY_LOCK",
    "helper-file-lock": "HELPER_FILE_LOCK",
    "integrity-check": "INTEGRITY_CHECK",
    "process-start": "PROCESS_START",
  };
  const fixed = Object.prototype.hasOwnProperty.call(fixedPhases, phase) ? fixedPhases[phase] : undefined;
  if (fixed) return fixed;
  if (/^parent-directory-open-index-\d+-win32-\d+$/u.test(phase)) return "PARENT_DIRECTORY_OPEN";
  if (/^parent-directory-check-win32-\d+$/u.test(phase)) return "PARENT_DIRECTORY_CHECK";
  if (/^helper-file-open-win32-\d+$/u.test(phase)) return "HELPER_FILE_OPEN";
  return undefined;
}

class HelperProtocol {
  private buffered = Buffer.alloc(0);
  private payloadStarted = false;
  private payloadFailure: "CALLBACK" | "STREAM" | undefined;
  private payloadTransportFailureQueued = false;
  private payloadCallbacks = Promise.resolve();
  private readonly waiters: Array<{ prefix: string; resolve: (line: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];

  constructor(
    stream: NodeJS.ReadableStream,
    private readonly onStdoutChunk?: (chunk: Uint8Array) => Promise<void>,
    private readonly onPayloadError?: () => void,
  ) {
    stream.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.from(chunk);
      if (this.payloadStarted) {
        const acceptedBeforeTransportFailure = !this.payloadTransportFailureQueued;
        this.payloadCallbacks = this.payloadCallbacks.then(async () => {
          if (acceptedBeforeTransportFailure && this.payloadFailure === undefined && this.onStdoutChunk) {
            await this.onStdoutChunk(bytes);
          }
        }).catch(() => {
          this.payloadFailure ??= "CALLBACK";
          this.onPayloadError?.();
        });
        return;
      }
      this.buffered = Buffer.concat([this.buffered, bytes]);
      if (this.buffered.byteLength > 64 * 1024) {
        this.rejectAll("WINDOWS_HELPER_PROTOCOL_BUFFER_EXCEEDED");
        return;
      }
      this.flush();
    });
    stream.on("error", () => {
      if (!this.payloadStarted) {
        this.rejectAll("WINDOWS_HELPER_CHANNEL_FAILED");
        return;
      }
      if (this.payloadTransportFailureQueued) return;
      this.payloadTransportFailureQueued = true;
      this.onPayloadError?.();
      this.payloadCallbacks = this.payloadCallbacks.then(() => {
        this.payloadFailure ??= "STREAM";
      });
    });
  }

  beginPayload(): void {
    if (this.buffered.byteLength !== 0) throw new Error("WINDOWS_HELPER_UNEXPECTED_PRELAUNCH_OUTPUT");
    this.payloadStarted = true;
  }

  async drainPayload(): Promise<void> {
    let observed: Promise<void>;
    do {
      observed = this.payloadCallbacks;
      await observed;
    } while (observed !== this.payloadCallbacks);
    if (this.payloadFailure === "STREAM") throw new Error("WINDOWS_HELPER_PAYLOAD_STREAM_FAILED");
    if (this.payloadFailure === "CALLBACK") throw new Error("WINDOWS_HELPER_PAYLOAD_CALLBACK_FAILED");
  }

  nextLine(prefix: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) this.waiters.splice(index, 1);
        const stage = prefix === "EBB_HELPER_READY" || prefix === "EBB_SCOPE_READY" ? prefix : undefined;
        reject(new Error(stage
          ? `WINDOWS_HELPER_HANDSHAKE_TIMEOUT:${stage}`
          : "WINDOWS_HELPER_HANDSHAKE_TIMEOUT"));
      }, timeoutMs);
      this.waiters.push({ prefix, resolve, reject, timer });
      this.flush();
    });
  }

  private flush(): void {
    for (let index = 0; index < this.waiters.length; index += 1) {
      const waiter = this.waiters[index]!;
      const newline = this.buffered.indexOf(0x0a);
      if (newline < 0) return;
      const bytes = this.buffered.subarray(0, newline);
      const line = bytes[bytes.byteLength - 1] === 0x0d
        ? bytes.subarray(0, bytes.byteLength - 1).toString("utf8")
        : bytes.toString("utf8");
      if (line.startsWith("UNKNOWN\t")) {
        const fields = line.slice("UNKNOWN\t".length).split("\t");
        const code = fields[0]!;
        const safeCode = SAFE_NATIVE_HELPER_FAILURE_CODES.has(code) ? code : "INVALID_CODE";
        const diagnosticStage = code === "LAUNCH_TICKET_SOURCE_SNAPSHOT_TREE_MISMATCH" && fields.length === 2 &&
          SAFE_SNAPSHOT_TREE_DIAGNOSTIC_STAGES.has(fields[1]!) ? fields[1] : undefined;
        this.rejectAll(`WINDOWS_HELPER_NATIVE_UNKNOWN:${safeCode}`, diagnosticStage);
        return;
      }
      if (!matchesHelperProtocolLine(waiter.prefix, line)) continue;
      this.buffered = this.buffered.subarray(newline + 1);
      this.waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(line);
      return;
    }
  }

  private rejectAll(code: string, diagnosticStage?: string): void {
    const failure = new Error(code);
    if (diagnosticStage) Object.defineProperty(failure, "diagnosticStage", { value: diagnosticStage, enumerable: false });
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(failure);
    }
  }
}

function matchesHelperProtocolLine(prefix: string, line: string): boolean {
  if (prefix === "EBB_HELPER_READY") return line === prefix;
  if (prefix === "EBB_SCOPE_READY") return line.startsWith(`${prefix}\t`);
  return line === prefix || line.startsWith(`${prefix}\t`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
