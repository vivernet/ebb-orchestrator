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

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  if (startIndex < 0) return "";
  const endIndex = source.indexOf(end, startIndex + start.length);
  return endIndex < 0 ? "" : source.slice(startIndex, endIndex);
}

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

  it("emits fixed stderr markers for native launch setup failures before READY", () => {
    const earlyFailureWriter = /void reportEarlyLaunchFailure\(const char\* code\) \{[\s\S]*?\n\}/u.exec(nativeSource)?.[0] ?? "";
    expect(earlyFailureWriter).toMatch(/NATIVE_HELPER_LAUNCH_FAIL:/u);
    expect(earlyFailureWriter).toMatch(/GetStdHandle\(STD_ERROR_HANDLE\)/u);
    expect(earlyFailureWriter).not.toMatch(/GetLastError|absolute|relative|path|ACE|SID/iu);

    expect(nativeSource).toMatch(/if \(!job \|\| jobCreateError == ERROR_ALREADY_EXISTS\) \{\s*report\("JOB_CREATE_FAILED_OR_EXISTS"\);\s*reportEarlyLaunchFailure\("JOB_CREATE_FAILED_OR_EXISTS"\);\s*return false;/u);
    expect(nativeSource).toMatch(/if \(!SetInformationJobObject\(job\.value, JobObjectExtendedLimitInformation, &limits, sizeof\(limits\)\)\) \{\s*report\("JOB_POLICY_FAILED"\);\s*reportEarlyLaunchFailure\("JOB_POLICY_FAILED"\);\s*return false;/u);
    expect(nativeSource).toMatch(/if \(!mapping \|\| mappingCreateError == ERROR_ALREADY_EXISTS\) \{\s*report\("MAPPING_CREATE_FAILED_OR_EXISTS"\);\s*reportEarlyLaunchFailure\("MAPPING_CREATE_FAILED_OR_EXISTS"\);\s*return false;/u);
    expect(nativeSource).toMatch(/if \(!writeStdout\("EBB_HELPER_READY\\n"\)\) \{\s*reportEarlyLaunchFailure\("HELPER_READY_WRITE_FAILED"\);\s*return false;/u);
    expect(supervisorSource).toMatch(/JOB_CREATE_FAILED_OR_EXISTS: "LAUNCH_JOB_CREATE"/u);
    expect(supervisorSource).toMatch(/JOB_POLICY_FAILED: "LAUNCH_JOB_POLICY"/u);
    expect(supervisorSource).toMatch(/MAPPING_CREATE_FAILED_OR_EXISTS: "LAUNCH_MAPPING_CREATE"/u);
    expect(supervisorSource).toMatch(/HELPER_READY_WRITE_FAILED: "LAUNCH_READY_WRITE"/u);
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

  it("binds direct Hermes launch metadata to a bounded EBB6 frame", () => {
    expect(nativeSource).toMatch(/magic != 0x45424233 && magic != 0x45424236/u);
    expect(nativeSource).toMatch(/frameByteLength/u);
    expect(nativeSource).toMatch(/kMaxMetadataBytes/u);
    expect(nativeSource).toMatch(/remaining\s*==\s*0/u);
    const encoder = /function encodeMetadataFrame\([\s\S]*?\n\}/u.exec(supervisorSource)?.[0] ?? "";
    expect(encoder).toMatch(/addU32\(launchIdentity \? 0x45424236 : 0x45424233\)[\s\S]*?frameLengthOffset/u);
    expect(encoder).toContain("launchIdentity.hermesExecutablePath");
    expect(encoder).toContain("launchIdentity.executableIdentity");
    expect(encoder).toContain("runId");
    expect(encoder).not.toMatch(/snapshot|projection|profileHome/iu);
  });

  it("parses bounded direct-launch EBB6 frames before accepting launch acknowledgement", () => {
    expect(nativeSource).toMatch(/magic\s*!=\s*0x45424236/u);
    expect(nativeSource).toMatch(/readMetadata\(&metadata\)[\s\S]*?LAUNCH_FRAME_INVALID/u);
    expect(nativeSource).toMatch(/readMetadata\(&metadata\)[\s\S]*?readLaunchAcknowledgement\(nonce\)/u);
  });

  it("keeps phase identity evidence acceptance-only, bounded, ordered, and outside EBBJOB1", () => {
    expect(nativeSource).toMatch(/operation == L"launch-evidence"/u);
    expect(nativeSource).toMatch(/operation == L"launch" \|\| operation == L"launch-evidence"/u);
    expect(nativeSource).toMatch(/std::vector<std::string> evidenceRecords/u);
    expect(nativeSource).toMatch(/EBB_EVIDENCE\\tV3\\t/u);
    expect(nativeSource).toMatch(/evidenceRecords\.size\(\) != 5/u);
    expect(nativeSource).toMatch(/FRAME_DECODED_EXPECTED[\s\S]*?SUPERVISOR_OPEN[\s\S]*?PRE_CREATE[\s\S]*?PRE_RESUME[\s\S]*?STOPPED_HELD/u);
    expect(nativeSource).toMatch(/GetFileInformationByHandleEx\(handle, FileIdInfo/u);
    expect(nativeSource).toMatch(/launchObjectCommitment\("SUPERVISOR_OPEN"/u);
    expect(nativeSource).toMatch(/launchObjectCommitment\("STOPPED_HELD"/u);
    expect(nativeSource).toMatch(/for \(const auto& record : evidenceRecords\) envelope \+= record/u);
    expect(nativeSource).toMatch(/EBB_EVIDENCE_END_V3:/u);
    expect(nativeSource).toMatch(/if \(active == 0\) break;[\s\S]*?STOPPED_HELD[\s\S]*?writeStdout\(envelope\)/u);

    const preCreateOffset = nativeSource.indexOf('&digest, "PRE_CREATE"');
    const createOffset = nativeSource.indexOf("CreateProcessW(metadata.executable.c_str()", preCreateOffset);
    expect(preCreateOffset).toBeGreaterThan(-1);
    expect(createOffset).toBeGreaterThan(preCreateOffset);
    expect(nativeSource.slice(preCreateOffset, createOffset)).not.toMatch(/Sleep\(|WaitFor|await|callback/iu);

    const preResumeOffset = nativeSource.indexOf('acceptanceEvidence ? "PRE_RESUME"');
    const resumeOffset = nativeSource.indexOf("ResumeThread(primaryThread.value)", preResumeOffset);
    expect(preResumeOffset).toBeGreaterThan(-1);
    expect(resumeOffset).toBeGreaterThan(preResumeOffset);
    const resumeGate = nativeSource.slice(preResumeOffset, resumeOffset);
    expect(resumeGate).toMatch(/return false;\s*\}\s*const DWORD previousSuspendCount = $/u);
    expect(resumeGate.slice(resumeGate.lastIndexOf("return false;"))).not.toMatch(/Sleep\(|WaitFor|await|callback/iu);
    expect(nativeSource).toContain("EBB-LAUNCH-OBJECT-EVIDENCE-V3");
    expect(nativeSource).toMatch(/addEvidenceRecord\([\s\S]*?ownerAscii[\s\S]*?runId[\s\S]*?nonceAscii[\s\S]*?digest/u);
    expect(nativeSource).toMatch(/constexpr char kMappingMagic\[\] = "EBBJOB1";/u);
  });

  it("strips acceptance evidence before returning process output and limits it to one exact launch", () => {
    expect(supervisorSource).toMatch(/this\.acceptanceEvidence \? "launch-evidence" : "launch"/u);
    expect(supervisorSource).toMatch(/this\.acceptanceEvidenceUsed \|\|/u);
    expect(supervisorSource).toMatch(/this\.acceptanceEvidence\.parser\.write[\s\S]*?parser\.finish\(\)[\s\S]*?stdout: evidence\.payloadOutput/u);
    expect(supervisorSource).toMatch(/request\.onStdoutChunk \|\| request\.captureOutput === false/u);
    expect(supervisorSource).toMatch(/fields\.length !== 7[\s\S]*?fields\[3\] !== binding\.containmentId[\s\S]*?fields\[4\] !== binding\.runId[\s\S]*?fields\[5\] !== binding\.launchNonce/u);
    expect(supervisorSource).toMatch(/records\.length !== WINDOWS_PATH_CHAIN_EVIDENCE_STAGES\.length/u);
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

describe("shared configured Hermes native boundary", () => {
  it("launches the installed Hermes images from direct metadata without a private profile or source snapshot", () => {
    const launch = sourceBetween(nativeSource, "bool launch(", "bool inspect(");
    expect(launch).toContain("CreateProcessW(metadata.executable.c_str()");
    expect(launch).toContain("openTicketExecutable");
    expect(launch).toContain("openTicketHermesLauncher");
    expect(launch).toContain("ResumeThread(primaryThread.value)");
    expect(launch).not.toMatch(/verifyHermesSourceSnapshot|snapshot|projection|ProfileChain|profileHome/iu);
    expect(supervisorSource).toContain("encodeMetadataFrame(request, launchIdentity)");
  });
});
