import {
  manualSessionCapabilities,
  manualSessionFullAccessCapabilities,
  manualSessionReadOnlyCapabilities,
  manualSessionShellCapabilities,
  type Capability,
} from "@odyshell/protocol";

export type ManualAccessPreset = "read-only" | "shell" | "full";

export { manualSessionCapabilities };
export const manualReadOnlyCapabilities = manualSessionReadOnlyCapabilities;

const manualPresetCapabilities: Record<
  ManualAccessPreset,
  readonly Capability[]
> = {
  "read-only": manualSessionReadOnlyCapabilities,
  shell: manualSessionShellCapabilities,
  full: manualSessionFullAccessCapabilities,
};

export function capabilitiesForManualPreset(
  preset: ManualAccessPreset,
  locallyAllowed: readonly Capability[],
): Capability[] {
  return manualPresetCapabilities[preset].filter((capability) =>
    locallyAllowed.includes(capability),
  );
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
