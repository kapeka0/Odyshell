import {
  manualSessionHostShellCapabilities,
  manualSessionReadOnlyCapabilities,
  manualSessionSelectableCapabilities,
  type Capability,
} from "@odyshell/protocol";

export type ManualAccessPreset = "read-only";

export const manualReadOnlyCapabilities = manualSessionReadOnlyCapabilities;
export const manualHostShellCapabilities = manualSessionHostShellCapabilities;
export const manualSelectableCapabilities =
  manualSessionSelectableCapabilities;

const manualPresetCapabilities: Record<
  ManualAccessPreset,
  readonly Capability[]
> = {
  "read-only": manualSessionReadOnlyCapabilities,
};

export function capabilitiesForManualPreset(
  preset: ManualAccessPreset,
  locallyAllowed: readonly Capability[],
): Capability[] {
  return manualPresetCapabilities[preset].filter((capability) =>
    locallyAllowed.includes(capability),
  );
}

export function capabilitiesForHostShellSelection(
  locallyAllowed: readonly Capability[],
): Capability[] {
  return manualSessionHostShellCapabilities.filter((capability) =>
    locallyAllowed.includes(capability),
  );
}

export function toggleManualHostShellSelection(
  current: readonly Capability[],
  locallyAllowed: readonly Capability[],
  activePreset: ManualAccessPreset | null,
): Capability[] {
  if (current.includes("host.shell")) {
    return current.filter((capability) => capability !== "host.shell");
  }
  const hostShell = capabilitiesForHostShellSelection(locallyAllowed);
  if (hostShell.length === 0) return [...current];
  // The initial Read-only capabilities came from a convenience preset, not
  // from individual choices. Selecting Host Shell replaces that preset so it
  // never grants structured authority implicitly. Once a member customizes
  // the selection, independently chosen capabilities remain additive.
  return activePreset === "read-only"
    ? hostShell
    : [...new Set([...current, ...hostShell])];
}

export function manualSessionSelectionIsValid(
  capabilities: readonly Capability[],
  locallyAllowed: readonly Capability[],
): boolean {
  return (
    capabilities.length > 0 &&
    capabilities.every((capability) => locallyAllowed.includes(capability))
  );
}
