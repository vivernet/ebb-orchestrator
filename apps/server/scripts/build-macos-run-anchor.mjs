import { execFileSync } from "node:child_process";
import console from "node:console";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { writeNativeHelperIntegrityAnchor } from "./package-native-assets.mjs";

if (process.platform !== "darwin") {
  throw new Error("MACOS_PROCESS_SCOPE_BUILD_REQUIRES_DARWIN");
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const serverDirectory = resolve(scriptDirectory, "..");
const repositoryDirectory = resolve(serverDirectory, "..", "..");
const source = join(serverDirectory, "native", "macos-run-anchor", "ebb-macos-run-anchor.c");
const outputDirectory = join(serverDirectory, "dist", "native", "macos-run-anchor");
const executable = join(outputDirectory, "ebb-macos-run-anchor");
const canonicalRepository = realpathSync(repositoryDirectory);

if (!existsSync(source)) {
  throw new Error("MACOS_PROCESS_SCOPE_BUILD_SOURCE_UNAVAILABLE");
}

mkdirSync(outputDirectory, { recursive: true });

const compiler = process.env.CC ?? "clang";
execFileSync(compiler, [
  "-arch", "arm64",
  "-mmacosx-version-min=13.5",
  "-std=c11",
  "-O2",
  "-Wall",
  "-Wextra",
  "-Werror",
  source,
  "-o", executable,
], {
  cwd: canonicalRepository,
  shell: false,
  stdio: "inherit",
});

console.log(`Built provider-free macOS process-scope anchor: ${executable}`);
writeNativeHelperIntegrityAnchor({ serverRoot: serverDirectory });
