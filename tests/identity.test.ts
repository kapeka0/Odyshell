import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { identityConfiguration } from "../apps/web/src/lib/identity-config.js";
import {
  canAdministerOrganization,
  identityRole,
} from "../apps/web/src/lib/identity-permissions.js";
import { identityMigrationsEnabled } from "../apps/web/src/lib/identity-migrations.js";

const validEnvironment = {
  DATABASE_URL: "postgresql://odyshell:odyshell@127.0.0.1:55432/odyshell",
  BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
  BETTER_AUTH_URL: "https://app.odyshell.test",
  ODYSHELL_MCP_URL: "https://mcp.odyshell.test/mcp",
};

describe("Odyshell Identity configuration", () => {
  it("owns identity through Better Auth instead of the execution database", () => {
    const identity = readFileSync("apps/web/src/lib/identity-auth.ts", "utf8");
    const serverDatabase = readFileSync(
      "apps/server/src/control-database.ts",
      "utf8",
    );
    expect(identity).toContain("betterAuth({");
    expect(identity).toContain("organization({");
    expect(identity).toContain("oauthProvider({");
    expect(identity).toContain('options: "-c search_path=public"');
    expect(identity).toContain("jwt({ jwt: { issuer: configuration.baseUrl } })");
    expect(serverDatabase).not.toMatch(
      /create table public\."user"|create table[^;]*(?:oauthClient|jwks)/isu,
    );
    expect(serverDatabase).not.toMatch(/BETTER_AUTH_SECRET|clientSecret\s*=|privateKey\s*=/u);
  });

  it("migrates self-hosted identity on boot and exposes an explicit cloud runner", () => {
    const instrumentation = readFileSync("apps/web/src/instrumentation.ts", "utf8");
    const migrations = readFileSync(
      "apps/web/src/lib/identity-migrations.ts",
      "utf8",
    );
    const rootPackage = readFileSync("package.json", "utf8");
    expect(instrumentation).toContain("identityMigrationsEnabled(process.env)");
    expect(migrations).toContain('from "better-auth/db/migration"');
    expect(migrations).toContain("getMigrations(auth.options)");
    expect(migrations).toContain("pg_advisory_lock");
    expect(migrations).toContain('options: "-c search_path=public"');
    expect(migrations).toContain("await runMigrations()");
    expect(rootPackage).toContain('"migrate:identity"');
  });

  it("does not run schema writes in cloud serverless cold starts", () => {
    expect(
      identityMigrationsEnabled({ ODYSHELL_DEPLOYMENT_MODE: "cloud" }),
    ).toBe(false);
    expect(
      identityMigrationsEnabled({ ODYSHELL_DEPLOYMENT_MODE: "self-hosted" }),
    ).toBe(true);
    expect(
      identityMigrationsEnabled({
        ODYSHELL_DEPLOYMENT_MODE: "cloud",
        ODYSHELL_RUN_IDENTITY_MIGRATIONS: "true",
      }),
    ).toBe(true);
    expect(() =>
      identityMigrationsEnabled({
        ODYSHELL_RUN_IDENTITY_MIGRATIONS: "yes",
      }),
    ).toThrow("must be true or false");
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

  it("accepts only complete HTTPS OIDC discovery configuration", () => {
    expect(() =>
      identityConfiguration({ ...validEnvironment, OIDC_CLIENT_ID: "client" }),
    ).toThrow("must be configured together");
    expect(() =>
      identityConfiguration({
        ...validEnvironment,
        NODE_ENV: "production",
        OIDC_CLIENT_ID: "client",
        OIDC_CLIENT_SECRET: "secret",
        OIDC_DISCOVERY_URL: "http://identity.example.test/.well-known/openid-configuration",
      }),
    ).toThrow("OIDC_DISCOVERY_URL must use HTTPS");
    expect(identityConfiguration({
      ...validEnvironment,
      OIDC_CLIENT_ID: "client",
      OIDC_CLIENT_SECRET: "secret",
      OIDC_DISCOVERY_URL: "https://identity.example.test/.well-known/openid-configuration",
      OIDC_PROVIDER_ID: "customer_oidc",
    }).oidc).toEqual({
      clientId: "client",
      clientSecret: "secret",
      discoveryUrl: "https://identity.example.test/.well-known/openid-configuration",
      providerId: "customer_oidc",
    });
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
