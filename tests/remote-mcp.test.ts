import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  remoteMcpConfiguration,
  remoteMcpOriginAllowed,
} from "../apps/server/src/remote-mcp.js";

describe("remote MCP security boundary", () => {
  it("stays disabled unless every OAuth setting is present", () => {
    expect(remoteMcpConfiguration({ ODYSHELL_MCP_URL: "https://mcp.test/mcp" })).toBeNull();
  });

  it("requires HTTPS for the resource and issuer in production", () => {
    expect(() =>
      remoteMcpConfiguration({
        NODE_ENV: "production",
        ODYSHELL_MCP_URL: "http://mcp.test/mcp",
        CLERK_OAUTH_ISSUER: "https://clerk.test",
        CLERK_SECRET_KEY: "secret",
        CLERK_PUBLISHABLE_KEY: "public",
      }),
    ).toThrow("must use HTTPS");
  });

  it("matches browser origins exactly while allowing server clients without Origin", () => {
    const allowed = new Set(["https://odyshell.com"]);
    expect(remoteMcpOriginAllowed(undefined, allowed)).toBe(true);
    expect(remoteMcpOriginAllowed("https://odyshell.com", allowed)).toBe(true);
    expect(remoteMcpOriginAllowed("https://evil.odyshell.com", allowed)).toBe(false);
    expect(remoteMcpOriginAllowed("https://odyshell.com.evil.test", allowed)).toBe(false);
    expect(remoteMcpOriginAllowed("not a url", allowed)).toBe(false);
  });

  it("persists installation grants without OAuth or Session plaintext", async () => {
    const database = await readFile("apps/server/src/database.ts", "utf8");
    const migration = database.slice(
      database.indexOf("async function migrateRemoteMcp("),
      database.indexOf("async function rollbackRemoteMcp("),
    );
    expect(migration).toContain("mcp_installations");
    expect(migration).toContain("mcp_session_grants");
    expect(migration).not.toMatch(/access_token|refresh_token|session_token|token_hash/);
  });

  it("revokes remote grants when a Session is cancelled", async () => {
    const database = await readFile("apps/server/src/database.ts", "utf8");
    const cancellation = database.slice(
      database.indexOf("async cancelAgentSession("),
      database.indexOf("async failClaimedAgentSession("),
    );
    expect(cancellation).toContain('.updateTable("mcpSessionGrants")');
    expect(cancellation).toContain('status: "revoked"');
  });
});
