import { describe, expect, it } from 'vitest';
import * as hermesProfileHome from '../../../src/platform/home/hermes-profile-home.js';
const { createHermesRunProfileHome } = hermesProfileHome;

describe('createHermesRunProfileHome', () => {
  it('exposes native exact-Run cleanup for transaction rollback', async () => {
    expect(hermesProfileHome).toHaveProperty('cleanupHermesRunProfileHome');
  });

  it('invokes the native helper with only the exact Hermes root and Run UUID', async () => {
    const calls: Array<{ executable: string; args: string[]; options: { shell: false } }> = [];
    await hermesProfileHome.cleanupHermesRunProfileHome({
      hermesRoot: 'C:\\Users\\alice\\AppData\\Local\\hermes',
      runId: 'c9b640db-9fbf-4d1f-b8a8-91e74093772b',
      helperPath: 'C:\\ebb\\native\\ebb-hermes-profile-path.exe',
      platform: 'win32',
      verifyHelper: async () => undefined,
      runHelper: async (
        executable: string,
        args: string[],
        options: { shell: false; input?: string },
      ) => { calls.push({ executable, args, options }); },
    });

    expect(calls).toEqual([{
      executable: 'C:\\ebb\\native\\ebb-hermes-profile-path.exe',
      args: ['cleanup-profile', 'C:\\Users\\alice\\AppData\\Local\\hermes', 'c9b640db-9fbf-4d1f-b8a8-91e74093772b'],
      options: { shell: false },
    }]);
  });

  it('rejects cleanup for an invalid UUID without invoking native code', async () => {
    let called = false;
    await expect(hermesProfileHome.cleanupHermesRunProfileHome({
      hermesRoot: '/home/alice/.hermes',
      runId: '../outside',
      helperPath: '/opt/ebb/native/ebb-hermes-profile-path',
      platform: 'linux',
      verifyHelper: async () => undefined,
      runHelper: async () => { called = true; },
    })).rejects.toThrow('HERMES_PROFILE_PATH_INPUT_INVALID');
    expect(called).toBe(false);
  });
  it('creates exactly one native profile beneath the Hermes auth-owning root', async () => {
    const calls: Array<{ executable: string; args: string[]; options: { shell: false } }> = [];
    const home = await createHermesRunProfileHome({
      hermesRoot: '/home/alice/.hermes',
      runId: 'c9b640db-9fbf-4d1f-b8a8-91e74093772b',
      helperPath: '/opt/ebb/native/ebb-hermes-profile-path',
      platform: 'linux',
      verifyHelper: async () => undefined,
      runHelper: async (executable: string, args: string[], options: { shell: false }) => {
        calls.push({ executable, args, options });
      },
    });

    expect(home).toBe('/home/alice/.hermes/profiles/ebb-orchestrator-run-c9b640db-9fbf-4d1f-b8a8-91e74093772b');
    expect(calls).toEqual([{
      executable: '/opt/ebb/native/ebb-hermes-profile-path',
      args: ['create-profile', '/home/alice/.hermes', 'c9b640db-9fbf-4d1f-b8a8-91e74093772b'],
      options: { shell: false },
    }]);
  });

  it('rejects an unsafe run id without invoking the native helper', async () => {
    let called = false;
    await expect(createHermesRunProfileHome({
      hermesRoot: '/home/alice/.hermes',
      runId: '../outside',
      helperPath: '/opt/ebb/native/ebb-hermes-profile-path',
      platform: 'linux',
      verifyHelper: async () => undefined,
      runHelper: async () => { called = true; },
    })).rejects.toThrow('HERMES_PROFILE_PATH_INPUT_INVALID');
    expect(called).toBe(false);
  });

  it('rejects a non-canonical UUID Run ID before invoking the native helper', async () => {
    let called = false;
    await expect(createHermesRunProfileHome({
      hermesRoot: '/home/alice/.hermes',
      runId: 'A1111111-1111-4111-8111-111111111111',
      helperPath: '/opt/ebb/native/ebb-hermes-profile-path',
      platform: 'linux',
      verifyHelper: async () => undefined,
      runHelper: async () => { called = true; },
    })).rejects.toThrow('HERMES_PROFILE_PATH_INPUT_INVALID');
    expect(called).toBe(false);
  });

  it('does not return a profile path when native handle-bound creation fails', async () => {
    await expect(createHermesRunProfileHome({
      hermesRoot: '/home/alice/.hermes',
      runId: 'c9b640db-9fbf-4d1f-b8a8-91e74093772b',
      helperPath: '/opt/ebb/native/ebb-hermes-profile-path',
      platform: 'linux',
      verifyHelper: async () => undefined,
      runHelper: async () => { throw new Error('native failure with path /secret/root'); },
    })).rejects.toThrow('HERMES_PROFILE_PATH_CREATE_FAILED');
  });

  it('writes the bounded Run config through native handles using stdin and the exact Run binding', async () => {
    const calls: Array<{ executable: string; args: string[]; options: { shell: false; input?: string } }> = [];
    const runId = 'c9b640db-9fbf-4d1f-b8a8-91e74093772b';
    const profileHome = `C:\\Users\\alice\\AppData\\Local\\hermes\\profiles\\ebb-orchestrator-run-${runId}`;
    const configYaml = 'model:\n  provider: "openai-codex"\n  default: "model-x"\n';

    await hermesProfileHome.writeHermesRunProfileConfig({
      profileHome,
      runId,
      helperPath: 'C:\\ebb\\native\\ebb-hermes-profile-path.exe',
      platform: 'win32',
      configYaml,
      verifyHelper: async () => undefined,
      runHelper: async (
        executable: string,
        args: string[],
        options: { shell: false; input?: string },
      ) => { calls.push({ executable, args, options }); },
    });

    expect(calls).toEqual([{
      executable: 'C:\\ebb\\native\\ebb-hermes-profile-path.exe',
      args: ['initialize-run-profile', 'C:\\Users\\alice\\AppData\\Local\\hermes', runId],
      options: { shell: false, input: configYaml },
    }]);
  });

  it('writes the exact Linux Run profile config through the native helper using stdin', async () => {
    const calls: Array<{ executable: string; args: string[]; options: { shell: false; input?: string } }> = [];
    const runId = 'c9b640db-9fbf-4d1f-b8a8-91e74093772b';
    const configYaml = 'model:\n  provider: "openai-api"\n  default: "model-x"\n';

    await hermesProfileHome.writeHermesRunProfileConfig({
      profileHome: `/home/alice/.hermes/profiles/ebb-orchestrator-run-${runId}`,
      runId,
      helperPath: '/opt/ebb/native/ebb-hermes-profile-path',
      platform: 'linux',
      configYaml,
      verifyHelper: async () => undefined,
      runHelper: async (
        executable: string,
        args: string[],
        options: { shell: false; input?: string },
      ) => { calls.push({ executable, args, options }); },
    } as unknown as Parameters<typeof hermesProfileHome.writeHermesRunProfileConfig>[0]);

    expect(calls).toEqual([{
      executable: '/opt/ebb/native/ebb-hermes-profile-path',
      args: ['initialize-run-profile', '/home/alice/.hermes', runId],
      options: { shell: false, input: configYaml },
    }]);
  });

  it('rejects a profile path whose leaf does not match the Run UUID before invoking native code', async () => {
    let called = false;
    await expect(hermesProfileHome.writeHermesRunProfileConfig({
      profileHome: 'C:\\Users\\alice\\AppData\\Local\\hermes\\profiles\\another-run',
      runId: 'c9b640db-9fbf-4d1f-b8a8-91e74093772b',
      helperPath: 'C:\\ebb\\native\\ebb-hermes-profile-path.exe',
      platform: 'win32',
      configYaml: 'model: {}\n',
      verifyHelper: async () => undefined,
      runHelper: async () => { called = true; },
    })).rejects.toThrow('HERMES_PROFILE_CONFIG_WRITE_INPUT_INVALID');
    expect(called).toBe(false);
  });

  it('rejects oversized profile config before invoking native code', async () => {
    let called = false;
    await expect(hermesProfileHome.writeHermesRunProfileConfig({
      profileHome: 'C:\\Users\\alice\\AppData\\Local\\hermes\\profiles\\ebb-orchestrator-run-c9b640db-9fbf-4d1f-b8a8-91e74093772b',
      runId: 'c9b640db-9fbf-4d1f-b8a8-91e74093772b',
      helperPath: 'C:\\ebb\\native\\ebb-hermes-profile-path.exe',
      platform: 'win32',
      configYaml: 'x'.repeat(64 * 1024 + 1),
      verifyHelper: async () => undefined,
      runHelper: async () => { called = true; },
    })).rejects.toThrow('HERMES_PROFILE_CONFIG_WRITE_INPUT_INVALID');
    expect(called).toBe(false);
  });
});
