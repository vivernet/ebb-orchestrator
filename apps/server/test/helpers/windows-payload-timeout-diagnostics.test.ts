import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { ProcessScopeIdentity } from "../../src/platform/process/process-inspector.js";
import {
  classifyWindowsJobMembershipResult,
  formatWindowsPayloadMarkerTimeout,
  inspectWindowsLaunchPhaseForTimeout,
  parseWindowsPayloadCpuActivity,
  type WindowsPayloadMarkerTimeoutSnapshot,
} from "./windows-payload-timeout-diagnostics.js";

describe("Windows payload marker timeout diagnostics", () => {
  it("formats only safe enums and artifact-presence booleans", () => {
    const snapshot: WindowsPayloadMarkerTimeoutSnapshot = {
      ownerState: "LIVE",
      ownerIdentityMatches: true,
      scopeInspection: "LIVE",
      jobMembership: "MEMBER",
      cpuActivity: "LIVE_CPU_ADVANCED",
      launchPhase: "ACK_ACCEPTED",
      payloadMarkerPresent: false,
      descendantPidPresent: true,
      heartbeatPresent: false,
      descendantExitPresent: false,
      terminalStatusPresent: false,
    };

    expect(formatWindowsPayloadMarkerTimeout(snapshot)).toBe(
      "PROCESS_SCOPE_PAYLOAD_MARKER_TIMEOUT ownerState=LIVE ownerIdentityMatches=true scopeInspection=LIVE " +
      "jobMembership=MEMBER cpuActivity=LIVE_CPU_ADVANCED launchPhase=ACK_ACCEPTED payloadMarkerPresent=false descendantPidPresent=true " +
      "heartbeatPresent=false descendantExitPresent=false terminalStatusPresent=false",
    );
  });

  it("queries the exact persisted process owner and hides unavailable or invalid phase results", async () => {
    const persistedOwner: ProcessScopeIdentity = {
      runId: "persisted-run-id",
      containmentKind: "windows-job",
      containmentId: "a".repeat(64),
      launchNonce: "b".repeat(64),
      systemdInvocationId: null,
      systemdControlGroup: null,
      supervisorPid: 31,
      supervisorStartIdentity: "1234567",
      pid: 32,
      platform: "win32",
      processStartIdentity: "7654321",
      executableIdentity: `sha256:${"c".repeat(64)}`,
      state: "UNKNOWN",
    };
    const inspectLaunchPhase = vi.fn(async (_owner: ProcessScopeIdentity) => "ACK_ACCEPTED");

    await expect(inspectWindowsLaunchPhaseForTimeout(persistedOwner, inspectLaunchPhase)).resolves.toBe("ACK_ACCEPTED");
    expect(inspectLaunchPhase).toHaveBeenCalledTimes(1);
    expect(inspectLaunchPhase.mock.calls[0]?.[0]).toBe(persistedOwner);

    const secret = "OPENAI_API_KEY=must-not-appear";
    await expect(inspectWindowsLaunchPhaseForTimeout(
      persistedOwner,
      async () => secret,
    )).resolves.toBe("UNAVAILABLE");
    await expect(inspectWindowsLaunchPhaseForTimeout(
      persistedOwner,
      async () => { throw new Error(secret); },
    )).resolves.toBe("UNAVAILABLE");
    await expect(inspectWindowsLaunchPhaseForTimeout(
      undefined,
      inspectLaunchPhase,
    )).resolves.toBe("UNAVAILABLE");
    expect(inspectLaunchPhase).toHaveBeenCalledTimes(1);
  });

  it("does not echo invalid enum values, path text, or provider-shaped content", () => {
    const secret = "OPENAI_API_KEY=never-echo-this";
    const unsafeSnapshot = {
      ownerState: secret,
      ownerIdentityMatches: `${secret}`,
      scopeInspection: secret,
      jobMembership: secret,
      cpuActivity: secret,
      launchPhase: secret,
      payloadMarkerPresent: secret,
      descendantPidPresent: secret,
      heartbeatPresent: secret,
      descendantExitPresent: secret,
      terminalStatusPresent: secret,
    } as unknown as WindowsPayloadMarkerTimeoutSnapshot;

    const diagnostic = formatWindowsPayloadMarkerTimeout(unsafeSnapshot);
    const parsedActivity = parseWindowsPayloadCpuActivity(secret);
    expect(diagnostic.includes(secret)).toBe(false);
    expect(parsedActivity === "UNAVAILABLE").toBe(true);
    expect(parsedActivity.includes(secret)).toBe(false);
    expect(diagnostic.includes("PROCESS_SCOPE_PAYLOAD_MARKER_TIMEOUT")).toBe(true);
    expect(diagnostic.includes("ownerState=UNAVAILABLE")).toBe(true);
    expect(diagnostic.includes("scopeInspection=UNAVAILABLE")).toBe(true);
    expect(diagnostic.includes("cpuActivity=UNAVAILABLE")).toBe(true);
    expect(diagnostic.includes("launchPhase=UNAVAILABLE")).toBe(true);
    expect(diagnostic.includes("ownerIdentityMatches=false")).toBe(true);
    expect(diagnostic.includes("jobMembership=UNAVAILABLE")).toBe(true);
  });

  it("distinguishes exact non-membership from unavailable helper results", () => {
    const secret = "PROCESS_SCOPE_API_KEY_SUPERSECRET";
    expect(classifyWindowsJobMembershipResult(
      0,
      "EXACT_PROCESS_JOB_MEMBERSHIP_CONFIRMED\r\n",
      "",
    ) === "MEMBER").toBe(true);
    expect(classifyWindowsJobMembershipResult(
      1,
      "",
      "DESCENDANT_NOT_IN_NAMED_JOB\r\n",
    ) === "NOT_MEMBER").toBe(true);
    for (const result of [
      { exitCode: 1, stdout: "", stderr: `${secret}\r\n` },
      { exitCode: 1, stdout: "partial output", stderr: "DESCENDANT_NOT_IN_NAMED_JOB\r\n" },
      { exitCode: 1, stdout: "", stderr: "permission denied\r\n" },
      { exitCode: 1, stdout: "", stderr: "DESCENDANT_NOT_IN_NAMED_JOB plus extra text\r\n" },
      { exitCode: 2, stdout: "", stderr: "DESCENDANT_NOT_IN_NAMED_JOB\r\n" },
      { exitCode: 0, stdout: "unexpected output", stderr: "" },
    ]) {
      const classification = classifyWindowsJobMembershipResult(result.exitCode, result.stdout, result.stderr);
      expect(classification === "UNAVAILABLE").toBe(true);
      expect(classification.includes(secret)).toBe(false);
    }
  });

  it("keeps the CPU probe read-only, exact-identity, bounded, and enum-only", async () => {
    const helperSource = await readFile(new URL("./windows-process-scope-native.ps1", import.meta.url), "utf8");
    const acceptanceSource = await readFile(new URL("../e2e/hermes-process-scope.acceptance.test.ts", import.meta.url), "utf8");
    const supervisorSource = await readFile(new URL("../../src/platform/process/windows-job-supervisor.ts", import.meta.url), "utf8");
    const phaseQuerySource = supervisorSource.slice(
      supervisorSource.indexOf("async inspectLaunchPhase("),
      supervisorSource.indexOf("async stop("),
    );
    const waitSource = acceptanceSource.slice(
      acceptanceSource.indexOf("async function waitForWindowsPayloadMarkerWithDiagnostics("),
      acceptanceSource.indexOf("async function collectWindowsPayloadMarkerTimeoutSnapshot("),
    );
    const diagnosticSource = acceptanceSource.slice(
      acceptanceSource.indexOf("async function collectWindowsPayloadMarkerTimeoutSnapshot("),
      acceptanceSource.indexOf("async function readFileIfPresent("),
    );
    const windowsPayloadWaitCallSites = acceptanceSource.replace(
      "async function waitForWindowsPayloadMarkerWithDiagnostics(",
      "",
    );

    expect(helperSource.includes('"probe-cpu"')).toBe(true);
    expect(helperSource.includes("GetExitCodeProcess")).toBe(true);
    expect(helperSource.includes("GetProcessTimes")).toBe(true);
    expect(helperSource.includes("Thread.Sleep(250)")).toBe(true);
    expect(helperSource.includes("ProcessQueryLimitedInformation | Synchronize")).toBe(true);
    expect(helperSource.includes("WaitForSingleObject(process, 0)")).toBe(true);
    expect(helperSource.includes("waitStatus == WaitObject0")).toBe(true);
    expect(helperSource.includes("waitStatus != WaitTimeout")).toBe(true);
    expect(helperSource.includes("real exit code 259")).toBe(true);
    const waitStateRead = helperSource.indexOf("uint waitStatus = WaitForSingleObject(process, 0)");
    const exitCodeRead = helperSource.indexOf("GetExitCodeProcess(process, out exitCode)");
    expect((waitStateRead >= 0 && exitCodeRead > waitStateRead)).toBe(true);
    for (const status of ["LIVE_CPU_ADVANCED", "LIVE_CPU_IDLE", "EXITED", "IDENTITY_MISMATCH", "UNAVAILABLE"]) {
      expect(helperSource.includes(`"${status}"`)).toBe(true);
    }
    expect(acceptanceSource.includes('mode: "probe-cpu"')).toBe(true);
    expect(acceptanceSource.includes("new WindowsJobSupervisor(new ProcessExecutor()).inspect(toScopeIdentity(owner))")).toBe(true);
    expect(diagnosticSource.includes("owner.pid === expected.pid")).toBe(true);
    expect(diagnosticSource.includes("owner.supervisorPid === expected.supervisorPid")).toBe(true);
    expect(diagnosticSource.includes("owner.supervisorStartIdentity === expected.supervisorStartIdentity")).toBe(true);
    expect(diagnosticSource.includes("processId: expectedPid")).toBe(true);
    expect(diagnosticSource.includes("expectedCreationTime: owner.processStartIdentity")).toBe(true);
    expect(acceptanceSource.includes("classifyWindowsJobMembershipResult")).toBe(true);
    expect(diagnosticSource.includes("error instanceof ExitCodeError")).toBe(true);
    expect(diagnosticSource.includes("classifyWindowsJobMembershipResult(error.exitCode, error.stdout, error.stderr)")).toBe(true);
    expect(diagnosticSource.includes("inspectWindowsLaunchPhaseForTimeout(")).toBe(true);
    expect(diagnosticSource.includes("owner ? toScopeIdentity(owner) : undefined")).toBe(true);
    expect(diagnosticSource.includes("phaseSupervisor.inspectLaunchPhase(exactOwner)")).toBe(true);
    expect(phaseQuerySource.includes("maxBuffer: 4_096")).toBe(true);
    expect(phaseQuerySource.includes("timeout: 5_000")).toBe(true);
    expect(waitSource.indexOf("await collectWindowsPayloadMarkerTimeoutSnapshot(") <
      waitSource.indexOf("throw new Error(formatWindowsPayloadMarkerTimeout(snapshot)")).toBe(true);
    expect(windowsPayloadWaitCallSites.match(/waitForWindowsPayloadMarkerWithDiagnostics\(/gu)?.length === 3).toBe(true);
    expect(diagnosticSource.includes(".stop(")).toBe(false);
    expect(diagnosticSource.includes("terminate-exact")).toBe(false);
    expect(diagnosticSource.includes("rm(")).toBe(false);
  });
});
