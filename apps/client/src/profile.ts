import { access, readFile, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, posix, win32 } from "node:path";
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

export type ListedClientProfile = {
  profileName: string;
  configPath: string;
  valid: boolean;
  machineId?: string;
  machineName?: string;
  serverUrl?: string;
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
        service,
      };
    }),
  );
  return profiles
    .filter((profile): profile is ListedClientProfile => profile !== undefined)
    .sort((left, right) => left.profileName.localeCompare(right.profileName));
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

async function fileExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
}
