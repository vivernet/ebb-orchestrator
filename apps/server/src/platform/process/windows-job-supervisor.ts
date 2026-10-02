import { fileURLToPath } from "node:url";
import { ProcessExecutor, type ProcessResult, type ProcessSession } from "./process-executor.js";
import type { ProcessScopeIdentity, ProcessScopeObservation } from "./process-inspector.js";
import { ProcessScopeLaunchNotDispatchedError, type ProcessScopeHandle, type ProcessScopeLaunchRequest, type ProcessScopeSupervisor } from "./run-scope-supervisor.js";

const STOP_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;
const HELPER_PATH = fileURLToPath(new URL("../../../dist/native/windows-run-supervisor/ebb-run-supervisor.exe", import.meta.url));
const HERMES_CHILD_ENV_KEYS = new Set([
  "HOMEDRIVE", "HOMEPATH", "SYSTEMROOT", "TEMP", "TMP", "PATH", "NODE_PATH", "NODE_ENV",
  "HOME", "HERMES_HOME", "HERMES_CONFIG", "HERMES_MODEL",
]);
const pendingLaunches = new Set<string>();

function launchKey(owner: ProcessScopeIdentity): string {
  return `${owner.containmentId}:${owner.launchNonce}`;
}

/** Reopens and controls only the private named Job associated with one Run owner. */
export class WindowsJobSupervisor implements ProcessScopeSupervisor {
  constructor(private readonly executor = new ProcessExecutor(), private readonly helperPath = HELPER_PATH) {}

  async launch(
    owner: ProcessScopeIdentity,
    request: ProcessScopeLaunchRequest,
    persistVerifiedIdentity: (identity: ProcessScopeIdentity) => Promise<void>,
  ): Promise<ProcessScopeHandle> {
    assertWindowsOwner(owner);
    assertRequest(request);
    if (request.signal?.aborted) throw new ProcessScopeLaunchNotDispatchedError();
    const metadataFrame = encodeMetadataFrame(request);
    const key = launchKey(owner);
    pendingLaunches.add(key);
    let session: ProcessSession;
    try {
      session = this.executor.startSession(this.helperPath, ["launch", owner.containmentId, owner.launchNonce], {
        cwd: request.cwd,
        timeout: 0,
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (error) {
      pendingLaunches.delete(key);
      throw error;
    }
    const protocol = new HelperProtocol(session.stdout);
    let identity: ProcessScopeIdentity | undefined;
    let stopPromise: Promise<ProcessScopeObservation> | undefined;
    const requestStop = () => {
      if (!stopPromise) stopPromise = this.stop(identity ?? owner);
      return stopPromise;
    };
    const onAbort = () => {
      session.stdin.destroy();
      if (identity) void requestStop().catch(() => undefined);
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await protocol.nextLine("EBB_HELPER_READY", 10_000);
      if (request.signal?.aborted) throw new Error("WINDOWS_PROCESS_SCOPE_LAUNCH_CANCELLED");
      session.stdin.write(metadataFrame);
      identity = parseLiveIdentity(await protocol.nextLine("EBB_SCOPE_READY", 10_000), owner);
      await persistVerifiedIdentity(identity);
      // ResumeThread is gated by this one-byte authorization. Recheck the signal
      // after the asynchronous durable callback and before sending the byte.
      if (request.signal?.aborted) throw new Error("WINDOWS_PROCESS_SCOPE_LAUNCH_CANCELLED");
      session.stdin.write(Buffer.from([1]));
      pendingLaunches.delete(key);
    } catch (error) {
      session.stdin.destroy();
      // Closing the protocol channel makes the suspended native helper reject the
      // launch ACK. Keep the pending marker until that exact helper has exited.
      await session.completion.catch(() => undefined);
      pendingLaunches.delete(key);
      request.signal?.removeEventListener("abort", onAbort);
      const stopOwner = identity ?? owner;
      const observed = await this.waitForStopped(stopOwner, STOP_TIMEOUT_MS);
      const stopped = observed.state === "STOPPED" ? observed : await this.stop(stopOwner);
      const final = stopped.state === "STOPPED" ? stopped : await this.waitForStopped(stopOwner, STOP_TIMEOUT_MS);
      if (final.state !== "STOPPED") {
        const reason = final.state === "UNKNOWN" ? final.reason : "WINDOWS_JOB_STOP_NOT_CONFIRMED";
        throw new Error(`WINDOWS_PROCESS_SCOPE_LAUNCH_UNPROVEN:${reason}`, { cause: error });
      }
      throw error;
    }

    const verifiedIdentity = identity;
    if (!verifiedIdentity) throw new Error("WINDOWS_PROCESS_SCOPE_LIVE_IDENTITY_MISSING");
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; void requestStop(); }, request.timeoutMs);
    const completion = session.completion.then(async (result) => {
      const stopped = await this.waitForStopped(verifiedIdentity, STOP_TIMEOUT_MS);
      if (stopped.state !== "STOPPED") throw new Error("WINDOWS_PROCESS_SCOPE_STOP_UNPROVEN");
      if (timedOut) throw new Error("WINDOWS_PROCESS_SCOPE_TIMEOUT");
      return stripHelperProtocol(result);
    }).catch(async (error: unknown) => {
      const stopped = await requestStop().catch(() => ({ state: "UNKNOWN" as const, reason: "WINDOWS_JOB_STOP_FAILED" }));
      if (stopped.state !== "STOPPED") throw new Error("WINDOWS_PROCESS_SCOPE_STOP_UNPROVEN");
      throw error;
    }).finally(() => {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onAbort);
    });
    return { completion };
  }

