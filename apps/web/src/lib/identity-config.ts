import { z } from "zod";

const urlSchema = z.string().url();

export type IdentityConfiguration = {
  baseUrl: string;
  databaseUrl: string;
  deploymentMode: "cloud" | "self-hosted";
  google?: { clientId: string; clientSecret: string };
  mcpAudience: string;
  secret: string;
  trustedOrigins: string[];
};

export function identityConfiguration(
  environment: NodeJS.ProcessEnv,
): IdentityConfiguration {
  const production = environment.NODE_ENV === "production";
  const baseUrl = urlSchema.parse(
    environment.BETTER_AUTH_URL ??
      (production ? undefined : "http://localhost:3000"),
  );
  const parsedBaseUrl = new URL(baseUrl);
  if (production && parsedBaseUrl.protocol !== "https:" && !isLoopback(parsedBaseUrl)) {
    throw new Error("BETTER_AUTH_URL must use HTTPS in production");
  }

  const databaseUrl = environment.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required for Odyshell Identity");

  const configuredSecret = environment.BETTER_AUTH_SECRET?.trim();
  const secret =
    configuredSecret ??
    (production
      ? undefined
      : "odyshell-development-identity-secret-only");
  if (!secret || secret.length < 32) {
    throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters");
  }

  const googleClientId = environment.GOOGLE_CLIENT_ID?.trim();
  const googleClientSecret = environment.GOOGLE_CLIENT_SECRET?.trim();
  if (Boolean(googleClientId) !== Boolean(googleClientSecret)) {
    throw new Error(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured together",
    );
  }

  const extraOrigins = (environment.ODYSHELL_AUTH_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => new URL(value).origin);
  const mcpAudience = new URL(
    environment.ODYSHELL_MCP_URL ?? "/mcp",
    parsedBaseUrl,
  );
  if (production && mcpAudience.protocol !== "https:" && !isLoopback(mcpAudience)) {
    throw new Error("ODYSHELL_MCP_URL must use HTTPS in production");
  }

  return {
    baseUrl: parsedBaseUrl.origin,
    databaseUrl,
    deploymentMode:
      environment.ODYSHELL_DEPLOYMENT_MODE === "cloud"
        ? "cloud"
        : "self-hosted",
    mcpAudience: mcpAudience.href,
    secret,
    trustedOrigins: [...new Set([parsedBaseUrl.origin, ...extraOrigins])],
    ...(googleClientId && googleClientSecret
      ? { google: { clientId: googleClientId, clientSecret: googleClientSecret } }
      : {}),
  };
}

function isLoopback(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}
