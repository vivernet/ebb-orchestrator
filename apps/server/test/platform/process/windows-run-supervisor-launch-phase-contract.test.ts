import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProcessExecutor, type ProcessOptions, type ProcessResult } from "../../../src/platform/process/process-executor.js";
import {
  parseWindowsProcessScopeLaunchPhase,
  WINDOWS_PROCESS_SCOPE_LAUNCH_PHASES,
  WindowsJobSupervisor,
} from "../../../src/platform/process/windows-job-supervisor.js";
import type { ProcessScopeIdentity } from "../../../src/platform/process/process-inspector.js";

const nativeSource = readFileSync(
  new URL("../../../native/windows-run-supervisor/ebb-run-supervisor.cpp", import.meta.url),
  "utf8",
);
const supervisorSource = readFileSync(
  new URL("../../../src/platform/process/windows-job-supervisor.ts", import.meta.url),
  "utf8",
);

class PhaseExecutor extends ProcessExecutor {
  readonly calls: string[][] = [];
  constructor(private readonly output: string) { super(); }
  override async exec(_file: string, args: string[], _options: ProcessOptions = {}): Promise<ProcessResult> {
    this.calls.push(args);
    return { exitCode: 0, stdout: this.output, stderr: "" };
  }
}

const owner: ProcessScopeIdentity = {
  runId: "windows-phase-test-run",
  containmentKind: "windows-job",
  containmentId: "a".repeat(64),
  launchNonce: "b".repeat(64),
  systemdInvocationId: null,
  systemdControlGroup: null,
  supervisorPid: null,
  supervisorStartIdentity: null,
  pid: 42,
  platform: "win32",
  processStartIdentity: "123456",
  executableIdentity: `sha256:${"c".repeat(64)}`,
  state: "LIVE",
};

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

