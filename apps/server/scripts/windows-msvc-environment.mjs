import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { win32 as path } from "node:path";
import process from "node:process";

const x64CompilerSuffix = "\\bin\\hostx64\\x64\\cl.exe";
const visualStudioComponent = "Microsoft.VisualStudio.Component.VC.Tools.x86.x64";

function environmentValue(environment, name) {
  const key = Object.keys(environment).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? environment[key] : undefined;
}

function hasCompilerEnvironment(environment) {
  return Boolean(environmentValue(environment, "INCLUDE") && environmentValue(environment, "LIB"));
}

function withEnvironmentValue(environment, name, value) {
  const existingKey = Object.keys(environment).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  environment[existingKey ?? name] = value;
}

function isX64Compiler(candidate) {
  return typeof candidate === "string"
    && path.normalize(candidate).toLowerCase().endsWith(x64CompilerSuffix);
}

function firstExistingX64Compiler(output, fileExists) {
  return output
    .split(/\r?\n/u)
    .map((candidate) => candidate.trim())
    .find((candidate) => isX64Compiler(candidate) && fileExists(candidate));
}

function commandOptions(environment) {
  return {
    encoding: "utf8",
    env: environment,
    shell: false,
    windowsHide: true,
  };
}

function importDeveloperEnvironment({ environment, installationPath, run }) {
  const developerCommand = path.join(installationPath, "Common7", "Tools", "VsDevCmd.bat");
  if (!environment.exists(developerCommand)) {
    throw new Error("WINDOWS_PROCESS_SCOPE_DEVELOPER_ENVIRONMENT_UNAVAILABLE");
  }

  const command = `call "${developerCommand}" -arch=amd64 -host_arch=amd64 && set`;
  let output;
  try {
    output = run("cmd.exe", ["/d", "/s", "/c", command], {
      ...commandOptions(environment.values),
      windowsVerbatimArguments: true,
    });
  } catch {
    throw new Error("WINDOWS_PROCESS_SCOPE_DEVELOPER_ENVIRONMENT_FAILED");
  }

  const imported = { ...environment.values };
  for (const line of String(output).split(/\r?\n/u)) {
    const separator = line.indexOf("=");
    if (separator > 0) {
      withEnvironmentValue(imported, line.slice(0, separator), line.slice(separator + 1));
    }
  }
  return imported;
}

/**
 * Разрешает установленный MSVC для сборки Windows helper без изменения окружения
 * текущего процесса. В developer shell используется готовый x64 toolchain; в
 * обычной оболочке VsDevCmd запускается дочерним `cmd.exe`, а его environment
 * импортируется только в параметры последующего compiler process.
 *
 * @param {object} [options] Зависимости для разрешения toolchain.
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [options.env] Исходное окружение процесса.
 * @param {(filePath: string) => boolean} [options.exists] Проверка существования файлов.
 * @param {(file: string, args: string[], options: object) => string} [options.run] Запуск executable с shell:false.
 * @returns {{compiler: string, environment: Record<string, string | undefined>}} Путь к x64 compiler и его process-local environment.
 * @throws {Error} Если Visual Studio C++ Build Tools, VsDevCmd или x64 compiler отсутствует либо developer environment не загружается.
 */
export function resolveWindowsMsvcEnvironment({
  env = process.env,
  exists = existsSync,
  run = execFileSync,
} = {}) {
  const initialEnvironment = { ...env };
  const initialToolsDirectory = environmentValue(initialEnvironment, "VCToolsInstallDir");
  if (initialToolsDirectory) {
    const compiler = path.join(initialToolsDirectory, "bin", "Hostx64", "x64", "cl.exe");
    if (exists(compiler) && hasCompilerEnvironment(initialEnvironment)) {
      return { compiler, environment: initialEnvironment };
    }
  }

  try {
    const fromPath = run("where.exe", ["cl.exe"], commandOptions(initialEnvironment));
    const compiler = firstExistingX64Compiler(String(fromPath), exists);
    if (compiler && hasCompilerEnvironment(initialEnvironment)) {
      return { compiler, environment: initialEnvironment };
    }
  } catch {
    // An ordinary shell usually has no compiler on PATH; discover the VS installation below.
  }

  const programFilesX86 = environmentValue(initialEnvironment, "ProgramFiles(x86)");
  const vswhere = programFilesX86
    ? path.join(programFilesX86, "Microsoft Visual Studio", "Installer", "vswhere.exe")
    : undefined;
  if (!vswhere || !exists(vswhere)) {
    throw new Error("WINDOWS_PROCESS_SCOPE_BUILD_TOOLS_UNAVAILABLE");
  }

  let installationPath;
  try {
    installationPath = String(run(vswhere, [
      "-latest",
      "-products",
      "*",
      "-requires",
      visualStudioComponent,
      "-property",
      "installationPath",
    ], commandOptions(initialEnvironment))).trim();
  } catch {
    throw new Error("WINDOWS_PROCESS_SCOPE_BUILD_TOOLS_UNAVAILABLE");
  }
  if (!installationPath) {
    throw new Error("WINDOWS_PROCESS_SCOPE_BUILD_TOOLS_UNAVAILABLE");
  }

  const importedEnvironment = importDeveloperEnvironment({
    environment: { exists, values: initialEnvironment },
    installationPath,
    run,
  });
  const importedToolsDirectory = environmentValue(importedEnvironment, "VCToolsInstallDir");
  if (importedToolsDirectory) {
    const compiler = path.join(importedToolsDirectory, "bin", "Hostx64", "x64", "cl.exe");
    if (exists(compiler) && hasCompilerEnvironment(importedEnvironment)) {
      return { compiler, environment: importedEnvironment };
    }
  }

  let importedPath;
  try {
    importedPath = run("where.exe", ["cl.exe"], commandOptions(importedEnvironment));
  } catch {
    throw new Error("WINDOWS_PROCESS_SCOPE_BUILD_TOOLS_UNAVAILABLE");
  }
  const compiler = firstExistingX64Compiler(String(importedPath), exists);
  if (!compiler || !hasCompilerEnvironment(importedEnvironment)) {
    throw new Error("WINDOWS_PROCESS_SCOPE_BUILD_TOOLS_UNAVAILABLE");
  }
  return { compiler, environment: importedEnvironment };
}
