import { execFileSync } from "node:child_process";
import console from "node:console";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

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
let compiler = process.env.VCToolsInstallDir
  ? join(process.env.VCToolsInstallDir, "bin", "Hostx64", "x64", "cl.exe")
  : undefined;
if (!compiler) {
  try {
    compiler = execFileSync("where.exe", ["cl.exe"], { encoding: "utf8", windowsHide: true }).split(/\r?\n/u)[0];
  } catch {
    throw new Error("WINDOWS_PROCESS_SCOPE_BUILD_TOOLS_UNAVAILABLE");
  }
}
if (!compiler || !existsSync(compiler) || !existsSync(source)) {
  throw new Error("WINDOWS_PROCESS_SCOPE_BUILD_TOOLS_OR_SOURCE_UNAVAILABLE");
}

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
  stdio: "inherit",
  windowsHide: true,
});

console.log(`Built provider-free Windows process-scope helper: ${executable}`);
