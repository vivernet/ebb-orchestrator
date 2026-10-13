import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveHermesExecutable, buildHermesInstalledRuntimeArgs } from "../../../src/modules/runtime/hermes/hermes-executable-resolver.js";
import { HERMES_PROVIDER_SELECTION_SOURCE } from "../../../src/modules/runtime/hermes/hermes-source-identity.js";

let fixtureRoot = "";
afterEach(async () => {
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = "";
});

describe("direct installed Hermes resolver", () => {
  it("treats the install-stamp commit as optional diagnostics and never checks out Git", async () => {
    const paths = process.platform === "win32" ? await windowsFixture() : await linuxFixture();
    const stampPath = join(paths.source, "install-stamp.json");
    const installedCommit = "9244275491" + "0".repeat(30);
    await writeFile(stampPath, JSON.stringify({ runtimeDir: join(paths.source, "runtime"), commit: installedCommit }));
    const verifySourceCheckout = async () => { throw new Error("must not inspect Git"); };
    const resolution = await resolveHermesExecutable({ cwd: paths.cwd, pathValue: paths.bin, platform: process.platform === "win32" ? "win32" : "linux", environment: paths.environment, verifySourceCheckout, verifyNativeHelper: async () => undefined, runNativePathVerifier: async (_file, args) => { const filename = args[args.indexOf("file") + 1] ?? ""; return { exitCode: 0, stdout: JSON.stringify({ status: "SAFE_PATH", kind: "file", path: filename, volumeSerial: "0123456789abcdef", fileId: "0123456789abcdef0123456789abcdef" }), stderr: "" }; } });
    expect(resolution.sourceCommit).toBe(installedCommit);
    await writeFile(stampPath, JSON.stringify({ runtimeDir: join(paths.source, "runtime") }));
    const unstamped = await resolveHermesExecutable({ cwd: paths.cwd, pathValue: paths.bin, platform: process.platform === "win32" ? "win32" : "linux", environment: paths.environment, verifySourceCheckout, verifyNativeHelper: async () => undefined, runNativePathVerifier: async (_file, args) => { const filename = args[args.indexOf("file") + 1] ?? ""; return { exitCode: 0, stdout: JSON.stringify({ status: "SAFE_PATH", kind: "file", path: filename, volumeSerial: "0123456789abcdef", fileId: "0123456789abcdef0123456789abcdef" }), stderr: "" }; } });
    expect(unstamped.sourceCommit).toBeNull();
  });
  it("discovers the installed launcher and ordinary Python runtime without Git or ACL admission", async () => {
    const platform = process.platform === "win32" ? "win32" : "linux";
    const paths = platform === "win32" ? await windowsFixture() : await linuxFixture();
    const verifierCalls: string[][] = [];
    const resolution = await resolveHermesExecutable({
      cwd: paths.cwd,
      pathValue: paths.bin,
      platform,
      environment: paths.environment,
      verifySourceCheckout: async () => { throw new Error("must not inspect Git"); },
      verifyNativeHelper: async () => undefined,
      runNativePathVerifier: async (_file, args) => {
        verifierCalls.push(args);
        const filename = args[args.indexOf("file") + 1] ?? "";
        return { exitCode: 0, stdout: JSON.stringify({
          status: "SAFE_PATH", kind: "file", path: filename,
          volumeSerial: "0123456789abcdef", fileId: filename.toLowerCase().replace(/[^a-f0-9]/gu, "0").padEnd(32, "0").slice(0, 32),
        }), stderr: "" };
      },
    });
    expect(resolution.executablePath).toBe(paths.launcher);
    expect(resolution.runtimeExecutablePath).toBe(paths.python);
    expect(resolution.hermesProjectRoot).toBe(paths.source);
    expect(resolution.sourceCommit).toBe(HERMES_PROVIDER_SELECTION_SOURCE.commit);
    expect(resolution.hermesConfigHome).toBe(paths.hermesHome);
    expect(resolution).not.toHaveProperty("runtimeDependencyRoot");
    expect(resolution).not.toHaveProperty("runtimeArgsPrefix");
    expect(verifierCalls.every((args) => args[0] === "verify-host-path")).toBe(true);
    expect(verifierCalls.some((args) => args.some((arg) => /git|acl|snapshot|profile/iu.test(arg)))).toBe(false);
  });

  it("builds the normal installed-source bootstrap and registers Ebb MCP in memory", () => {
    const args = buildHermesInstalledRuntimeArgs({
      hermesProjectRoot: process.platform === "win32" ? "C:\\Hermes\\hermes-agent" : "/opt/hermes/hermes-agent",
      sourceCommit: HERMES_PROVIDER_SELECTION_SOURCE.commit,
      runtimeExecutablePath: process.platform === "win32" ? "C:\\Hermes\\python.exe" : "/opt/hermes/python/bin/python3",
      hermesHome: process.platform === "win32" ? "C:\\Users\\alice\\AppData\\Local\\hermes" : "/home/alice/.hermes",
      mcpServer: { command: "node", args: ["ebb-mcp.js", "--capability-ref", "dummy-ref"] },
    });
    expect(args.slice(0, 3)).toEqual(["-I", "-B", "-c"]);
    const bootstrap = args[3] ?? "";
    expect(bootstrap).toContain("sys.path.insert(0,");
    expect(bootstrap).not.toContain("ebb_verify_hermes_source");
    expect(bootstrap).not.toContain("subprocess");
    expect(bootstrap).toContain("import hermes_bootstrap");
    expect(bootstrap).toContain("except BaseException as ebb_bootstrap_error:");
    expect(bootstrap).toContain("EBB_HERMES_BOOTSTRAP_RELAUNCH:HERMES_BOOTSTRAP:");
    expect(bootstrap).toContain("EBB_HERMES_BOOTSTRAP_SYSTEM_EXIT:HERMES_BOOTSTRAP:");
    expect(bootstrap).toContain("type(ebb_bootstrap_error).__module__ == 'hermes_bootstrap'");
    expect(bootstrap).toContain("type(ebb_bootstrap_error) is SystemExit");
    expect(bootstrap).not.toContain("hermes_bootstrap.__name__");
    expect(bootstrap).not.toContain("isinstance(ebb_bootstrap_error, SystemExit)");
    expect(bootstrap).toContain("raise");
    expect(bootstrap).toContain("runpy.run_module('hermes_cli.main', run_name='__main__', alter_sys=True)");
    expect(bootstrap).toContain("os.environ.pop('PYTHONHOME', None)");
    expect(bootstrap).toContain("os.environ.pop('PYTHONPATH', None)");
    expect(bootstrap).toContain("os.environ.pop('VIRTUAL_ENV', None)");
    expect(bootstrap).toContain("os.environ['HERMES_HOME'] = os.environ.get('HERMES_HOME') or");
    expect(bootstrap.indexOf("register_mcp_servers(ebb_mcp)")).toBeLessThan(bootstrap.indexOf("runpy.run_module('hermes_cli.main'"));
    expect(bootstrap).toContain("mcp__ebb_orchestrator__submit_result");
    expect(bootstrap).toContain("HERMES_EBB_MCP_REGISTRATION_FAILED");
    expect(bootstrap).not.toContain("config.yaml");
    expect(bootstrap).not.toContain("auth.json");
  });

  it.runIf(process.platform === "win32")("gives both Windows identity probes a bounded 15-second cold-start budget", async () => {
    const paths = await windowsFixture();
    const verifiedPaths: string[] = [];
    const resolution = await resolveHermesExecutable({
      cwd: paths.cwd,
      pathValue: paths.bin,
      platform: "win32",
      environment: paths.environment,
      verifySourceCheckout: async (root, commit) => {
        expect(root).toBe(paths.source);
        expect(commit).toBe(HERMES_PROVIDER_SELECTION_SOURCE.commit);
      },
      verifyNativeHelper: async () => undefined,
      runNativePathVerifier: async (_file, args, options) => {
        expect(options.timeout).toBe(15_000);
        expect(options.shell).toBe(false);
        expect(options.maxBuffer).toBe(2_048);
        const filename = args[args.indexOf("file") + 1] ?? "";
        verifiedPaths.push(filename);
        return { exitCode: 0, stdout: JSON.stringify({
          status: "SAFE_PATH", kind: "file", path: filename,
          volumeSerial: "0123456789abcdef", fileId: "0123456789abcdef0123456789abcdef",
        }), stderr: "" };
      },
    });
    expect(verifiedPaths).toEqual([paths.launcher, paths.python]);
    expect(resolution.runtimeExecutablePath).toBe(paths.python);
  });
});

