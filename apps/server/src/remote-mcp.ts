import { createClerkClient } from "@clerk/backend";
import {
  createMcpHandler,
  type AuthInfo,
} from "@modelcontextprotocol/server";
import {
  createApprovedMcpServer,
  type ApprovedMcpRuntime,
} from "@odyshell/mcp";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type {
  Database,
  McpInstallationRecord,
  McpWorkspaceRecord,
} from "./database.js";

type RemoteMcpConfiguration = {
  resource: URL;
  issuer: URL;
  allowedOrigins: Set<string>;
  secretKey: string;
  publishableKey: string;
};

export type RemoteMcpDependencies = {
  database: Database;
  runtime(installation: McpInstallationRecord): ApprovedMcpRuntime;
};

export function remoteMcpConfiguration(
  environment: NodeJS.ProcessEnv,
): RemoteMcpConfiguration | null {
  const resource = environment.ODYSHELL_MCP_URL;
  const issuer = environment.CLERK_OAUTH_ISSUER;
  const secretKey = environment.CLERK_SECRET_KEY;
  const publishableKey = environment.CLERK_PUBLISHABLE_KEY;
  if (!resource || !issuer || !secretKey || !publishableKey) return null;
  const resourceUrl = new URL(resource);
  const issuerUrl = new URL(issuer);
  if (
    environment.NODE_ENV === "production" &&
    (resourceUrl.protocol !== "https:" || issuerUrl.protocol !== "https:")
  ) {
    throw new Error("Remote MCP URLs must use HTTPS in production");
  }
  return {
    resource: resourceUrl,
    issuer: issuerUrl,
    secretKey,
    publishableKey,
    allowedOrigins: new Set(
      (environment.ODYSHELL_MCP_ALLOWED_ORIGINS ?? resourceUrl.origin)
        .split(",")
        .map((origin) => new URL(origin.trim()).origin),
    ),
  };
}

export function remoteMcpOriginAllowed(
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  if (!origin) return true;
  try {
    return allowedOrigins.has(new URL(origin).origin);
  } catch {
    return false;
  }
}

export function registerRemoteMcp(
  app: FastifyInstance,
  environment: NodeJS.ProcessEnv,
  dependencies: RemoteMcpDependencies,
): void {
  const configuration = remoteMcpConfiguration(environment);
  if (!configuration) {
    app.log.info("Remote MCP disabled because OAuth configuration is incomplete");
    return;
  }
  const clerk = createClerkClient({
    secretKey: configuration.secretKey,
    publishableKey: configuration.publishableKey,
  });
  const handler = createMcpHandler(
    async (context) => {
      const installationId = context.authInfo?.extra?.installationId;
      if (typeof installationId !== "string") {
        throw new Error("MCP installation context is missing");
      }
      const installation = context.authInfo?.extra?.installation;
      if (!isMcpInstallation(installation)) {
        throw new Error("MCP installation is unavailable");
      }
      return createApprovedMcpServer(
        dependencies.runtime(installation),
        (error) => app.log.error(error, "Remote MCP tool failed"),
      );
    },
    {
      legacy: "stateless",
      responseMode: "json",
      onerror: (error) => app.log.error(error, "Remote MCP request failed"),
    },
  );

  const metadata = {
    resource: configuration.resource.href,
    resource_name: "Odyshell",
    authorization_servers: [configuration.issuer.origin],
    bearer_methods_supported: ["header"],
    scopes_supported: ["openid", "profile", "email", "user:org:read"],
  };
  app.get("/.well-known/oauth-protected-resource", async () => metadata);
  app.get("/.well-known/oauth-protected-resource/mcp", async () => metadata);

  for (const url of ["/mcp", "/mcp/:workspaceId"]) {
    app.route<{ Params: { workspaceId?: string } }>({
      method: ["GET", "POST", "DELETE"],
      url,
      async handler(request, reply) {
        if (
          !remoteMcpOriginAllowed(
            request.headers.origin,
            configuration.allowedOrigins,
          )
        ) {
          return reply.code(403).send({ error: "origin_denied" });
        }
        const webRequest = fastifyWebRequest(request, configuration.resource);
        const state = await clerk.authenticateRequest(webRequest, {
          acceptsToken: "oauth_token",
        });
        const auth = state.toAuth();
        if (
          !auth.isAuthenticated ||
          auth.tokenType !== "oauth_token" ||
          !auth.userId ||
          !auth.clientId
        ) {
          reply.header(
            "www-authenticate",
            `Bearer resource_metadata="${new URL("/.well-known/oauth-protected-resource", configuration.resource).href}"`,
          );
          return reply.code(401).send({ error: "oauth_token_required" });
        }
        const memberships = await clerk.users.getOrganizationMembershipList({
          userId: auth.userId,
          limit: 100,
        });
        const workspace = await resolveWorkspace(
          dependencies.database,
          request.params.workspaceId,
          memberships.data.map((membership) => membership.organization.id),
        );
        if (!workspace) {
          return reply.code(403).send({ error: "workspace_access_denied" });
        }
        let agentName = "MCP Agent";
        try {
          const application = await clerk.oauthApplications.get(auth.clientId);
          agentName = application.name;
        } catch {
          // Dynamically registered clients may not expose an application record.
        }
        const installation = await dependencies.database.ensureMcpInstallation({
          workspaceId: workspace.workspaceId,
          userId: auth.userId,
          oauthClientId: auth.clientId,
          agentName,
        });
        if (!installation) {
          return reply.code(403).send({ error: "mcp_installation_revoked" });
        }
        const bearer = bearerToken(request.headers.authorization);
        if (!bearer) return reply.code(401).send({ error: "oauth_token_required" });
        const authInfo: AuthInfo = {
          token: bearer,
          clientId: auth.clientId,
          scopes: auth.scopes,
          resource: configuration.resource,
          extra: { installationId: installation.id, installation },
        };
        const response = await handler.fetch(webRequest, {
          authInfo,
          parsedBody: request.body,
        });
        reply.code(response.status);
        response.headers.forEach((value, name) => reply.header(name, value));
        return reply.send(Buffer.from(await response.arrayBuffer()));
      },
    });
  }
}

async function resolveWorkspace(
  database: Database,
  requestedWorkspaceId: string | undefined,
  organizationIds: string[],
): Promise<McpWorkspaceRecord | null> {
  if (requestedWorkspaceId) {
    const workspace = await database.mcpWorkspace(requestedWorkspaceId);
    return workspace && organizationIds.includes(workspace.organizationExternalId)
      ? workspace
      : null;
  }
  const workspaces = await database.mcpWorkspacesForOrganizations(organizationIds);
  return workspaces.length === 1 ? workspaces[0]! : null;
}

function fastifyWebRequest(request: FastifyRequest, resource: URL): Request {
  const url = new URL(request.url, resource.origin);
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  return new Request(url, {
    method: request.method,
    headers,
    ...(hasBody && request.body !== undefined
      ? { body: JSON.stringify(request.body) }
      : {}),
  });
}

function bearerToken(authorization: string | undefined): string | null {
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length).trim();
  return token || null;
}

function isMcpInstallation(value: unknown): value is McpInstallationRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { workspaceId?: unknown }).workspaceId === "string" &&
    typeof (value as { agentId?: unknown }).agentId === "string"
  );
}
