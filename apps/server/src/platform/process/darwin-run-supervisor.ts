import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ProcessResult } from "./process-executor.js";
import type { ProcessScopeIdentity, ProcessScopeObservation } from "./process-inspector.js";
import { ProcessScopeLaunchNotDispatchedError, type ProcessScopeHandle, type ProcessScopeLaunchRequest, type ProcessScopeSupervisor } from "./run-scope-supervisor.js";
import { consumeHermesLaunchTicket, type HermesLaunchTicketInput } from "../../modules/runtime/hermes/hermes-launch-ticket.js";
import { encodeDarwinProcessGroupIdentityV1, parseDarwinProcessGroupIdentityV1 } from "../../modules/runtime/run-process-owner.js";
import { verifyNativeHelperIntegrity } from "./native-helper-integrity.js";

const HELPER_PATH = fileURLToPath(new URL("../../../dist/native/macos-run-anchor/ebb-macos-run-anchor", import.meta.url));
const STOP_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 100;
const READY_TIMEOUT_MS = 60_000;
const INSPECTION_TIMEOUT_MS = 30_000;
const FRAME_MAGIC = 0x45424233; // "EBB3"
const MAX_ARGS = 512;
const MAX_ENV = 128;
const MAX_STRING_BYTES = 16 * 1024;
const MAX_FRAME_BYTES = 256 * 1024;
const DARWIN_ENV_ALLOWLIST = new Set([
  "PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "NODE_ENV",
  "HERMES_HOME", "HERMES_PROFILE", "HERMES_CONFIG", "HERMES_MODEL",
  "HERMES_DATA_DIR_SUFFIX", "HERMES_RUNTIME_DIR",
]);

/** Записывает весь буфер в поток и ждёт flush. */
async function writeAll(stream: NodeJS.WritableStream, chunk: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.write(chunk, (error?: Error | null) => error ? reject(error) : resolve());
  });
}

/**
 * Собирает бинарный фрейм метаданных launch (magic/frame_len/counts и строки)
 * для C anchor по протоколу read_metadata. Возвращает Buffer с проверенными лимитами.
 */
function buildMetadataFrame(request: ProcessScopeLaunchRequest, environment: Record<string, string>): Buffer {
  const entries = Object.entries(environment);
  if (request.args.length > MAX_ARGS || entries.length > MAX_ENV) {
    throw new Error("DARWIN_METADATA_FRAME_INVALID");
  }
  const strings: Buffer[] = [];
  const push = (value: string): void => {
    const raw = Buffer.from(value, "utf8");
    if (raw.byteLength > MAX_STRING_BYTES) throw new Error("DARWIN_METADATA_FRAME_INVALID");
    strings.push(raw);
  };
  push(request.executable);
  push(request.cwd);
  for (const arg of request.args) push(arg);
  for (const [key, value] of entries) { push(key); push(value); }
  let stringBytes = 0;
  for (const s of strings) stringBytes += 4 + s.byteLength;
  const frameLen = 16 + stringBytes;
  if (frameLen > MAX_FRAME_BYTES) throw new Error("DARWIN_METADATA_FRAME_INVALID");
  const frame = Buffer.allocUnsafe(frameLen);
  let offset = 0;
  frame.writeUInt32BE(FRAME_MAGIC, offset); offset += 4;
  frame.writeUInt32BE(frameLen, offset); offset += 4;
  frame.writeUInt32BE(request.args.length, offset); offset += 4;
  frame.writeUInt32BE(entries.length, offset); offset += 4;
  for (const s of strings) {
    frame.writeUInt32BE(s.byteLength, offset); offset += 4;
    s.copy(frame, offset); offset += s.byteLength;
  }
  return frame;
}

interface LocalLaunchAttempt {
  control?: NodeJS.ReadWriteStream;
  controlEnded: boolean;
}

function launchKey(owner: ProcessScopeIdentity): string {
  return `${owner.containmentId}:${owner.launchNonce}`;
}

interface AnchorChild {
  readonly stdio: [unknown, NodeJS.ReadableStream, NodeJS.ReadableStream, NodeJS.ReadWriteStream];
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "close", listener: (code: number | null) => void): this;
}

/**
 * Первый канонический anchor: живая сессия/группа для одного Run.
 * Протокол: приватный control-канал (fd 3) отделён от stdout/stderr payload;
 * READY/UNKNOWN/ACK/STOP — по приватному duplex control-каналу (fd 3);
 * EOF закрывает гейт и запускает self-stop.
 * Ebb никогда не шлёт числовые PID/PGID-сигналы.
 */
export class DarwinRunSupervisor implements ProcessScopeSupervisor {
  private readonly launchAttempts = new Map<string, LocalLaunchAttempt>();
  private readonly launchAttemptNonces = new Map<string, string>();

