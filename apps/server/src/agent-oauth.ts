import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";

export type AgentOAuthIdentity = {
  subject: string;
  clientId: string;
  organizationId: string;
  scopes: string[];
  token: string;
};

type AgentOAuthConfiguration = {
  issuer: URL;
  jwks: URL;
  audience: URL;
};

export function agentOAuthConfiguration(
  environment: NodeJS.ProcessEnv,
): AgentOAuthConfiguration | null {
  const issuer = environment.ODYSHELL_IDENTITY_ISSUER;
  const audience = environment.ODYSHELL_MCP_URL;
  if (!issuer || !audience) return null;
  const issuerUrl = new URL(issuer);
  const audienceUrl = new URL(audience);
  const jwksUrl = new URL(
    environment.ODYSHELL_IDENTITY_JWKS_URL ?? "/api/auth/jwks",
    issuerUrl,
  );
  if (
    environment.NODE_ENV === "production" &&
    [issuerUrl, audienceUrl, jwksUrl].some(
      (url) => url.protocol !== "https:" && !isLoopback(url),
    )
  ) {
    throw new Error("Agent OAuth URLs must use HTTPS in production");
  }
  return { issuer: issuerUrl, jwks: jwksUrl, audience: audienceUrl };
}

export function agentOAuthIdentityFromClaims(
  claims: Record<string, unknown>,
  token: string,
): AgentOAuthIdentity | null {
  const scopes = typeof claims.scope === "string"
    ? claims.scope.split(" ").filter(Boolean)
    : [];
  if (
    !scopes.includes("odyshell:agent") ||
    typeof claims.organization_id !== "string" ||
    claims.organization_id.length === 0 ||
    typeof claims.azp !== "string" ||
    claims.azp.length === 0 ||
    typeof claims.sub !== "string" ||
    claims.sub.length === 0
  ) {
    return null;
  }
  return {
    subject: claims.sub,
    clientId: claims.azp,
    organizationId: claims.organization_id,
    scopes,
    token,
  };
}

export type AgentOAuthAuthenticator = (
  authorization: string | undefined,
) => Promise<AgentOAuthIdentity | null>;

export function createAgentOAuthAuthenticator(
  environment: NodeJS.ProcessEnv,
): AgentOAuthAuthenticator {
  const configuration = agentOAuthConfiguration(environment);
  if (!configuration) return async () => null;
  const resourceClient = oauthProviderResourceClient().getActions();
  return async (authorization) => {
    const token = bearerToken(authorization);
    if (!token) return null;
    try {
      const claims = await resourceClient.verifyAccessToken(token, {
        jwksUrl: configuration.jwks.href,
        scopes: ["odyshell:agent"],
        verifyOptions: {
          audience: configuration.audience.href,
          issuer: configuration.issuer.origin,
        },
      });
      return agentOAuthIdentityFromClaims(claims, token);
    } catch {
      return null;
    }
  };
}

function bearerToken(authorization: string | undefined): string | undefined {
  return authorization ? /^Bearer\s+(.+)$/i.exec(authorization)?.[1] : undefined;
}

function isLoopback(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}
