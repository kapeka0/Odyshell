import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, posix, resolve, win32 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import process from "node:process";
import { defaultClientConfigPath } from "./platform.js";

const execFileAsync = promisify(execFile);
export const linuxServiceName = "odyshell-client.service";

export type ClientServiceStatus = {
  supported: boolean;
  installed: boolean;
  active: boolean;
  enabled: boolean;
  current?: boolean;
  servicePath?: string;
};

export type InstallClientServiceOptions = {
  nodePath: string;
  cliPath: string;
  configPath: string;
};

const windowsLauncherSource = String.raw`using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

internal static class OdyshellClientLauncher
{
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
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
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length < 2 || !Path.IsPathRooted(args[0]) || !File.Exists(args[0]))
        {
            return 2;
        }

        var startInfo = new ProcessStartInfo
        {
            FileName = Path.GetFullPath(args[0]),
            Arguments = BuildArguments(args, 1),
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            WorkingDirectory = Path.GetDirectoryName(Path.GetFullPath(args[0]))
        };

        using (var process = new Process { StartInfo = startInfo })
        {
            process.OutputDataReceived += delegate { };
            process.ErrorDataReceived += delegate { };
            if (!process.Start())
            {
                return 3;
            }
            process.StandardInput.Close();
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();

            IntPtr job = CreateKillOnCloseJob();
            if (job == IntPtr.Zero || !AssignProcessToJobObject(job, process.Handle))
            {
                try { process.Kill(); } catch { }
                if (job != IntPtr.Zero) CloseHandle(job);
                return 4;
            }

            try
            {
                process.WaitForExit();
                return process.ExitCode;
            }
            finally
            {
                CloseHandle(job);
            }
        }
    }

    private static IntPtr CreateKillOnCloseJob()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return IntPtr.Zero;

        var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr pointer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(limits, pointer, false);
            if (!SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                pointer,
                (uint)size))
            {
                CloseHandle(job);
                return IntPtr.Zero;
            }
            return job;
        }
        finally
        {
            Marshal.FreeHGlobal(pointer);
        }
    }

    private static string BuildArguments(string[] args, int start)
    {
        var result = new StringBuilder();
        for (int index = start; index < args.Length; index++)
        {
            if (result.Length > 0) result.Append(' ');
            result.Append(QuoteArgument(args[index]));
        }
        return result.ToString();
    }

    private static string QuoteArgument(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0)
        {
            return value;
        }

        var result = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char character in value)
        {
            if (character == '\\')
            {
                backslashes++;
                continue;
            }
            if (character == '"')
            {
                result.Append('\\', backslashes * 2 + 1);
                result.Append('"');
                backslashes = 0;
                continue;
            }
            result.Append('\\', backslashes);
            backslashes = 0;
            result.Append(character);
        }
        result.Append('\\', backslashes * 2);
        result.Append('"');
        return result.ToString();
    }
}
`;

export function linuxUserServicePath(
  home = homedir(),
  environment: NodeJS.ProcessEnv = process.env,
  serviceName = linuxServiceName,
): string {
  const configHome = environment.XDG_CONFIG_HOME ?? posix.join(home, ".config");
  return posix.join(configHome, "systemd", "user", serviceName);
}

export function linuxServiceNameForConfig(
  configPath: string,
  legacyConfigPath = defaultClientConfigPath(),
): string {
  const normalizedConfigPath = resolve(configPath);
  if (normalizedConfigPath === resolve(legacyConfigPath)) {
    return linuxServiceName;
  }
  const digest = createHash("sha256")
    .update(normalizedConfigPath)
    .digest("hex")
    .slice(0, 12);
  return `odyshell-client-${digest}.service`;
}

export function macLaunchAgentLabelForConfig(
  configPath: string,
  legacyConfigPath = defaultClientConfigPath(),
): string {
  return resolve(configPath) === resolve(legacyConfigPath)
    ? "com.odyshell.client"
    : `com.odyshell.client.${configDigest(configPath)}`;
}

export function macLaunchAgentPath(
  configPath: string,
  home = homedir(),
): string {
  return posix.join(
    home,
    "Library",
    "LaunchAgents",
    `${macLaunchAgentLabelForConfig(configPath)}.plist`,
  );
}

