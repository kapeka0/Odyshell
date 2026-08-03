import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, posix, resolve, win32 } from "node:path";
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
  return win32.join(win32.dirname(win32.resolve(configPath)), "client-service.ps1");
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
  const invocation = [
    options.nodePath,
    options.cliPath,
    "client",
    "start",
    "--config",
    win32.resolve(options.configPath),
  ]
    .map(quotePowerShellLiteral)
    .join(" ");
  return `Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
& ${invocation}
exit $LASTEXITCODE
`;
}

export function renderWindowsTaskAction(
  options: InstallClientServiceOptions,
  windowsDirectory = process.env.SystemRoot ?? "C:\\Windows",
): { execute: string; arguments: string } {
  return {
    execute: win32.join(
      windowsDirectory,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    arguments: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      quoteWindowsArgument(windowsTaskLauncherPath(options.configPath)),
    ].join(" "),
  };
}

export function windowsTaskActionIsCurrent(
  action: { execute: string; arguments: string },
  configPath: string,
  windowsDirectory = process.env.SystemRoot ?? "C:\\Windows",
): boolean {
  const expected = renderWindowsTaskAction(
    { nodePath: "", cliPath: "", configPath },
    windowsDirectory,
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
  await writeFile(launcherPath, renderWindowsTaskLauncher(options), {
    encoding: "utf8",
    mode: 0o600,
  });
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
    await rm(windowsTaskLauncherPath(configPath), { force: true });
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
    "Stop-ScheduledTask -TaskName $env:ODYSHELL_TASK_NAME",
    { ODYSHELL_TASK_NAME: taskName },
  );
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

function quotePowerShellLiteral(value: string): string {
  if (/[\r\n\0]/.test(value)) {
    throw new Error("Windows service arguments cannot contain control characters");
  }
  return `'${value.replaceAll("'", "''")}'`;
}
