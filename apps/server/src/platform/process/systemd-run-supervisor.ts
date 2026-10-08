import { statfs } from "node:fs/promises";
import { dirname, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { ProcessExecutor, type ProcessResult, type ProcessSession } from "./process-executor.js";
import { classifySystemdScope, inspectCgroupTree, type ProcessScopeIdentity, type ProcessScopeObservation, type SystemdScopeSnapshot } from "./process-inspector.js";
import { ProcessScopeLaunchNotDispatchedError, type ProcessScopeHandle, type ProcessScopeLaunchRequest, type ProcessScopeSupervisor } from "./run-scope-supervisor.js";
import { consumeHermesLaunchTicket, type HermesLaunchTicketInput } from "../../modules/runtime/hermes/hermes-launch-ticket.js";
import { getLinuxHermesLauncherIntegrityDigest } from "./native-helper-integrity.js";

const HERMES_CHILD_ENV_KEYS = new Set([
  "HOMEDRIVE", "HOMEPATH", "SYSTEMROOT", "TEMP", "TMP", "PATH", "NODE_PATH", "NODE_ENV",
  "HOME", "HERMES_HOME", "HERMES_CONFIG", "HERMES_MODEL",
]);
const STOP_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;
const TRANSIENT_SCOPE_INSPECTION_REASONS = new Set([
  "SYSTEMD_PREREQUISITE_CHECK_UNAVAILABLE",
  "SYSTEMD_UNIT_LOAD_STATE_UNVERIFIED",
  "SYSTEMD_UNIT_CONTROL_GROUP_UNAVAILABLE",
  "SYSTEMD_PENDING_JOB_QUERY_UNAVAILABLE",
  "SYSTEMD_SCOPE_READBACK_UNAVAILABLE",
  "CGROUP_READ_UNAVAILABLE",
]);

type SystemdInspectionFailureCode =
  | "SYSTEMD_UNIT_LOAD_STATE_UNVERIFIED"
  | "SYSTEMD_UNIT_CONTROL_GROUP_UNAVAILABLE"
  | "SYSTEMD_PENDING_JOB_QUERY_UNAVAILABLE";

class SystemdInspectionFailure extends Error {
  constructor(readonly diagnosticCode: SystemdInspectionFailureCode) {
    super(diagnosticCode);
  }
}

const systemdPayloadWrapper = String.raw`
const { spawn } = require("node:child_process");
const { constants, fstatSync, openSync, closeSync, readFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const safeEnvironmentKeys = [
  "HOMEDRIVE", "HOMEPATH", "SYSTEMROOT", "TEMP", "TMP", "PATH", "NODE_PATH", "NODE_ENV",
  "HOME", "HERMES_HOME", "HERMES_CONFIG", "HERMES_MODEL",
];
let pending = Buffer.alloc(0);
let waiter;
function take(size) {
  if (pending.length >= size) {
    const value = pending.subarray(0, size);
    pending = pending.subarray(size);
    return Promise.resolve(value);
  }
  return new Promise((resolve, reject) => { waiter = { size, resolve, reject }; });
}
process.stdin.on("data", (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  if (waiter && pending.length >= waiter.size) {
    const current = waiter;
    waiter = undefined;
    const value = pending.subarray(0, current.size);
    pending = pending.subarray(current.size);
    current.resolve(value);
  }
});
process.stdin.on("end", () => { if (waiter) waiter.reject(new Error("scope transport closed")); });
async function main() {
  const ack = await take(1);
  if (ack[0] !== 1) throw new Error("launch not authorized by durable owner");
  process.stdin.pause();
  const payload = process.argv.slice(1);
  const verifiedHelper = payload[0] === "--verified-linux-hermes-helper";
  let file;
  let args;
  let helperFd;
  if (verifiedHelper) {
    const [, helperPath, expectedDigest, ...helperArgs] = payload;
    if (!helperPath || !/^[a-f0-9]{64}$/.test(expectedDigest || "")) throw new Error("native helper identity missing");
    helperFd = openSync(helperPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const helperStat = fstatSync(helperFd);
    if (!helperStat.isFile() || (helperStat.mode & 0o111) === 0 || helperStat.size <= 0 || helperStat.size > 128 * 1024 * 1024) {
      closeSync(helperFd);
      throw new Error("native helper type rejected");
    }
    const digest = createHash("sha256").update(readFileSync(helperFd)).digest("hex");
    if (digest !== expectedDigest) {
      closeSync(helperFd);
      throw new Error("native helper identity mismatch");
    }
    file = "/proc/self/fd/3";
    args = helperArgs;
  } else {
    [file, ...args] = payload;
  }
  if (!file) throw new Error("payload executable missing");
  const env = {};
  for (const key of safeEnvironmentKeys) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  let child;
  try {
    child = spawn(file, args, {
      shell: false, cwd: process.cwd(), env,
      stdio: helperFd === undefined ? ["ignore", "inherit", "inherit"] : ["ignore", "inherit", "inherit", helperFd],
    });
  } finally {
    if (helperFd !== undefined) closeSync(helperFd);
  }
  child.on("error", () => process.exit(126));
  child.on("close", (code) => process.exit(code ?? 1));
}
main().catch(() => process.exit(125));
`;

interface SystemdRunSupervisorOptions {
  linuxHermesLauncherPath?: string;
  loadLinuxHermesLauncherDigest?: () => Promise<string>;
}

/** Linux process owner backed only by systemd user services and unified cgroup v2. */
export class SystemdRunSupervisor implements ProcessScopeSupervisor {
  private readonly linuxHermesLauncherPath: string;
  private readonly loadLinuxHermesLauncherDigest: () => Promise<string>;

  constructor(private readonly executor = new ProcessExecutor(), options: SystemdRunSupervisorOptions = {}) {
    this.linuxHermesLauncherPath = options.linuxHermesLauncherPath ?? posix.resolve(
      dirname(fileURLToPath(import.meta.url)), "../../../dist/native/linux-hermes-launcher/ebb-linux-hermes-launcher",
    );
    this.loadLinuxHermesLauncherDigest = options.loadLinuxHermesLauncherDigest ??
      getLinuxHermesLauncherIntegrityDigest;
  }

  async launch(
    owner: ProcessScopeIdentity,
    request: ProcessScopeLaunchRequest,
    persistVerifiedIdentity: (identity: ProcessScopeIdentity) => Promise<void>,
  ): Promise<ProcessScopeHandle> {
    assertLinuxOwner(owner);
    assertRequest(request);
    const launchIdentity = consumeLaunchIdentity(owner, request);
    if (launchIdentity && launchIdentity.platform !== "linux") throw new Error("SYSTEMD_HERMES_LAUNCH_PLATFORM_MISMATCH");
    await this.assertNativePrerequisites();
    if (request.signal?.aborted) throw new ProcessScopeLaunchNotDispatchedError();
    const baseEnvironment = this.managerEnvironment();
    for (const [key, value] of Object.entries(request.environment)) {
      if (!HERMES_CHILD_ENV_KEYS.has(key) || isCredentialEnvironmentKey(key) || !/^[A-Z_][A-Z0-9_]*$/.test(key) || /[\0\r\n]/.test(value)) {
        throw new Error("PROCESS_SCOPE_ENVIRONMENT_REJECTED");
      }
    }
    const wrapperEnvironment = { ...baseEnvironment, ...request.environment };
    const explicitWrapperEnvironment = Object.entries(wrapperEnvironment)
      .filter(([key]) => HERMES_CHILD_ENV_KEYS.has(key))
      .map(([key, value]) => `${key}=${value}`);
    const unitName = systemdUnitName(owner);
    const launchPayload = launchIdentity
      ? [
        "--verified-linux-hermes-helper",
        this.linuxHermesLauncherPath,
        await this.loadLinuxHermesLauncherDigest(),
        ...buildLinuxHermesLauncherArgs(owner, request, launchIdentity),
      ]
      : [request.executable, ...request.args];
    const args = [
      "--user", "--expand-environment=no", "--pipe", "--wait", `--unit=${unitName}`, "--slice=app.slice",
      "--description=ebb-orchestrator:" + owner.launchNonce,
      "--service-type=exec",
      "--property=Type=exec",
      "--property=ExitType=cgroup",
      "--property=KillMode=control-group",
      "--property=Delegate=no",
      "--property=ProtectControlGroups=yes",
      "--property=Restart=no",
      `--property=WorkingDirectory=${request.cwd}`,
    ];
    // systemd user services inherit the manager environment. env -i exec-replaces itself before Node
    // starts, so the wrapper's initial /proc/<pid>/environ contains only this validated allowlist.
    // Disable systemd argument expansion so JavaScript template expressions such as `${process.ppid}`
    // in payload arguments are passed to Node unchanged.
    args.push(
      "--", "/usr/bin/env", "-i", ...explicitWrapperEnvironment,
      process.execPath, "-e", systemdPayloadWrapper, "--", ...launchPayload,
    );

    const managerEnvironment = this.managerEnvironment();
    const session = this.executor.startSession("systemd-run", args, {
      cwd: request.cwd, env: managerEnvironment, timeout: 0, maxBuffer: 10 * 1024 * 1024,
      captureOutput: request.captureOutput ?? true,
    });
    let verifiedIdentity: ProcessScopeIdentity | undefined;
    let stoppedBySignal = false;
    let stdoutFailure: unknown;
    let stdoutCallbacks = Promise.resolve();
    if (request.onStdoutChunk) {
      let stdoutTransportFailureQueued = false;
      session.stdout.on("data", (chunk: Buffer | string) => {
        if (stdoutTransportFailureQueued) return;
        const bytes = Buffer.from(chunk);
        stdoutCallbacks = stdoutCallbacks.then(async () => {
          if (stdoutFailure === undefined) await request.onStdoutChunk!(bytes);
        }).catch((error: unknown) => {
          if (stdoutFailure === undefined) {
            stdoutFailure = error;
            stoppedBySignal = true;
            session.stdin.destroy();
            void this.stop(verifiedIdentity ?? owner).catch(() => undefined);
          }
        });
      });
      session.stdout.on("error", () => {
        if (stdoutTransportFailureQueued) return;
        stdoutTransportFailureQueued = true;
        stoppedBySignal = true;
        session.stdin.destroy();
        void this.stop(verifiedIdentity ?? owner).catch(() => undefined);
        stdoutCallbacks = stdoutCallbacks.then(() => {
          stdoutFailure ??= new Error("SYSTEMD_PROCESS_STDOUT_FAILED");
        });
      });
    }
    const onAbort = () => {
      stoppedBySignal = true;
      // Closing the wrapper transport prevents its launch-authorization read from
      // being satisfied if cancellation wins the pre-dispatch race.
      session.stdin.destroy();
      void this.stop(verifiedIdentity ?? owner).catch(() => undefined);
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => {
      stoppedBySignal = true;
      session.stdin.destroy();
      void this.stop(verifiedIdentity ?? owner).catch(() => undefined);
    }, request.timeoutMs);

    try {
      if (request.signal?.aborted) throw new Error("PROCESS_SCOPE_LAUNCH_CANCELLED");
      const observed = await this.waitUntilLive(owner, session, request.signal);
      if (observed.state !== "LIVE") throw new Error("PROCESS_SCOPE_LIVE_MEMBERSHIP_UNPROVEN");
      verifiedIdentity = observed.identity;
      await persistVerifiedIdentity(observed.identity);
      // Payload authorization is a separate protocol byte. Cancellation after durable
      // owner persistence but before this byte must never dispatch the payload.
      if (request.signal?.aborted) throw new Error("PROCESS_SCOPE_LAUNCH_CANCELLED");
      session.stdin.write(Buffer.from([1]));
      session.stdin.end();
    } catch (error) {
      session.stdin.destroy();
      await this.stop(verifiedIdentity ?? owner).catch(() => undefined);
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onAbort);
      throw error;
    }

    const scopeIdentity = verifiedIdentity;
    if (!scopeIdentity) throw new Error("PROCESS_SCOPE_LIVE_IDENTITY_MISSING");
    const drainStdoutCallbacks = async (): Promise<void> => {
      let observed: Promise<void>;
      do {
        observed = stdoutCallbacks;
        await observed;
      } while (observed !== stdoutCallbacks);
    };
    const completion = session.completion.then(async (result) => {
      await drainStdoutCallbacks();
      if (stdoutFailure !== undefined) throw new Error("SYSTEMD_PROCESS_STDOUT_FAILED");
      const observed = await this.waitForStopped(scopeIdentity, STOP_TIMEOUT_MS);
      if (observed.state !== "STOPPED") throw new Error("PROCESS_SCOPE_STOP_UNPROVEN");
      return request.captureOutput === false ? { ...result, stdout: "", stderr: "" } : result;
    }).catch(async (error: unknown) => {
      await drainStdoutCallbacks();
      const stopped = await this.stop(scopeIdentity).catch(() => ({ state: "UNKNOWN" as const, reason: "SYSTEMD_STOP_FAILED" }));
      if (stopped.state !== "STOPPED") throw new Error("PROCESS_SCOPE_STOP_UNPROVEN");
      throw error;
    }).finally(() => {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onAbort);
    });
    if (stoppedBySignal) void completion.catch(() => undefined);
    return { completion };
  }

  async inspect(owner: ProcessScopeIdentity): Promise<ProcessScopeObservation> {
    assertLinuxOwner(owner);
    try {
      await this.assertNativePrerequisites();
    } catch {
      return { state: "UNKNOWN", reason: "SYSTEMD_PREREQUISITE_CHECK_UNAVAILABLE" };
    }
    try {
      const unitName = systemdUnitName(owner);
      const snapshot = await this.readSnapshot(owner, unitName, owner.systemdControlGroup);
      return classifySystemdScope(owner, snapshot);
    } catch (error) {
      const reason = error instanceof SystemdInspectionFailure
        ? error.diagnosticCode
        : "SYSTEMD_SCOPE_READBACK_UNAVAILABLE";
      return { state: "UNKNOWN", reason };
    }
  }

  async stop(owner: ProcessScopeIdentity): Promise<ProcessScopeObservation> {
    assertLinuxOwner(owner);
    const observation = await this.inspect(owner);
    if (observation.state !== "LIVE") return observation;
    const live = observation.identity;
    if (live.runId !== owner.runId || live.containmentId !== owner.containmentId ||
        live.launchNonce !== owner.launchNonce || !live.systemdInvocationId || !live.systemdControlGroup ||
        (owner.systemdInvocationId !== null && live.systemdInvocationId !== owner.systemdInvocationId) ||
        (owner.systemdControlGroup !== null && live.systemdControlGroup !== owner.systemdControlGroup)) {
      return { state: "UNKNOWN", reason: "SYSTEMD_STOP_IDENTITY_MISMATCH" };
    }
    try {
      await this.execManager("systemctl", ["--user", "stop", systemdUnitName(live)], { timeout: STOP_TIMEOUT_MS });
      return await this.waitForStopped(live, STOP_TIMEOUT_MS);
    } catch {
      return { state: "UNKNOWN", reason: "SYSTEMD_STOP_FAILED" };
    }
  }

  async waitForStopped(owner: ProcessScopeIdentity, timeoutMs = STOP_TIMEOUT_MS): Promise<ProcessScopeObservation> {
    const deadline = Date.now() + timeoutMs;
    do {
      const last = await this.inspect(owner);
      if (last.state === "STOPPED" || last.state === "UNKNOWN") return last;
      if (Date.now() + POLL_INTERVAL_MS > deadline) break;
      await delay(POLL_INTERVAL_MS);
    } while (Date.now() <= deadline);
    return { state: "UNKNOWN", reason: "SYSTEMD_STOP_TIMEOUT" };
  }

  private async waitUntilLive(
    owner: ProcessScopeIdentity,
    session: ProcessSession,
    signal?: AbortSignal,
  ): Promise<ProcessScopeObservation> {
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    do {
      if (signal?.aborted) throw new Error("PROCESS_SCOPE_LAUNCH_CANCELLED");
      const completion = await Promise.race([
        session.completion.then(() => "closed" as const, () => "closed" as const),
        delay(250).then(() => "pending" as const),
      ]);
      if (signal?.aborted) throw new Error("PROCESS_SCOPE_LAUNCH_CANCELLED");
      if (completion === "closed") throw new Error("PROCESS_SCOPE_EXITED_BEFORE_MEMBERSHIP");
      const observed = await this.inspect(owner);
      if (observed.state === "LIVE") return observed;
      if (observed.state === "UNKNOWN" && observed.reason !== "SYSTEMD_UNIT_ABSENCE_UNPROVEN") {
        // Keep retrying the same inspection failures that were transient before diagnostics were split.
        if (!TRANSIENT_SCOPE_INSPECTION_REASONS.has(observed.reason)) {
          throw new Error("PROCESS_SCOPE_LAUNCH_IDENTITY_UNVERIFIED");
        }
      }
    } while (Date.now() < deadline);
    throw new Error("PROCESS_SCOPE_LAUNCH_TIMEOUT");
  }

  private async assertNativePrerequisites(): Promise<void> {
    const filesystem = await statfs("/sys/fs/cgroup");
    if (filesystem.type !== 0x63677270) throw new Error("CGROUP_V2_REQUIRED");
    await this.execManager("systemctl", ["--user", "is-system-running"], { timeout: 5_000 });
  }

  private async readSnapshot(owner: ProcessScopeIdentity, unitName: string, recordedGroup: string | null): Promise<SystemdScopeSnapshot> {
    let values: Map<string, string>;
    try {
      const result = await this.execManager("systemctl", [
        "--user", "show", unitName, "--no-pager",
        "--property=LoadState", "--property=ActiveState", "--property=SubState",
        "--property=Description", "--property=InvocationID", "--property=ControlGroup", "--property=MainPID",
        "--property=Type", "--property=ExitType", "--property=KillMode", "--property=Delegate",
        "--property=ProtectControlGroups", "--property=Restart",
      ], { timeout: 5_000 });
      values = parseProperties(result.stdout);
    } catch {
      return emptySystemdSnapshot(false, null, false, false, false, [], null, null);
    }
    const loadState = values.get("LoadState");
    if (loadState === "not-found") {
      const pendingJob = await this.isUnitPending(unitName);
      if (recordedGroup === null) return emptySystemdSnapshot(pendingJob, null, false, false, true, [], null, null);
      const tree = await inspectCgroupTree(recordedGroup);
      return emptySystemdSnapshot(pendingJob, recordedGroup, tree.exists, tree.readable, true,
        tree.processIds, null, "persisted-owner", tree.populated);
    }
    if (loadState !== "loaded") throw new SystemdInspectionFailure("SYSTEMD_UNIT_LOAD_STATE_UNVERIFIED");
    const controlGroup = values.get("ControlGroup") || null;
    if (!controlGroup || !posix.isAbsolute(controlGroup)) {
      throw new SystemdInspectionFailure("SYSTEMD_UNIT_CONTROL_GROUP_UNAVAILABLE");
    }
    const tree = await inspectCgroupTree(controlGroup);
    return {
      managerQuerySucceeded: true,
      controlGroupSource: "unit-readback",
      expectedControlGroup: controlGroup,
      unitFound: true,
      pendingJob: false,
      activeState: values.get("ActiveState") ?? null,
      subState: values.get("SubState") ?? null,
      description: values.get("Description") ?? null,
      invocationId: values.get("InvocationID") ?? null,
      controlGroup,
      mainPid: positiveInteger(values.get("MainPID")),
      type: values.get("Type") ?? null,
      exitType: values.get("ExitType") ?? null,
      killMode: values.get("KillMode") ?? null,
      delegate: values.get("Delegate") ?? null,
      protectControlGroups: values.get("ProtectControlGroups") ?? null,
      restart: values.get("Restart") ?? null,
      cgroupExists: tree.exists,
      cgroupReadable: tree.readable,
      cgroupPopulated: tree.populated,
      cgroupProcessIds: tree.processIds,
    };
  }

  private async isUnitPending(unitName: string): Promise<boolean> {
    try {
      const result = await this.execManager("systemctl", ["--user", "list-jobs", "--no-legend", "--no-pager"], { timeout: 5_000 });
      return result.stdout.split(/\r?\n/).some((line) => line.trim().split(/\s+/)[1] === unitName);
    } catch {
      throw new SystemdInspectionFailure("SYSTEMD_PENDING_JOB_QUERY_UNAVAILABLE");
    }
  }

  private async execManager(file: string, args: string[], options: { timeout: number }): Promise<ProcessResult> {
    return this.executor.exec(file, args, { ...options, env: this.managerEnvironment() });
  }

  private managerEnvironment(): Record<string, string> {
    const required = ["PATH", "HOME", "XDG_RUNTIME_DIR"] as const;
    const env: Record<string, string> = {};
    for (const key of required) {
      const value = process.env[key];
      if (!value || /[\0\r\n]/.test(value) || (key !== "PATH" && !posix.isAbsolute(value))) {
        throw new Error("SYSTEMD_MANAGER_ENVIRONMENT_UNAVAILABLE");
      }
      env[key] = value;
    }
    const runtimeDirectory = env.XDG_RUNTIME_DIR;
    if (!runtimeDirectory) throw new Error("SYSTEMD_MANAGER_ENVIRONMENT_UNAVAILABLE");
    const normalizedRuntimeDirectory = runtimeDirectory.replace(/\/+$/, "") || "/";
    env.XDG_RUNTIME_DIR = normalizedRuntimeDirectory;
    const bus = process.env.DBUS_SESSION_BUS_ADDRESS;
    if (bus !== undefined) {
      const busPath = normalizedRuntimeDirectory === "/" ? "/bus" : `${normalizedRuntimeDirectory}/bus`;
      const escapedBusPath = busPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (!new RegExp(`^unix:path=${escapedBusPath}(?:,guid=[a-fA-F0-9]{32})?$`).test(bus)) {
        throw new Error("SYSTEMD_MANAGER_BUS_ADDRESS_INVALID");
      }
      env.DBUS_SESSION_BUS_ADDRESS = bus;
    }
    for (const key of ["LANG", "LC_ALL"] as const) {
      const value = process.env[key];
      if (value && /^[A-Za-z0-9_.@-]+$/.test(value)) env[key] = value;
    }
    return env;
  }
}

