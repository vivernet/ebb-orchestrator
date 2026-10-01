import { describe, expect, it } from "vitest";
import {
  classifySystemdScope,
  type ProcessScopeIdentity,
  type SystemdScopeSnapshot,
} from "../../../src/platform/process/process-inspector.js";

const owner: ProcessScopeIdentity = {
  runId: "run-1",
  containmentKind: "systemd-user-service",
  containmentId: "a".repeat(64),
  launchNonce: "b".repeat(64),
  systemdInvocationId: "11111111111111111111111111111111",
  systemdControlGroup: `/user.slice/user-1000.slice/user@1000.service/app.slice/ebb-orchestrator-run-${"a".repeat(64)}.service`,
  supervisorPid: null,
  supervisorStartIdentity: null,
  pid: 4321,
  platform: "linux",
  processStartIdentity: null,
  executableIdentity: null,
  state: "LIVE",
};

function snapshot(overrides: Partial<SystemdScopeSnapshot> = {}): SystemdScopeSnapshot {
  return {
    managerQuerySucceeded: true,
    controlGroupSource: "unit-readback",
    expectedControlGroup: owner.systemdControlGroup,
    unitFound: true,
    pendingJob: false,
    activeState: "active",
    subState: "running",
    description: `ebb-orchestrator:${owner.launchNonce}`,
    invocationId: owner.systemdInvocationId,
    controlGroup: owner.systemdControlGroup,
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
    cgroupProcessIds: [4321],
    ...overrides,
  };
}

describe("process inspector", () => {
  it("treats a populated verified cgroup as LIVE despite root-process exit", () => {
    expect(classifySystemdScope(owner, snapshot({ cgroupProcessIds: [4322] }))).toMatchObject({ state: "LIVE" });
  });

  it("requires every systemd containment property and matching nonce/invocation", () => {
    for (const invalid of [
      { delegate: "yes" },
      { protectControlGroups: "no" },
      { killMode: "process" },
      { exitType: "main" },
      { restart: "on-failure" },
      { description: "unrelated" },
      { invocationId: "2".repeat(32) },
      { controlGroup: "/different" },
    ] satisfies Array<Partial<SystemdScopeSnapshot>>) {
      expect(classifySystemdScope(owner, snapshot(invalid))).toMatchObject({ state: "UNKNOWN" });
    }
  });

  it("requires verified empty cgroup evidence before STOPPED", () => {
    expect(classifySystemdScope(owner, snapshot({ activeState: "inactive", subState: "dead", cgroupPopulated: false, cgroupProcessIds: [] })))
      .toMatchObject({ state: "STOPPED", evidence: "SYSTEMD_CGROUP_EMPTY" });
    expect(classifySystemdScope(owner, snapshot({ cgroupReadable: false }))).toMatchObject({ state: "UNKNOWN" });
    expect(classifySystemdScope(owner, snapshot({ unitFound: false, pendingJob: true, cgroupExists: true })))
      .toMatchObject({ state: "UNKNOWN" });
    expect(classifySystemdScope(owner, snapshot({
      unitFound: false, controlGroup: null, pendingJob: false, cgroupExists: false,
      controlGroupSource: "persisted-owner",
      cgroupReadable: true, cgroupPopulated: false, cgroupProcessIds: [],
    })))
      .toMatchObject({ state: "STOPPED", evidence: "UNIT_ABSENT_NO_PENDING_CGROUP_ABSENT" });
  });

  it("does not infer STOPPED from unreadable or mismatched unit-absence evidence", () => {
    expect(classifySystemdScope(owner, snapshot({
      unitFound: false, pendingJob: false, cgroupExists: false, cgroupReadable: false,
    }))).toMatchObject({ state: "UNKNOWN" });
    expect(classifySystemdScope(owner, snapshot({
      unitFound: false, pendingJob: false, cgroupExists: false, controlGroup: null,
    }))).toMatchObject({ state: "UNKNOWN" });
    expect(classifySystemdScope({ ...owner, systemdControlGroup: null }, snapshot({
      unitFound: false, pendingJob: false, cgroupExists: false, controlGroup: null,
      controlGroupSource: null, expectedControlGroup: null,
    }))).toMatchObject({ state: "UNKNOWN" });
    const failedManagerQuery = {
      ...snapshot({ unitFound: false, pendingJob: false, cgroupExists: false }),
      managerQuerySucceeded: false,
    };
    expect(classifySystemdScope(owner, failedManagerQuery)).toMatchObject({ state: "UNKNOWN" });
  });
});
