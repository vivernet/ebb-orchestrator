import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureWindowsRunSupervisor } from "../../scripts/package-native-assets.mjs";

describe("server production native packaging", () => {
  let serverRoot: string | undefined;

  afterEach(() => {
    if (serverRoot) rmSync(serverRoot, { recursive: true, force: true });
    serverRoot = undefined;
  });

  it("builds and asserts the helper at the exact Windows runtime path", () => {
    const root = mkdtempSync(resolve(tmpdir(), "ebb-server-native-package-"));
    serverRoot = root;
    const expectedPath = resolve(root, "dist/native/windows-run-supervisor/ebb-run-supervisor.exe");
    let buildCalls = 0;

    const packagedPath = ensureWindowsRunSupervisor({
      platform: "win32",
      serverRoot: root,
      buildHelper: () => {
        buildCalls += 1;
        mkdirSync(resolve(root, "dist/native/windows-run-supervisor"), { recursive: true });
        writeFileSync(expectedPath, "native helper executable");
      },
    });

    expect(buildCalls).toBe(1);
    expect(packagedPath).toBe(expectedPath);
  });

  it("fails the Windows package build when the helper artifact is missing", () => {
    const root = mkdtempSync(resolve(tmpdir(), "ebb-server-native-package-missing-"));
    serverRoot = root;

    expect(() => ensureWindowsRunSupervisor({ platform: "win32", serverRoot: root, buildHelper: () => undefined }))
      .toThrow(/WINDOWS_PROCESS_SCOPE_HELPER_NOT_PACKAGED/u);
  });

  it("does not invoke a Windows compiler or require its artifact on Linux", () => {
    const root = mkdtempSync(resolve(tmpdir(), "ebb-server-native-package-linux-"));
    serverRoot = root;
    let buildCalls = 0;

    const packagedPath = ensureWindowsRunSupervisor({
      platform: "linux",
      serverRoot: root,
      buildHelper: () => { buildCalls += 1; },
    });

    expect(buildCalls).toBe(0);
    expect(packagedPath).toBeNull();
  });
});
