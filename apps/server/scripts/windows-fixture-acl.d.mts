export interface WindowsFixtureAclOptions {
  serverDirectory: string;
  systemRoot?: string;
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
