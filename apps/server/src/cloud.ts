import { randomBytes } from "node:crypto";
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
  }),
});

export const approveDeviceSchema = cloudIdentitySchema.extend({
  userCode: z.string().min(8).max(16),
});

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
    const current = this.windows.get(key);
    if (!current || current.resetsAt <= now) {
      this.windows.set(key, {
        count: 1,
        resetsAt: now + this.windowMilliseconds,
      });
      return true;
    }
    if (current.count >= this.limit) return false;
    current.count += 1;
    return true;
  }
}
