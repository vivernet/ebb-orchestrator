import { execFileSync } from "node:child_process";
import console from "node:console";
import { existsSync, mkdirSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { resolveWindowsMsvcEnvironment } from "./windows-msvc-environment.mjs";
import { writeNativeHelperIntegrityAnchor } from "./package-native-assets.mjs";

if (process.platform !== "win32") {
  console.log("Hermes file identity helper is only required on Windows.");
  process.exit(0);
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const serverDirectory = resolve(scriptDirectory, "..");
const source = join(serverDirectory, "native", "hermes-profile-path", "ebb-hermes-profile-path.cpp");
const outputDirectory = join(serverDirectory, "dist", "native", "hermes-profile-path");
const executable = join(outputDirectory, "ebb-hermes-profile-path.exe");

if (!existsSync(source)) throw new Error("HERMES_PROFILE_PATH_BUILD_SOURCE_UNAVAILABLE");
mkdirSync(outputDirectory, { recursive: true });
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
  "kernel32.lib",
  "ntdll.lib",
], {
  cwd: serverDirectory,
  env: environment,
  shell: false,
  stdio: "inherit",
  windowsHide: true,
});
console.log(`Built Hermes file identity helper: ${executable}`);
writeNativeHelperIntegrityAnchor({ serverRoot: serverDirectory });
