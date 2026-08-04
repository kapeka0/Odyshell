import {
  allCapabilities,
  capabilitySchema,
  type Capability,
} from "@odyshell/protocol";
import { ExpectedError } from "./errors.js";

export function parseCapabilities(value: string): Capability[] {
  const parsed = capabilitySchema
    .array()
    .min(1)
    .safeParse(
      [...new Set(value.split(/[,\s]+/u))].filter(Boolean),
    );
  if (!parsed.success) {
    throw new ExpectedError(
      `Invalid capabilities. Choose from: ${allCapabilities.join(", ")}`,
      "invalid_capabilities",
    );
  }
  return parsed.data;
}

export function warnForHostShell(
  capabilities: Capability[],
  write: (warning: string) => void = console.error,
): void {
  if (!capabilities.includes("host.shell")) return;
  write(
    "WARNING: host.shell runs native commands as the same operating-system user as the Odyshell Client and starts in that user's Home by default. A per-command cwd can choose another working directory, but cwd does not narrow that authority. Commands can access that user's files, credentials, network, and services. There is no sandbox or isolation, and changes may persist after the Session ends.",
  );
}
