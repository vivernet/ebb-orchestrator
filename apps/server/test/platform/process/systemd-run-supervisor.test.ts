import { PassThrough, Writable } from "node:stream";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ExitCodeError,
  ProcessExecutor,
  type ProcessOptions,
  type ProcessResult,
  type ProcessSession,
  type ProcessSessionOptions,
} from "../../../src/platform/process/process-executor.js";
import {
  SystemdRunSupervisor,
} from "../../../src/platform/process/systemd-run-supervisor.js";
import type {
  ProcessScopeIdentity,
  SystemdScopeSnapshot,
} from "../../../src/platform/process/process-inspector.js";
import type { ProcessScopeLaunchRequest } from "../../../src/platform/process/run-scope-supervisor.js";
import { createHermesLaunchTicket } from "../../../src/modules/runtime/hermes/hermes-launch-ticket.js";

class FakeProcessExecutor extends ProcessExecutor {
  readonly execCalls: Array<{ file: string; args: string[]; options: ProcessOptions }> = [];
  sessionCall: { file: string; args: string[]; options: ProcessSessionOptions; session: ProcessSession } | undefined;
  sessionWrites: Buffer[] = [];
  private resolveCompletion: ((result: ProcessResult) => void) | undefined;
  private rejectCompletion: ((error: Error) => void) | undefined;
  onExec: ((file: string, args: string[]) => ProcessResult | Error | void) | undefined;