describe("Windows native helper launch-phase diagnostic contract", () => {
  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
    vi.restoreAllMocks();
  });

  it("keeps the durable identity mapping byte-layout and name unchanged", () => {
    expect(nativeSource).toMatch(/constexpr char kMappingMagic\[\] = "EBBJOB1";/u);
    expect(nativeSource).toMatch(/std::wstring mappingName\(const std::wstring& id\) \{ return L"Local\\\\ebb-orchestrator-run-meta-" \+ id; \}/u);
    const legacyMapping = /struct MappingData \{([\s\S]*?)\n\};/u.exec(nativeSource)?.[1] ?? "";
    expect(legacyMapping).toMatch(/char magic\[8\];[\s\S]*char nonce\[65\];[\s\S]*DWORD helperPid;[\s\S]*ULONGLONG helperCreation;[\s\S]*DWORD payloadPid;[\s\S]*ULONGLONG payloadCreation;[\s\S]*char executableIdentity\[72\];/u);
    expect(legacyMapping).not.toMatch(/phase|stage/iu);
  });

  it("uses a separate nonce-bound phase mapping with a closed stage enum and exact read query", () => {
    expect(nativeSource).toMatch(/constexpr char kPhaseMappingMagic\[\] = "EBBPHASE1";/u);
    expect(nativeSource).toMatch(/std::wstring phaseMappingName\(const std::wstring& id\)/u);
    expect(nativeSource).toMatch(/struct PhaseMappingData \{[\s\S]*?char magic\[10\];[\s\S]*?char nonce\[65\];[\s\S]*?volatile LONG phase;/u);
    expect(nativeSource).toMatch(/enum LaunchPhase : LONG \{[\s\S]*?WAITING_FOR_ACK[\s\S]*?ACK_ACCEPTED[\s\S]*?RESUME_API_ERROR[\s\S]*?RESUME_COUNT_ZERO[\s\S]*?RESUME_COUNT_ONE[\s\S]*?RESUME_COUNT_GREATER_THAN_ONE/u);
    expect(nativeSource).toMatch(/bool isLaunchPhase\(LONG phase\)/u);
    expect(nativeSource).toMatch(/bool writeLaunchPhase\(HANDLE mapping, const std::wstring& nonce, LaunchPhase phase\)/u);
    expect(nativeSource).toMatch(/bool readLaunchPhase\(HANDLE mapping, const std::wstring& nonce, LaunchPhase\* phase\)/u);
    expect(nativeSource).toMatch(/operation == L"phase" && argc == 4/u);
    expect(nativeSource).toMatch(/readLaunchPhase\([\s\S]*?nonce[\s\S]*?PHASE\\t/u);
    const phaseIdentityCheck = /bool phaseMappingMatches\([\s\S]*?\n\}/u.exec(nativeSource)?.[0] ?? "";
    expect(phaseIdentityCheck).toMatch(/expectedNonce\.size\(\) == 64/u);
    expect(phaseIdentityCheck).toMatch(/memcmp\(data->magic, kPhaseMappingMagic/u);
    expect(phaseIdentityCheck).toMatch(/memcmp\(data->nonce, expectedNonce\.data\(\), 64\)/u);
    expect(phaseIdentityCheck).toMatch(/data->nonce\[64\] == '\\0'/u);
  });

  it("accepts only ResumeThread previous count one and terminates the exact Job otherwise", () => {
    expect(nativeSource).toMatch(/const DWORD previousSuspendCount = ResumeThread\(primaryThread\.value\);/u);
    expect(nativeSource).toMatch(/if \(previousSuspendCount == static_cast<DWORD>\(-1\)\)[\s\S]*?CHILD_RESUME_API_ERROR/u);
    expect(nativeSource).toMatch(/if \(previousSuspendCount == 0\)[\s\S]*?CHILD_RESUME_COUNT_ZERO/u);
    expect(nativeSource).toMatch(/if \(previousSuspendCount > 1\)[\s\S]*?CHILD_RESUME_COUNT_GREATER_THAN_ONE/u);
    for (const code of ["CHILD_RESUME_API_ERROR", "CHILD_RESUME_COUNT_ZERO", "CHILD_RESUME_COUNT_GREATER_THAN_ONE"]) {
      const reportOffset = nativeSource.indexOf(`report("${code}")`);
      const branchOffset = nativeSource.lastIndexOf("if (previousSuspendCount", reportOffset);
      expect(reportOffset).toBeGreaterThan(branchOffset);
      expect(nativeSource.slice(branchOffset, reportOffset)).toContain("TerminateJobObject(job.value, 1)");
    }
  });

  it("binds Hermes native launch to a bounded snapshot projection and holds its verified tree through Job exit", () => {
    expect(nativeSource).toMatch(/hermesSourceSnapshotKey/u);
    expect(nativeSource).toMatch(/hermesSourceSnapshotRoot/u);
    expect(nativeSource).toMatch(/hermesSourceProjectionPath/u);
    expect(nativeSource).toMatch(/hermesSourceProjectionSha256/u);
    expect(nativeSource).toMatch(/hermesSourceProjectionSize/u);
    expect(nativeSource).toMatch(/verifyHermesSourceSnapshot\(/u);
    expect(nativeSource).toMatch(/BCryptCreateHash/u);
    expect(nativeSource).toMatch(/GetSecurityInfo/u);
    expect(nativeSource).toMatch(/FILE_SHARE_READ\s*,/u);
    expect(nativeSource).toMatch(/std::vector<Handle>\s+snapshotHandles/u);
    expect(nativeSource).toMatch(/verifyHermesSourceSnapshot\([\s\S]*?ResumeThread/u);
    expect(nativeSource).toMatch(/std::vector<Handle>\s+snapshotHandles;[\s\S]*?for\s*\(;;\)[\s\S]*?active == 0/u);
    expect(nativeSource).toMatch(/EHSP/u);
    const encoder = /function encodeMetadataFrame\([\s\S]*?\n\}/u.exec(supervisorSource)?.[0] ?? "";
    for (const field of [
      "hermesSourceSnapshotKey", "hermesSourceSnapshotRoot", "hermesSourceSnapshotRootIdentity",
      "hermesSourceManifestDigest", "hermesSourceProjectionPath", "hermesSourceProjectionSha256",
      "hermesSourceProjectionSize",
    ]) expect(encoder).toContain(field);
    expect(encoder).not.toContain("encodeNativeProjection");
    expect(encoder).toContain("256 * 1024");
  });

  it("splits Job-open and mapping/identity-open inspection failures into fixed UNKNOWN codes", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    expect(nativeSource).toMatch(/JOB_OPEN_UNAVAILABLE/u);
    expect(nativeSource).toMatch(/MAPPING_OR_IDENTITY_UNAVAILABLE/u);
    expect(nativeSource).not.toMatch(/UNKNOWN\\tJOB_OR_IDENTITY_UNAVAILABLE/u);

    for (const nativeCode of ["JOB_OPEN_UNAVAILABLE", "MAPPING_OR_IDENTITY_UNAVAILABLE"]) {
      const executor = new PhaseExecutor(`UNKNOWN\t${nativeCode}\n`);
      const supervisor = new WindowsJobSupervisor(executor, "native-helper.exe", async (file, name, args) => ({
        file, args, env: {},
      }));
      await expect(supervisor.inspect(owner)).resolves.toEqual({ state: "UNKNOWN", reason: `WINDOWS_${nativeCode}` });
    }
  });

  it("queries the exact phase for the owner nonce and parses only the fixed allowlist", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    expect(WINDOWS_PROCESS_SCOPE_LAUNCH_PHASES).toEqual([
      "WAITING_FOR_ACK", "ACK_ACCEPTED", "RESUME_API_ERROR", "RESUME_COUNT_ZERO",
      "RESUME_COUNT_ONE", "RESUME_COUNT_GREATER_THAN_ONE",
    ]);
    for (const phase of WINDOWS_PROCESS_SCOPE_LAUNCH_PHASES) {
      expect(parseWindowsProcessScopeLaunchPhase(`PHASE\t${phase}\n`)).toBe(phase);
      expect(parseWindowsProcessScopeLaunchPhase(`PHASE\t${phase}\r\n`)).toBe(phase);
    }
    expect(parseWindowsProcessScopeLaunchPhase("PHASE\tUNKNOWN_NATIVE_VALUE\n")).toBe("UNAVAILABLE");
    expect(parseWindowsProcessScopeLaunchPhase("PHASE\tACK_ACCEPTED\nUNEXPECTED\n")).toBe("UNAVAILABLE");

    const executor = new PhaseExecutor("PHASE\tACK_ACCEPTED\n");
    const supervisor = new WindowsJobSupervisor(executor, "native-helper.exe", async (file, name, args) => ({
      file, args, env: {},
    }));
    await expect(supervisor.inspectLaunchPhase(owner)).resolves.toBe("ACK_ACCEPTED");
    expect(executor.calls).toEqual([["phase", owner.containmentId, owner.launchNonce]]);
  });
});
