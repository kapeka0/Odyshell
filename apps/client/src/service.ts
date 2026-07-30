import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, posix, resolve } from "node:path";
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
  servicePath?: string;
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
