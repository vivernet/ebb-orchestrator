import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureHermesProfilePathHelper, ensureLinuxHermesLauncher, ensureWindowsRunSupervisor, writeNativeHelperIntegrityAnchor } from "../../scripts/package-native-assets.mjs";

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

  it.each([
    ["win32", "ebb-hermes-profile-path.exe"],
    ["linux", "ebb-hermes-profile-path"],
  ] as const)("packages the Hermes profile helper on %s", (platform, filename) => {
    const root = mkdtempSync(resolve(tmpdir(), "ebb-hermes-profile-package-"));
    serverRoot = root;
    const expectedPath = resolve(root, "dist/native/hermes-profile-path", filename);
    let buildCalls = 0;

    const packagedPath = ensureHermesProfilePathHelper({
      platform,
      serverRoot: root,
      buildHelper: () => {
        buildCalls += 1;
        mkdirSync(resolve(root, "dist/native/hermes-profile-path"), { recursive: true });
        writeFileSync(expectedPath, "native helper executable");
      },
    });

    expect(buildCalls).toBe(1);
    expect(packagedPath).toBe(expectedPath);
  });

  it("does not require a Hermes profile helper on unsupported platforms", () => {
    const root = mkdtempSync(resolve(tmpdir(), "ebb-hermes-profile-package-unsupported-"));
    serverRoot = root;
    let buildCalls = 0;

    expect(ensureHermesProfilePathHelper({
      platform: "darwin",
      serverRoot: root,
      buildHelper: () => { buildCalls += 1; },
    })).toBeNull();
    expect(buildCalls).toBe(0);
  });

  it("packages the Linux Hermes launch boundary only on Linux", () => {
    const root = mkdtempSync(resolve(tmpdir(), "ebb-linux-hermes-launcher-package-"));
    serverRoot = root;
    const expectedPath = resolve(root, "dist/native/linux-hermes-launcher/ebb-linux-hermes-launcher");
    let buildCalls = 0;

    const packagedPath = ensureLinuxHermesLauncher({
      platform: "linux",
      serverRoot: root,
      buildHelper: () => {
        buildCalls += 1;
        mkdirSync(resolve(root, "dist/native/linux-hermes-launcher"), { recursive: true });
        writeFileSync(expectedPath, "native helper executable", { mode: 0o755 });
      },
    });

    expect(buildCalls).toBe(1);
    expect(packagedPath).toBe(expectedPath);
    expect(ensureLinuxHermesLauncher({ platform: "win32", serverRoot: root, buildHelper: () => { throw new Error("unexpected build"); } }))
      .toBeNull();
  });

  it("fails the Linux package build when the Hermes launch artifact is missing", () => {
    const root = mkdtempSync(resolve(tmpdir(), "ebb-linux-hermes-launcher-mode-"));
    serverRoot = root;

    expect(() => ensureLinuxHermesLauncher({
      platform: "linux",
      serverRoot: root,
      buildHelper: () => undefined,
    })).toThrow(/LINUX_HERMES_LAUNCHER_NOT_PACKAGED/u);
  });

  it("writes helper digests into parent runtime code outside native helper directories", () => {
    const root = mkdtempSync(resolve(tmpdir(), "ebb-native-helper-anchor-"));
    serverRoot = root;
    const supervisorPath = resolve(root, "dist/native/windows-run-supervisor/ebb-run-supervisor.exe");
    const profileName = process.platform === "win32" ? "ebb-hermes-profile-path.exe" : "ebb-hermes-profile-path";
    const profilePath = resolve(root, "dist/native/hermes-profile-path", profileName);
    const supervisorBytes = Buffer.from("trusted supervisor helper");
    const profileBytes = Buffer.from("trusted profile helper");
    mkdirSync(resolve(root, "dist/native/windows-run-supervisor"), { recursive: true });
    mkdirSync(resolve(root, "dist/native/hermes-profile-path"), { recursive: true });
    writeFileSync(supervisorPath, supervisorBytes);
    writeFileSync(profilePath, profileBytes);

    const anchorPath = writeNativeHelperIntegrityAnchor({ serverRoot: root });
    const generatedCode = readFileSync(anchorPath, "utf8");
    expect(anchorPath).toBe(resolve(root, "dist/platform/process/native-helper-integrity-anchor.js"));
    expect(generatedCode).toContain(createHash("sha256").update(supervisorBytes).digest("hex"));
    expect(generatedCode).toContain(createHash("sha256").update(profileBytes).digest("hex"));
    expect(generatedCode).not.toContain("manifest.json");
  });
});
