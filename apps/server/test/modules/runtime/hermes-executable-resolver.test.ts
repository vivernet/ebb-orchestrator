import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { access, mkdtemp, mkdir, rm, writeFile, chmod } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import type { ProcessResult } from "../../../src/platform/process/process-executor.js";
import { HERMES_PROVIDER_SELECTION_SOURCE } from "../../../src/modules/runtime/hermes/hermes-provider-selection.js";
import type { HermesSourceSnapshot } from "../../../src/modules/runtime/hermes/hermes-source-snapshot.js";
import type { HermesResolverCommandOptions } from "../../../src/modules/runtime/hermes/hermes-executable-resolver.js";
type HermesExecutableResolverModule = typeof import("../../../src/modules/runtime/hermes/hermes-executable-resolver.js");

const snapshotAttestationFixture = vi.hoisted(() => ({ value: undefined as unknown }));
const snapshotModulePath = "../../../src/modules/runtime/hermes/hermes-source-snapshot.js";
const resolverModulePath = "../../../src/modules/runtime/hermes/hermes-executable-resolver.js";

const sourceCommit = HERMES_PROVIDER_SELECTION_SOURCE.commit;
const sourceVersion = HERMES_PROVIDER_SELECTION_SOURCE.version;
const sourceTree = "a".repeat(sourceCommit.length);
const isWindows = process.platform === "win32";
const hermesName = isWindows ? "hermes.exe" : "hermes";

type ResolverOptions = NonNullable<Parameters<HermesExecutableResolverModule["resolveHermesExecutable"]>[0]>;
type Runner = NonNullable<ResolverOptions["runCommand"]>;

let testRoot = "";
let resolverModule: HermesExecutableResolverModule;

beforeEach(async () => {
  snapshotAttestationFixture.value = undefined;
  vi.doUnmock(resolverModulePath);
  vi.doUnmock(snapshotModulePath);
  vi.resetModules();
  vi.doMock(snapshotModulePath, async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../src/modules/runtime/hermes/hermes-source-snapshot.js")>();
    return {
      ...actual,
      isVerifiedHermesSourceSnapshot: (value: unknown) => value === snapshotAttestationFixture.value,
    };
  });
  try {
    resolverModule = await import("../../../src/modules/runtime/hermes/hermes-executable-resolver.js");
  } catch (error) {
    vi.doUnmock(resolverModulePath);
    vi.doUnmock(snapshotModulePath);
    vi.resetModules();
    throw error;
  }
});

afterEach(async () => {
  try {
    if (testRoot) await rm(testRoot, { recursive: true, force: true });
  } finally {
    testRoot = "";
    vi.doUnmock(resolverModulePath);
    vi.doUnmock(snapshotModulePath);
    vi.resetModules();
  }
});

async function fixture() {
  testRoot = await mkdtemp(join(tmpdir(), "ebb-hermes-resolver-"));
  const cwd = join(testRoot, "cwd");
  const home = join(testRoot, "hermes-home");
  const sourceRoot = join(home, "hermes-agent");
  const bin = join(home, "bin");
  const runtimeDir = join(home, "tools", "python");
  await Promise.all([mkdir(cwd), mkdir(sourceRoot, { recursive: true }), mkdir(bin, { recursive: true }), mkdir(runtimeDir, { recursive: true })]);
  await writeFile(join(sourceRoot, "install-stamp.json"), JSON.stringify({ baseVersion: "0.21.5" }));
  const pythonPath = join(runtimeDir, isWindows ? "python.exe" : "python3");
  await writeFile(pythonPath, "test runtime placeholder");
  const executablePath = join(bin, hermesName);
  if (isWindows) {
    const script = pinnedLauncherScript(resolve(sourceRoot));
    await writeFile(executablePath, makeWindowsLauncher(script, resolve(pythonPath)));
    await writeFile(join(bin, "hermes.cmd"), makeCommandSidecar(script, resolve(pythonPath)), "utf8");
  } else {
    const root = resolve(sourceRoot);
    const shellTarget = `${root}/.hermes/bin/hermes`;
    await writeFile(executablePath, `#!/bin/sh\nexec ${shellQuote(shellTarget)} "$@"\n`);
    await chmod(executablePath, 0o755);
    await chmod(pythonPath, 0o755);
  }
  return { cwd, home: resolve(home), sourceRoot: resolve(sourceRoot), bin, executablePath: resolve(executablePath), pythonPath: resolve(pythonPath) };
}

