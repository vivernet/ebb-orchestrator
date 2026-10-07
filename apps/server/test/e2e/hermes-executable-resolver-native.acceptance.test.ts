import { afterAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { ProcessResult } from "../../src/platform/process/process-executor.js";
import { runVerifiedNativeHelper } from "../../src/platform/process/native-helper-launcher.js";
import { HERMES_PROVIDER_SELECTION_SOURCE } from "../../src/modules/runtime/hermes/hermes-provider-selection.js";
import { pinnedWindowsLauncherScript, resolveHermesExecutable } from "../../src/modules/runtime/hermes/hermes-executable-resolver.js";

const isWindows = process.platform === "win32";
const fixtureRoots = new Set<string>();
const signerSubject = "CN=Johannes Schindelin, O=Johannes Schindelin, S=Nordrhein-Westfalen, C=DE";
const signerThumbprint = "3EB14A3AEF84B7153E139397F0A49E2FAC662B0E";
const sourceTree = "a".repeat(HERMES_PROVIDER_SELECTION_SOURCE.commit.length);

afterAll(() => {
  for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true });
  fixtureRoots.clear();
});

describe.skipIf(!isWindows)("Windows Hermes resolver native path-chain integration", () => {
  it("accepts the OS-derived Windows PowerShell dependency through the integrity-checked helper", async () => {
    const helper = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist/native/hermes-profile-path/ebb-hermes-profile-path.exe");
    const result = await runVerifiedNativeHelper(helper, "hermesProfilePath", ["verify-windows-system-powershell"], {
      cwd: process.cwd(),
      timeout: 15_000,
      maxBuffer: 8_192,
    });
    expect(result.stderr).toBe("");
    const identity = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(identity).toMatchObject({ status: "SAFE_PATH", kind: "file" });
    expect(identity.path).toMatch(/\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/iu);
  }, 20_000);

  it("uses the integrity-checked helper for install paths and confines read-only ancestor rights", async () => {
    const paths = makeFixture();
    try {
      const runner = makeGitAndSignatureProbe(paths);
      grantForeignRights(paths.fixtureRoot, "RD,REA");

      const resolved = await resolveHermesExecutable({
        cwd: paths.cwd,
        pathValue: paths.bin,
        platform: "win32",
        runCommand: runner,
        // Deliberately omit runNativePathVerifier and verifyNativeHelper: production helper
        // execution and its generated integrity anchor are part of this acceptance.
      });

      expect(resolved.executablePath).toBe(paths.executablePath);
      expect(resolved.hermesProjectRoot).toBe(paths.sourceRoot);
      expect(resolved.runtimeExecutablePath).toBe(paths.pythonPath);

      grantForeignRights(paths.home, "WD");
      await expect(resolveHermesExecutable({
        cwd: paths.cwd,
        pathValue: paths.bin,
        platform: "win32",
        runCommand: runner,
      })).rejects.toThrow("HERMES_PATH_UNSAFE");
      removeForeignRights(paths.home);

      grantForeignRights(paths.sourceRoot, "AD");
      await expect(resolveHermesExecutable({
        cwd: paths.cwd,
        pathValue: paths.bin,
        platform: "win32",
        runCommand: runner,
      })).rejects.toThrow("HERMES_PATH_UNSAFE");
      removeForeignRights(paths.sourceRoot);
    } finally {
      rmSync(paths.fixtureRoot, { recursive: true, force: true });
      fixtureRoots.delete(paths.fixtureRoot);
    }
  }, 120_000);
});

function makeFixture() {
  const volumeRoot = path.win32.parse(realpathSync(tmpdir())).root;
  const fixtureRoot = mkdtempSync(path.win32.join(volumeRoot, "ebb-hermes-resolver-chain-"));
  fixtureRoots.add(fixtureRoot);
  const cwd = path.win32.join(fixtureRoot, "cwd");
  const home = path.win32.join(fixtureRoot, "hermes-home");
  const sourceRoot = path.win32.join(home, "hermes-agent");
  const bin = path.win32.join(home, "bin");
  const runtimeDir = path.win32.join(home, "tools", "python");
  mkdirSync(cwd);
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  const pythonPath = path.win32.join(runtimeDir, "python.exe");
  const executablePath = path.win32.join(bin, "hermes.exe");
  const gitPath = path.win32.join(bin, "git.exe");
  const script = pinnedWindowsLauncherScript(sourceRoot);
  const baseVersion = HERMES_PROVIDER_SELECTION_SOURCE.version.match(/^v(\d+\.\d+\.\d+)\+/u)?.[1];
  if (!baseVersion) throw new Error("HERMES_TEST_SOURCE_VERSION_INVALID");
  writeFileSync(path.win32.join(sourceRoot, "install-stamp.json"), JSON.stringify({ baseVersion }));
  writeFileSync(pythonPath, "provider-free placeholder runtime");
  writeFileSync(executablePath, makeWindowsLauncher(script, pythonPath));
  writeFileSync(path.win32.join(bin, "hermes.cmd"), makeCommandSidecar(script, pythonPath), "utf8");
  writeFileSync(gitPath, "test seam: Git commands and signer probe are mocked");

  for (const directory of [fixtureRoot, cwd, home, sourceRoot, bin, path.win32.join(home, "tools"), runtimeDir]) makePrivate(directory);
  for (const file of [pythonPath, executablePath, path.win32.join(bin, "hermes.cmd"), gitPath,
    path.win32.join(sourceRoot, "install-stamp.json")]) makePrivate(file);
  return {
    fixtureRoot: realpathSync(fixtureRoot), cwd: realpathSync(cwd), home: realpathSync(home),
    sourceRoot: realpathSync(sourceRoot), bin: realpathSync(bin), executablePath: realpathSync(executablePath),
    pythonPath: realpathSync(pythonPath), gitPath: realpathSync(gitPath),
  };
}