  async inspect(owner: ProcessScopeIdentity): Promise<ProcessScopeObservation> {
    assertWindowsOwner(owner);
    try {
      const result = await this.executor.exec(this.helperPath, [
        "inspect",
        owner.containmentId,
        owner.launchNonce,
        owner.state,
        owner.supervisorPid?.toString() ?? "-",
        owner.supervisorStartIdentity ?? "-",
        pendingLaunches.has(launchKey(owner)) ? "1" : "0",
      ], { timeout: 5_000, maxBuffer: 32 * 1024 });
      return parseInspection(result.stdout, owner);
    } catch {
      return { state: "UNKNOWN", reason: "WINDOWS_JOB_INSPECTION_UNAVAILABLE" };
    }
  }

  async stop(owner: ProcessScopeIdentity): Promise<ProcessScopeObservation> {
    assertWindowsOwner(owner);
    const before = await this.inspect(owner);
    if (before.state !== "LIVE") return before;
    try {
      await this.executor.exec(this.helperPath, ["stop", owner.containmentId, owner.launchNonce], { timeout: STOP_TIMEOUT_MS, maxBuffer: 32 * 1024 });
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

function encodeMetadataFrame(request: ProcessScopeLaunchRequest): Buffer {
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
  addU32(0x45424231);
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
  const result = Buffer.concat(pieces);
  if (result.byteLength > 256 * 1024) throw new TypeError("Windows process-scope metadata exceeds 256 KiB.");
  return result;
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

class HelperProtocol {
  private buffered = "";
  private readonly waiters: Array<{ prefix: string; resolve: (line: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];

  constructor(stream: NodeJS.ReadableStream) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      this.buffered += chunk;
      this.flush();
    });
    stream.on("error", () => this.rejectAll("WINDOWS_HELPER_CHANNEL_FAILED"));
  }

  nextLine(prefix: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("WINDOWS_HELPER_HANDSHAKE_TIMEOUT"));
      }, timeoutMs);
      this.waiters.push({ prefix, resolve, reject, timer });
      this.flush();
    });
  }

  private flush(): void {
    for (let index = 0; index < this.waiters.length; index += 1) {
      const waiter = this.waiters[index]!;
      const newline = this.buffered.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffered.slice(0, newline).replace(/\r$/, "");
      if (!line.startsWith(waiter.prefix)) continue;
      this.buffered = this.buffered.slice(newline + 1);
      this.waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(line);
      return;
    }
  }

  private rejectAll(code: string): void {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(code));
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