function pinnedLauncherScript(sourceRoot: string): string {
  return resolverModule.pinnedWindowsLauncherScript(sourceRoot);
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

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

function makeRunner(input: {
  executablePath: string;
  sourceRoot: string;
  pythonPath: string;
  head?: string;
  topLevel?: string;
  diffExitCode?: number;
  dirtyStatus?: string;
  untrustedGitPaths?: string[];
}): { runner: Runner; calls: Array<{ file: string; args: string[]; options: HermesResolverCommandOptions }> } {
  const calls: Array<{ file: string; args: string[]; options: HermesResolverCommandOptions }> = [];
  const runner: Runner = async (file: string, args: string[], options: HermesResolverCommandOptions): Promise<ProcessResult> => {
    calls.push({ file, args: [...args], options });
    if (args[0] === "verify-safe-path") {
      const kind = args[1];
      const target = args[2];
      if ((kind !== "file" && kind !== "directory") || !target) throw new Error("UNEXPECTED_TEST_PATH_VERIFICATION");
      const checksum = [...target.toLowerCase()].reduce((sum, character) => sum + character.charCodeAt(0), 0).toString(16).padStart(32, "0");
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          status: "SAFE_PATH",
          kind,
          path: `\\\\?\\${target}`,
          volumeSerial: "0123456789abcdef",
          fileId: checksum,
        }) + "\n",
        stderr: "",
      };
    }
    if (args.includes("-Command") && options.env?.EBB_HERMES_TRUST_CANDIDATE) {
      const candidate = options.env.EBB_HERMES_TRUST_CANDIDATE;
      const untrusted = input.untrustedGitPaths?.some((entry) => entry.toLowerCase() === candidate.toLowerCase()) ?? false;
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          status: "Valid",
          subject: untrusted ? "CN=Different Publisher" : "CN=Johannes Schindelin, O=Johannes Schindelin, S=Nordrhein-Westfalen, C=DE",
          thumbprint: untrusted ? "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF" : "3EB14A3AEF84B7153E139397F0A49E2FAC662B0E",
        }),
        stderr: "",
      };
    }
    if (file.toLowerCase().endsWith(isWindows ? "git.exe" : "/git") && args.includes("HEAD^{tree}")) {
      return { exitCode: 0, stdout: `${sourceTree}\n`, stderr: "" };
    }
    if (file.toLowerCase().endsWith(isWindows ? "git.exe" : "/git") && args.includes("--show-toplevel")) {
      const topLevel = input.topLevel ?? (isWindows ? input.sourceRoot.replaceAll("\\", "/") : input.sourceRoot);
      return { exitCode: 0, stdout: `${topLevel}\n`, stderr: "" };
    }
    if (file.toLowerCase().endsWith(isWindows ? "git.exe" : "/git") && args.includes("--verify")) {
      return { exitCode: 0, stdout: `${input.head ?? sourceCommit}\n`, stderr: "" };
    }
    if (file.toLowerCase().endsWith(isWindows ? "git.exe" : "/git") && args.includes("diff")) {
      return { exitCode: input.diffExitCode ?? 0, stdout: "", stderr: "" };
    }
    if (file.toLowerCase().endsWith(isWindows ? "git.exe" : "/git") && args.includes("status")) {
      return { exitCode: 0, stdout: input.dirtyStatus ?? "", stderr: "" };
    }
    throw new Error("UNEXPECTED_TEST_COMMAND");
  };
  return { runner, calls };
}

function pathValue(...entries: string[]): string {
  return entries.join(delimiter);
}

async function findGitCandidate(): Promise<{ executable: string; directory: string }> {
  if (!isWindows) throw new Error("Windows Git fixture requested on a non-Windows host");
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, "git.exe");
    const present = await access(candidate).then(() => true, () => false);
    if (present) return { executable: resolve(candidate), directory: resolve(directory) };
  }
  throw new Error("No absolute git.exe candidate is available for this Windows test");
}

