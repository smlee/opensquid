param(
  [Parameter(Mandatory = $true)][string]$JobName,
  [Parameter(Mandatory = $true)][ValidateSet('terminate', 'force_kill')][string]$Action,
  [Parameter(Mandatory = $true)][string]$MetadataPath
)
$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class OpenSquidJobControl {
    const uint JOB_OBJECT_QUERY = 0x0004;
    const uint JOB_OBJECT_TERMINATE = 0x0008;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr OpenJobObject(uint access, bool inherit, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);

    static void Check(bool ok, string operation) {
        if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }

    public static void Run(string jobName, string action, uint targetPid) {
        IntPtr job = OpenJobObject(JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE, false, jobName);
        if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenJobObject");
        try {
            // Windows has no POSIX SIGTERM for an arbitrary detached tree. Both explicit human OS actions
            // therefore target the exact owned Job Object; the distinct exit code preserves terminate vs kill
            // in process/audit state while guaranteeing that no descendant escapes either action.
            uint exitCode = action == "force_kill" ? 137u : 143u;
            Check(TerminateJobObject(job, exitCode), "TerminateJobObject");
        } finally {
            CloseHandle(job);
        }
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp
$metadata = Get-Content -Raw -LiteralPath $MetadataPath | ConvertFrom-Json
if ($metadata.jobName -ne $JobName) { throw 'Windows Job Object metadata identity mismatch' }
[OpenSquidJobControl]::Run($JobName, $Action, [uint32]$metadata.targetPid)
