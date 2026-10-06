param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("compile-helper", "is-job-member", "probe-cpu", "read-creation", "terminate-exact")]
  [string] $Mode,

  [Parameter(Mandatory = $true)]
  [uint32] $ProcessId,

  [string] $ExpectedCreationTime,

  [string] $ContainmentId,

  [string] $AssemblyPath,

  [string] $DiagnosticPath
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Write-PhaseMarker([string] $Value) {
  if ([string]::IsNullOrWhiteSpace($DiagnosticPath)) { return }
  $allowed = @(
    "POWERSHELL_SCRIPT_STARTED", "ADD_TYPE_STARTED", "ADD_TYPE_COMPLETED",
    "ASSEMBLY_LOAD_STARTED", "ASSEMBLY_LOAD_COMPLETED",
    "OPEN_PROCESS_STARTED", "OPEN_PROCESS_RETURNED",
    "GET_PROCESS_TIMES_STARTED", "GET_PROCESS_TIMES_RETURNED"
  )
  if ($allowed -notcontains $Value) { return }
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value + [Environment]::NewLine)
    $stream = [System.IO.File]::Open($DiagnosticPath, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
    try {
      if ($stream.Length + $bytes.Length -le 4096) { $stream.Write($bytes, 0, $bytes.Length) }
    } finally { $stream.Dispose() }
  } catch { }
}

Write-PhaseMarker "POWERSHELL_SCRIPT_STARTED"

