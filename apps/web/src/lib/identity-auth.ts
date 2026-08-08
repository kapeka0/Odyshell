import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { jwt, organization } from "better-auth/plugins";
import { Pool } from "pg";
import { identityConfiguration } from "@/lib/identity-config";
import {
  canAdministerOrganization,
  identityAccessControl,
  identityRole,
  identityRoles,
} from "@/lib/identity-permissions";

const oauthScopes = ["openid", "profile", "email", "offline_access", "odyshell:agent"];

export function createOdyshellAuth(environment: NodeJS.ProcessEnv) {
  const configuration = identityConfiguration(environment);
  const database = new Pool({ connectionString: configuration.databaseUrl });

  async function organizationRoleFor(
    userId: string,
    organizationId: string,
  ): Promise<string | null> {
    const result = await database.query<{ role: string }>(
      'select role from member where "userId" = $1 and "organizationId" = $2 limit 1',
      [userId, organizationId],
    );
    return result.rows[0]?.role ?? null;
  }

  return betterAuth({
    appName: "Odyshell",
    baseURL: configuration.baseUrl,
    secret: configuration.secret,
    trustedOrigins: configuration.trustedOrigins,
    database,
    disabledPaths: ["/token"],
    advanced: {
      database: { generateId: "uuid" },
      useSecureCookies: configuration.baseUrl.startsWith("https://"),
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      autoSignIn: true,
      revokeSessionsOnPasswordReset: true,
    },
    ...(configuration.google
      ? { socialProviders: { google: configuration.google } }
      : {}),
    plugins: [
      organization({
        ac: identityAccessControl,
        roles: identityRoles,
        creatorRole: "owner",
        allowUserToCreateOrganization: async () => {
          if (configuration.deploymentMode === "cloud") return true;
          const result = await database.query<{ exists: boolean }>(
            "select exists(select 1 from organization) as exists",
          );
          return !result.rows[0]?.exists;
        },
      }),
      jwt({ jwt: { issuer: configuration.baseUrl } }),
      oauthProvider({
        silenceWarnings: {
          oauthAuthServerConfig: true,
          openidConfig: true,
        },
        loginPage: "/sign-in",
        consentPage: "/oauth/consent",
        signup: { page: "/sign-up" },
        scopes: oauthScopes,
        validAudiences: [configuration.baseUrl, configuration.mcpAudience],
        accessTokenExpiresIn: 15 * 60,
        m2mAccessTokenExpiresIn: 15 * 60,
        refreshTokenExpiresIn: 30 * 24 * 60 * 60,
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationDefaultScopes: ["openid", "profile", "email", "odyshell:agent"],
        clientRegistrationAllowedScopes: oauthScopes,
        clientCredentialGrantDefaultScopes: ["odyshell:agent"],
        postLogin: {
          page: "/onboarding",
          consentReferenceId: ({ session, scopes }) => {
            if (!scopes.includes("odyshell:agent")) return undefined;
            const organizationId = session.activeOrganizationId;
            if (typeof organizationId !== "string") {
              throw new Error("An active organization is required for Agent access");
            }
            return organizationId;
          },
          shouldRedirect: ({ session, scopes }) =>
            scopes.includes("odyshell:agent") &&
            typeof session.activeOrganizationId !== "string",
        },
        clientReference: ({ session }) => {
          const organizationId = session?.activeOrganizationId;
          return typeof organizationId === "string" ? organizationId : undefined;
        },
        clientPrivileges: async ({ action, user, session }) => {
          if (!user || !session) return action === "create";
          const organizationId = session.activeOrganizationId;
          if (typeof organizationId !== "string") return false;
          const role = identityRole(
            (await organizationRoleFor(user.id, organizationId)) ?? "",
          );
          return role ? canAdministerOrganization(role) : false;
        },
        customAccessTokenClaims: ({ referenceId }) =>
          referenceId ? { organization_id: referenceId } : {},
      }),
      nextCookies(),
    ],
  });
}
