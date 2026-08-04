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
import type { OperationAction } from "@odyshell/protocol";
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
  "actorHumanId",
  "actorAgentId",
  "runId",
  "scopes",
  "kind",
  "exitCode",
  "errorCode",
  "correlationId",
  "outcome",
]);
const eventSinkMinimalKeys = new Set([
  "machineId",
  "machineIds",
  "status",
  "expiresAt",
  "predecessorSessionId",
  "executorAgentId",
  "requesterAgentId",
  "actorHumanId",
  "actorAgentId",
  "runId",
  "scopes",
  "kind",
  "exitCode",
  "errorCode",
  "correlationId",
  "outcome",
]);
const alwaysSensitiveKey = /(?:token|secret|password|credential|authorization|cookie|env|stdin)/iu;
const neverExportedKey = /^(?:env(?:ironment)?|stdin(?:Base64)?)$/iu;
const neverEventSinkContentKey =
  /^(?:command|program|args|stdout|stderr|summary|env(?:ironment)?|stdin(?:Base64)?)$/iu;
const secretValuePatterns = [
  /\b(?:bearer|basic)\s+[a-z0-9._~+/=-]+\b/giu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
  /\b(?:ods|sk|pk|gh[pousr]|github_pat|xox[baprs])[_-][a-z0-9_-]{12,}\b/giu,
  /\bAKIA[A-Z0-9]{16}\b/gu,
  /\bAIza[A-Za-z0-9_-]{20,}\b/gu,
  /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/giu,
];
const namedSecretValue =
  /\b((?:token|secret|password|passwd|authorization|cookie|api[-_ ]?key)\s*[:=]\s*)[^\s,;]+/giu;

export function operationTimelineMetadata(
  action: OperationAction,
): Record<string, unknown> {
  switch (action.kind) {
    case "process.exec":
      return {
        kind: action.kind,
        program: action.program,
        args: action.args,
        cwd: action.cwd,
      };
    case "host.shell":
      return {
        kind: action.kind,
        cwd: action.cwd,
        command: action.command,
      };
    case "fs.search":
      return {
        kind: action.kind,
        path: action.path,
        query: action.query,
        maxResults: action.maxResults,
      };
    case "docker.logs":
      return {
        kind: action.kind,
        container: action.container,
        tail: action.tail,
        timestamps: action.timestamps,
      };
    default:
      return {
        kind: action.kind,
        path: action.path,
      };
  }
}

const sensitiveFlag = /^(?:(?:--?)?(?:token|secret|password|passwd|authorization|api[-_]?key):?|-[pk])$/iu;
const sensitiveAssignment = /^((?:(?:--?)?(?:token|secret|password|passwd|authorization|api[-_]?key)|-[pk])\s*(?:=|:)).*$/iu;
const safeFlag = /^-{1,2}[a-z][a-z0-9-]*$/iu;
const safeCommandWord = new Set([
  "cat", "df", "docker", "find", "git", "grep", "head", "ls", "pwd",
  "status", "show", "list", "logs", "tail", "version", "where", "which",
]);

function sanitizeProgram(value: string): string {
  const basename = value.split(/[\\/]/u).at(-1) ?? "";
  return /^[a-z0-9._+-]{1,128}$/iu.test(basename)
    ? basename
    : "[REDACTED]";
}

function sanitizeArgument(argument: string): string {
  const assignment = sensitiveAssignment.exec(argument);
  if (assignment) return `${assignment[1]}[REDACTED]`;
  if (safeFlag.test(argument) || safeCommandWord.has(argument.toLowerCase())) {
    return argument;
  }
  if (/^--?[a-z][a-z0-9-]*=/iu.test(argument)) {
    return `${argument.slice(0, argument.indexOf("=") + 1)}[REDACTED]`;
  }
  return "[REDACTED]";
}

function sanitizeArgs(args: string[]): string[] {
  let redactNext = false;
  return args.map((argument) => {
    if (redactNext) {
      redactNext = false;
      return "[REDACTED]";
    }
    if (sensitiveFlag.test(argument)) {
      redactNext = true;
      return argument;
    }
    return sanitizeArgument(argument);
  });
}

export function privacyMinimalOperationMetadata(
  action: OperationAction,
): Record<string, unknown> {
  if (action.kind === "process.exec") {
    return {
      kind: action.kind,
      program: sanitizeProgram(action.program),
      args: sanitizeArgs(action.args),
    };
  }
  if (action.kind === "host.shell") {
    return { kind: action.kind };
  }
  // Privacy-minimal is an allowlist. Filesystem paths, search queries and
  // Docker container names can disclose customer data even without output.
  return { kind: action.kind };
}

const MAX_DIAGNOSTIC_STREAM_BYTES = 64 * 1024;

