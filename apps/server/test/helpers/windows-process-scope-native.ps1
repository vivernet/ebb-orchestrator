param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("is-job-member", "read-creation", "terminate-exact")]
  [string] $Mode,

  [Parameter(Mandatory = $true)]
  [uint32] $ProcessId,

  [string] $ExpectedCreationTime,

  [string] $ContainmentId
)

$ErrorActionPreference = "Stop"

$nativeMethods = @'
using System;
using System.Runtime.InteropServices;

public static class EbbProcessScopeNative
{
    private const uint ProcessTerminate = 0x0001;
    private const uint ProcessQueryLimitedInformation = 0x1000;
    private const uint Synchronize = 0x00100000;
    private const uint JobObjectQuery = 0x0004;
    private const uint WaitObject0 = 0x00000000;

    [StructLayout(LayoutKind.Sequential)]
    private struct FileTime
    {
        public uint Low;
        public uint High;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern IntPtr OpenJobObjectW(uint access, bool inheritHandle, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(IntPtr process, out FileTime creation, out FileTime exit, out FileTime kernel, out FileTime user);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    public static ulong CreationTime(uint processId)
    {
        IntPtr process = OpenProcess(ProcessQueryLimitedInformation, false, processId);
        if (process == IntPtr.Zero) throw new InvalidOperationException("OPEN_PROCESS_FAILED:" + Marshal.GetLastWin32Error());
        try
        {
            FileTime creation, exit, kernel, user;
            if (!GetProcessTimes(process, out creation, out exit, out kernel, out user))
                throw new InvalidOperationException("GET_PROCESS_TIMES_FAILED:" + Marshal.GetLastWin32Error());
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
  Add-Type -TypeDefinition $nativeMethods

  switch ($Mode) {
    "read-creation" {
      $creationTime = [EbbProcessScopeNative]::CreationTime($ProcessId)
      [Console]::Out.WriteLine("PROCESS_CREATION_IDENTITY=" + $creationTime.ToString([Globalization.CultureInfo]::InvariantCulture))
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
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
