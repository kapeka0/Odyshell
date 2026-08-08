import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import {
  createMcpHandler,
  type AuthInfo,
} from "@modelcontextprotocol/server";
import {
  createAgenticMcpServer,
  type AgenticMcpRuntime,
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
  jwks: URL;
  allowedOrigins: Set<string>;
};

export type RemoteMcpDependencies = {
  database: Database;
  agenticRuntime(installation: McpInstallationRecord): Promise<AgenticMcpRuntime>;
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
  const issuer = environment.ODYSHELL_IDENTITY_ISSUER;
  if (!resource || !issuer) return null;
  const resourceUrl = new URL(resource);
  const issuerUrl = new URL(issuer);
  const jwksUrl = new URL(
    environment.ODYSHELL_IDENTITY_JWKS_URL ?? "/api/auth/jwks",
    issuerUrl,
  );
  const allowInternalHttpJwks =
    environment.ODYSHELL_IDENTITY_JWKS_ALLOW_HTTP === "true";
  if (
    environment.NODE_ENV === "production" &&
    ([resourceUrl, issuerUrl].some(
      (url) => url.protocol !== "https:" && !isLoopback(url),
    ) ||
      (jwksUrl.protocol !== "https:" &&
        !isLoopback(jwksUrl) &&
        !allowInternalHttpJwks))
  ) {
    throw new Error("Remote MCP URLs must use HTTPS in production");
  }
  return {
    resource: resourceUrl,
    issuer: issuerUrl,
    jwks: jwksUrl,
    allowedOrigins: new Set(
      (environment.ODYSHELL_MCP_ALLOWED_ORIGINS ?? resourceUrl.origin)
        .split(",")
        .map((origin) => new URL(origin.trim()).origin),
    ),
  };
}

function isLoopback(url: URL): boolean {
  return (
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]"
  );
}

export function remoteMcpIdentityFromClaims(
  claims: Record<string, unknown>,
  token: string,
): RemoteMcpOauthIdentity | null {
  const scopes = typeof claims.scope === "string" ? claims.scope.split(" ").filter(Boolean) : [];
  const organizationId = claims.organization_id;
  const clientId = claims.azp;
  if (
    !scopes.includes("odyshell:agent") ||
    typeof organizationId !== "string" ||
    organizationId.length === 0 ||
    typeof clientId !== "string" ||
    clientId.length === 0
  ) {
    return null;
  }
  return {
    userId: typeof claims.sub === "string" ? claims.sub : `agent:${clientId}`,
    clientId,
    scopes,
    organizationId,
    token,
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
  const resourceClient = oauthProviderResourceClient().getActions();
  const oauth: RemoteMcpOauth = dependencies.oauth ?? {
    async authenticate(webRequest) {
      const token = bearerToken(webRequest.headers.get("authorization") ?? undefined);
      if (!token) return null;
      try {
        const claims = await resourceClient.verifyAccessToken(token, {
          jwksUrl: configuration.jwks.href,
          scopes: ["odyshell:agent"],
          verifyOptions: {
            audience: configuration.resource.href,
            issuer: configuration.issuer.origin,
          },
        });
        return remoteMcpIdentityFromClaims(claims, token);
      } catch {
        return null;
      }
    },
    async applicationName() { return undefined; },
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
      const report = (error: unknown) => app.log.error(error, "Remote MCP tool failed");
      return createAgenticMcpServer(
        await dependencies.agenticRuntime(installation),
        report,
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
    scopes_supported: ["odyshell:agent"],
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
        if (installation?.status === "agent_limit_reached") {
          return reply.code(409).send({
            error: "agent_limit_reached",
            details: {
              activeAgentLimit: installation.activeAgentLimit,
              plan: installation.plan,
            },
          });
        }
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
