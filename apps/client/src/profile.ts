import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, posix, win32 } from "node:path";
import { promisify } from "node:util";
import process from "node:process";
import { clientConfigSchema } from "@odyshell/protocol";
import {
  clientConfigPathFor,
  clientConfigPathForProfile,
  normalizeClientProfileName,
  type SupportedNodePlatform,
} from "./platform.js";
import {
  clientServiceStatus,
  removeClientService,
  type ClientServiceStatus,
} from "./service.js";

const execFileAsync = promisify(execFile);

export type ListedClientProfile = {
  profileName: string;
  configPath: string;
  valid: boolean;
  machineId?: string;
  machineName?: string;
  serverUrl?: string;
  allowPrivilegeEscalation?: boolean;
  service: ClientServiceStatus;
};

export type ListClientProfilesOptions = {
  platform?: SupportedNodePlatform;
  home?: string;
  environment?: NodeJS.ProcessEnv;
  getServiceStatus?: (configPath: string) => Promise<ClientServiceStatus>;
};

export type RemoveClientProfileOptions = {
  profileName: string;
  platform?: SupportedNodePlatform;
  home?: string;
  environment?: NodeJS.ProcessEnv;
  removeService?: (configPath: string) => Promise<void>;
};

export type RemoveAllClientProfilesOptions = Omit<
  RemoveClientProfileOptions,
  "profileName"
>;

export type ConfigureClientPrivilegeEscalationOptions = {
  profileName: string;
  allow: boolean;
  platform?: SupportedNodePlatform;
  home?: string;
  environment?: NodeJS.ProcessEnv;
  verifyPasswordlessSudo?: () => Promise<void>;
  applyService: (configPath: string) => Promise<void>;
};

export async function listClientProfiles(
  options: ListClientProfilesOptions = {},
): Promise<ListedClientProfile[]> {
  const platform = options.platform ??
    (process.platform as SupportedNodePlatform);
  const home = options.home ?? homedir();
  const environment = options.environment ?? process.env;
  const pathApi = platform === "win32" ? win32 : posix;
  const profilesDirectory = pathApi.join(
    pathApi.dirname(clientConfigPathFor(platform, home, environment)),
    "clients",
  );
  const entries = await readdir(profilesDirectory, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  const getServiceStatus = options.getServiceStatus ?? clientServiceStatus;
  const profiles = await Promise.all(
    entries.map(async (entry): Promise<ListedClientProfile | undefined> => {
      if (!entry.isDirectory()) return undefined;
      let profileName: string;
      try {
        profileName = normalizeClientProfileName(entry.name);
      } catch {
        return undefined;
      }
      if (profileName !== entry.name) return undefined;
      const configPath = pathApi.join(profilesDirectory, profileName, "client.json");
      let rawConfig: string;
      try {
        rawConfig = await readFile(configPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
      const service = await getServiceStatus(configPath);
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawConfig);
      } catch {
        return { profileName, configPath, valid: false, service };
      }
      const config = clientConfigSchema.safeParse(parsed);
      if (!config.success) {
        return { profileName, configPath, valid: false, service };
      }
      return {
        profileName,
        configPath,
        valid: true,
        machineId: config.data.machineId,
        machineName: config.data.machineName,
        serverUrl: config.data.serverUrl,
        allowPrivilegeEscalation: config.data.allowPrivilegeEscalation,
        service,
      };
    }),
  );
  return profiles
    .filter((profile): profile is ListedClientProfile => profile !== undefined)
    .sort((left, right) => left.profileName.localeCompare(right.profileName));
}

export async function configureClientPrivilegeEscalation(
  options: ConfigureClientPrivilegeEscalationOptions,
): Promise<{
  profileName: string;
  configPath: string;
  allowPrivilegeEscalation: boolean;
}> {
  const platform = options.platform ??
    (process.platform as SupportedNodePlatform);
  if (platform !== "linux") {
    throw new Error("Sudo access is only available for Linux Client Profiles");
  }
  const profileName = normalizeClientProfileName(options.profileName);
  const configPath = clientConfigPathForProfile(
    profileName,
    platform,
    options.home ?? homedir(),
    options.environment ?? process.env,
  );
  let original: string;
  try {
    original = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Client Profile "${profileName}" does not exist`);
    }
    throw error;
  }
  const parsed = clientConfigSchema.safeParse(JSON.parse(original));
  if (!parsed.success) {
    throw new Error(`Client Profile "${profileName}" has invalid configuration`);
  }
  if (options.allow) {
    const hasHostRunner = Object.values(parsed.data.profiles).some(
      (profile) => profile.runner === "host",
    );
    if (!hasHostRunner) {
      throw new Error("Sudo access requires a host runner");
    }
    await (options.verifyPasswordlessSudo ?? verifyPasswordlessSudo)();
  }

  const next = `${JSON.stringify({
    ...parsed.data,
    allowPrivilegeEscalation: options.allow,
  }, null, 2)}\n`;
  await replacePrivateConfig(configPath, next);
  try {
    await options.applyService(configPath);
  } catch (error) {
    await replacePrivateConfig(configPath, original);
    try {
      await options.applyService(configPath);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Could not apply or restore the Client privilege policy",
      );
    }
    throw error;
  }
  return {
    profileName,
    configPath,
    allowPrivilegeEscalation: options.allow,
  };
}

export async function verifyPasswordlessSudo(): Promise<void> {
  if (await passwordlessSudoAvailable()) return;
  throw new Error(
    "Passwordless sudo is unavailable. Configure a narrow NOPASSWD sudoers policy before enabling sudo access.",
  );
}

export async function passwordlessSudoAvailable(): Promise<boolean> {
  try {
    const { stdout, stderr } = await execFileAsync("sudo", ["-n", "-l"], {
      windowsHide: true,
      timeout: 10_000,
    });
    return sudoListingGrantsPasswordlessCommand(`${stdout}\n${stderr}`);
  } catch {
    return false;
  }
}

export function sudoListingGrantsPasswordlessCommand(listing: string): boolean {
  return /(?:^|\s)NOPASSWD\s*:/mu.test(listing);
}

export async function removeClientProfile(
  options: RemoveClientProfileOptions,
): Promise<{ profileName: string; configPath: string }> {
  const platform = options.platform ??
    (process.platform as SupportedNodePlatform);
  const profileName = normalizeClientProfileName(options.profileName);
  const configPath = clientConfigPathForProfile(
    profileName,
    platform,
    options.home ?? homedir(),
    options.environment ?? process.env,
  );
  try {
    await access(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Client Profile "${profileName}" does not exist`);
    }
    throw error;
  }

  const removeService = options.removeService ?? removeInstalledClientService;
  await removeService(configPath);
  await rm(dirname(configPath), { recursive: true });
  return { profileName, configPath };
}

