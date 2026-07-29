import { describe, expect, it } from "vitest";
import {
  boundedSessionExpiry,
  developmentCredentialsEnabled,
} from "../apps/server/src/access.js";
import { parseDuration } from "../apps/cli/src/duration.js";

describe("temporary access", () => {
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

  it("accepts human durations while keeping bare seconds compatible", () => {
    expect(parseDuration("90")).toBe(90);
    expect(parseDuration("30s")).toBe(30);
    expect(parseDuration("15m")).toBe(900);
    expect(parseDuration("1h")).toBe(3_600);
    expect(parseDuration("2d")).toBe(172_800);
    expect(() => parseDuration("1.5h")).toThrow(/must be a duration/);
  });
});
