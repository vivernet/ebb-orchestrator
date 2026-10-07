import { vi } from 'vitest';
import * as path from 'node:path';

type FixtureModules = {
  providerModule: typeof import('../../src/modules/runtime/hermes/hermes-provider-selection.js');
  selectionModule: typeof import('../../src/modules/runtime/hermes/hermes-run-selection.js');
  profileModule: typeof import('../../src/platform/home/hermes-profile-home.js');
  launcherModule: typeof import('../../src/platform/process/native-helper-launcher.js');
  integrityModule: typeof import('../../src/platform/process/native-helper-integrity.js');
};

/** Provider-free fixture backed by opaque capabilities from mocked native boundaries. */
export async function createHermesAuthRouteFixture(
  runId: string,
  providerId = 'openai-codex',
  modelId = 'test-model',
  authRootOverride?: string,
  endpointOverridePresent = false,
  moduleOverrides?: FixtureModules,
  runEnvironment: Readonly<Record<string, string | undefined>> = {},
) {
  const providerModule = moduleOverrides?.providerModule ?? await import('../../src/modules/runtime/hermes/hermes-provider-selection.js');
  const selectionModule = moduleOverrides?.selectionModule ?? await import('../../src/modules/runtime/hermes/hermes-run-selection.js');
  const profileModule = moduleOverrides?.profileModule ?? await import('../../src/platform/home/hermes-profile-home.js');
  const platform = process.platform === 'win32' ? 'win32' : 'linux';
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const authRoot = authRootOverride ?? (platform === 'win32' ? 'C:\\test-hermes' : '/tmp/test-hermes');
  const helperPath = paths.join(authRoot, platform === 'win32' ? 'helper.exe' : 'helper');
  const profileHome = paths.join(authRoot, 'profiles', `ebb-orchestrator-run-${runId}`);
  const profileHomePathChain = platform === 'win32'
    ? (() => {
      const root = path.win32.parse(profileHome).root;
      const pathParts = path.win32.relative(root, profileHome).split(/[\\/]+/u).filter(Boolean);
      const authRootIndex = path.win32.relative(root, authRoot).split(/[\\/]+/u).filter(Boolean).length;
      return {
        version: 1 as const,
        authRootIndex,
        components: Array.from({ length: pathParts.length + 1 }, (_unused, index) => ({
          volumeSerial: '0123456789abcdef',
          fileId: index === pathParts.length
            ? '0123456789abcdef0123456789abcdef'
            : `${index}`.padStart(32, '0'),
        })),
      };
    })()
    : undefined;
  const launcher = moduleOverrides?.launcherModule ?? await import('../../src/platform/process/native-helper-launcher.js');
  const integrity = moduleOverrides?.integrityModule ?? await import('../../src/platform/process/native-helper-integrity.js');
  const launcherMock = vi.spyOn(launcher, 'runVerifiedNativeHelper');
  launcherMock.mockImplementation(async (_helperPath, _anchor, args) => ({
    exitCode: 0,
    stderr: '',
    stdout: args[0] === 'project-selection' ? JSON.stringify({
      sourceVersion: providerModule.HERMES_PROVIDER_SELECTION_SOURCE.version,
      sourceCommit: providerModule.HERMES_PROVIDER_SELECTION_SOURCE.commit,
      projectionVersion: providerModule.HERMES_PROVIDER_SELECTION_SOURCE.projectionVersion,
      status: 'EXPLICIT_SELECTION',
      endpointOverridePresent,
      providerId,
      modelId,
    }) : '',
  }));
  const integrityMock = vi.spyOn(integrity, 'verifyNativeHelperIntegrity');
  integrityMock.mockResolvedValue(undefined);

  const providerSelection = await providerModule.readHermesProviderSelection({
    hermesConfigHome: authRoot,
    hermesRunProfileHome: profileHome,
    hermesProjectRoot: paths.join(authRoot, 'source'),
    runId,
    runEnvironment,
    helperPath,
    platform,
  });
  const profileReceipt = await profileModule.createHermesRunProfileHomeWithReceipt({
    hermesRoot: authRoot, runId, helperPath, platform,
  });
  const authRouteEvidence = selectionModule.deriveHermesNativeAuthRouteEvidence({
    profileReceipt,
    providerSelection,
    authRoot,
    hermesProjectRoot: paths.join(authRoot, 'source'),
    sourceVersion: providerModule.HERMES_PROVIDER_SELECTION_SOURCE.version,
    sourceCommit: providerModule.HERMES_PROVIDER_SELECTION_SOURCE.commit,
    environment: runEnvironment as Readonly<Record<string, string>>,
    ...(profileHomePathChain ? { profileHomePathChain } : {}),
  });
  return {
    authRoot, profileHome, providerSelection, profileReceipt, authRouteEvidence,
    ...(profileHomePathChain ? { profileHomePathChain } : {}),
    hermesProjectRoot: paths.join(authRoot, 'source'), runEnvironment,
  };
}
