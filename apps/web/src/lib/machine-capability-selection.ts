import type { Capability } from "@odyshell/protocol";

export function updateMachineCapabilitySelection(
  current: readonly Capability[],
  capability: Capability,
  selected: boolean,
): Capability[] {
  const unique = [...new Set(current)];

  if (capability === "host.shell") {
    return selected
      ? ["host.shell"]
      : unique.filter((value) => value !== "host.shell");
  }
  if (unique.includes("host.shell")) return unique;
  if (!selected) {
    return unique.filter((value) => value !== capability);
  }
  return [...new Set([...unique, capability])];
}
