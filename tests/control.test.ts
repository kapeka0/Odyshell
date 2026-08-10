import { describe, expect, it } from "vitest";
import {
  ControlLiveTokenReplayGuard,
  createControlLiveToken,
  controlLiveOriginDecision,
  controlIdentitySchema,
  controlUserSettingsSchema,
  controlOrganizationSettingsSchema,
  controlWebRequestDecision,
  controlWebKey,
  controlWebUrl,
  deleteControlAgentSchema,
  FixedWindowRateLimiter,
  privacySafeControlMetadata,
  revokeControlMachineSchema,
  ScopedConcurrencyLimiter,
  ScopedRateLimiter,
  updateControlMachineSchema,
  verifyControlLiveToken,
} from "../apps/server/src/control.js";
import { controlRouteIdentityDecision } from "../apps/web/src/lib/control-route-policy.js";

const identity = {
  userId: "user_123",
  role: "owner" as const,
  organization: { externalId: "org_123", slug: "acme", name: "Acme" },
};

describe("control control boundaries", () => {
  it("validates identity-bound settings without accepting tenant input", () => {
    expect(controlUserSettingsSchema.safeParse({
      ...identity,
      timeZone: "Europe/Madrid",
    }).success).toBe(true);
    expect(controlUserSettingsSchema.safeParse({
      ...identity,
      timeZone: "Mars/Olympus",
    }).success).toBe(false);
    expect(controlOrganizationSettingsSchema.safeParse({
      ...identity,
      section: "details",
      name: "Production",
      avatarSeed: "seed",
    }).success).toBe(true);
    expect(controlOrganizationSettingsSchema.safeParse({
      ...identity,
      section: "logging",
      loggingLevel: "operational",
      organizationId: "attacker-organization",
    }).success).toBe(false);
  });

  it("requires a signed-in Organization member for every web mutation", () => {
    expect(controlRouteIdentityDecision(null, null)).toBe("not_authenticated");
    expect(controlRouteIdentityDecision("user_123", null)).toBe(
      "organization_required",
    );
    expect(controlRouteIdentityDecision("user_123", "org_123")).toBe(
      "authorized",
    );
  });

  it("rejects malformed, incomplete, and overlong control identities", () => {
    expect(controlIdentitySchema.safeParse({
      userId: "user",
      role: "member",
      organization: { externalId: "org", slug: "acme", name: "Acme" },
    }).success).toBe(false);
    expect(controlIdentitySchema.safeParse({
      userId: "user",
      organization: { externalId: "org", slug: "acme", name: "Acme" },
    }).success).toBe(false);
    expect(controlIdentitySchema.safeParse({
      ...identity,
      organization: { ...identity.organization, slug: "../escape" },
    }).success).toBe(false);
  });

  it("binds Machine and Agent mutations to the authenticated identity", () => {
    const machineUpdate = {
      ...identity,
      machineId: "2dc24de7-ec0e-45b3-88c1-acbb900e51f8",
      name: "Build server",
      description: "Linux builder",
    };
    expect(updateControlMachineSchema.safeParse(machineUpdate).success).toBe(true);
    expect(updateControlMachineSchema.safeParse({
      ...machineUpdate,
      organizationId: "attacker-organization",
    }).success).toBe(false);
    expect(revokeControlMachineSchema.safeParse({
      ...identity,
      machineId: machineUpdate.machineId,
    }).success).toBe(true);
    expect(deleteControlAgentSchema.safeParse({
      ...identity,
      agentId: "21a970a0-d42a-44ab-bf3f-f0a5f2ada248",
      capabilities: ["host.shell"],
    }).success).toBe(false);
  });

  it("exposes only allowlisted scalar control metadata", () => {
    expect(privacySafeControlMetadata({
      revokedSessions: 3,
      deletedAgents: 2,
      disconnected: true,
      command: "cat /etc/shadow",
      stdout: "secret",
      kind: "process.exec",
    })).toEqual({
      revokedSessions: "3",
      deletedAgents: "2",
      disconnected: "true",
    });
    expect(privacySafeControlMetadata({
      revokedSessions: -1,
      deletedAgents: "2",
      disconnected: "yes",
    })).toEqual({});
  });

  it("fails closed on weak production web credentials and insecure origins", () => {
    expect(() =>
      controlWebKey({ NODE_ENV: "production", ODYSHELL_WEB_KEY: "short" }),
    ).toThrow(/32 characters/);
    expect(() => controlWebUrl({
      NODE_ENV: "production",
      ODYSHELL_WEB_URL: "http://app.example",
    }, true)).toThrow(/HTTPS/);
    expect(controlWebUrl({
      NODE_ENV: "production",
      ODYSHELL_WEB_URL: "https://app.example/ignored",
    }, true)).toBe("https://app.example");
    expect(controlWebUrl({
      NODE_ENV: "production",
      ODYSHELL_WEB_URL: "http://localhost:3000",
    }, true)).toBe("http://localhost:3000");
  });

  it("denies control mutations when the internal web credential is absent or wrong", () => {
    const key = "a-secure-internal-web-key-with-32-characters";
    expect(controlWebRequestDecision(undefined, key)).toBe("disabled");
    expect(controlWebRequestDecision(key, undefined)).toBe("unauthorized");
    expect(controlWebRequestDecision(key, "wrong-key")).toBe("unauthorized");
    expect(controlWebRequestDecision(key, key)).toBe("authorized");
  });

  it("keeps hosted credentials optional for self-hosted deployments", () => {
    expect(controlWebKey({ NODE_ENV: "production" })).toBeUndefined();
    expect(controlWebUrl({ NODE_ENV: "production" }, false)).toBeUndefined();
  });

  it("binds short-lived live streams and rejects expiry or signature changes", () => {
    const secret = "a-secure-internal-web-key-with-32-characters";
    const token = createControlLiveToken(
      secret,
      { organizationId: "organization-a", userId: "user-a" },
      1_000,
      60_000,
    );

    expect(verifyControlLiveToken(secret, token, 60_999)).toEqual({
      organizationId: "organization-a",
      userId: "user-a",
      expiresAt: 61_000,
      nonce: expect.stringMatching(/^[A-Za-z0-9_-]+$/u),
    });
    expect(verifyControlLiveToken(secret, token, 61_000)).toBeNull();
    expect(verifyControlLiveToken("different-key-with-at-least-32-characters", token, 2_000)).toBeNull();

    const [payload, signature] = token.slice("ods_live_".length).split(".");
    const changedSignature = `${signature![0] === "A" ? "B" : "A"}${signature!.slice(1)}`;
    expect(verifyControlLiveToken(
      secret,
      `ods_live_${payload}.${changedSignature}`,
      2_000,
    )).toBeNull();

    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const finalIndex = alphabet.indexOf(signature!.at(-1)!);
    const nonCanonicalSignature = signature!.slice(0, -1) + alphabet[finalIndex ^ 1];
    expect(Buffer.from(nonCanonicalSignature, "base64url")).toEqual(
      Buffer.from(signature!, "base64url"),
    );
    expect(verifyControlLiveToken(
      secret,
      `ods_live_${payload}.${nonCanonicalSignature}`,
      2_000,
    )).toBeNull();
  });

  it("rejects replayed live-stream tokens and releases expired replay state", () => {
    const guard = new ControlLiveTokenReplayGuard();
    const token = "ods_live_payload.signature";
    expect(guard.consume(token, 61_000, 1_000)).toBe(true);
    expect(guard.consume(token, 61_000, 1_001)).toBe(false);
    expect(guard.consume(token, 122_000, 61_000)).toBe(true);
  });

  it("bounds concurrent live resources by both Human and Organization", () => {
    const limiter = new ScopedConcurrencyLimiter(2, 1);
    expect(limiter.acquire("organization-a", "user-a")).toBe(true);
    expect(limiter.acquire("organization-a", "user-a")).toBe(false);
    expect(limiter.acquire("organization-a", "user-b")).toBe(true);
    expect(limiter.acquire("organization-a", "user-c")).toBe(false);
    limiter.release("organization-a", "user-a");
    expect(limiter.acquire("organization-a", "user-c")).toBe(true);
    limiter.release("organization-a", "user-a");
    expect(limiter.activeForOrganization("organization-a")).toBe(2);
  });

  it("accepts live streams only from the exact configured web origin", () => {
    expect(controlLiveOriginDecision(
      "https://odyshell.com",
      "https://odyshell.com",
    )).toBe("allowed");
    expect(controlLiveOriginDecision(
      "https://odyshell.com",
      "https://odyshell.com.attacker.test",
    )).toBe("denied");
    expect(controlLiveOriginDecision("https://odyshell.com", undefined)).toBe("denied");
    expect(controlLiveOriginDecision(undefined, "https://odyshell.com")).toBe("disabled");
  });

  it("bounds rate-limit state and releases expired keys", () => {
    const limiter = new FixedWindowRateLimiter(2, 1_000, 3);
    expect(limiter.allow("client-a", 1_000)).toBe(true);
    expect(limiter.allow("client-b", 1_000)).toBe(true);
    expect(limiter.allow("client-c", 1_000)).toBe(true);
    expect(limiter.allow("attacker", 1_001)).toBe(false);
    expect(limiter.allow("client-a", 1_001)).toBe(true);
    expect(limiter.trackedKeyCount).toBe(3);
    expect(limiter.allow("fresh-client", 2_000)).toBe(true);
    expect(limiter.trackedKeyCount).toBe(1);
  });

  it("fails closed on invalid rate-limit state and timestamps", () => {
    expect(() => new FixedWindowRateLimiter(0, 1_000)).toThrow(RangeError);
    expect(() => new FixedWindowRateLimiter(1, 0)).toThrow(RangeError);
    expect(() => new FixedWindowRateLimiter(1, 1_000, 0)).toThrow(RangeError);
    const limiter = new FixedWindowRateLimiter(1, 1_000);
    expect(limiter.allow("client", Number.NaN)).toBe(false);
    expect(limiter.allow("client", Number.POSITIVE_INFINITY)).toBe(false);
    expect(limiter.allow("client", Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(limiter.trackedKeyCount).toBe(0);
  });

  it("bounds credential issuance per Human and Organization", () => {
    const limiter = new ScopedRateLimiter(3, 2, 1_000);
    expect(limiter.allow("organization", "user-a", 1_000)).toBe(true);
    expect(limiter.allow("organization", "user-a", 1_001)).toBe(true);
    expect(limiter.allow("organization", "user-a", 1_002)).toBe(false);
    expect(limiter.allow("organization", "user-b", 1_003)).toBe(true);
    expect(limiter.allow("organization", "user-c", 1_004)).toBe(false);
    expect(limiter.allow("other", "user-c", 1_004)).toBe(true);
  });
});