export function windowsTaskNameForConfig(
  configPath: string,
  legacyConfigPath = defaultClientConfigPath(),
): string {
  const normalizedConfigPath = win32.resolve(configPath);
  return normalizedConfigPath === win32.resolve(legacyConfigPath)
    ? "Odyshell Client"
    : `Odyshell Client ${digestPath(normalizedConfigPath)}`;
}

export function windowsTaskLauncherPath(configPath: string): string {
  return win32.join(
    win32.dirname(win32.resolve(configPath)),
    "client-launcher-v1.exe",
  );
}

function legacyWindowsTaskLauncherPaths(configPath: string): string[] {
  const directory = win32.dirname(win32.resolve(configPath));
  return [
    win32.join(directory, "client-service.ps1"),
    win32.join(directory, "client-service.js"),
  ];
}

export function renderLinuxUserService(options: {
  nodePath: string;
  cliPath: string;
  configPath: string;
}): string {
  return `[Unit]
Description=Odyshell outbound machine client
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${quoteSystemd(options.nodePath)} ${quoteSystemd(options.cliPath)} client start --config ${quoteSystemd(options.configPath)}
Restart=always
RestartSec=3
KillMode=control-group
NoNewPrivileges=true

[Install]
WantedBy=default.target
`;
}

export function renderMacLaunchAgent(
  options: InstallClientServiceOptions,
): string {
  const label = macLaunchAgentLabelForConfig(options.configPath);
  const argumentsList = [
    options.nodePath,
    options.cliPath,
    "client",
    "start",
    "--config",
    resolve(options.configPath),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsList.map((argument) => `    <string>${xmlEscape(argument)}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

export function renderWindowsTaskLauncher(
  options: InstallClientServiceOptions,
): string {
  for (const value of [options.nodePath, options.cliPath, options.configPath]) {
    quoteWindowsArgument(value);
  }
  return windowsLauncherSource;
}

export function renderWindowsTaskAction(
  options: InstallClientServiceOptions,
  _windowsDirectory = process.env.SystemRoot ?? "C:\\Windows",
): { execute: string; arguments: string } {
  return {
    execute: windowsTaskLauncherPath(options.configPath),
    arguments: [
      options.nodePath,
      options.cliPath,
      "client",
      "start",
      "--config",
      win32.resolve(options.configPath),
    ]
      .map(quoteWindowsArgument)
      .join(" "),
  };
}

export function windowsTaskActionIsCurrent(
  action: { execute: string; arguments: string },
  configPath: string,
  runtime: { nodePath?: string; cliPath?: string } = {},
): boolean {
  const expected = renderWindowsTaskAction(
    {
      nodePath: runtime.nodePath ?? process.execPath,
      cliPath: runtime.cliPath ?? process.argv[1] ?? "",
      configPath,
    },
  );
  return (
    win32.normalize(action.execute).toLowerCase() ===
      win32.normalize(expected.execute).toLowerCase() &&
    action.arguments === expected.arguments
  );
}

export async function installClientService(
  options: InstallClientServiceOptions,
): Promise<{ servicePath: string; lingering: boolean | undefined }> {
  if (process.platform === "linux") {
    return installLinuxUserService(options);
  }
  if (process.platform === "darwin") {
    return installMacLaunchAgent(options);
  }
  if (process.platform === "win32") {
    return installWindowsTask(options);
  }
  throw new Error(`Background service management does not support ${process.platform}`);
}

export async function installLinuxUserService(options: {
  nodePath: string;
  cliPath: string;
  configPath: string;
}): Promise<{ servicePath: string; lingering: boolean | undefined }> {
  assertLinuxSystemd();
  const configPath = resolve(options.configPath);
  await readFile(configPath, "utf8");
  const serviceName = linuxServiceNameForConfig(configPath);
  const servicePath = linuxUserServicePath(homedir(), process.env, serviceName);
  await mkdir(dirname(servicePath), { recursive: true });
  await writeFile(
    servicePath,
    renderLinuxUserService({ ...options, configPath }),
    { mode: 0o644 },
  );
  await activateLinuxUserService(serviceName);
  return { servicePath, lingering: await userLingering() };
}

export async function installMacLaunchAgent(
  options: InstallClientServiceOptions,
): Promise<{ servicePath: string; lingering: undefined }> {
  await readFile(resolve(options.configPath), "utf8");
  const servicePath = macLaunchAgentPath(options.configPath);
  await mkdir(dirname(servicePath), { recursive: true });
  await writeFile(servicePath, renderMacLaunchAgent(options), { mode: 0o644 });
  await activateMacLaunchAgent(options.configPath);
  return { servicePath, lingering: undefined };
}

export async function activateMacLaunchAgent(
  configPath: string,
  runLaunchctl: (args: string[]) => Promise<void> = launchctl,
  domain = macLaunchAgentDomain(),
): Promise<void> {
  const servicePath = macLaunchAgentPath(configPath);
  const label = macLaunchAgentLabelForConfig(configPath);
  await runLaunchctl(["bootout", domain, servicePath]).catch(() => {});
  await runLaunchctl(["bootstrap", domain, servicePath]);
  await runLaunchctl(["kickstart", "-k", `${domain}/${label}`]);
  await runLaunchctl(["print", `${domain}/${label}`]);
}

export async function installWindowsTask(
  options: InstallClientServiceOptions,
): Promise<{ servicePath: string; lingering: undefined }> {
  await readFile(resolve(options.configPath), "utf8");
  const taskName = windowsTaskNameForConfig(options.configPath);
  const launcherPath = windowsTaskLauncherPath(options.configPath);
  await mkdir(dirname(launcherPath), { recursive: true });
  await stopWindowsTask(taskName).catch(() => {});
  await compileWindowsTaskLauncher(options, launcherPath);
  await Promise.all(
    legacyWindowsTaskLauncherPaths(options.configPath).map((path) =>
      rm(path, { force: true }),
    ),
  );
  await registerWindowsTask(taskName, options);
  await startWindowsTask(taskName);
  await getWindowsTask(taskName);
  return {
    servicePath: `Task Scheduler: ${taskName}`,
    lingering: undefined,
  };
}

export async function activateLinuxUserService(
  serviceName = linuxServiceName,
  runSystemctl: (args: string[]) => Promise<void> = systemctl,
): Promise<void> {
  await runSystemctl(["daemon-reload"]);
  await runSystemctl(["enable", serviceName]);
  await runSystemctl(["restart", serviceName]);
  await runSystemctl(["is-active", "--quiet", serviceName]);
}

export async function stopLinuxUserService(
  configPath = defaultClientConfigPath(),
): Promise<void> {
  assertLinuxSystemd();
  await systemctl([
    "disable",
    "--now",
    linuxServiceNameForConfig(configPath),
  ]);
}

export async function stopClientService(
  configPath = defaultClientConfigPath(),
): Promise<void> {
  if (process.platform === "linux") {
    return stopLinuxUserService(configPath);
  }
  if (process.platform === "darwin") {
    const servicePath = macLaunchAgentPath(configPath);
    await launchctl(["bootout", macLaunchAgentDomain(), servicePath]).catch(
      () => {},
    );
    await rm(servicePath, { force: true });
    return;
  }
  if (process.platform === "win32") {
    const taskName = windowsTaskNameForConfig(configPath);
    await stopWindowsTask(taskName).catch(() => {});
    await unregisterWindowsTask(taskName);
    await removeWindowsLauncherWhenUnlocked(
      windowsTaskLauncherPath(configPath),
    );
    await Promise.all(
      legacyWindowsTaskLauncherPaths(configPath).map((path) =>
        rm(path, { force: true }),
      ),
    );
    return;
  }
  throw new Error(`Background service management does not support ${process.platform}`);
}

export async function restartClientService(
  configPath = defaultClientConfigPath(),
): Promise<void> {
  if (process.platform === "linux") {
    return activateLinuxUserService(linuxServiceNameForConfig(configPath));
  }
  if (process.platform === "darwin") {
    return activateMacLaunchAgent(configPath);
  }
  if (process.platform === "win32") {
    await startWindowsTask(windowsTaskNameForConfig(configPath));
    return;
  }
  throw new Error(`Background service management does not support ${process.platform}`);
}

export async function removeLinuxUserService(
  configPath = defaultClientConfigPath(),
): Promise<void> {
  assertLinuxSystemd();
  const serviceName = linuxServiceNameForConfig(configPath);
  await systemctl(["disable", "--now", serviceName]).catch(() => {});
  await rm(linuxUserServicePath(homedir(), process.env, serviceName), {
    force: true,
  });
  await systemctl(["daemon-reload"]);
}

export async function clientServiceStatus(
  configPath = defaultClientConfigPath(),
): Promise<ClientServiceStatus> {
  if (process.platform === "darwin") {
    const servicePath = macLaunchAgentPath(configPath);
    const installed = await fileExists(servicePath);
    const active =
      installed &&
      (await launchctl([
        "print",
        `${macLaunchAgentDomain()}/${macLaunchAgentLabelForConfig(configPath)}`,
      ]).then(
        () => true,
        () => false,
      ));
    return {
      supported: true,
      installed,
      active,
      enabled: installed,
      servicePath,
    };
  }
  if (process.platform === "win32") {
    const taskName = windowsTaskNameForConfig(configPath);
    const installed = await getWindowsTask(taskName).then(
      () => true,
      () => false,
    );
    const current =
      installed &&
      (await windowsTaskAction(taskName).then(
        (action) => windowsTaskActionIsCurrent(action, configPath),
        () => false,
      ));
    const active =
      installed &&
      (await windowsTaskState(taskName).then(
        (state) => state === "Running",
        () => false,
      ));
    return {
      supported: true,
      installed,
      active,
      enabled: installed,
      current,
      servicePath: `Task Scheduler: ${taskName}`,
    };
  }
  if (process.platform !== "linux") {
    return { supported: false, installed: false, active: false, enabled: false };
  }
  const serviceName = linuxServiceNameForConfig(configPath);
  const servicePath = linuxUserServicePath(homedir(), process.env, serviceName);
  const installed = await readFile(servicePath, "utf8").then(
    () => true,
    () => false,
  );
  if (!installed) {
    return { supported: true, installed: false, active: false, enabled: false, servicePath };
  }
  const [active, enabled] = await Promise.all([
    systemctl(["is-active", "--quiet", serviceName]).then(
      () => true,
      () => false,
    ),
    systemctl(["is-enabled", "--quiet", serviceName]).then(
      () => true,
      () => false,
    ),
  ]);
  return { supported: true, installed, active, enabled, servicePath };
}

async function systemctl(args: string[]): Promise<void> {
  await execFileAsync("systemctl", ["--user", ...args], {
    windowsHide: true,
    timeout: 30_000,
  });
}

async function launchctl(args: string[]): Promise<void> {
  await execFileAsync("launchctl", args, {
    windowsHide: true,
    timeout: 30_000,
  });
}

async function windowsTaskPowerShell(
  script: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ], {
    windowsHide: true,
    timeout: 30_000,
    env: { ...process.env, ...environment },
  });
}

async function compileWindowsTaskLauncher(
  options: InstallClientServiceOptions,
  launcherPath: string,
): Promise<void> {
  const nonce = `${process.pid}-${randomUUID()}`;
  const sourcePath = `${launcherPath}.${nonce}.cs`;
  const outputPath = `${launcherPath}.${nonce}.exe`;
  try {
    await writeFile(sourcePath, renderWindowsTaskLauncher(options), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await windowsTaskPowerShell(
      "Add-Type -Path $env:ODYSHELL_LAUNCHER_SOURCE -OutputAssembly $env:ODYSHELL_LAUNCHER_OUTPUT -OutputType WindowsApplication",
      {
        ODYSHELL_LAUNCHER_SOURCE: sourcePath,
        ODYSHELL_LAUNCHER_OUTPUT: outputPath,
      },
    );
    await removeWindowsLauncherWhenUnlocked(launcherPath);
    await rename(outputPath, launcherPath);
  } finally {
    await Promise.all([
      rm(sourcePath, { force: true }),
      rm(outputPath, { force: true }),
    ]);
  }
}

async function registerWindowsTask(
  taskName: string,
  options: InstallClientServiceOptions,
): Promise<void> {
  const action = renderWindowsTaskAction(options);
  await windowsTaskPowerShell(
    [
      "$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()",
      "$action = New-ScheduledTaskAction -Execute $env:ODYSHELL_TASK_EXECUTABLE -Argument $env:ODYSHELL_TASK_ARGUMENTS",
      "$principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited",
      "$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name",
      "$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries",
      "Register-ScheduledTask -TaskName $env:ODYSHELL_TASK_NAME -Action $action -Principal $principal -Trigger $trigger -Settings $settings -Force | Out-Null",
    ].join("; "),
    {
      ODYSHELL_TASK_NAME: taskName,
      ODYSHELL_TASK_EXECUTABLE: action.execute,
      ODYSHELL_TASK_ARGUMENTS: action.arguments,
    },
  );
}

async function startWindowsTask(taskName: string): Promise<void> {
  await windowsTaskPowerShell(
    "Start-ScheduledTask -TaskName $env:ODYSHELL_TASK_NAME",
    { ODYSHELL_TASK_NAME: taskName },
  );
}

async function stopWindowsTask(taskName: string): Promise<void> {
  await windowsTaskPowerShell(
    [
      "Stop-ScheduledTask -TaskName $env:ODYSHELL_TASK_NAME",
      "$deadline = [DateTime]::UtcNow.AddSeconds(10)",
      "do { $state = (Get-ScheduledTask -TaskName $env:ODYSHELL_TASK_NAME).State; if ($state -ne 'Running') { exit 0 }; Start-Sleep -Milliseconds 100 } while ([DateTime]::UtcNow -lt $deadline)",
      "throw 'Timed out waiting for the Odyshell Client task to stop'",
    ].join("; "),
    { ODYSHELL_TASK_NAME: taskName },
  );
}

async function removeWindowsLauncherWhenUnlocked(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      await rm(path, { force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== "EPERM" && code !== "EBUSY") || Date.now() >= deadline) {
        throw error;
      }
      await delay(100);
    }
  }
}

async function unregisterWindowsTask(taskName: string): Promise<void> {
  await windowsTaskPowerShell(
    "Unregister-ScheduledTask -TaskName $env:ODYSHELL_TASK_NAME -Confirm:$false",
    { ODYSHELL_TASK_NAME: taskName },
  );
}

async function getWindowsTask(taskName: string): Promise<void> {
  await windowsTaskPowerShell(
    "Get-ScheduledTask -TaskName $env:ODYSHELL_TASK_NAME | Out-Null",
    { ODYSHELL_TASK_NAME: taskName },
  );
}

async function windowsTaskState(taskName: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Console]::Out.Write((Get-ScheduledTask -TaskName $env:ODYSHELL_TASK_NAME).State)",
    ],
    {
      windowsHide: true,
      timeout: 30_000,
      env: { ...process.env, ODYSHELL_TASK_NAME: taskName },
    },
  );
  return stdout.trim();
}

async function windowsTaskAction(
  taskName: string,
): Promise<{ execute: string; arguments: string }> {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$action = @((Get-ScheduledTask -TaskName $env:ODYSHELL_TASK_NAME).Actions)[0]; @{ execute = $action.Execute; arguments = $action.Arguments } | ConvertTo-Json -Compress",
    ],
    {
      windowsHide: true,
      timeout: 30_000,
      env: { ...process.env, ODYSHELL_TASK_NAME: taskName },
    },
  );
  const parsed = JSON.parse(stdout) as {
    execute?: unknown;
    arguments?: unknown;
  };
  if (
    typeof parsed.execute !== "string" ||
    typeof parsed.arguments !== "string"
  ) {
    throw new Error("Windows Client task has an invalid action");
  }
  return { execute: parsed.execute, arguments: parsed.arguments };
}

async function userLingering(): Promise<boolean | undefined> {
  try {
    const user = process.env.USER;
    if (!user) return undefined;
    const { stdout } = await execFileAsync(
      "loginctl",
      ["show-user", user, "--property=Linger", "--value"],
      { windowsHide: true, timeout: 10_000 },
    );
    return stdout.trim() === "yes";
  } catch {
    return undefined;
  }
}

function assertLinuxSystemd(): void {
  if (process.platform !== "linux") {
    throw new Error("Background service management currently requires Linux with systemd");
  }
}

function macLaunchAgentDomain(): string {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error("Could not determine the macOS user ID");
  }
  return `gui/${uid}`;
}

async function fileExists(path: string): Promise<boolean> {
  return readFile(path, "utf8").then(
    () => true,
    () => false,
  );
}

function configDigest(configPath: string): string {
  return digestPath(resolve(configPath));
}

function digestPath(configPath: string): string {
  return createHash("sha256")
    .update(configPath)
    .digest("hex")
    .slice(0, 12);
}

function xmlEscape(value: string): string {
  if (/[\0]/.test(value)) {
    throw new Error("LaunchAgent arguments cannot contain null bytes");
  }
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function quoteSystemd(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error("Systemd arguments cannot contain control characters");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function quoteWindowsArgument(value: string): string {
  if (/[\r\n\0]/.test(value)) {
    throw new Error("Windows task arguments cannot contain control characters");
  }
  return `"${value
    .replace(/(\\*)"/g, "$1$1\\\"")
    .replace(/(\\+)$/g, "$1$1")}"`;
}
