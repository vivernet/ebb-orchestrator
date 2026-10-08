import { spawnSync as nodeSpawnSync } from "node:child_process";
import { join } from "node:path";

const WINDOWS_FIXTURE_ACL_TIMEOUT_MS = 30_000;
const WINDOWS_FIXTURE_ACL_PHASES = new Set([
  "COMMAND_START",
  "PATH_RESOLVED",
  "IDENTITY_RESOLVED",
  "GET_ACL_STARTED",
  "GET_ACL_COMPLETED",
  "DACL_PROTECTION_STARTED",
  "DACL_PROTECTION_COMPLETED",
  "REMOVE_RULES_STARTED",
  "REMOVE_RULES_COMPLETED",
  "SET_OWNER_STARTED",
  "SET_OWNER_COMPLETED",
  "TARGET_TYPE_STARTED",
  "TARGET_TYPE_RESOLVED",
  "RULE_CREATED",
  "ADD_RULE_STARTED",
  "ADD_RULE_COMPLETED",
  "SET_ACL_STARTED",
  "SET_ACL_COMPLETED",
]);

function readRecognizedPhases(output) {
  const phases = [];
  for (const match of String(output || "").matchAll(/EBB_ACL_PHASE:([A-Z_]+)/gu)) {
    const phase = match[1];
    if (WINDOWS_FIXTURE_ACL_PHASES.has(phase) && !phases.includes(phase)) phases.push(phase);
  }
  return phases;
}

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
    "$phase = { param([string]$name) [Console]::Error.WriteLine(('EBB_ACL_PHASE:' + $name)); [Console]::Error.Flush() };",
    "$phase.Invoke('COMMAND_START');",
    "$path = [System.Environment]::GetEnvironmentVariable('EBB_HERMES_PROFILE_TEST_ROOT');",
    "$phase.Invoke('PATH_RESOLVED');",
    "$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User;",
    "$phase.Invoke('IDENTITY_RESOLVED');",
    "$phase.Invoke('GET_ACL_STARTED');",
    "$acl = Get-Acl -LiteralPath $path;",
    "$phase.Invoke('GET_ACL_COMPLETED');",
    "$phase.Invoke('DACL_PROTECTION_STARTED');",
    "$acl.SetAccessRuleProtection($true, $false);",
    "$phase.Invoke('DACL_PROTECTION_COMPLETED');",
    "$phase.Invoke('REMOVE_RULES_STARTED');",
    "foreach ($entry in @($acl.Access)) { $acl.RemoveAccessRuleAll($entry) };",
    "$phase.Invoke('REMOVE_RULES_COMPLETED');",
    "$phase.Invoke('SET_OWNER_STARTED');",
    "$acl.SetOwner($identity);",
    "$phase.Invoke('SET_OWNER_COMPLETED');",
    "$rights = [System.Security.AccessControl.FileSystemRights]::FullControl;",
    "$phase.Invoke('TARGET_TYPE_STARTED');",
    "$inherit = [System.Security.AccessControl.InheritanceFlags]::None; if ((Get-Item -LiteralPath $path).PSIsContainer) { $inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit };",
    "$phase.Invoke('TARGET_TYPE_RESOLVED');",
    "$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, $rights, $inherit, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow);",
    "$phase.Invoke('RULE_CREATED');",
    "$phase.Invoke('ADD_RULE_STARTED');",
    "$acl.AddAccessRule($rule);",
    "$phase.Invoke('ADD_RULE_COMPLETED');",
    "$phase.Invoke('SET_ACL_STARTED');",
    "Set-Acl -LiteralPath $path -AclObject $acl;",
    "$phase.Invoke('SET_ACL_COMPLETED');",
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
      const phases = [result.stderr, result.stdout]
        .flatMap(readRecognizedPhases)
        .filter((phase, index, all) => all.indexOf(phase) === index);
      throw new Error(`WINDOWS_FIXTURE_ACL_SETUP_TIMEOUT:${WINDOWS_FIXTURE_ACL_TIMEOUT_MS}:phases=${phases.join(",") || "none"}`);
    }
    throw new Error(`WINDOWS_FIXTURE_ACL_SETUP_SPAWN_FAILED:${result.error.code || "UNKNOWN"}`, { cause: result.error });
  }

  const errorText = String(result.stderr || "").replaceAll(directory, "<test-root>").trim();
  if (result.status !== 0) {
    const status = result.status === null ? "NO_EXIT_STATUS" : `EXIT_${result.status}`;
    throw new Error(`WINDOWS_FIXTURE_ACL_SETUP_FAILED:${status}:${errorText || "no stderr"}`);
  }
}
