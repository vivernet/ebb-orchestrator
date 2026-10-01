import { statfs } from "node:fs/promises";
import { posix } from "node:path";
import { ProcessExecutor, type ProcessResult, type ProcessSession } from "./process-executor.js";
import { classifySystemdScope, inspectCgroupTree, type ProcessScopeIdentity, type ProcessScopeObservation, type SystemdScopeSnapshot } from "./process-inspector.js";
import { encodeSecretFrame, ProcessScopeLaunchNotDispatchedError, type ProcessScopeHandle, type ProcessScopeLaunchRequest, type ProcessScopeSupervisor } from "./run-scope-supervisor.js";

const PROCESS_KEY_ENV = "EBB_HERMES_PROVIDER_API_KEY";
const HERMES_CHILD_ENV_KEYS = new Set([
  "HOMEDRIVE", "HOMEPATH", "SYSTEMROOT", "TEMP", "TMP", "PATH", "NODE_PATH", "NODE_ENV",
  "HOME", "HERMES_HOME", "HERMES_CONFIG", "HERMES_MODEL",
]);
const STOP_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;

const systemdPayloadWrapper = String.raw`
const { spawn } = require("node:child_process");
const KEY = "EBB_HERMES_PROVIDER_API_KEY";
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
  const header = await take(4);
  const length = header.readUInt32BE(0);
  if (length > 8192) throw new Error("invalid secret frame");
  const key = (await take(length)).toString("utf8");
  const ack = await take(1);
  if (ack[0] !== 1) throw new Error("launch not authorized by durable owner");
  process.stdin.pause();
  const [file, ...args] = process.argv.slice(1);
  if (!file) throw new Error("payload executable missing");
  const env = { ...process.env };
  if (length > 0) env[KEY] = key;
  const child = spawn(file, args, { shell: false, cwd: process.cwd(), env, stdio: ["ignore", "inherit", "inherit"] });
  child.on("error", () => process.exit(126));
  child.on("close", (code) => process.exit(code ?? 1));
}
main().catch(() => process.exit(125));
`;

/** Linux process owner backed only by systemd user services and unified cgroup v2. */
export class SystemdRunSupervisor implements ProcessScopeSupervisor {
  constructor(private readonly executor = new ProcessExecutor()) {}

  async launch(
    owner: ProcessScopeIdentity,
    request: ProcessScopeLaunchRequest,
    persistVerifiedIdentity: (identity: ProcessScopeIdentity) => Promise<void>,
  ): Promise<ProcessScopeHandle> {
    assertLinuxOwner(owner);
    await this.assertNativePrerequisites();
    assertRequest(request);
    if (request.signal?.aborted) throw new ProcessScopeLaunchNotDispatchedError();
    const unitName = systemdUnitName(owner);
    const args = [
      "--user", "--pipe", "--wait", `--unit=${unitName}`, "--slice=app.slice",
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
    for (const [key, value] of Object.entries(request.environment)) {
      if (key === PROCESS_KEY_ENV) throw new Error("PROCESS_SCOPE_SECRET_MUST_USE_STDIN");
      if (!HERMES_CHILD_ENV_KEYS.has(key) || isCredentialEnvironmentKey(key) || !/^[A-Z_][A-Z0-9_]*$/.test(key) || /[\0\r\n]/.test(value)) {
        throw new Error("PROCESS_SCOPE_ENVIRONMENT_REJECTED");
      }
      args.push(`--setenv=${key}=${value}`);
    }
    args.push("--", "node", "-e", systemdPayloadWrapper, "--", request.executable, ...request.args);
    assertSecretAbsentFromLaunchMetadata(request);

    const frame = encodeSecretFrame(request.secret);
    const managerEnvironment = this.managerEnvironment();
    const session = this.executor.startSession("systemd-run", args, {
      cwd: request.cwd, env: managerEnvironment, timeout: 0, maxBuffer: 10 * 1024 * 1024,
    });
    let verifiedIdentity: ProcessScopeIdentity | undefined;
    let stoppedBySignal = false;
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
      session.stdin.write(frame);
      const observed = await this.waitUntilLive(owner, session, request.signal);
      if (observed.state !== "LIVE") throw new Error("PROCESS_SCOPE_LIVE_MEMBERSHIP_UNPROVEN");
      verifiedIdentity = observed.identity;
      await persistVerifiedIdentity(observed.identity);
      // Hermes authorization is a separate protocol byte. Cancellation after durable
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
    const completion = session.completion.then(async (result) => {
      const observed = await this.waitForStopped(scopeIdentity, STOP_TIMEOUT_MS);
      if (observed.state !== "STOPPED") throw new Error("PROCESS_SCOPE_STOP_UNPROVEN");
      return result;
    }).catch(async (error: unknown) => {
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
      const unitName = systemdUnitName(owner);
      const snapshot = await this.readSnapshot(owner, unitName, owner.systemdControlGroup);
      return classifySystemdScope(owner, snapshot);
    } catch {
      return { state: "UNKNOWN", reason: "SYSTEMD_INSPECTION_UNAVAILABLE" };
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
        // During first activation the cgroup may not yet exist; all other ambiguity is fail-closed.
        const transient = observed.reason === "SYSTEMD_INSPECTION_UNAVAILABLE" || observed.reason === "CGROUP_READ_UNAVAILABLE";
        if (!transient) throw new Error("PROCESS_SCOPE_LAUNCH_IDENTITY_UNVERIFIED");
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
    if (loadState !== "loaded") throw new Error("SYSTEMD_UNIT_LOAD_STATE_UNVERIFIED");
    const controlGroup = values.get("ControlGroup") || null;
    if (!controlGroup || !posix.isAbsolute(controlGroup)) throw new Error("SYSTEMD_CONTROL_GROUP_UNAVAILABLE");
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
    const result = await this.execManager("systemctl", ["--user", "list-jobs", "--no-legend", "--no-pager"], { timeout: 5_000 });
    return result.stdout.split(/\r?\n/).some((line) => line.trim().split(/\s+/)[1] === unitName);
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

function assertSecretAbsentFromLaunchMetadata(request: ProcessScopeLaunchRequest): void {
  const secret = request.secret;
  if (secret === undefined) return;
  const values = [request.executable, request.cwd, ...request.args, ...Object.values(request.environment)];
  if (values.some((value) => value.includes(secret))) throw new Error("PROCESS_SCOPE_SECRET_MUST_USE_STDIN");
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
  if (request.environment[PROCESS_KEY_ENV] !== undefined) throw new Error("PROCESS_SCOPE_SECRET_MUST_USE_STDIN");
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
