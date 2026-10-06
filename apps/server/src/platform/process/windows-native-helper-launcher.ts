import path from "node:path";
import process from "node:process";
import { getNativeHelperIntegrityDigest, type NativeHelperAnchorName } from "./native-helper-integrity.js";

export interface WindowsNativeHelperInvocation {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Создаёт invocation доверенного PowerShell gate. Gate открывает helper без перехода
 * через reparse points, проверяет digest открытого handle по anchor родительского кода,
 * запрещает замену файла и запускает тот же path, удерживая handle до запуска.
 * Предварительная проверка digest по path не разрешает запуск.
 * Бинарный stdin передаётся с flush каждого chunk; EOF закрывает stdin helper до ожидания exit.
 *
 * @param helperPath Абсолютный path упакованного helper.
 * @param anchorName Ключ digest, встроенного в сгенерированный код родительского runtime.
 * @param helperArgs Точный argv helper; кодируется как данные и получает Windows quoting внутри gate.
 * @returns Абсолютный path PowerShell, закодированный script и минимальное Windows environment.
 * @throws {Error} Если trusted anchor или SystemRoot недоступны либо path или argv некорректны.
 */
export async function createWindowsNativeHelperInvocation(
  helperPath: string,
  anchorName: NativeHelperAnchorName,
  helperArgs: readonly string[],
): Promise<WindowsNativeHelperInvocation> {
  if (!path.win32.isAbsolute(helperPath) || helperArgs.length === 0 ||
      helperArgs.some((argument) => typeof argument !== "string" || argument.includes("\0"))) {
    throw new Error("NATIVE_HELPER_LAUNCH_INPUT_INVALID");
  }
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) throw new Error("NATIVE_HELPER_GATE_UNAVAILABLE");
  const powershell = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const digest = await getNativeHelperIntegrityDigest(anchorName);
  const pathLiteral = Buffer.from(helperPath, "utf8").toString("base64");
  const argsLiteral = Buffer.from(JSON.stringify(helperArgs), "utf8").toString("base64");
  const script = windowsHelperGateScript(pathLiteral, digest, argsLiteral);
  const env: Record<string, string> = {};
  for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "PATH", "TEMP", "TMP"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return Object.freeze({
    file: powershell,
    args: Object.freeze(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]),
    env: Object.freeze(env),
  });
}

