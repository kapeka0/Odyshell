import type { Capability } from "@odyshell/protocol";

export function executionWarningState(
  capabilities: readonly Capability[],
  privilegeEscalation: "none" | "sudo" | "unknown",
): { hostShell: boolean; rootAccess: boolean } {
  const hostShell = capabilities.includes("host.shell");
  const rootCapableExecution = capabilities.some(
    (capability) =>
      capability === "host.shell" || capability.startsWith("process."),
  );
  return {
    hostShell,
    rootAccess: privilegeEscalation === "sudo" && rootCapableExecution,
  };
}