function isCredentialEnvironmentKey(key: string): boolean {
  return /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API[_-]?KEY)/i.test(key);
}

function assertLinuxOwner(owner: ProcessScopeIdentity): void {
  if (process.platform !== "linux" || owner.containmentKind !== "systemd-user-service" || !/^[a-f0-9]{64}$/.test(owner.containmentId) || !/^[a-f0-9]{64}$/.test(owner.launchNonce)) {
    throw new Error("SYSTEMD_PROCESS_SCOPE_UNSUPPORTED");
  }
}

function assertRequest(request: ProcessScopeLaunchRequest): void {
  if (!request.executable || !posix.isAbsolute(request.cwd) || !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0) {
    throw new TypeError("Invalid systemd process-scope launch request.");
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
    attempt: request.attempt ?? null,
    executable: request.executable,
    args: request.args,
    environment: request.environment,
  });
  if (identity.platform !== "linux") throw new Error("SYSTEMD_HERMES_LAUNCH_PLATFORM_MISMATCH");
  return identity;
}

function buildLinuxHermesLauncherArgs(
  owner: ProcessScopeIdentity,
  request: ProcessScopeLaunchRequest,
  identity: HermesLaunchTicketInput,
): string[] {
  if (identity.platform !== "linux" || identity.hermesExecutableIdentity.platform !== "linux" ||
    identity.executableIdentity.platform !== "linux" || identity.profileHomeIdentity.platform !== "linux") {
    throw new Error("SYSTEMD_HERMES_LAUNCH_PLATFORM_MISMATCH");
  }
  if (identity.hermesSourceSnapshotRootIdentity.platform !== "linux" ||
      identity.hermesSourceProjectionSize > 64 * 1024 * 1024 || identity.hermesSourceSnapshotKey.length > 4096) {
    throw new Error("SYSTEMD_HERMES_SOURCE_SNAPSHOT_INVALID");
  }
  return [
    "--run-hermes",
    identity.runId,
    owner.launchNonce,
    identity.profileHome,
    identity.profileHomeIdentity.device,
    identity.profileHomeIdentity.inode,
    identity.hermesExecutablePath,
    identity.hermesExecutableIdentity.device,
    identity.hermesExecutableIdentity.inode,
    identity.executablePath,
    identity.executableIdentity.device,
    identity.executableIdentity.inode,
    identity.hermesSourceSnapshotRoot,
    identity.hermesSourceSnapshotRootIdentity.device,
    identity.hermesSourceSnapshotRootIdentity.inode,
    identity.hermesSourceProjectionPath,
    identity.hermesSourceProjectionSha256,
    String(identity.hermesSourceProjectionSize),
    identity.hermesSourceManifestDigest,
    identity.hermesSourceSnapshotKey,
    String(request.args.length),
    ...request.args,
  ];
}

