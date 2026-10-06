import { execFileSync } from "node:child_process";
import console from "node:console";
import { existsSync, mkdirSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { writeNativeHelperIntegrityAnchor } from "./package-native-assets.mjs";

if (process.platform !== "linux") throw new Error("LINUX_HERMES_LAUNCHER_BUILD_REQUIRES_LINUX");

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const serverDirectory = resolve(scriptDirectory, "..");
const source = join(serverDirectory, "native", "linux-hermes-launcher", "ebb-linux-hermes-launcher.cpp");
const outputDirectory = join(serverDirectory, "dist", "native", "linux-hermes-launcher");
const executable = join(outputDirectory, "ebb-linux-hermes-launcher");

if (!existsSync(source)) throw new Error("LINUX_HERMES_LAUNCHER_BUILD_SOURCE_UNAVAILABLE");
mkdirSync(outputDirectory, { recursive: true });

execFileSync(process.env.CXX || "c++", [
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

console.log(`Built Linux Hermes launch helper: ${executable}`);
writeNativeHelperIntegrityAnchor({ serverRoot: serverDirectory });
