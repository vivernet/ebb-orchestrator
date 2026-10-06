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

export interface PackageHermesProfilePathHelperOptions {
  platform: NodeJS.Platform;
  serverRoot: string;
  buildHelper: () => void;
}

export interface PackageLinuxHermesLauncherOptions {
  platform: NodeJS.Platform;
  serverRoot: string;
  buildHelper: () => void;
}

/**
 * Собирает Hermes profile-path helper на Windows/Linux и проверяет runtime artifact.
 *
 * @param options Платформа, корень server package и сборщик helper.
 * @returns Путь к собранному helper или null для неподдерживаемой платформы.
 * @throws {Error} Если поддерживаемая сборка не создала непустой executable.
 */
export function ensureHermesProfilePathHelper(options: PackageHermesProfilePathHelperOptions): string | null;

/**
 * Packages the Linux Hermes launch helper and verifies its runtime executable artifact.
 * @param options Server package root and native builder.
 * @returns The helper path on Linux or null on other platforms.
 * @throws {Error} If the Linux build did not create a non-empty executable.
 */
export function ensureLinuxHermesLauncher(options: PackageLinuxHermesLauncherOptions): string | null;

/**
 * Emits a generated parent-runtime JavaScript integrity anchor for every present supported helper.
 * @param options Server package root whose compiled native helpers are packaged.
 * @returns Absolute path to the generated parent-runtime anchor.
 */
export function writeNativeHelperIntegrityAnchor(options: { serverRoot: string }): string;
