import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { normalizeServerUrl } from "@odyshell/client";
import { ExpectedError } from "./errors.js";

export type ClientUpConfiguration = {
  configPath: string;
  configExists: boolean;
};

export async function resolveClientUpConfiguration(options: {
  serverUrl: string;
  explicitConfigPath?: string;
  legacyConfigPath: string;
  instanceConfigPath: string;
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

  if (options.explicitConfigPath) {
    const configPath = resolve(options.explicitConfigPath);
    const existingServerUrl = await serverUrlFromConfig(configPath);
    if (!existingServerUrl) {
      return { configPath, configExists: false };
    }
    assertSameServer(configPath, existingServerUrl, requestedServerUrl);
    return { configPath, configExists: true };
  }

  const legacyConfigPath = resolve(options.legacyConfigPath);
  const legacyServerUrl = await serverUrlFromConfig(legacyConfigPath);
  if (
    legacyServerUrl &&
    normalizedExistingServerUrl(legacyConfigPath, legacyServerUrl) ===
      requestedServerUrl
  ) {
    return { configPath: legacyConfigPath, configExists: true };
  }

  const instanceConfigPath = resolve(options.instanceConfigPath);
  const instanceServerUrl = await serverUrlFromConfig(instanceConfigPath);
  if (!instanceServerUrl) {
    return { configPath: instanceConfigPath, configExists: false };
  }
  assertSameServer(instanceConfigPath, instanceServerUrl, requestedServerUrl);
  return { configPath: instanceConfigPath, configExists: true };
}

async function serverUrlFromConfig(
  configPath: string,
): Promise<string | undefined> {
  let source: string;
  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  try {
    const parsed = JSON.parse(source) as { serverUrl?: unknown };
    if (typeof parsed.serverUrl !== "string" || !parsed.serverUrl) {
      throw new Error("serverUrl is missing");
    }
    return parsed.serverUrl;
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
