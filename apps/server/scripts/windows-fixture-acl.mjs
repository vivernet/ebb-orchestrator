import { spawnSync as nodeSpawnSync } from "node:child_process";
import { join } from "node:path";

const WINDOWS_FIXTURE_ACL_TIMEOUT_MS = 30_000;

/**
 * Настраивает ACL временного Windows acceptance fixture и прекращает выполнение
 * при таймауте, ошибке запуска PowerShell или неуспешном результате команды.
 * Повторных попыток изменения ACL нет: после ошибки состояние fixture остаётся
 * непроверенным и вызывающий тест должен завершиться с ошибкой.
 *
 * @param {string} directory Путь к временной папке или файлу fixture.
 * @param {{serverDirectory: string, systemRoot?: string, spawnSync?: typeof nodeSpawnSync}} options Настройки harness; spawnSync нужен для изолированной проверки диагностики.
 */
export function makeWindowsFixturePrivate(directory, { serverDirectory, systemRoot, spawnSync = nodeSpawnSync }) {
  const powershell = join(systemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const command = [
    "$ErrorActionPreference = 'Stop';",
    "$path = [System.Environment]::GetEnvironmentVariable('EBB_HERMES_PROFILE_TEST_ROOT');",
    "$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User;",
    "$acl = Get-Acl -LiteralPath $path;",
    "$acl.SetAccessRuleProtection($true, $false);",
    "foreach ($entry in @($acl.Access)) { $acl.RemoveAccessRuleAll($entry) };",
    "$acl.SetOwner($identity);",
    "$rights = [System.Security.AccessControl.FileSystemRights]::FullControl;",
    "$inherit = [System.Security.AccessControl.InheritanceFlags]::None; if ((Get-Item -LiteralPath $path).PSIsContainer) { $inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit };",
    "$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, $rights, $inherit, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow);",
    "$acl.AddAccessRule($rule);",
    "Set-Acl -LiteralPath $path -AclObject $acl;",
  ].join(" ");
  const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", command], {
    cwd: serverDirectory,
    env: { ...(systemRoot ? { SYSTEMROOT: systemRoot } : {}), EBB_HERMES_PROFILE_TEST_ROOT: directory },
    encoding: "utf8",
    shell: false,
    timeout: WINDOWS_FIXTURE_ACL_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 4_096,
  });

  if (result.error) {
    if (result.error.code === "ETIMEDOUT") {
      throw new Error(`WINDOWS_FIXTURE_ACL_SETUP_TIMEOUT:${WINDOWS_FIXTURE_ACL_TIMEOUT_MS}`, { cause: result.error });
    }
    throw new Error(`WINDOWS_FIXTURE_ACL_SETUP_SPAWN_FAILED:${result.error.code || "UNKNOWN"}`, { cause: result.error });
  }

  const errorText = String(result.stderr || "").replaceAll(directory, "<test-root>").trim();
  if (result.status !== 0) {
    const status = result.status === null ? "NO_EXIT_STATUS" : `EXIT_${result.status}`;
    throw new Error(`WINDOWS_FIXTURE_ACL_SETUP_FAILED:${status}:${errorText || "no stderr"}`);
  }
}
