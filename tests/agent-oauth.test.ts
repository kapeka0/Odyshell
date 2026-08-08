import { describe, expect, it } from "vitest";
import {
  agentOAuthConfiguration,
  agentOAuthIdentityFromClaims,
} from "../apps/server/src/agent-oauth.js";

describe("canonical Agent OAuth", () => {
  it("requires scope, Organization, client and subject claims", () => {
    const valid = {
      scope: "openid odyshell:agent",
      organization_id: "org-a",
      azp: "client-a",
      sub: "agent-subject",
    };
    expect(agentOAuthIdentityFromClaims(valid, "token")).toMatchObject({
      organizationId: "org-a",
      clientId: "client-a",
      subject: "agent-subject",
    });
    for (const claim of ["scope", "organization_id", "azp", "sub"] as const) {
      expect(agentOAuthIdentityFromClaims({ ...valid, [claim]: undefined }, "token")).toBeNull();
    }
  });

  it("fails closed when OAuth resource configuration is incomplete", () => {
    expect(agentOAuthConfiguration({})).toBeNull();
    expect(agentOAuthConfiguration({
      ODYSHELL_IDENTITY_ISSUER: "http://localhost:3000",
    })).toBeNull();
  });

  it("requires HTTPS for every production trust endpoint", () => {
    expect(() => agentOAuthConfiguration({
      NODE_ENV: "production",
      ODYSHELL_IDENTITY_ISSUER: "https://identity.example.com",
      ODYSHELL_IDENTITY_JWKS_URL: "http://keys.example.com/jwks",
      ODYSHELL_MCP_URL: "https://server.example.com/mcp",
    })).toThrow(/HTTPS/);
    expect(agentOAuthConfiguration({
      NODE_ENV: "production",
      ODYSHELL_IDENTITY_ISSUER: "https://identity.example.com",
      ODYSHELL_IDENTITY_JWKS_URL: "http://web:3000/api/auth/jwks",
      ODYSHELL_IDENTITY_JWKS_ALLOW_HTTP: "true",
      ODYSHELL_MCP_URL: "https://server.example.com/mcp",
    })).toMatchObject({
      issuer: new URL("https://identity.example.com"),
      jwks: new URL("http://web:3000/api/auth/jwks"),
    });
    expect(() => agentOAuthConfiguration({
      NODE_ENV: "production",
      ODYSHELL_IDENTITY_ISSUER: "http://identity.example.com",
      ODYSHELL_IDENTITY_JWKS_URL: "http://web:3000/api/auth/jwks",
      ODYSHELL_IDENTITY_JWKS_ALLOW_HTTP: "true",
      ODYSHELL_MCP_URL: "https://server.example.com/mcp",
    })).toThrow(/HTTPS/);
  });
});