async function windowsFixture() {
  fixtureRoot = await mkdtemp(join(tmpdir(), "ebb-hermes-direct-")).then(resolve);
  const paths = win32;
  const install = paths.join(fixtureRoot, "install");
  const source = paths.join(install, "hermes-agent");
  const bin = paths.join(install, "bin");
  const cwd = paths.join(fixtureRoot, "cwd");
  const hermesHome = paths.join(fixtureRoot, "user-home", "hermes");
  await Promise.all([mkdir(paths.join(source, "hermes_cli"), { recursive: true }), mkdir(bin, { recursive: true }), mkdir(cwd), mkdir(hermesHome, { recursive: true })]);
  await writeFile(paths.join(source, "hermes_cli", "main.py"), "");
  await writeFile(paths.join(source, "install-stamp.json"), JSON.stringify({ commit: "08165d58931841cee713468ae89032af7c57060a" }));
  const launcher = paths.join(bin, "hermes.cmd");
  await writeFile(launcher, "@echo off\r\n");
  const state = paths.join(install, "installs", createHash("sha256").update(source).digest("hex").slice(0, 16));
  const venv = paths.join(state, "environments", "fixture", "venv");
  const python = paths.join(venv, "Scripts", "python.exe");
  await mkdir(paths.dirname(python), { recursive: true });
  await writeFile(python, "");
  await writeFile(paths.join(venv, "pyvenv.cfg"), "home = fixture\n");
  await writeFile(paths.join(state, "facts.json"), JSON.stringify({ packages: { venv: { environment: venv } } }));
  return { source, bin, cwd, launcher, python, hermesHome, environment: { PATH: bin, HERMES_HOME: hermesHome, USERPROFILE: fixtureRoot } };
}

