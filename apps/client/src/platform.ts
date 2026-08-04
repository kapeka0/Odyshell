import { homedir, userInfo } from "node:os";
import { posix, win32 } from "node:path";
import process from "node:process";
import type { HostPlatform } from "@odyshell/protocol";

export type SupportedNodePlatform = "linux" | "darwin" | "win32";

export type HostAccountShell = {
  program: string;
  argsForCommand: (command: string) => string[];
  windowsVerbatimArguments?: boolean;
};

export function hostAccountShell(
  platform: SupportedNodePlatform = process.platform as SupportedNodePlatform,
  environment: NodeJS.ProcessEnv = process.env,
  loginShell: string | null = userInfo().shell,
): HostAccountShell {
  if (platform === "win32") {
    return {
      program: environment.ComSpec ?? "cmd.exe",
      argsForCommand: (command) => ["/d", "/s", "/c", command],
      windowsVerbatimArguments: true,
    };
  }
  const program = loginShell || "/bin/sh";
  return {
    program,
    argsForCommand: (command) => ["-l", "-c", command],
  };
}

export function hostPlatform(platform: NodeJS.Platform = process.platform): HostPlatform {
  switch (platform) {
    case "linux":
      return "linux";
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      throw new Error(`Unsupported host platform: ${platform}`);
  }
}

export function clientConfigPathFor(
  platform: SupportedNodePlatform,
  home: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === "win32") {
    return win32.join(
      environment.APPDATA ?? win32.join(home, "AppData", "Roaming"),
      "Odyshell",
      "client.json",
    );
  }
  if (platform === "darwin") {
    return posix.join(home, "Library", "Application Support", "Odyshell", "client.json");
  }
  return posix.join(
    environment.XDG_CONFIG_HOME ?? posix.join(home, ".config"),
    "odyshell",
    "client.json",
  );
}

export function defaultClientConfigPath(): string {
  return clientConfigPathFor(process.platform as SupportedNodePlatform, homedir());
}

export function normalizeClientProfileName(profileName: string): string {
  const normalized = profileName.trim().toLowerCase();
  if (
    !/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u.test(normalized)
  ) {
    throw new Error(
      "Client Profile name must contain 1-40 lowercase letters, numbers, or hyphens",
    );
  }
  return normalized;
}

export function clientConfigPathForProfile(
  profileName: string,
  platform = process.platform as SupportedNodePlatform,
  home = homedir(),
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const normalized = normalizeClientProfileName(profileName);
  const legacyPath = clientConfigPathFor(platform, home, environment);
  const baseDirectory =
    platform === "win32" ? win32.dirname(legacyPath) : posix.dirname(legacyPath);
  return platform === "win32"
    ? win32.join(baseDirectory, "clients", normalized, "client.json")
    : posix.join(baseDirectory, "clients", normalized, "client.json");
}

export function normalizeServerUrl(serverUrl: string): string {
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    throw new Error("Server URL must be a valid HTTP or HTTPS URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Server URL must use HTTP or HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("Server URL must not contain credentials");
  }
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
  return url.toString().replace(/\/$/u, "");
}

export function containerUser(
  platform: NodeJS.Platform = process.platform,
  uid = process.getuid?.(),
  gid = process.getgid?.(),
): string {
  if (platform === "win32") return "1000:1000";
  return `${uid ?? 1000}:${gid ?? 1000}`;
}
