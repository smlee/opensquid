$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class OpenSquidJobBroker {
    const uint CREATE_SUSPENDED = 0x00000004;
    const uint CREATE_NEW_PROCESS_GROUP = 0x00000200;
    const uint STARTF_USESTDHANDLES = 0x00000100;
    const uint DUPLICATE_SAME_ACCESS = 0x00000002;
    const int JobObjectBasicAccountingInformation = 1;
    const int JobObjectExtendedLimitInformation = 9;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info,
        int length);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcess(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(
        IntPtr job,
        int informationClass,
        out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info,
        int length,
        IntPtr returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr GetStdHandle(int stdHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool DuplicateHandle(
        IntPtr sourceProcess,
        IntPtr sourceHandle,
        IntPtr targetProcess,
        out IntPtr targetHandle,
        uint desiredAccess,
        bool inheritHandle,
        uint options);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);

    static void Check(bool ok, string operation) {
        if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }

    static IntPtr InheritableStdHandle(int id) {
        IntPtr current = GetCurrentProcess();
        IntPtr duplicate;
        Check(DuplicateHandle(current, GetStdHandle(id), current, out duplicate, 0, true, DUPLICATE_SAME_ACCESS), "DuplicateHandle");
        return duplicate;
    }

    public static int Run(string application, string commandLine, string cwd, string jobName, string metadataPath) {
        IntPtr job = CreateJobObject(IntPtr.Zero, jobName);
        if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject");
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        Check(SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits,
            Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))), "SetInformationJobObject");

        STARTUPINFO startup = new STARTUPINFO();
        startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        startup.dwFlags = STARTF_USESTDHANDLES;
        startup.hStdInput = InheritableStdHandle(-10);
        startup.hStdOutput = InheritableStdHandle(-11);
        startup.hStdError = InheritableStdHandle(-12);
        PROCESS_INFORMATION process;
        try {
            Check(CreateProcess(
                application,
                new StringBuilder(commandLine),
                IntPtr.Zero,
                IntPtr.Zero,
                true,
                CREATE_SUSPENDED | CREATE_NEW_PROCESS_GROUP,
                IntPtr.Zero,
                cwd,
                ref startup,
                out process), "CreateProcess");
            try {
                Check(AssignProcessToJobObject(job, process.hProcess), "AssignProcessToJobObject");
                string metadata = "{\"jobName\":\"" + jobName.Replace("\\", "\\\\") +
                    "\",\"targetPid\":" + process.dwProcessId.ToString() + "}";
                File.WriteAllText(metadataPath, metadata);
                if (ResumeThread(process.hThread) == 0xffffffff) {
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "ResumeThread");
                }
                WaitForSingleObject(process.hProcess, 0xffffffff);
                uint exitCode;
                Check(GetExitCodeProcess(process.hProcess, out exitCode), "GetExitCodeProcess");
                while (true) {
                    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
                    Check(QueryInformationJobObject(job, JobObjectBasicAccountingInformation, out accounting,
                        Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)), IntPtr.Zero),
                        "QueryInformationJobObject");
                    if (accounting.ActiveProcesses == 0) break;
                    Thread.Sleep(50);
                }
                return unchecked((int)exitCode);
            } finally {
                CloseHandle(process.hThread);
                CloseHandle(process.hProcess);
            }
        } finally {
            CloseHandle(startup.hStdInput);
            CloseHandle(startup.hStdOutput);
            CloseHandle(startup.hStdError);
            CloseHandle(job);
        }
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp
$application = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:OPENSQUID_WINDOWS_APPLICATION_B64))
$commandLine = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:OPENSQUID_WINDOWS_COMMAND_LINE_B64))
$cwd = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:OPENSQUID_WINDOWS_CWD_B64))
$exitCode = [OpenSquidJobBroker]::Run(
  $application,
  $commandLine,
  $cwd,
  $env:OPENSQUID_WINDOWS_JOB_NAME,
  $env:OPENSQUID_WINDOWS_JOB_METADATA
)
exit $exitCode
