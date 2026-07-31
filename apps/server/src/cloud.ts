import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  agentTokenRequestSchema,
  capabilitySchema,
} from "@odyshell/protocol";
import { z } from "zod";

export const cloudPlanIds = ["free", "team", "scale"] as const;
export type CloudPlanId = (typeof cloudPlanIds)[number];

export type PlanEntitlements = {
  machineLimit: number;
  workspaceLimit: number;
  activeAgentLimit: number;
};

export const planEntitlements: Record<CloudPlanId, PlanEntitlements> = {
  free: {
    machineLimit: 2,
    workspaceLimit: 1,
    activeAgentLimit: 3,
  },
  team: {
    machineLimit: 10,
    workspaceLimit: 3,
    activeAgentLimit: 25,
  },
  scale: {
    machineLimit: 50,
    workspaceLimit: 10,
    activeAgentLimit: 100,
  },
};

export const cloudIdentitySchema = z.object({
  userId: z.string().min(1).max(256),
  organization: z.object({
    externalId: z.string().min(1).max(256),
    slug: z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9-]*$/),
    name: z.string().trim().min(1).max(200),
  }).strict(),
}).strict();

export const approveDeviceSchema = cloudIdentitySchema.extend({
  userCode: z.string().min(8).max(16),
});

export const sessionApprovalSchema = cloudIdentitySchema.extend({
  approvalCode: z
    .string()
    .min(32)
    .max(128)
    .regex(/^ods_approval_[A-Za-z0-9_-]+$/u),
});

export const createCloudAgentAccessSchema = cloudIdentitySchema.extend(
  agentTokenRequestSchema.shape,
);

export const revokeCloudAgentAccessSchema = cloudIdentitySchema.extend({
  tokenId: z.string().uuid(),
});

export const deleteCloudAgentAccessSchema = cloudIdentitySchema.extend({
  tokenId: z.string().uuid(),
});

export const revokeCloudMachineSchema = cloudIdentitySchema.extend({
  machineId: z.string().uuid(),
});

const cloudLiveClaimsSchema = z.object({
  workspaceId: z.string().min(1).max(128),
  userId: z.string().min(1).max(256),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/u),
  expiresAt: z.number().int().positive(),
}).strict();

export type CloudLiveClaims = z.infer<typeof cloudLiveClaimsSchema>;

const CLOUD_LIVE_TOKEN_PREFIX = "ods_live_";
const MAX_CLOUD_LIVE_TOKEN_LENGTH = 2_048;