  constructor(
    private readonly anchorPath = HELPER_PATH,
    private readonly verifyIntegrity: (path: string) => Promise<void> = (path) => verifyNativeHelperIntegrity(path, "darwinRunAnchor"),
  ) {}

  async launch(
    owner: ProcessScopeIdentity,
    request: ProcessScopeLaunchRequest,
    persistVerifiedIdentity: (identity: ProcessScopeIdentity) => Promise<void>,
  ): Promise<ProcessScopeHandle> {
    assertDarwinOwner(owner);
    assertRequest(request);
    if (request.signal?.aborted) throw new ProcessScopeLaunchNotDispatchedError();
    const requiresTicket = isHermesExecutable(request.executable);
    consumeLaunchIdentity(owner, request);
    const environment = { ...request.environment };
    if (requiresTicket && request.hermesLaunchTicket) {
      environment.HERMES_LAUNCH_TICKET = JSON.stringify(request.hermesLaunchTicket);
    }
    const key = launchKey(owner);
    if (this.launchAttempts.has(key) || this.launchAttemptNonces.has(owner.containmentId)) {
      throw new Error("DARWIN_PROCESS_SCOPE_LAUNCH_ATTEMPT_ALREADY_RECORDED");
    }
    await this.verifyIntegrity(this.anchorPath);

    const child = spawn(this.anchorPath, ["launch", owner.containmentId, owner.launchNonce], {
      cwd: request.cwd,
      env: environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe", "pipe"],
      windowsHide: true,
    }) as unknown as AnchorChild;

    const attempt: LocalLaunchAttempt = { controlEnded: false };
    this.launchAttempts.set(key, attempt);
    this.launchAttemptNonces.set(owner.containmentId, owner.launchNonce);

    const control = child.stdio[3];
    attempt.control = control;
    let payloadStdout = "";
    let payloadStderr = "";
    child.stdout.on("data", (chunk: Buffer) => { payloadStdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { payloadStderr += chunk.toString("utf8"); });
    const completion = new Promise<ProcessResult>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve({ exitCode: code ?? 1, stdout: payloadStdout, stderr: payloadStderr }));
    });
    const frame = buildMetadataFrame(request, environment);
    try {
      await writeAll(control, frame);
    } catch (error) {
      control.end();
      await completion.catch(() => undefined);
      this.launchAttempts.delete(key);
      this.launchAttemptNonces.delete(owner.containmentId);
      throw error;
    }

    const identity = await readReadyLine(control, owner, READY_TIMEOUT_MS).catch(async (error: unknown) => {
      control.end();
      await completion.catch(() => undefined);
      this.launchAttempts.delete(key);
      this.launchAttemptNonces.delete(owner.containmentId);
      throw error;
    });
    await persistVerifiedIdentity(identity);
    if (request.signal?.aborted) {
      control.end();
      this.launchAttempts.delete(key);
      this.launchAttemptNonces.delete(owner.containmentId);
      throw new ProcessScopeLaunchNotDispatchedError();
    }
    control.write(`EBB_DARWIN_ACK\t${owner.launchNonce}\n`);

    const requestStop = () => this.stop(owner);
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; void requestStop().catch(() => undefined); }, request.timeoutMs);
    const onAbort = () => { control.end(); void requestStop().catch(() => undefined); };
    request.signal?.addEventListener("abort", onAbort, { once: true });

    const completion4 = completion.then(
      (result: ProcessResult) => {
        if (timedOut) throw new Error("DARWIN_PROCESS_SCOPE_TIMEOUT");
        return result;
      },
      (error: unknown) => {
        void requestStop().catch(() => undefined);
        throw error;
      },
    ).finally(async () => {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onAbort);
      const stopped = await this.waitForStopped(identity, STOP_TIMEOUT_MS);
      if (stopped.state !== "STOPPED") throw new Error("DARWIN_PROCESS_SCOPE_STOP_UNPROVEN");
      this.launchAttempts.delete(key);
      this.launchAttemptNonces.delete(identity.containmentId);
    });

    return { completion: completion4 };
  }

  async inspect(owner: ProcessScopeIdentity): Promise<ProcessScopeObservation> {
    assertDarwinOwner(owner);
    const anchor = parseDarwinProcessGroupIdentityV1(owner.supervisorStartIdentity);
    const runner = parseDarwinProcessGroupIdentityV1(owner.processStartIdentity);
    await this.verifyIntegrity(this.anchorPath);
    const args = [
      "inspect",
      owner.containmentId,
      owner.launchNonce,
      anchor.bootSessionUUID,
      String(anchor.pid), String(anchor.startTvsec), String(anchor.startUsec),
      String(anchor.pgid), String(anchor.sid),
      String(runner.pid), String(runner.startTvsec), String(runner.startUsec),
      owner.executableIdentity ?? "-",
    ];
    return this.execInspection(owner, args);
  }

  async stop(owner: ProcessScopeIdentity): Promise<ProcessScopeObservation> {
    assertDarwinOwner(owner);
    const before = await this.inspect(owner);
    if (before.state !== "LIVE") return before;
    const attempt = this.launchAttempts.get(launchKey(owner));
    if (attempt?.control && !attempt.controlEnded) {
      attempt.control.end();
      attempt.controlEnded = true;
    }
    return this.waitForStopped(owner, STOP_TIMEOUT_MS);
  }

  async waitForStopped(owner: ProcessScopeIdentity, timeoutMs = STOP_TIMEOUT_MS): Promise<ProcessScopeObservation> {
    const deadline = Date.now() + timeoutMs;
    do {
      const result = await this.inspect(owner);
      if (result.state === "STOPPED" || result.state === "UNKNOWN") return result;
      if (Date.now() + POLL_INTERVAL_MS > deadline) break;
      await delay(POLL_INTERVAL_MS);
    } while (Date.now() <= deadline);
    return { state: "UNKNOWN", reason: "DARWIN_GROUP_STOP_TIMEOUT" };
  }

  private async execInspection(owner: ProcessScopeIdentity, args: string[]): Promise<ProcessScopeObservation> {
    const child = spawn(this.anchorPath, args, {
      cwd: process.cwd(),
      env: buildMinimalEnvironment(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    const exitCode = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); }, INSPECTION_TIMEOUT_MS);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (code) => { clearTimeout(timer); resolve(code ?? 1); });
    });
    if (exitCode !== 0) return { state: "UNKNOWN", reason: "DARWIN_GROUP_INSPECTION_PROCESS_EXIT_NONZERO" };
    return parseInspection(stdout, owner);
  }
}

