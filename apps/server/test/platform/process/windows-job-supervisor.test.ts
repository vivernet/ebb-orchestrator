import { afterEach, describe, expect, it, vi } from "vitest";
import { PassThrough, Writable } from "node:stream";
import { ProcessExecutor, type ProcessOptions, type ProcessResult, type ProcessSession } from "../../../src/platform/process/process-executor.js";
import { WindowsJobSupervisor } from "../../../src/platform/process/windows-job-supervisor.js";
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
  override startSession = vi.fn<ProcessExecutor["startSession"]>(() => {
    const stdin = new Writable({
      write: (chunk: Buffer | string, _encoding, callback) => {
        this.writes.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk));
        callback();
      },
    });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const completion = new Promise<ProcessResult>((resolve) => {
      stdin.once("close", () => resolve({ exitCode: 3, stdout: "", stderr: "" }));
    });
    const session: ProcessSession = { stdin, stdout, stderr, completion, terminate: () => undefined };
    queueMicrotask(() => {
      stdout.write("EBB_HELPER_READY\n");
      stdout.write(`EBB_SCOPE_READY\t${owner.containmentId}\t${owner.launchNonce}\t41\t100000000\t42\t200000000\tsha256:${"c".repeat(64)}\n`);
    });
    return session;
  });

  override async exec(_file: string, _args: string[], _options: ProcessOptions = {}): Promise<ProcessResult> {
    return { exitCode: 0, stdout: "STOPPED\tJOB_EMPTY\n", stderr: "" };
  }
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
  secret: "WindowsScopeSecretCanary_5A",
  timeoutMs: 10_000,
};

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

describe("WindowsJobSupervisor", () => {
  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
    vi.restoreAllMocks();
  });

  it("rejects credential-shaped child environment before starting the native helper", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    const executor = new FakeExecutor();
    const supervisor = new WindowsJobSupervisor(executor, "native-helper.exe");
    const unsafeRequest = {
      ...request,
      environment: { ...request.environment, AWS_SECRET_ACCESS_KEY: "must-not-be-forwarded" },
    };

    await expect(supervisor.launch(owner, unsafeRequest, async () => undefined))
      .rejects.toThrow("PROCESS_SCOPE_ENVIRONMENT_REJECTED");
    expect(executor.startSession).not.toHaveBeenCalled();
  });

  it("does not send the ResumeThread authorization byte when cancellation arrives during owner persistence", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    const executor = new HandshakeExecutor();
    const supervisor = new WindowsJobSupervisor(executor, "native-helper.exe");
    const abortController = new AbortController();

    await expect(supervisor.launch(owner, { ...request, signal: abortController.signal }, async () => {
      abortController.abort();
    })).rejects.toThrow("WINDOWS_PROCESS_SCOPE_LAUNCH_CANCELLED");

    expect(executor.startSession).toHaveBeenCalledTimes(1);
    expect(executor.writes).toHaveLength(2);
    expect(executor.writes).not.toContainEqual(Buffer.from([1]));
  });

  it("refuses a secret embedded in helper command or environment metadata", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    const executor = new FakeExecutor();
    const supervisor = new WindowsJobSupervisor(executor, "native-helper.exe");
    const unsafeRequest = { ...request, args: [...request.args, request.secret!] };

    await expect(supervisor.launch(owner, unsafeRequest, async () => undefined))
      .rejects.toThrow("PROCESS_SCOPE_SECRET_MUST_USE_STDIN");
    expect(executor.startSession).not.toHaveBeenCalled();
  });

  it("does not stop a live named Job whose persisted process identity differs", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    const output = [
      "LIVE", owner.containmentId, owner.launchNonce, "41", "100", "42", "200", `sha256:${"c".repeat(64)}`,
    ].join("\t");
    const executor = new InspectionExecutor(`${output}\n`);
    const supervisor = new WindowsJobSupervisor(executor, "native-helper.exe");
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
    const supervisor = new WindowsJobSupervisor(executor, "native-helper.exe");
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
    const supervisor = new WindowsJobSupervisor(executor, "native-helper.exe");

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
    const supervisor = new WindowsJobSupervisor(executor, "native-helper.exe");

    await expect(supervisor.inspect({
      ...owner,
      state: "STOPPED",
      supervisorPid: 41,
      supervisorStartIdentity: "123456789",
    })).resolves.toEqual({ state: "STOPPED", evidence: "WINDOWS_JOB_AND_HELPER_ABSENT" });
  });
});
