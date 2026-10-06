import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

/**
 * Собирает Windows process-scope helper в ожидаемый runtime каталог и проверяет его упаковку.
 * На других платформах не требует Windows compiler и возвращает null.
 *
 * @param {{ platform: string, serverRoot: string, buildHelper: () => void }} options Платформа, корень server package и сборщик native helper.
 * @returns {string | null} Абсолютный путь собранного helper на Windows; иначе null.
 * @throws {Error} Если Windows сборка не положила непустой executable в runtime каталог.
 */
export function ensureWindowsRunSupervisor({ platform, serverRoot, buildHelper }) {
  if (platform !== "win32") return null;

  const helperPath = resolve(serverRoot, "dist/native/windows-run-supervisor/ebb-run-supervisor.exe");
  buildHelper();

  let helperStat;
  try {
    helperStat = lstatSync(helperPath);
  } catch {
    throw new Error(`WINDOWS_PROCESS_SCOPE_HELPER_NOT_PACKAGED:${helperPath}`);
  }
  if (!helperStat.isFile() || helperStat.isSymbolicLink() || helperStat.size === 0) {
    throw new Error(`WINDOWS_PROCESS_SCOPE_HELPER_NOT_PACKAGED:${helperPath}`);
  }
  return helperPath;
}

/**
 * Собирает Hermes profile-path helper на поддерживаемом runtime host и проверяет его runtime artifact.
 * Другие платформы не получают фиктивный fallback executable.
 *
 * @param {{ platform: string, serverRoot: string, buildHelper: () => void }} options Платформа, корень server package и builder.
 * @returns {string | null} Абсолютный путь к helper для Windows/Linux или null на неподдерживаемой платформе.
 * @throws {Error} Если поддерживаемая сборка не положила непустой executable.
 */
export function ensureHermesProfilePathHelper({ platform, serverRoot, buildHelper }) {
  if (platform !== "win32" && platform !== "linux") return null;

  const filename = platform === "win32" ? "ebb-hermes-profile-path.exe" : "ebb-hermes-profile-path";
  const helperPath = resolve(serverRoot, "dist/native/hermes-profile-path", filename);
  buildHelper();

  let helperStat;
  try {
    helperStat = lstatSync(helperPath);
  } catch {
    throw new Error(`HERMES_PROFILE_PATH_HELPER_NOT_PACKAGED:${helperPath}`);
  }
  if (!helperStat.isFile() || helperStat.isSymbolicLink() || helperStat.size === 0) {
    throw new Error(`HERMES_PROFILE_PATH_HELPER_NOT_PACKAGED:${helperPath}`);
  }
  return helperPath;
}

/**
 * Собирает Linux Hermes launch boundary и проверяет runtime artifact.
 * На других платформах Linux compiler не требуется.
 *
 * @param {{ platform: string, serverRoot: string, buildHelper: () => void }} options Платформа, корень server package и сборщик helper.
 * @returns {string | null} Абсолютный путь к Linux helper или null на неподдерживаемой платформе.
 * @throws {Error} Если Linux сборка не положила непустой executable.
 */
export function ensureLinuxHermesLauncher({ platform, serverRoot, buildHelper }) {
  if (platform !== "linux") return null;

  const helperPath = resolve(serverRoot, "dist/native/linux-hermes-launcher/ebb-linux-hermes-launcher");
  buildHelper();

  let helperStat;
  try {
    helperStat = lstatSync(helperPath);
  } catch {
    throw new Error(`LINUX_HERMES_LAUNCHER_NOT_PACKAGED:${helperPath}`);
  }
  if (!helperStat.isFile() || helperStat.isSymbolicLink() || helperStat.size === 0 ||
      (process.platform === "linux" && (helperStat.mode & 0o111) === 0)) {
    throw new Error(`LINUX_HERMES_LAUNCHER_NOT_PACKAGED:${helperPath}`);
  }
  return helperPath;
}

/**
 * Writes native helper hashes into parent runtime code after compilation. Runtime callers compare
 * helper bytes against this bundled code anchor; they never accept a helper's own JSON as proof.
 *
 * @param {{ serverRoot: string }} options Server package root whose compiled helper paths are packaged.
 * @returns {string} Absolute generated parent-code path outside the native helper directories.
 * @throws {Error} If an existing helper is not a regular non-empty file.
 */
export function writeNativeHelperIntegrityAnchor({ serverRoot }) {
  const helpers = {
    windowsRunSupervisor: resolve(serverRoot, "dist/native/windows-run-supervisor/ebb-run-supervisor.exe"),
    hermesProfilePath: resolve(serverRoot, "dist/native/hermes-profile-path", process.platform === "win32"
      ? "ebb-hermes-profile-path.exe"
      : "ebb-hermes-profile-path"),
    linuxHermesLauncher: resolve(serverRoot, "dist/native/linux-hermes-launcher/ebb-linux-hermes-launcher"),
  };
  const digests = {};
  for (const [name, helperPath] of Object.entries(helpers)) {
    try {
      const helperStat = lstatSync(helperPath, { bigint: true });
      if (!helperStat.isFile() || helperStat.isSymbolicLink() || helperStat.size === 0n) continue;
      const bytes = readFileSync(helperPath);
      digests[name] = createHash("sha256").update(bytes).digest("hex");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const anchorPath = resolve(serverRoot, "dist/platform/process/native-helper-integrity-anchor.js");
  mkdirSync(resolve(serverRoot, "dist/platform/process"), { recursive: true });
  writeFileSync(anchorPath,
    `export const NATIVE_HELPER_INTEGRITY_ANCHOR = Object.freeze(${JSON.stringify(digests)});\n`,
    { encoding: "utf8", mode: 0o644 },
  );
  return anchorPath;
}
