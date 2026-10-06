import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const resolverSource = readFileSync(
  new URL('../../../src/modules/runtime/hermes/hermes-executable-resolver.ts', import.meta.url), 'utf8',
);
const runtimeAdapterSource = readFileSync(
  new URL('../../../src/modules/runtime/hermes/hermes-runtime-adapter.ts', import.meta.url), 'utf8',
);
const profileHomeSource = readFileSync(
  new URL('../../../src/platform/home/hermes-profile-home.ts', import.meta.url), 'utf8',
);
const launchTicketSource = readFileSync(
  new URL('../../../src/modules/runtime/hermes/hermes-launch-ticket.ts', import.meta.url), 'utf8',
);
const nativeHelperLauncherSource = readFileSync(
  new URL('../../../src/platform/process/native-helper-launcher.ts', import.meta.url), 'utf8',
);
const nativeLauncherSource = readFileSync(
  new URL('../../../native/linux-hermes-launcher/ebb-linux-hermes-launcher.cpp', import.meta.url), 'utf8',
);

describe('Linux production Hermes path contract', () => {
  it('resolves a pinned Hermes source and runtime without executing the PATH shell wrapper', () => {
    expect(resolverSource).toMatch(/if \(platform === "linux"\) return resolveLinuxHermesExecutable\(options\);/u);
    const linuxResolver = resolverSource.split('async function resolveLinuxHermesExecutable(')[1]?.split('/** Применяет только path-resolution')[0] ?? '';
    expect(linuxResolver).not.toBe('');
    expect(resolverSource).toMatch(/resolveLinuxHermesPythonPath\(/u);
    expect(linuxResolver).toMatch(/verifyPinnedGitSource\(layout\.hermesProjectRoot,[\s\S]*?gitRunner\)/u);
    expect(linuxResolver).not.toMatch(/runBounded\([\s\S]*?runtimeExecutablePath/u);
    expect(linuxResolver).not.toMatch(/--print-runtime-command/u);
    expect(linuxResolver).toMatch(/runtimeArgsPrefix: failClosedRuntimeArgsPrefix\(\)/u);
    expect(linuxResolver).toMatch(/sourceTree,[\s\S]*?gitExecutable: gitPath/u);
    expect(resolverSource).toMatch(/buildHermesSnapshotRuntimeArgs/u);
    expect(resolverSource).toMatch(/sys\.dont_write_bytecode = True/u);
    expect(resolverSource).toMatch(/HermesSnapshotFinder/u);
    expect(linuxResolver).toMatch(/canonicalExistingFile\("\/usr\/bin\/git"/u);
    expect(linuxResolver).toMatch(/executablePath,[\s\S]*?layout\.innerLauncherPath,[\s\S]*?runtimeExecutablePath/u);
  });

  it('uses Linux device/inode identities at profile and native launch boundaries', () => {
    expect(resolverSource).toMatch(/parseNativeSafePathIdentity/u);
    expect(resolverSource).toMatch(/device,inode,path,platform/u);
    expect(resolverSource).toMatch(/verifyHermesProfileHomeIdentity[\s\S]*?platform === "linux"/u);
    expect(runtimeAdapterSource).not.toMatch(/HERMES_PROFILE_PATH_PLATFORM_UNSUPPORTED|HERMES_PROFILE_CONFIG_WRITE_PLATFORM_UNSUPPORTED|HERMES_LAUNCH_PLATFORM_NOT_READY/u);
    expect(runtimeAdapterSource).toMatch(/paths\.join\(resolution\.hermesConfigHome, "profiles", `ebb-orchestrator-run-\$\{runId\}`\)/u);
    expect(runtimeAdapterSource).toMatch(/createHermesRunProfileHomeWithReceipt\(helperOptions\)/u);
    expect(runtimeAdapterSource).toMatch(/profileHome = profileReceipt\.profileHome/u);
    expect(runtimeAdapterSource).toMatch(/writeHermesRunProfileConfig\)\(\{[\s\S]*?platform,[\s\S]*?configYaml/u);
    expect(runtimeAdapterSource).toMatch(/platform: resolution\.executableIdentity\.platform/u);
    expect(runtimeAdapterSource).toMatch(/createHermesLaunchTicket\([\s\S]*?profileHomeIdentity/u);
    expect(runtimeAdapterSource).toMatch(/function hermesProfilePathHelperPath\(platform: "win32" \| "linux"\)[\s\S]*?ebb-hermes-profile-path/u);
    expect(profileHomeSource).toMatch(/runVerifiedNativeHelper\(executable, 'hermesProfilePath'/u);
    expect(profileHomeSource).toMatch(/\['create-profile', hermesRoot, runId\]/u);
    expect(profileHomeSource).toMatch(/\['initialize-run-profile', hermesRoot, runId\]/u);
    expect(launchTicketSource).toMatch(/hermesExecutableIdentity: HermesLaunchObjectIdentity/u);
    expect(launchTicketSource).toMatch(/executableIdentity: HermesLaunchObjectIdentity/u);
    expect(launchTicketSource).toMatch(/profileHomeIdentity: HermesLaunchObjectIdentity/u);
    expect(nativeHelperLauncherSource).toMatch(/runLinuxHelperFromDescriptor\(helperPath/u);
    expect(nativeLauncherSource).toMatch(/openAbsoluteExecutable\(shimPath, expectedShimDevice, expectedShimInode\)/u);
    expect(nativeLauncherSource).toMatch(/openAbsoluteExecutable\(pythonPath, expectedPythonDevice, expectedPythonInode\)/u);
    expect(nativeLauncherSource).toMatch(/profileInfo\.st_dev\) != expectedProfileDevice/u);
    expect(nativeLauncherSource).toMatch(/profileInfo\.st_ino\) != expectedProfileInode/u);
    expect(nativeLauncherSource).toMatch(/IDENTITY_MISMATCH/u);
  });

  it('uses a dedicated shared reference lease for the complete Linux process scope', () => {
    expect(nativeLauncherSource).toMatch(/openat\(directory\.get\(\), "\.source-cache\.ref\.lock"/u);
    expect(nativeLauncherSource).toMatch(/flock\(lock\.get\(\), LOCK_SH \| LOCK_NB\)/u);
    expect(nativeLauncherSource).not.toMatch(/openat\(directory\.get\(\), "\.source-cache\.lock"/u);
  });
});
