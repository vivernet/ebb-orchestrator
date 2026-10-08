import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nativeHelper = {
  calls: [] as Array<{ helperPath: string; anchor: string; args: string[]; options: Record<string, unknown> }>,
  stdout: "",
};

describe("Hermes provider selection production helper gate", () => {
  beforeEach(() => {
    vi.resetModules();
    nativeHelper.calls = [];
    nativeHelper.stdout = JSON.stringify({
      sourceVersion: "v0.21.5+9117.g08165d5",
      sourceCommit: "08165d58931841cee713468ae89032af7c57060a",
      projectionVersion: "hermes-config-selection-v1",
      status: "EXPLICIT_SELECTION",
      providerId: "fireworks",
      modelId: "accounts/fireworks/models/example",
      endpointOverridePresent: false,
    });
    vi.doMock("../../../src/platform/process/native-helper-launcher.js", () => ({
      runVerifiedNativeHelper: vi.fn(async (
        helperPath: string,
        anchor: string,
        args: string[],
        options: Record<string, unknown>,
      ) => {
        nativeHelper.calls.push({ helperPath, anchor, args, options });
        return { exitCode: 0, stdout: nativeHelper.stdout, stderr: "" };
      }),
    }));
  });

  afterEach(() => {
    vi.doUnmock("../../../src/platform/process/native-helper-launcher.js");
    vi.resetModules();
  });

  it("uses the parent-integrity-gated native helper when production does not inject a test runner", async () => {
    const { readHermesProviderSelection } = await import(
      "../../../src/modules/runtime/hermes/hermes-provider-selection.js"
    );
    const { runVerifiedNativeHelper } = await import("../../../src/platform/process/native-helper-launcher.js");
    expect(vi.isMockFunction(runVerifiedNativeHelper)).toBe(true);
    const platform = process.platform === "win32" ? "win32" : "linux";
    const paths = platform === "win32"
      ? { root: "C:\\Hermes", helper: "C:\\Ebb\\native\\ebb-hermes-profile-path.exe", join: "\\" }
      : { root: "/home/alice/.hermes", helper: "/opt/ebb/native/ebb-hermes-profile-path", join: "/" };
    const runId = "c9b640db-9fbf-4d1f-b8a8-91e74093772b";
    const profileHome = `${paths.root}${paths.join}profiles${paths.join}ebb-orchestrator-run-${runId}`;

    await readHermesProviderSelection({
      hermesConfigHome: paths.root,
      hermesRunProfileHome: profileHome,
      hermesProjectRoot: platform === "win32" ? "C:\\Hermes\\install" : "/opt/hermes-agent",
      runId,
      runEnvironment: {},
      helperPath: paths.helper,
      platform,
    });

    expect(nativeHelper.calls).toEqual([{
      helperPath: paths.helper,
      anchor: "hermesProfilePath",
      args: ["project-selection", paths.root, profileHome, runId],
      options: expect.objectContaining({
        timeout: 5_000,
        maxBuffer: 2_048,
        env: expect.any(Object),
      }),
    }]);
  });
});
