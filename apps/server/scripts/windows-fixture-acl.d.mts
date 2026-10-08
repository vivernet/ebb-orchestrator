export interface WindowsFixtureAclOptions {
  serverDirectory: string;
  systemRoot?: string;
  systemPowerShellPath?: string;
  spawnSync?: (
    command: string,
    args: string[],
    options: {
      cwd: string;
      env: Record<string, string | undefined>;
      encoding: "utf8";
      shell: false;
      timeout: number;
      windowsHide: true;
      maxBuffer: number;
    },
  ) => {
    error: NodeJS.ErrnoException | undefined;
    status: number | null;
    stderr?: string | null;
    stdout?: string | null;
  };
}

/**
 * Настраивает ACL временного Windows acceptance fixture и прекращает выполнение
 * при таймауте, ошибке запуска PowerShell или неуспешном результате команды.
 * Повторных попыток изменения ACL нет.
 *
 * @param directory Путь к временной папке или файлу fixture.
 * @param options Настройки harness; spawnSync предназначен для изолированной проверки диагностики.
 * @throws {Error} Если PowerShell не запустился, завершился с ошибкой или превысил ограничение времени.
 */
export function makeWindowsFixturePrivate(directory: string, options: WindowsFixtureAclOptions): void;

/**
 * Создаёт непосредственный потомок volume root с protected owner-only DACL до появления каталога.
 *
 * @param directory Абсолютный путь к новому каталогу — ровно один компонент под volume root.
 * @param options Настройки acceptance harness и изолированного тестирования.
 * @returns Проверенный путь созданного каталога.
 * @throws {Error} Если путь небезопасен, цель уже существует, PowerShell завершился с ошибкой или истёк timeout.
 */
export function createWindowsPrivateFixtureDirectory(directory: string, options: WindowsFixtureAclOptions): string;
