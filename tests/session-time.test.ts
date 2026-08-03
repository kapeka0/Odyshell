import { describe, expect, it } from "vitest";
import { formatSessionRemaining } from "../apps/web/src/lib/session-time.js";

describe("Session countdown", () => {
  const now = new Date("2026-08-03T12:00:00.000Z").getTime();

  it("shows a live-size remaining duration", () => {
    expect(formatSessionRemaining("2026-08-03T13:02:03.000Z", now)).toBe(
      "1h 02m 03s left",
    );
    expect(formatSessionRemaining("2026-08-03T12:04:05.000Z", now)).toBe(
      "4m 05s left",
    );
  });

  it("does not expose a negative countdown", () => {
    expect(formatSessionRemaining("2026-08-03T11:59:59.000Z", now)).toBe(
      "Expired",
    );
  });
});
