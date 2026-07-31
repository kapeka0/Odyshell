import {
  PROTOCOL_VERSION,
  type ClientRuntimeInfo,
} from "@odyshell/protocol";

export type ClientCompatibility = {
  compatible: boolean;
  upgradeRequired: boolean;
  clientVersion: string | null;
  protocolVersion: number | null;
};

export function clientCompatibility(
  runtime: unknown,
): ClientCompatibility {
  if (!isRuntimeInfo(runtime)) {
    return {
      compatible: true,
      upgradeRequired: false,
      clientVersion: null,
      protocolVersion: null,
    };
  }
  const protocolVersion = runtime.protocolVersion ?? null;
  const compatible =
    protocolVersion === null || protocolVersion === PROTOCOL_VERSION;
  return {
    compatible,
    upgradeRequired: !compatible,
    clientVersion: runtime.clientVersion ?? null,
    protocolVersion,
  };
}

function isRuntimeInfo(value: unknown): value is ClientRuntimeInfo {
  return typeof value === "object" && value !== null;
}
