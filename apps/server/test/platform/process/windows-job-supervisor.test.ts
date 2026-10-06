import { afterEach, describe, expect, it, vi } from "vitest";
import { PassThrough, Writable } from "node:stream";
import { ProcessExecutor, type ProcessOptions, type ProcessResult, type ProcessSession } from "../../../src/platform/process/process-executor.js";
import { WindowsJobSupervisor } from "../../../src/platform/process/windows-job-supervisor.js";
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
  private resolveCompletion: ((result: ProcessResult) => void) | undefined;
  private rejectCompletion: ((error: Error) => void) | undefined;
  constructor(
    private readonly payload = "",
    private readonly autoComplete = true,
    private readonly preHandshakeOutput?: string,
    private readonly completionStderr = "",
    private readonly inspectionOutput = "STOPPED\tJOB_EMPTY\n",
  ) { super(); }
  override startSession = vi.fn<ProcessExecutor["startSession"]>(() => {
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
        if (bytes.length === 1 && bytes[0] === 1) {
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
    stdin.once("close", () => this.complete({ exitCode: 3, stdout: "", stderr: this.completionStderr }));
    const session: ProcessSession = { stdin, stdout, stderr, completion, terminate: () => undefined };
    this.session = session;
    queueMicrotask(() => {
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

  it("does not send the ResumeThread authorization byte when cancellation arrives during owner persistence", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    const executor = new HandshakeExecutor();
    const supervisor = new WindowsJobSupervisor(executor, "native-helper.exe", createTestHelperInvocation);
    const abortController = new AbortController();

    await expect(supervisor.launch(owner, { ...request, signal: abortController.signal }, async () => {
      abortController.abort();
    })).rejects.toThrow("WINDOWS_PROCESS_SCOPE_LAUNCH_CANCELLED");

    expect(executor.startSession).toHaveBeenCalledTimes(1);
    expect(executor.writes).toHaveLength(1);
    expect(executor.writes).not.toContainEqual(Buffer.from([1]));
  });

  it("sends only launch metadata and owner authorization to the helper", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    const executor = new HandshakeExecutor();
    const supervisor = new WindowsJobSupervisor(executor, "native-helper.exe", createTestHelperInvocation);

    await supervisor.launch(owner, request, async () => undefined);

    expect(executor.writes).toHaveLength(2);
    expect(executor.writes[1]).toEqual(Buffer.from([1]));
    expect(Buffer.concat(executor.writes).toString("utf8")).not.toContain("EBB_HERMES_PROVIDER_API_KEY");
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
    expect(executor.writes.some((write) => write.equals(Buffer.from([1])))).toBe(false);
    expect(executor.execCalls).toEqual([[
      "inspect", owner.containmentId, owner.launchNonce, "LAUNCHING", "-", "-", "0",
    ]]);
  });

  it("does not echo an oversized native UNKNOWN code into the launch error", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    const executor = new HandshakeExecutor("", true, `UNKNOWN\t${"X".repeat(1_000)}\n`);
    const supervisor = new WindowsJobSupervisor(executor, "native-helper.exe", createTestHelperInvocation);

    await expect(supervisor.launch(owner, request, async () => undefined))
      .rejects.toThrow("WINDOWS_HELPER_NATIVE_UNKNOWN:INVALID_CODE");
  });

  it.each([
    ["before helper-ready", "", "WINDOWS_HELPER_HANDSHAKE_TIMEOUT:EBB_HELPER_READY"],
    ["after helper-ready", "EBB_HELPER_READY\n", "WINDOWS_HELPER_HANDSHAKE_TIMEOUT:EBB_SCOPE_READY"],
  ])("identifies the native handshake stage that timed out %s", async (_description, preHandshakeOutput, expectedCode) => {
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
    expect((failure as Error).message).toBe("WINDOWS_NATIVE_HELPER_GATE_FAILURE:INTEGRITY_CHECK");
    expect((failure as Error).message).not.toContain("CryptographicException");
    expect((failure as Error).message).not.toContain("OPENAI_API_KEY");
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
    expect((failure as Error).message).toBe("WINDOWS_HELPER_HANDSHAKE_TIMEOUT:EBB_HELPER_READY");
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
      "WINDOWS_PROCESS_SCOPE_LAUNCH_UNPROVEN:WINDOWS_JOB_ABSENT_HELPER_IDENTITY_MISSING>WINDOWS_NATIVE_HELPER_GATE_FAILURE:INTEGRITY_CHECK",
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
    expect((failure as Error).message).toBe("WINDOWS_HELPER_HANDSHAKE_TIMEOUT:EBB_HELPER_READY");
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
