import { describe, expect, it } from "vitest";
import { createEnrollmentToken } from "../apps/server/src/access.js";

describe("Machine enrollment credentials", () => {
  it("issues distinct high-entropy opaque tokens", () => {
    const tokens = [createEnrollmentToken(), createEnrollmentToken()];
    expect(new Set(tokens)).toHaveLength(2);
    for (const token of tokens) {
      expect(token).toMatch(/^ods_enroll_[A-Za-z0-9_-]{43}$/u);
    }
  });
});
