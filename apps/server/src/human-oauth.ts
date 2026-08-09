import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import { agentOAuthConfiguration } from "./agent-oauth.js";

export type HumanOAuthIdentity = {
  humanId: string;
  organizationId: string;
  role: "owner" | "admin" | "supervisor";
  clientId: string;
};

export type HumanOAuthAuthenticator = (
  authorization: string | undefined,
) => Promise<HumanOAuthIdentity | null>;

export function humanOAuthIdentityFromClaims(
  claims: Record<string, unknown>,
): HumanOAuthIdentity | null {
  const scopes = typeof claims.scope === "string" ? claims.scope.split(" ").filter(Boolean) : [];
  if (
    !scopes.includes("odyshell:cli") ||
    typeof claims.sub !== "string" ||
    typeof claims.azp !== "string" ||
    typeof claims.organization_id !== "string" ||
    !["owner", "admin", "supervisor"].includes(String(claims.organization_role))
  ) return null;
  return {
    humanId: claims.sub,
    clientId: claims.azp,
    organizationId: claims.organization_id,
    role: claims.organization_role as HumanOAuthIdentity["role"],
  };
}

export function createHumanOAuthAuthenticator(
  environment: NodeJS.ProcessEnv,
): HumanOAuthAuthenticator {
  const configuration = agentOAuthConfiguration(environment);
  if (!configuration) return async () => null;
  const resourceClient = oauthProviderResourceClient().getActions();
  return async (authorization) => {
    const token = authorization ? /^Bearer\s+(.+)$/iu.exec(authorization)?.[1] : undefined;
    if (!token) return null;
    try {
      const claims = await resourceClient.verifyAccessToken(token, {
        jwksUrl: configuration.jwks.href,
        scopes: ["odyshell:cli"],
        verifyOptions: {
          audience: configuration.audience.href,
          issuer: configuration.issuer.origin,
        },
      });
      return humanOAuthIdentityFromClaims(claims);
    } catch {
      return null;
    }
  };
}
