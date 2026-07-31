import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { z } from "zod";

export class EventSinkError extends Error {
  readonly expected = true;

  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "EventSinkError";
  }
}

export const eventSinkDetailLevels = [
  "privacy-minimal",
  "operational",
  "diagnostic",
] as const;
export type EventSinkDetailLevel = (typeof eventSinkDetailLevels)[number];

export const eventSinkConfigurationSchema = z
  .object({
    endpoint: z.string().url().max(2_048),
    detailLevel: z.enum(eventSinkDetailLevels).default("privacy-minimal"),
    signingSecret: z.string().min(32).max(256),
  })
  .strict();

type LookupResult = { address: string; family: 4 | 6 };
type Lookup = (
  hostname: string,
) => Promise<LookupResult[]>;

export type EventSinkDestination = {
  hostname: string;
  address: string;
  family: 4 | 6;
  port: number;
  path: string;
};

export async function eventSinkDestination(
  endpoint: string,
  lookup: Lookup = async (hostname) =>
    (await dnsLookup(hostname, { all: true, verbatim: true })) as LookupResult[],
): Promise<EventSinkDestination> {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw destinationDenied();
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hostname.toLowerCase() === "localhost"
  ) {
    throw destinationDenied();
  }
  let addresses: LookupResult[];
  try {
    addresses = isIP(url.hostname)
      ? [{
          address: url.hostname,
          family: isIP(url.hostname) as 4 | 6,
        }]
      : await lookup(url.hostname);
  } catch {
    throw destinationDenied();
  }
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => !isPublicAddress(address))
  ) {
    throw destinationDenied();
  }
  const selected = addresses[0]!;
  return {
    hostname: url.hostname,
    address: selected.address,
    family: selected.family,
    port: url.port ? Number(url.port) : 443,
    path: `${url.pathname}${url.search}`,
  };
}

function destinationDenied(): EventSinkError {
  return new EventSinkError(
    "Event Sink endpoints must use HTTPS and resolve only to public addresses.",
    "event_sink_destination_denied",
  );
}

function isPublicAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) {
    return isPublicAddress(normalized.slice(7));
  }
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b! >= 64 && b! <= 127) ||
      a! >= 224
    );
  }
  if (isIP(address) === 6) {
    return !(
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      /^fe[89ab]/u.test(normalized)
    );
  }
  return false;
}

export function encryptEventSinkSecret(
  secret: string,
  encodedKey: string,
): string {
  const key = encryptionKey(encodedKey);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    nonce.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptEventSinkSecret(
  value: string,
  encodedKey: string,
): string {
  const [version, nonce, tag, ciphertext, extra] = value.split(".");
  if (
    version !== "v1" ||
    !nonce ||
    !tag ||
    !ciphertext ||
    extra !== undefined
  ) {
    throw new Error("Invalid Event Sink secret envelope");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(encodedKey),
    Buffer.from(nonce, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function encryptionKey(encodedKey: string): Buffer {
  const key = Buffer.from(encodedKey, "base64url");
  if (key.length !== 32) {
    throw new EventSinkError(
      "ODYSHELL_EVENT_SINK_ENCRYPTION_KEY must be a base64url-encoded 32-byte key.",
      "event_sink_encryption_unavailable",
    );
  }
  return key;
}

const minimalKeys = new Set([
  "machineId",
  "machineIds",
  "status",
  "expiresAt",
  "predecessorSessionId",
  "executorAgentId",
  "requesterAgentId",
  "runId",
  "scopes",
]);
const alwaysSensitiveKey = /(?:token|secret|password|credential|authorization|cookie|env)/iu;
const diagnosticOnlyKey = /^(?:stdout|stderr|result|resultText)$/u;

export function redactTimelineMetadata(
  metadata: Record<string, unknown>,
  level: EventSinkDetailLevel,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (alwaysSensitiveKey.test(key)) continue;
    if (level === "privacy-minimal" && !minimalKeys.has(key)) continue;
    if (level === "operational" && diagnosticOnlyKey.test(key)) continue;
    result[key] = value;
  }
  return result;
}

export type TimelineExport = {
  version: "2026-07-31";
  sessionId: string;
  exportedAt: string;
  events: Array<Record<string, unknown>>;
};

export function signedTimelineDelivery(
  timeline: TimelineExport,
  secret: string,
  deliveryId: string,
  timestamp = new Date().toISOString(),
): {
  body: string;
  headers: Record<string, string>;
} {
  const body = JSON.stringify({
    specVersion: "ods.timeline.v1",
    deliveryId,
    timestamp,
    timeline,
  });
  const signature = createHmac("sha256", secret)
    .update(body)
    .digest("hex");
  return {
    body,
    headers: {
      "content-type": "application/json",
      "x-odyshell-delivery": deliveryId,
      "x-odyshell-timestamp": timestamp,
      "x-odyshell-signature": `v1=${signature}`,
    },
  };
}

export class EventSinkReplayGuard {
  private readonly seen = new Set<string>();

  consume(deliveryId: string): boolean {
    if (this.seen.has(deliveryId)) return false;
    this.seen.add(deliveryId);
    return true;
  }
}

export function verifyTimelineDeliverySignature(
  body: string,
  secret: string,
  signature: string,
): boolean {
  if (!signature.startsWith("v1=")) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(signature.slice(3), "hex");
  } catch {
    return false;
  }
  return (
    provided.length === expected.length &&
    timingSafeEqual(provided, expected)
  );
}

export function eventSinkRetryAt(
  attempts: number,
  now: number,
): number | undefined {
  if (attempts >= 6) return undefined;
  const delays = [1_000, 5_000, 30_000, 120_000, 300_000];
  return now + delays[Math.min(Math.max(attempts - 1, 0), 4)]!;
}

export async function postSignedTimeline(
  destination: EventSinkDestination,
  body: string,
  headers: Record<string, string>,
  timeoutMilliseconds = 5_000,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = httpsRequest(
      {
        protocol: "https:",
        hostname: destination.address,
        family: destination.family,
        port: destination.port,
        path: destination.path,
        method: "POST",
        servername: destination.hostname,
        headers: {
          ...headers,
          host: destination.hostname,
          "content-length": Buffer.byteLength(body),
        },
        timeout: timeoutMilliseconds,
      },
      (response) => {
        let received = 0;
        response.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > 64 * 1024) response.destroy();
        });
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          if (status >= 200 && status < 300) resolve();
          else reject(new EventSinkError("Event Sink rejected delivery.", `http_${status}`));
        });
      },
    );
    request.on("timeout", () => {
      request.destroy(
        new EventSinkError("Event Sink timed out.", "event_sink_timeout"),
      );
    });
    request.on("error", reject);
    request.end(body);
  });
}
