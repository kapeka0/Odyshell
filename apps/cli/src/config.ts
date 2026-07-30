import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, posix, resolve, win32 } from "node:path";
import process from "node:process";
import { homedir } from "node:os";

export type StoredConfig = {
  serverUrl: string;
  workspaceId?: string;
  agentToken?: string;
  /** @deprecated Read only for existing development configurations. */
  agentKey?: string;
  adminKey?: string;
};

export type GlobalOptions = {
  server?: string;
  workspaceId?: string;
  agentToken?: string;
  agentKey?: string;
  adminKey?: string;
  configFile?: string;
  json?: boolean;
};

export function cliConfigPathFor(
  platform: "linux" | "darwin" | "win32",
  home: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === "win32") {
    return win32.join(
      environment.APPDATA ?? win32.join(home, "AppData", "Roaming"),
      "Odyshell",
      "config.json",
    );
  }
  if (platform === "darwin") {
    return posix.join(home, "Library", "Application Support", "Odyshell", "config.json");
  }
  return posix.join(
    environment.XDG_CONFIG_HOME ?? posix.join(home, ".config"),
    "odyshell",
    "config.json",
  );
}

export function defaultConfigPath(): string {
  if (process.env.ODS_CONFIG_FILE) return resolve(process.env.ODS_CONFIG_FILE);
  return cliConfigPathFor(
    process.platform as "linux" | "darwin" | "win32",
    homedir(),
  );
}

export async function loadStoredConfig(path = defaultConfigPath()): Promise<StoredConfig | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as StoredConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function saveStoredConfig(config: StoredConfig, path = defaultConfigPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600).catch(() => {});
}

export async function removeStoredConfig(path = defaultConfigPath()): Promise<void> {
  await rm(path, { force: true });
}

export async function resolveConfig(options: GlobalOptions): Promise<StoredConfig> {
  const configPath = options.configFile ? resolve(options.configFile) : defaultConfigPath();
  const stored = await loadStoredConfig(configPath);
  const agentToken =
    options.agentToken ??
    process.env.ODYSHELL_AGENT_TOKEN ??
    options.agentKey ??
    process.env.ODYSHELL_AGENT_KEY ??
    stored?.agentToken ??
    stored?.agentKey;
  const adminKey = options.adminKey ?? process.env.ODYSHELL_ADMIN_KEY ?? stored?.adminKey;
  const workspaceId =
    options.workspaceId ??
    process.env.ODYSHELL_WORKSPACE_ID ??
    stored?.workspaceId;
  return {
    serverUrl:
      options.server ??
      process.env.ODYSHELL_URL ??
      process.env.ODYSHELL_SERVER_URL ??
      stored?.serverUrl ??
      "http://127.0.0.1:4100",
    ...(workspaceId ? { workspaceId } : {}),
    ...(agentToken ? { agentToken } : {}),
    ...(adminKey ? { adminKey } : {}),
  };
}
