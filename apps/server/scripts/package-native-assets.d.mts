export interface PackageWindowsRunSupervisorOptions {
  platform: NodeJS.Platform;
  serverRoot: string;
  buildHelper: () => void;
}

/**
 * Собирает Windows process-scope helper в ожидаемый runtime каталог и проверяет его упаковку.
 * На других платформах не требует Windows compiler и возвращает null.
 *
 * @param options Платформа, корень server package и сборщик native helper.
 * @returns Абсолютный путь собранного helper на Windows; иначе null.
 * @throws {Error} Если Windows сборка не положила непустой executable в runtime каталог.
 */
export function ensureWindowsRunSupervisor(options: PackageWindowsRunSupervisorOptions): string | null;