function makeGitAndSignatureProbe(paths: ReturnType<typeof makeFixture>) {
  return async (file: string, args: string[], options: { readonly env?: Readonly<Record<string, string | undefined>> }): Promise<ProcessResult> => {
    if (args.includes("-Command") && options.env?.EBB_HERMES_TRUST_CANDIDATE === paths.gitPath) {
      return { exitCode: 0, stdout: JSON.stringify({ status: "Valid", subject: signerSubject, thumbprint: signerThumbprint }), stderr: "" };
    }
    if (path.win32.basename(file).toLowerCase() !== "git.exe" || !file.toLowerCase().endsWith("git.exe")) {
      throw new Error("UNEXPECTED_NON_GIT_PROBE");
    }
    if (args.includes("HEAD^{tree}")) return { exitCode: 0, stdout: `${sourceTree}\n`, stderr: "" };
    if (args.includes("--show-toplevel")) return { exitCode: 0, stdout: `${paths.sourceRoot.replaceAll("\\", "/")}\n`, stderr: "" };
    if (args.includes("--verify")) return { exitCode: 0, stdout: `${HERMES_PROVIDER_SELECTION_SOURCE.commit}\n`, stderr: "" };
    if (args.includes("diff")) return { exitCode: 0, stdout: "", stderr: "" };
    if (args.includes("status")) return { exitCode: 0, stdout: "", stderr: "" };
    throw new Error("UNEXPECTED_GIT_PROBE");
  };
}

function makePrivate(target: string): void {
  const identity = execFileSync(path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
    "-NoProfile", "-NonInteractive", "-Command", "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
  ], { encoding: "utf8", shell: false, windowsHide: true }).trim();
  execFileSync(path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"), [
    target, "/inheritance:r", "/grant:r", `*${identity}:(F)`,
  ], { encoding: "utf8", shell: false, windowsHide: true });
}

function grantForeignRights(target: string, rights: string): void {
  const result = spawnSync(path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"), [
    target, "/grant", `*S-1-1-0:(${rights})`,
  ], { encoding: "utf8", shell: false, windowsHide: true, timeout: 5_000 });
  if (result.error || result.status !== 0) throw new Error("HERMES_RESOLVER_FIXTURE_ACL_FAILED");
}

function removeForeignRights(target: string): void {
  const result = spawnSync(path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"), [
    target, "/remove:g", "*S-1-1-0",
  ], { encoding: "utf8", shell: false, windowsHide: true, timeout: 5_000 });
  if (result.error || result.status !== 0) throw new Error("HERMES_RESOLVER_FIXTURE_ACL_CLEANUP_FAILED");
}

function makeCommandSidecar(script: string, pythonPath: string): string {
  const payload = Buffer.from(script, "utf8").toString("base64");
  return `@echo off\r\n"${pythonPath}" -I -c "import base64; exec(base64.b64decode('${payload}'))" %*\r\n`;
}

function makeWindowsLauncher(script: string, pythonPath: string): Buffer {
  const pe = Buffer.alloc(0x80);
  pe.write("MZ", 0, "ascii");
  pe.writeUInt32LE(0x40, 0x3c);
  pe.write("PE\0\0", 0x40, "binary");
  const prefix = Buffer.concat([pe, Buffer.from(`#!${pythonPath} -I\n`, "utf8")]);
  const name = Buffer.from("__main__.py", "ascii");
  const data = Buffer.from(script, "utf8");
  const checksum = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const localFile = Buffer.concat([local, name, data]);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  const centralFile = Buffer.concat([central, name]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralFile.length, 12);
  end.writeUInt32LE(localFile.length, 16);
  return Buffer.concat([prefix, localFile, centralFile, end]);
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
