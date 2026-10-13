import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildHermesInstalledRuntimeArgs, resolveHermesExecutable } from "../../src/modules/runtime/hermes/hermes-executable-resolver.js";

const fixtureRoots = new Set<string>();
afterAll(() => {
  for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true });
  fixtureRoots.clear();
});

describe.skipIf(process.platform !== "win32")("Windows installed Hermes resolver acceptance", () => {
  it("discovers launcher/Python identity and keeps the source pin diagnostic", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ebb-hermes-resolver-acceptance-"));
    fixtureRoots.add(root);
    const install = path.join(root, "install");
    const source = path.join(install, "hermes-agent");
    const bin = path.join(install, "bin");
    const cwd = path.join(root, "cwd");
    const home = path.join(root, "hermes-home");
    mkdirSync(path.join(source, "hermes_cli"), { recursive: true });
    mkdirSync(bin, { recursive: true });
    mkdirSync(cwd);
    mkdirSync(home);
    writeFileSync(path.join(source, "hermes_cli", "main.py"), "");
    writeFileSync(path.join(source, "install-stamp.json"), JSON.stringify({ commit: "08165d58931841cee713468ae89032af7c57060a" }));
    const launcher = path.join(bin, "hermes.cmd");
    writeFileSync(launcher, "@echo off\r\n");
    const runtime = path.join(home, "tools");
    const pythonEntry = "python-3.14.7+fixture-win32-x64";
    const python = path.join(runtime, pythonEntry, "python.exe");
    mkdirSync(path.dirname(python), { recursive: true });
    writeFileSync(python, "fixture interpreter");
    writeFileSync(path.join(runtime, "facts.json"), JSON.stringify({ packages: { python: { entry: pythonEntry } } }));
    const operations: string[] = [];
    const sourceChecks: Array<{ root: string; commit: string }> = [];

    const resolution = await resolveHermesExecutable({
      cwd,
      pathValue: bin,
      platform: "win32",
      environment: { PATH: bin, HERMES_HOME: home, USERPROFILE: root },
      verifySourceCheckout: async (sourceRoot, sourceCommit) => { sourceChecks.push({ root: sourceRoot, commit: sourceCommit }); },
      runNativePathVerifier: async (_file, args) => {
        operations.push(args[0] ?? "");
        const filename = args[2] ?? "";
        return { exitCode: 0, stderr: "", stdout: JSON.stringify({
          status: "SAFE_PATH", kind: "file", path: filename,
          volumeSerial: "0123456789abcdef", fileId: "0123456789abcdef0123456789abcdef",
        }) };
      },
      verifyNativeHelper: async () => undefined,
    });

    expect(resolution).toMatchObject({ executablePath: launcher, runtimeExecutablePath: python, hermesProjectRoot: source, hermesConfigHome: home });
    expect(resolution.sourceCommit).toBe("08165d58931841cee713468ae89032af7c57060a");
    const args = buildHermesInstalledRuntimeArgs({
      hermesProjectRoot: resolution.hermesProjectRoot,
      sourceCommit: resolution.sourceCommit,
      runtimeExecutablePath: resolution.runtimeExecutablePath,
      hermesHome: resolution.hermesConfigHome,
    });
    expect(args[3]).toContain("import hermes_bootstrap");
    expect(args[3]).toContain("runpy.run_module('hermes_cli.main'");
    expect(operations.length).toBeGreaterThan(0);
    expect(sourceChecks).toEqual([]);
    expect(operations.every((operation) => operation === "verify-host-path")).toBe(true);
  });
});
