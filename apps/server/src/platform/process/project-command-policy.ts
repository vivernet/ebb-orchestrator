const directShellNames = new Set([
  "ash", "bash", "bosh", "csh", "dash", "elvish", "fish", "ksh", "mksh", "nu", "oksh", "osh", "pdksh", "powershell", "pwsh", "rc", "sh", "tcsh", "xonsh", "yash", "zsh",
  "cmd", "command.com",
]);

const shellLauncherNames = new Set(["busybox", "env", "wsl"]);

/** Отклоняет известные executable shell и распространённые launcher-ы, способные запустить shell. */
export function isDisallowedProjectCommandExecutable(executable: string): boolean {
  const executableName = executable.split(/[\\/]/u).at(-1)?.toLocaleLowerCase("en-US").replace(/\.exe$/u, "");
  return executableName !== undefined && (directShellNames.has(executableName) || shellLauncherNames.has(executableName));
}
