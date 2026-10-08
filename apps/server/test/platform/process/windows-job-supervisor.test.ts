import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { PassThrough, Writable } from "node:stream";
import { ProcessExecutor, type ProcessOptions, type ProcessResult, type ProcessSession, type ProcessSessionOptions } from "../../../src/platform/process/process-executor.js";
import { WindowsJobSupervisor } from "../../../src/platform/process/windows-job-supervisor.js";
import { createHermesLaunchTicket } from "../../../src/modules/runtime/hermes/hermes-launch-ticket.js";
import { safeRestartChildFailureCode } from "../../helpers/restart-child-diagnostics.js";
import type { ProcessScopeIdentity } from "../../../src/platform/process/process-inspector.js";
import type { ProcessScopeLaunchRequest } from "../../../src/platform/process/run-scope-supervisor.js";

class FakeExecutor extends ProcessExecutor {
  override startSession = vi.fn<ProcessExecutor["startSession"]>(() => {
    throw new Error("HELPER_STARTED");
  });

  override async exec(_file: string, _args: string[], _options: ProcessOptions = {}): Promise<ProcessResult> {
    throw new Error("HELPER_EXECUTED");
  }
}

class InspectionExecutor extends ProcessExecutor {
  readonly calls: string[][] = [];
  constructor(private readonly output: string) { super(); }
  override async exec(_file: string, args: string[], _options: ProcessOptions = {}): Promise<ProcessResult> {
    this.calls.push(args);
    return { exitCode: 0, stdout: this.output, stderr: "" };
  }
}

class HandshakeExecutor extends ProcessExecutor {
  readonly writes: Buffer[] = [];
  readonly execCalls: string[][] = [];
  session: ProcessSession | undefined;
  private stdoutStream: PassThrough | undefined;
  private stderrStream: PassThrough | undefined;
  private resolveCompletion: ((result: ProcessResult) => void) | undefined;
  private rejectCompletion: ((error: Error) => void) | undefined;
  constructor(
    private readonly payload = "",
    private readonly autoComplete = true,
    private readonly preHandshakeOutput?: string,
    private readonly completionStderr = "",
    private readonly inspectionOutput = "STOPPED\tJOB_EMPTY\n",
  ) { super(); }
  override startSession = vi.fn<ProcessExecutor["startSession"]>((_file, _args, options: ProcessSessionOptions = {}) => {
    const completion = new Promise<ProcessResult>((resolve, reject) => {
      this.resolveCompletion = resolve;
      this.rejectCompletion = reject;
    });
    const stdout = new PassThrough();
    this.stdoutStream = stdout;
    const stdin = new Writable({
      write: (chunk: Buffer | string, _encoding, callback) => {
        const bytes = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk);
        this.writes.push(bytes);
        if (bytes.equals(Buffer.from(`EBBACK01${owner.launchNonce}`, "ascii"))) {
          if (this.payload) {
            const splitAt = Math.max(1, Math.floor(this.payload.length / 2));
            stdout.write(this.payload.slice(0, splitAt));
            stdout.write(this.payload.slice(splitAt));
          }
          if (this.autoComplete) this.complete();
        }
        callback();
      },
    });
    const stderr = new PassThrough();
    this.stderrStream = stderr;
    stdin.once("close", () => this.complete({
      exitCode: 3,
      stdout: "",
      stderr: options.captureOutput === false ? "" : this.completionStderr,
    }));
    const session: ProcessSession = { stdin, stdout, stderr, completion, terminate: () => undefined };
    this.session = session;
    queueMicrotask(() => {
      if (this.completionStderr) stderr.write(this.completionStderr);
      if (this.preHandshakeOutput !== undefined) {
        stdout.write(this.preHandshakeOutput);
        return;
      }
      stdout.write("EBB_HELPER_READY\n");
      stdout.write(`EBB_SCOPE_READY\t${owner.containmentId}\t${owner.launchNonce}\t41\t100000000\t42\t200000000\tsha256:${"c".repeat(64)}\n`);
    });
    return session;
  });

  override async exec(_file: string, _args: string[], _options: ProcessOptions = {}): Promise<ProcessResult> {
    this.execCalls.push(_args);
    return { exitCode: 0, stdout: this.inspectionOutput, stderr: "" };
  }

  complete(result: ProcessResult = { exitCode: 0, stdout: "", stderr: "" }): void {
    this.resolveCompletion?.(result);
  }

  fail(error: Error): void {
    this.rejectCompletion?.(error);
  }

  writeStdout(chunk: string): void {
    this.stdoutStream?.write(chunk);
  }

  writeStderr(chunk: string): void {
    this.stderrStream?.write(chunk);
  }
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

