import { describe, expect, it } from "vitest";
import {
  boundedSessionExpiry,
  createOpaqueToken,
  developmentCredentialsEnabled,
  serverAdminKey,
} from "../apps/server/src/access.js";
import { parseDuration } from "../apps/cli/src/duration.js";

describe("temporary access", () => {
  it("generates distinct 256-bit opaque tokens with ods prefixes", () => {
    const enrollmentTokens = [createOpaqueToken("enroll"), createOpaqueToken("enroll")];
    const agentTokens = [createOpaqueToken("agent"), createOpaqueToken("agent")];

    for (const token of enrollmentTokens) {
      expect(token).toMatch(/^ods_enroll_[A-Za-z0-9_-]{43}$/);
      expect(token).not.toContain("ody_enroll_");
    }
    for (const token of agentTokens) {
      expect(token).toMatch(/^ods_agent_[A-Za-z0-9_-]{43}$/);
      expect(token).not.toContain("ody_agent_");
    }
    expect(new Set([...enrollmentTokens, ...agentTokens]).size).toBe(4);
  });

  it("never lets a session outlive its agent token", () => {
    const now = new Date("2026-07-29T10:00:00.000Z");
    const tokenExpiresAt = new Date("2026-07-29T10:05:00.000Z");

    expect(boundedSessionExpiry(now, 3_600, tokenExpiresAt)).toEqual(tokenExpiresAt);
    expect(boundedSessionExpiry(now, 60, tokenExpiresAt)).toEqual(
      new Date("2026-07-29T10:01:00.000Z"),
    );
    expect(boundedSessionExpiry(now, 60, null)).toEqual(
      new Date("2026-07-29T10:01:00.000Z"),
    );
  });

  it("only enables development credentials outside production or by explicit opt-in", () => {
    expect(developmentCredentialsEnabled({ NODE_ENV: "development" })).toBe(true);
    expect(developmentCredentialsEnabled({ NODE_ENV: "production" })).toBe(false);
    expect(
      developmentCredentialsEnabled({
        NODE_ENV: "production",
        ODYSHELL_ALLOW_DEV_CREDENTIALS: "true",
      }),
    ).toBe(true);
  });

  it("requires an explicit secure admin key in production", () => {
    expect(serverAdminKey({ NODE_ENV: "development" })).toBe("dev-admin-key");
    expect(
      serverAdminKey({
        NODE_ENV: "production",
        ODYSHELL_ADMIN_KEY: "production-secret",
      }),
    ).toBe("production-secret");
    expect(() => serverAdminKey({ NODE_ENV: "production" })).toThrow(
      /ODYSHELL_ADMIN_KEY/,
    );
    expect(() =>
      serverAdminKey({
        NODE_ENV: "production",
        ODYSHELL_ADMIN_KEY: "dev-admin-key",
      }),
    ).toThrow(/ODYSHELL_ADMIN_KEY/);
  });

  it("accepts human durations while keeping bare seconds compatible", () => {
    expect(parseDuration("90")).toBe(90);
    expect(parseDuration("30s")).toBe(30);
    expect(parseDuration("15m")).toBe(900);
    expect(parseDuration("1h")).toBe(3_600);
    expect(parseDuration("2d")).toBe(172_800);
    expect(() => parseDuration("1.5h")).toThrow(/must be a duration/);
  });
});
