import { describe, expect, it } from "vitest";
import {
  cloudIdentitySchema,
  cloudWebKey,
  cloudWebUrl,
  createDeviceUserCode,
  deviceApprovalDecision,
  deviceExchangeDecision,
  entitlementsFor,
  FixedWindowRateLimiter,
  normalizeDeviceUserCode,
} from "../apps/server/src/cloud.js";

describe("cloud identity and device authorization boundaries", () => {
  it("creates unambiguous, normalized eight-character user codes", () => {
    const code = createDeviceUserCode(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(normalizeDeviceUserCode(` ${code.toLowerCase()} `)).toHaveLength(8);
    expect(normalizeDeviceUserCode("ab-cd ef_gh")).toBe("ABCDEFGH");
  });

  it("rejects malformed or overlong cloud identities", () => {
    expect(
      cloudIdentitySchema.safeParse({
        userId: "user",
        organization: { externalId: "org", slug: "../escape", name: "Acme" },
      }).success,
    ).toBe(false);
    expect(
      cloudIdentitySchema.safeParse({
        userId: "",
        organization: { externalId: "org", slug: "acme", name: "Acme" },
      }).success,
    ).toBe(false);
  });

  it("fails closed on weak production web credentials and insecure origins", () => {
    expect(() =>
      cloudWebKey({ NODE_ENV: "production", ODYSHELL_WEB_KEY: "short" }),
    ).toThrow(/32 characters/);
    expect(() =>
      cloudWebUrl(
        {
          NODE_ENV: "production",
          ODYSHELL_WEB_URL: "http://app.example",
        },
        true,
      ),
    ).toThrow(/HTTPS/);
    expect(
      cloudWebUrl(
        {
          NODE_ENV: "production",
          ODYSHELL_WEB_URL: "https://app.example/ignored",
        },
        true,
      ),
    ).toBe("https://app.example");
  });

  it("keeps cloud auth optional for self-hosted deployments", () => {
    expect(cloudWebKey({ NODE_ENV: "production" })).toBeUndefined();
    expect(cloudWebUrl({ NODE_ENV: "production" }, false)).toBeUndefined();
    expect(entitlementsFor("unknown")).toEqual({
      machineLimit: 2,
      workspaceLimit: 1,
      activeAgentLimit: 3,
    });
  });

  it("rate-limits repeated device attempts and resets only after the window", () => {
    const limiter = new FixedWindowRateLimiter(2, 1_000);
    expect(limiter.allow("client", 1_000)).toBe(true);
    expect(limiter.allow("client", 1_100)).toBe(true);
    expect(limiter.allow("client", 1_200)).toBe(false);
    expect(limiter.allow("other", 1_200)).toBe(true);
    expect(limiter.allow("client", 2_000)).toBe(true);
  });

  it("rejects expired approval and prevents device-code replay", () => {
    const now = new Date("2026-07-30T10:00:00.000Z");
    const approved = {
      status: "approved",
      expiresAt: new Date("2026-07-30T10:10:00.000Z"),
      workspaceId: "workspace",
      userId: "user",
    };
    expect(deviceExchangeDecision(approved, now)).toBe("authorized");
    expect(deviceExchangeDecision({ ...approved, status: "consumed" }, now)).toBe(
      "consumed",
    );
    expect(
      deviceApprovalDecision(
        {
          ...approved,
          status: "pending",
          expiresAt: new Date("2026-07-30T09:59:59.000Z"),
        },
        now,
      ),
    ).toBe("expired");
    expect(
      deviceExchangeDecision({ ...approved, workspaceId: null }, now),
    ).toBe("consumed");
  });
});
