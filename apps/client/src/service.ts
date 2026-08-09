import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, posix, resolve, win32 } from "node:path";
import { promisify } from "node:util";
import process from "node:process";
import { clientConfigSchema } from "@odyshell/protocol";
import { defaultClientConfigPath } from "./platform.js";

const execFileAsync = promisify(execFile);
export const linuxServiceName = "odyshell-client.service";
export const macosServiceLabel = "com.odyshell.client";
export const windowsTaskPrefix = "Odyshell\\Client";

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
  if (normalizedConfigPath === resolve(legacyConfigPath)) return linuxServiceName;
  const digest = createHash("sha256")
    .update(normalizedConfigPath)
    .digest("hex")
    .slice(0, 12);
  return `odyshell-client-${digest}.service`;
}

export function renderLinuxUserService(options: InstallClientServiceOptions): string {
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

export async function installClientService(
  options: InstallClientServiceOptions,
): Promise<{ servicePath: string; lingering: boolean | undefined }> {
  if (process.platform === "linux") return await installLinuxUserService(options);
  if (process.platform === "darwin") return await installMacosUserService(options);
  if (process.platform === "win32") return await installWindowsUserService(options);
  throw new Error(`Unsupported Client platform: ${process.platform}`);
}

export async function installLinuxUserService(
  options: InstallClientServiceOptions,
): Promise<{ servicePath: string; lingering: boolean | undefined }> {
  assertLinuxSystemd();
  const configPath = resolve(options.configPath);
  const parsed = clientConfigSchema.safeParse(JSON.parse(await readFile(configPath, "utf8")));
  if (!parsed.success) {
    throw new Error(`Invalid Client configuration at ${configPath}`);
  }
  const serviceName = linuxServiceNameForConfig(configPath);
  const servicePath = linuxUserServicePath(homedir(), process.env, serviceName);
  await mkdir(dirname(servicePath), { recursive: true });
  await writeFile(servicePath, renderLinuxUserService({ ...options, configPath }), {
    mode: 0o644,
  });
  await activateLinuxUserService(serviceName);
  return { servicePath, lingering: await userLingering() };
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
  await systemctl(["disable", "--now", linuxServiceNameForConfig(configPath)]);
}

export async function stopClientService(
  configPath = defaultClientConfigPath(),
): Promise<void> {
  if (process.platform === "linux") return await stopLinuxUserService(configPath);
  if (process.platform === "darwin") return await stopMacosUserService(configPath);
  if (process.platform === "win32") return await stopWindowsUserService(configPath);
  throw new Error(`Unsupported Client platform: ${process.platform}`);
}

export async function removeClientService(
  configPath = defaultClientConfigPath(),
): Promise<void> {
  if (process.platform === "linux") return await removeLinuxUserService(configPath);
  if (process.platform === "darwin") return await removeMacosUserService(configPath);
  if (process.platform === "win32") return await removeWindowsUserService(configPath);
  throw new Error(`Unsupported Client platform: ${process.platform}`);
}

export async function restartClientService(
  configPath = defaultClientConfigPath(),
): Promise<void> {
  if (process.platform === "linux") {
    assertLinuxSystemd();
    return await activateLinuxUserService(linuxServiceNameForConfig(configPath));
  }
  if (process.platform === "darwin") return await restartMacosUserService(configPath);
  if (process.platform === "win32") return await restartWindowsUserService(configPath);
  throw new Error(`Unsupported Client platform: ${process.platform}`);
}

export async function removeLinuxUserService(
  configPath = defaultClientConfigPath(),
): Promise<void> {
  assertLinuxSystemd();
  const serviceName = linuxServiceNameForConfig(configPath);
  await systemctl(["disable", "--now", serviceName]).catch(() => {});
  await rm(linuxUserServicePath(homedir(), process.env, serviceName), { force: true });
  await systemctl(["daemon-reload"]);
}

export async function clientServiceStatus(
  configPath = defaultClientConfigPath(),
): Promise<ClientServiceStatus> {
  if (process.platform === "darwin") return await macosUserServiceStatus(configPath);
  if (process.platform === "win32") return await windowsUserServiceStatus(configPath);
  if (process.platform !== "linux") return { supported: false, installed: false, active: false, enabled: false };
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
    systemctl(["is-active", "--quiet", serviceName]).then(() => true, () => false),
    systemctl(["is-enabled", "--quiet", serviceName]).then(() => true, () => false),
  ]);
  return { supported: true, installed, active, enabled, current: true, servicePath };
}

