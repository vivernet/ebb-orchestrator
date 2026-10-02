import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProcessExecutor,
  type ProcessOptions,
  type ProcessResult,
  type ProcessSession,
} from "../../../src/platform/process/process-executor.js";
import {
  SystemdRunSupervisor,
} from "../../../src/platform/process/systemd-run-supervisor.js";
import type {
  ProcessScopeIdentity,
  SystemdScopeSnapshot,
} from "../../../src/platform/process/process-inspector.js";
import type { ProcessScopeLaunchRequest } from "../../../src/platform/process/run-scope-supervisor.js";

class FakeProcessExecutor extends ProcessExecutor {
  readonly execCalls: Array<{ file: string; args: string[]; options: ProcessOptions }> = [];
  sessionCall: { file: string; args: string[]; options: ProcessOptions; session: ProcessSession } | undefined;
  sessionWrites: Buffer[] = [];
  private resolveCompletion: ((result: ProcessResult) => void) | undefined;
  onExec: ((file: string, args: string[]) => ProcessResult | Error | void) | undefined;

  override async exec(file: string, args: string[], options: ProcessOptions = {}): Promise<ProcessResult> {
    this.execCalls.push({ file, args: [...args], options });
    const result = this.onExec?.(file, args);
    if (result instanceof Error) throw result;
    if (result) return result;
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  override startSession(file: string, args: string[], options: ProcessOptions = {}): ProcessSession {
    const stdin = new Writable({
      write: (chunk: Buffer | string, _encoding, callback) => {
        this.sessionWrites.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk));
        callback();
      },
    });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const completion = new Promise<ProcessResult>((resolve) => { this.resolveCompletion = resolve; });
    const session: ProcessSession = { stdin, stdout, stderr, completion, terminate: () => undefined };
    this.sessionCall = { file, args: [...args], options, session };
    return session;
  }

  finish(result: ProcessResult = { exitCode: 0, stdout: "dummy stdout", stderr: "" }): void {
    this.resolveCompletion?.(result);
  }
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
