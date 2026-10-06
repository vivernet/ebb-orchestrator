import { execFileSync } from "node:child_process";
import console from "node:console";
import { existsSync, mkdirSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { resolveWindowsMsvcEnvironment } from "./windows-msvc-environment.mjs";
import { writeNativeHelperIntegrityAnchor } from "./package-native-assets.mjs";

if (process.platform !== "win32" && process.platform !== "linux") {
  throw new Error("HERMES_PROFILE_PATH_BUILD_UNSUPPORTED_PLATFORM");
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const serverDirectory = resolve(scriptDirectory, "..");
const source = join(serverDirectory, "native", "hermes-profile-path", "ebb-hermes-profile-path.cpp");
const outputDirectory = join(serverDirectory, "dist", "native", "hermes-profile-path");
const executable = join(outputDirectory, process.platform === "win32" ? "ebb-hermes-profile-path.exe" : "ebb-hermes-profile-path");

if (!existsSync(source)) throw new Error("HERMES_PROFILE_PATH_BUILD_SOURCE_UNAVAILABLE");
mkdirSync(outputDirectory, { recursive: true });

if (process.platform === "win32") {
  const objectFile = join(outputDirectory, "ebb-hermes-profile-path.obj");
  const { compiler, environment } = resolveWindowsMsvcEnvironment({ exists: existsSync });
  execFileSync(compiler, [
    "/nologo",
    "/std:c++17",
    "/EHsc",
    "/W4",
    "/DUNICODE",
    "/D_UNICODE",
    "/D_WIN32_WINNT=0x0A00",
    `/Fo${objectFile}`,
    `/Fe${executable}`,
    source,
    "advapi32.lib",
    "kernel32.lib",
    "ntdll.lib",
  ], {
    cwd: serverDirectory,
    env: environment,
    shell: false,
    stdio: "inherit",
    windowsHide: true,
  });
} else {
  const compiler = process.env.CXX || "c++";
  execFileSync(compiler, [
    "-std=c++17",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Wpedantic",
    source,
    "-o",
    executable,
  ], {
    cwd: serverDirectory,
    shell: false,
    stdio: "inherit",
  });
}

console.log(`Built Hermes profile-path helper: ${executable}`);
writeNativeHelperIntegrityAnchor({ serverRoot: serverDirectory });