function readReadyLine(
  output: NodeJS.ReadableStream,
  owner: ProcessScopeIdentity,
  timeoutMs: number,
): Promise<ProcessScopeIdentity> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => settle(new Error("DARWIN_ANCHOR_HANDSHAKE_TIMEOUT")), timeoutMs);
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) {
        if (buffered.byteLength > 4096) settle(new Error("DARWIN_ANCHOR_PROTOCOL_BUFFER_EXCEEDED"));
        return;
      }
      const line = buffered.subarray(0, newline).toString("utf8");
      if (line.startsWith("UNKNOWN\t")) settle(new Error(`DARWIN_ANCHOR_NATIVE_UNKNOWN:${line.slice(8)}`));
      else settle(null, line);
    };
    const onError = (): void => settle(new Error("DARWIN_ANCHOR_CHANNEL_FAILED"));
    const onEnd = (): void => settle(new Error("DARWIN_ANCHOR_CHANNEL_CLOSED"));
    const settle = (error: Error | null, line?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      output.removeListener("data", onData);
      output.removeListener("error", onError);
      output.removeListener("end", onEnd);
      if (error) reject(error);
      else resolve(parseLiveIdentity(line!, owner));
    };
    output.on("data", onData);
    output.on("error", onError);
    output.on("end", onEnd);
  });
}

/**
 * Разбирает READY-строку anchor-протокола (control, fd 3) в durable Darwin ProcessScopeIdentity.
 * Строка: EBB_DARWIN_READY\t<containmentId>\t<launchNonce>\t1\t<bootSessionUUID>\t<anchorPid>\t<anchorSec>\t<anchorUsec>\t<pgid>\t<sid>\t<runnerPid>\t<runnerSec>\t<runnerUsec>\t<execIdentity>.
 * Проверяет ровно 14 полей, nonce-биндинг, pgid == anchor pid и формат exec-identity.
 */
