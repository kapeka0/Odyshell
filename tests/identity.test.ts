import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { identityConfiguration } from "../apps/web/src/lib/identity-config.js";
import {
  canAdministerOrganization,
  identityRole,
} from "../apps/web/src/lib/identity-permissions.js";

const validEnvironment = {
  DATABASE_URL: "postgresql://odyshell:odyshell@127.0.0.1:55432/odyshell",
  BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
  BETTER_AUTH_URL: "https://app.odyshell.test",
  ODYSHELL_MCP_URL: "https://mcp.odyshell.test/mcp",
};

describe("Odyshell Identity configuration", () => {
  it("ships the identity schema through the Server migration boundary", () => {
    const database = readFileSync("apps/server/src/database.ts", "utf8");
    const migration = database.slice(
      database.indexOf("async function migrateOdyshellIdentity("),
      database.indexOf("const migrationProvider"),
    );
    expect(database).toContain('"024_odyshell_identity"');
    expect(migration).toContain('create table public."user"');
    expect(migration).toContain('create table public."oauthClient"');
    expect(migration).toContain('create table public."jwks"');
    expect(migration).not.toMatch(/BETTER_AUTH_SECRET|clientSecret\s*=|privateKey\s*=/);
  });

  it("does not let Compose start its identity boundary with default secrets", () => {
    const compose = readFileSync("docker-compose.yml", "utf8");
    expect(compose).toContain("BETTER_AUTH_SECRET: ${BETTER_AUTH_SECRET:?");
    expect(compose).toContain("ODYSHELL_WEB_KEY: ${ODYSHELL_WEB_KEY:?");
    expect(compose).not.toContain("odyshell-local-identity-secret");
  });

  it("fails closed when production secrets or HTTPS are missing", () => {
    expect(() =>
      identityConfiguration({
        NODE_ENV: "production",
        DATABASE_URL: validEnvironment.DATABASE_URL,
        BETTER_AUTH_URL: validEnvironment.BETTER_AUTH_URL,
      }),
    ).toThrow("BETTER_AUTH_SECRET");
    expect(() =>
      identityConfiguration({
        ...validEnvironment,
        NODE_ENV: "production",
        BETTER_AUTH_URL: "http://app.odyshell.test",
      }),
    ).toThrow("HTTPS");
    expect(() =>
      identityConfiguration({
        ...validEnvironment,
        NODE_ENV: "production",
        ODYSHELL_MCP_URL: "http://mcp.odyshell.test/mcp",
      }),
    ).toThrow("ODYSHELL_MCP_URL");
  });

  it("requires PostgreSQL and paired Google credentials", () => {
    expect(() =>
      identityConfiguration({
        BETTER_AUTH_SECRET: validEnvironment.BETTER_AUTH_SECRET,
      }),
    ).toThrow("DATABASE_URL");
    expect(() =>
      identityConfiguration({
        ...validEnvironment,
        GOOGLE_CLIENT_ID: "google-client",
      }),
    ).toThrow("configured together");
  });

  it("normalizes trusted origins and defaults self-hosting safely", () => {
    const configuration = identityConfiguration({
      ...validEnvironment,
      ODYSHELL_AUTH_TRUSTED_ORIGINS:
        "https://console.odyshell.test/path,https://app.odyshell.test/duplicate",
    });
    expect(configuration.deploymentMode).toBe("self-hosted");
    expect(configuration.trustedOrigins).toEqual([
      "https://app.odyshell.test",
      "https://console.odyshell.test",
    ]);
    expect(configuration.mcpAudience).toBe("https://mcp.odyshell.test/mcp");
  });
});

describe("Odyshell Identity roles", () => {
  it("recognizes only the accepted human roles", () => {
    expect(identityRole("owner")).toBe("owner");
    expect(identityRole("admin")).toBe("admin");
    expect(identityRole("supervisor")).toBe("supervisor");
    expect(identityRole("member")).toBeNull();
    expect(identityRole("org:admin")).toBeNull();
  });

  it("keeps organization administration away from supervisors", () => {
    expect(canAdministerOrganization("owner")).toBe(true);
    expect(canAdministerOrganization("admin")).toBe(true);
    expect(canAdministerOrganization("supervisor")).toBe(false);
  });
});
