import { createClerkClient } from "@clerk/backend";
import { decodeJwt } from "@clerk/backend/jwt";
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
  oauth?: RemoteMcpOauth;
};

export type RemoteMcpOauthIdentity = {
  userId: string;
  clientId: string;
  scopes: string[];
  organizationId: string;
  token: string;
};

export type RemoteMcpOauth = {
  authenticate(request: Request): Promise<RemoteMcpOauthIdentity | null>;
  applicationName(clientId: string): Promise<string | undefined>;
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

export function remoteMcpOrganizationId(
  verifiedToken: string,
  scopes: readonly string[],
): string | null {
  if (!scopes.includes("user:org:read")) return null;
  try {
    const organizationId = decodeJwt(verifiedToken).payload.org_id;
    return typeof organizationId === "string" && organizationId.startsWith("org_")
      ? organizationId
      : null;
  } catch {
    return null;
  }
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

export function remoteMcpAgentName(
  applicationName: string | undefined,
  userAgent: string | undefined,
): string {
  const source = `${applicationName ?? ""} ${userAgent ?? ""}`.toLowerCase();
  if (source.includes("chatgpt") || source.includes("openai")) return "ChatGPT";
  if (source.includes("claude") || source.includes("anthropic")) return "Claude";
  const candidate = applicationName?.trim();
  if (candidate && !/^(mcp agent|mcp client|mcp)$/i.test(candidate)) {
    return candidate;
  }
  return "MCP";
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
  const oauth: RemoteMcpOauth = dependencies.oauth ?? {
    async authenticate(webRequest) {
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
        return null;
      }
      const token = bearerToken(webRequest.headers.get("authorization") ?? undefined);
      if (!token) return null;
      const organizationId = remoteMcpOrganizationId(token, auth.scopes);
      if (!organizationId) return null;
      return {
        userId: auth.userId,
        clientId: auth.clientId,
        scopes: auth.scopes,
        organizationId,
        token,
      };
    },
    async applicationName(clientId) {
      try {
        return (await clerk.oauthApplications.get(clientId)).name;
      } catch {
        return undefined;
      }
    },
  };
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
        const identity = await oauth.authenticate(webRequest);
        if (!identity) {
          reply.header(
            "www-authenticate",
            `Bearer resource_metadata="${new URL("/.well-known/oauth-protected-resource", configuration.resource).href}"`,
          );
          return reply.code(401).send({ error: "oauth_token_required" });
        }
        const workspace = await resolveWorkspace(
          dependencies.database,
          request.params.workspaceId,
          identity.organizationId,
        );
        if (!workspace) {
          return reply.code(403).send({ error: "workspace_access_denied" });
        }
        const agentName = remoteMcpAgentName(
          await oauth.applicationName(identity.clientId),
          request.headers["user-agent"],
        );
        const installation = await dependencies.database.ensureMcpInstallation({
          workspaceId: workspace.workspaceId,
          userId: identity.userId,
          oauthClientId: identity.clientId,
          agentName,
        });
        if (!installation) {
          return reply.code(403).send({ error: "mcp_installation_revoked" });
        }
        const authInfo: AuthInfo = {
          token: identity.token,
          clientId: identity.clientId,
          scopes: identity.scopes,
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
  organizationId: string,
): Promise<McpWorkspaceRecord | null> {
  if (requestedWorkspaceId) {
    const workspace = await database.mcpWorkspace(requestedWorkspaceId);
    return workspace && workspace.organizationExternalId === organizationId
      ? workspace
      : null;
  }
  const workspaces = await database.mcpWorkspacesForOrganizations([organizationId]);
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
