import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

  it("serializes agent deletion with session creation and scopes both by workspace", () => {
    const database = readFileSync(
      resolve(process.cwd(), "apps/server/src/database.ts"),
      "utf8",
    );
    const deletion = database.slice(
      database.indexOf("async deleteAgentToken("),
      database.indexOf("async expireAgentSessions("),
    );
    const creation = database.slice(
      database.indexOf("async createSession("),
      database.indexOf("async getSession("),
    );

    expect(deletion).toContain("this.db.transaction()");
    expect(deletion).toContain('.where("workspaceId", "=", workspaceId)');
    expect(deletion).toContain('.where("deletedAt", "is", null)');
    expect(deletion.indexOf('.updateTable("agentTokens")')).toBeLessThan(
      deletion.indexOf('.updateTable("sessions")'),
    );
    expect(creation).toContain("this.db.transaction()");
    expect(creation).toContain('.where("workspaceId", "=", input.workspaceId)');
    expect(creation).toContain('.where("revokedAt", "is", null)');
    expect(creation).toContain('.where("deletedAt", "is", null)');
    expect(creation).toContain(".forShare()");
  });
});
