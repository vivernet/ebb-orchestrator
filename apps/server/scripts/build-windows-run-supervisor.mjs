import { execFileSync } from "node:child_process";
import console from "node:console";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { resolveWindowsMsvcEnvironment } from "./windows-msvc-environment.mjs";

if (process.platform !== "win32") {
  throw new Error("WINDOWS_PROCESS_SCOPE_BUILD_REQUIRES_WINDOWS");
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const serverDirectory = resolve(scriptDirectory, "..");
const repositoryDirectory = resolve(serverDirectory, "..", "..");
const source = join(serverDirectory, "native", "windows-run-supervisor", "ebb-run-supervisor.cpp");
const outputDirectory = join(serverDirectory, "dist", "native", "windows-run-supervisor");
const executable = join(outputDirectory, "ebb-run-supervisor.exe");
const objectFile = join(outputDirectory, "ebb-run-supervisor.obj");
const canonicalRepository = realpathSync(repositoryDirectory);
if (!existsSync(source)) {
  throw new Error("WINDOWS_PROCESS_SCOPE_BUILD_TOOLS_OR_SOURCE_UNAVAILABLE");
}
const { compiler, environment: compilerEnvironment } = resolveWindowsMsvcEnvironment({ exists: existsSync });

mkdirSync(outputDirectory, { recursive: true });

execFileSync(compiler, [
  "/nologo",
  "/std:c++17",
  "/EHsc",
  "/W4",
  "/DUNICODE",
  "/D_UNICODE",
  "/DWIN32_LEAN_AND_MEAN",
  "/DNOMINMAX",
  "/D_WIN32_WINNT=0x0A00",
  `/Fo${objectFile}`,
  `/Fe${executable}`,
  source,
  "kernel32.lib",
  "bcrypt.lib",
], {
  cwd: canonicalRepository,
  env: compilerEnvironment,
  shell: false,
  stdio: "inherit",
  windowsHide: true,
});

console.log(`Built provider-free Windows process-scope helper: ${executable}`);
