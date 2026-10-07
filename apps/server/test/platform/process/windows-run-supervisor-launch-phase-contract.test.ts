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
const profileChainAcceptanceSource = readFileSync(
  new URL("../../e2e/hermes-profile-path-chain.acceptance.test.ts", import.meta.url),
  "utf8",
);
const nativeHermesHarnessSource = readFileSync(
  new URL("../../../scripts/test-hermes-profile-path-native.mjs", import.meta.url),
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

  it("keeps source-tree failure public code stable and returns only allowlisted internal stages", () => {
    const reportTreeStage = /void reportSnapshotTreeFailure\(const char\* code, const char\* stage\) \{[\s\S]*?\n\}/u.exec(nativeSource)?.[0] ?? "";
    const directoryVerifier = /bool verifySnapshotDirectory\([\s\S]*?\n\}/u.exec(nativeSource)?.[0] ?? "";
    const snapshotVerifier = /bool verifyHermesSourceSnapshot\([\s\S]*?\n\}/u.exec(nativeSource)?.[0] ?? "";
    expect(reportTreeStage).toMatch(/writeStdout\(std::string\("UNKNOWN\\t"\) \+ code \+ "\\t" \+ candidate \+ "\\n"\)/u);
    expect(reportTreeStage).toMatch(/std::strcmp\(code, "LAUNCH_TICKET_SOURCE_SNAPSHOT_TREE_MISMATCH"\)/u);
    expect(reportTreeStage).toContain("PATH_ENUMERATION");
    expect(reportTreeStage).toContain("ENTRY_SHAPE");
    expect(reportTreeStage).toContain("FILE_ATTRIBUTES");
    expect(reportTreeStage).toContain("FILE_OPEN");
    expect(reportTreeStage).toContain("FILE_LINK_COUNT");
    expect(reportTreeStage).toContain("FILE_SIZE");
    expect(reportTreeStage).toContain("FILE_DACL");
    expect(reportTreeStage).toContain("CONTENT_HASH");
    expect(reportTreeStage).toContain("CONTENT_MISMATCH");
    expect(reportTreeStage).toContain("ENUMERATION_END");
    expect(reportTreeStage).toContain("ENUMERATION_COMPLETENESS");
    expect(reportTreeStage).toContain("PROJECTION_ENTRY_COLLISION");
    expect(reportTreeStage).not.toMatch(/absolute|relative|childPath|GetLastError|GetAclInformation|SID|ACE|OutputDebugString/iu);
    expect(directoryVerifier).toMatch(/FindFirstFileW\(pattern\.c_str\(\), &data\)[\s\S]*?setSnapshotTreeFailureStage\(failureStage, "PATH_ENUMERATION"\)/u);
    expect(directoryVerifier).toMatch(/name\.empty\(\)[\s\S]*?setSnapshotTreeFailureStage\(failureStage, "ENTRY_SHAPE"\)/u);
    expect(directoryVerifier).toMatch(/FILE_ATTRIBUTE_READONLY\)[\s\S]*?setSnapshotTreeFailureStage\(failureStage, "FILE_ATTRIBUTES"\)/u);
    expect(directoryVerifier).toMatch(/if \(!file\)[\s\S]*?setSnapshotTreeFailureStage\(failureStage, "FILE_OPEN"\)/u);
    expect(directoryVerifier).toMatch(/nNumberOfLinks != 1[\s\S]*?setSnapshotTreeFailureStage\(failureStage, "FILE_LINK_COUNT"\)/u);
    expect(directoryVerifier).toMatch(/GetFileSizeEx[\s\S]*?setSnapshotTreeFailureStage\(failureStage, "FILE_SIZE"\)/u);
    expect(directoryVerifier).toMatch(/validPrivateAcl\(file\.value\)[\s\S]*?setSnapshotTreeFailureStage\(failureStage, "FILE_DACL"\)/u);
    expect(directoryVerifier).toMatch(/sha256File[\s\S]*?setSnapshotTreeFailureStage\(failureStage, "CONTENT_HASH"\)/u);
    expect(directoryVerifier).toMatch(/memcmp\(digest, expected->second->digest, 32\)[\s\S]*?setSnapshotTreeFailureStage\(failureStage, "CONTENT_MISMATCH"\)/u);
    expect(directoryVerifier).toMatch(/findError != ERROR_NO_MORE_FILES[\s\S]*?setSnapshotTreeFailureStage\(failureStage, "ENUMERATION_END"\)/u);
    expect(snapshotVerifier).toMatch(/expectedFiles\.emplace\(entry\.path, &entry\)[\s\S]*?setSnapshotTreeFailureStage\(diagnosticStage, "PROJECTION_ENTRY_COLLISION"\)/u);
    expect(snapshotVerifier).toMatch(/seenFiles\.size\(\) != expectedFiles\.size\(\)[\s\S]*?setSnapshotTreeFailureStage\(diagnosticStage, "ENUMERATION_COMPLETENESS"\)/u);
    expect(snapshotVerifier).toMatch(/fail\("LAUNCH_TICKET_SOURCE_SNAPSHOT_TREE_MISMATCH"\)/u);
    expect(supervisorSource).toMatch(/SAFE_SNAPSHOT_TREE_DIAGNOSTIC_STAGES = new Set\(\[[\s\S]*?PROJECTION_ENTRY_COLLISION/u);
    expect(profileChainAcceptanceSource).toMatch(/const launchFailureCode = safeHermesLaunchFailureAssertionContext\(error\)/u);
    expect(profileChainAcceptanceSource).toMatch(/expect\(evidence, `native refusal evidence \(\$\{launchFailureCode\}\)`\)\.toBe\("HERMES_TICKET_OBJECT_MISMATCH"\)/u);
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

  it("parses the complete bounded EBB3 launch frame before accepting launch acknowledgement", () => {
    expect(nativeSource).toMatch(/magic\s*!=\s*0x45424233/u);
    expect(nativeSource).toMatch(/frameByteLength/u);
    expect(nativeSource).toMatch(/kMaxMetadataBytes/u);
    expect(nativeSource).toMatch(/remaining\s*==\s*0/u);
    expect(nativeSource).toMatch(/readMetadata\(&metadata\)[\s\S]*?LAUNCH_FRAME_INVALID/u);
    expect(nativeSource).toMatch(/readMetadata\(&metadata\)[\s\S]*?readLaunchAcknowledgement\(nonce\)/u);
    const encoder = /function encodeMetadataFrame\([\s\S]*?\n\}/u.exec(supervisorSource)?.[0] ?? "";
    expect(encoder).toMatch(/addU32\(0x45424233\)[\s\S]*?frameLengthOffset[\s\S]*?result\.writeUInt32BE\(result\.byteLength/u);
  });

  it("opens and verifies every Hermes profile component relative to a held no-reparse parent", () => {
    expect(nativeSource).toMatch(/OBJ_CASE_INSENSITIVE\s*\|\s*OBJ_DONT_REPARSE/u);
    expect(nativeSource).toMatch(/NtCreateFileProc/u);
    expect(nativeSource).toMatch(/openProfileDirectoryRelative\(handles->back\(\)\.value, components\[index\]/u);
    expect(nativeSource).toMatch(/profilePathChain\.size\(\)[\s\S]*?ticketFileIdentity\(handle, expected\.first, expected\.second\)/u);
    expect(nativeSource).toMatch(/FILE_SHARE_READ\s*\|\s*FILE_SHARE_WRITE, FILE_OPEN/u);
    expect(nativeSource).toMatch(/safeProfileAncestorAcl/u);
    expect(nativeSource).toMatch(/safePrivateProfileDirectoryAcl/u);
    expect(nativeSource).toMatch(/metadata\.authRootIndex\s*\+\s*3\s*!=\s*metadata\.profilePathChain\.size\(\)/u);
    expect(nativeSource).toContain("EBBACK01");
    expect(supervisorSource).toContain("encodeLaunchAcknowledgement(owner.launchNonce)");
    expect(nativeSource).toMatch(/ticketPathsStillMatch\(metadata,[\s\S]*?ResumeThread/u);
    expect(nativeSource).toMatch(/std::vector<Handle>\s+ticketProfileChain;[\s\S]*?for\s*\(;;\)[\s\S]*?active == 0/u);
  });

  it("keeps phase identity evidence acceptance-only, bounded, ordered, and outside EBBJOB1", () => {
    expect(nativeSource).toMatch(/operation == L"launch-evidence"/u);
    expect(nativeSource).toMatch(/operation == L"launch" \|\| operation == L"launch-evidence"/u);
    expect(nativeSource).toMatch(/std::vector<std::string> evidenceRecords/u);
    expect(nativeSource).toMatch(/EBB_EVIDENCE\\tV1\\t/u);
    expect(nativeSource).toMatch(/evidenceRecords\.size\(\) != 5/u);
    expect(nativeSource).toMatch(/FRAME_DECODED_EXPECTED[\s\S]*?SUPERVISOR_OPEN[\s\S]*?PRE_CREATE[\s\S]*?PRE_RESUME[\s\S]*?STOPPED_HELD/u);
    expect(nativeSource).toMatch(/chain-v[\s\S]*component-count=/u);
    expect(nativeSource).toMatch(/GetFileInformationByHandleEx\(handle, FileIdInfo/u);
    expect(nativeSource).toMatch(/heldPathChainCommitment\("SUPERVISOR_OPEN"/u);
    expect(nativeSource).toMatch(/heldPathChainCommitment\("STOPPED_HELD"/u);
    expect(nativeSource).toMatch(/for \(const auto& record : evidenceRecords\) envelope \+= record/u);
    expect(nativeSource).toMatch(/EBB_EVIDENCE_END_V1:/u);
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
    expect(nativeSource).toMatch(/std::string\("EBB-PATH-CHAIN-EVIDENCE-V1\\n"\)[\s\S]*?stage[\s\S]*?runId[\s\S]*?metadata\.profilePathChain/u);
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

  it("releases the LIVE dummy payload on marker failure and waits for STOPPED before fixture restoration", () => {
    const liveTest = /it\("keeps the production Job live until release and performs fixture cleanup only after STOPPED"([\s\S]*?)\n\s{2}\}, 180_000\)/u.exec(profileChainAcceptanceSource)?.[1] ?? "";
    expect(liveTest).toMatch(/try \{\s*await waitForFile\(marker\);[\s\S]*?catch \(error\) \{\s*actionFailure = error;\s*\} finally \{[\s\S]*?writeFile\(release, "release"\)/u);
    expect(liveTest).toMatch(/handle\.completion[\s\S]*?waitForStopped\(identity!, 30_000\)[\s\S]*?if \(liveAncestorSubstitution === "JUNCTION_INSTALLED"\)[\s\S]*?rmdir\(profilesPath\)/u);
    expect(liveTest).toMatch(/finalObservation\.state\s*!==\s*"STOPPED"[\s\S]*?PROFILE_PATH_CHAIN_LIVE_FIXTURE_STOP_UNPROVEN/u);
  });

  it("roots strict native ACL verification and recursive cleanup inside the disposable fixture", () => {
    const fixtureSetup = /async function makeFixture\([\s\S]*?(?=\n\s{2}\}\n\}\);)/u.exec(profileChainAcceptanceSource)?.[0] ?? "";
    expect(fixtureSetup).toMatch(/existingRealDirectory\(userProfile\)[\s\S]*?existingRealDirectory\(localAppData\)/u);
    expect(fixtureSetup).toMatch(/relative\(userProfile, localAppData\)[\s\S]*?PROFILE_PATH_CHAIN_LOCALAPPDATA_OUTSIDE_USERPROFILE/u);
    expect(fixtureSetup).not.toMatch(/nativeIdentity\(localAppData,\s*"directory",\s*userProfile\)/u);
    expect(fixtureSetup).toMatch(/mkdtemp\(join\(parse\(tmpdir\(\)\)\.root,\s*"ebb-orchestrator-profile-chain-e2e-"\)\)/u);
    expect(fixtureSetup).toMatch(/const homeRoot = join\(fixtureParent, "home"\)[\s\S]*?setPrivateOwnerAcl\(\[fixtureParent\]\)[\s\S]*?setPrivateOwnerAcl\(\[homeRoot\]\)[\s\S]*?nativeIdentity\(homeRoot,\s*"directory",\s*fixtureParent,\s*"strict-root"\)/u);
    expect(fixtureSetup).toMatch(/nativeIdentity\(profile,\s*"directory",\s*fixtureParent\)[\s\S]*?nativeIdentity\(home,\s*"directory",\s*fixtureParent\)/u);
    expect(fixtureSetup).toMatch(/throw new Error\(\s*`HERMES_SOURCE_SNAPSHOT_FAILED:\$\{snapshotFailurePhase \?\? "UNKNOWN"\}/u);
    expect(fixtureSetup).not.toContain("throw snapshotError;");
    expect(profileChainAcceptanceSource).toMatch(/identityPoint === "strict-root"[\s\S]*?chain\?\.authRootIndex[\s\S]*?chain\?\.components\?\.\[chain\.authRootIndex!\]/u);
    expect(profileChainAcceptanceSource).toMatch(/waitForStopped\(identity,\s*30_000\)[\s\S]*?nativeIdentity\(\s*fixtureHome\.identityProbe,\s*"directory",\s*fixtureHome\.strictRoot,\s*"strict-root",?\s*\)[\s\S]*?rm\(fixtureHome\.path,\s*\{\s*recursive:\s*true/u);
    expect(fixtureSetup).toMatch(/rmdir\(homeRoot\)[\s\S]*?rmdir\(fixtureParent\)/u);
  });

  it("restores the deny-delete path-chain fixture ACL even when an assertion fails", () => {
    const fixtureLoop = /for \(const \[label, deny, expectAccepted\] of \[[\s\S]*?\n  \}\n\n  for \(const \[label, readOnlyRight\]/u.exec(nativeHermesHarnessSource)?.[0] ?? "";
    expect(fixtureLoop).toMatch(/try \{[\s\S]*?const aceResult = invoke\([\s\S]*?\} finally \{\s*if \(deny\) restoreWindowsFixtureForeignDenyDelete\(aceParent\);\s*\}/u);
    expect(nativeHermesHarnessSource).toMatch(/function restoreWindowsFixtureForeignDenyDelete\(directory\)[\s\S]*?\[directory, "\/remove:d", "\*S-1-1-0", "\/T", "\/C"\]/u);
    expect(nativeHermesHarnessSource).toMatch(/function makeWindowsFixturePrivate\(directory\)[\s\S]*?spawnSync\(powershell,[\s\S]*?cwd: serverDirectory/u);
    expect(nativeHermesHarnessSource).toMatch(/\$inherit = \[System\.Security\.AccessControl\.InheritanceFlags\]::None; if \(\(Get-Item -LiteralPath \$path\)\.PSIsContainer\)/u);
  });

  it("uses a Hermes-compatible executable leaf name in the Windows launch-ticket fixture", () => {
    expect(profileChainAcceptanceSource).toMatch(/const shim = join\(root, "hermes\.exe"\)/u);
    expect(profileChainAcceptanceSource).toMatch(/const launchFailureCode = safeHermesLaunchFailureAssertionContext\(error\)/u);
  });

  it("uses the same bounded foreign ancestor ACL policy in both Windows native helpers", () => {
    const ancestorAclSource = /bool safeProfileAncestorAcl\([\s\S]*?(?=\nbool safePrivateProfileDirectoryAcl)/u.exec(nativeSource)?.[0] ?? "";
    expect(nativeSource).toMatch(/#include "\.\.\/hermes-profile-path\/hermes-profile-path-acl-policy\.h"/u);
    expect(ancestorAclSource).toMatch(/EqualSid\(trustee, owner\) \|\| trustedPathTrustee\(trustee, currentUser\)/u);
    expect(ancestorAclSource).toMatch(/safeAncestorAcePolicy\(\s*header->AceType,\s*header->AceFlags,\s*ace->Mask,/u);
    expect(ancestorAclSource).not.toMatch(/ace->Mask & ~ebb::hermes::profile_path::kAllowedForeignDirectoryRights/u);
    expect(nativeSource).not.toMatch(/kForeignAncestorMask/u);
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