const owner: ProcessScopeIdentity = {
  runId: "windows-test-run",
  containmentKind: "windows-job",
  containmentId: "a".repeat(64),
  launchNonce: "b".repeat(64),
  systemdInvocationId: null,
  systemdControlGroup: null,
  supervisorPid: null,
  supervisorStartIdentity: null,
  pid: null,
  platform: null,
  processStartIdentity: null,
  executableIdentity: null,
  state: "LAUNCHING",
};

const request: ProcessScopeLaunchRequest = {
  executable: "C:\\Program Files\\nodejs\\node.exe",
  args: ["-e", "process.exit(0)"],
  cwd: "C:\\ebb-worktree",
  environment: {
    PATH: "C:\\Windows\\System32",
    SYSTEMROOT: "C:\\Windows",
    HERMES_HOME: "C:\\ebb\\hermes-home",
  },
  timeoutMs: 10_000,
};

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const createTestHelperInvocation = async (
  helperPath: string,
  _name: "windowsRunSupervisor" | "hermesProfilePath",
  args: readonly string[],
) => ({ file: helperPath, args, env: {} });

describe("WindowsJobSupervisor", () => {
  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("rejects credential-shaped child environment before starting the native helper", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    const executor = new FakeExecutor();
    const supervisor = new WindowsJobSupervisor(executor, "native-helper.exe", createTestHelperInvocation);
    const unsafeRequest = {
      ...request,
      environment: { ...request.environment, AWS_SECRET_ACCESS_KEY: "must-not-be-forwarded" },
    };

    await expect(supervisor.launch(owner, unsafeRequest, async () => undefined))
      .rejects.toThrow("PROCESS_SCOPE_ENVIRONMENT_REJECTED");
    expect(executor.startSession).not.toHaveBeenCalled();
  });

  it("rejects a PATH-resolved Hermes executable before starting the native helper", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    const executor = new FakeExecutor();
    const supervisor = new WindowsJobSupervisor(executor, "native-helper.exe", createTestHelperInvocation);

    await expect(supervisor.launch(owner, {
      ...request,
      executable: "hermes.exe",
      environment: { ...request.environment, PATH: "C:\\attacker\\bin" },
    }, async () => undefined)).rejects.toThrow("HERMES_LAUNCH_TICKET_REQUIRED");

    expect(executor.startSession).not.toHaveBeenCalled();
  });

  it("does not send the ResumeThread authorization frame when cancellation arrives during owner persistence", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    const executor = new HandshakeExecutor();
    const supervisor = new WindowsJobSupervisor(executor, "native-helper.exe", createTestHelperInvocation);
    const abortController = new AbortController();

    await expect(supervisor.launch(owner, { ...request, signal: abortController.signal }, async () => {
      abortController.abort();
    })).rejects.toThrow("WINDOWS_PROCESS_SCOPE_LAUNCH_CANCELLED");

    expect(executor.startSession).toHaveBeenCalledTimes(1);
    expect(executor.writes).toHaveLength(1);
    expect(executor.writes).not.toContainEqual(Buffer.from(`EBBACK01${owner.launchNonce}`, "ascii"));
  });

  it("sends only launch metadata and the nonce-bound owner authorization frame to the helper", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    const executor = new HandshakeExecutor();
    const supervisor = new WindowsJobSupervisor(executor, "native-helper.exe", createTestHelperInvocation);

    await supervisor.launch(owner, request, async () => undefined);

    expect(executor.writes).toHaveLength(2);
    expect(executor.writes[1]).toEqual(Buffer.from(`EBBACK01${owner.launchNonce}`, "ascii"));
    expect(Buffer.concat(executor.writes).toString("utf8")).not.toContain("EBB_HERMES_PROVIDER_API_KEY");
  });

  it("serializes the Run-bound EBB3 profile identity chain before source snapshot metadata", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    const runId = "123e4567-e89b-42d3-a456-426614174000";
    const profileHome = `C:\\ebb\\profiles\\ebb-orchestrator-run-${runId}`;
    const objectIdentity = (fileId: string) => ({
      platform: "win32" as const,
      volumeSerial: "0123456789abcdef",
      fileId,
    });
    const sourceSnapshotKey = JSON.stringify({
      formatVersion: 1,
      hermesVersion: "v0.21.5+7357.g9244275",
      manifestDigest: "c".repeat(64),
      materializationPolicyVersion: 2,
      sourceCommit: "b".repeat(40),
      sourceTree: "d".repeat(40),
    });
    const sourceSnapshotId = createHash("sha256").update(sourceSnapshotKey).digest("hex");
    const argsPrefix = ["-I", "-B", "-S", "-c", "snapshot-bootstrap"];
    const launchTicket = createHermesLaunchTicket({
      runId,
      attempt: 0,
      platform: "win32",
      hermesExecutablePath: "C:\\ebb\\bin\\hermes.exe",
      hermesExecutableIdentity: objectIdentity("1".repeat(32)),
      executablePath: "C:\\ebb\\runtime\\python.exe",
      executableIdentity: objectIdentity("2".repeat(32)),
      executableArgsPrefix: argsPrefix,
      profileHome,
      profileHomeIdentity: objectIdentity("4".repeat(32)),
      profileHomeTargetIdentities: {
        home: objectIdentity("6".repeat(32)),
        config: objectIdentity("7".repeat(32)),
      },
      profileHomePathChain: {
        version: 1,
        authRootIndex: 1,
        components: [
          { volumeSerial: "0123456789abcdef", fileId: "0".repeat(32) },
          { volumeSerial: "0123456789abcdef", fileId: "1".repeat(32) },
          { volumeSerial: "0123456789abcdef", fileId: "2".repeat(32) },
          { volumeSerial: "0123456789abcdef", fileId: "4".repeat(32) },
        ],
      },
      hermesSourceSnapshotKey: sourceSnapshotKey,
      hermesSourceSnapshotRoot: `C:\\ebb\\source-snapshots\\${sourceSnapshotId}`,
      hermesSourceSnapshotRootIdentity: objectIdentity("5".repeat(32)),
      hermesSourceManifestDigest: "c".repeat(64),
      hermesSourceProjectionPath: `C:\\ebb\\source-snapshots\\${sourceSnapshotId}.native-v1.bin`,
      hermesSourceProjectionSha256: "f".repeat(64),
      hermesSourceProjectionSize: 256,
      environment: {
        HERMES_HOME: profileHome,
        HOME: `${profileHome}\\home`,
        HERMES_CONFIG: `${profileHome}\\config.yaml`,
      },
    });
    const executor = new HandshakeExecutor();
    const supervisor = new WindowsJobSupervisor(executor, "native-helper.exe", createTestHelperInvocation);

    await supervisor.launch({ ...owner, runId }, {
      ...request,
      attempt: 0,
      executable: "C:\\ebb\\runtime\\python.exe",
      args: [...argsPrefix, "chat"],
      environment: {
        HERMES_HOME: profileHome,
        HOME: `${profileHome}\\home`,
        HERMES_CONFIG: `${profileHome}\\config.yaml`,
      },
      hermesLaunchTicket: launchTicket,
    }, async () => undefined);

    const frame = executor.writes[0]!;
    let offset = 0;
    const readU32 = () => { const value = frame.readUInt32BE(offset); offset += 4; return value; };
    const readString = () => { const length = readU32(); const value = frame.toString("utf8", offset, offset + length); offset += length; return value; };
    const skipIdentity = () => { readString(); readString(); };
    const readIdentity = () => [readString(), readString()];
    expect(readU32()).toBe(0x45424233);
    const declaredFrameLength = readU32();
    expect(declaredFrameLength).toBe(frame.length);
    const argCount = readU32();
    const environmentCount = readU32();
    readString();
    readString();
    for (let index = 0; index < argCount; index += 1) readString();
    for (let index = 0; index < environmentCount; index += 1) { readString(); readString(); }
    expect(readU32()).toBe(1);
    expect(readString()).toBe(profileHome);
    readString();
    skipIdentity();
    skipIdentity();
    skipIdentity();
    expect(readIdentity()).toEqual(["0123456789abcdef", "6".repeat(32)]);
    expect(readIdentity()).toEqual(["0123456789abcdef", "7".repeat(32)]);
    expect(readString()).toBe(runId);
    expect(readU32()).toBe(1);
    expect(readU32()).toBe(1);
    expect(readU32()).toBe(4);
    for (const component of ["0", "1", "2", "4"]) {
      expect(readString()).toBe("0123456789abcdef");
      expect(readString()).toBe(component.repeat(32));
    }
    expect(readString()).toBe(sourceSnapshotKey);
    readString();
    skipIdentity();
    readString();
    readString();
    readString();
    readU32();
    expect(offset).toBe(frame.length);
  });

  it("fails immediately on a native UNKNOWN frame before the launch handshake", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    const executor = new HandshakeExecutor("", true, "UNKNOWN\tJOB_ACCOUNTING_UNAVAILABLE\n");
    const supervisor = new WindowsJobSupervisor(executor, "native-helper.exe", createTestHelperInvocation);

    await expect(supervisor.launch(owner, request, async () => undefined))
      .rejects.toThrow("WINDOWS_HELPER_NATIVE_UNKNOWN:JOB_ACCOUNTING_UNAVAILABLE");
  });

  it("surfaces a safe native UNKNOWN after helper-ready and proves pending-launch cleanup", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    const executor = new HandshakeExecutor(
      "",
      true,
      "EBB_HELPER_READY\nUNKNOWN\tCHILD_CREATE_FAILED\nUNSUPPORTED_NATIVE_DIAGNOSTIC\n",
    );
    const supervisor = new WindowsJobSupervisor(executor, "native-helper.exe", createTestHelperInvocation);
    let failure: unknown;
    try { await supervisor.launch(owner, request, async () => undefined); }
    catch (error) { failure = error; }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("WINDOWS_HELPER_NATIVE_UNKNOWN:CHILD_CREATE_FAILED");
    expect((failure as Error).message).not.toContain("UNSUPPORTED_NATIVE_DIAGNOSTIC");
    expect(executor.session?.stdin.destroyed).toBe(true);
    expect(executor.writes.some((write) => write.subarray(0, 8).equals(Buffer.from("EBBACK01")))).toBe(false);
    expect(executor.execCalls).toEqual([[
      "inspect", owner.containmentId, owner.launchNonce, "LAUNCHING", "-", "-", "0",
    ]]);
  });

  it.each([
    "LAUNCH_TICKET_EXECUTABLE_MISMATCH",
    "LAUNCH_TICKET_HERMES_MISMATCH",
    "LAUNCH_TICKET_PROFILE_CHAIN_MISMATCH",
    "LAUNCH_TICKET_PROFILE_CHAIN_SHAPE_MISMATCH",
    "LAUNCH_TICKET_PROFILE_PATH_BINDING_MISMATCH",
    "LAUNCH_TICKET_PROFILE_ROOT_UNSAFE",
    "LAUNCH_TICKET_PROFILE_COMPONENT_UNSAFE",
    "LAUNCH_TICKET_PROFILE_TARGETS_MISMATCH",
    "LAUNCH_TICKET_SOURCE_SNAPSHOT_MISMATCH",
    "LAUNCH_TICKET_SOURCE_SNAPSHOT_ROOT_UNSAFE",
    "LAUNCH_TICKET_SOURCE_SNAPSHOT_PROJECTION_UNSAFE",
    "LAUNCH_TICKET_SOURCE_SNAPSHOT_TREE_MISMATCH",
  ])("preserves a bounded launch-ticket validation stage code: %s", async (code) => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    const executor = new HandshakeExecutor("", true, `EBB_HELPER_READY\nUNKNOWN\t${code}\n`);
    const supervisor = new WindowsJobSupervisor(executor, "native-helper.exe", createTestHelperInvocation);

    await expect(supervisor.launch(owner, request, async () => undefined))
      .rejects.toThrow(`WINDOWS_HELPER_NATIVE_UNKNOWN:${code}`);
  });

  it.each([
    "PATH_ENUMERATION", "ENTRY_SHAPE", "FILE_ATTRIBUTES", "FILE_OPEN", "FILE_LINK_COUNT",
    "FILE_SIZE", "FILE_DACL", "CONTENT_HASH", "CONTENT_MISMATCH", "ENUMERATION_END",
    "ENUMERATION_COMPLETENESS", "PROJECTION_ENTRY_COLLISION",
  ])("preserves only allowlisted source-tree detail outside the stable public code: %s", async (diagnosticStage) => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    const executor = new HandshakeExecutor(
      "",
      true,
      `EBB_HELPER_READY\nUNKNOWN\tLAUNCH_TICKET_SOURCE_SNAPSHOT_TREE_MISMATCH\t${diagnosticStage}\n`,
    );
    const supervisor = new WindowsJobSupervisor(executor, "native-helper.exe", createTestHelperInvocation);
    let failure: unknown;
    try { await supervisor.launch(owner, request, async () => undefined); }
    catch (error) { failure = error; }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("WINDOWS_HELPER_NATIVE_UNKNOWN:LAUNCH_TICKET_SOURCE_SNAPSHOT_TREE_MISMATCH");
    expect((failure as Error & { diagnosticStage?: string }).diagnosticStage).toBe(diagnosticStage);
    expect(Object.keys(failure as Error)).not.toContain("diagnosticStage");
    expect(JSON.stringify(failure)).not.toMatch(/path|SID|ACE|Win32|private/iu);
  });

  it("ignores unrecognized source-tree stage details while preserving the public mismatch code", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    const executor = new HandshakeExecutor(
      "",
      true,
      "EBB_HELPER_READY\nUNKNOWN\tLAUNCH_TICKET_SOURCE_SNAPSHOT_TREE_MISMATCH\tC:\\private\\secret\n",
    );
    const supervisor = new WindowsJobSupervisor(executor, "native-helper.exe", createTestHelperInvocation);
    let failure: unknown;
    try { await supervisor.launch(owner, request, async () => undefined); }
    catch (error) { failure = error; }

    expect((failure as Error).message).toBe("WINDOWS_HELPER_NATIVE_UNKNOWN:LAUNCH_TICKET_SOURCE_SNAPSHOT_TREE_MISMATCH");
    expect((failure as Error & { diagnosticStage?: string }).diagnosticStage).toBeUndefined();
    expect((failure as Error).message).not.toContain("secret");
  });

  it("does not echo an oversized native UNKNOWN code into the launch error", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    const executor = new HandshakeExecutor("", true, `UNKNOWN\t${"X".repeat(1_000)}\n`);
    const supervisor = new WindowsJobSupervisor(executor, "native-helper.exe", createTestHelperInvocation);

    await expect(supervisor.launch(owner, request, async () => undefined))
      .rejects.toThrow("WINDOWS_HELPER_NATIVE_UNKNOWN:INVALID_CODE");
  });

  it.each([
    ["before helper-ready", "", "WINDOWS_NATIVE_HELPER_DIAGNOSTIC:PHASE_UNCLASSIFIED:TYPE_UNCLASSIFIED:EXIT_3:READY_ABSENT"],
    ["after helper-ready", "EBB_HELPER_READY\n", "WINDOWS_NATIVE_HELPER_DIAGNOSTIC:PHASE_UNCLASSIFIED:TYPE_UNCLASSIFIED:EXIT_3:READY_PRESENT"],
  ])("reports bounded terminal facts when the native handshake stage times out %s", async (_description, preHandshakeOutput, expectedCode) => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    vi.useFakeTimers();
    const executor = new HandshakeExecutor("", true, preHandshakeOutput);
    const supervisor = new WindowsJobSupervisor(executor, "native-helper.exe", createTestHelperInvocation);

    const outcome = supervisor.launch(owner, request, async () => undefined).then(
      () => ({ kind: "success" as const }),
      (error: unknown) => ({ kind: "failure" as const, error }),
    );
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10_000);

    const result = await outcome;
    expect(result.kind).toBe("failure");
    expect(result.kind === "failure" ? (result.error as Error).message : undefined).toBe(expectedCode);
  });

  it("does not surface an unknown uppercase stdout line as a native failure code", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    const executor = new HandshakeExecutor("", true, "UNKNOWN\tPROVIDER_SECRET_VALUE\n");
    const supervisor = new WindowsJobSupervisor(executor, "native-helper.exe", createTestHelperInvocation);

    let failure: unknown;
    try { await supervisor.launch(owner, request, async () => undefined); }
    catch (error) { failure = error; }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("WINDOWS_HELPER_NATIVE_UNKNOWN:INVALID_CODE");
    expect((failure as Error).message).not.toContain("PROVIDER_SECRET_VALUE");
  });

  it("normalizes only an allowlisted native-helper gate phase from completion stderr", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    vi.useFakeTimers();
    const executor = new HandshakeExecutor(
      "", true, "", "NATIVE_HELPER_GATE_FAIL:integrity-check:CryptographicException\nOPENAI_API_KEY=must-not-leak\n",
    );
    const supervisor = new WindowsJobSupervisor(executor, "native-helper.exe", createTestHelperInvocation);

    const outcome = supervisor.launch(owner, request, async () => undefined).then(
      () => ({ kind: "success" as const }),
      (error: unknown) => ({ kind: "failure" as const, error }),
    );
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await outcome;
    const failure = result.kind === "failure" ? result.error : undefined;

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "WINDOWS_NATIVE_HELPER_DIAGNOSTIC:PHASE_INTEGRITY_CHECK:TYPE_CRYPTOGRAPHIC_EXCEPTION:EXIT_3:READY_ABSENT",
    );
    expect((failure as Error).message).not.toContain("CryptographicException");
    expect((failure as Error).message).not.toContain("OPENAI_API_KEY");
  });

  it.each([
    ["JOB_CREATE_FAILED_OR_EXISTS", "LAUNCH_JOB_CREATE"],
    ["JOB_POLICY_FAILED", "LAUNCH_JOB_POLICY"],
    ["MAPPING_CREATE_FAILED_OR_EXISTS", "LAUNCH_MAPPING_CREATE"],
    ["HELPER_READY_WRITE_FAILED", "LAUNCH_READY_WRITE"],
  ])("reports only the allowlisted pre-READY native failure %s", async (nativeFailure, phase) => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    vi.useFakeTimers();
    const secret = "C:\\private\\provider-token";
    const executor = new HandshakeExecutor(
      "", true, "", `NATIVE_HELPER_LAUNCH_FAIL:${nativeFailure}\r\n${secret} OPENAI_API_KEY=must-not-leak`,
    );
    const supervisor = new WindowsJobSupervisor(executor, "native-helper.exe", createTestHelperInvocation);

    const outcome = supervisor.launch(owner, request, async () => undefined).then(
      () => ({ kind: "success" as const }),
      (error: unknown) => ({ kind: "failure" as const, error }),
    );
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await outcome;
    const failure = result.kind === "failure" ? result.error : undefined;

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      `WINDOWS_NATIVE_HELPER_DIAGNOSTIC:PHASE_${phase}:TYPE_NATIVE_LAUNCH_FAILURE:EXIT_3:READY_ABSENT`,
    );
    expect((failure as Error).message).not.toContain(secret);
    expect((failure as Error).message).not.toContain("OPENAI_API_KEY");
  });

  it("does not surface unrecognized native launch markers or their raw content", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    vi.useFakeTimers();
    const executor = new HandshakeExecutor(
      "", true, "", "NATIVE_HELPER_LAUNCH_FAIL:C:\\private\\secret\n",
    );
    const supervisor = new WindowsJobSupervisor(executor, "native-helper.exe", createTestHelperInvocation);

    const outcome = supervisor.launch(owner, request, async () => undefined).then(
      () => ({ kind: "success" as const }),
      (error: unknown) => ({ kind: "failure" as const, error }),
    );
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await outcome;
    const failure = result.kind === "failure" ? result.error : undefined;

    expect((failure as Error).message).toBe(
      "WINDOWS_NATIVE_HELPER_DIAGNOSTIC:PHASE_UNCLASSIFIED:TYPE_UNCLASSIFIED:EXIT_3:READY_ABSENT",
    );
    expect((failure as Error).message).not.toContain("secret");
  });

  it("retains only an allowlisted gate failure from stderr when output capture is disabled", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    vi.useFakeTimers();
    const secret = "C:\\private\\provider-token";
    const rawStderr = `NATIVE_HELPER_GATE_FAIL:process-start:Win32Exception\r\n${secret} OPENAI_API_KEY=must-not-leak`;
    const executor = new HandshakeExecutor("", true, "", rawStderr);
    const supervisor = new WindowsJobSupervisor(executor, "native-helper.exe", createTestHelperInvocation);

    const outcome = supervisor.launch(owner, { ...request, captureOutput: false }, async () => undefined).then(
      () => ({ kind: "success" as const }),
      (error: unknown) => ({ kind: "failure" as const, error }),
    );
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await outcome;
    const failure = result.kind === "failure" ? result.error : undefined;

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "WINDOWS_NATIVE_HELPER_DIAGNOSTIC:PHASE_PROCESS_START:TYPE_WIN32_EXCEPTION:EXIT_3:READY_ABSENT",
    );
    expect((await executor.session?.completion)?.stderr).toBe("");
    expect((failure as Error).message).not.toContain(secret);
    expect((failure as Error).message).not.toContain("OPENAI_API_KEY");
    expect(safeRestartChildFailureCode(failure)).toBe(
      `${(failure as Error).message}>WINDOWS_HELPER_HANDSHAKE_TIMEOUT:EBB_HELPER_READY`,
    );
  });

  it("does not accept a READY marker with a suffix as handshake evidence", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    vi.useFakeTimers();
    const executor = new HandshakeExecutor("", true, "EBB_HELPER_READY_EXTRA\n");
    const supervisor = new WindowsJobSupervisor(executor, "native-helper.exe", createTestHelperInvocation);

    const outcome = supervisor.launch(owner, request, async () => undefined).then(
      () => ({ kind: "success" as const }),
      (error: unknown) => ({ kind: "failure" as const, error }),
    );
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await outcome;
    const failure = result.kind === "failure" ? result.error : undefined;

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "WINDOWS_NATIVE_HELPER_DIAGNOSTIC:PHASE_UNCLASSIFIED:TYPE_UNCLASSIFIED:EXIT_3:READY_ABSENT",
    );
  });

  it("stops parsing gate markers after exact READY so payload stderr cannot spoof the gate failure", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    vi.useFakeTimers();
    const executor = new HandshakeExecutor("", true, "EBB_HELPER_READY\n");
    const supervisor = new WindowsJobSupervisor(executor, "native-helper.exe", createTestHelperInvocation);

    const outcome = supervisor.launch(owner, request, async () => undefined).then(
      () => ({ kind: "success" as const }),
      (error: unknown) => ({ kind: "failure" as const, error }),
    );
    for (let attempt = 0; attempt < 10 && executor.writes.length === 0; attempt += 1) await Promise.resolve();
    expect(executor.writes).toHaveLength(1);
    executor.writeStderr("NATIVE_HELPER_GATE_FAIL:process-start:Win32Exception\r\n");
    executor.writeStderr("NATIVE_HELPER_LAUNCH_FAIL:JOB_CREATE_FAILED_OR_EXISTS\r\n");
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await outcome;
    const failure = result.kind === "failure" ? result.error : undefined;

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "WINDOWS_NATIVE_HELPER_DIAGNOSTIC:PHASE_UNCLASSIFIED:TYPE_UNCLASSIFIED:EXIT_3:READY_PRESENT",
    );
  });

  it("does not echo an arbitrary gate phase or secret-shaped stderr", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    vi.useFakeTimers();
    const executor = new HandshakeExecutor(
      "", true, "", "NATIVE_HELPER_GATE_FAIL:sk-secret-value:InvalidOperationException\nNATIVE_HELPER_GATE_FAIL:integrity-check:ProviderSecretValue\n",
    );
    const supervisor = new WindowsJobSupervisor(executor, "native-helper.exe", createTestHelperInvocation);

    const outcome = supervisor.launch(owner, request, async () => undefined).then(
      () => ({ kind: "success" as const }),
      (error: unknown) => ({ kind: "failure" as const, error }),
    );
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await outcome;
    const failure = result.kind === "failure" ? result.error : undefined;

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "WINDOWS_NATIVE_HELPER_DIAGNOSTIC:PHASE_UNCLASSIFIED:TYPE_UNCLASSIFIED:EXIT_3:READY_ABSENT",
    );
    expect((failure as Error).message).not.toContain("sk-secret-value");
    expect((failure as Error).message).not.toContain("ProviderSecretValue");
  });

  it("keeps missing stop proof as the top-level error while preserving a safe gate phase beneath it", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    vi.useFakeTimers();
    const executor = new HandshakeExecutor(
      "", true, "", "NATIVE_HELPER_GATE_FAIL:integrity-check:CryptographicException\nOPENAI_API_KEY=must-not-leak\n",
      "UNKNOWN\tJOB_ABSENT_HELPER_IDENTITY_MISSING\n",
    );
    const supervisor = new WindowsJobSupervisor(executor, "native-helper.exe", createTestHelperInvocation);

    const outcome = supervisor.launch(owner, request, async () => undefined).then(
      () => ({ kind: "success" as const }),
      (error: unknown) => ({ kind: "failure" as const, error }),
    );
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await outcome;
    const failure = result.kind === "failure" ? result.error : undefined;

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "WINDOWS_PROCESS_SCOPE_LAUNCH_UNPROVEN:WINDOWS_JOB_ABSENT_HELPER_IDENTITY_MISSING",
    );
    expect(safeRestartChildFailureCode(failure)).toBe(
      "WINDOWS_PROCESS_SCOPE_LAUNCH_UNPROVEN:WINDOWS_JOB_ABSENT_HELPER_IDENTITY_MISSING>WINDOWS_NATIVE_HELPER_DIAGNOSTIC:PHASE_INTEGRITY_CHECK:TYPE_CRYPTOGRAPHIC_EXCEPTION:EXIT_3:READY_ABSENT",
    );
    expect(safeRestartChildFailureCode(failure)).not.toContain("WINDOWS_HELPER_HANDSHAKE_TIMEOUT");
    expect((failure as Error).message).not.toContain("OPENAI_API_KEY");
  });

  it.each(["constructor", "toString"])("rejects prototype phase key %s as an unknown gate phase", async (phase) => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    vi.useFakeTimers();
    const executor = new HandshakeExecutor(
      "", true, "", `NATIVE_HELPER_GATE_FAIL:${phase}:InvalidOperationException\n`,
    );
    const supervisor = new WindowsJobSupervisor(executor, "native-helper.exe", createTestHelperInvocation);

    const outcome = supervisor.launch(owner, request, async () => undefined).then(
      () => ({ kind: "success" as const }),
      (error: unknown) => ({ kind: "failure" as const, error }),
    );
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await outcome;
    const failure = result.kind === "failure" ? result.error : undefined;

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "WINDOWS_NATIVE_HELPER_DIAGNOSTIC:PHASE_UNCLASSIFIED:TYPE_UNCLASSIFIED:EXIT_3:READY_ABSENT",
    );
    expect((failure as Error).message).not.toContain("NATIVE_HELPER_GATE_FAILURE");
  });

  it("forwards only child payload bytes after both helper handshakes and the launch ACK", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    const payload = '{"type":"system","subtype":"init","session_id":"session-1"}\n';
    const executor = new HandshakeExecutor(payload);
    const supervisor = new WindowsJobSupervisor(executor, "native-helper.exe", createTestHelperInvocation);
    const chunks: string[] = [];

    const handle = await supervisor.launch(owner, {
      ...request,
      captureOutput: false,
      onStdoutChunk: async (chunk) => { chunks.push(Buffer.from(chunk).toString("utf8")); },
    }, async () => undefined);
    const result = await handle.completion;

    expect(chunks.join("")).toBe(payload);
    expect(chunks.join("")).not.toContain("EBB_HELPER_READY");
    expect(chunks.join("")).not.toContain("EBB_SCOPE_READY");
    expect(result.stdout).toBe("");
  });

  it("rejects and stops the exact Job when stdout errors after a successful init callback", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    const payload = '{"type":"system","subtype":"init","session_id":"session-before-error"}\n';
    const executor = new HandshakeExecutor(payload, false);
    const supervisor = new WindowsJobSupervisor(executor, "native-helper.exe", createTestHelperInvocation);
    const stop = vi.spyOn(supervisor, "stop");
    const callbackDone = deferred();
    const chunks: string[] = [];
    const handle = await supervisor.launch(owner, {
      ...request,
      onStdoutChunk: async (chunk) => { chunks.push(Buffer.from(chunk).toString("utf8")); callbackDone.resolve(); },
    }, async () => undefined);
    await callbackDone.promise;
    let escapedStreamError = false;
    try { executor.session?.stdout.emit("error", new Error("injected payload stream error")); }
    catch { escapedStreamError = true; }
    executor.complete();

    await expect(handle.completion).rejects.toThrow("WINDOWS_HELPER_PAYLOAD_STREAM_FAILED");
    expect(escapedStreamError).toBe(false);
    expect(chunks.join("")).toBe(payload);
    expect(stop).toHaveBeenCalledWith(expect.objectContaining({
      runId: owner.runId, containmentId: owner.containmentId, launchNonce: owner.launchNonce,
      supervisorPid: 41, supervisorStartIdentity: "100000000",
    }));
  });

  it("drains a deferred payload callback before rejecting helper completion", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    const executor = new HandshakeExecutor("", false);
    const supervisor = new WindowsJobSupervisor(executor, "native-helper.exe", createTestHelperInvocation);
    const entered = deferred();
    const release = deferred();
    const handle = await supervisor.launch(owner, {
      ...request,
      onStdoutChunk: async () => { entered.resolve(); await release.promise; },
    }, async () => undefined);
    executor.writeStdout("queued payload");
    await entered.promise;
    executor.fail(new Error("injected helper completion failure"));
    let settled = false;
    const settledCompletion = handle.completion.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    release.resolve();
    await settledCompletion;
    expect(settled).toBe(true);
  });

  it("does not stop a live named Job whose persisted process identity differs", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    const output = [
      "LIVE", owner.containmentId, owner.launchNonce, "41", "100", "42", "200", `sha256:${"c".repeat(64)}`,
    ].join("\t");
    const executor = new InspectionExecutor(`${output}\n`);
    const supervisor = new WindowsJobSupervisor(executor, "native-helper.exe", createTestHelperInvocation);
    const persistedOwner = {
      ...owner,
      supervisorPid: 41,
      supervisorStartIdentity: "100",
      pid: 43,
      platform: "win32",
      processStartIdentity: "201",
      executableIdentity: `sha256:${"c".repeat(64)}`,
    };

    await expect(supervisor.stop(persistedOwner)).resolves.toMatchObject({
      state: "UNKNOWN", reason: "WINDOWS_JOB_IDENTITY_MISMATCH",
    });
    expect(executor.calls).toEqual([[
      "inspect", owner.containmentId, owner.launchNonce, "LAUNCHING", "41", "100", "0",
    ]]);
  });

  it("keeps an absent Job UNKNOWN while its matching helper may still be live", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    const executor = new InspectionExecutor("UNKNOWN\tJOB_ABSENT_HELPER_STILL_LIVE\n");
    const supervisor = new WindowsJobSupervisor(executor, "native-helper.exe", createTestHelperInvocation);
    const stoppingOwner = {
      ...owner,
      state: "STOPPING" as const,
      supervisorPid: 41,
      supervisorStartIdentity: "123456789",
    };

    await expect(supervisor.inspect(stoppingOwner)).resolves.toEqual({
      state: "UNKNOWN", reason: "WINDOWS_JOB_ABSENT_HELPER_STILL_LIVE",
    });
    expect(executor.calls).toEqual([[
      "inspect", owner.containmentId, owner.launchNonce, "STOPPING", "41", "123456789", "0",
    ]]);
  });

  it("preserves UNKNOWN from native inspection when a LAUNCHING owner has no helper identity", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    const executor = new InspectionExecutor("UNKNOWN\tJOB_ABSENT_HELPER_IDENTITY_MISSING\n");
    const supervisor = new WindowsJobSupervisor(executor, "native-helper.exe", createTestHelperInvocation);

    await expect(supervisor.inspect(owner)).resolves.toEqual({
      state: "UNKNOWN", reason: "WINDOWS_JOB_ABSENT_HELPER_IDENTITY_MISSING",
    });
    expect(executor.calls).toEqual([[
      "inspect", owner.containmentId, owner.launchNonce, "LAUNCHING", "-", "-", "0",
    ]]);
  });

  it("accepts STOPPED only from the helper's verified absent-Job proof", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    const executor = new InspectionExecutor("STOPPED\tJOB_ABSENT_NO_HELPER\n");
    const supervisor = new WindowsJobSupervisor(executor, "native-helper.exe", createTestHelperInvocation);

    await expect(supervisor.inspect({
      ...owner,
      state: "STOPPED",
      supervisorPid: 41,
      supervisorStartIdentity: "123456789",
    })).resolves.toEqual({ state: "STOPPED", evidence: "WINDOWS_JOB_AND_HELPER_ABSENT" });
  });
});