export function diagnosticTimelineMetadata(
  events: Array<{ stream: string; data: Uint8Array }>,
): Record<string, string> {
  const streams: Record<string, Buffer[]> = { stdout: [], stderr: [] };
  const sizes: Record<string, number> = { stdout: 0, stderr: 0 };
  for (const event of events) {
    if (event.stream !== "stdout" && event.stream !== "stderr") continue;
    const remaining = MAX_DIAGNOSTIC_STREAM_BYTES - sizes[event.stream]!;
    if (remaining <= 0) continue;
    const chunk = Buffer.from(event.data).subarray(0, remaining);
    streams[event.stream]!.push(chunk);
    sizes[event.stream] = sizes[event.stream]! + chunk.length;
  }
  return Object.fromEntries(
    Object.entries(streams)
      .filter(([, chunks]) => chunks.length > 0)
      .map(([stream, chunks]) => [
        stream,
        Buffer.concat(chunks).toString("utf8"),
      ]),
  );
}

export function redactTimelineMetadata(
  metadata: Record<string, unknown>,
  level: EventSinkDetailLevel,
): Record<string, unknown> {
  if (level === "diagnostic") return diagnosticExportMetadata(metadata);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (alwaysSensitiveKey.test(key)) continue;
    if (key === "summary") continue;
    if (level === "privacy-minimal" && !minimalKeys.has(key)) continue;
    result[key] = level === "privacy-minimal"
      ? privacyMinimalExportValue(key, value)
      : operationalExportValue(key, value);
  }
  return result;
}

export function redactEventSinkMetadata(
  metadata: Record<string, unknown>,
  level: EventSinkDetailLevel,
): Record<string, unknown> {
  const exportable = stripEventSinkContent(metadata) as Record<string, unknown>;
  if (level === "diagnostic") return diagnosticExportMetadata(exportable);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(exportable)) {
    if (alwaysSensitiveKey.test(key)) continue;
    if (key === "summary") continue;
    if (level === "privacy-minimal" && !eventSinkMinimalKeys.has(key)) continue;
    result[key] = level === "privacy-minimal"
      ? privacyMinimalExportValue(key, value)
      : operationalExportValue(key, value);
  }
  return result;
}

function stripEventSinkContent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripEventSinkContent);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !neverEventSinkContentKey.test(key))
      .map(([key, nested]) => [key, stripEventSinkContent(nested)]),
  );
}

function diagnosticExportMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(structuredClone(metadata)).filter(
      ([key]) => !neverExportedKey.test(key),
    ),
  );
}

function privacyMinimalExportValue(key: string, value: unknown): unknown {
  if (key !== "scopes" || !Array.isArray(value)) {
    return operationalExportValue(key, value);
  }
  return value.map((scope) => {
    if (!scope || typeof scope !== "object") return {};
    const candidate = scope as Record<string, unknown>;
    return {
      ...(typeof candidate.machineId === "string"
        ? { machineId: candidate.machineId }
        : {}),
      ...(Array.isArray(candidate.capabilities)
        ? {
            capabilities: candidate.capabilities.filter(
              (capability): capability is string => typeof capability === "string",
            ),
          }
        : {}),
    };
  });
}

function operationalExportValue(key: string, value: unknown): unknown {
  if (key === "command" && typeof value === "string") {
    return redactOperationalString(value);
  }
  if (key === "program" && typeof value === "string") {
    return redactOperationalString(value);
  }
  if (key === "args" && Array.isArray(value)) {
    return redactOperationalArgs(
      value.filter((item): item is string => typeof item === "string"),
    );
  }
  if (typeof value === "string") {
    return redactOperationalString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => operationalExportValue(key, item));
  }
  if (value && typeof value === "object") {
    return redactTimelineMetadata(value as Record<string, unknown>, "operational");
  }
  return value;
}

function redactOperationalString(value: string): string {
  return secretValuePatterns
    .reduce(
      (redacted, pattern) =>
        redacted.replace(pattern, (_match, prefix: string | undefined) =>
          typeof prefix === "string"
            ? `${prefix}[REDACTED]@`
            : "[REDACTED]",
        ),
      value,
    )
    .replace(namedSecretValue, "$1[REDACTED]");
}

function redactOperationalArgs(args: string[]): string[] {
  let redactNext = false;
  return args.map((argument) => {
    if (redactNext) {
      redactNext = false;
      return "[REDACTED]";
    }
    if (sensitiveFlag.test(argument)) {
      redactNext = true;
      return argument;
    }
    const assignment = sensitiveAssignment.exec(argument);
    if (assignment) return `${assignment[1]}[REDACTED]`;
    return redactOperationalString(argument);
  });
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