export function createCloudLiveToken(
  secret: string,
  claims: Omit<CloudLiveClaims, "expiresAt" | "nonce">,
  now = Date.now(),
  lifetimeMilliseconds = 60_000,
): string {
  const payload = Buffer.from(
    JSON.stringify({
      ...claims,
      nonce: randomBytes(18).toString("base64url"),
      expiresAt: now + Math.max(1_000, Math.min(lifetimeMilliseconds, 60_000)),
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
  return `${CLOUD_LIVE_TOKEN_PREFIX}${payload}.${signature}`;
}

export function verifyCloudLiveToken(
  secret: string,
  token: string,
  now = Date.now(),
): CloudLiveClaims | null {
  if (
    token.length > MAX_CLOUD_LIVE_TOKEN_LENGTH ||
    !token.startsWith(CLOUD_LIVE_TOKEN_PREFIX)
  ) {
    return null;
  }
  const [payload, signature, extra] = token
    .slice(CLOUD_LIVE_TOKEN_PREFIX.length)
    .split(".");
  if (!payload || !signature || extra !== undefined) return null;
  const expected = createHmac("sha256", secret).update(payload).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return null;
  }
  try {
    const claims = cloudLiveClaimsSchema.parse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
    return claims.expiresAt > now ? claims : null;
  } catch {
    return null;
  }
}

export function cloudLiveOriginDecision(
  configuredOrigin: string | undefined,
  requestOrigin: string | undefined,
): "allowed" | "denied" | "disabled" {
  if (!configuredOrigin) return "disabled";
  return requestOrigin === configuredOrigin ? "allowed" : "denied";
}

export class CloudLiveTokenReplayGuard {
  private readonly usedUntil = new Map<string, number>();

  consume(token: string, expiresAt: number, now = Date.now()): boolean {
    for (const [digest, expiry] of this.usedUntil) {
      if (expiry <= now) this.usedUntil.delete(digest);
    }
    const digest = createHash("sha256").update(token).digest("base64url");
    if (this.usedUntil.has(digest)) return false;
    this.usedUntil.set(digest, expiresAt);
    return true;
  }
}

export class ScopedConcurrencyLimiter {
  private readonly workspaces = new Map<string, number>();
  private readonly users = new Map<string, number>();

  constructor(
    private readonly workspaceLimit: number,
    private readonly userLimit: number,
  ) {}

  acquire(workspaceId: string, userId: string): boolean {
    const userKey = `${workspaceId}:${userId}`;
    const workspaceCount = this.workspaces.get(workspaceId) ?? 0;
    const userCount = this.users.get(userKey) ?? 0;
    if (
      workspaceCount >= this.workspaceLimit ||
      userCount >= this.userLimit
    ) {
      return false;
    }
    this.workspaces.set(workspaceId, workspaceCount + 1);
    this.users.set(userKey, userCount + 1);
    return true;
  }

  release(workspaceId: string, userId: string): void {
    const userKey = `${workspaceId}:${userId}`;
    if (!this.users.has(userKey)) return;
    decrementOrDelete(this.users, userKey);
    decrementOrDelete(this.workspaces, workspaceId);
  }

  activeForWorkspace(workspaceId: string): number {
    return this.workspaces.get(workspaceId) ?? 0;
  }
}

function decrementOrDelete(counts: Map<string, number>, key: string): void {
  const count = counts.get(key);
  if (!count) return;
  if (count === 1) {
    counts.delete(key);
  } else {
    counts.set(key, count - 1);
  }
}

export const startDeviceAuthorizationSchema = z.object({
  clientName: z.string().trim().min(1).max(120).default("Odyshell CLI"),
});

export const exchangeDeviceAuthorizationSchema = z.object({
  deviceCode: z.string().min(32).max(128),
});

const userCodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function createDeviceUserCode(bytes = randomBytes(8)): string {
  let code = "";
  for (let index = 0; index < 8; index += 1) {
    code += userCodeAlphabet[bytes[index]! % userCodeAlphabet.length];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function normalizeDeviceUserCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function privacySafeControlMetadata(
  metadata: Record<string, unknown>,
): Record<string, string> {
  const safe: Record<string, string> = {};
  const kind = capabilitySchema.safeParse(metadata.kind);
  if (kind.success) safe.kind = kind.data;
  const reason = controlEventReasonSchema.safeParse(metadata.reason);
  if (reason.success) safe.reason = reason.data;
  const machineId = z.string().uuid().safeParse(metadata.machineId);
  if (machineId.success) {
    safe.machineId = machineId.data;
  }
  return safe;
}

type WorkspaceConnection = {
  id: string;
  machineId: string;
  principalId: string;
  status: string;
};

export function cloudConnectionView(
  connection: WorkspaceConnection,
  agentName: string,
): {
  id: string;
  machineId: string;
  agentId: string;
  agentName: string;
  status: string;
} {
  return {
    id: connection.id,
    machineId: connection.machineId,
    agentId: connection.principalId,
    agentName,
    status: connection.status,
  };
}

const controlEventReasonSchema = z.enum([
  "agent_request",
  "agent_token_revoked",
  "capability_scope",
  "client_rejected",
  "expired",
  "machine_revoked",
  "machine_scope",
  "session_capability",
]);

export function entitlementsFor(plan: string): PlanEntitlements {
  return planEntitlements[cloudPlanIds.includes(plan as CloudPlanId) ? plan as CloudPlanId : "free"];
}

type DeviceAuthorizationState = {
  status: string;
  expiresAt: Date;
  workspaceId: string | null;
  userId: string | null;
};

export function deviceApprovalDecision(
  authorization: DeviceAuthorizationState | null,
  now = new Date(),
): "approved" | "expired" | "invalid" | "already_used" {
  if (!authorization) return "invalid";
  if (authorization.expiresAt <= now) return "expired";
  return authorization.status === "pending" ? "approved" : "already_used";
}

export function deviceExchangeDecision(
  authorization: DeviceAuthorizationState | null,
  now = new Date(),
): "authorized" | "consumed" | "denied" | "expired" | "invalid" | "pending" {
  if (!authorization) return "invalid";
  if (authorization.expiresAt <= now) return "expired";
  if (authorization.status === "pending") return "pending";
  if (authorization.status === "denied") return "denied";
  if (
    authorization.status !== "approved" ||
    !authorization.workspaceId ||
    !authorization.userId
  ) {
    return "consumed";
  }
  return "authorized";
}

export function cloudWebKey(environment: NodeJS.ProcessEnv): string | undefined {
  const value = environment.ODYSHELL_WEB_KEY;
  if (!value) return undefined;
  if (environment.NODE_ENV === "production" && value.length < 32) {
    throw new Error("ODYSHELL_WEB_KEY must contain at least 32 characters in production");
  }
  return value;
}

export function cloudWebRequestDecision(
  expected: string | undefined,
  provided: string | undefined,
): "authorized" | "disabled" | "unauthorized" {
  if (!expected) return "disabled";
  if (!provided) return "unauthorized";
  const expectedDigest = createHash("sha256").update(expected).digest();
  const providedDigest = createHash("sha256").update(provided).digest();
  return timingSafeEqual(expectedDigest, providedDigest)
    ? "authorized"
    : "unauthorized";
}

export function cloudWebUrl(
  environment: NodeJS.ProcessEnv,
  cloudEnabled: boolean,
): string | undefined {
  if (!cloudEnabled) return undefined;
  const value = environment.ODYSHELL_WEB_URL ??
    (environment.NODE_ENV === "production" ? undefined : "http://localhost:3000");
  if (!value) {
    throw new Error("ODYSHELL_WEB_URL is required when cloud authentication is enabled");
  }
  const url = new URL(value);
  if (
    environment.NODE_ENV === "production" &&
    url.protocol !== "https:"
  ) {
    throw new Error("ODYSHELL_WEB_URL must use HTTPS in production");
  }
  return url.origin;
}

export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, { count: number; resetsAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMilliseconds: number,
  ) {}

  allow(key: string, now = Date.now()): boolean {
    if (!this.canAllow(key, now)) return false;
    this.consume(key, now);
    return true;
  }

  canAllow(key: string, now = Date.now()): boolean {
    const current = this.windows.get(key);
    return !current || current.resetsAt <= now || current.count < this.limit;
  }

  consume(key: string, now = Date.now()): void {
    const current = this.windows.get(key);
    if (!current || current.resetsAt <= now) {
      this.windows.set(key, {
        count: 1,
        resetsAt: now + this.windowMilliseconds,
      });
      return;
    }
    current.count += 1;
  }
}

export class ScopedRateLimiter {
  private readonly workspaceLimiter: FixedWindowRateLimiter;
  private readonly userLimiter: FixedWindowRateLimiter;

  constructor(
    workspaceLimit: number,
    userLimit: number,
    windowMilliseconds: number,
  ) {
    this.workspaceLimiter = new FixedWindowRateLimiter(
      workspaceLimit,
      windowMilliseconds,
    );
    this.userLimiter = new FixedWindowRateLimiter(
      userLimit,
      windowMilliseconds,
    );
  }

  allow(workspaceId: string, userId: string, now = Date.now()): boolean {
    const userKey = `${workspaceId}:${userId}`;
    if (
      !this.userLimiter.canAllow(userKey, now) ||
      !this.workspaceLimiter.canAllow(workspaceId, now)
    ) {
      return false;
    }
    this.userLimiter.consume(userKey, now);
    this.workspaceLimiter.consume(workspaceId, now);
    return true;
  }
}
