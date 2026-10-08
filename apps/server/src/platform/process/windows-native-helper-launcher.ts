import path from "node:path";
import process from "node:process";
import { gzipSync } from "node:zlib";
import { getNativeHelperIntegrityDigest, type NativeHelperAnchorName } from "./native-helper-integrity.js";

export interface WindowsNativeHelperInvocation {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

const WINDOWS_NATIVE_HELPER_GATE_SOURCE = String.raw`
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;
public static class EbbNativeHelperGate {
  [StructLayout(LayoutKind.Sequential)] private struct JOB_OBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] private struct IO_COUNTERS {
    public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount;
    public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)] private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOB_OBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential)] private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
    public long TotalUserTime; public long TotalKernelTime; public long ThisPeriodTotalUserTime; public long ThisPeriodTotalKernelTime;
    public uint TotalPageFaultCount; public uint TotalProcesses; public uint ActiveProcesses; public uint TotalTerminatedProcesses;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct STARTUPINFO {
    public int cb;
    [MarshalAs(UnmanagedType.LPWStr)] public string lpReserved;
    [MarshalAs(UnmanagedType.LPWStr)] public string lpDesktop;
    [MarshalAs(UnmanagedType.LPWStr)] public string lpTitle;
    public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public ushort wShowWindow, cbReserved2;
    public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct STARTUPINFOEX {
    public STARTUPINFO StartupInfo;
    public IntPtr lpAttributeList;
  }
  [StructLayout(LayoutKind.Sequential)] private struct PROCESS_INFORMATION {
    public IntPtr hProcess, hThread;
    public uint dwProcessId, dwThreadId;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint size);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info, uint size, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, UIntPtr size, IntPtr previous, IntPtr returnedSize);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateProcessW(string application, System.Text.StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory, ref STARTUPINFOEX startupInfo, out PROCESS_INFORMATION information);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GetStdHandle(int identifier);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetHandleInformation(IntPtr handle, out uint flags);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  public static IntPtr CreateKillOnCloseJob() {
    IntPtr job = CreateJobObjectW(IntPtr.Zero, null); if (job == IntPtr.Zero) return IntPtr.Zero;
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    info.BasicLimitInformation.LimitFlags = 0x00002000;
    if (SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)))) return job;
    CloseHandle(job); return IntPtr.Zero;
  }
  public static bool AssignInspectionProcess(IntPtr job, IntPtr process) { return job != IntPtr.Zero && process != IntPtr.Zero && AssignProcessToJobObject(job, process); }
  public static bool CreateAndResumeInspectionProcess(string executable, string arguments, IntPtr job, out IntPtr process) {
    process = IntPtr.Zero;
    IntPtr size = IntPtr.Zero, attributeList = IntPtr.Zero, jobValue = IntPtr.Zero, handleValues = IntPtr.Zero;
    IntPtr stdin = GetStdHandle(-10), stdout = GetStdHandle(-11), stderr = GetStdHandle(-12);
    uint stdinFlags = 0, stdoutFlags = 0, stderrFlags = 0;
    bool restoreStdin = false, restoreStdout = false, restoreStderr = false, attributesInitialized = false;
    PROCESS_INFORMATION created = new PROCESS_INFORMATION();
    try {
      if (job == IntPtr.Zero || stdin == IntPtr.Zero || stdout == IntPtr.Zero || stderr == IntPtr.Zero ||
          stdin == new IntPtr(-1) || stdout == new IntPtr(-1) || stderr == new IntPtr(-1)) return false;
      if (!GetHandleInformation(stdin, out stdinFlags) || !GetHandleInformation(stdout, out stdoutFlags) || !GetHandleInformation(stderr, out stderrFlags)) return false;
      if ((stdinFlags & 1) == 0) { if (!SetHandleInformation(stdin, 1, 1)) return false; restoreStdin = true; }
      if ((stdoutFlags & 1) == 0) { if (!SetHandleInformation(stdout, 1, 1)) return false; restoreStdout = true; }
      if ((stderrFlags & 1) == 0) { if (!SetHandleInformation(stderr, 1, 1)) return false; restoreStderr = true; }
      InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
      if (size == IntPtr.Zero) return false;
      attributeList = Marshal.AllocHGlobal(size);
      if (!InitializeProcThreadAttributeList(attributeList, 2, 0, ref size)) return false;
      attributesInitialized = true;
      jobValue = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobValue, job);
      handleValues = Marshal.AllocHGlobal(IntPtr.Size * 3);
      Marshal.WriteIntPtr(handleValues, 0, stdin); Marshal.WriteIntPtr(handleValues, IntPtr.Size, stdout); Marshal.WriteIntPtr(handleValues, IntPtr.Size * 2, stderr);
      if (!UpdateProcThreadAttribute(attributeList, 0, new IntPtr(0x0002000D), jobValue, (UIntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero) ||
          !UpdateProcThreadAttribute(attributeList, 0, new IntPtr(0x00020002), handleValues, (UIntPtr)(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero)) return false;
      STARTUPINFOEX startup = new STARTUPINFOEX();
      startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
      startup.StartupInfo.dwFlags = 0x00000100;
      startup.StartupInfo.hStdInput = stdin; startup.StartupInfo.hStdOutput = stdout; startup.StartupInfo.hStdError = stderr;
      startup.lpAttributeList = attributeList;
      System.Text.StringBuilder commandLine = new System.Text.StringBuilder(arguments);
      if (!CreateProcessW(executable, commandLine, IntPtr.Zero, IntPtr.Zero, true, 0x00080004, IntPtr.Zero, null, ref startup, out created)) return false;
      if (ResumeThread(created.hThread) != 1) {
        process = created.hProcess;
        created.hProcess = IntPtr.Zero;
        return false;
      }
      process = created.hProcess;
      created.hProcess = IntPtr.Zero;
      return true;
    } finally {
      if (created.hThread != IntPtr.Zero) CloseHandle(created.hThread);
      if (created.hProcess != IntPtr.Zero) CloseHandle(created.hProcess);
      if (attributeList != IntPtr.Zero) { if (attributesInitialized) DeleteProcThreadAttributeList(attributeList); Marshal.FreeHGlobal(attributeList); }
      if (jobValue != IntPtr.Zero) Marshal.FreeHGlobal(jobValue);
      if (handleValues != IntPtr.Zero) Marshal.FreeHGlobal(handleValues);
      if (restoreStdin) SetHandleInformation(stdin, 1, stdinFlags & 1);
      if (restoreStdout) SetHandleInformation(stdout, 1, stdoutFlags & 1);
      if (restoreStderr) SetHandleInformation(stderr, 1, stderrFlags & 1);
    }
  }
  public static bool WaitForInspectionProcess(IntPtr process, int timeoutMilliseconds) {
    return process != IntPtr.Zero && WaitForSingleObject(process, (uint)timeoutMilliseconds) == 0;
  }
  public static int InspectionProcessExitCode(IntPtr process) {
    uint exitCode; return process != IntPtr.Zero && GetExitCodeProcess(process, out exitCode) ? (int)exitCode : -1;
  }
  public static bool CloseInspectionProcess(IntPtr process) { return process == IntPtr.Zero || CloseHandle(process); }
  public static bool TerminateInspectionJob(IntPtr job) { return job != IntPtr.Zero && TerminateJobObject(job, 126); }
  public static int InspectionJobActiveProcessCount(IntPtr job) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info;
    if (job == IntPtr.Zero || !QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)), IntPtr.Zero)) return -1;
    return info.ActiveProcesses > Int32.MaxValue ? -1 : (int)info.ActiveProcesses;
  }
  public static bool WaitForInspectionJobEmpty(IntPtr job, int timeoutMilliseconds) {
    DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMilliseconds);
    do { int active = InspectionJobActiveProcessCount(job); if (active < 0) return false; if (active == 0) return true; System.Threading.Thread.Sleep(25); }
    while (DateTime.UtcNow < deadline);
    return InspectionJobActiveProcessCount(job) == 0;
  }
  public static bool CloseInspectionJob(IntPtr job) { return job == IntPtr.Zero || CloseHandle(job); }
  public static async Task RelayStandardInput(Stream source, Stream destination) {
    try { byte[] buffer = new byte[81920]; int count; while ((count = await source.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false)) != 0) { await destination.WriteAsync(buffer, 0, count).ConfigureAwait(false); await destination.FlushAsync().ConfigureAwait(false); } }
    finally { destination.Close(); }
  }
  [StructLayout(LayoutKind.Sequential)] private struct FILE_ATTRIBUTE_TAG_INFO { public uint FileAttributes; public uint ReparseTag; }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int infoClass, out FILE_ATTRIBUTE_TAG_INFO info, uint size);
  public static int LastErrorCode() { return Marshal.GetLastWin32Error(); }
  public static SafeFileHandle OpenLockedRegularFile(string path) { return CreateFileW(path, 0x80000080, 0x00000001, IntPtr.Zero, 3, 0x00200000 | 0x08000000, IntPtr.Zero); }
  public static SafeFileHandle OpenLockedDirectory(string path) { return CreateFileW(path, 0x00000080, 0x00000003, IntPtr.Zero, 3, 0x00200000 | 0x02000000, IntPtr.Zero); }
  public static bool IsRegularNonReparseFile(SafeFileHandle handle) { FILE_ATTRIBUTE_TAG_INFO info; if (!GetFileInformationByHandleEx(handle, 9, out info, 8)) return false; return (info.FileAttributes & (0x00000010 | 0x00000400 | 0x00000040)) == 0; }
  public static bool IsDirectoryNonReparse(SafeFileHandle handle) { FILE_ATTRIBUTE_TAG_INFO info; if (!GetFileInformationByHandleEx(handle, 9, out info, 8)) return false; return (info.FileAttributes & 0x00000010) != 0 && (info.FileAttributes & 0x00000400) == 0; }
}
`;

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
  const boundedInspection = anchorName === "windowsRunSupervisor" && helperArgs[0] === "inspect";
  const script = windowsHelperGateScript(pathLiteral, digest, argsLiteral, boundedInspection);
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

function windowsHelperGateScript(helperPathBase64: string, expectedDigest: string, argsBase64: string, boundedInspection: boolean): string {
  const gateSourceCompressed = gzipSync(Buffer.from(WINDOWS_NATIVE_HELPER_GATE_SOURCE, "utf8")).toString("base64");
  const expandedScript = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$exitCode = 126
$phase = 'argument-decode'
$gateSourceBytes = [Convert]::FromBase64String('${gateSourceCompressed}')
$gateSourceInput = [System.IO.MemoryStream]::new($gateSourceBytes)
$gateSourceGzip = [System.IO.Compression.GZipStream]::new($gateSourceInput, [System.IO.Compression.CompressionMode]::Decompress)
$gateSourceReader = [System.IO.StreamReader]::new($gateSourceGzip, [System.Text.Encoding]::UTF8)
$gateSource = $gateSourceReader.ReadToEnd()
$gateSourceReader.Dispose()
$gateSourceGzip.Dispose()
$gateSourceInput.Dispose()
$directoryHandles = [System.Collections.Generic.List[Microsoft.Win32.SafeHandles.SafeFileHandle]]::new()
$stream = $null
$sha = $null
$inspectionJob = [IntPtr]::Zero
$inspectionProcess = [IntPtr]::Zero
$child = $null
$inspectionAssigned = $false
$failurePhase = $null
$failureType = $null
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
  $boundedInspection = ${boundedInspection ? "$true" : "$false"}
  if ($boundedInspection) {
    $phase = 'inspection-job-create'
    $inspectionJob = [EbbNativeHelperGate]::CreateKillOnCloseJob()
    if ($inspectionJob -eq [IntPtr]::Zero) { throw [System.InvalidOperationException]::new('Inspection Job setup failed') }
  }
  if ($boundedInspection) {
    $phase = 'inspection-process-create'
    $inspectionCommandLine = (& $quote $helperPath) + ' ' + $arguments
    if (-not [EbbNativeHelperGate]::CreateAndResumeInspectionProcess($helperPath, $inspectionCommandLine, $inspectionJob, [ref]$inspectionProcess)) {
      if ($inspectionProcess -ne [IntPtr]::Zero) {
        $inspectionAssigned = $true
        $phase = 'inspection-resume'
      }
      throw [System.InvalidOperationException]::new('Inspection process could not be started in its Job')
    }
    $inspectionAssigned = $true
    $stream.Dispose()
    $sha.Dispose()
    $phase = 'inspection-wait'
    if (-not [EbbNativeHelperGate]::WaitForInspectionProcess($inspectionProcess, 10000)) {
      $phase = 'inspection-timeout'
      if (-not [EbbNativeHelperGate]::TerminateInspectionJob($inspectionJob)) {
        $phase = 'inspection-cleanup-unproven'
        throw [System.InvalidOperationException]::new('Inspection Job termination failed')
      }
      if (-not [EbbNativeHelperGate]::WaitForInspectionProcess($inspectionProcess, 5000) -or -not [EbbNativeHelperGate]::WaitForInspectionJobEmpty($inspectionJob, 5000)) {
        $phase = 'inspection-cleanup-unproven'
        throw [System.InvalidOperationException]::new('Inspection helper termination could not be verified')
      }
      $phase = 'inspection-timeout'
      throw [System.TimeoutException]::new('Inspection helper exceeded its bounded deadline')
    } else {
      if (-not [EbbNativeHelperGate]::WaitForInspectionJobEmpty($inspectionJob, 5000)) {
        $phase = 'inspection-cleanup-unproven'
        throw [System.InvalidOperationException]::new('Inspection Job became empty could not be verified')
      }
      $exitCode = [EbbNativeHelperGate]::InspectionProcessExitCode($inspectionProcess)
      if ($exitCode -lt 0) { $phase = 'inspection-cleanup-unproven'; throw [System.InvalidOperationException]::new('Inspection exit status unavailable') }
    }
  } else {
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
    $exitCode = $child.ExitCode
    try { $child.StandardInput.Close() } catch { }
    try { [void]$stdoutTask.GetAwaiter().GetResult() } catch { }
    try { [void]$stderrTask.GetAwaiter().GetResult() } catch { }
  }
} catch {
  $failurePhase = $phase
  $failureType = $_.Exception.GetType().Name
  $exitCode = 126
}
finally {
  if ($stream) { $stream.Dispose() }
  if ($sha) { $sha.Dispose() }
  if ($inspectionJob -ne [IntPtr]::Zero) {
    $processStopped = $true
    if ($inspectionAssigned -and $inspectionProcess -ne [IntPtr]::Zero -and -not [EbbNativeHelperGate]::WaitForInspectionProcess($inspectionProcess, 0)) {
      [void][EbbNativeHelperGate]::TerminateInspectionJob($inspectionJob)
      $processStopped = [EbbNativeHelperGate]::WaitForInspectionProcess($inspectionProcess, 5000)
    }
    [void][EbbNativeHelperGate]::CloseInspectionProcess($inspectionProcess)
    $jobEmpty = -not $inspectionAssigned -or [EbbNativeHelperGate]::WaitForInspectionJobEmpty($inspectionJob, 5000)
    if (-not $processStopped -or -not $jobEmpty) {
      $failurePhase = 'inspection-cleanup-unproven'
      $failureType = 'InvalidOperationException'
      $exitCode = 126
    }
    [void][EbbNativeHelperGate]::CloseInspectionJob($inspectionJob)
  }
  foreach ($directoryHandle in $directoryHandles) { $directoryHandle.Dispose() }
}
if ($failurePhase) { [Console]::Error.WriteLine('NATIVE_HELPER_GATE_FAIL:' + $failurePhase + ':' + $failureType) }
exit $exitCode
`;
  const compressedScript = gzipSync(Buffer.from(expandedScript, "utf8")).toString("base64");
  return String.raw`$scriptBytes = [Convert]::FromBase64String('${compressedScript}')
$scriptInput = [System.IO.MemoryStream]::new($scriptBytes)
$scriptGzip = [System.IO.Compression.GZipStream]::new($scriptInput, [System.IO.Compression.CompressionMode]::Decompress)
$scriptReader = [System.IO.StreamReader]::new($scriptGzip, [System.Text.Encoding]::UTF8)
$expandedScript = $scriptReader.ReadToEnd()
$scriptReader.Dispose()
$scriptGzip.Dispose()
$scriptInput.Dispose()
& ([System.Management.Automation.ScriptBlock]::Create($expandedScript))`;
}