const resolveHermesExecutableForTests = (options: ResolverOptions) => resolverModule.resolveHermesExecutable({
  ...options,
  verifyNativeHelper: async () => undefined,
});

function makeVerifiedSnapshotFixture(rootPath: string) {
  const snapshot = Object.freeze({
    cacheKey: JSON.stringify({
      formatVersion: 1,
      hermesVersion: sourceVersion,
      manifestDigest: "b".repeat(64),
      sourceCommit,
      sourceTree: "a".repeat(sourceCommit.length),
    }),
    directoryId: "c".repeat(64),
    manifestDigest: "b".repeat(64),
    rootPath,
  });
  snapshotAttestationFixture.value = snapshot;
  return snapshot as HermesSourceSnapshot;
}

async function findHostPython(): Promise<string | undefined> {
  const names = process.platform === "win32" ? ["python.exe", "python3.exe"] : ["python3", "python"];
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter((entry) => entry && isAbsolutePath(entry))) {
    for (const name of names) {
      const candidate = join(directory, name);
      if (await access(candidate).then(() => true, () => false)) return resolve(candidate);
    }
  }
  return undefined;
}

function isAbsolutePath(value: string): boolean {
  return process.platform === "win32" ? pathWin32IsAbsolute(value) : value.startsWith("/");
}

function pathWin32IsAbsolute(value: string): boolean {
  return /^[A-Za-z]:\\/u.test(value) || value.startsWith("\\\\");
}