export function parseLiveIdentity(line: string, owner: ProcessScopeIdentity): ProcessScopeIdentity {
  const fields = line.split("\t");
  if (
    fields.length !== 14 || fields[0] !== "EBB_DARWIN_READY" ||
    fields[1] !== owner.containmentId || fields[2] !== owner.launchNonce || fields[3] !== "1"
  ) {
    throw new Error("DARWIN_ANCHOR_IDENTITY_MISMATCH");
  }
  const bootSessionUUID = fields[4]!;
  const anchorPid = parsePid(fields[5]);
  const anchorSec = parseNonNegativeInt(fields[6]);
  const anchorUsec = parseNonNegativeInt(fields[7]);
  const pgid = parsePid(fields[8]);
  const sid = parsePid(fields[9]);
  const runnerPid = parsePid(fields[10]);
  const runnerSec = parseNonNegativeInt(fields[11]);
  const runnerUsec = parseNonNegativeInt(fields[12]);
  const executableIdentity = fields[13]!;
  if (
    !anchorPid || anchorSec === null || anchorUsec === null || !pgid || !sid ||
    !runnerPid || runnerSec === null || runnerUsec === null ||
    pgid !== anchorPid ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(bootSessionUUID) ||
    !/^sha256:[a-f0-9]{64}$/.test(executableIdentity)
  ) {
    throw new Error("DARWIN_ANCHOR_IDENTITY_INVALID");
  }
  const supervisorStartIdentity = encodeDarwinProcessGroupIdentityV1({
    formatVersion: 1, bootSessionUUID, pid: anchorPid, startTvsec: anchorSec, startUsec: anchorUsec, pgid, sid,
  });
  const processStartIdentity = encodeDarwinProcessGroupIdentityV1({
    formatVersion: 1, bootSessionUUID, pid: runnerPid, startTvsec: runnerSec, startUsec: runnerUsec, pgid, sid,
  });
  return {
    ...owner,
    supervisorPid: anchorPid,
    supervisorStartIdentity,
    pid: runnerPid,
    platform: "darwin",
    processStartIdentity,
    executableIdentity,
    state: "LIVE",
  };
}

/**
 * Разбирает stdout `inspect` (одна строка): LIVE-идентичность переиспользует READY-парсер,
 * STOPPED принимается только с доказательством DARWIN_GROUP_EMPTY, UNKNOWN — только с кодами-идентификаторами.
 */
export function parseInspection(output: string, owner: ProcessScopeIdentity): ProcessScopeObservation {
  const line = output.trim().split(/\r?\n/)[0] ?? "";
  const fields = line.split("\t");
  if (fields[0] === "STOPPED" && fields[1] === "DARWIN_GROUP_EMPTY") {
    return { state: "STOPPED", evidence: "DARWIN_GROUP_EMPTY" };
  }
  if (fields[0] === "UNKNOWN" && fields.length === 2) {
    const reason = fields[1];
    if (reason && /^[A-Z0-9_]+$/.test(reason)) return { state: "UNKNOWN", reason };
  }
  if (fields[0] === "LIVE" && fields[1] === owner.containmentId && fields[2] === owner.launchNonce) {
    const liveLine = `EBB_DARWIN_READY\t${fields.slice(1).join("\t")}`;
    const identity = parseLiveIdentity(liveLine, owner);
    return { state: "LIVE", identity };
  }
  return { state: "UNKNOWN", reason: "DARWIN_GROUP_IDENTITY_UNPROVEN" };
}

function assertDarwinOwner(owner: ProcessScopeIdentity): void {
  if (process.platform !== "darwin" || owner.containmentKind !== "darwin-process-group" ||
      !/^[a-f0-9]{64}$/.test(owner.containmentId) || !/^[a-f0-9]{64}$/.test(owner.launchNonce)) {
    throw new Error("DARWIN_PROCESS_SCOPE_UNSUPPORTED");
  }
}

function assertRequest(request: ProcessScopeLaunchRequest): void {
  if (!request.executable || !request.cwd || !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0) {
    throw new TypeError("Invalid Darwin process-scope launch request.");
  }
  for (const [key, value] of Object.entries(request.environment)) {
    if (!DARWIN_ENV_ALLOWLIST.has(key) || isCredentialEnvironmentKey(key) || !/^[A-Z_][A-Z0-9_]*$/.test(key) || /[\0\r\n]/.test(value)) {
      throw new Error("PROCESS_SCOPE_ENVIRONMENT_REJECTED");
    }
  }
}

function isCredentialEnvironmentKey(key: string): boolean {
  return /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API[_-]?KEY)/i.test(key);
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
  if (identity.platform !== "darwin") throw new Error("DARWIN_HERMES_LAUNCH_PLATFORM_MISMATCH");
  return identity;
}

function isHermesExecutable(executable: string): boolean {
  const name = executable.split(/[\\/]/u).at(-1)?.toLocaleLowerCase("en-US");
  return name === "hermes" || name === "hermes.exe";
}

function parsePid(value: string | undefined): number | null {
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const pid = Number(value);
  return Number.isSafeInteger(pid) ? pid : null;
}

function parseNonNegativeInt(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildMinimalEnvironment(): Record<string, string> {
  const allowed = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "HERMES_HOME", "HERMES_PROFILE"];
  return Object.fromEntries(allowed.flatMap((key) => {
    const value = process.env[key];
    return value === undefined ? [] : [[key, value]];
  }));
}

/** Хэш-идентичность executable для Darwin (sha256 файла), согласованно с anchor. */
export async function computeDarwinExecutableIdentity(executable: string): Promise<string> {
  const bytes = await readFile(executable);
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
