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