export function serviceDigest(configPath: string): string {
  return createHash("sha256").update(resolve(configPath)).digest("hex").slice(0, 12);
}

export function macosServiceNameForConfig(configPath: string): string {
  return `${macosServiceLabel}.${serviceDigest(configPath)}`;
}

export function macosUserServicePath(configPath: string, home = homedir()): string {
  return posix.join(home, "Library", "LaunchAgents", `${macosServiceNameForConfig(configPath)}.plist`);
}

export function renderMacosUserService(options: InstallClientServiceOptions): string {
  const configPath = resolve(options.configPath);
  const label = macosServiceNameForConfig(configPath);
  const argumentsList = [options.nodePath, options.cliPath, "client", "start", "--config", configPath]
    .map((value) => `    <string>${escapeXmlArgument(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsList}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
}

export async function installMacosUserService(
  options: InstallClientServiceOptions,
): Promise<{ servicePath: string; lingering: undefined }> {
  assertPlatform("darwin", "launchd");
  const configPath = await validatedConfigPath(options.configPath);
  const servicePath = macosUserServicePath(configPath);
  await mkdir(dirname(servicePath), { recursive: true });
  await writeFile(servicePath, renderMacosUserService({ ...options, configPath }), { mode: 0o600 });
  await launchctl(["bootout", launchdDomain(), servicePath]).catch(() => {});
  await launchctl(["bootstrap", launchdDomain(), servicePath]);
  await launchctl(["kickstart", "-k", `${launchdDomain()}/${macosServiceNameForConfig(configPath)}`]);
  return { servicePath, lingering: undefined };
}

async function stopMacosUserService(configPath: string): Promise<void> {
  assertPlatform("darwin", "launchd");
  await launchctl(["bootout", launchdDomain(), macosUserServicePath(configPath)]);
}

async function restartMacosUserService(configPath: string): Promise<void> {
  assertPlatform("darwin", "launchd");
  await launchctl(["kickstart", "-k", `${launchdDomain()}/${macosServiceNameForConfig(configPath)}`]);
}

async function removeMacosUserService(configPath: string): Promise<void> {
  assertPlatform("darwin", "launchd");
  const servicePath = macosUserServicePath(configPath);
  await launchctl(["bootout", launchdDomain(), servicePath]).catch(() => {});
  await rm(servicePath, { force: true });
}

async function macosUserServiceStatus(configPath: string): Promise<ClientServiceStatus> {
  const servicePath = macosUserServicePath(configPath);
  const installed = await fileExists(servicePath);
  if (!installed) return { supported: true, installed: false, active: false, enabled: false, servicePath };
  const active = await launchctl(["print", `${launchdDomain()}/${macosServiceNameForConfig(configPath)}`]).then(() => true, () => false);
  return { supported: true, installed: true, active, enabled: true, current: true, servicePath };
}

export function windowsTaskNameForConfig(configPath: string): string {
  return `${windowsTaskPrefix}-${serviceDigest(configPath)}`;
}

export function windowsLauncherPath(configPath: string): string {
  return win32.join(win32.dirname(resolve(configPath)), "odyshell-client.cmd");
}

export function renderWindowsLauncher(options: InstallClientServiceOptions): string {
  return `@echo off\r\n${quoteWindowsBatch(options.nodePath)} ${quoteWindowsBatch(options.cliPath)} client start --config ${quoteWindowsBatch(resolve(options.configPath))}\r\n`;
}

export async function installWindowsUserService(
  options: InstallClientServiceOptions,
): Promise<{ servicePath: string; lingering: undefined }> {
  assertPlatform("win32", "Task Scheduler");
  const configPath = await validatedConfigPath(options.configPath);
  const servicePath = windowsLauncherPath(configPath);
  await mkdir(dirname(servicePath), { recursive: true });
  await writeFile(servicePath, renderWindowsLauncher({ ...options, configPath }), { mode: 0o600 });
  const taskName = windowsTaskNameForConfig(configPath);
  await schtasks(["/Create", "/TN", taskName, "/SC", "ONLOGON", "/TR", servicePath, "/F", "/RL", "LIMITED"]);
  await schtasks(["/Run", "/TN", taskName]);
  return { servicePath, lingering: undefined };
}

async function stopWindowsUserService(configPath: string): Promise<void> {
  assertPlatform("win32", "Task Scheduler");
  await schtasks(["/End", "/TN", windowsTaskNameForConfig(configPath)]);
}

async function restartWindowsUserService(configPath: string): Promise<void> {
  assertPlatform("win32", "Task Scheduler");
  await schtasks(["/End", "/TN", windowsTaskNameForConfig(configPath)]).catch(() => {});
  await schtasks(["/Run", "/TN", windowsTaskNameForConfig(configPath)]);
}

async function removeWindowsUserService(configPath: string): Promise<void> {
  assertPlatform("win32", "Task Scheduler");
  const taskName = windowsTaskNameForConfig(configPath);
  await schtasks(["/End", "/TN", taskName]).catch(() => {});
  await schtasks(["/Delete", "/TN", taskName, "/F"]).catch(() => {});
  await rm(windowsLauncherPath(configPath), { force: true });
}

async function windowsUserServiceStatus(configPath: string): Promise<ClientServiceStatus> {
  const servicePath = windowsLauncherPath(configPath);
  const installed = await fileExists(servicePath) && await schtasks(["/Query", "/TN", windowsTaskNameForConfig(configPath)]).then(() => true, () => false);
  if (!installed) return { supported: true, installed: false, active: false, enabled: false, servicePath };
  const active = await windowsScheduledTaskState(configPath).then(
    (state) => state === "Running",
    () => false,
  );
  return { supported: true, installed: true, active, enabled: true, current: true, servicePath };
}

async function windowsScheduledTaskState(configPath: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$task = Get-ScheduledTask -TaskPath '\\Odyshell\\' -TaskName $env:ODYSHELL_TASK_NAME -ErrorAction Stop; $task.State.ToString()",
    ],
    {
      windowsHide: true,
      timeout: 10_000,
      env: { ...process.env, ODYSHELL_TASK_NAME: `Client-${serviceDigest(configPath)}` },
    },
  );
  return stdout.trim();
}

async function validatedConfigPath(configPath: string): Promise<string> {
  const resolvedPath = resolve(configPath);
  const parsed = clientConfigSchema.safeParse(JSON.parse(await readFile(resolvedPath, "utf8")));
  if (!parsed.success) throw new Error(`Invalid Client configuration at ${resolvedPath}`);
  return resolvedPath;
}

async function fileExists(path: string): Promise<boolean> {
  return await readFile(path).then(() => true, () => false);
}

function launchdDomain(): string {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("launchd user domain is unavailable");
  return `gui/${uid}`;
}

async function launchctl(args: string[]): Promise<void> {
  await execFileAsync("launchctl", args, { windowsHide: true, timeout: 30_000 });
}

async function schtasks(args: string[]): Promise<void> {
  await execFileAsync("schtasks.exe", args, { windowsHide: true, timeout: 30_000 });
}

function assertPlatform(expected: NodeJS.Platform, manager: string): void {
  if (process.platform !== expected) throw new Error(`${manager} service management requires ${expected}`);
}

function escapeXmlArgument(value: string): string {
  if (/[\r\n\0]/u.test(value)) throw new Error("Service arguments cannot contain control characters");
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function quoteWindowsBatch(value: string): string {
  if (/[\r\n\0"]/u.test(value)) throw new Error("Windows service arguments contain invalid characters");
  return `"${value.replaceAll("%", "%%")}"`;
}

async function systemctl(args: string[]): Promise<void> {
  await execFileAsync("systemctl", ["--user", ...args], {
    windowsHide: true,
    timeout: 30_000,
  });
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
    throw new Error("Background service management requires Linux with systemd");
  }
}

function quoteSystemd(value: string): string {
  if (/[\r\n\0]/.test(value)) {
    throw new Error("Systemd arguments cannot contain control characters");
  }
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
