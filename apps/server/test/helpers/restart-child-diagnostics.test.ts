import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  formatRestartChildRecoveryMarkerFailure,
  formatRestartChildTerminalStatusDiagnostic,
  parseRestartChildTerminalStatus,
  restartChildTerminalStatusPath,
  restartChildTerminalStatusForFailure,
  safeRestartChildFailureCode,
  serializeRestartChildTerminalStatus,
} from "./restart-child-diagnostics.js";

describe("restart child failure diagnostics", () => {
  it("reports only bounded allowlisted codes from a short Error cause chain", () => {
    const nativeFailure = new Error("WINDOWS_HELPER_NATIVE_UNKNOWN:CHILD_JOB_BARRIER_UNAVAILABLE");
    const wrappedFailure = new Error("WINDOWS_PROCESS_SCOPE_LAUNCH_UNPROVEN:WINDOWS_JOB_STOP_NOT_CONFIRMED", {
      cause: nativeFailure,
    });

    expect(safeRestartChildFailureCode(wrappedFailure)).toBe(
      "WINDOWS_PROCESS_SCOPE_LAUNCH_UNPROVEN:WINDOWS_JOB_STOP_NOT_CONFIRMED>WINDOWS_HELPER_NATIVE_UNKNOWN:CHILD_JOB_BARRIER_UNAVAILABLE",
    );
    expect(safeRestartChildFailureCode(new Error("CHILD_JOB_BARRIER_UNAVAILABLE"))).toBe("CHILD_JOB_BARRIER_UNAVAILABLE");
  });

  it("does not echo a secret or arbitrary message from an Error or its cause", () => {
    const secret = "sk-test-never-echo-this-value";
    const cause = new Error(`WINDOWS_HELPER_NATIVE_UNKNOWN:${secret}`);
    const error = new Error(`launch failed; credential=${secret}`, { cause });
    const uppercaseSecretCode = safeRestartChildFailureCode(new Error("PROCESS_SCOPE_API_KEY_SUPERSECRET"));

    const failureCode = safeRestartChildFailureCode(error);

    expect(failureCode).toBeUndefined();
    expect(failureCode ?? "").not.toContain(secret);
    expect(uppercaseSecretCode).toBeUndefined();
    expect(uppercaseSecretCode ?? "").not.toContain("PROCESS_SCOPE_API_KEY_SUPERSECRET");
  });

  it("preserves only the two fixed native handshake timeout stages", () => {
    expect(safeRestartChildFailureCode(new Error("WINDOWS_HELPER_HANDSHAKE_TIMEOUT:EBB_HELPER_READY")))
      .toBe("WINDOWS_HELPER_HANDSHAKE_TIMEOUT:EBB_HELPER_READY");
    expect(safeRestartChildFailureCode(new Error("WINDOWS_HELPER_HANDSHAKE_TIMEOUT:EBB_SCOPE_READY")))
      .toBe("WINDOWS_HELPER_HANDSHAKE_TIMEOUT:EBB_SCOPE_READY");
    expect(safeRestartChildFailureCode(new Error("WINDOWS_HELPER_HANDSHAKE_TIMEOUT:PROVIDER_SECRET_VALUE")))
      .toBeUndefined();
  });

  it("preserves only normalized allowlisted native helper gate phases", () => {
    expect(safeRestartChildFailureCode(new Error("WINDOWS_NATIVE_HELPER_GATE_FAILURE:INTEGRITY_CHECK")))
      .toBe("WINDOWS_NATIVE_HELPER_GATE_FAILURE:INTEGRITY_CHECK");
    expect(safeRestartChildFailureCode(new Error("WINDOWS_NATIVE_HELPER_GATE_FAILURE:sk-secret-value")))
      .toBeUndefined();
  });

  it("matches the native Windows report and UNKNOWN code sets exactly", async () => {
    const nativeSource = await readFile(new URL("../../native/windows-run-supervisor/ebb-run-supervisor.cpp", import.meta.url), "utf8");
    const supervisorSource = await readFile(new URL("../../src/platform/process/windows-job-supervisor.ts", import.meta.url), "utf8");
    const reportCodes = [...nativeSource.matchAll(/report\("([A-Z0-9_]+)"\)/gu)]
      .map((match) => match[1]!)
      .filter((code) => !code.startsWith("TEST_"));
    const unknownCodes = [...nativeSource.matchAll(/UNKNOWN\\t([A-Z0-9_]+)/gu)].map((match) => match[1]!);

    expect(reportCodes.length).toBeGreaterThan(0);
    expect(unknownCodes.length).toBeGreaterThan(0);
    expect(safeRestartChildFailureCode(new Error("TEST_PROFILE_UNSAFE"))).toBeUndefined();
    for (const code of new Set(reportCodes)) {
      expect(safeRestartChildFailureCode(new Error(code))).toBe(code);
      expect(safeRestartChildFailureCode(new Error(`WINDOWS_HELPER_NATIVE_UNKNOWN:${code}`)))
        .toBe(`WINDOWS_HELPER_NATIVE_UNKNOWN:${code}`);
      expect(supervisorSource).toContain(`"${code}"`);
    }
    for (const code of new Set(unknownCodes)) {
      expect(safeRestartChildFailureCode(new Error(`WINDOWS_HELPER_NATIVE_UNKNOWN:${code}`)))
        .toBe(`WINDOWS_HELPER_NATIVE_UNKNOWN:${code}`);
      expect(supervisorSource).toContain(`"${code}"`);
    }
  });

  it("redacts recovery worker stderr and verifies recovery-marker failure uses the shared formatter", async () => {
    const secret = "OPENAI_API_KEY=recovery-marker-secret";
    const diagnostic = formatRestartChildRecoveryMarkerFailure(17, "", `provider failure ${secret}`);
    expect(diagnostic).toBe("PROCESS_SCOPE_RECOVERY_MARKER_MISSING:17:PROCESS_SCOPE_RESTART_CHILD_FAILED workerStdout=empty workerStderr=present-redacted");
    expect(diagnostic).not.toContain(secret);

    const acceptanceSource = await readFile(new URL("../e2e/hermes-process-scope.acceptance.test.ts", import.meta.url), "utf8");
    const recoverySource = acceptanceSource.slice(
      acceptanceSource.indexOf("async function runRecoveryWorker("),
      acceptanceSource.indexOf("async function runWindowsNativeScopeCommand("),
    );
    expect(recoverySource).toContain("formatRestartChildRecoveryMarkerFailure(exit.code, worker.output.stdout, worker.output.stderr)");
    expect(recoverySource).not.toContain("${worker.output.stderr}");
  });

  it("bounds the number of codes and verifies launch/recovery use only the sanitized value", async () => {
    let error: Error | undefined;
    for (let index = 0; index < 20; index += 1) {
      error = new Error(index % 2 === 0 ? "PROCESS_SCOPE_STOP_UNPROVEN" : "PROCESS_SCOPE_LAUNCH_TIMEOUT", { cause: error });
    }
    const code = safeRestartChildFailureCode(error);
    expect(code?.split(">")).toHaveLength(2);
    expect(code?.length).toBeLessThan(512);

    const childSource = await readFile(new URL("./hermes-process-scope-restart-child.ts", import.meta.url), "utf8");
    expect(childSource.match(/safeRestartChildFailureCode\(error\)/gu)).toHaveLength(2);
    expect(childSource).toContain("PROCESS_SCOPE_RESTART_CHILD_FAILED:${failureCode}");
    expect(childSource).toContain("...(failureCode ? { failureCode } : {})");
  });

  it("wires launch completion to a terminal-status sidecar checked by payload acceptance", async () => {
    const childSource = await readFile(new URL("./hermes-process-scope-restart-child.ts", import.meta.url), "utf8");
    const acceptanceSource = await readFile(new URL("../e2e/hermes-process-scope.acceptance.test.ts", import.meta.url), "utf8");
    const sharedLaunchAcceptance = acceptanceSource.slice(
      acceptanceSource.indexOf("async function runRestartBoundaryAcceptance()"),
      acceptanceSource.indexOf("async function runWindowsHelperCrashBoundaryAcceptance()"),
    );
    const windowsCrashAcceptance = acceptanceSource.slice(
      acceptanceSource.indexOf("async function runWindowsHelperCrashBoundaryAcceptance()"),
      acceptanceSource.indexOf("function spawnRestartWorker("),
    );

    expect(childSource.includes("restartChildTerminalStatusPath(markerPath)")).toBe(true);
    expect(childSource.includes("handle.completion.then")).toBe(true);
    expect(childSource.includes("restartChildTerminalStatusForFailure(error)")).toBe(true);
    expect(childSource.includes("(result) => writeTerminalStatus(terminalStatusPath, {")).toBe(true);
    expect(childSource.includes("exitCode: result.exitCode,")).toBe(true);
    expect(childSource.includes("result.exitCode === 0")).toBe(false);
    expect(childSource.includes("serializeRestartChildTerminalStatus")).toBe(true);
    expect(childSource.includes("rename(temporaryPath, terminalStatusPath)")).toBe(true);
    expect(acceptanceSource.includes("const terminalStatusPath = restartChildTerminalStatusPath(readyPath);")).toBe(true);
    expect(acceptanceSource.includes("formatRestartChildTerminalStatusDiagnostic(statusContents)")).toBe(true);
    for (const launchAcceptance of [sharedLaunchAcceptance, windowsCrashAcceptance]) {
      expect(launchAcceptance.includes("waitForPayloadMarkerOrTerminalStatus(payloadMarkerPath, terminalStatusPath)")).toBe(true);
      expect(launchAcceptance.includes("waitForLaunchArtifactOrTerminalStatus(descendantPidPath, terminalStatusPath)")).toBe(true);
      expect(launchAcceptance.includes("waitForLaunchArtifactOrTerminalStatus(heartbeatPath, terminalStatusPath)")).toBe(true);
    }
    expect(sharedLaunchAcceptance.includes("assertNoRestartChildTerminalStatus(terminalStatusPath)")).toBe(true);
    expect(windowsCrashAcceptance.includes("assertNoRestartChildTerminalStatus(terminalStatusPath)")).toBe(false);
    expect(windowsCrashAcceptance.match(/waitForExpectedRestartChildExitStatus\(terminalStatusPath, 137\)/gu)?.length === 3).toBe(true);
  });

  it("accepts only allowlisted terminal failure codes and numeric exit statuses", () => {
    const failure = { kind: "failure", failureCode: "WINDOWS_HELPER_NATIVE_UNKNOWN:CHILD_CREATE_FAILED" } as const;
    const successfulExit = { kind: "exit", exitCode: 0 } as const;
    const exit = { kind: "exit", exitCode: 23 } as const;
    const maxExit = { kind: "exit", exitCode: 0xFFFF_FFFF } as const;

    expect(restartChildTerminalStatusPath("ready.json")).toBe("ready.json.terminal-status.json");
    expect(parseRestartChildTerminalStatus(serializeRestartChildTerminalStatus(failure))).toEqual(failure);
    expect(parseRestartChildTerminalStatus(serializeRestartChildTerminalStatus(successfulExit))).toEqual(successfulExit);
    expect(parseRestartChildTerminalStatus(serializeRestartChildTerminalStatus(exit))).toEqual(exit);
    expect(parseRestartChildTerminalStatus(serializeRestartChildTerminalStatus(maxExit))).toEqual(maxExit);
    expect(formatRestartChildTerminalStatusDiagnostic(serializeRestartChildTerminalStatus(failure)))
      .toBe("PROCESS_SCOPE_TERMINAL_FAILURE:WINDOWS_HELPER_NATIVE_UNKNOWN:CHILD_CREATE_FAILED");
    expect(formatRestartChildTerminalStatusDiagnostic(serializeRestartChildTerminalStatus(exit)))
      .toBe("PROCESS_SCOPE_TERMINAL_EXIT_CODE:23");
    expect(formatRestartChildTerminalStatusDiagnostic(serializeRestartChildTerminalStatus(successfulExit)))
      .toBe("PROCESS_SCOPE_TERMINAL_EXIT_CODE:0");
  });

  it("records only the generic terminal failure when rejection text is not allowlisted", () => {
    const secret = "OPENAI_API_KEY=unclassified-error-secret";
    const status = restartChildTerminalStatusForFailure(new Error(`provider failed ${secret}`));
    const serialized = serializeRestartChildTerminalStatus(status);
    const diagnostic = formatRestartChildTerminalStatusDiagnostic(serialized);

    expect(status).toEqual({ kind: "failure" });
    expect(diagnostic === "PROCESS_SCOPE_TERMINAL_FAILURE").toBe(true);
    expect(serialized.includes(secret)).toBe(false);
    expect(diagnostic.includes(secret)).toBe(false);
  });

  it("does not reflect secret-shaped, invalid, or oversized sidecar contents", () => {
    const secret = "PROCESS_SCOPE_API_KEY_SUPERSECRET";
    const secretStatus = JSON.stringify({ kind: "failure", failureCode: secret });
    const invalidStatus = `invalid sidecar ${secret}`;
    const unexpectedFieldStatus = JSON.stringify({ kind: "failure", failureCode: "PROCESS_SCOPE_STOP_UNPROVEN", stdout: secret });
    const invalidExitStatus = JSON.stringify({ kind: "exit", exitCode: -1 });
    const outOfRangeExitStatus = JSON.stringify({ kind: "exit", exitCode: 0x1_0000_0000 });
    const oversizedStatus = "x".repeat(1_025);

    for (const value of [secretStatus, invalidStatus, unexpectedFieldStatus, invalidExitStatus, outOfRangeExitStatus, oversizedStatus]) {
      const diagnostic = formatRestartChildTerminalStatusDiagnostic(value);
      expect(diagnostic === "PROCESS_SCOPE_TERMINAL_STATUS_INVALID").toBe(true);
      expect(diagnostic.includes(secret)).toBe(false);
      expect(parseRestartChildTerminalStatus(value)).toBeUndefined();
    }
  });
});