export async function removeAllClientProfiles(
  options: RemoveAllClientProfilesOptions = {},
): Promise<{
  removed: Array<{ profileName: string; configPath: string }>;
}> {
  const platform = options.platform ??
    (process.platform as SupportedNodePlatform);
  const home = options.home ?? homedir();
  const environment = options.environment ?? process.env;
  const pathApi = platform === "win32" ? win32 : posix;
  const legacyConfigPath = clientConfigPathFor(
    platform,
    home,
    environment,
  );
  const profilesDirectory = pathApi.join(
    pathApi.dirname(legacyConfigPath),
    "clients",
  );
  const candidates: Array<{
    profileName: string;
    configPath: string;
    removePath: string;
  }> = [];

  if (await fileExists(legacyConfigPath)) {
    candidates.push({
      profileName: "legacy",
      configPath: legacyConfigPath,
      removePath: legacyConfigPath,
    });
  }
  const entries = await readdir(profilesDirectory, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const configPath = pathApi.join(
      profilesDirectory,
      entry.name,
      "client.json",
    );
    if (!(await fileExists(configPath))) continue;
    candidates.push({
      profileName: entry.name,
      configPath,
      removePath: pathApi.dirname(configPath),
    });
  }

  const removeService = options.removeService ?? removeInstalledClientService;
  const removed: Array<{ profileName: string; configPath: string }> = [];
  for (const candidate of candidates) {
    await removeService(candidate.configPath);
    await rm(candidate.removePath, {
      recursive: candidate.removePath !== candidate.configPath,
    });
    removed.push({
      profileName: candidate.profileName,
      configPath: candidate.configPath,
    });
  }
  return { removed };
}

async function removeInstalledClientService(configPath: string): Promise<void> {
  const service = await clientServiceStatus(configPath);
  if (service.installed) await removeClientService(configPath);
}

async function replacePrivateConfig(path: string, contents: string): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, contents, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
      flush: true,
    });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function fileExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
}
