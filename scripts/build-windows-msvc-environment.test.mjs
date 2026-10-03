import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { resolveWindowsMsvcEnvironment } from "../apps/server/scripts/windows-msvc-environment.mjs";

const builderPath = fileURLToPath(new NodeURL("../apps/server/scripts/build-windows-run-supervisor.mjs", import.meta.url));

test("Windows helper build resolves an isolated Visual Studio compiler environment", () => {
  const source = readFileSync(builderPath, "utf8");

  assert.match(source, /resolveWindowsMsvcEnvironment/u);
  assert.match(source, /env: compilerEnvironment/u, "compiler must receive only the resolved child environment");
});

test("an initialized developer shell keeps its exact Hostx64/x64 compiler fast path", () => {
  const toolsDirectory = "C:\\VS\\VC\\Tools\\MSVC\\14.45.35312";
  const compiler = `${toolsDirectory}\\bin\\Hostx64\\x64\\cl.exe`;
  const runCalls = [];
  const result = resolveWindowsMsvcEnvironment({
    env: { VCToolsInstallDir: toolsDirectory, INCLUDE: "existing-include", LIB: "existing-lib" },
    exists: (candidate) => candidate === compiler,
    run: (...args) => {
      runCalls.push(args);
      throw new Error("unexpected subprocess");
    },
  });

  assert.equal(result.compiler, compiler);
  assert.equal(result.environment.INCLUDE, "existing-include");
  assert.equal(result.environment.LIB, "existing-lib");
  assert.deepEqual(runCalls, []);
});

test("an incomplete VCToolsInstallDir environment falls through to complete VS discovery", () => {
  const programFilesX86 = "C:\\Program Files (x86)";
  const vswhere = `${programFilesX86}\\Microsoft Visual Studio\\Installer\\vswhere.exe`;
  const installationPath = "C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\BuildTools";
  const developerCommand = `${installationPath}\\Common7\\Tools\\VsDevCmd.bat`;
  const staleToolsDirectory = "C:\\Stale\\VC\\Tools\\MSVC\\14.30";
  const completeToolsDirectory = "C:\\VS\\VC\\Tools\\MSVC\\14.45.35312\\";
  const staleCompiler = `${staleToolsDirectory}\\bin\\Hostx64\\x64\\cl.exe`;
  const completeCompiler = `${completeToolsDirectory}bin\\Hostx64\\x64\\cl.exe`;
  const existingFiles = new Set([vswhere, developerCommand, staleCompiler, completeCompiler]);
  const calls = [];
  const result = resolveWindowsMsvcEnvironment({
    env: {
      "ProgramFiles(x86)": programFilesX86,
      VCToolsInstallDir: staleToolsDirectory,
      PATH: "C:\\Windows\\System32",
      INCLUDE: "incomplete-include",
    },
    exists: (candidate) => existingFiles.has(candidate),
    run: (file, args) => {
      calls.push(file);
      if (file === "where.exe") return "";
      if (file === vswhere) return `${installationPath}\r\n`;
      if (file === "cmd.exe") {
        return [
          `VCToolsInstallDir=${completeToolsDirectory}`,
          "PATH=C:\\VS\\bin",
          "INCLUDE=C:\\VS\\include",
          "LIB=C:\\VS\\lib",
        ].join("\r\n");
      }
      throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
    },
  });

  assert.equal(result.compiler, completeCompiler);
  assert.equal(result.environment.INCLUDE, "C:\\VS\\include");
  assert.equal(result.environment.LIB, "C:\\VS\\lib");
  assert.deepEqual(calls, ["where.exe", vswhere, "cmd.exe"]);
});