function isHermesExecutable(executable: string): boolean {
  const name = executable.split("/").at(-1)?.toLocaleLowerCase("en-US");
  return name === "hermes" || name === "hermes.exe";
}

function systemdUnitName(owner: ProcessScopeIdentity): string {
  return `ebb-orchestrator-run-${owner.containmentId}.service`;
}

function parseProperties(output: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    values.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return values;
}

function emptySystemdSnapshot(
  pendingJob: boolean,
  inspectedPath: string | null,
  cgroupExists: boolean,
  cgroupReadable: boolean,
  managerQuerySucceeded: boolean,
  cgroupProcessIds: number[],
  controlGroup: string | null,
  controlGroupSource: SystemdScopeSnapshot["controlGroupSource"],
  cgroupPopulated: boolean | null = cgroupReadable ? false : null,
): SystemdScopeSnapshot {
  return {
    managerQuerySucceeded, controlGroupSource, expectedControlGroup: inspectedPath,
    unitFound: false, pendingJob, activeState: null, subState: null, description: null, invocationId: null,
    controlGroup, mainPid: null, type: null, exitType: null, killMode: null, delegate: null,
    protectControlGroups: null, restart: null, cgroupExists, cgroupReadable, cgroupPopulated,
    cgroupProcessIds,
  };
}

function positiveInteger(value: string | undefined): number | null {
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
