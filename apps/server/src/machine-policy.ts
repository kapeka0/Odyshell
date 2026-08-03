import {
  capabilitySchema,
  type Capability,
  type SessionMachineScope,
} from "@odyshell/protocol";

export function machineLocalCapabilities(runtime: unknown): Capability[] {
  if (!isRecord(runtime) || !Array.isArray(runtime.profiles)) return [];
  const profile =
    runtime.profiles.find(
      (candidate) => isRecord(candidate) && candidate.name === "default",
    ) ?? runtime.profiles.find(isRecord);
  if (!isRecord(profile) || !Array.isArray(profile.capabilities)) return [];
  return uniqueCapabilities(profile.capabilities);
}

export function effectiveMachineCapabilities(
  runtime: unknown,
  capabilityPolicy: unknown,
): Capability[] {
  const local = machineLocalCapabilities(runtime);
  if (capabilityPolicy === null || capabilityPolicy === undefined) return local;
  const enabled = new Set(uniqueCapabilities(capabilityPolicy));
  return local.filter((capability) => enabled.has(capability));
}

export function deniedMachineCapability(
  runtime: unknown,
  requested: Capability[],
): Capability | undefined {
  const available = new Set(machineLocalCapabilities(runtime));
  return requested.find((capability) => !available.has(capability));
}

export function machineScopesAllowed(
  machines: Array<{
    id: string;
    runtime: unknown;
    capabilityPolicy: unknown;
  }>,
  scopes: SessionMachineScope[],
): boolean {
  const byId = new Map(machines.map((machine) => [machine.id, machine]));
  return scopes.every((scope) => {
    const machine = byId.get(scope.machineId);
    if (!machine) return false;
    // A null policy means the Server has not added a second ceiling. The
    // Client still enforces its Local Policy when opening the Session.
    if (
      machine.capabilityPolicy === null ||
      machine.capabilityPolicy === undefined
    ) {
      return true;
    }
    const allowed = new Set(
      effectiveMachineCapabilities(machine.runtime, machine.capabilityPolicy),
    );
    return scope.capabilities.every((capability) => allowed.has(capability));
  });
}

function uniqueCapabilities(value: unknown): Capability[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.flatMap((candidate) => {
        const parsed = capabilitySchema.safeParse(candidate);
        return parsed.success ? [parsed.data] : [];
      }),
    ),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
