import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, posix, resolve } from "node:path";
import { promisify } from "node:util";
import process from "node:process";

const execFileAsync = promisify(execFile);
export const linuxServiceName = "odyshell-client.service";

export type ClientServiceStatus = {
  supported: boolean;
  installed: boolean;
  active: boolean;
  enabled: boolean;
  servicePath?: string;
};

export function linuxUserServicePath(
  home = homedir(),
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configHome = environment.XDG_CONFIG_HOME ?? posix.join(home, ".config");
  return posix.join(configHome, "systemd", "user", linuxServiceName);
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

export async function installLinuxUserService(options: {
  nodePath: string;
  cliPath: string;
  configPath: string;
}): Promise<{ servicePath: string; lingering: boolean | undefined }> {
  assertLinuxSystemd();
  await readFile(resolve(options.configPath), "utf8");
  const servicePath = linuxUserServicePath();
  await mkdir(dirname(servicePath), { recursive: true });
  await writeFile(
    servicePath,
    renderLinuxUserService({ ...options, configPath: resolve(options.configPath) }),
    { mode: 0o644 },
  );
  await activateLinuxUserService();
  return { servicePath, lingering: await userLingering() };
}

export async function activateLinuxUserService(
  runSystemctl: (args: string[]) => Promise<void> = systemctl,
): Promise<void> {
  await runSystemctl(["daemon-reload"]);
  await runSystemctl(["enable", linuxServiceName]);
  await runSystemctl(["restart", linuxServiceName]);
  await runSystemctl(["is-active", "--quiet", linuxServiceName]);
}

export async function stopLinuxUserService(): Promise<void> {
  assertLinuxSystemd();
  await systemctl(["disable", "--now", linuxServiceName]);
}

export async function removeLinuxUserService(): Promise<void> {
  assertLinuxSystemd();
  await systemctl(["disable", "--now", linuxServiceName]).catch(() => {});
  await rm(linuxUserServicePath(), { force: true });
  await systemctl(["daemon-reload"]);
}

export async function clientServiceStatus(): Promise<ClientServiceStatus> {
  if (process.platform !== "linux") {
    return { supported: false, installed: false, active: false, enabled: false };
  }
  const servicePath = linuxUserServicePath();
  const installed = await readFile(servicePath, "utf8").then(
    () => true,
    () => false,
  );
  if (!installed) {
    return { supported: true, installed: false, active: false, enabled: false, servicePath };
  }
  const [active, enabled] = await Promise.all([
    systemctl(["is-active", "--quiet", linuxServiceName]).then(
      () => true,
      () => false,
    ),
    systemctl(["is-enabled", "--quiet", linuxServiceName]).then(
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

function quoteSystemd(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error("Systemd arguments cannot contain control characters");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