async function linuxFixture() {
  fixtureRoot = await mkdtemp(join(tmpdir(), "ebb-hermes-direct-")).then(resolve);
  const source = fixtureRoot;
  const bin = join(source, "bin");
  const inner = join(source, ".hermes", "bin", "hermes");
  const runtime = join(source, "runtime");
  const cwd = join(source, "cwd");
  const hermesHome = join(source, "user-home", ".hermes");
  const python = join(runtime, "python", "bin", "python3");
  await Promise.all([mkdir(join(source, "hermes_cli"), { recursive: true }), mkdir(bin), mkdir(join(source, ".hermes", "bin"), { recursive: true }), mkdir(join(source, "runtime", "python", "bin"), { recursive: true }), mkdir(cwd), mkdir(hermesHome, { recursive: true })]);
  await writeFile(join(source, "hermes_cli", "main.py"), "");
  await writeFile(join(source, "install-stamp.json"), JSON.stringify({ runtimeDir: runtime, commit: HERMES_PROVIDER_SELECTION_SOURCE.commit }));
  await writeFile(join(runtime, "facts.json"), JSON.stringify({ packages: { python: { entry: "python" } } }));
  await writeFile(python, "");
  await chmod(python, 0o755);
  const launcher = join(bin, "hermes");
  await writeFile(launcher, `#!/bin/sh\nexec '${inner}' "$@"\n`);
  await chmod(launcher, 0o755);
  await writeFile(inner, "");
  await chmod(inner, 0o755);
  return { source, bin, cwd, launcher, python, hermesHome, environment: { PATH: bin, HOME: join(source, "user-home"), HERMES_HOME: hermesHome } };
}
