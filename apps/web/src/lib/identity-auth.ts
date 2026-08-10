import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { genericOAuth, jwt, organization } from "better-auth/plugins";
import { Pool } from "pg";
import { defaultOrganizationForUser } from "./default-organization";
import { identityConfiguration } from "./identity-config";
import {
  canAdministerOrganization,
  identityAccessControl,
  identityRole,
  identityRoles,
} from "./identity-permissions";

const oauthScopes = ["openid", "profile", "email", "offline_access", "odyshell:agent", "odyshell:cli"];

export function createOdyshellAuth(
  environment: NodeJS.ProcessEnv,
  providedDatabase?: Pool,
) {
  const configuration = identityConfiguration(environment);
  const database =
    providedDatabase ??
    new Pool({
      connectionString: configuration.databaseUrl,
      options: "-c search_path=public",
    });

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

  let createDefaultOrganization: (input: {
    userId: string;
    name: string;
    slug: string;
  }) => Promise<{ id: string }> = async () => {
    throw new Error("Odyshell Identity is not initialized");
  };

  const auth = betterAuth({
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
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            await defaultOrganizationForUser({
              database,
              userId: user.id,
              createOrganization: createDefaultOrganization,
            });
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            if (typeof session.activeOrganizationId === "string") return;
            const activeOrganizationId = await defaultOrganizationForUser({
              database,
              userId: session.userId,
              createOrganization: createDefaultOrganization,
            });
            return { data: { ...session, activeOrganizationId } };
          },
        },
      },
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
          const result = await database.query<{ exists: boolean }>(
            "select exists(select 1 from organization) as exists",
          );
          return !result.rows[0]?.exists;
        },
      }),
      jwt({ jwt: { issuer: configuration.baseUrl } }),
      ...(configuration.oidc
        ? [
            genericOAuth({
              config: [
                {
                  providerId: configuration.oidc.providerId,
                  clientId: configuration.oidc.clientId,
                  clientSecret: configuration.oidc.clientSecret,
                  discoveryUrl: configuration.oidc.discoveryUrl,
                  scopes: ["openid", "profile", "email"],
                  pkce: true,
                  requireIssuerValidation: true,
                },
              ],
            }),
          ]
        : []),
      oauthProvider({
        silenceWarnings: {
          oauthAuthServerConfig: true,
          openidConfig: true,
        },
        loginPage: "/sign-in",
        consentPage: "/oauth/consent",
        signup: { page: "/sign-up" },
        scopes: oauthScopes,
        // Better Auth 1.6 does not bind resource indicators to the original grant.
        // Keep one allow-listed resource until the stable 1.7 resource model is adopted.
        validAudiences: [configuration.mcpAudience],
        accessTokenExpiresIn: 15 * 60,
        m2mAccessTokenExpiresIn: 15 * 60,
        refreshTokenExpiresIn: 30 * 24 * 60 * 60,
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationDefaultScopes: ["openid", "profile", "email", "odyshell:agent", "odyshell:cli"],
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
        customAccessTokenClaims: async ({ referenceId, user }) => {
          if (!referenceId) return {};
          const role = user ? identityRole((await organizationRoleFor(user.id, referenceId)) ?? "") : null;
          return {
            organization_id: referenceId,
            ...(role ? { organization_role: role } : {}),
          };
        },
      }),
      nextCookies(),
    ],
  });

  createDefaultOrganization = async ({ userId, name, slug }) => {
    const organization = await auth.api.createOrganization({
      body: { userId, name, slug },
    });
    if (!organization?.id) throw new Error("Default Organization creation failed");
    return { id: organization.id };
  };

  return auth;
}
