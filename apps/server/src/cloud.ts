import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { performance } from "node:perf_hooks";
import { z } from "zod";

export const cloudPlanIds = ["free", "team", "scale"] as const;
export const workspaceLoggingLevels = [
  "privacy-minimal",
  "operational",
  "diagnostic",
] as const;
export type WorkspaceLoggingLevel = (typeof workspaceLoggingLevels)[number];
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
  userName: z.string().trim().min(1).max(128).optional(),
  role: z.enum(["owner", "admin", "supervisor"]),
  organization: z.object({
    externalId: z.string().min(1).max(256),
    slug: z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9-]*$/),
    name: z.string().trim().min(1).max(200),
  }).strict(),
}).strict();

export const cloudUserSettingsSchema = cloudIdentitySchema.extend({
  timeZone: z.string().trim().min(1).max(128).refine(
    (timeZone) => {
      if (timeZone === "System") return true;
      try {
        new Intl.DateTimeFormat("en-US", { timeZone }).format();
        return true;
      } catch {
        return false;
      }
    },
    { message: "Invalid IANA time zone" },
  ),
}).strict();

export const cloudWorkspaceSettingsSchema = z.discriminatedUnion("section", [
  cloudIdentitySchema.extend({
    section: z.literal("details"),
    name: z.string().trim().min(1).max(96),
    avatarSeed: z.string().trim().min(1).max(128),
  }).strict(),
  cloudIdentitySchema.extend({
    section: z.literal("logging"),
    loggingLevel: z.enum(workspaceLoggingLevels),
  }).strict(),
]);

export const revokeCloudMachineSchema = cloudIdentitySchema.extend({
  machineId: z.string().uuid(),
});

export const updateCloudMachineSchema = cloudIdentitySchema
  .extend({
    machineId: z.string().uuid(),
    name: z.string().trim().min(1).max(128),
    description: z.string().trim().max(280),
  })
  .strict();

export const deleteCloudAgentSchema = cloudIdentitySchema.extend({
  agentId: z.string().uuid(),
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
  if (provided.toString("base64url") !== signature) {
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

export function privacySafeControlMetadata(
  metadata: Record<string, unknown>,
): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const key of ["revokedTasks", "deletedAgents"] as const) {
    const value = z.number().int().nonnegative().safeParse(metadata[key]);
    if (value.success) safe[key] = String(value.data);
  }
  const disconnected = z.boolean().safeParse(metadata.disconnected);
  if (disconnected.success) safe.disconnected = String(disconnected.data);
  return safe;
}

export function entitlementsFor(plan: string): PlanEntitlements {
  return planEntitlements[cloudPlanIds.includes(plan as CloudPlanId) ? plan as CloudPlanId : "free"];
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
    url.protocol !== "https:" &&
    !isLoopback(url)
  ) {
    throw new Error("ODYSHELL_WEB_URL must use HTTPS in production");
  }
  return url.origin;
}

function isLoopback(url: URL): boolean {
  return (
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]"
  );
}

export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, { count: number; resetsAt: number }>();
  private readonly expirations: Array<{ key: string; resetsAt: number }> = [];

  get trackedKeyCount(): number {
    return this.windows.size;
  }

  constructor(
    private readonly limit: number,
    private readonly windowMilliseconds: number,
    private readonly maxTrackedKeys = 10_000,
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError("Rate limit must be a positive safe integer");
    }
    if (!Number.isSafeInteger(windowMilliseconds) || windowMilliseconds < 1) {
      throw new RangeError("Rate-limit window must be a positive safe integer");
    }
    if (!Number.isSafeInteger(maxTrackedKeys) || maxTrackedKeys < 1) {
      throw new RangeError(
        "Tracked rate-limit key capacity must be a positive safe integer",
      );
    }
  }

  allow(key: string, now = monotonicMilliseconds()): boolean {
    const observedAt = this.prepare(now);
    if (observedAt === undefined || !this.canAllowPrepared(key)) return false;
    this.consumePrepared(key, observedAt);
    return true;
  }

  canAllow(key: string, now = monotonicMilliseconds()): boolean {
    if (this.prepare(now) === undefined) return false;
    return this.canAllowPrepared(key);
  }

  consume(key: string, now = monotonicMilliseconds()): void {
    const observedAt = this.prepare(now);
    if (observedAt === undefined || !this.canAllowPrepared(key)) return;
    this.consumePrepared(key, observedAt);
  }

  private prepare(now: number): number | undefined {
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      now > Number.MAX_SAFE_INTEGER - this.windowMilliseconds
    ) {
      return undefined;
    }
    this.pruneExpired(now);
    return now;
  }

  private pruneExpired(now: number): void {
    while (true) {
      const next = this.expirations[0];
      if (!next || next.resetsAt > now) return;
      const expired = this.removeNextExpiration();
      if (!expired) return;
      const current = this.windows.get(expired.key);
      if (current?.resetsAt === expired.resetsAt) {
        this.windows.delete(expired.key);
      }
    }
  }

  private canAllowPrepared(key: string): boolean {
    const current = this.windows.get(key);
    return current
      ? current.count < this.limit
      : this.windows.size < this.maxTrackedKeys;
  }

  private consumePrepared(key: string, now: number): void {
    const current = this.windows.get(key);
    if (!current) {
      const window = {
        count: 1,
        resetsAt: now + this.windowMilliseconds,
      };
      this.windows.set(key, window);
      this.addExpiration({ key, resetsAt: window.resetsAt });
      return;
    }
    current.count += 1;
  }

  private addExpiration(expiration: { key: string; resetsAt: number }): void {
    this.expirations.push(expiration);
    let index = this.expirations.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.expirations[parent]!.resetsAt <= expiration.resetsAt) break;
      this.expirations[index] = this.expirations[parent]!;
      index = parent;
    }
    this.expirations[index] = expiration;
  }

  private removeNextExpiration(): { key: string; resetsAt: number } | undefined {
    const first = this.expirations[0];
    const last = this.expirations.pop();
    if (!first || !last || this.expirations.length === 0) return first;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      if (left >= this.expirations.length) break;
      const right = left + 1;
      const child =
        right < this.expirations.length &&
        this.expirations[right]!.resetsAt < this.expirations[left]!.resetsAt
          ? right
          : left;
      if (this.expirations[child]!.resetsAt >= last.resetsAt) break;
      this.expirations[index] = this.expirations[child]!;
      index = child;
    }
    this.expirations[index] = last;
    return first;
  }
}

function monotonicMilliseconds(): number {
  return Math.floor(performance.now());
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

  allow(
    workspaceId: string,
    userId: string,
    now = monotonicMilliseconds(),
  ): boolean {
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
