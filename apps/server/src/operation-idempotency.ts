import { createHash } from "node:crypto";
import type { OperationAction } from "@odyshell/protocol";
import {
  hasTransientOperationInput,
  persistedOperationAction,
} from "./operation-data.js";

export type OperationIdempotencyPayload = {
  machineId: string;
  action: OperationAction;
  timeoutSeconds: number;
  maxOutputBytes: number;
};

const PAYLOAD_FINGERPRINT_DOMAIN = "odyshell.operation.idempotency.v1\0";
const LEGACY_FINGERPRINT_DOMAIN = "odyshell.operation.idempotency.legacy.v1\0";
const KEY_HASH_DOMAIN = "odyshell.operation.idempotency-key.v1\0";

/**
 * Produces a stable JSON representation without retaining the source payload.
 * Object keys are sorted recursively so semantically identical parsed actions
 * have the same fingerprint regardless of property insertion order.
 */
function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Operation idempotency payload must contain finite numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((item) => (item === undefined ? "null" : canonicalJson(item)))
      .join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  throw new TypeError("Operation idempotency payload is not JSON-serializable");
}

export function operationIdempotencyFingerprint(
  payload: OperationIdempotencyPayload,
): string {
  const boundedPayload = {
    machineId: payload.machineId,
    // Host Shell env/stdin are deliberately excluded. Hashing those transient
    // values would persist a dictionary oracle for low-entropy secrets. The
    // idempotency key still identifies the first execution, so a retry with
    // changed transient input replays that result rather than dispatching it.
    action: persistedOperationAction(payload.action),
    hasTransientInput: hasTransientOperationInput(payload.action),
    timeoutSeconds: payload.timeoutSeconds,
    maxOutputBytes: payload.maxOutputBytes,
  };
  return createHash("sha256")
    .update(PAYLOAD_FINGERPRINT_DOMAIN)
    .update(canonicalJson(boundedPayload))
    .digest("hex");
}

/**
 * Existing rows predate payload fingerprints and cannot be verified safely,
 * especially when a Host Shell action originally carried transport-only
 * environment or stdin values. Give those rows a domain-separated fingerprint so a
 * retry fails closed instead of being mistaken for a matching payload.
 */
export function legacyOperationIdempotencyFingerprint(): string {
  return createHash("sha256")
    .update(LEGACY_FINGERPRINT_DOMAIN)
    .digest("hex");
}

/**
 * Reserves an opaque idempotency key after its Operation payload is purged.
 * The domain-separated digest is control metadata, never an authentication
 * credential, and prevents retaining caller-provided identifiers indefinitely.
 */
export function operationIdempotencyKeyHash(idempotencyKey: string): string {
  return createHash("sha256")
    .update(KEY_HASH_DOMAIN)
    .update(idempotencyKey)
    .digest("hex");
}