describe("pinned Hermes executable resolver", () => {
  it("rejects caller-created absolute roots even when they point at the mutable install source", () => {
    const forgedSnapshot = Object.freeze({
      cacheKey: JSON.stringify({ hermesVersion: sourceVersion, sourceCommit }),
      directoryId: "d".repeat(64),
      manifestDigest: "e".repeat(64),
      rootPath: "C:\\Users\\alice\\.hermes\\hermes-agent",
    });
    expect(() => resolverModule.buildHermesSnapshotRuntimeArgs({
      snapshot: forgedSnapshot as HermesSourceSnapshot,
      runtimeDependencyRoot: "C:\\Users\\alice\\.hermes\\tools\\python",
      runtimeExecutablePath: "C:\\Users\\alice\\.hermes\\tools\\python\\python.exe",
      sourceVersion,
      sourceCommit,
    })).toThrow("HERMES_SOURCE_SNAPSHOT_REQUIRED");
  });

  it("builds an isolated bootstrap for an opaque snapshot and blocks pre-guard system-site hooks", async (context) => {
    const hostPython = await findHostPython();
    if (!hostPython) context.skip();
    testRoot = await mkdtemp(join(tmpdir(), "ebb-hermes-startup-hooks-"));
    const runtimeRoot = join(testRoot, "python-runtime");
    const snapshotRoot = join(testRoot, "empty-snapshot");
    await mkdir(snapshotRoot);
    const venv = spawnSync(hostPython!, ["-I", "-S", "-m", "venv", "--copies", "--without-pip", runtimeRoot], {
      encoding: "utf8", timeout: 60_000, windowsHide: true,
    });
    if (venv.status !== 0) context.skip();
    const runtimeExecutablePath = join(runtimeRoot, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    const getSitePath = "import sys,sysconfig; v=dict(sysconfig.get_config_vars()); r=sys.argv[1]; v.update({'base':r,'platbase':r,'installed_base':r,'installed_platbase':r}); print(sysconfig.get_paths(vars=v)['purelib'])";
    const siteQuery = spawnSync(runtimeExecutablePath, ["-I", "-S", "-c", getSitePath, runtimeRoot], {
      encoding: "utf8", timeout: 15_000, windowsHide: true,
    });
    if (siteQuery.status !== 0 || !siteQuery.stdout.trim()) context.skip();
    const sitePackages = siteQuery.stdout.trim();
    await mkdir(join(sitePackages, "hermes_cli"), { recursive: true });
    const pthMarker = join(testRoot, "pth-ran.marker");
    const importMarker = join(testRoot, "hermes-imported-before-guard.marker");
    await writeFile(join(sitePackages, "00-hostile.pth"),
      `import pathlib; pathlib.Path(${JSON.stringify(pthMarker)}).write_text('ran'); import hermes_cli\n`);
    await writeFile(join(sitePackages, "sitecustomize.py"),
      `from pathlib import Path; Path(${JSON.stringify(importMarker)}).write_text('ran')\n`);
    await writeFile(join(sitePackages, "hermes_cli", "__init__.py"),
      `from pathlib import Path; Path(${JSON.stringify(importMarker)}).write_text('ran')\n`);

    const snapshot = makeVerifiedSnapshotFixture(snapshotRoot);
    const args = resolverModule.buildHermesSnapshotRuntimeArgs({
      snapshot,
      runtimeDependencyRoot: runtimeRoot,
      runtimeExecutablePath,
      sourceVersion,
      sourceCommit,
    });
    expect(args.slice(0, 4)).toEqual(["-I", "-B", "-S", "-c"]);
    expect(args[4]).toContain("sys.dont_write_bytecode = True");
    expect(args[4]).toContain("HermesSnapshotFinder");
    expect(args[4]).toContain("sys.meta_path.insert(0, HermesSnapshotFinder())");
    expect(args[4]!.indexOf("sys.meta_path.insert(0, HermesSnapshotFinder())"))
      .toBeLessThan(args[4]!.indexOf("sys.path.extend(sorted(dependency_roots))"));

    const unsafeControl = spawnSync(runtimeExecutablePath, args.filter((argument) => argument !== "-S"), {
      cwd: testRoot,
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(unsafeControl.status).not.toBe(0);
    await expect(access(pthMarker)).resolves.toBeUndefined();
    await expect(access(importMarker)).resolves.toBeUndefined();
    await Promise.all([rm(pthMarker, { force: true }), rm(importMarker, { force: true })]);

    const result = spawnSync(runtimeExecutablePath, [...args], {
      cwd: testRoot,
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("HERMES_RUNTIME_LAYOUT_UNSUPPORTED");
    await expect(access(pthMarker)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(importMarker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("builds a fail-closed snapshot-only bootstrap for the exact pinned identity", () => {
    const snapshot = makeVerifiedSnapshotFixture("/var/lib/ebb/hermes-source/verified");
    const args = resolverModule.buildHermesSnapshotRuntimeArgs({
      snapshot,
      runtimeDependencyRoot: "/opt/hermes/python",
      runtimeExecutablePath: "/opt/hermes/python/bin/python3",
      sourceVersion,
      sourceCommit,
    });

    expect(args.slice(0, 4)).toEqual(["-I", "-B", "-S", "-c"]);
    expect(args[4]).toContain("sys.dont_write_bytecode = True");
    expect(args[4]).toContain("/var/lib/ebb/hermes-source/verified");
    expect(args[4]).toContain("hermes_constants");
    expect(args[4]).toContain("hermes_bootstrap");
    expect(args[4]).toContain("hermes_cli.main");
    expect(args[4]).toContain("HermesSnapshotFinder");
    expect(() => resolverModule.buildHermesSnapshotRuntimeArgs({
      snapshot,
      runtimeDependencyRoot: "/opt/hermes/python",
      runtimeExecutablePath: "/opt/hermes/python/bin/python3",
      sourceVersion: "v0.0.0+untrusted",
      sourceCommit,
    })).toThrow("HERMES_SOURCE_PIN_MISMATCH");
  });

  it("parses only the pinned distlib PE/ZIP launcher template", () => {
    const sourceRoot = "C:\\Hermes\\hermes-agent";
    const pythonPath = "C:\\Hermes\\tools\\python\\python.exe";
    const script = resolverModule.pinnedWindowsLauncherScript(sourceRoot);
    const parsed = resolverModule.inspectPinnedWindowsLauncher(makeWindowsLauncher(script, pythonPath), sourceRoot);
    expect(parsed.pythonExecutable).toBe(pythonPath);
    expect(parsed.scriptBytes.toString("utf8")).toBe(script);

    const altered = makeWindowsLauncher(`${script}# substituted payload\n`, pythonPath);
    expect(() => resolverModule.inspectPinnedWindowsLauncher(altered, sourceRoot)).toThrow("HERMES_LAUNCHER_PROVENANCE_MISMATCH");
    expect(() => resolverModule.inspectPinnedWindowsLauncher(Buffer.from("MZnot-a-PE"), sourceRoot)).toThrow("HERMES_LAUNCHER_PROVENANCE_MISMATCH");
  });

  it("accepts only exact pinned Git Authenticode evidence", () => {
    const pinned = JSON.stringify({
      status: "Valid",
      subject: "CN=Johannes Schindelin, O=Johannes Schindelin, S=Nordrhein-Westfalen, C=DE",
      thumbprint: "3EB14A3AEF84B7153E139397F0A49E2FAC662B0E",
    });
    expect(resolverModule.isPinnedGitAuthenticodeEvidence(pinned, 0, "")).toBe(true);
    expect(resolverModule.isPinnedGitAuthenticodeEvidence(JSON.stringify({ status: "NotSigned", subject: "", thumbprint: "" }), 0, "")).toBe(false);
    expect(resolverModule.isPinnedGitAuthenticodeEvidence(JSON.stringify({
      status: "Valid", subject: "CN=Different Publisher", thumbprint: "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF",
    }), 0, "")).toBe(false);
    expect(resolverModule.isPinnedGitAuthenticodeEvidence(`${pinned}\n`, 0, "")).toBe(false);
    expect(resolverModule.isPinnedGitAuthenticodeEvidence(pinned, 1, "signature query failed")).toBe(false);
  });

  it("applies pinned Linux Hermes root and profile override normalization", () => {
    expect(resolverModule.resolveLinuxHermesConfigHome({ HOME: "/home/alice", HERMES_DATA_DIR_SUFFIX: "-qa" }))
      .toBe("/home/alice/.hermes-qa");
    expect(resolverModule.resolveLinuxHermesConfigHome({
      HOME: "/home/alice",
      HERMES_DATA_DIR_SUFFIX: "-qa",
      HERMES_HOME: "$HOME/.hermes-qa/profiles/legacy-name",
    })).toBe("/home/alice/.hermes-qa");
    expect(resolverModule.resolveLinuxHermesConfigHome({ HOME: "/home/alice", HERMES_HOME: "/srv/hermes/profiles/custom" }))
      .toBe("/srv/hermes");
    expect(resolverModule.resolveLinuxHermesConfigHome({ HOME: "/home/alice", HERMES_HOME: "/srv/hermes" }))
      .toBe("/srv/hermes");
    expect(resolverModule.resolveLinuxHermesConfigHome({ HOME: "/home/alice", HERMES_HOME: "~/.hermes/custom" }))
      .toBe("/home/alice/.hermes/custom");
    expect(resolverModule.resolveLinuxHermesConfigHome({ HOME: "/home/alice", HERMES_HOME: "~/.hermes/profiles/run-a" }))
      .toBe("/home/alice/.hermes");
    expect(resolverModule.resolveLinuxHermesConfigHome({ HOME: "/home/alice", HERMES_HOME: "~/.hermes/profiles/run-a/nested" }))
      .toBe("/home/alice/.hermes/profiles/run-a/nested");
    expect(() => resolverModule.resolveLinuxHermesConfigHome({ HOME: "/home/alice", HERMES_HOME: "relative/hermes" }))
      .toThrow("HERMES_CONFIG_HOME_UNSAFE");
  });

  it("constructs the pinned Linux Python bootstrap without running the outer shell launcher", () => {
    const script = resolverModule.pinnedLinuxLauncherScript("/opt/hermes/hermes-agent");
    expect(script).toContain("sys.path.insert(0, '/opt/hermes/hermes-agent')");
    expect(script).toContain("import hermes_bootstrap");
    expect(script).toContain("from hermes_cli.main import main");
    expect(script).not.toContain("os.exec");
    expect(script).not.toContain("--print-runtime-command");
  });

  it("accepts only exact Linux device/inode path identities", () => {
    const linuxPath = "/home/alice/.hermes/profiles/ebb-orchestrator-run-c9b640db-9fbf-4d1f-b8a8-91e74093772b";
    const valid = JSON.stringify({ platform: "linux", path: linuxPath, device: "2049", inode: "195236" });
    expect(resolverModule.parseNativeSafePathIdentity(valid, "directory", linuxPath, linuxPath, "linux"))
      .toMatchObject({ platform: "linux", kind: "directory", path: linuxPath, device: "2049", inode: "195236" });
    expect(() => resolverModule.parseNativeSafePathIdentity(
      JSON.stringify({ platform: "linux", path: linuxPath, device: "02049", inode: "195236" }),
      "directory", linuxPath, linuxPath, "linux",
    )).toThrow("HERMES_PATH_IDENTITY_INVALID");
    expect(() => resolverModule.parseNativeSafePathIdentity(
      JSON.stringify({ platform: "linux", path: "/tmp/other", device: "2049", inode: "195236" }),
      "directory", linuxPath, linuxPath, "linux",
    )).toThrow("HERMES_PATH_IDENTITY_INVALID");
    expect(() => resolverModule.parseNativeSafePathIdentity(
      JSON.stringify({ platform: "linux", path: linuxPath, device: "2049", inode: "195236", extra: true }),
      "directory", linuxPath, linuxPath, "linux",
    )).toThrow("HERMES_PATH_IDENTITY_INVALID");
  });

  it("parses the exact native Windows profile path identity chain and auth-root boundary", () => {
    const profileHome = "C:\\Users\\alice\\AppData\\Local\\hermes\\profiles\\ebb-orchestrator-run-123e4567-e89b-42d3-a456-426614174000";
    const authRoot = "C:\\Users\\alice\\AppData\\Local\\hermes";
    const components = [
      { volumeSerial: "0123456789abcdef", fileId: "0".repeat(32) },
      ..."Users\\alice\\AppData\\Local\\hermes\\profiles".split("\\").map((_part, index) => ({
        volumeSerial: "0123456789abcdef",
        fileId: `${index + 1}`.padStart(32, "0"),
      })),
      { volumeSerial: "0123456789abcdef", fileId: "f".repeat(32) },
    ];
    const valid = JSON.stringify({
      status: "SAFE_PATH_CHAIN",
      profileHomePathChain: { version: 1, authRootIndex: 5, components },
    });
    expect(resolverModule.parseNativeSafePathIdentityChain(valid, profileHome, authRoot, "win32"))
      .toMatchObject({ version: 1, authRootIndex: 5, components });
    expect(() => resolverModule.parseNativeSafePathIdentityChain(
      JSON.stringify({ status: "SAFE_PATH_CHAIN", profileHomePathChain: { version: 1, authRootIndex: 6, components } }),
      profileHome, authRoot, "win32",
    )).toThrow("HERMES_PATH_IDENTITY_INVALID");
    expect(() => resolverModule.parseNativeSafePathIdentityChain(
      JSON.stringify({ status: "SAFE_PATH_CHAIN", profileHomePathChain: { version: 1, authRootIndex: 5, components, extra: true } }),
      profileHome, authRoot, "win32",
    )).toThrow("HERMES_PATH_IDENTITY_INVALID");
  });
});

describe.skipIf(process.platform !== "win32")("pinned Windows Hermes executable resolver", () => {
  it("rejects a substituted PATH launcher and Git even when both claim the pinned source", async () => {
    const paths = await fixture();
    const fakeGit = join(paths.bin, isWindows ? "git.exe" : "git");
    await writeFile(fakeGit, "substituted Git claiming the pinned commit");
    if (!isWindows) await chmod(fakeGit, 0o755);
    const substitutedLauncher = makeWindowsLauncher(
      `${pinnedLauncherScript(paths.sourceRoot)}# substituted entry point\n`,
      paths.pythonPath,
    );
    await writeFile(paths.executablePath, substitutedLauncher);
    const { runner, calls } = makeRunner(paths);

    await expect(resolveHermesExecutableForTests({
      cwd: paths.cwd,
      pathValue: pathValue(paths.bin),
      platform: "win32",
      runCommand: runner,
    })).rejects.toThrow("HERMES_LAUNCHER_PROVENANCE_MISMATCH");
    expect(calls.some((call) => call.file === paths.executablePath || call.file.toLowerCase().endsWith("git.exe") || call.args.includes("-Command"))).toBe(false);
  });

  it("resolves one absolute non-CWD launcher and proves the exact pinned runtime bootstrap", async () => {
    const paths = await fixture();
    const trustedGit = await findGitCandidate();
    const { runner, calls } = makeRunner(paths);

    const resolved = await resolveHermesExecutableForTests({
      cwd: paths.cwd,
      pathValue: pathValue(paths.cwd, paths.bin, trustedGit.directory),
      platform: "win32",
      runCommand: runner,
    });

    expect(resolved).toMatchObject({
      executablePath: paths.executablePath,
      hermesProjectRoot: paths.sourceRoot,
      hermesConfigHome: paths.home,
      runtimeExecutablePath: paths.pythonPath,
      runtimeDependencyRoot: resolve(paths.pythonPath, ".."),
      runtimeArgsPrefix: ["-I", "-B", "-S", "-c", "raise SystemExit('HERMES_SOURCE_SNAPSHOT_REQUIRED')"],
      executableIdentity: { platform: "win32" },
      runtimeExecutableIdentity: { platform: "win32" },
      sourceVersion,
      sourceCommit,
      sourceTree,
      gitExecutable: trustedGit.executable,
    });
    expect(calls.some((call) => call.file === paths.executablePath)).toBe(false);
    expect(calls.some((call) => call.args.some((arg) => arg.includes("--print-runtime-command")))).toBe(false);
    expect(calls.some((call) => call.file === trustedGit.executable && call.args.includes("HEAD^{tree}"))).toBe(true);
    expect(calls.some((call) => call.file === trustedGit.executable && call.args.includes("--verify"))).toBe(true);
    const signatureCall = calls.find((call) => call.args.includes("-Command"));
    expect(signatureCall?.options.shell).toBe(false);
    expect(signatureCall?.args.slice(0, 3)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive"]);
    expect(signatureCall?.options.env?.EBB_HERMES_TRUST_CANDIDATE).toBe(trustedGit.executable);
    expect(signatureCall?.args[4]).toContain("Get-AuthenticodeSignature");
    expect(signatureCall?.args[4]).toContain("SignerCertificate.Thumbprint");
    expect(signatureCall?.options.shell).toBe(false);
    expect(signatureCall?.options.env?.EBB_HERMES_TRUST_CANDIDATE).toBe(trustedGit.executable);
    const pathVerifierCalls = calls.filter((call) => call.args[0] === "verify-safe-path");
    expect(pathVerifierCalls.length).toBeGreaterThan(0);
    expect(pathVerifierCalls.every((call) => call.options.shell === false && call.options.timeout === 5_000)).toBe(true);
    expect(pathVerifierCalls.some((call) => call.args[1] === "file" && call.args[2] === paths.executablePath)).toBe(true);
    expect(pathVerifierCalls.some((call) => call.args[1] === "directory" && call.args[2] === paths.sourceRoot)).toBe(true);
  });

  it("skips a substituted writable PATH Git and invokes the identified protected absolute binary", async () => {
    const paths = await fixture();
    const identifiedGit = await findGitCandidate();
    const fakeGit = join(paths.bin, "git.exe");
    await writeFile(fakeGit, "fake Git claiming the correct commit");
    const { runner, calls } = makeRunner({ ...paths, untrustedGitPaths: [fakeGit] });

    const result = await resolveHermesExecutableForTests({
      cwd: paths.cwd,
      pathValue: pathValue(paths.bin, identifiedGit.directory),
      platform: "win32",
      runCommand: runner,
    });

    expect(result.sourceCommit).toBe(sourceCommit);
    expect(calls.some((call) => call.file === fakeGit)).toBe(false);
    expect(calls.some((call) => call.file === identifiedGit.executable)).toBe(true);
  });

  it("verifies the installed Git signer through the real fixed PowerShell process boundary", async () => {
    const identifiedGit = await findGitCandidate();
    await expect(resolverModule.verifyPinnedWindowsGitSignature(identifiedGit.executable)).resolves.toBe(true);
  }, 15_000);

  it("resolves launcher identity without running Hermes to inspect its runtime command", async () => {
    const paths = await fixture();
    const trustedGit = await findGitCandidate();
    const { runner, calls } = makeRunner(paths);

    const resolved = await resolveHermesExecutableForTests({
      cwd: paths.cwd,
      pathValue: pathValue(paths.bin, trustedGit.directory),
      platform: "win32",
      runCommand: runner,
    });
    expect(resolved.executableIdentity).toMatchObject({ platform: "win32" });
    expect(calls.some((call) => call.file === paths.executablePath)).toBe(false);
    expect(calls.some((call) => call.args.some((arg) => arg.includes("--print-runtime-command")))).toBe(false);
  });

  it("ignores relative and CWD PATH entries instead of resolving them against cwd", async () => {
    const paths = await fixture();
    const cwdLauncher = join(paths.cwd, hermesName);
    await writeFile(cwdLauncher, "must not be selected");
    if (!isWindows) await chmod(cwdLauncher, 0o755);

    await expect(resolveHermesExecutableForTests({
      cwd: paths.cwd,
      pathValue: pathValue(".", paths.cwd),
      platform: "win32",
      runCommand: async () => { throw new Error("launcher must not run"); },
    })).rejects.toThrow("HERMES_LAUNCHER_NOT_FOUND");
  });

  it("fails closed when PATH contains multiple distinct Hermes launchers", async () => {
    const paths = await fixture();
    const otherBin = join(testRoot, "other-bin");
    await mkdir(otherBin);
    const otherLauncher = join(otherBin, hermesName);
    await writeFile(otherLauncher, "second launcher");
    if (!isWindows) await chmod(otherLauncher, 0o755);

    await expect(resolveHermesExecutableForTests({
      cwd: paths.cwd,
      pathValue: pathValue(paths.bin, otherBin),
      platform: "win32",
      runCommand: async () => { throw new Error("ambiguous launcher must not run"); },
    })).rejects.toThrow("HERMES_LAUNCHER_AMBIGUOUS");
  });

  it("rejects an exact source root whose commit is not pinned", async () => {
    const paths = await fixture();
    const trustedGit = await findGitCandidate();
    const { runner } = makeRunner({ ...paths, head: "f".repeat(40) });
    await expect(resolveHermesExecutableForTests({
      cwd: paths.cwd,
      pathValue: pathValue(paths.bin, trustedGit.directory),
      platform: "win32",
      runCommand: runner,
    })).rejects.toThrow("HERMES_SOURCE_PIN_MISMATCH");
  });

  it("rejects a dirty source launcher and a mismatched install version", async () => {
    const paths = await fixture();
    const trustedGit = await findGitCandidate();
    const dirtyRunner = makeRunner({ ...paths, diffExitCode: 1 }).runner;
    await expect(resolveHermesExecutableForTests({
      cwd: paths.cwd,
      pathValue: pathValue(paths.bin, trustedGit.directory),
      platform: "win32",
      runCommand: dirtyRunner,
    })).rejects.toThrow("HERMES_SOURCE_DIRTY");

    const untrackedRunner = makeRunner({ ...paths, dirtyStatus: "?? hermes_plugin.py\n" }).runner;
    await expect(resolveHermesExecutableForTests({
      cwd: paths.cwd,
      pathValue: pathValue(paths.bin, trustedGit.directory),
      platform: "win32",
      runCommand: untrackedRunner,
    })).rejects.toThrow("HERMES_SOURCE_DIRTY");

    await writeFile(join(paths.sourceRoot, "install-stamp.json"), JSON.stringify({ baseVersion: "0.21.4" }));
    const cleanRunner = makeRunner(paths).runner;
    await expect(resolveHermesExecutableForTests({
      cwd: paths.cwd,
      pathValue: pathValue(paths.bin, trustedGit.directory),
      platform: "win32",
      runCommand: cleanRunner,
    })).rejects.toThrow("HERMES_SOURCE_VERSION_MISMATCH");
  });
});