function windowsHelperGateScript(helperPathBase64: string, expectedDigest: string, argsBase64: string): string {
  return String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$exitCode = 126
$phase = 'argument-decode'
$gateSource = @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;
public static class EbbNativeHelperGate {
  // Передаёт бинарные chunks сразу: короткий ACK не должен ждать следующего write или EOF.
  public static async Task RelayStandardInput(Stream source, Stream destination) {
    try {
      byte[] buffer = new byte[81920];
      int count;
      while ((count = await source.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false)) != 0) {
        await destination.WriteAsync(buffer, 0, count).ConfigureAwait(false);
        await destination.FlushAsync().ConfigureAwait(false);
      }
    } finally {
      // EOF передаётся до WaitForExit, включая helpers, завершающиеся только после закрытия stdin.
      destination.Close();
    }
  }
  [StructLayout(LayoutKind.Sequential)] private struct FILE_ATTRIBUTE_TAG_INFO {
    public uint FileAttributes;
    public uint ReparseTag;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security,
    uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int infoClass,
    out FILE_ATTRIBUTE_TAG_INFO info, uint size);
  public static int LastErrorCode() { return Marshal.GetLastWin32Error(); }
  public static SafeFileHandle OpenLockedRegularFile(string path) {
    return CreateFileW(path, 0x80000080, 0x00000001, IntPtr.Zero, 3, 0x00200000 | 0x08000000, IntPtr.Zero);
  }
  public static SafeFileHandle OpenLockedDirectory(string path) {
    return CreateFileW(path, 0x00000080, 0x00000003, IntPtr.Zero, 3, 0x00200000 | 0x02000000, IntPtr.Zero);
  }
  public static bool IsRegularNonReparseFile(SafeFileHandle handle) {
    FILE_ATTRIBUTE_TAG_INFO info;
    if (!GetFileInformationByHandleEx(handle, 9, out info, 8)) return false;
    return (info.FileAttributes & (0x00000010 | 0x00000400 | 0x00000040)) == 0;
  }
  public static bool IsDirectoryNonReparse(SafeFileHandle handle) {
    FILE_ATTRIBUTE_TAG_INFO info;
    if (!GetFileInformationByHandleEx(handle, 9, out info, 8)) return false;
    return (info.FileAttributes & 0x00000010) != 0 && (info.FileAttributes & 0x00000400) == 0;
  }
}
'@
$directoryHandles = [System.Collections.Generic.List[Microsoft.Win32.SafeHandles.SafeFileHandle]]::new()
$stream = $null
$sha = $null
try {
  Add-Type -TypeDefinition $gateSource -ErrorAction Stop | Out-Null
  Add-Type -AssemblyName System.Web.Extensions -ErrorAction Stop
  $encoding = [System.Text.Encoding]::UTF8
  $helperPath = $encoding.GetString([Convert]::FromBase64String('${helperPathBase64}'))
  $phase = 'argument-json'
  $argsJson = $encoding.GetString([Convert]::FromBase64String('${argsBase64}'))
  $serializer = [System.Web.Script.Serialization.JavaScriptSerializer]::new()
  $helperArgs = $serializer.DeserializeObject($argsJson)
  if ($helperArgs -isnot [Array]) { throw [System.InvalidOperationException]::new('Helper arguments must be a JSON array') }
  $phase = 'argument-validation'
  if ($helperArgs.Count -eq 0 -or $helperArgs.Count -gt 32) { throw [System.InvalidOperationException]::new('Invalid helper argument count') }
  foreach ($argument in $helperArgs) {
    if ($argument -isnot [string]) { $phase = 'argument-type'; throw [System.InvalidOperationException]::new('Invalid helper argument type') }
    if ($argument.Contains([char]0)) { $phase = 'argument-nul'; throw [System.InvalidOperationException]::new('Invalid helper argument') }
  }
  $phase = 'path-normalization'
  $fullHelperPath = [System.IO.Path]::GetFullPath($helperPath)
  $root = [System.IO.Path]::GetPathRoot($fullHelperPath)
  if ($root -notmatch '^[A-Za-z]:\\$' -or -not [string]::Equals($fullHelperPath, $helperPath, [StringComparison]::OrdinalIgnoreCase)) { throw [System.InvalidOperationException]::new('Unsafe absolute helper path') }
  $parts = $fullHelperPath.Substring($root.Length).Split([char[]]@(92, 47), [StringSplitOptions]::RemoveEmptyEntries)
  if ($parts.Length -lt 2) { throw [System.InvalidOperationException]::new('Helper path has no parent directory') }
  $directoryPath = $root
  $phase = 'parent-directory-lock'
  for ($index = 0; $index -lt $parts.Length; $index++) {
    $directoryPath = [System.IO.Path]::Combine($directoryPath, $parts[$index])
    if ($index -eq ($parts.Length - 1)) { break }
    $directoryHandle = [EbbNativeHelperGate]::OpenLockedDirectory($directoryPath)
    if ($null -eq $directoryHandle -or $directoryHandle.IsInvalid) {
      $phase = 'parent-directory-open-index-' + $index + '-win32-' + [EbbNativeHelperGate]::LastErrorCode()
      throw [System.InvalidOperationException]::new('Helper parent directory open failed')
    }
    if (-not [EbbNativeHelperGate]::IsDirectoryNonReparse($directoryHandle)) {
      $phase = 'parent-directory-check-win32-' + [EbbNativeHelperGate]::LastErrorCode()
      throw [System.InvalidOperationException]::new('Helper parent directory check failed')
    }
    $directoryHandles.Add($directoryHandle)
  }
  $phase = 'helper-file-lock'
  $handle = [EbbNativeHelperGate]::OpenLockedRegularFile($helperPath)
  if ($null -eq $handle -or $handle.IsInvalid) {
    $phase = 'helper-file-open-win32-' + [EbbNativeHelperGate]::LastErrorCode()
    throw [System.InvalidOperationException]::new('Helper file open failed')
  }
  if (-not [EbbNativeHelperGate]::IsRegularNonReparseFile($handle)) { throw [System.InvalidOperationException]::new('Unsafe helper file') }
  $phase = 'integrity-check'
  $stream = [System.IO.FileStream]::new($handle, [System.IO.FileAccess]::Read)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $actual = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
  if ($actual -cne '${expectedDigest}') { exit 127 }
  $phase = 'process-start'
  $stream.Position = 0
  $quote = { param([string]$value)
    if ($value.Length -gt 0 -and $value -notmatch '[\s"]') { return $value }
    $builder = [System.Text.StringBuilder]::new()
    [void]$builder.Append('"')
    $slashes = 0
    foreach ($character in $value.ToCharArray()) {
      if ($character -eq '\') { $slashes++; continue }
      if ($character -eq '"') {
        [void]$builder.Append(('\' * ($slashes * 2 + 1)))
        [void]$builder.Append($character)
        $slashes = 0
        continue
      }
      if ($slashes -gt 0) { [void]$builder.Append(('\' * $slashes)); $slashes = 0 }
      [void]$builder.Append($character)
    }
    if ($slashes -gt 0) { [void]$builder.Append(('\' * ($slashes * 2))) }
    [void]$builder.Append('"')
    return $builder.ToString()
  }
  $arguments = (@($helperArgs | ForEach-Object { & $quote $_ }) -join ' ')
  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $helperPath
  $startInfo.Arguments = $arguments
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $child = [System.Diagnostics.Process]::new()
  $child.StartInfo = $startInfo
  if (-not $child.Start()) { throw [System.InvalidOperationException]::new('Helper process start failed') }
  $stream.Dispose()
  $sha.Dispose()
  $stdinTask = [EbbNativeHelperGate]::RelayStandardInput([Console]::OpenStandardInput(), $child.StandardInput.BaseStream)
  $stdoutTask = $child.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput())
  $stderrTask = $child.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())
  $child.WaitForExit()
  try { $child.StandardInput.Close() } catch { }
  try { [void]$stdoutTask.GetAwaiter().GetResult() } catch { }
  try { [void]$stderrTask.GetAwaiter().GetResult() } catch { }
  $exitCode = $child.ExitCode
} catch {
  [Console]::Error.WriteLine('NATIVE_HELPER_GATE_FAIL:' + $phase + ':' + $_.Exception.GetType().Name)
  $exitCode = 126
}
finally {
  if ($stream) { $stream.Dispose() }
  if ($sha) { $sha.Dispose() }
  foreach ($directoryHandle in $directoryHandles) { $directoryHandle.Dispose() }
}
exit $exitCode
`;
}
