import { containmentKindForPlatform, encodeDarwinProcessGroupIdentityV1, type RunContainmentKind } from "../../src/modules/runtime/run-process-owner.js";
import type { ProcessScopeIdentity } from "../../src/platform/process/process-inspector.js";

export interface RunProcessOwnerPlatformFixture {
  containmentKind: RunContainmentKind | null;
  identity: ProcessScopeIdentity | null;
  stopEvidence: string | null;
  unavailableReason: string | null;
}

/** Возвращает данные только для проверки общего owner-контракта, без запуска OS supervisor. */
export function runProcessOwnerFixtureForPlatform(platform: NodeJS.Platform): RunProcessOwnerPlatformFixture {
  const containmentKind = containmentKindForPlatform(platform);
  if (platform === "win32") {
    return {
      containmentKind,
      identity: {
        runId: "fixture-run", containmentKind: "windows-job", containmentId: "a".repeat(64), launchNonce: "b".repeat(64),
        systemdInvocationId: null, systemdControlGroup: null, supervisorPid: 101, supervisorStartIdentity: "win-start",
        pid: 102, platform: "win32", processStartIdentity: "runner-start", executableIdentity: "file-id", state: "LIVE",
      },
      stopEvidence: "WINDOWS_JOB_EMPTY",
      unavailableReason: null,
    };
  }
  if (platform === "linux") {
    return {
      containmentKind,
      identity: {
        runId: "fixture-run", containmentKind: "systemd-user-service", containmentId: "c".repeat(64), launchNonce: "d".repeat(64),
        systemdInvocationId: "01234567-89ab-cdef-0123-456789abcdef", systemdControlGroup: "/user.slice/fixture.scope",
        supervisorPid: null, supervisorStartIdentity: null, pid: 103, platform: "linux",
        processStartIdentity: null, executableIdentity: null, state: "LIVE",
      },
      stopEvidence: "SYSTEMD_CGROUP_EMPTY",
      unavailableReason: null,
    };
  }
  if (platform === "darwin") {
    const boot = {
      formatVersion: 1 as const, bootSessionUUID: "0f1a2b3c-4d5e-6f70-8a9b-0c1d2e3f4a5b",
      pid: 401, startTvsec: 1738000000, startUsec: 123456, pgid: 401, sid: 401,
    };
    return {
      containmentKind,
      identity: {
        runId: "fixture-run", containmentKind: "darwin-process-group", containmentId: "e".repeat(64), launchNonce: "f".repeat(64),
        systemdInvocationId: null, systemdControlGroup: null, supervisorPid: 401,
        supervisorStartIdentity: encodeDarwinProcessGroupIdentityV1(boot),
        pid: 402, platform: "darwin",
        processStartIdentity: encodeDarwinProcessGroupIdentityV1({ ...boot, pid: 402, startTvsec: 1738000001, startUsec: 654321 }),
        executableIdentity: `sha256:${"c".repeat(64)}`, state: "LIVE",
      },
      stopEvidence: "DARWIN_GROUP_EMPTY",
      unavailableReason: null,
    };
  }
  return { containmentKind: null, identity: null, stopEvidence: null, unavailableReason: "RUN_PROCESS_CONTAINMENT_UNSUPPORTED" };
}
