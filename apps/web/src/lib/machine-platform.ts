const platformLabels = {
  linux: "Linux",
  macos: "macOS",
  windows: "Windows",
} as const;

export function machinePlatform(runtime: unknown): string {
  if (!runtime || typeof runtime !== "object") return "Unknown";
  const hostPlatform = Reflect.get(runtime, "hostPlatform");
  if (typeof hostPlatform !== "string") return "Unknown";
  return platformLabels[hostPlatform as keyof typeof platformLabels] ?? "Unknown";
}

export function machinePrivilegeEscalation(
  runtime: unknown,
): "none" | "sudo" | "unknown" {
  if (!runtime || typeof runtime !== "object") return "unknown";
  const value = Reflect.get(runtime, "privilegeEscalation");
  if (value === "sudo" || value === "none") return value;
  return "unknown";
}