test("ordinary shells import VsDevCmd PATH, INCLUDE and LIB only for the compiler child", () => {
  const programFilesX86 = "C:\\Program Files (x86)";
  const vswhere = `${programFilesX86}\\Microsoft Visual Studio\\Installer\\vswhere.exe`;
  const installationPath = "C:\\Program Files (x86)\\Microsoft Visual Studio\\2019\\BuildTools";
  const developerCommand = `${installationPath}\\Common7\\Tools\\VsDevCmd.bat`;
  const toolsDirectory = "C:\\VS\\VC\\Tools\\MSVC\\14.45.35312\\";
  const compiler = `${toolsDirectory}bin\\Hostx64\\x64\\cl.exe`;
  const initialEnvironment = { "ProgramFiles(x86)": programFilesX86, PATH: "C:\\Windows\\System32" };
  const calls = [];
  const existingFiles = new Set([vswhere, developerCommand, compiler]);
  const result = resolveWindowsMsvcEnvironment({
    env: initialEnvironment,
    exists: (candidate) => existingFiles.has(candidate),
    run: (file, args, options) => {
      calls.push({ file, args, options });
      if (file === "where.exe") return "";
      if (file === vswhere) return `${installationPath}\r\n`;
      if (file === "cmd.exe") {
        return [
          `VCToolsInstallDir=${toolsDirectory}`,
          "Path=C:\\VS\\VC\\Tools\\MSVC\\14.45.35312\\bin\\Hostx64\\x64;C:\\Windows\\System32",
          "INCLUDE=C:\\VS\\include",
          "LIB=C:\\VS\\lib",
        ].join("\r\n");
      }
      throw new Error(`unexpected command: ${file}`);
    },
  });

  assert.equal(result.compiler, compiler, "the selected compiler must be Hostx64/x64 even when the inherited PATH has no compiler");
  assert.equal(result.environment.PATH, "C:\\VS\\VC\\Tools\\MSVC\\14.45.35312\\bin\\Hostx64\\x64;C:\\Windows\\System32");
  assert.equal(result.environment.INCLUDE, "C:\\VS\\include");
  assert.equal(result.environment.LIB, "C:\\VS\\lib");
  assert.equal(initialEnvironment.PATH, "C:\\Windows\\System32", "the parent environment must remain unchanged");
  assert.deepEqual(calls.map(({ file }) => file), ["where.exe", vswhere, "cmd.exe"]);
  assert.deepEqual(calls[1].args, [
    "-latest",
    "-products",
    "*",
    "-requires",
    "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
    "-property",
    "installationPath",
  ]);
  assert.deepEqual(calls[2].args, [
    "/d",
    "/s",
    "/c",
    `call "${developerCommand}" -arch=amd64 -host_arch=amd64 && set`,
  ]);
  assert.equal(calls[2].options.shell, false);
  assert.equal(calls[2].options.windowsVerbatimArguments, true);
  assert.equal(calls[2].options.env.PATH, initialEnvironment.PATH, "VsDevCmd runs in a child based on the original environment");
});

test("PATH fallback accepts only an existing x64 host compiler", () => {
  const x86Compiler = "C:\\VS\\VC\\Tools\\MSVC\\14.45\\bin\\Hostx86\\x64\\cl.exe";
  const x64Compiler = "C:\\VS\\VC\\Tools\\MSVC\\14.45\\bin\\Hostx64\\x64\\cl.exe";
  const result = resolveWindowsMsvcEnvironment({
    env: { PATH: "C:\\VS\\bin", INCLUDE: "C:\\VS\\include", LIB: "C:\\VS\\lib" },
    exists: (candidate) => candidate === x64Compiler,
    run: () => `${x86Compiler}\r\n${x64Compiler}\r\n`,
  });

  assert.equal(result.compiler, x64Compiler);
});

test("missing Visual Studio tooling fails closed", () => {
  assert.throws(
    () => resolveWindowsMsvcEnvironment({
      env: { PATH: "C:\\Windows\\System32" },
      exists: () => false,
      run: () => {
        throw new Error("no command");
      },
    }),
    { message: "WINDOWS_PROCESS_SCOPE_BUILD_TOOLS_UNAVAILABLE" },
  );
});
