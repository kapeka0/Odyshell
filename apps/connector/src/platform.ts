import { homedir } from "node:os";
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

export function connectorConfigPathFor(
  platform: SupportedNodePlatform,
  home: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === "win32") {
    return win32.join(
      environment.APPDATA ?? win32.join(home, "AppData", "Roaming"),
      "Odyshell",
      "connector.json",
    );
  }
  if (platform === "darwin") {
    return posix.join(home, "Library", "Application Support", "Odyshell", "connector.json");
  }
  return posix.join(
    environment.XDG_CONFIG_HOME ?? posix.join(home, ".config"),
    "odyshell",
    "connector.json",
  );
}

export function defaultConnectorConfigPath(): string {
  return connectorConfigPathFor(process.platform as SupportedNodePlatform, homedir());
}

export function containerUser(
  platform: NodeJS.Platform = process.platform,
  uid = process.getuid?.(),
  gid = process.getgid?.(),
): string {
  if (platform === "win32") return "1000:1000";
  return `${uid ?? 1000}:${gid ?? 1000}`;
}
