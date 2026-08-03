import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovedMcpRuntime } from "../packages/mcp/src/index.js";
import type { Database } from "../apps/server/src/database.js";
import type { ClientGateway } from "../apps/server/src/gateway.js";
import { ScopedRateLimiter } from "../apps/server/src/cloud.js";
import { createRemoteMcpRuntime } from "../apps/server/src/remote-mcp-runtime.js";
import {
  registerRemoteMcp,
  remoteMcpConfiguration,
  remoteMcpOrganizationId,
  remoteMcpOriginAllowed,
  type RemoteMcpOauth,
} from "../apps/server/src/remote-mcp.js";

const apps: Array<ReturnType<typeof Fastify>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("remote MCP security boundary", () => {
  it("stays disabled unless every OAuth setting is present", () => {
    expect(remoteMcpConfiguration({ ODYSHELL_MCP_URL: "https://mcp.test/mcp" })).toBeNull();
  });

  it("requires HTTPS for the resource and issuer in production", () => {
    expect(() =>
      remoteMcpConfiguration({
        NODE_ENV: "production",
        ODYSHELL_MCP_URL: "http://mcp.test/mcp",
        CLERK_OAUTH_ISSUER: "https://clerk.test",
        CLERK_SECRET_KEY: "secret",
        CLERK_PUBLISHABLE_KEY: "public",
      }),
    ).toThrow("must use HTTPS");
  });

  it("matches browser origins exactly while allowing server clients without Origin", () => {
    const allowed = new Set(["https://odyshell.com"]);
    expect(remoteMcpOriginAllowed(undefined, allowed)).toBe(true);
    expect(remoteMcpOriginAllowed("https://odyshell.com", allowed)).toBe(true);
    expect(remoteMcpOriginAllowed("https://evil.odyshell.com", allowed)).toBe(false);
    expect(remoteMcpOriginAllowed("https://odyshell.com.evil.test", allowed)).toBe(false);
    expect(remoteMcpOriginAllowed("not a url", allowed)).toBe(false);
  });

  it("accepts only an OAuth-selected Organization from a scoped JWT", () => {
    const token = unsignedJwt({ org_id: "org_member" });

    expect(
      remoteMcpOrganizationId(token, ["openid", "user:org:read"]),
    ).toBe("org_member");
    expect(remoteMcpOrganizationId(token, ["openid"])).toBeNull();
    expect(
      remoteMcpOrganizationId(unsignedJwt({ org_id: "workspace-member" }), [
        "user:org:read",
      ]),
    ).toBeNull();
    expect(remoteMcpOrganizationId("not-a-jwt", ["user:org:read"])).toBeNull();
  });

  it("persists installation grants without OAuth or Session plaintext", async () => {
    const database = await readFile("apps/server/src/database.ts", "utf8");
    const migration = database.slice(
      database.indexOf("async function migrateRemoteMcp("),
      database.indexOf("async function rollbackRemoteMcp("),
    );
    expect(migration).toContain("mcp_installations");
    expect(migration).toContain("mcp_session_grants");
    expect(migration).not.toMatch(/access_token|refresh_token|session_token|token_hash/);
  });

  it("revokes remote grants when a Session is cancelled", async () => {
    const database = await readFile("apps/server/src/database.ts", "utf8");
    const cancellation = database.slice(
      database.indexOf("async cancelAgentSession("),
      database.indexOf("async failClaimedAgentSession("),
    );
    expect(cancellation).toContain('.updateTable("mcpSessionGrants")');
    expect(cancellation).toContain('status: "revoked"');
  });

  it("rejects hostile browser origins before OAuth runs", async () => {
    const authenticate = vi.fn();
    const app = remoteMcpApp({ authenticate });

    const response = await app.inject({
      method: "POST",
      url: "/mcp/workspace-id",
      headers: { origin: "https://odyshell.com.evil.test" },
      payload: initializeRequest(),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "origin_denied" });
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("rejects missing or invalid OAuth credentials with discovery metadata", async () => {
    const app = remoteMcpApp({ authenticate: vi.fn(async () => null) });

    const response = await app.inject({
      method: "POST",
      url: "/mcp/workspace-id",
      payload: initializeRequest(),
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toContain(
      "/.well-known/oauth-protected-resource",
    );
  });

  it("denies cross-workspace OAuth memberships", async () => {
    const ensureMcpInstallation = vi.fn();
    const app = remoteMcpApp({
      database: {
        mcpWorkspace: vi.fn(async () => ({
          workspaceId: "workspace-id",
          workspaceName: "Private",
          organizationExternalId: "org-private",
        })),
        ensureMcpInstallation,
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/mcp/workspace-id",
      headers: { authorization: "Bearer safe-oauth-token" },
      payload: initializeRequest(),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "workspace_access_denied" });
    expect(ensureMcpInstallation).not.toHaveBeenCalled();
  });

  it("binds workspace access to the Organization selected during OAuth consent", async () => {
    const ensureMcpInstallation = vi.fn();
    const authenticate = vi.fn(async () => ({
      userId: "user-id",
      clientId: "client-id",
      scopes: ["openid", "user:org:read"],
      organizationId: "org-member",
      organizationIds: ["org-member", "org-private"],
      token: "safe-oauth-token",
    })) as RemoteMcpOauth["authenticate"];
    const app = remoteMcpApp({
      authenticate,
      database: {
        mcpWorkspace: vi.fn(async () => ({
          workspaceId: "private-workspace",
          workspaceName: "Private",
          organizationExternalId: "org-private",
        })),
        ensureMcpInstallation,
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/mcp/private-workspace",
      headers: { authorization: "Bearer safe-oauth-token" },
      payload: initializeRequest(),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "workspace_access_denied" });
    expect(ensureMcpInstallation).not.toHaveBeenCalled();
  });

  it("denies a revoked MCP installation", async () => {
    const app = remoteMcpApp({
      database: {
        mcpWorkspace: vi.fn(async () => ({
          workspaceId: "workspace-id",
          workspaceName: "Private",
          organizationExternalId: "org-member",
        })),
        ensureMcpInstallation: vi.fn(async () => null),
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/mcp/workspace-id",
      headers: { authorization: "Bearer safe-oauth-token" },
      payload: initializeRequest(),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "mcp_installation_revoked" });
  });

  it("does not claim an approved request twice", async () => {
    const claimAgentSessionRequest = vi.fn();
    const runtime = remoteRuntime({
      mcpSessionForRequest: vi.fn(async () => ({
        sessionId: "29f34f33-418c-4624-84c3-25818db42023",
        status: "active",
        expiresAt: Date.now() + 60_000,
      })),
      mcpGrantedSessionForRequest: vi.fn(async () => ({
        workspaceId: "workspace-id",
        agentId: "7e5e118e-07ce-430a-a20a-b89562acae61",
        agentName: "Test MCP",
        sessionId: "29f34f33-418c-4624-84c3-25818db42023",
        scopes: [],
        expiresAt: Date.now() + 60_000,
      })),
      listAgentSessionTargetRuntimes: vi.fn(async () => []),
      claimAgentSessionRequest,
    });

    await runtime.status("7d8730ef-075c-40d5-a72d-8101abe17260");

    expect(claimAgentSessionRequest).not.toHaveBeenCalled();
  });

  it("denies an operation outside the granted path before dispatch", async () => {
    const send = vi.fn();
    const createOperation = vi.fn();
    const runtime = remoteRuntime(
      {
        findMcpSessionPrincipal: vi.fn(async () => sessionPrincipal()),
        listMachines: vi.fn(async () => [machineRecord()]),
        audit: vi.fn(async () => undefined),
        createOperation,
      },
      { send },
    );

    await expect(
      runtime.execute({
        sessionId: "29f34f33-418c-4624-84c3-25818db42023",
        machine: "rpi5",
        action: { kind: "fs.read", path: "secrets.env" },
        timeoutSeconds: 120,
        operationId: "a6e9dd35-5882-4167-a30b-9aa0382d2630",
      }),
    ).rejects.toMatchObject({ code: "path_scope_denied", status: 403 });
    expect(createOperation).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("returns the original operation for an idempotent replay", async () => {
    const send = vi.fn();
    const createOperation = vi.fn();
    const runtime = remoteRuntime(
      {
        findMcpSessionPrincipal: vi.fn(async () => sessionPrincipal()),
        listMachines: vi.fn(async () => [machineRecord()]),
        getAgentSessionTargetRuntime: vi.fn(async () => ({
          status: "ready",
          runtimeSessionId: "runtime-session-id",
        })),
        findOperationByIdempotency: vi.fn(async () => ({
          id: "existing-operation-id",
          status: "succeeded",
        })),
        getOperation: vi.fn(async () => ({
          id: "existing-operation-id",
          sessionId: "runtime-session-id",
          principalId: "7e5e118e-07ce-430a-a20a-b89562acae61",
          action: { kind: "fs.read", path: "config/app.json" },
          status: "succeeded",
          timeoutSeconds: 120,
          maxOutputBytes: 1024,
          exitCode: 0,
          outputTruncated: false,
          events: [],
          createdAt: 0,
          updatedAt: 0,
        })),
        audit: vi.fn(async () => undefined),
        createOperation,
      },
      { send, isOnline: vi.fn(() => false) },
    );

    const result = await runtime.execute({
      sessionId: "29f34f33-418c-4624-84c3-25818db42023",
      machine: "rpi5",
      action: { kind: "fs.read", path: "config/app.json" },
      timeoutSeconds: 120,
      operationId: "a6e9dd35-5882-4167-a30b-9aa0382d2630",
    });

    expect(result.operation.id).toBe("existing-operation-id");
    expect(createOperation).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses to complete a Session while an Operation is active", async () => {
    const send = vi.fn();
    const runtime = remoteRuntime(
      {
        findMcpSessionPrincipal: vi.fn(async () => sessionPrincipal()),
        completeAgentSession: vi.fn(async () => ({ status: "busy" })),
      },
      { send },
    );

    await expect(
      runtime.complete({
        sessionId: "29f34f33-418c-4624-84c3-25818db42023",
        outcome: "succeeded",
      }),
    ).rejects.toMatchObject({
      code: "session_operations_active",
      status: 409,
    });
    expect(send).not.toHaveBeenCalled();
  });
});

function remoteMcpApp(
  overrides: {
    authenticate?: RemoteMcpOauth["authenticate"];
    database?: Record<string, unknown>;
  } = {},
) {
  const app = Fastify();
  apps.push(app);
  const database = {
    mcpWorkspace: vi.fn(async () => ({
      workspaceId: "workspace-id",
      workspaceName: "Workspace",
      organizationExternalId: "org-member",
    })),
    mcpWorkspacesForOrganizations: vi.fn(async () => []),
    ensureMcpInstallation: vi.fn(async () => ({
      workspaceId: "workspace-id",
      id: "installation-id",
      userId: "user-id",
      oauthClientId: "client-id",
      agentId: "7e5e118e-07ce-430a-a20a-b89562acae61",
      agentName: "Test MCP",
      status: "active" as const,
      createdAt: 0,
      updatedAt: 0,
    })),
    ...overrides.database,
  } as unknown as Database;
  const oauth: RemoteMcpOauth = {
    authenticate:
      overrides.authenticate ??
      vi.fn(async () => ({
        userId: "user-id",
        clientId: "client-id",
        scopes: ["openid", "user:org:read"],
        organizationId: "org-member",
        token: "safe-oauth-token",
      })),
    applicationName: vi.fn(async () => "Test MCP"),
  };
  registerRemoteMcp(
    app,
    {
      NODE_ENV: "test",
      ODYSHELL_MCP_URL: "https://mcp.test/mcp",
      ODYSHELL_MCP_ALLOWED_ORIGINS: "https://odyshell.com",
      CLERK_OAUTH_ISSUER: "https://clerk.test",
      CLERK_SECRET_KEY: "sk_test_placeholder",
      CLERK_PUBLISHABLE_KEY: "pk_test_placeholder",
    },
    { database, oauth, runtime: () => fakeRuntime() },
  );
  return app;
}

function fakeRuntime(): ApprovedMcpRuntime {
  return {
    machines: vi.fn(async () => ({ data: [] })),
    ping: vi.fn(),
    request: vi.fn(),
    status: vi.fn(),
    execute: vi.fn(),
    complete: vi.fn(),
    timeline: vi.fn(),
  };
}

function initializeRequest() {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "security-test", version: "1.0.0" },
    },
  };
}

function unsignedJwt(payload: Record<string, unknown>) {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", typ: "at+jwt" })}.${encode(payload)}.${Buffer.from("signature").toString("base64url")}`;
}

function remoteRuntime(
  database: Record<string, unknown>,
  gateway: Partial<ClientGateway> = {},
) {
  return createRemoteMcpRuntime(
    {
      workspaceId: "workspace-id",
      id: "installation-id",
      userId: "user-id",
      oauthClientId: "client-id",
      agentId: "7e5e118e-07ce-430a-a20a-b89562acae61",
      agentName: "Test MCP",
      status: "active",
      createdAt: 0,
      updatedAt: 0,
    },
    {
      database: database as unknown as Database,
      gateway: {
        isOnline: vi.fn(() => true),
        send: vi.fn(() => true),
        notifyWorkspace: vi.fn(),
        ...gateway,
      } as unknown as ClientGateway,
      sessionRequestLimiter: new ScopedRateLimiter(10, 10, 60_000),
      webUrl: "https://odyshell.com",
    },
  );
}

function sessionPrincipal() {
  return {
    workspaceId: "workspace-id",
    agentId: "7e5e118e-07ce-430a-a20a-b89562acae61",
    agentName: "Test MCP",
    sessionId: "29f34f33-418c-4624-84c3-25818db42023",
    scopes: [
      {
        machineId: "machine-id",
        profile: "workspace",
        capabilities: ["fs.read" as const],
        restrictions: {
          filesystem: {
            paths: [
              { path: "config/app.json", includeDescendants: false },
            ],
          },
        },
      },
    ],
    expiresAt: Date.now() + 5 * 60_000,
  };
}

function machineRecord() {
  return {
    id: "machine-id",
    workspaceId: "workspace-id",
    name: "rpi5",
    publicKey: "public",
    status: "active" as const,
    enrolledAt: 0,
    lastSeenAt: 0,
    createdAt: 0,
    updatedAt: 0,
  };
}
