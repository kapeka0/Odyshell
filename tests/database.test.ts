import { describe, expect, it } from "vitest";
import { createDatabase } from "../apps/server/src/database.js";

describe("server storage boundaries", () => {
  it("requires PostgreSQL in every environment", () => {
    expect(() => createDatabase({ NODE_ENV: "production" })).toThrow(/DATABASE_URL/);
    expect(() =>
      createDatabase({
        NODE_ENV: "test",
        ODYSHELL_STORAGE: "memory",
      }),
    ).toThrow(/DATABASE_URL/);
  });

  it("does not accept the removed Convex configuration", () => {
    expect(() =>
      createDatabase({
        NODE_ENV: "production",
        CONVEX_URL: "https://example.convex.cloud",
        ODYSHELL_CONVEX_SERVICE_KEY: "not-used",
      }),
    ).toThrow(/DATABASE_URL/);
  });
});