$nativeMethods = @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class EbbProcessScopeNative
{
    private const long MaxDiagnosticBytes = 4096;
    private const uint ProcessTerminate = 0x0001;
    private const uint ProcessQueryLimitedInformation = 0x1000;
    private const uint Synchronize = 0x00100000;
    private const uint JobObjectQuery = 0x0004;
    private const uint WaitObject0 = 0x00000000;
    private const uint WaitTimeout = 0x00000102;
    private const uint StillActive = 259;

    [StructLayout(LayoutKind.Sequential)]
    private struct FileTime
    {
        public uint Low;
        public uint High;
    }

    private static void WritePhaseMarker(string path, string phase)
    {
        if (String.IsNullOrEmpty(path)) return;
        try
        {
            byte[] bytes = Encoding.UTF8.GetBytes(phase + Environment.NewLine);
            using (FileStream stream = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite))
            {
                if (stream.Length + bytes.Length <= MaxDiagnosticBytes) stream.Write(bytes, 0, bytes.Length);
            }
        }
        catch { }
    }

    private static ulong FileTimeValue(FileTime value)
    {
        return ((ulong)value.High << 32) | value.Low;
    }

    private static string ExactProcessState(IntPtr process)
    {
        // The signaled handle distinguishes a real exit code 259 from STILL_ACTIVE.
        uint waitStatus = WaitForSingleObject(process, 0);
        if (waitStatus == WaitObject0) return "EXITED";
        if (waitStatus != WaitTimeout) return "UNAVAILABLE";
        uint exitCode;
        if (!GetExitCodeProcess(process, out exitCode)) return "UNAVAILABLE";
        return exitCode == StillActive ? "LIVE" : "EXITED";
    }

    public static string ProbeCpuActivity(uint processId, ulong expectedCreationTime)
    {
        IntPtr process = IntPtr.Zero;
        try
        {
            process = OpenProcess(ProcessQueryLimitedInformation | Synchronize, false, processId);
            if (process == IntPtr.Zero) return "UNAVAILABLE";

            string processState = ExactProcessState(process);
            if (processState != "LIVE") return processState;

            FileTime creation, exit, kernelBefore, userBefore;
            if (!GetProcessTimes(process, out creation, out exit, out kernelBefore, out userBefore))
                return ExactProcessState(process) == "EXITED" ? "EXITED" : "UNAVAILABLE";
            if (FileTimeValue(creation) != expectedCreationTime) return "IDENTITY_MISMATCH";

            System.Threading.Thread.Sleep(250);

            FileTime laterCreation, laterExit, kernelAfter, userAfter;
            if (!GetProcessTimes(process, out laterCreation, out laterExit, out kernelAfter, out userAfter))
                return ExactProcessState(process) == "EXITED" ? "EXITED" : "UNAVAILABLE";
            if (FileTimeValue(laterCreation) != expectedCreationTime) return "IDENTITY_MISMATCH";
            processState = ExactProcessState(process);
            if (processState != "LIVE") return processState;

            bool kernelAdvanced = FileTimeValue(kernelAfter) > FileTimeValue(kernelBefore);
            bool userAdvanced = FileTimeValue(userAfter) > FileTimeValue(userBefore);
            return kernelAdvanced || userAdvanced ? "LIVE_CPU_ADVANCED" : "LIVE_CPU_IDLE";
        }
        catch
        {
            return "UNAVAILABLE";
        }
        finally
        {
            if (process != IntPtr.Zero) CloseHandle(process);
        }
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern IntPtr OpenJobObjectW(uint access, bool inheritHandle, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(IntPtr process, out FileTime creation, out FileTime exit, out FileTime kernel, out FileTime user);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    public static ulong CreationTime(uint processId, string diagnosticPath)
    {
        WritePhaseMarker(diagnosticPath, "OPEN_PROCESS_STARTED");
        IntPtr process = OpenProcess(ProcessQueryLimitedInformation, false, processId);
        WritePhaseMarker(diagnosticPath, "OPEN_PROCESS_RETURNED");
        if (process == IntPtr.Zero) throw new InvalidOperationException("OPEN_PROCESS_FAILED:" + Marshal.GetLastWin32Error());
        try
        {
            FileTime creation, exit, kernel, user;
            WritePhaseMarker(diagnosticPath, "GET_PROCESS_TIMES_STARTED");
            if (!GetProcessTimes(process, out creation, out exit, out kernel, out user))
                throw new InvalidOperationException("GET_PROCESS_TIMES_FAILED:" + Marshal.GetLastWin32Error());
            WritePhaseMarker(diagnosticPath, "GET_PROCESS_TIMES_RETURNED");
            return ((ulong)creation.High << 32) | creation.Low;
        }
        finally { CloseHandle(process); }
    }

    public static bool IsJobMember(uint processId, string containmentId, ulong expectedCreationTime)
    {
        IntPtr process = OpenProcess(ProcessQueryLimitedInformation, false, processId);
        if (process == IntPtr.Zero) throw new InvalidOperationException("OPEN_PROCESS_FAILED:" + Marshal.GetLastWin32Error());
        try
        {
            FileTime creation, exit, kernel, user;
            if (!GetProcessTimes(process, out creation, out exit, out kernel, out user))
                throw new InvalidOperationException("GET_PROCESS_TIMES_FAILED:" + Marshal.GetLastWin32Error());
            ulong actualCreationTime = ((ulong)creation.High << 32) | creation.Low;
            if (actualCreationTime != expectedCreationTime)
                throw new InvalidOperationException("PROCESS_CREATION_IDENTITY_MISMATCH");

            IntPtr job = OpenJobObjectW(JobObjectQuery, false, @"Local\ebb-orchestrator-run-" + containmentId);
            if (job == IntPtr.Zero) throw new InvalidOperationException("OPEN_JOB_FAILED:" + Marshal.GetLastWin32Error());
            try
            {
                bool member;
                if (!IsProcessInJob(process, job, out member))
                    throw new InvalidOperationException("IS_PROCESS_IN_JOB_FAILED:" + Marshal.GetLastWin32Error());
                return member;
            }
            finally { CloseHandle(job); }
        }
        finally { CloseHandle(process); }
    }

    public static void TerminateExact(uint processId, ulong expectedCreationTime)
    {
        IntPtr process = OpenProcess(ProcessQueryLimitedInformation | ProcessTerminate | Synchronize, false, processId);
        if (process == IntPtr.Zero) throw new InvalidOperationException("OPEN_PROCESS_FAILED:" + Marshal.GetLastWin32Error());
        try
        {
            FileTime creation, exit, kernel, user;
            if (!GetProcessTimes(process, out creation, out exit, out kernel, out user))
                throw new InvalidOperationException("GET_PROCESS_TIMES_FAILED:" + Marshal.GetLastWin32Error());
            ulong actualCreationTime = ((ulong)creation.High << 32) | creation.Low;
            if (actualCreationTime != expectedCreationTime)
                throw new InvalidOperationException("PROCESS_CREATION_IDENTITY_MISMATCH");
            if (!TerminateProcess(process, 137))
                throw new InvalidOperationException("TERMINATE_EXACT_PROCESS_FAILED:" + Marshal.GetLastWin32Error());
            if (WaitForSingleObject(process, 10000) != WaitObject0)
                throw new InvalidOperationException("TERMINATE_EXACT_PROCESS_WAIT_FAILED");
        }
        finally { CloseHandle(process); }
    }
}
'@

try {
  if ($Mode -eq "compile-helper") {
    if ([string]::IsNullOrWhiteSpace($AssemblyPath)) { throw "NATIVE_HELPER_ASSEMBLY_PATH_REQUIRED" }
    $resolvedAssemblyPath = [System.IO.Path]::GetFullPath($AssemblyPath)
    $assemblyDirectory = [System.IO.Path]::GetDirectoryName($resolvedAssemblyPath)
    if ([string]::IsNullOrWhiteSpace($assemblyDirectory) -or -not [System.IO.Directory]::Exists($assemblyDirectory)) {
      throw "NATIVE_HELPER_ASSEMBLY_DIRECTORY_MISSING"
    }
    Write-PhaseMarker "ADD_TYPE_STARTED"
    Add-Type -TypeDefinition $nativeMethods -OutputAssembly $resolvedAssemblyPath
    if (-not [System.IO.File]::Exists($resolvedAssemblyPath)) { throw "NATIVE_HELPER_ASSEMBLY_NOT_CREATED" }
    Write-PhaseMarker "ADD_TYPE_COMPLETED"
    [Console]::Out.WriteLine("NATIVE_HELPER_COMPILED")
    return
  }

  if ([string]::IsNullOrWhiteSpace($AssemblyPath) -or -not [System.IO.File]::Exists($AssemblyPath)) {
    throw "NATIVE_HELPER_ASSEMBLY_MISSING"
  }
  $resolvedAssemblyPath = [System.IO.Path]::GetFullPath($AssemblyPath)
  Write-PhaseMarker "ASSEMBLY_LOAD_STARTED"
  Add-Type -Path $resolvedAssemblyPath
  Write-PhaseMarker "ASSEMBLY_LOAD_COMPLETED"

  switch ($Mode) {
    "read-creation" {
      $creationTime = [EbbProcessScopeNative]::CreationTime($ProcessId, $DiagnosticPath)
      [Console]::Out.WriteLine("PROCESS_CREATION_IDENTITY=" + $creationTime.ToString([Globalization.CultureInfo]::InvariantCulture))
    }
    "probe-cpu" {
      $probeResult = "UNAVAILABLE"
      if ($ExpectedCreationTime -match '^[1-9][0-9]*$') {
        try {
          $expected = [UInt64]::Parse($ExpectedCreationTime, [Globalization.CultureInfo]::InvariantCulture)
          $probeResult = [EbbProcessScopeNative]::ProbeCpuActivity($ProcessId, $expected)
        } catch { $probeResult = "UNAVAILABLE" }
      }
      if (@("LIVE_CPU_ADVANCED", "LIVE_CPU_IDLE", "EXITED", "IDENTITY_MISMATCH", "UNAVAILABLE") -notcontains $probeResult) {
        $probeResult = "UNAVAILABLE"
      }
      [Console]::Out.WriteLine($probeResult)
    }
    "is-job-member" {
      if (-not $ContainmentId -or $ContainmentId -notmatch '^[a-f0-9]{64}$') {
        throw "CONTAINMENT_ID_INVALID"
      }
      if ($ExpectedCreationTime -notmatch '^[1-9][0-9]*$') { throw "PROCESS_CREATION_IDENTITY_INVALID" }
      $expected = [UInt64]::Parse($ExpectedCreationTime, [Globalization.CultureInfo]::InvariantCulture)
      if (-not [EbbProcessScopeNative]::IsJobMember($ProcessId, $ContainmentId, $expected)) {
        throw "DESCENDANT_NOT_IN_NAMED_JOB"
      }
      [Console]::Out.WriteLine("EXACT_PROCESS_JOB_MEMBERSHIP_CONFIRMED")
    }
    "terminate-exact" {
      if ($ExpectedCreationTime -notmatch '^[1-9][0-9]*$') { throw "PROCESS_CREATION_IDENTITY_INVALID" }
      $expected = [UInt64]::Parse($ExpectedCreationTime, [Globalization.CultureInfo]::InvariantCulture)
      [EbbProcessScopeNative]::TerminateExact($ProcessId, $expected)
      [Console]::Out.WriteLine("EXACT_PROCESS_TERMINATED")
    }
  }
} catch {
  if ($Mode -eq "probe-cpu") {
    [Console]::Out.WriteLine("UNAVAILABLE")
    exit 0
  }
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
