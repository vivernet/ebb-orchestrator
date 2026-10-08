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
const sourceSnapshotAcceptanceSource = readFileSync(
  new URL("../../e2e/hermes-source-snapshot.acceptance.test.ts", import.meta.url),
  "utf8",
);
const nativeHermesHarnessSource = readFileSync(
  new URL("../../../scripts/test-hermes-profile-path-native.mjs", import.meta.url),
  "utf8",
);
const windowsFixtureAclSource = readFileSync(
  new URL("../../../scripts/windows-fixture-acl.mjs", import.meta.url),
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

  it("revalidates the ticket-bound volume-root identity before applying the root-only ACL exception", () => {
    const profileChain = /bool openTicketProfileChain\([\s\S]*?\n\}/u.exec(nativeSource)?.[0] ?? "";
    const rootVerification = /const auto verifyComponent = \[&\]\(HANDLE handle, size_t index\) \{[\s\S]*?\n {2}\};/u.exec(profileChain)?.[0] ?? "";

    expect(nativeSource).toMatch(/GetFinalPathNameByHandleW\(handle[\s\S]*?FILE_NAME_NORMALIZED \| VOLUME_NAME_GUID/u);
    expect(nativeSource).toMatch(/isCanonicalVolumeGuidRootPath\(std::wstring\(finalPath\.data\(\), pathLength\)\)/u);
    expect(profileChain).toMatch(/verifiedVolumeRootHandle\(handle, expected\.first, expected\.second\)/u);
    expect(profileChain).toMatch(/safeProfileAncestorAcl\(handle, currentUser, true\)/u);
    expect(rootVerification.indexOf("verifiedVolumeRootHandle")).toBeLessThan(
      rootVerification.indexOf("safeProfileAncestorAcl(handle, currentUser, true"),
    );
    expect(rootVerification).toMatch(/if \(index < metadata\.authRootIndex\) return safeProfileAncestorAcl\(handle, currentUser\)/u);
    expect(rootVerification).not.toMatch(/index < metadata\.authRootIndex\) return safeProfileAncestorAcl\(handle, currentUser, true/u);
    expect(profileChain.indexOf("verifyComponent(volumeRootHandle.value, 0)")).toBeLessThan(
      profileChain.indexOf("handles->push_back(std::move(volumeRootHandle))"),
    );
    expect(nativeSource).toMatch(/heldPathChainCommitment\("STOPPED_HELD"/u);
  });

  it("restores a fixture ACL only after authoritative STOPPED proof", () => {
    const mutationTest = /it\("rejects a Run-profile ACL change in the suspended CreateProcessW-to-ACK window"[\s\S]*?(?=\n {2}it\()/u.exec(profileChainAcceptanceSource)?.[0] ?? "";
    const fixtureTeardown = /afterAll\(async \(\) => \{[\s\S]*?\n {2}\}, 300_000\);/u.exec(profileChainAcceptanceSource)?.[0] ?? "";

    expect(mutationTest).toMatch(/let stopProven = false/u);
    expect(mutationTest).toMatch(/waitForStopped\(publishedIdentity!, 30_000\)[\s\S]*?stopProven = stopped\.state === "STOPPED"/u);
    expect(mutationTest).toMatch(/if \(aclMutationAttempted && stopProven\) await removeForeignWriteAce\(fixture\.profile, fixture\.systemPaths\)/u);
    expect(fixtureTeardown).toMatch(/for \(const fixtureHome of fixtureHomes\.reverse\(\)\)[\s\S]*?for \(const attempt of fixtureHome\.launchAttempts\)[\s\S]*?waitForStopped\(attempt\.identity, 30_000\)[\s\S]*?observation\.state !== "STOPPED"[\s\S]*?removeWindowsFixtureTree\(fixtureHome\.path, fixtureHome\.identity\)/u);
    expect(fixtureTeardown).not.toMatch(/\brm\s*\(|\brmdir\s*\(/u);
  });

  it("binds every launch attempt and STOP proof to its own fixture", () => {
    const managedFixture = /interface ManagedFixtureHome \{([\s\S]*?)\n\}/u.exec(profileChainAcceptanceSource)?.[1] ?? "";
    const launchTracker = /async function launchForFixture\([\s\S]*?(?=\n {2}it\()/u.exec(profileChainAcceptanceSource)?.[0] ?? "";
    const fixtureTeardown = /afterAll\(async \(\) => \{([\s\S]*?)\n {2}\}, 300_000\);/u.exec(profileChainAcceptanceSource)?.[1] ?? "";
    expect(managedFixture).toMatch(/launchAttempted: boolean/u);
    expect(managedFixture).toMatch(/launchAttempts: Array<\{[\s\S]*?identity: ProcessScopeIdentity \| undefined;[\s\S]*?attemptAwareStopRequired: boolean/u);
    expect(managedFixture).toMatch(/unprovenLaunch: boolean/u);
    expect(launchTracker).toMatch(/managed\.launchAttempted = true;[\s\S]*?managed\.launchAttempts\.push\(attempt\)/u);
    expect(launchTracker).toMatch(/attempt\.identity = identity;[\s\S]*?await onIdentity\(identity\)/u);
    expect(launchTracker).toMatch(/identity\.runId !== fixture\.runId[\s\S]*?identity\.containmentId !== expectedOwner\.containmentId[\s\S]*?identity\.launchNonce !== expectedOwner\.launchNonce[\s\S]*?managed\.unprovenLaunch = true[\s\S]*?LAUNCH_IDENTITY_MISMATCH/u);
    expect(launchTracker).toMatch(/if \(!identityPublished\)[\s\S]*?waitForStopped\(expectedOwner, 30_000\)[\s\S]*?evidence === "WINDOWS_ATTEMPT_SCOPE_ABSENT"[\s\S]*?attempt\.attemptAwareStopRequired = true[\s\S]*?managed\.unprovenLaunch = true/u);
    expect(fixtureTeardown).toMatch(/fixtureHome\.launchAttempted && \(fixtureHome\.unprovenLaunch[\s\S]*?fixtureHome\.launchAttempts\.some\(\(attempt\) => !attempt\.identity\)/u);
    expect(fixtureTeardown).toMatch(/for \(const attempt of fixtureHome\.launchAttempts\)[\s\S]*?waitForStopped\(attempt\.identity, 30_000\)/u);
    expect(fixtureTeardown).toMatch(/attempt\.attemptAwareStopRequired && finalObservation\.evidence !== "WINDOWS_ATTEMPT_SCOPE_ABSENT"/u);
    expect(fixtureTeardown).toMatch(/finalObservation = await supervisor\.waitForStopped\(attempt\.identity, 30_000\)[\s\S]*?removeWindowsFixtureTree/u);
    expect(profileChainAcceptanceSource).toMatch(/afterAll\(async \(\) => \{[\s\S]*?\n {2}\}, 300_000\);/u);
    expect(profileChainAcceptanceSource).not.toContain("observedJobIdentities");
    expect(profileChainAcceptanceSource).toMatch(/strictBoundary: fixtureParent, managedHome, profile/u);
    expect(profileChainAcceptanceSource).toMatch(/launchForFixture\(supervisor, fixture, ownerIdentity\(owner\), \(publishIdentity\) => supervisor\.launch/u);
    expect(profileChainAcceptanceSource).toMatch(/launchForFixture\(evidenceSupervisor, fixture, launchOwner, \(publishIdentity\) => evidenceSupervisor\.launch/u);
  });

  it("keeps native path-chain fixtures in system temp and fails clearly on unsafe temp ancestors", () => {
    expect(nativeHermesHarnessSource).toMatch(/const tempRoot = realpathSync\(tmpdir\(\)\)/u);
    expect(nativeHermesHarnessSource).toMatch(/const pathChainFixtureRoot = mkdtempSync\(join\(tempRoot, "ebb-hermes-profile-chain-"\)\)/u);
    expect(nativeHermesHarnessSource).not.toMatch(/mkdtempSync\(join\(parse\(tempRoot\)\.root/u);
    expect(nativeHermesHarnessSource).toMatch(/assert\.equal\(safeChain\.stdout, ""[\s\S]*?TEMP_PATH_ANCESTOR_CHAIN_NOT_ACCEPTED/u);
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
    const fixtureCreator = /async function createPrivateOwnerFixtureDirectory\(path: string, systemPaths: VerifiedWindowsSystemPaths\): Promise<void> \{[\s\S]*?(?=\n\}\n\nasync function addForeignWriteAce)/u.exec(profileChainAcceptanceSource)?.[0] ?? "";
    expect(fixtureSetup).toMatch(/existingRealDirectory\(userProfile\)[\s\S]*?existingRealDirectory\(localAppData\)/u);
    expect(fixtureSetup).toMatch(/relative\(userProfile, localAppData\)[\s\S]*?PROFILE_PATH_CHAIN_LOCALAPPDATA_OUTSIDE_USERPROFILE/u);
    expect(fixtureSetup).not.toMatch(/nativeIdentity\(localAppData,\s*"directory",\s*userProfile\)/u);
    expect(fixtureSetup).toMatch(/const fixtureRootOverride = process\.env\.EBB_PROFILE_CHAIN_FIXTURE_ROOT;[\s\S]*?const fixtureRoot = fixtureRootOverride \? resolve\(fixtureRootOverride\) : tmpdir\(\);/u);
    expect(fixtureSetup).toMatch(/const systemPaths = await getVerifiedWindowsSystemPaths\(\);[\s\S]*?const systemVolumeRoot = systemPaths\.volumeRoot;/u);
    expect(fixtureSetup).toMatch(/if \(fixtureRootOverride && \(!isAbsolute\(fixtureRootOverride\) \|\| !\/\^\[A-Za-z\]:\\\\\$\/u\.test\(fixtureRoot\) \|\|[\s\S]*?fixtureRoot\.toLowerCase\(\) !== systemVolumeRoot\.toLowerCase\(\)\)\) \{\s*throw new Error\("PROFILE_PATH_CHAIN_FIXTURE_ROOT_MUST_BE_LOCAL_SYSTEM_VOLUME_ROOT"\);/u);
    expect(fixtureSetup).toMatch(/if \(!\(await existingRealDirectory\(fixtureRoot\)\)\) throw new Error\("PROFILE_PATH_CHAIN_FIXTURE_ROOT_UNAVAILABLE"\);/u);
    expect(fixtureSetup).toMatch(/const fixtureParent = join\(fixtureRoot, `ebb-orchestrator-profile-chain-e2e-\$\{randomUUID\(\)\}`\);/u);
    expect(fixtureSetup).toMatch(/homes\.push\(managedHome\);[\s\S]*?createPrivateOwnerFixtureDirectory\(fixtureParent, systemPaths\);[\s\S]*?managedHome\.identity = await nativeIdentity\(homeRoot, "directory", fixtureParent, "strict-root"\)/u);
    expect(fixtureSetup).not.toMatch(/rmdir\(homeRoot\)|rmdir\(fixtureParent\)/u);
    expect(fixtureSetup).toMatch(/await createPrivateOwnerFixtureDirectory\(fixtureParent, systemPaths\);[\s\S]*?await mkdir\(homeRoot\);[\s\S]*?await setPrivateOwnerAcl\(\[homeRoot\], systemPaths\)[\s\S]*?nativeIdentity\(homeRoot,\s*"directory",\s*fixtureParent,\s*"strict-root"\)/u);
    expect(fixtureCreator).toMatch(/\$identity=\[Security\.Principal\.WindowsIdentity\]::GetCurrent\(\)\.User;/u);
    expect(fixtureCreator).toMatch(/\$acl\.SetAccessRuleProtection\(\$true,\$false\); \$acl\.SetOwner\(\$identity\);/u);
    expect(fixtureCreator).toMatch(/\$inherit=\[Security\.AccessControl\.InheritanceFlags\]::ContainerInherit -bor \[Security\.AccessControl\.InheritanceFlags\]::ObjectInherit;[\s\S]*?FileSystemAccessRule\]::new\(\$identity,\[Security\.AccessControl\.FileSystemRights\]::FullControl,\$inherit,\[Security\.AccessControl\.PropagationFlags\]::None,\[Security\.AccessControl\.AccessControlType\]::Allow\)[\s\S]*?\$acl\.AddAccessRule\(\$rule\);/u);
    expect(fixtureCreator).toMatch(/\$directory=\[IO\.DirectoryInfo\]::new\(\$path\); \$directory\.Create\(\$acl\);[\s\S]*?\$verified=\$directory\.GetAccessControl\(\);/u);
    expect(fixtureCreator).toMatch(/\$verified\.AreAccessRulesProtected[\s\S]*?GetOwner\(\[Security\.Principal\.SecurityIdentifier\]\)\.Value -ne \$identity\.Value/u);
    expect(fixtureCreator).toMatch(/\$rules=@\(\$verified\.Access\);[\s\S]*?\$rules\.Count -ne 1[\s\S]*?IdentityReference\.Translate\(\[Security\.Principal\.SecurityIdentifier\]\)\.Value -ne \$identity\.Value[\s\S]*?AccessControlType -ne \[Security\.AccessControl\.AccessControlType\]::Allow[\s\S]*?\[int\]\$rules\[0\]\.FileSystemRights -ne 0x001F01FF[\s\S]*?InheritanceFlags -ne \$inherit[\s\S]*?PropagationFlags -ne \[Security\.AccessControl\.PropagationFlags\]::None[\s\S]*?IsInherited/u);
    expect(fixtureSetup).not.toMatch(/mkdtemp\(join\(tmpdir\(\),\s*"ebb-orchestrator-profile-chain-e2e-"\)\)/u);
    expect(fixtureSetup).not.toMatch(/setPrivateOwnerAcl\(\[fixtureParent\]\)/u);
    expect(fixtureSetup).toMatch(/nativeIdentity\(profile,\s*"directory",\s*fixtureParent\)[\s\S]*?nativeIdentity\(home,\s*"directory",\s*fixtureParent\)/u);
    expect(fixtureSetup).toMatch(/throw new Error\(\s*`HERMES_SOURCE_SNAPSHOT_FAILED:\$\{snapshotFailurePhase \?\? "UNKNOWN"\}/u);
    expect(fixtureSetup).not.toContain("throw snapshotError;");
    expect(profileChainAcceptanceSource).toMatch(/identityPoint === "strict-root"[\s\S]*?chain\?\.authRootIndex[\s\S]*?chain\?\.components\?\.\[chain\.authRootIndex!\]/u);
    expect(profileChainAcceptanceSource).toMatch(/waitForStopped\(attempt\.identity,\s*30_000\)[\s\S]*?nativeIdentity\(\s*fixtureHome\.identityProbe,\s*"directory",\s*fixtureHome\.strictRoot,\s*"strict-root",?\s*\)[\s\S]*?removeWindowsFixtureTree\(fixtureHome\.path, fixtureHome\.identity\)/u);
    expect(profileChainAcceptanceSource).toMatch(/if \(!fixtureHome\.identity\) throw new Error\("PROFILE_PATH_CHAIN_FIXTURE_CLEANUP_IDENTITY_UNPROVEN"\);[\s\S]*?nativeIdentity\([\s\S]*?sameNativeIdentity\(currentIdentity, fixtureHome\.identity\)[\s\S]*?removeWindowsFixtureTree\(fixtureHome\.path, fixtureHome\.identity\)/u);
    expect(profileChainAcceptanceSource).not.toMatch(/rm\(fixtureHome\.path|rmdir\(fixtureHome\.path/u);
  });

  it("uses native-verified Windows system paths instead of caller-controlled SystemRoot aliases", () => {
    const fixtureSetup = /async function makeFixture\([\s\S]*?(?=\n\s{2}\}\n\}\);)/u.exec(profileChainAcceptanceSource)?.[0] ?? "";
    const systemPathResolver = /async function getVerifiedWindowsSystemPaths\(\)[\s\S]*?(?=\n\}\n)/u.exec(profileChainAcceptanceSource)?.[0] ?? "";
    const identityParser = /function parseVerifiedWindowsSystemPowerShellIdentity\(stdout: string\)[\s\S]*?(?=\n\}\n)/u.exec(profileChainAcceptanceSource)?.[0] ?? "";
    expect(fixtureSetup).toMatch(/const systemPaths = await getVerifiedWindowsSystemPaths\(\)/u);
    expect(fixtureSetup).not.toMatch(/process\.env\.(?:SystemRoot|SYSTEMROOT|WINDIR)/u);
    expect(systemPathResolver).toMatch(/verifyNativeHelperIntegrity\(profileHelper, "hermesProfilePath"\)[\s\S]*?spawnSync\(profileHelper,[\s\S]*?\["verify-windows-system-powershell"\][\s\S]*?shell:\s*false[\s\S]*?timeout:\s*15_000[\s\S]*?maxBuffer:\s*8_192/u);
    expect(systemPathResolver).not.toMatch(/process\.env\.(?:SystemRoot|SYSTEMROOT|WINDIR|PATH)/u);
    expect(systemPathResolver).not.toMatch(/resolve\([^)]*(?:SystemRoot|SYSTEMROOT|WINDIR|PATH)/u);
    expect(identityParser).toMatch(/Object\.keys\(identity\)\.sort\(\)\.join\(","\) !== "fileId,kind,path,status,volumeSerial"[\s\S]*?identity\.status !== "SAFE_PATH"[\s\S]*?identity\.kind !== "file"/u);
    expect(identityParser).toMatch(/identity\.fileId[\s\S]*?\^\[a-f0-9\]\{32\}\$[\s\S]*?identity\.volumeSerial[\s\S]*?\^\[a-f0-9\]\{16\}\$[\s\S]*?system32\\\\windowspowershell\\\\v1\.0\\\\powershell\.exe/u);
    expect(profileChainAcceptanceSource).toMatch(/execFileSync\(systemPaths\.powershell[\s\S]*?SystemRoot:\s*systemPaths\.systemRoot[\s\S]*?SYSTEMROOT:\s*systemPaths\.systemRoot/u);
    expect(profileChainAcceptanceSource).toMatch(/function buildFixtureIccaclsInvocation\([\s\S]*?system32: string[\s\S]*?join\(system32, "icacls\.exe"\)/u);
    expect(profileChainAcceptanceSource).not.toMatch(/join\(process\.env\.(?:SystemRoot|SYSTEMROOT|WINDIR)[\s\S]{0,80}?(?:powershell|icacls)/iu);
    const helperChildEnvironment = /const environment = \{([\s\S]*?)\n\s{6}\};/u.exec(profileChainAcceptanceSource)?.[1] ?? "";
    expect(helperChildEnvironment).toMatch(/SYSTEMROOT: systemPaths\.systemRoot/u);
    expect(helperChildEnvironment).not.toMatch(/\bSystemRoot:/u);
    expect(helperChildEnvironment).toMatch(/process\.env\.TEMP[\s\S]*?process\.env\.TMP/u);
    expect(profileChainAcceptanceSource).toMatch(/originalSystemRootAliases[\s\S]*?restoreSystemRootAliases\(\)/u);
  });

  it("creates the Windows source-snapshot fixture with an atomic private DACL at volume root", () => {
    expect(sourceSnapshotAcceptanceSource).toMatch(/const systemPowerShellPath = await resolveVerifiedSystemPowerShellPath\(\);[\s\S]*?const volumeRoot = win32\.parse\(systemPowerShellPath\)\.root;[\s\S]*?fixtureDirectory = candidate;\s*createWindowsPrivateFixtureDirectory\(candidate,\s*\{\s*serverDirectory:[\s\S]*?systemPowerShellPath/u);
    expect(sourceSnapshotAcceptanceSource).toMatch(/async function resolveVerifiedSystemPowerShellPath\(\)[\s\S]*?runVerifiedNativeHelper\(profileHelperPath, "hermesProfilePath", \["verify-windows-system-powershell"\][\s\S]*?\^\[A-Za-z\]:\\\\\$[\s\S]*?endsWith\("\\\\system32\\\\windowspowershell\\\\v1\.0\\\\powershell\.exe"\)/u);
    expect(sourceSnapshotAcceptanceSource).not.toContain("EBB_PROFILE_CHAIN_FIXTURE_ROOT");
    expect(sourceSnapshotAcceptanceSource).toMatch(/fixtureDirectory = await mkdtemp\(join\(tmpdir\(\), "ebb-hermes-source-acceptance-"\)\);[\s\S]*?fixtureDirectoryIdentity = await objectIdentity\(fixtureDirectory, "directory"\);/u);
    expect(sourceSnapshotAcceptanceSource).toMatch(/const cacheRoot = join\(fixtureDirectory, "source-cache"\);\s*await mkdir\(cacheRoot,[\s\S]*?objectIdentity\(cacheRoot, "directory"\)/u);
    expect(sourceSnapshotAcceptanceSource).not.toMatch(/makeWindowsFixturePrivate\(fixtureDirectory/u);
    expect(sourceSnapshotAcceptanceSource).not.toMatch(/makeWindowsFixturePrivate\(cacheRoot/u);
    expect(sourceSnapshotAcceptanceSource).toMatch(/objectIdentity\(python, "file", windows \? dirname\(python\) : undefined\)/u);
    expect(sourceSnapshotAcceptanceSource).toMatch(/const args = strictRoot[\s\S]*?kind === "file"[\s\S]*?verify-safe-file-chain/u);
    expect(sourceSnapshotAcceptanceSource).toMatch(/withHermesSourceSnapshotFailureObserver\([\s\S]*?snapshotFailurePhase = phase[\s\S]*?materializeHermesSourceSnapshot\([\s\S]*?SOURCE_ACCEPTANCE_SNAPSHOT_FAILED:\$\{snapshotFailurePhase \?\? "UNKNOWN"\}/u);
    expect(sourceSnapshotAcceptanceSource).toMatch(/function collectNativeHelperEvidence\([\s\S]*?if \(evidence\.length > 0\)[\s\S]*?return safeHermesLaunchFailureAssertionContext\(error\);/u);
    expect(sourceSnapshotAcceptanceSource).toMatch(/for \(const variant of \["changed", "missing", "extra", "hash", "malformed"\] as const\)[\s\S]*?expectedProjection: variant === "missing" \|\| variant === "malformed"[\s\S]*?expectedNativeFailureCode: variant === "hash"[\s\S]*?LAUNCH_TICKET_SOURCE_SNAPSHOT_TREE_MISMATCH:CONTENT_MISMATCH[\s\S]*?LAUNCH_TICKET_SOURCE_SNAPSHOT_PROJECTION_UNSAFE/u);
    expect(sourceSnapshotAcceptanceSource).toMatch(/expectedLinuxFailureCode: variant === "missing"[\s\S]*?HERMES_SOURCE_PROJECTION_UNAVAILABLE[\s\S]*?HERMES_SOURCE_SNAPSHOT_CONTENT_MISMATCH/u);
    expect(sourceSnapshotAcceptanceSource).toMatch(/expect\(nativeRefusalEvidence, `\$\{input\.variant\} EHSP refusal evidence`\)\.toBe\([\s\S]*?WINDOWS_HELPER_NATIVE_UNKNOWN:\$\{input\.expectedNativeFailureCode\}/u);
    expect(sourceSnapshotAcceptanceSource).toMatch(/expect\(nativeRefusalEvidence, `\$\{input\.variant\} EHSP refusal evidence`\)\.toBe\([\s\S]*?HERMES_LINUX_LAUNCH_REFUSED:\$\{input\.expectedLinuxFailureCode\}/u);
    expect(sourceSnapshotAcceptanceSource).toMatch(/expect\(refusal\.observation\.state[\s\S]*?\.toBe\("STOPPED"\)[\s\S]*?markerExists\(refusal\.markerPath\)[\s\S]*?\.toBe\(false\)/u);
    const atomicFixtureCreator = /export function createWindowsPrivateFixtureDirectory[\s\S]*?(?=\n\})/u.exec(windowsFixtureAclSource)?.[0] ?? "";
    expect(atomicFixtureCreator).not.toBe("");
    expect(atomicFixtureCreator).toContain("win32.dirname(normalized)");
    expect(atomicFixtureCreator).toContain("!/^[A-Za-z]:");
    expect(atomicFixtureCreator).toContain("normalizedPowerShellPath");
    expect(atomicFixtureCreator).toContain("$directory.Create($acl)");
    expect(atomicFixtureCreator).toContain("$directory.GetAccessControl()");
    expect(atomicFixtureCreator).toContain("InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit");
    expect(atomicFixtureCreator).toContain("$rules[0].InheritanceFlags -ne $inherit");
    expect(atomicFixtureCreator).toContain("WINDOWS_FIXTURE_PRIVATE_CREATE_FAILED");
    expect(windowsFixtureAclSource).not.toMatch(/createWindowsPrivateFixtureDirectory[\s\S]*?SetAccessControl/u);
    expect(sourceSnapshotAcceptanceSource).toMatch(/function safeWindowsRefusalEvidence\(stderr: string, stdout: string\)[\s\S]*?lines\.length !== 1[\s\S]*?WINDOWS_HELPER_NATIVE_UNKNOWN:[\s\S]*?UNKNOWN\\t\(LAUNCH_TICKET_SOURCE_SNAPSHOT_PROJECTION_UNSAFE\|LAUNCH_TICKET_SOURCE_SNAPSHOT_TREE_MISMATCH\)/u);
  });

  it("restores the deny-delete path-chain fixture ACL even when an assertion fails", () => {
    const fixtureLoop = /for \(const \[label, deny, expectAccepted\] of \[[\s\S]*?\n {2}\}\n\n {2}for \(const \[label, readOnlyRight\]/u.exec(nativeHermesHarnessSource)?.[0] ?? "";
    expect(fixtureLoop).toMatch(/try \{[\s\S]*?const aceResult = invoke\([\s\S]*?\} finally \{\s*if \(deny\) restoreWindowsFixtureForeignDenyDelete\(aceParent\);\s*\}/u);
    expect(nativeHermesHarnessSource).toMatch(/function restoreWindowsFixtureForeignDenyDelete\(directory\)[\s\S]*?\[directory, "\/remove:d", "\*S-1-1-0", "\/T", "\/C"\]/u);
    expect(nativeHermesHarnessSource).toMatch(/function makeWindowsFixturePrivate\(directory\)[\s\S]*?setWindowsFixturePrivate\(directory, \{ serverDirectory, systemRoot: process\.env\.SYSTEMROOT \}\)/u);
    expect(windowsFixtureAclSource).toMatch(/spawnSync\(powershell,[\s\S]*?cwd: serverDirectory/u);
    expect(windowsFixtureAclSource).toMatch(/target = lstatSync\(directory\)/u);
    expect(windowsFixtureAclSource).toMatch(/target\.isSymbolicLink\(\) \|\| \(!target\.isDirectory\(\) && !target\.isFile\(\)\)/u);
    expect(windowsFixtureAclSource).toMatch(/const isDirectory = target\.isDirectory\(\)/u);
    expect(windowsFixtureAclSource).toMatch(/\$isDirectory = \[System\.Environment\]::GetEnvironmentVariable\('EBB_HERMES_PROFILE_TEST_IS_DIRECTORY'\)/u);
    expect(windowsFixtureAclSource).toMatch(/\$inherit = \[System\.Security\.AccessControl\.InheritanceFlags\]::None; if \(\$isDirectory -eq '1'\) \{ \$inherit = \[System\.Security\.AccessControl\.InheritanceFlags\]::ContainerInherit -bor \[System\.Security\.AccessControl\.InheritanceFlags\]::ObjectInherit \}/u);
    expect(windowsFixtureAclSource).toMatch(/if \(\$isDirectory -eq '1'\) \{ \[System\.IO\.DirectoryInfo\]::new\(\$path\) \} else \{ \[System\.IO\.FileInfo\]::new\(\$path\) \}/u);
    expect(windowsFixtureAclSource).toMatch(/\$acl = \$item\.GetAccessControl\(\);/u);
    expect(windowsFixtureAclSource).toMatch(/\$item\.SetAccessControl\(\$acl\);/u);
    expect(windowsFixtureAclSource).not.toMatch(/Get-Acl|Set-Acl/u);
    const aclChildEnvironment = /env: \{([\s\S]*?)\n\s*\},/u.exec(windowsFixtureAclSource)?.[1] ?? "";
    expect(aclChildEnvironment).toMatch(/EBB_HERMES_PROFILE_TEST_ROOT: directory/u);
    expect(aclChildEnvironment).toMatch(/EBB_HERMES_PROFILE_TEST_IS_DIRECTORY: isDirectory \? "1" : "0"/u);
    expect(aclChildEnvironment).not.toMatch(/\.\.\.process\.env/u);
    expect(windowsFixtureAclSource).not.toMatch(/Get-Item/u);
    expect(windowsFixtureAclSource).toMatch(/timeout: WINDOWS_FIXTURE_ACL_TIMEOUT_MS/u);
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
