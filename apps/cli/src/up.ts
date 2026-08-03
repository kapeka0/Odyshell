import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  unlink,
} from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { normalizeServerUrl } from "@odyshell/client";
import { ExpectedError } from "./errors.js";

export type ClientUpConfiguration = {
  configPath: string;
  configExists: boolean;
  migratedFrom?: string;
};

export async function assertClientServerReachable(
  serverUrl: string,
  fetcher: typeof globalThis.fetch = globalThis.fetch,
): Promise<void> {
  const healthUrl = new URL("/health", normalizeServerUrl(serverUrl));
  let response: Response;
  try {
    response = await fetcher(healthUrl, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new ExpectedError(
      `Could not reach Odyshell Server at ${healthUrl.origin}: ${
        error instanceof Error ? error.message : String(error)
      }. Check this machine's Internet connection and DNS, then retry.`,
      "client_server_unreachable",
    );
  }
  if (!response.ok) {
    throw new ExpectedError(
      `Odyshell Server at ${healthUrl.origin} is unavailable (HTTP ${response.status}). Retry when the Server is healthy.`,
      "client_server_unavailable",
    );
  }
}

export async function resolveClientUpConfiguration(options: {
  serverUrl: string;
  explicitConfigPath?: string;
  profileName: string;
  legacyConfigPath: string;
  profileConfigPath: string;
}): Promise<ClientUpConfiguration> {
  let requestedServerUrl: string;
  try {
    requestedServerUrl = normalizeServerUrl(options.serverUrl);
  } catch (error) {
    throw new ExpectedError(
      error instanceof Error ? error.message : "Invalid server URL",
      "invalid_server_url",
    );
  }
  try {
    assertClientProfileName(options.profileName);
  } catch (error) {
    throw new ExpectedError(
      error instanceof Error ? error.message : "Invalid Client Profile",
      "invalid_client_profile",
    );
  }

  if (options.explicitConfigPath) {
    const configPath = resolve(options.explicitConfigPath);
    const existing = await identityFromConfig(configPath);
    if (!existing) {
      return { configPath, configExists: false };
    }
    assertSameServer(configPath, existing.serverUrl, requestedServerUrl);
    return { configPath, configExists: true };
  }

  const profileConfigPath = resolve(options.profileConfigPath);
  const profileIdentity = await identityFromConfig(profileConfigPath);
  const legacyConfigPath = resolve(options.legacyConfigPath);
  const legacyIdentity =
    options.profileName === "default"
      ? await identityFromConfig(legacyConfigPath)
      : undefined;
  if (profileIdentity && legacyIdentity) {
    throw new ExpectedError(
      `Both the legacy Client identity and the default Client Profile exist. Refusing to choose or overwrite either file. Remove one after verifying which machine identity is active.`,
      "client_profile_migration_conflict",
    );
  }
  if (profileIdentity) {
    if (
      profileIdentity.profileName &&
      profileIdentity.profileName !== options.profileName
    ) {
      throw new ExpectedError(
        `Client configuration at ${profileConfigPath} belongs to Profile "${profileIdentity.profileName}", not "${options.profileName}".`,
        "client_config_profile_mismatch",
      );
    }
    assertSameServer(
      profileConfigPath,
      profileIdentity.serverUrl,
      requestedServerUrl,
    );
    return { configPath: profileConfigPath, configExists: true };
  }
  if (!legacyIdentity) {
    return { configPath: profileConfigPath, configExists: false };
  }
  assertSameServer(
    legacyConfigPath,
    legacyIdentity.serverUrl,
    requestedServerUrl,
  );
  try {
    await mkdir(dirname(profileConfigPath), { recursive: true, mode: 0o700 });
    await copyFile(
      legacyConfigPath,
      profileConfigPath,
      constants.COPYFILE_EXCL,
    );
    await chmod(profileConfigPath, 0o600);
    await unlink(legacyConfigPath);
  } catch (error) {
    throw new ExpectedError(
      `Could not import the legacy Client identity into the default Profile: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "client_profile_migration_failed",
    );
  }
  return {
    configPath: profileConfigPath,
    configExists: true,
    migratedFrom: legacyConfigPath,
  };
}

function assertClientProfileName(profileName: string): void {
  if (
    !/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u.test(profileName)
  ) {
    throw new Error(
      "Client Profile name must contain 1-40 lowercase letters, numbers, or hyphens",
    );
  }
}

async function identityFromConfig(
  configPath: string,
): Promise<{ serverUrl: string; profileName?: string } | undefined> {
  let source: string;
  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  try {
    const parsed = JSON.parse(source) as {
      serverUrl?: unknown;
      profileName?: unknown;
    };
    if (typeof parsed.serverUrl !== "string" || !parsed.serverUrl) {
      throw new Error("serverUrl is missing");
    }
    if (
      parsed.profileName !== undefined &&
      typeof parsed.profileName !== "string"
    ) {
      throw new Error("profileName is invalid");
    }
    return {
      serverUrl: parsed.serverUrl,
      ...(parsed.profileName ? { profileName: parsed.profileName } : {}),
    };
  } catch (error) {
    throw new ExpectedError(
      `Client configuration at ${configPath} is invalid: ${
        error instanceof Error ? error.message : "invalid JSON"
      }`,
      "client_config_invalid",
    );
  }
}

function normalizedExistingServerUrl(
  configPath: string,
  serverUrl: string,
): string {
  try {
    return normalizeServerUrl(serverUrl);
  } catch {
    throw new ExpectedError(
      `Client configuration at ${configPath} contains an invalid server URL`,
      "client_config_invalid",
    );
  }
}

function assertSameServer(
  configPath: string,
  existingServerUrl: string,
  requestedServerUrl: string,
): void {
  if (
    normalizedExistingServerUrl(configPath, existingServerUrl) ===
    requestedServerUrl
  ) {
    return;
  }
  throw new ExpectedError(
    `Client configuration at ${configPath} belongs to another Odyshell server. Use a different "--config <path>" or omit --config to keep identities isolated automatically.`,
    "client_config_server_mismatch",
  );
}
