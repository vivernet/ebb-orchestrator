import { spawnSync as nodeSpawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { join, win32 } from "node:path";

const WINDOWS_FIXTURE_ACL_TIMEOUT_MS = 30_000;
const WINDOWS_FIXTURE_FS_ERROR_CODES = new Set(["EACCES", "EBUSY", "EINVAL", "EIO", "EISDIR", "ENOENT", "ENOTDIR", "EPERM"]);
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
  "CREATE_STARTED",
  "CREATE_COMPLETED",
  "READBACK_STARTED",
  "READBACK_COMPLETED",
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
  let target;
  try {
    target = lstatSync(directory);
  } catch {
    throw new Error("WINDOWS_FIXTURE_ACL_UNSAFE_TARGET");
  }
  if (target.isSymbolicLink() || (!target.isDirectory() && !target.isFile())) {
    throw new Error("WINDOWS_FIXTURE_ACL_UNSAFE_TARGET");
  }
  const isDirectory = target.isDirectory();
  const powershell = join(systemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const command = [
    "$ErrorActionPreference = 'Stop';",
    "$phase = { param([string]$name) [Console]::Error.WriteLine(('EBB_ACL_PHASE:' + $name)); [Console]::Error.Flush() };",
    "$phase.Invoke('COMMAND_START');",
    "$path = [System.Environment]::GetEnvironmentVariable('EBB_HERMES_PROFILE_TEST_ROOT');",
    "$phase.Invoke('PATH_RESOLVED');",
    "$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User;",
    "$phase.Invoke('IDENTITY_RESOLVED');",
    "$phase.Invoke('TARGET_TYPE_STARTED');",
    "$isDirectory = [System.Environment]::GetEnvironmentVariable('EBB_HERMES_PROFILE_TEST_IS_DIRECTORY');",
    "$item = if ($isDirectory -eq '1') { [System.IO.DirectoryInfo]::new($path) } else { [System.IO.FileInfo]::new($path) };",
    "$phase.Invoke('TARGET_TYPE_RESOLVED');",
    "$phase.Invoke('GET_ACL_STARTED');",
    "$acl = $item.GetAccessControl();",
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
    "$inherit = [System.Security.AccessControl.InheritanceFlags]::None; if ($isDirectory -eq '1') { $inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit };",
    "$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, $rights, $inherit, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow);",
    "$phase.Invoke('RULE_CREATED');",
    "$phase.Invoke('ADD_RULE_STARTED');",
    "$acl.AddAccessRule($rule);",
    "$phase.Invoke('ADD_RULE_COMPLETED');",
    "$phase.Invoke('SET_ACL_STARTED');",
    "$item.SetAccessControl($acl);",
    "$phase.Invoke('SET_ACL_COMPLETED');",
  ].join(" ");
  const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", command], {
    cwd: serverDirectory,
    env: {
      ...(systemRoot ? { SYSTEMROOT: systemRoot } : {}),
      EBB_HERMES_PROFILE_TEST_ROOT: directory,
      EBB_HERMES_PROFILE_TEST_IS_DIRECTORY: isDirectory ? "1" : "0",
    },
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

/**
 * Создаёт уникальный Windows acceptance root непосредственным потомком volume root
 * с protected owner-only DACL до появления каталога в namespace.
 *
 * @param {string} directory Абсолютный путь к новому каталогу — ровно один компонент под volume root.
 * @param {{serverDirectory: string, systemPowerShellPath: string, spawnSync?: typeof nodeSpawnSync}} options Путь PowerShell, полученный через integrity-checked native verifier, и изолированный spawn для тестирования.
 * @returns {string} Путь после проверки владельца и точной DACL.
 */
export function createWindowsPrivateFixtureDirectory(directory, { serverDirectory, systemPowerShellPath, spawnSync = nodeSpawnSync }) {
  const normalized = win32.normalize(directory);
  const parsed = win32.parse(normalized);
  const normalizedPowerShellPath = typeof systemPowerShellPath === "string" ? win32.normalize(systemPowerShellPath) : "";
  const powerShellRoot = normalizedPowerShellPath ? win32.parse(normalizedPowerShellPath).root : "";
  if (!/^[A-Za-z]:\\$/u.test(parsed.root) || !win32.isAbsolute(directory) ||
      win32.dirname(normalized).toLowerCase() !== parsed.root.toLowerCase() ||
      win32.basename(normalized) === "" || normalized.endsWith("\\") ||
      !/^[A-Za-z]:\\$/u.test(powerShellRoot) || powerShellRoot.toLowerCase() !== parsed.root.toLowerCase() ||
      !normalizedPowerShellPath.toLowerCase().endsWith("\\system32\\windowspowershell\\v1.0\\powershell.exe")) {
    throw new Error("WINDOWS_FIXTURE_PRIVATE_CREATE_UNSAFE_TARGET");
  }
  try {
    lstatSync(directory);
    throw new Error("WINDOWS_FIXTURE_PRIVATE_CREATE_TARGET_EXISTS");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("WINDOWS_FIXTURE_PRIVATE_CREATE_")) throw error;
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") {
      const code = error && typeof error === "object" && "code" in error &&
        typeof error.code === "string" && WINDOWS_FIXTURE_FS_ERROR_CODES.has(error.code)
        ? error.code
        : "UNKNOWN";
      if (error instanceof Error) {
        for (const key of Object.keys(error)) {
          if (key !== "code") delete error[key];
        }
        delete error.cause;
        delete error.path;
        delete error.dest;
        delete error.syscall;
        delete error.errno;
        error.code = code;
        error.name = "Error";
        error.message = `Fixture filesystem error: ${code}`;
        error.stack = error.message;
      }
      throw new Error("WINDOWS_FIXTURE_PRIVATE_CREATE_UNSAFE_TARGET", { cause: error });
    }
  }

  const powershell = normalizedPowerShellPath;
  const command = [
    "$ErrorActionPreference='Stop';",
    "$path=[Environment]::GetEnvironmentVariable('EBB_HERMES_PRIVATE_FIXTURE_ROOT');",
    "$phase={param([string]$name)[Console]::Error.WriteLine(('EBB_ACL_PHASE:'+$name));[Console]::Error.Flush()};",
    "$phase.Invoke('COMMAND_START');",
    "$identity=[Security.Principal.WindowsIdentity]::GetCurrent().User;",
    "$root=[IO.Path]::GetPathRoot($path); $parent=[IO.Path]::GetDirectoryName($path);",
    "if ([string]::IsNullOrWhiteSpace($root) -or $parent.TrimEnd('\\') -ine $root.TrimEnd('\\') -or [IO.Directory]::Exists($path) -or [IO.File]::Exists($path)) { throw 'FIXTURE_ROOT_INVALID' };",
    "$acl=New-Object Security.AccessControl.DirectorySecurity; $acl.SetAccessRuleProtection($true,$false); $acl.SetOwner($identity);",
    "$inherit=[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit;",
    "$rule=[Security.AccessControl.FileSystemAccessRule]::new($identity,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow); $acl.AddAccessRule($rule);",
    "$phase.Invoke('CREATE_STARTED'); $directory=[IO.DirectoryInfo]::new($path); $directory.Create($acl); $phase.Invoke('CREATE_COMPLETED');",
    "$phase.Invoke('READBACK_STARTED'); $verified=$directory.GetAccessControl();",
    "if (-not $directory.Exists -or -not $verified.AreAccessRulesProtected -or $verified.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $identity.Value) { throw 'FIXTURE_DACL_VERIFICATION_FAILED' };",
    "$rules=@($verified.Access); if ($rules.Count -ne 1 -or $rules[0].IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $identity.Value -or $rules[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or [int]$rules[0].FileSystemRights -ne 0x001F01FF -or $rules[0].InheritanceFlags -ne $inherit -or $rules[0].PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None -or $rules[0].IsInherited) { throw 'FIXTURE_DACL_VERIFICATION_FAILED' };",
    "$phase.Invoke('READBACK_COMPLETED');",
  ].join(" ");
  const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", command], {
    cwd: serverDirectory,
    env: {
      EBB_HERMES_PRIVATE_FIXTURE_ROOT: directory,
    },
    encoding: "utf8",
    shell: false,
    timeout: WINDOWS_FIXTURE_ACL_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 4_096,
  });
  if (result.error) {
    if (result.error.code === "ETIMEDOUT") {
      const phases = [result.stderr, result.stdout].flatMap(readRecognizedPhases).filter((phase, index, all) => all.indexOf(phase) === index);
      throw new Error(`WINDOWS_FIXTURE_PRIVATE_CREATE_TIMEOUT:${WINDOWS_FIXTURE_ACL_TIMEOUT_MS}:phases=${phases.join(",") || "none"}`);
    }
    throw new Error(`WINDOWS_FIXTURE_PRIVATE_CREATE_SPAWN_FAILED:${result.error.code || "UNKNOWN"}`, { cause: result.error });
  }
  if (result.status !== 0) {
    const status = result.status === null ? "NO_EXIT_STATUS" : `EXIT_${result.status}`;
    const phases = [result.stderr, result.stdout].flatMap(readRecognizedPhases).filter((phase, index, all) => all.indexOf(phase) === index);
    throw new Error(`WINDOWS_FIXTURE_PRIVATE_CREATE_FAILED:${status}:phases=${phases.join(",") || "none"}`);
  }
  return directory;
}
