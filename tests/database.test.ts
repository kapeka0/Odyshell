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
});
