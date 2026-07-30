import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";
import process from "node:process";
import type { HostPlatform } from "@odyshell/protocol";

export type SupportedNodePlatform = "linux" | "darwin" | "win32";

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

export function clientConfigPathForServer(
  serverUrl: string,
  platform = process.platform as SupportedNodePlatform,
  home = homedir(),
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const normalized = normalizeServerUrl(serverUrl);
  const url = new URL(normalized);
  const hostname = url.hostname
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-|-$/gu, "")
    .slice(0, 40) || "server";
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 12);
  const legacyPath = clientConfigPathFor(platform, home, environment);
  const legacyDirectory =
    platform === "win32" ? win32.dirname(legacyPath) : posix.dirname(legacyPath);
  const clientsDirectory =
    platform === "win32"
      ? win32.join(legacyDirectory, "clients")
      : posix.join(legacyDirectory, "clients");
  const instanceDirectory = `${hostname}-${digest}`;

  return platform === "win32"
    ? win32.join(clientsDirectory, instanceDirectory, "client.json")
    : posix.join(clientsDirectory, instanceDirectory, "client.json");
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