  override async exec(file: string, args: string[], options: ProcessOptions = {}): Promise<ProcessResult> {
    this.execCalls.push({ file, args: [...args], options });
    const result = this.onExec?.(file, args);
    if (result instanceof Error) throw result;
    if (result) return result;
    if (file === "systemctl" && args[1] === "is-system-running") {
      return { exitCode: 0, stdout: "running\n", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  override startSession(file: string, args: string[], options: ProcessSessionOptions = {}): ProcessSession {
    const stdin = new Writable({
      write: (chunk: Buffer | string, _encoding, callback) => {
        this.sessionWrites.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk));
        callback();
      },
    });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const completion = new Promise<ProcessResult>((resolve, reject) => {
      this.resolveCompletion = resolve;
      this.rejectCompletion = reject;
    });
    const session: ProcessSession = { stdin, stdout, stderr, completion, terminate: () => undefined };
    this.sessionCall = { file, args: [...args], options, session };
    return session;
  }

  finish(result: ProcessResult = { exitCode: 0, stdout: "dummy stdout", stderr: "" }): void {
    this.resolveCompletion?.(result);
  }

  fail(error: Error): void {
    this.rejectCompletion?.(error);
  }
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

const owner: ProcessScopeIdentity = {
  runId: "systemd-test-run",
  containmentKind: "systemd-user-service",
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

const exactControlGroup = "/user.slice/authoritative-readback/app.slice/actual-path.scope";

const launchRequest: ProcessScopeLaunchRequest = {
  executable: "dummy-hermes",
  args: ["--safe-mode"],
  cwd: "/tmp/ebb-worktree",
  environment: { HOME: "/tmp/ebb-profile", HERMES_HOME: "/tmp/ebb-profile" },
  timeoutMs: 10_000,
};

function liveSnapshot(): SystemdScopeSnapshot {
  return {
    managerQuerySucceeded: true,
    controlGroupSource: "unit-readback",
    expectedControlGroup: exactControlGroup,
    unitFound: true,
    pendingJob: false,
    activeState: "active",
    subState: "running",
    description: `ebb-orchestrator:${owner.launchNonce}`,
    invocationId: "12345678123456781234567812345678",
    controlGroup: exactControlGroup,
    mainPid: 4321,
    type: "exec",
    exitType: "cgroup",
    killMode: "control-group",
    delegate: "no",
    protectControlGroups: "yes",
    restart: "no",
    cgroupExists: true,
    cgroupReadable: true,
    cgroupPopulated: true,
    cgroupProcessIds: [4321, 4322],
  };
}

function absentSnapshot(recordedPath: string | null): SystemdScopeSnapshot {
  return {
    managerQuerySucceeded: true,
    controlGroupSource: recordedPath ? "persisted-owner" : null,
    expectedControlGroup: recordedPath,
    unitFound: false,
    pendingJob: false,
    activeState: null,
    subState: null,
    description: null,
    invocationId: null,
    controlGroup: null,
    mainPid: null,
    type: null,
    exitType: null,
    killMode: null,
    delegate: null,
    protectControlGroups: null,
    restart: null,
    cgroupExists: false,
    cgroupReadable: recordedPath !== null,
    cgroupPopulated: recordedPath === null ? null : false,
    cgroupProcessIds: [],
  };
}

describe("SystemdRunSupervisor", () => {
  let executor: FakeProcessExecutor;
  let supervisor: SystemdRunSupervisor;
  let unitState: "live" | "absent";

  beforeEach(() => {
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
    vi.stubEnv("PATH", "/usr/bin:/bin");
    vi.stubEnv("HOME", "/home/test-user");
    vi.stubEnv("XDG_RUNTIME_DIR", "/run/user/1000");
    vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus");
    vi.stubEnv("LANG", "en_US.UTF-8");
    vi.stubEnv("LC_ALL", "C.UTF-8");
    vi.stubEnv("SECRET_CANARY_IN_PARENT", "MUST_NOT_BE_INHERITED");
    unitState = "live";
    executor = new FakeProcessExecutor();
    supervisor = new SystemdRunSupervisor(executor);
    vi.spyOn(supervisor as unknown as { cgroupFilesystemType(): Promise<number> }, "cgroupFilesystemType")
      .mockResolvedValue(0x63677270);
    vi.spyOn(supervisor as unknown as { assertNativePrerequisites(): Promise<void> }, "assertNativePrerequisites")
      .mockResolvedValue();
    vi.spyOn(supervisor as unknown as {
      readSnapshot(owner: ProcessScopeIdentity, unitName: string, recordedGroup: string | null): Promise<SystemdScopeSnapshot>;
    }, "readSnapshot").mockImplementation(async (_owner, _unitName, recordedGroup) =>
      unitState === "live" ? liveSnapshot() : absentSnapshot(recordedGroup));
    executor.onExec = (file, args) => {
      if (file === "systemctl" && args.includes("stop")) unitState = "absent";
    };
  });

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("holds the provider-free dummy payload behind owner authorization without a credential frame", async () => {
    let persistedIdentity: ProcessScopeIdentity | undefined;
    const handle = await supervisor.launch(owner, launchRequest, async (identity) => {
      persistedIdentity = identity;
    });

    const call = executor.sessionCall;
    expect(call?.file).toBe("systemd-run");
    expect(persistedIdentity).toMatchObject({
      state: "LIVE", systemdInvocationId: "12345678123456781234567812345678",
      systemdControlGroup: exactControlGroup,
    });
    expect(call?.args.join(" ")).toContain("--property=Type=exec");
    expect(call?.args.join(" ")).toContain("--property=ExitType=cgroup");
    expect(call?.args.join(" ")).toContain("--property=KillMode=control-group");
    expect(call?.args.join(" ")).toContain("--property=Delegate=no");
    expect(call?.args.join(" ")).toContain("--property=ProtectControlGroups=yes");
    expect(call?.args.join(" ")).toContain("--property=Restart=no");
    expect(call?.args).toContain("--collect");
    expect(call?.args.join(" ")).not.toContain("EBB_HERMES_PROVIDER_API_KEY");
    expect(call?.args.join(" ")).not.toContain("...process.env");
    expect(call?.options.env).toMatchObject({
      PATH: "/usr/bin:/bin", HOME: "/home/test-user", XDG_RUNTIME_DIR: "/run/user/1000",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    });
    expect(call?.options.env).not.toHaveProperty("SECRET_CANARY_IN_PARENT");
    expect(call?.options.env).not.toHaveProperty("EBB_HERMES_PROVIDER_API_KEY");

    const written = Buffer.concat(executor.sessionWrites);
    expect(written).toEqual(Buffer.from([1]));

    unitState = "absent";
    executor.finish();
    await expect(handle.completion).resolves.toMatchObject({ exitCode: 0, stdout: "dummy stdout" });
  });

  it("routes a ticketed Linux Hermes run through the pinned native launcher and verifies its digest in the wrapper", async () => {
    const runId = "123e4567-e89b-42d3-a456-426614174000";
    const profileHome = `/home/test-user/.hermes/profiles/ebb-orchestrator-run-${runId}`;
    const pythonPath = "/opt/hermes/venv/bin/python";
    const argsPrefix = ["-I", "-B", "-S", "-c", "pinned-hermes-bootstrap"];
    const hermesSourceSnapshotKey = JSON.stringify({
      formatVersion: 1,
      hermesVersion: "v0.21.5+9117.g08165d5",
      manifestDigest: "a".repeat(64),
      sourceCommit: "b".repeat(40),
      sourceTree: "c".repeat(40),
    });
    const sourceSnapshotDirectoryId = createHash("sha256").update(hermesSourceSnapshotKey).digest("hex");
    const sourceSnapshotRoot = `/var/lib/ebb/runtime/hermes/source-snapshots/${sourceSnapshotDirectoryId}`;
    const ticket = createHermesLaunchTicket({
      runId,
      attempt: 0,
      platform: "linux",
      hermesExecutablePath: "/opt/hermes/bin/hermes",
      hermesExecutableIdentity: { platform: "linux", device: "8", inode: "10" },
      executablePath: pythonPath,
      executableIdentity: { platform: "linux", device: "8", inode: "11" },
      executableArgsPrefix: argsPrefix,
      profileHome,
      profileHomeIdentity: { platform: "linux", device: "8", inode: "12" },
      hermesSourceSnapshotKey,
      hermesSourceSnapshotRoot: sourceSnapshotRoot,
      hermesSourceSnapshotRootIdentity: { platform: "linux", device: "8", inode: "13" },
      hermesSourceManifestDigest: "a".repeat(64),
      hermesSourceProjectionPath: `${sourceSnapshotRoot}.native-v1.bin`,
      hermesSourceProjectionSha256: "d".repeat(64),
      hermesSourceProjectionSize: 128,
      environment: {
        HERMES_HOME: profileHome,
        HOME: `${profileHome}/home`,
        HERMES_CONFIG: `${profileHome}/config.yaml`,
      },
    });
    const hermesRequest: ProcessScopeLaunchRequest = {
      ...launchRequest,
      attempt: 0,
      executable: pythonPath,
      args: [...argsPrefix, "chat", "--query-file", "/tmp/request.md", "--source", runId],
      environment: {
        HERMES_HOME: profileHome,
        HOME: `${profileHome}/home`,
        HERMES_CONFIG: `${profileHome}/config.yaml`,
      },
      hermesLaunchTicket: ticket,
    };
    const launchNonce = "c".repeat(64);
    const hermesOwner = { ...owner, runId, launchNonce };
    const nativeHelperDigest = "d".repeat(64);
    const helperPath = "/server/dist/native/linux-hermes-launcher/ebb-linux-hermes-launcher";
    const digestLoader = vi.fn(async () => nativeHelperDigest);
    supervisor = new SystemdRunSupervisor(executor, {
      linuxHermesLauncherPath: helperPath,
      loadLinuxHermesLauncherDigest: digestLoader,
    });
    vi.spyOn(supervisor as unknown as { assertNativePrerequisites(): Promise<void> }, "assertNativePrerequisites")
      .mockResolvedValue();
    vi.spyOn(supervisor as unknown as {
      readSnapshot(owner: ProcessScopeIdentity, unitName: string, recordedGroup: string | null): Promise<SystemdScopeSnapshot>;
    }, "readSnapshot").mockImplementation(async (_owner, _unitName, recordedGroup) =>
      unitState === "live"
        ? { ...liveSnapshot(), description: `ebb-orchestrator:${hermesOwner.launchNonce}` }
        : absentSnapshot(recordedGroup));
    unitState = "live";

    const handle = await supervisor.launch(hermesOwner, hermesRequest, async () => undefined);

    const call = executor.sessionCall;
    expect(digestLoader).toHaveBeenCalledOnce();
    expect(call?.args).toContain(helperPath);
    expect(call?.args).toContain("--verified-linux-hermes-helper");
    expect(call?.args).toContain(nativeHelperDigest);
      expect(call?.args).toContain("--run-hermes");
      expect(call?.args).toContain(runId);
      expect(call?.args).toContain(launchNonce);
      expect(call?.args).toContain(profileHome);
      expect(call?.args).toContain(sourceSnapshotRoot);
      expect(call?.args).toContain("13");
      expect(call?.args).toContain(`${sourceSnapshotRoot}.native-v1.bin`);
      expect(call?.args).toContain("d".repeat(64));
      expect(call?.args).toContain("128");
      expect(call?.args).toContain(hermesSourceSnapshotKey);
    expect(call?.args).toContain("12");
    expect(call?.args).toContain(pythonPath);
    expect(call?.args).toContain("11");
    expect(call?.args).toContain("pinned-hermes-bootstrap");
    expect(call?.args).toContain("/opt/hermes/bin/hermes");
    expect(call?.args.join(" ")).toContain("/proc/self/fd/3");
    expect(call?.args.join(" ")).toContain("openSync");
    expect(call?.args.join(" ")).toContain("createHash");
    expect(call?.options.env).not.toHaveProperty("SECRET_CANARY_IN_PARENT");

    unitState = "absent";
    executor.finish();
    await expect(handle.completion).resolves.toMatchObject({ exitCode: 0 });
  });

  it("forwards live payload chunks and suppresses all process output from its completion result", async () => {
    const chunks: string[] = [];
    const handle = await supervisor.launch(owner, {
      ...launchRequest,
      captureOutput: false,
      onStdoutChunk: async (chunk) => { chunks.push(Buffer.from(chunk).toString("utf8")); },
    }, async () => undefined);
    const payload = '{"type":"system","subtype":"init","session_id":"session-live"}\n';
    (executor.sessionCall?.session.stdout as PassThrough | undefined)?.write(Buffer.from(payload).subarray(0, 19));
    (executor.sessionCall?.session.stdout as PassThrough | undefined)?.write(Buffer.from(payload).subarray(19));

    unitState = "absent";
    executor.finish({ exitCode: 0, stdout: payload, stderr: "private diagnostic" });
    const result = await handle.completion;

    expect(chunks.join("")).toBe(payload);
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(executor.sessionCall?.options.captureOutput).toBe(false);
  });

  it("rejects and stops the exact scope when stdout errors after a successful init callback", async () => {
    const payload = '{"type":"system","subtype":"init","session_id":"session-before-error"}\n';
    const executor = new FakeProcessExecutor();
    const supervisor = new SystemdRunSupervisor(executor);
    vi.spyOn(supervisor as unknown as { assertNativePrerequisites(): Promise<void> }, "assertNativePrerequisites")
      .mockResolvedValue();
    vi.spyOn(supervisor as unknown as {
      readSnapshot(owner: ProcessScopeIdentity, unitName: string, recordedGroup: string | null): Promise<SystemdScopeSnapshot>;
    }, "readSnapshot").mockImplementation(async (_owner, _unitName, recordedGroup) =>
      unitState === "live" ? liveSnapshot() : absentSnapshot(recordedGroup));
    executor.onExec = (file, args) => {
      if (file === "systemctl" && args.includes("stop")) unitState = "absent";
    };
    const callbackDone = deferred();
    const chunks: string[] = [];
    const handle = await supervisor.launch(owner, {
      ...launchRequest,
      onStdoutChunk: async (chunk) => { chunks.push(Buffer.from(chunk).toString("utf8")); callbackDone.resolve(); },
    }, async () => undefined);
    const stdout = executor.sessionCall?.session.stdout as PassThrough;
    stdout.write(payload);
    await callbackDone.promise;
    let escapedStreamError = false;
    try { stdout.emit("error", new Error("injected stdout transport failure")); }
    catch { escapedStreamError = true; }
    executor.finish();

    await expect(handle.completion).rejects.toThrow("SYSTEMD_PROCESS_STDOUT_FAILED");
    expect(escapedStreamError).toBe(false);
    expect(chunks.join("")).toBe(payload);
    expect(executor.execCalls.some((call) => call.file === "systemctl" && call.args.includes("stop"))).toBe(true);
    expect(unitState).toBe("absent");
  });

  it("drains a deferred stdout callback before rejecting completion", async () => {
    const entered = deferred();
    const release = deferred();
    const handle = await supervisor.launch(owner, {
      ...launchRequest,
      onStdoutChunk: async () => { entered.resolve(); await release.promise; },
    }, async () => undefined);
    (executor.sessionCall?.session.stdout as PassThrough).write("queued payload");
    await entered.promise;
    executor.fail(new Error("injected wrapper completion failure"));
    let settled = false;
    const settledCompletion = handle.completion.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    release.resolve();
    await settledCompletion;
    expect(settled).toBe(true);
    expect(unitState).toBe("absent");
  });

  it("exec-replaces env with only explicit Hermes allowlist variables before starting the wrapper", async () => {
    const handle = await supervisor.launch(owner, launchRequest, async () => undefined);
    const call = executor.sessionCall;
    const commandStart = call?.args.indexOf("--") ?? -1;
    const nodeIndex = call?.args.indexOf(process.execPath) ?? -1;

    expect(commandStart).toBeGreaterThan(-1);
    expect(call?.args.slice(commandStart, commandStart + 3)).toEqual(["--", "/usr/bin/env", "-i"]);
    expect(nodeIndex).toBeGreaterThan(commandStart + 2);
    expect(call?.args[nodeIndex + 1]).toBe("-e");
    expect(call?.args).toContain("PATH=/usr/bin:/bin");
    expect(call?.args).toContain(`HOME=${launchRequest.environment.HOME}`);
    expect(call?.args).toContain(`HERMES_HOME=${launchRequest.environment.HERMES_HOME}`);
    expect(call?.args.some((argument) => argument.startsWith("--setenv="))).toBe(false);
    expect(call?.args.join(" ")).not.toContain("SECRET_CANARY_IN_PARENT");
    expect(call?.options.env).not.toHaveProperty("UNLISTED_PROVIDER_TOKEN");

    unitState = "absent";
    executor.finish();
    await expect(handle.completion).resolves.toMatchObject({ exitCode: 0 });
  });

  it("disables systemd argument expansion before passing JavaScript template expressions to the payload", async () => {
    const payloadScript = "process.stdout.write(`${process.ppid}`)";
    const request = {
      ...launchRequest,
      executable: process.execPath,
      args: ["-e", payloadScript],
    };

    const handle = await supervisor.launch(owner, request, async () => undefined);

    const args = executor.sessionCall?.args ?? [];
    const separatorIndex = args.indexOf("--");
    const expansionOptionIndex = args.indexOf("--expand-environment=no");
    expect(expansionOptionIndex).toBeGreaterThanOrEqual(0);
    expect(expansionOptionIndex).toBeLessThan(separatorIndex);
    expect(args.slice(-3)).toEqual([process.execPath, "-e", payloadScript]);

    unitState = "absent";
    executor.finish();
    await expect(handle.completion).resolves.toMatchObject({ exitCode: 0 });
  });

  it("normalizes a trailing slash in XDG_RUNTIME_DIR before validating and passing the session bus", async () => {
    vi.stubEnv("XDG_RUNTIME_DIR", "/run/user/1000/");

    const handle = await supervisor.launch(owner, launchRequest, async () => undefined);

    expect(executor.sessionCall?.options.env).toMatchObject({
      XDG_RUNTIME_DIR: "/run/user/1000",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    });
    unitState = "absent";
    executor.finish();
    await expect(handle.completion).resolves.toMatchObject({ exitCode: 0 });
  });

  it("withholds the launch authorization byte when cancellation arrives during durable identity persistence", async () => {
    const abortController = new AbortController();
    const request = { ...launchRequest, signal: abortController.signal };

    await expect(supervisor.launch(owner, request, async () => {
      abortController.abort();
    })).rejects.toThrow("PROCESS_SCOPE_LAUNCH_CANCELLED");

    const written = Buffer.concat(executor.sessionWrites);
    expect(written.subarray(written.length - 1)).not.toEqual(Buffer.from([1]));
    expect(unitState).toBe("absent");
    expect(executor.execCalls.some((call) => call.file === "systemctl" && call.args.includes("stop"))).toBe(true);
  });

  it("stops the exact named scope and requires empty-cgroup readback", async () => {
    const observation = await supervisor.stop({ ...owner, systemdControlGroup: exactControlGroup, state: "LIVE" });
    expect(executor.execCalls).toContainEqual(expect.objectContaining({
      file: "systemctl", args: ["--user", "stop", `ebb-orchestrator-run-${owner.containmentId}.service`],
      options: expect.objectContaining({ env: expect.objectContaining({ XDG_RUNTIME_DIR: "/run/user/1000" }) }),
    }));
    expect(observation).toMatchObject({ state: "STOPPED", evidence: "UNIT_ABSENT_NO_PENDING_CGROUP_ABSENT" });
  });

  it("keeps unit-not-found UNKNOWN until an exact ControlGroup was durably observed", async () => {
    const snapshotReader = supervisor as unknown as {
      readSnapshot(owner: ProcessScopeIdentity, unitName: string, recordedGroup: string | null): Promise<SystemdScopeSnapshot>;
    };
    vi.mocked(snapshotReader.readSnapshot).mockRestore();
    executor.onExec = (_file, args) => {
      if (args[1] === "show") return { exitCode: 0, stdout: "LoadState=not-found\n", stderr: "" };
      if (args[1] === "list-jobs") return { exitCode: 0, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const observation = await supervisor.inspect(owner);
    expect(observation).toMatchObject({ state: "UNKNOWN", reason: "SYSTEMD_UNIT_ABSENCE_UNPROVEN" });
    expect(executor.execCalls.some((call) => call.args.includes("user@1000.service"))).toBe(false);
    expect(executor.execCalls.every((call) => call.options.env?.XDG_RUNTIME_DIR === "/run/user/1000")).toBe(true);
  });

  it("distinguishes a failed same-user manager query from a confirmed missing unit", async () => {
    const snapshotReader = supervisor as unknown as {
      readSnapshot(owner: ProcessScopeIdentity, unitName: string, recordedGroup: string | null): Promise<SystemdScopeSnapshot>;
    };
    vi.mocked(snapshotReader.readSnapshot).mockRestore();
    executor.onExec = (_file, args) => {
      if (args[1] === "show") return new Error("systemd manager unavailable");
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const observation = await supervisor.inspect({ ...owner, systemdControlGroup: exactControlGroup });
    expect(observation).toMatchObject({ state: "UNKNOWN", reason: "SYSTEMD_MANAGER_QUERY_UNAVAILABLE" });
    expect(executor.execCalls).toHaveLength(1);
  });

  it("fails launch immediately when systemctl show cannot verify the unit, without persisting identity or authorizing payload", async () => {
    const snapshotReader = supervisor as unknown as {
      readSnapshot(owner: ProcessScopeIdentity, unitName: string, recordedGroup: string | null): Promise<SystemdScopeSnapshot>;
    };
    vi.mocked(snapshotReader.readSnapshot).mockRestore();
    executor.onExec = (_file, args) => args[1] === "show"
      ? new Error("private manager endpoint /run/user/1000/bus unavailable")
      : undefined;
    const persistIdentity = vi.fn(async () => undefined);

    await expect(supervisor.launch(owner, launchRequest, persistIdentity))
      .rejects.toThrow("PROCESS_SCOPE_LAUNCH_IDENTITY_UNVERIFIED");

    expect(persistIdentity).not.toHaveBeenCalled();
    expect(Buffer.concat(executor.sessionWrites)).not.toContain(1);
    expect(executor.execCalls.filter((call) => call.args[1] === "show")).toHaveLength(2);
    expect(executor.execCalls.filter((call) => call.args[1] === "list-jobs")).toHaveLength(0);
  });

  it("retries a list-jobs inspection failure and authorizes only after LIVE membership is verified", async () => {
    const snapshotReader = supervisor as unknown as {
      readSnapshot(owner: ProcessScopeIdentity, unitName: string, recordedGroup: string | null): Promise<SystemdScopeSnapshot>;
    };
    vi.mocked(snapshotReader.readSnapshot).mockRestore();
    let pendingJobQueries = 0;
    executor.onExec = (_file, args) => {
      if (args[1] === "show") return { exitCode: 0, stdout: "LoadState=not-found\n", stderr: "" };
      if (args[1] === "list-jobs") {
        pendingJobQueries += 1;
        return pendingJobQueries === 1
          ? new Error("temporary private manager transport error")
          : { exitCode: 0, stdout: "", stderr: "" };
      }
      return undefined;
    };
    const identity: ProcessScopeIdentity = {
      ...owner,
      systemdInvocationId: "12345678123456781234567812345678",
      systemdControlGroup: exactControlGroup,
      pid: 4321,
      platform: "linux",
      state: "LIVE",
    };
    const inspectLiveIdentity = supervisor.inspect.bind(supervisor);
    const inspectSpy = vi.spyOn(supervisor, "inspect");
    inspectSpy.mockImplementationOnce((input) => inspectLiveIdentity(input));
    inspectSpy.mockResolvedValueOnce({ state: "LIVE", identity });
    const persistenceOrder: string[] = [];

    const handle = await supervisor.launch(owner, launchRequest, async () => {
      persistenceOrder.push("identity-persisted");
    });

    expect(pendingJobQueries).toBe(1);
    expect(persistenceOrder).toEqual(["identity-persisted"]);
    expect(Buffer.concat(executor.sessionWrites)).toEqual(Buffer.from([1]));
    unitState = "absent";
    executor.finish();
    await expect(handle.completion).resolves.toMatchObject({ exitCode: 0 });
  });

  it("reports prerequisite inspection failures with a fixed code and no exception details", async () => {
    vi.spyOn(supervisor as unknown as { assertNativePrerequisites(): Promise<void> }, "assertNativePrerequisites")
      .mockRejectedValue(new Error("secret /home/private stderr payload"));

    const observation = await supervisor.inspect({ ...owner, systemdControlGroup: exactControlGroup });

    expect(observation).toEqual({ state: "UNKNOWN", reason: "SYSTEMD_PREREQUISITE_CHECK_UNAVAILABLE" });
    expect(JSON.stringify(observation)).not.toMatch(/secret|private|stderr|home/u);
  });

  it.each([
    {
      name: "cgroup statfs failure",
      configure: () => {
        const filesystemProbe = supervisor as unknown as { cgroupFilesystemType(): Promise<number> };
        vi.mocked(filesystemProbe.cgroupFilesystemType).mockRejectedValue(new Error("private /sys/fs/cgroup failure"));
      },
      expectedReason: "SYSTEMD_CGROUP_STATFS_UNAVAILABLE",
    },
    {
      name: "cgroup v2 mismatch",
      configure: () => {
        const filesystemProbe = supervisor as unknown as { cgroupFilesystemType(): Promise<number> };
        vi.mocked(filesystemProbe.cgroupFilesystemType).mockResolvedValue(0x1234);
      },
      expectedReason: "SYSTEMD_CGROUP_V2_REQUIRED",
    },
    {
      name: "manager environment validation failure",
      configure: () => vi.stubEnv("XDG_RUNTIME_DIR", "relative-private-runtime"),
      expectedReason: "SYSTEMD_MANAGER_ENVIRONMENT_INVALID",
    },
    {
      name: "systemd manager status check failure",
      configure: () => {
        executor.onExec = (_file, args) => args[1] === "is-system-running"
          ? new Error("private stderr /home/secret")
          : undefined;
      },
      expectedReason: "SYSTEMD_MANAGER_STATUS_CHECK_UNAVAILABLE",
    },
  ])("reports a sanitized prerequisite reason for $name", async ({ configure, expectedReason }) => {
    vi.spyOn(supervisor as unknown as { assertNativePrerequisites(): Promise<void> }, "assertNativePrerequisites")
      .mockRestore();
    configure();

    const observation = await supervisor.inspect({ ...owner, systemdControlGroup: exactControlGroup });

    expect(observation).toEqual({ state: "UNKNOWN", reason: expectedReason });
    expect(JSON.stringify(observation)).not.toMatch(/private|secret|stderr|home|runtime/iu);
  });

  it.each([
    ["initializing", "SYSTEMD_MANAGER_STATE_INITIALIZING"],
    ["starting", "SYSTEMD_MANAGER_STATE_STARTING"],
    ["maintenance", "SYSTEMD_MANAGER_STATE_MAINTENANCE"],
    ["stopping", "SYSTEMD_MANAGER_STATE_STOPPING"],
    ["offline", "SYSTEMD_MANAGER_STATE_OFFLINE"],
    ["unknown", "SYSTEMD_MANAGER_STATE_UNKNOWN"],
  ])("maps the exact systemd manager state %s to a fixed diagnostic", async (state, expectedReason) => {
    vi.spyOn(supervisor as unknown as { assertNativePrerequisites(): Promise<void> }, "assertNativePrerequisites")
      .mockRestore();
    executor.onExec = (_file, args) => args[1] === "is-system-running"
      ? new ExitCodeError("systemctl", 1, `  ${state}  \n`, "private stderr")
      : undefined;

    const observation = await supervisor.inspect({ ...owner, systemdControlGroup: exactControlGroup });

    expect(observation).toEqual({ state: "UNKNOWN", reason: expectedReason });
    expect(JSON.stringify(observation)).not.toContain(`  ${state}  `);
    expect(JSON.stringify(observation)).not.toMatch(/private|stderr/iu);
  });

  it("uses the generic systemd manager status-check code for arbitrary exit output", async () => {
    vi.spyOn(supervisor as unknown as { assertNativePrerequisites(): Promise<void> }, "assertNativePrerequisites")
      .mockRestore();
    executor.onExec = (_file, args) => args[1] === "is-system-running"
      ? new ExitCodeError("systemctl", 1, "custom /home/private detail", "private stderr")
      : undefined;

    const observation = await supervisor.inspect({ ...owner, systemdControlGroup: exactControlGroup });

    expect(observation).toEqual({ state: "UNKNOWN", reason: "SYSTEMD_MANAGER_STATUS_CHECK_UNAVAILABLE" });
    expect(JSON.stringify(observation)).not.toMatch(/custom|private|stderr|home/iu);
  });

  it.each(["result", "ExitCodeError"] as const)(
    "accepts degraded only as manager responsiveness for a %s result, then requires identity readback",
    async (failureKind) => {
      vi.spyOn(supervisor as unknown as { assertNativePrerequisites(): Promise<void> }, "assertNativePrerequisites")
        .mockRestore();
      const snapshotReader = supervisor as unknown as {
        readSnapshot(owner: ProcessScopeIdentity, unitName: string, recordedGroup: string | null): Promise<SystemdScopeSnapshot>;
      };
      const readSnapshot = vi.mocked(snapshotReader.readSnapshot);
      readSnapshot.mockResolvedValue({ ...liveSnapshot(), description: "ebb-orchestrator:other-owner" });
      executor.onExec = (_file, args) => args[1] === "is-system-running"
        ? failureKind === "result"
          ? { exitCode: 1, stdout: "degraded\n", stderr: "private stderr" }
          : new ExitCodeError("systemctl", 1, "degraded\n", "private stderr")
        : undefined;

      const observation = await supervisor.inspect({ ...owner, systemdControlGroup: exactControlGroup });

      expect(readSnapshot).toHaveBeenCalledOnce();
      expect(observation).toEqual({ state: "UNKNOWN", reason: "SYSTEMD_IDENTITY_MISMATCH" });
      expect(JSON.stringify(observation)).not.toMatch(/private|stderr/iu);
    },
  );

  it.each(["__proto__", "constructor", "toString"])(
    "does not treat inherited property %s as a systemd state",
    async (state) => {
      vi.spyOn(supervisor as unknown as { assertNativePrerequisites(): Promise<void> }, "assertNativePrerequisites")
        .mockRestore();
      executor.onExec = (_file, args) => args[1] === "is-system-running"
        ? new ExitCodeError("systemctl", 1, state, "private stderr")
        : undefined;

      const observation = await supervisor.inspect({ ...owner, systemdControlGroup: exactControlGroup });

      expect(observation).toEqual({ state: "UNKNOWN", reason: "SYSTEMD_MANAGER_STATUS_CHECK_UNAVAILABLE" });
      expect(JSON.stringify(observation)).not.toContain(state);
      expect(JSON.stringify(observation)).not.toContain("private");
    },
  );

  it("accepts exact running success but still requires identity readback", async () => {
    vi.spyOn(supervisor as unknown as { assertNativePrerequisites(): Promise<void> }, "assertNativePrerequisites")
      .mockRestore();
    const snapshotReader = supervisor as unknown as {
      readSnapshot(owner: ProcessScopeIdentity, unitName: string, recordedGroup: string | null): Promise<SystemdScopeSnapshot>;
    };
    const readSnapshot = vi.mocked(snapshotReader.readSnapshot);
    readSnapshot.mockResolvedValue({ ...liveSnapshot(), description: "ebb-orchestrator:other-owner" });
    executor.onExec = (_file, args) => args[1] === "is-system-running"
      ? { exitCode: 0, stdout: "running\n", stderr: "" }
      : undefined;

    const observation = await supervisor.inspect({ ...owner, systemdControlGroup: exactControlGroup });

    expect(readSnapshot).toHaveBeenCalledOnce();
    expect(observation).toEqual({ state: "UNKNOWN", reason: "SYSTEMD_IDENTITY_MISMATCH" });
  });

  it.each(["", "unrecognized-state"])(
    "fails closed when exit zero has empty or unknown status output (%j)",
    async (stdout) => {
      vi.spyOn(supervisor as unknown as { assertNativePrerequisites(): Promise<void> }, "assertNativePrerequisites")
        .mockRestore();
      const snapshotReader = supervisor as unknown as {
        readSnapshot(owner: ProcessScopeIdentity, unitName: string, recordedGroup: string | null): Promise<SystemdScopeSnapshot>;
      };
      const readSnapshot = vi.mocked(snapshotReader.readSnapshot);
      executor.onExec = (_file, args) => args[1] === "is-system-running"
        ? { exitCode: 0, stdout, stderr: "private stderr" }
        : undefined;

      const observation = await supervisor.inspect({ ...owner, systemdControlGroup: exactControlGroup });

      expect(readSnapshot).not.toHaveBeenCalled();
      expect(observation).toEqual({ state: "UNKNOWN", reason: "SYSTEMD_MANAGER_STATUS_CHECK_UNAVAILABLE" });
      expect(JSON.stringify(observation)).not.toMatch(/private|stderr|unrecognized/iu);
    },
  );

  it("keeps retrying the phase-specific inspection errors that can occur during unit activation", async () => {
    const identity: ProcessScopeIdentity = {
      ...owner,
      systemdInvocationId: "12345678123456781234567812345678",
      systemdControlGroup: exactControlGroup,
      pid: 4321,
      platform: "linux",
      state: "LIVE",
    };
    vi.spyOn(supervisor, "inspect")
      .mockResolvedValueOnce({ state: "UNKNOWN", reason: "SYSTEMD_UNIT_CONTROL_GROUP_UNAVAILABLE" })
      .mockResolvedValueOnce({ state: "LIVE", identity });

    const persisted = vi.fn(async () => undefined);
    const handle = await supervisor.launch(owner, launchRequest, persisted);

    expect(persisted).toHaveBeenCalledWith(identity);
    expect(Buffer.concat(executor.sessionWrites)).toEqual(Buffer.from([1]));
    unitState = "absent";
    executor.finish();
    await expect(handle.completion).resolves.toMatchObject({ exitCode: 0 });
  });

  it("reports an unexpected systemd load state with a fixed readback code", async () => {
    const snapshotReader = supervisor as unknown as {
      readSnapshot(owner: ProcessScopeIdentity, unitName: string, recordedGroup: string | null): Promise<SystemdScopeSnapshot>;
    };
    vi.mocked(snapshotReader.readSnapshot).mockRestore();
    executor.onExec = (_file, args) => args[1] === "show"
      ? { exitCode: 0, stdout: "LoadState=unloading\n", stderr: "secret stderr" }
      : undefined;

    const observation = await supervisor.inspect({ ...owner, systemdControlGroup: exactControlGroup });

    expect(observation).toEqual({ state: "UNKNOWN", reason: "SYSTEMD_UNIT_LOAD_STATE_UNVERIFIED" });
    expect(JSON.stringify(observation)).not.toMatch(/secret|stderr|unloading/u);
  });

  it("reports an empty loaded-unit ControlGroup without inferring STOPPED", async () => {
    const snapshotReader = supervisor as unknown as {
      readSnapshot(owner: ProcessScopeIdentity, unitName: string, recordedGroup: string | null): Promise<SystemdScopeSnapshot>;
    };
    vi.mocked(snapshotReader.readSnapshot).mockRestore();
    executor.onExec = (_file, args) => args[1] === "show"
      ? { exitCode: 0, stdout: "LoadState=loaded\nActiveState=failed\nControlGroup=\n", stderr: "" }
      : undefined;

    const observation = await supervisor.inspect({ ...owner, systemdControlGroup: exactControlGroup });

    expect(observation).toEqual({ state: "UNKNOWN", reason: "SYSTEMD_UNIT_CONTROL_GROUP_UNAVAILABLE" });
  });

  it("retries transient empty ControlGroup readback while waiting for cgroup-backed STOPPED proof", async () => {
    vi.useFakeTimers();
    const inspect = vi.spyOn(supervisor, "inspect")
      .mockResolvedValueOnce({ state: "UNKNOWN", reason: "SYSTEMD_UNIT_CONTROL_GROUP_UNAVAILABLE" })
      .mockResolvedValueOnce({ state: "STOPPED", evidence: "SYSTEMD_CGROUP_EMPTY" });

    const waiting = supervisor.waitForStopped(owner, 2_000);
    await vi.advanceTimersByTimeAsync(500);
    await expect(waiting).resolves.toEqual({ state: "STOPPED", evidence: "SYSTEMD_CGROUP_EMPTY" });
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it("does not convert a persistent empty ControlGroup into STOPPED when bounded polling expires", async () => {
    vi.useFakeTimers();
    const inspect = vi.spyOn(supervisor, "inspect")
      .mockResolvedValue({ state: "UNKNOWN", reason: "SYSTEMD_UNIT_CONTROL_GROUP_UNAVAILABLE" });

    const waiting = supervisor.waitForStopped(owner, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(waiting).resolves.toEqual({ state: "UNKNOWN", reason: "SYSTEMD_STOP_TIMEOUT" });
    expect(inspect).toHaveBeenCalledTimes(3);
  });

  it("reports pending-job inspection failures with a fixed code and no command details", async () => {
    const snapshotReader = supervisor as unknown as {
      readSnapshot(owner: ProcessScopeIdentity, unitName: string, recordedGroup: string | null): Promise<SystemdScopeSnapshot>;
    };
    vi.mocked(snapshotReader.readSnapshot).mockRestore();
    executor.onExec = (_file, args) => {
      if (args[1] === "show") return { exitCode: 0, stdout: "LoadState=not-found\n", stderr: "" };
      if (args[1] === "list-jobs") return new Error("secret unit path /private/unit stderr");
      return undefined;
    };

    const observation = await supervisor.inspect({ ...owner, systemdControlGroup: exactControlGroup });

    expect(observation).toEqual({ state: "UNKNOWN", reason: "SYSTEMD_PENDING_JOB_QUERY_UNAVAILABLE" });
    expect(JSON.stringify(observation)).not.toMatch(/secret|private|stderr/u);
  });

  it("treats the exact unit in systemctl list-jobs column two as pending", async () => {
    const snapshotReader = supervisor as unknown as {
      readSnapshot(owner: ProcessScopeIdentity, unitName: string, recordedGroup: string | null): Promise<SystemdScopeSnapshot>;
    };
    vi.mocked(snapshotReader.readSnapshot).mockRestore();
    executor.onExec = (_file, args) => {
      if (args[1] === "show") return { exitCode: 0, stdout: "LoadState=not-found\n", stderr: "" };
      if (args[1] === "list-jobs") {
        return { exitCode: 0, stdout: `63 ebb-orchestrator-run-${owner.containmentId}.service start waiting\n`, stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const observation = await supervisor.inspect({ ...owner, systemdControlGroup: exactControlGroup });

    expect(observation).toMatchObject({ state: "UNKNOWN", reason: "SYSTEMD_UNIT_ABSENCE_UNPROVEN" });
    expect(executor.execCalls.some((call) => call.args[1] === "list-jobs")).toBe(true);
  });

  it("does not treat a different unit in systemctl list-jobs as pending", async () => {
    const snapshotReader = supervisor as unknown as {
      readSnapshot(owner: ProcessScopeIdentity, unitName: string, recordedGroup: string | null): Promise<SystemdScopeSnapshot>;
    };
    vi.mocked(snapshotReader.readSnapshot).mockRestore();
    executor.onExec = (_file, args) => {
      if (args[1] === "show") return { exitCode: 0, stdout: "LoadState=not-found\n", stderr: "" };
      if (args[1] === "list-jobs") return { exitCode: 0, stdout: "64 unrelated.service start waiting\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const observation = await supervisor.inspect({ ...owner, systemdControlGroup: exactControlGroup });

    expect(observation).toMatchObject({ state: "STOPPED", evidence: "UNIT_ABSENT_NO_PENDING_CGROUP_ABSENT" });
    expect(executor.execCalls.some((call) => call.args[1] === "list-jobs")).toBe(true);
  });

  it("does not stop a unit when readback identity or nonce mismatches", async () => {
    vi.spyOn(supervisor as unknown as {
      readSnapshot(owner: ProcessScopeIdentity, unitName: string, recordedGroup: string | null): Promise<SystemdScopeSnapshot>;
    }, "readSnapshot").mockResolvedValue({
      ...liveSnapshot(), description: "ebb-orchestrator:another-launch-nonce",
    });

    const observation = await supervisor.stop({ ...owner, systemdControlGroup: exactControlGroup, state: "LIVE" });
    expect(observation).toMatchObject({ state: "UNKNOWN" });
    expect(executor.execCalls.some((call) => call.file === "systemctl" && call.args.includes("stop"))).toBe(false);
  });

  it("stops before returning when the durable identity callback rejects and never sends the payload ACK", async () => {
    await expect(supervisor.launch(owner, launchRequest, async () => {
      throw new Error("owner persistence rejected");
    })).rejects.toThrow("owner persistence rejected");

    expect(executor.sessionCall).toBeDefined();
    expect(executor.execCalls.some((call) => call.args.includes("stop"))).toBe(true);
    expect(executor.sessionWrites).not.toContainEqual(Buffer.from([1]));
    expect(unitState).toBe("absent");
  });

  it("rejects untrusted manager environment before spawning systemd-run", async () => {
    vi.stubEnv("XDG_RUNTIME_DIR", "relative/runtime");
    await expect(supervisor.launch(owner, launchRequest, async () => undefined))
      .rejects.toThrow("SYSTEMD_MANAGER_ENVIRONMENT_UNAVAILABLE");
    expect(executor.sessionCall).toBeUndefined();
  });

  it("rejects credential-shaped Hermes environment keys from systemd unit properties", async () => {
    const request = {
      ...launchRequest,
      environment: { ...launchRequest.environment, AWS_SECRET_ACCESS_KEY: "SECRET_CANARY_UNIT_PROPERTY" },
    };
    await expect(supervisor.launch(owner, request, async () => undefined))
      .rejects.toThrow("PROCESS_SCOPE_ENVIRONMENT_REJECTED");
    expect(executor.sessionCall).toBeUndefined();
  });

  it("rejects the former provider-key environment name before creating a transient service", async () => {
    const request = {
      ...launchRequest,
      environment: { ...launchRequest.environment, EBB_HERMES_PROVIDER_API_KEY: "must-not-be-forwarded" },
    };
    await expect(supervisor.launch(owner, request, async () => undefined))
      .rejects.toThrow("PROCESS_SCOPE_ENVIRONMENT_REJECTED");
    expect(executor.sessionCall).toBeUndefined();
  });
});
