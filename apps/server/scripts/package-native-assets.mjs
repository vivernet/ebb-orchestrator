import { statSync } from "node:fs";
import { resolve } from "node:path";

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
    helperStat = statSync(helperPath);
  } catch {
    throw new Error(`WINDOWS_PROCESS_SCOPE_HELPER_NOT_PACKAGED:${helperPath}`);
  }
  if (!helperStat.isFile() || helperStat.size === 0) {
    throw new Error(`WINDOWS_PROCESS_SCOPE_HELPER_NOT_PACKAGED:${helperPath}`);
  }
  return helperPath;
}
