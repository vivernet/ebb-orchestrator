import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const nativeAcceptanceScript = readFileSync(
  new URL("../../scripts/test-hermes-profile-path-native.mjs", import.meta.url),
  "utf8",
);
const nativeSource = readFileSync(
  new URL("../../native/hermes-profile-path/ebb-hermes-profile-path.cpp", import.meta.url),
  "utf8",
);
const pathChainAcceptance = readFileSync(
  new URL("../e2e/hermes-profile-path-chain.acceptance.test.ts", import.meta.url),
  "utf8",
);
const aclPolicyHeader = readFileSync(
  new URL("../../native/hermes-profile-path/hermes-profile-path-acl-policy.h", import.meta.url),
  "utf8",
);
const snapshotSource = readFileSync(
  new URL("../../src/modules/runtime/hermes/hermes-source-snapshot.ts", import.meta.url),
  "utf8",
);
const snapshotAcceptanceSource = readFileSync(
  new URL("../e2e/hermes-source-snapshot.acceptance.test.ts", import.meta.url),
  "utf8",
);
const snapshotGcLimits = readFileSync(
  new URL("../../src/modules/runtime/hermes/hermes-source-snapshot-gc-limits.ts", import.meta.url),
  "utf8",
);
const runtimeAdapterSource = readFileSync(
  new URL("../../src/modules/runtime/hermes/hermes-runtime-adapter.ts", import.meta.url),
  "utf8",
);
const safeDirectoryStatusHandler = /if \(safeDirectory\.status === 0\) \{[\s\S]*?\} else if \(safeDirectory\.status === 41\) \{([\s\S]*?)\n\s*\} else \{/u.exec(
  nativeAcceptanceScript,
);

describe("native Hermes profile-path safe-path acceptance reporting", () => {
  it("keeps the TypeScript and native helper bound to the verified Hermes source revision", () => {
    const providerSelectionSource = readFileSync(
      new URL("../../src/modules/runtime/hermes/hermes-provider-selection.ts", import.meta.url),
      "utf8",
    );
    const pinnedVersion = "v0.21.5+9117.g08165d5";
    const pinnedCommit = "08165d58931841cee713468ae89032af7c57060a";

    expect(providerSelectionSource).toContain(`version: '${pinnedVersion}'`);
    expect(providerSelectionSource).toContain(`commit: '${pinnedCommit}'`);
    expect(nativeSource).toContain(`kHermesVersion = "${pinnedVersion}"`);
    expect(nativeSource).toContain(`kHermesCommit = "${pinnedCommit}"`);
  });

  it("fails closed when exit code 41 leaves safe-path acceptance unverified", () => {
    expect(safeDirectoryStatusHandler).not.toBeNull();
    const code41Handler = safeDirectoryStatusHandler?.[1] ?? "";

    expect(code41Handler).toMatch(/assert\.fail\(/u);
    expect(code41Handler).toMatch(/safe-path acceptance was not verified[\s\S]*41/iu);
    expect(code41Handler).not.toMatch(/process\.stdout\.write/u);
    expect(code41Handler).not.toMatch(/READ_CONTROL/iu);
  });

  it("emits and accepts only bounded safe-path refusal diagnostics", () => {
    expect(nativeSource).toMatch(/void printSafePathRefusal\([\s\S]*?VERIFY_SAFE_PATH_REFUSED:[\s\S]*?kMaxPathChainComponents[\s\S]*?64_PLUS[\s\S]*?aclStage <= 6/u);
    expect(nativeSource).toMatch(/printSafePathRefusal\("COMPONENT_ACL", index, aclFailureStage\)/u);
    expect(nativeSource).not.toMatch(/printSafePathRefusal\([^\n]*(?:rawPath|Sid|Mask|GetLastError)/iu);
    const sanitizer = /function safeWindowsPathRefusalEvidence\([\s\S]*?\n\}/u.exec(snapshotAcceptanceSource)?.[0] ?? "";
    expect(sanitizer).toContain("VERIFY_SAFE_PATH_REFUSED:");
    expect(sanitizer).toMatch(/lines\.length !== 1/u);
    expect(sanitizer).toMatch(/64_PLUS/u);
    expect(sanitizer).not.toMatch(/stderr\.match\(/u);
  });

  it("routes Linux path verification through the descriptor-bound verifier and exercises its identities", () => {
    const linuxDispatch = /if \(argc == 4 && std::string\(argv\[1\]\) == "verify-safe-path"\) return ([^;]+);/u.exec(nativeSource);

    expect(nativeSource).toMatch(/int verifySafePosixPath\(const std::string& rawPath, const std::string& rawKind\)/u);
    expect(linuxDispatch?.[1]).toBe("verifySafePosixPath(argv[3], argv[2])");
    expect(nativeSource).toMatch(/openat\(current, component\.c_str\(\), O_RDONLY \| O_DIRECTORY \| O_CLOEXEC \| O_NOFOLLOW\)/u);
    expect(nativeSource).toMatch(/openat\(parent, components\.back\(\)\.c_str\(\), O_PATH \| O_CLOEXEC \| O_NOFOLLOW\)/u);
    expect(nativeSource).toMatch(/fstat\(target, &info\)/u);
    expect(nativeAcceptanceScript).toMatch(/else if \(process\.platform === "linux"\) \{[\s\S]*?verify-safe-path[\s\S]*?directoryIdentity[\s\S]*?device[\s\S]*?inode[\s\S]*?safeFile[\s\S]*?symlink/u);
    expect(nativeAcceptanceScript).toMatch(/spawnSync\("mkfifo", \[fifoPath\], \{[\s\S]*?shell: false[\s\S]*?\}\)/u);
    expect(nativeAcceptanceScript).toMatch(/verify-safe-path", "file", fifoPath[\s\S]*?notEqual\(fifoResult\.status, 0[\s\S]*?fifoResult\.stdout, ""/u);
    expect(nativeAcceptanceScript).toMatch(/verify-safe-path", "file", "\/dev\/null"[\s\S]*?notEqual\(characterDeviceResult\.status, 0[\s\S]*?characterDeviceResult\.stdout, ""/u);
  });

  it("scopes the TrustedInstaller exception to the native OS-derived PowerShell dependency path", () => {
    expect(nativeSource).toMatch(/GetSystemDirectoryW\(/u);
    expect(nativeSource).toMatch(/verifySafeWindowsPath\(powerShellPath, L"file", systemComponents\.size\(\), trustedInstallerSid\)/u);
    expect(nativeSource).toMatch(/argc == 2[^\n]*verify-windows-system-powershell[\s\S]*?verifyWindowsSystemPowerShell\(\)/u);
    expect(nativeSource).toMatch(/safeWindowsPowerShellTrustedInstallerAcePolicy\([\s\S]*?header->AceFlags[\s\S]*?ace->Mask/u);
    expect(aclPolicyHeader).toMatch(/\(aceFlags & INHERIT_ONLY_ACE\) == 0 && \(aceFlags & INHERITED_ACE\) != 0/u);
    expect(nativeAcceptanceScript).toMatch(/verify-windows-system-powershell[\s\S]*?OS-derived PowerShell path should pass[\s\S]*?caller-selected paths/u);
    expect(nativeAcceptanceScript).toMatch(/TrustedInstaller FullControl ACE remains rejected outside the OS-derived PowerShell chain/u);
  });

  it("binds endpoint projection to the exact planned Hermes Run profile without creating it", () => {
    expect(nativeSource).toMatch(/bool isExactPlannedProfilePath\(const std::string& configHome(?:Utf8)?, const std::string& profileHome(?:Utf8)?,\s*const std::string& runId\)/u);
    expect(nativeSource).toMatch(/bool plannedProfilePathIsSafeOrAbsent\(const std::string& configHome(?:Utf8)?, const std::string& profileHome(?:Utf8)?,[\s\S]*?bool& profileExists\)/u);
    expect(nativeSource).toMatch(/int projectEndpoint\([\s\S]*?const std::string& envVar, const std::string& runId\)/u);
    expect(nativeSource).toMatch(/argc == 9 && std::string\(argv\[1\]\) == "project-endpoint"\)[\s\S]*?return projectEndpoint\(argv\[2\], argv\[3\], argv\[4\], argv\[5\], argv\[6\], argv\[7\], argv\[8\]\)/u);
    expect(nativeSource).toMatch(/openat\([^\n]*O_DIRECTORY[^\n]*O_NOFOLLOW/u);
    expect(nativeSource).toMatch(/NtCreateFile\([\s\S]*?OBJ_CASE_INSENSITIVE \| OBJ_DONT_REPARSE/u);
    expect(nativeAcceptanceScript).toMatch(/plannedRunId[\s\S]*?plannedProfileHome[\s\S]*?project-endpoint[\s\S]*?must not create profiles\//u);
    expect(nativeSource).toMatch(/int projectSelection\(const std::string& home(?:Utf8)?, const std::string& profileHome(?:Utf8)?, const std::string& runId\)[\s\S]*?plannedProfilePathIsSafeOrAbsent\(home(?:Utf8)?, profileHome(?:Utf8)?, runId, profileExists\)/u);
    expect(nativeSource).toMatch(/argc == 5 &&[^\n]*project-selection[\s\S]*?return projectSelection\(argv\[2\], argv\[3\], argv\[4\]\)/u);
    expect(nativeAcceptanceScript).toMatch(/native Run-bound project-selection[\s\S]*?project-selection profile bound to another Run UUID/u);
    expect(nativeAcceptanceScript).toMatch(/different Hermes root[\s\S]*?another Run UUID[\s\S]*?symlink or reparse/u);
    expect(nativeAcceptanceScript).toMatch(/existing private empty Run profile/u);
    const plannedCase = /const plannedRunId = [\s\S]*?const plannedProfileCreation/u.exec(nativeAcceptanceScript)?.[0] ?? "";
    expect(plannedCase).not.toBe("");
    expect(plannedCase.indexOf("planned missing profile path before native profile creation")).toBeLessThan(plannedCase.indexOf("plannedProfileCreation"));
    expect(plannedCase).toMatch(/planned-profile projection must not create profiles\//u);
  });

  it("applies the bounded ancestor ACL policy to the Windows volume root before accepting a path-chain identity", () => {
    const verifier = /int verifySafeWindowsPathChain\([\s\S]*?\n\}/u.exec(nativeSource)?.[0] ?? "";
    const volumeRootGate = /HANDLE volume = CreateFileW\([\s\S]*?if \(!appendIdentity\(volume, driveRoot\)/u.exec(verifier)?.[0] ?? "";

    expect(verifier).not.toBe("");
    expect(volumeRootGate).toMatch(/getVerifiedVolumeRootIdentity\(volume, verifiedRootVolumeSerial, verifiedRootFileId\)/u);
    expect(volumeRootGate).toMatch(/safeAncestorPathAcl\(volume, userSid, nullptr, true\)/u);
    expect(volumeRootGate).not.toMatch(/safePathAcl\(volume/u);
    expect(volumeRootGate.indexOf("getVerifiedVolumeRootIdentity(volume")).toBeLessThan(
      volumeRootGate.indexOf("safeAncestorPathAcl(volume, userSid"),
    );
    expect(volumeRootGate).toMatch(/closePathChainHandles\(heldHandles\);\s*return kPathRootUnsafe;/u);
    expect(verifier).toMatch(/if \(!appendIdentity\(volume, driveRoot\) \|\| identities\.front\(\)\.volumeSerial != verifiedRootVolumeSerial \|\|\s*identities\.front\(\)\.fileId != verifiedRootFileId\)/u);
    expect(verifier.indexOf("appendIdentity(volume, driveRoot)")).toBeLessThan(
      verifier.indexOf("for (size_t index = 0; index < identities.size(); ++index)"),
    );
    expect(verifier).toMatch(/authRootIndex[\s\S]*?<< authRootIndex/u);
    expect(nativeSource).toMatch(/GetFinalPathNameByHandleW\(handle[\s\S]*?FILE_NAME_NORMALIZED \| VOLUME_NAME_GUID/u);
    expect(nativeSource).toMatch(/isCanonicalVolumeGuidRootPath\(std::wstring\(finalPath\.data\(\), pathLength\)\)/u);
    expect(nativeSource).toMatch(/constexpr size_t kGuidLength = 36/u);
    expect(nativeSource).toMatch(/CompareStringOrdinal\(path\.data\(\),[\s\S]*?kPrefix/u);
  });

  it("applies the same verified volume-root exception to Hermes file chains without changing their strict root", () => {
    const verifier = /int verifySafeWindowsFilePathChain\([\s\S]*?\n\}/u.exec(nativeSource)?.[0] ?? "";
    const volumeRootGate = /HANDLE volume = CreateFileW\([\s\S]*?const size_t strictRootIndex/u.exec(verifier)?.[0] ?? "";

    expect(verifier).not.toBe("");
    expect(volumeRootGate).toMatch(/getVerifiedVolumeRootIdentity\(volume, verifiedRootVolumeSerial, verifiedRootFileId\)/u);
    expect(volumeRootGate).toMatch(/safeAncestorPathAcl\(volume, userSid, nullptr, true\)/u);
    expect(volumeRootGate).not.toMatch(/safePathAcl\(volume/u);
    expect(volumeRootGate).toMatch(/expectedVolumeSerial != verifiedRootVolumeSerial[\s\S]*?volumeFileId != verifiedRootFileId/u);
    expect(verifier).toMatch(/chainIndex < strictRootIndex\s*\?\s*safeAncestorPathAcl\(next, userSid, &aclFailureStage\)\s*:\s*safePathAcl\(next, userSid, true, true, false, &aclFailureStage\)/u);
    expect(verifier).toMatch(/volumeSerial != expectedVolumeSerial/u);
  });

  it("checks Windows config root and config-file mutation ACLs on the handles it reads", () => {
    expect(nativeSource).toMatch(/bool openWindowsConfig\(const std::wstring& configHome, PSID userSid, HANDLE& directory, HANDLE& file\)/u);
    expect(nativeSource).toMatch(/openWindowsDirectory\(configHome, true, userSid, false, true\)/u);
    expect(nativeSource).toMatch(/safeDirectoryAcl\(directory, userSid, true\)/u);
    expect(nativeSource).toMatch(/NtCreateFile\(&opened, GENERIC_READ \| FILE_READ_ATTRIBUTES \| READ_CONTROL \| SYNCHRONIZE/u);
    expect(nativeSource).toMatch(/safeReadOnlyFileAcl\(opened, userSid\)/u);
    expect(nativeSource).toMatch(/bool readWindowsConfig\([\s\S]*?openWindowsConfig\(configHome, userSid, directory, file\)[\s\S]*?CloseHandle\(file\);\s*CloseHandle\(directory\);/u);
    expect(nativeAcceptanceScript).toMatch(/unsafe Hermes config root DACL/u);
    expect(nativeAcceptanceScript).toMatch(/config\.yaml writable by an untrusted principal/u);
  });

  it("writes the exact Run profile home and config relative to verified Windows handles", () => {
    const initializeProfile = /bool initializeWindowsRunProfile\([\s\S]*?\n\}\n/u.exec(nativeSource)?.[0] ?? "";
    const configCreate = /HANDLE createWindowsChildFileForWrite\([\s\S]*?\n\}/u.exec(nativeSource)?.[0] ?? "";
    expect(initializeProfile).not.toBe("");
    expect(configCreate).not.toBe("");
    expect(initializeProfile).toMatch(/openWindowsDirectory\(root, true, userSid, false, true, false\)/u);
    expect(initializeProfile).toMatch(/openWindowsChildDirectory\(rootHandle, L"profiles", FILE_OPEN, [\s\S]*?false\)/u);
    expect(initializeProfile).toMatch(/widenUtf8\("ebb-orchestrator-run-" \+ runId\)/u);
    expect(initializeProfile).toMatch(/openWindowsChildDirectory\(profiles, leaf, FILE_OPEN, [\s\S]*?FILE_LIST_DIRECTORY \| FILE_ADD_FILE, false\)/u);
    expect(initializeProfile).toMatch(/safePrivateDirectoryAcl\(profile, userSid\)/u);
    expect(initializeProfile).toMatch(/windowsProfileContainsOnlyRunFiles\(profile\)/u);
    expect(initializeProfile).toMatch(/openWindowsChildDirectory\(profile, L"home", FILE_OPEN_IF/u);
    expect(initializeProfile).toMatch(/createWindowsChildFileForWrite\(profile, L"config\.yaml"\)/u);
    expect(initializeProfile).toMatch(/safeReadOnlyFileAcl\(config, userSid\)/u);
    expect(initializeProfile).toMatch(/writeWindowsFile\(config, configYaml\)/u);
    expect(configCreate).toMatch(/FILE_CREATE/u);
    expect(configCreate).not.toMatch(/FILE_OPEN_IF/u);
    expect(configCreate).toMatch(/FILE_NON_DIRECTORY_FILE \| FILE_SYNCHRONOUS_IO_NONALERT \| FILE_OPEN_REPARSE_POINT/u);
    expect(nativeSource).toMatch(/InitializeObjectAttributes\(&attributes, &objectName, OBJ_CASE_INSENSITIVE \| OBJ_DONT_REPARSE, parent/u);
    expect(nativeSource).toMatch(/initialize-run-profile[\s\S]*?readWindowsRunProfileConfig\(configYaml\)[\s\S]*?initializeWindowsRunProfile\(root, runId, configYaml\)/u);
    expect(nativeSource).toMatch(/configYaml\.size\(\) > kMaxRunProfileConfigBytes/u);
    expect(nativeAcceptanceScript).toMatch(/existing config\.yaml must remain unchanged/u);

    expect(runtimeAdapterSource).toMatch(/hermesRunProfileConfigWriter \?\? writeHermesRunProfileConfig/u);
    expect(runtimeAdapterSource).not.toMatch(/fs\.mkdir\(path\.join\(profileHome/u);
    expect(runtimeAdapterSource).not.toMatch(/fs\.writeFile\(path\.join\(profileHome, "config\.yaml"\)/u);
  });

  it("writes Linux Run home and config relative to exact held descriptors and refuses replacement", () => {
    const initializeProfile = /int initializePosixRunProfile\([\s\S]*?\n\}/u.exec(nativeSource)?.[0] ?? "";
    const configCreate = /bool writePosixRunProfileConfig\([\s\S]*?\n\}/u.exec(nativeSource)?.[0] ?? "";
    expect(initializeProfile).not.toBe("");
    expect(configCreate).not.toBe("");
    expect(initializeProfile).toMatch(/openPosixDirectory\(root, true\)/u);
    expect(initializeProfile).toMatch(/openat\(rootFd, "profiles", O_RDONLY \| O_DIRECTORY \| O_CLOEXEC \| O_NOFOLLOW\)/u);
    expect(initializeProfile).toMatch(/"ebb-orchestrator-run-" \+ runId/u);
    expect(initializeProfile).toMatch(/openat\(profilesFd, leaf\.c_str\(\), O_RDONLY \| O_DIRECTORY \| O_CLOEXEC \| O_NOFOLLOW\)/u);
    expect(initializeProfile).toMatch(/mkdirat\(profileFd, "home", 0700\)/u);
    expect(initializeProfile).toMatch(/openat\(profileFd, "home", O_RDONLY \| O_DIRECTORY \| O_CLOEXEC \| O_NOFOLLOW\)/u);
    expect(initializeProfile).toMatch(/writePosixRunProfileConfig\(profileFd, configYaml\)/u);
    expect(configCreate).toMatch(/openat\(profileFd, "config\.yaml", O_WRONLY \| O_CREAT \| O_EXCL \| O_CLOEXEC \| O_NOFOLLOW \| O_NONBLOCK, 0600\)/u);
    expect(configCreate).not.toMatch(/O_TRUNC/u);
    expect(configCreate).toMatch(/fsync\(fd\)/u);
    expect(nativeSource).toMatch(/initialize-run-profile[\s\S]*?readPosixRunProfileConfig\(configYaml\)[\s\S]*?initializePosixRunProfile\(argv\[2\], argv\[3\], configYaml\)/u);
    expect(nativeAcceptanceScript).toMatch(/process\.platform === "linux"\)[\s\S]*?initialize-run-profile[\s\S]*?must refuse an existing config\.yaml[\s\S]*?must remain unchanged/u);
  });

  it("removes snapshot GC trees only through identity-checked native handles", () => {
    const cleanup = /int removeSnapshotGcTree\([\s\S]*?\n\}/u.exec(nativeSource)?.[0] ?? "";
    const finishGc = /async function finishSnapshotGc\([\s\S]*?\n\}/u.exec(
      readFileSync(new URL("../../src/modules/runtime/hermes/hermes-source-snapshot.ts", import.meta.url), "utf8"),
    )?.[0] ?? "";

    expect(cleanup).not.toBe("");
    expect(cleanup).toMatch(/openat\([\s\S]*?O_NOFOLLOW/u);
    expect(nativeSource).toMatch(/bool samePosixIdentity\(const struct stat& info[\s\S]*?info\.st_dev[\s\S]*?info\.st_ino/u);
    expect(nativeSource).toMatch(/bool preparePosixGcDirectory\([\s\S]*?fstatat\([\s\S]*?AT_SYMLINK_NOFOLLOW[\s\S]*?openat\([\s\S]*?O_NOFOLLOW[\s\S]*?fstat\([\s\S]*?fchmod\(handle, 0700\)[\s\S]*?fsync\(handle\)[\s\S]*?fsync\(parent\)/u);
    expect(nativeSource).toMatch(/bool removePosixGcObject\([\s\S]*?fstat\([\s\S]*?fstatat\([\s\S]*?AT_SYMLINK_NOFOLLOW[\s\S]*?unlinkat\(/u);
    expect(nativeSource.match(/bool removePosixGcObject\([\s\S]*?\n\}/u)?.[0] ?? "").not.toMatch(/fchmod\(/u);
    expect(nativeSource).toMatch(/NtCreateFile\([\s\S]*?OBJ_DONT_REPARSE[\s\S]*?FILE_OPEN_REPARSE_POINT/u);
    expect(cleanup).toMatch(/FILE_DISPOSITION_INFO/u);
    expect(cleanup).toMatch(/SetFileInformationByHandle\(handle, FileDispositionInfo/u);
    expect(finishGc).toMatch(/removeSnapshotGcTreeByVerifiedNativeHandles/u);
    expect(finishGc).not.toMatch(/chmod\(rootPath|removeChildrenNoFollow\(rootPath|unlink\((?:projectionPath|metadataPath|intentPath)/u);
  });

  it("keeps every Windows Run-profile cleanup identity handle closed to delete sharing", () => {
    const cleanup = /int cleanupWindowsProfile\([\s\S]*?\n\}/u.exec(nativeSource)?.[0] ?? "";
    const inventory = /HANDLE child = directory[\s\S]*?\n\s*FILE_ATTRIBUTE_TAG_INFO/u.exec(cleanup)?.[0] ?? "";

    expect(cleanup).not.toBe("");
    expect(cleanup).toMatch(/openWindowsDirectory\(root, true, userSid, false, true, false\)/u);
    expect(cleanup).toMatch(/openWindowsChildDirectory\(rootHandle, L"profiles", FILE_OPEN, nullptr, false, true, 0, false\)/u);
    expect(cleanup).toMatch(/openWindowsChildDirectory\(profiles, leaf, FILE_OPEN, nullptr, false, true,[\s\S]*?DELETE \| FILE_LIST_DIRECTORY \| FILE_WRITE_ATTRIBUTES, false\)/u);
    expect(inventory).not.toBe("");
    expect(inventory).toMatch(/openWindowsChildDirectory\(parent, name, FILE_OPEN, nullptr, false, true,[\s\S]*?DELETE \| FILE_LIST_DIRECTORY \| FILE_WRITE_ATTRIBUTES, false\)/u);
    expect(inventory).toMatch(/openWindowsChildFile\(parent, name, false, DELETE \| FILE_WRITE_ATTRIBUTES\)/u);
    expect(cleanup).not.toMatch(/HANDLE rebound = node\.directory|openWindowsChildFile\(item\.parent, node\.name/u);
  });

  it("removes Windows acceptance fixtures only through STOPPED-gated native identity handles", () => {
    const fixtureRemoval = /int removeWindowsFixtureTree\([\s\S]*?\n\}/u.exec(nativeSource)?.[0] ?? "";
    const fixtureIdentity = /int identifyWindowsFixtureTree\([\s\S]*?\n\}/u.exec(nativeSource)?.[0] ?? "";
    const fixtureAcl = /bool safeProtectedPrivateFixtureDirectoryAcl\([\s\S]*?\n\}/u.exec(nativeSource)?.[0] ?? "";
    const cleanup = /afterAll\(async \(\) => \{([\s\S]*?)\n {2}\}, 300_000\);/u.exec(pathChainAcceptance)?.[1] ?? "";
    expect(fixtureRemoval).not.toBe("");
    expect(fixtureRemoval).toMatch(/openWindowsChildDirectory\(/u);
    expect(nativeSource).toMatch(/HANDLE openWindowsChildDirectory\([\s\S]*?OBJ_DONT_REPARSE[\s\S]*?FILE_OPEN_REPARSE_POINT/u);
    expect(fixtureRemoval).toMatch(/safePrivateDirectoryAcl/u);
    expect(fixtureRemoval).toMatch(/SetFileInformationByHandle\([\s\S]*?FileDispositionInfo/u);
    expect(fixtureRemoval).toMatch(/if \(!SetFileInformationByHandle\(node\.handle, FileDispositionInfo[\s\S]*?const DWORD error = GetLastError\(\);\s*closeHandles\(\);[\s\S]*?ERROR_ACCESS_DENIED[\s\S]*?ERROR_SHARING_VIOLATION[\s\S]*?ERROR_DIR_NOT_EMPTY[\s\S]*?ERROR_INVALID_PARAMETER[\s\S]*?kFixtureDispositionOtherFailure/u);
    expect(fixtureRemoval).toMatch(/kFixtureDispositionFileAccessDenied = 75[\s\S]*?kFixtureDispositionSharingViolation = 76[\s\S]*?kFixtureDispositionDirectoryNotEmpty = 77[\s\S]*?kFixtureDispositionInvalidParameter = 78[\s\S]*?kFixtureDispositionOtherFailure = 79[\s\S]*?kFixtureDispositionDirectoryAccessDenied = 80/u);
    expect(fixtureRemoval).toMatch(/if \(error == ERROR_ACCESS_DENIED\)\s*\{\s*return node\.directory \? kFixtureDispositionDirectoryAccessDenied : kFixtureDispositionFileAccessDenied;/u);
    expect(fixtureRemoval).toMatch(/FileIdBothDirectory/u);
    expect(fixtureRemoval).toMatch(/if \(!directory\) \{[\s\S]*?FILE_STANDARD_INFO standard\{\}[\s\S]*?GetFileInformationByHandleEx\(child, FileStandardInfo[\s\S]*?standard\.NumberOfLinks != 1\)[\s\S]*?kFixtureCollectLinkCountUnsafe/u);
    expect(fixtureRemoval).toMatch(/kFixtureCollectLinkCountUnsafe[\s\S]*?nodes\.push_back/u);
    expect(fixtureRemoval).toMatch(/NumberOfLinks != 1[\s\S]*?SetFileInformationByHandle\(node\.handle, FileBasicInfo/u);
    expect(fixtureRemoval).toMatch(/if \(\(tag\.FileAttributes & FILE_ATTRIBUTE_READONLY\) != 0\) \{\s*FILE_BASIC_INFO basic\{\};[\s\S]*?basic\.FileAttributes &= ~FILE_ATTRIBUTE_READONLY;[\s\S]*?SetFileInformationByHandle\(node\.handle, FileBasicInfo/u);
    expect(fixtureRemoval).not.toMatch(/if \(!node\.directory && \(tag\.FileAttributes & FILE_ATTRIBUTE_READONLY\)/u);
    expect(fixtureIdentity).toMatch(/openWindowsChildDirectory/u);
    expect(fixtureIdentity).toMatch(/expectedVolumeSerial/u);
    expect(fixtureIdentity).toMatch(/safeProtectedPrivateFixtureDirectoryAcl/u);
    expect(fixtureIdentity).toMatch(/printSafePathIdentity\("directory"/u);
    expect(fixtureIdentity).not.toMatch(/SetFileInformationByHandle|SetSecurityInfo|SetNamedSecurityInfo|CreateDirectory|FILE_CREATE/u);
    expect(fixtureAcl).toMatch(/SE_DACL_PROTECTED/u);
    expect(fixtureAcl).toMatch(/info\.AceCount == 1/u);
    expect(fixtureAcl).toMatch(/EqualSid\(trustee, currentUser\)[\s\S]*?ace->Mask == FILE_ALL_ACCESS/u);
    expect(cleanup).toMatch(/observation\.state !== "STOPPED"[\s\S]*?fixtureHome\.identity/u);
    expect(cleanup).toMatch(/fixtureHome\.launchAttempted && \(fixtureHome\.unprovenLaunch[\s\S]*?fixtureHome\.launchAttempts\.some\(\(attempt\) => !attempt\.identity\)[\s\S]*?FIXTURE_CLEANUP_STOP_UNPROVEN/u);
    expect(cleanup).toMatch(/removeWindowsFixtureTree\(fixtureHome\.path, fixtureHome\.identity\)/u);
    expect(pathChainAcceptance).toMatch(/fixture-tree-remove/u);
    expect(pathChainAcceptance.match(/setPrivateOwnerAcl\(\[[^\]]+\], systemPaths, true\)/gu))
      .toEqual([
        "setPrivateOwnerAcl([cacheRoot], systemPaths, true)",
        "setPrivateOwnerAcl([stagedRoot], systemPaths, true)",
      ]);
    expect(pathChainAcceptance).toMatch(/EBB_PROFILE_FIXTURE_INHERIT_CHILDREN[\s\S]*?ContainerInherit[\s\S]*?ObjectInherit/u);
    expect(pathChainAcceptance).toMatch(/InheritanceFlags -ne \$inheritance/u);
    expect(cleanup).not.toMatch(/\brm\s*\(|\brmdir\s*\(/u);
    expect(cleanup.indexOf("observation.state !== \"STOPPED\""))
      .toBeLessThan(cleanup.indexOf("removeWindowsFixtureTree("));
    expect(cleanup.indexOf("if (!fixtureHome.identity)"))
      .toBeLessThan(cleanup.indexOf("removeWindowsFixtureTree("));
    expect(nativeAcceptanceScript).toMatch(/--fixture-tree-remove-only[\s\S]*?verifyWindowsFixtureTreeRemoval/u);
    expect(nativeAcceptanceScript).toMatch(/fixture-tree-identity/u);
    expect(nativeAcceptanceScript).toMatch(/mismatched captured root identity/u);
    expect(nativeAcceptanceScript).toMatch(/reject a reparse child during preflight/u);
    expect(nativeAcceptanceScript).toMatch(/hardlink-to-outside sentinel/u);
    expect(nativeAcceptanceScript).toMatch(/const sentinelMetadata = \(\) => \{[\s\S]*?nlink[\s\S]*?mtimeNs[\s\S]*?ctimeNs/u);
    expect(nativeAcceptanceScript).toMatch(/reject a hardlink-to-outside sentinel[\s\S]*?before deleting known fixture children/u);
  });

  it("creates Windows projection aliases with a native protected DACL before Node opens them", () => {
    const windowsProjectionGuard = /#ifdef _WIN32\s+bool validSourceStagingTempName\([\s\S]*?int createWindowsSourceProjectionTemp\([\s\S]*?\n\}\s+#endif/u.exec(nativeSource)?.[0] ?? "";
    const createProjection = /int createWindowsSourceProjectionTemp\([\s\S]*?\n\}/u.exec(windowsProjectionGuard)?.[0] ?? "";
    const projection = /async function ensureNativeProjection\([\s\S]*?\n\}/u.exec(snapshotSource)?.[0] ?? "";
    const recovery = /async function recoverNativeProjectionAliases\([\s\S]*?\n\}/u.exec(snapshotSource)?.[0] ?? "";
    expect(windowsProjectionGuard).not.toBe("");
    expect(createProjection).toMatch(/validSourceProjectionTempName\(nameUtf8\)/u);
    expect(createProjection).toMatch(/openWindowsDirectory\(cacheRoot, true, userSid, false, true, false, FILE_ADD_FILE\)/u);
    expect(createProjection).toMatch(/createWindowsChildFileForWrite\(directory, name, descriptor, DELETE, &createStatus\)/u);
    expect(createProjection).toMatch(/safeProtectedPrivateFileAcl\(file, userSid\)/u);
    expect(createProjection).toMatch(/GetFileInformationByHandle\(file, &identity\)/u);
    expect(createProjection).toMatch(/unowned temp/u);
    expect(projection).toMatch(/"source-projection-create"/u);
    expect(projection).toMatch(/open\(temporaryPath, process\.platform === "win32" \? "r\+" : "wx"/u);
    expect(projection).toMatch(/sameExactFileIdentity\(nativeIdentity, openedIdentity\)/u);
    expect(projection).toMatch(/sameExactFileIdentity\(nativeIdentity, exactIdentityFromStats\(named\)\)/u);
    expect(projection).toMatch(/await handle\.writeFile\(bytes\)[\s\S]*?await handle\.sync\(\)[\s\S]*?await handle\.chmod\(0o400\)[\s\S]*?ownerPath/u);
    expect(projection).not.toMatch(/open\(temporaryPath, "wx"/u);
    expect(recovery).toMatch(/name\.startsWith\(ownerPrefix\) && !name\.endsWith\("\.owner"\) && !owners\.has\(name \+ "\.owner"\)\) throw snapshotError\(\)/u);
    expect(recovery).toMatch(/sameExactFileIdentity\(exactIdentity, exactIdentityFromStats\(details\)\)/u);
  });

  it("creates Windows snapshot staging roots with a protected inheritable DACL and versioned cache identity", () => {
    const stagingCreate = /int createWindowsSourceStagingDirectory\([\s\S]*?\n\}/u.exec(nativeSource)?.[0] ?? "";
    const stagingAcl = /bool safeProtectedPrivateStagingDirectoryAcl\([\s\S]*?\n\}/u.exec(nativeSource)?.[0] ?? "";
    const stageFactory = /async function createSnapshotStagingDirectory\([\s\S]*?\n\}/u.exec(snapshotSource)?.[0] ?? "";
    const identityValidation = snapshotSource.slice(snapshotSource.indexOf("function validateMetadataAndKey("));
    expect(stagingCreate).toMatch(/validSourceStagingTempName\(nameUtf8\)/u);
    expect(nativeSource).toMatch(/source-staging-create[\s\S]*?createWindowsSourceStagingDirectory/u);
    expect(nativeSource).toMatch(/FILE_CREATE/u);
    expect(stagingCreate).toMatch(/D:P\(A;OICI;FA;;;/u);
    expect(stagingCreate).toMatch(/createWindowsChildDirectory\(directory, name, descriptor/u);
    expect(stagingCreate).toMatch(/safeProtectedPrivateStagingDirectoryAcl\(staging, userSid\)/u);
    expect(stagingCreate).toMatch(/GetFileInformationByHandle\(staging, &identity\)/u);
    expect(stagingAcl).toMatch(/SE_DACL_PROTECTED/u);
    expect(stagingAcl).toMatch(/OBJECT_INHERIT_ACE \| CONTAINER_INHERIT_ACE/u);
    expect(stagingAcl).toMatch(/ace->Mask == FILE_ALL_ACCESS/u);
    expect(stageFactory).toMatch(/"source-staging-create"/u);
    expect(stageFactory).toMatch(/open\(stageRoot, fsConstants\.O_RDONLY\)/u);
    expect(stageFactory).toMatch(/sameExactFileIdentity\(nativeIdentity, exactIdentityFromStats\(opened\)\)/u);
    expect(stageFactory).toMatch(/sameExactFileIdentity\(nativeIdentity, exactIdentityFromStats\(named\)\)/u);
    expect(snapshotSource).toMatch(/materializationPolicyVersion: 2 as const/u);
    expect(identityValidation).toMatch(/identity\.materializationPolicyVersion === 2/u);
    expect(identityValidation).toMatch(/identityKeys/u);
    expect(snapshotSource).toMatch(/hasSnapshotReferences\(metadata\.cacheKey\) !== true/u);
    expect(snapshotSource).toMatch(/isReferencedLegacyWindowsSnapshot/u);
    expect(snapshotSource).toMatch(/source-staging-recover/u);
    expect(snapshotSource).toMatch(/sameStableFileIdentity\(expected, openedIdentity\)/u);
    expect(snapshotSource).toMatch(/names\.length > 128/u);
    expect(snapshotSource).toMatch(/process\.platform === "win32" \? \{ materializationPolicyVersion: 2 as const \} : \{\}/u);
    expect(nativeAcceptanceScript).toMatch(/verifyWindowsSourceStagingDirectory/u);
    expect(nativeAcceptanceScript).toMatch(/--source-staging-only/u);
  });

  it("preflights the whole candidate before deletion and removes intent after every sidecar", () => {
    const gc = /int removeSnapshotGcTree\([\s\S]*?\n\}/u.exec(nativeSource)?.[0] ?? "";
    const posixGcBranch = /#else([\s\S]*?)#endif/u.exec(gc)?.[1] ?? "";
    expect(posixGcBranch).toMatch(/openPosixDirectory\(cacheRoot, true\)/u);
    expect(posixGcBranch).not.toMatch(/openAbsoluteDirectory/u);
    expect(gc).toMatch(/preflightDirectory\(preflightDirectory, rootHandle[\s\S]*?preflightSidecars\(\)[\s\S]*?for \(const auto& object : nodes\)/u);
    expect(gc).toMatch(/preflightPosixGcDirectory\(root[\s\S]*?preflightPosixGcSidecars\([\s\S]*?for \(const auto& object : nodes\)/u);
    expect(gc).toMatch(/for \(const auto& object : nodes\)[\s\S]*?removeHandle\(rootHandle, objects\.front\(\), true\)[\s\S]*?directoryId \+ "\.manifest\.json"[\s\S]*?directoryId \+ "\.native-v1\.bin"[\s\S]*?"\.gc-" \+ directoryId \+ "\.intent\.json"/u);
    expect(gc).toMatch(/for \(const auto& object : nodes\)[\s\S]*?removePosixGcObject\(cache, cache, objects\.front\(\)\)[\s\S]*?directoryId \+ "\.manifest\.json"[\s\S]*?directoryId \+ "\.native-v1\.bin"[\s\S]*?"\.gc-" \+ directoryId \+ "\.intent\.json"/u);
  });

  it("keeps the pre-publication tree, durable intent, recovery reader, and native parser within one budget", () => {
    expect(snapshotGcLimits).toMatch(/intentBytes: 64 \* 1024 \* 1024/u);
    expect(snapshotGcLimits).toMatch(/inventoryBytes: 64 \* 1024 \* 1024/u);
    expect(snapshotGcLimits).toMatch(/files: 100_000[\s\S]*?directories: 100_000[\s\S]*?nodes: 200_000/u);
    expect(snapshotGcLimits).toMatch(/pathBytes: 720[\s\S]*?aggregatePathBytes: 8 \* 1024 \* 1024/u);
    expect(snapshotSource).toMatch(/assertHermesSourceSnapshotGcTreeFits\(entries\.map\(\(entry\) => entry\.path\)\)/u);
    expect(snapshotSource.indexOf("validateTreeEntries(entries);")).toBeLessThan(snapshotSource.indexOf("readAndHashGitBlobs(request.gitExecutable"));
    expect(snapshotSource).toMatch(/readStableFile\(intentPath, intentIdentity, HERMES_SOURCE_SNAPSHOT_GC_LIMITS\.intentBytes\)/u);
    expect(snapshotSource).toMatch(/assertHermesSourceSnapshotGcIntentFits\(bytes\.byteLength, intent\.nodes\.length\)/u);
    expect(snapshotSource).toMatch(/Buffer\.byteLength\(inventory, "utf8"\) > HERMES_SOURCE_SNAPSHOT_GC_LIMITS\.inventoryBytes/u);
    expect(snapshotSource).not.toMatch(/intent\.nodes\.length \+ 1/u);
    expect(nativeSource).toMatch(/kGcIntentAndInventoryBytes = 64 \* 1024 \* 1024/u);
    expect(nativeSource).toMatch(/kGcNodeLimit = 200000/u);
    expect(nativeSource).toMatch(/kGcAggregatePathBytes = 8 \* 1024 \* 1024/u);
    expect(nativeSource).toMatch(/path\.size\(\) > 720/u);
    expect(nativeSource).toMatch(/widePath\.size\(\) > 240/u);
    expect(nativeSource).toMatch(/widePart\.size\(\) > 255/u);
    expect(nativeSource).toMatch(/part\.size\(\) > 255/u);
    expect(snapshotSource).toMatch(/isHermesSourceSnapshotRelativePathValid\(value\)/u);
    expect(snapshotGcLimits).toMatch(/export function isHermesSourceSnapshotRelativePathValid\(path:/u);
  });

  it("prepares POSIX sealed directories only after full preflight and resumes exact GC-owned mode transitions", () => {
    const gc = /int removeSnapshotGcTree\([\s\S]*?\n\}/u.exec(nativeSource)?.[0] ?? "";
    const preparation = /bool preparePosixGcDirectory\([\s\S]*?\n\}/u.exec(nativeSource)?.[0] ?? "";
    expect(gc.indexOf("preflightPosixGcDirectory")).toBeLessThan(gc.indexOf("preflightPosixGcSidecars"));
    expect(gc.indexOf("preflightPosixGcSidecars")).toBeLessThan(gc.indexOf("preparePosixGcTreeDirectories"));
    expect(gc.indexOf("preparePosixGcTreeDirectories")).toBeLessThan(gc.indexOf("removePosixGcObject(cache, root, object)"));
    expect(preparation).toMatch(/fstatat\([\s\S]*?AT_SYMLINK_NOFOLLOW[\s\S]*?samePosixIdentity[\s\S]*?posixGcDirectoryModeIsRecoverable[\s\S]*?fchmod\([\s\S]*?fsync\(handle\)/u);
    expect(snapshotSource).toMatch(/modeBits !== expectedNode\.modeBits && !\(allowMissing && modeBits === 0o700\)/u);
    expect(nativeAcceptanceScript).toMatch(/POSIX regression must start with a sealed root directory/u);
    expect(nativeAcceptanceScript).toMatch(/resume after a crash between directory preparation steps/u);
    expect(nativeAcceptanceScript).toMatch(/directory mode outside the original\/intermediate set/u);
  });

  it("validates recovered GC node path units and file/directory caps before native dispatch", () => {
    expect(snapshotSource).toMatch(/isHermesSourceSnapshotGcNodeInventoryWithinLimits\(intent\.nodes\)/u);
    expect(snapshotSource).toMatch(/isHermesSourceSnapshotRelativePathValid\(node\.path\)/u);
    expect(snapshotSource).toMatch(/intent\.nodes\.every\(isSnapshotGcNode\)/u);
    expect(snapshotGcLimits).toMatch(/foldedPaths\.has\(foldedPath\)/u);
    expect(snapshotGcLimits).toMatch(/parent !== "directory"/u);
    expect(snapshotGcLimits).toMatch(/com\[1-9¹²³\]/u);
    expect(nativeAcceptanceScript).toMatch(/200000 nodes \(\$\{Math\.round\(boundaryDurationMs\)\}ms\)/u);
    expect(nativeAcceptanceScript.match(/source-cache-gc-only/g)).toHaveLength(1);
  });
});
