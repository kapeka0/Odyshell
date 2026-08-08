import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgenticMcpRuntime } from "../packages/mcp/src/index.js";
import type { Database } from "../apps/server/src/database.js";
import {
  registerRemoteMcp,
  remoteMcpAgentName,
  remoteMcpConfiguration,
  remoteMcpIdentityFromClaims,
  remoteMcpOriginAllowed,
  type RemoteMcpOauth,
} from "../apps/server/src/remote-mcp.js";

const apps: Array<ReturnType<typeof Fastify>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("remote MCP security boundary", () => {
  it("stays disabled unless every OAuth setting is present", () => {
    expect(remoteMcpConfiguration({ ODYSHELL_MCP_URL: "https://mcp.test/mcp" }))
      .toBeNull();
  });

  it("requires HTTPS for public production endpoints", () => {
    expect(() => remoteMcpConfiguration({
      NODE_ENV: "production",
      ODYSHELL_MCP_URL: "http://mcp.test/mcp",
      ODYSHELL_IDENTITY_ISSUER: "https://identity.test",
    })).toThrow("must use HTTPS");
    expect(remoteMcpConfiguration({
      NODE_ENV: "production",
      ODYSHELL_MCP_URL: "http://localhost:4100/mcp",
      ODYSHELL_IDENTITY_ISSUER: "http://localhost:3000",
      ODYSHELL_IDENTITY_JWKS_URL: "http://web:3000/api/auth/jwks",
      ODYSHELL_IDENTITY_JWKS_ALLOW_HTTP: "true",
    })).toMatchObject({
      resource: new URL("http://localhost:4100/mcp"),
      issuer: new URL("http://localhost:3000"),
    });
  });

  it("matches browser origins exactly while allowing server clients", () => {
    const allowed = new Set(["https://odyshell.com"]);
    expect(remoteMcpOriginAllowed(undefined, allowed)).toBe(true);
    expect(remoteMcpOriginAllowed("https://odyshell.com", allowed)).toBe(true);
    expect(remoteMcpOriginAllowed("https://evil.odyshell.com", allowed)).toBe(false);
    expect(remoteMcpOriginAllowed("https://odyshell.com.evil.test", allowed)).toBe(false);
    expect(remoteMcpOriginAllowed("not a url", allowed)).toBe(false);
  });

  it("derives a display name without trusting it for access", () => {
    expect(remoteMcpAgentName(undefined, "ChatGPT/1.0")).toBe("ChatGPT");
    expect(remoteMcpAgentName("MCP Client", "Claude-Connectors/1.0")).toBe("Claude");
    expect(remoteMcpAgentName("Internal Operator", undefined)).toBe("Internal Operator");
    expect(remoteMcpAgentName(undefined, undefined)).toBe("MCP");
  });

  it("accepts only Agent claims bound to an Organization and OAuth client", () => {
    expect(remoteMcpIdentityFromClaims({
      sub: "human-id",
      azp: "mcp-client-id",
      scope: "openid odyshell:agent",
      organization_id: "organization-id",
    }, "verified-token")).toEqual({
      userId: "human-id",
      clientId: "mcp-client-id",
      scopes: ["openid", "odyshell:agent"],
      organizationId: "organization-id",
      token: "verified-token",
    });
    expect(remoteMcpIdentityFromClaims({
      azp: "client",
      scope: "openid",
      organization_id: "organization-id",
    }, "verified-token")).toBeNull();
    expect(remoteMcpIdentityFromClaims({
      azp: "client",
      scope: "odyshell:agent",
    }, "verified-token")).toBeNull();
  });

  it("shares Task and Command policy between HTTP and MCP", async () => {
    const http = await readFile("apps/server/src/task-http.ts", "utf8");
    const runtime = await readFile("apps/server/src/task-mcp-runtime.ts", "utf8");
    expect(http).toContain("dependencies.service.requestTask(");
    expect(http).toContain("dependencies.service.createCommand(");
    expect(runtime).toContain("service.requestTask(principal");
    expect(runtime).toContain("service.createCommand(principal");
    expect(runtime).not.toContain("deliverOperation(");
  });

  it("rejects hostile browser origins before OAuth", async () => {
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

  it("rejects invalid OAuth with discovery metadata", async () => {
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

  it("serves only the agent-native Task and Command tools", async () => {
    const machines = vi.fn(async () => ({ data: [] }));
    const app = remoteMcpApp({ runtime: fakeAgenticRuntime({ machines }) });
    const request = (id: number, method: string, params: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: "/mcp/workspace-id",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer safe-oauth-token",
          "mcp-protocol-version": "2025-11-25",
        },
        payload: { jsonrpc: "2.0", id, method, params },
      });

    const initialize = await request(1, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "security-test", version: "1.0.0" },
    });
    expect(initialize.statusCode).toBe(200);

    const tools = await request(2, "tools/list", {});
    expect(tools.statusCode).toBe(200);
    for (const name of [
      "machines_list",
      "task_request",
      "task_get",
      "task_complete",
      "task_cancel",
      "command_run",
      "command_get",
      "command_output",
      "command_cancel",
    ]) {
      expect(tools.payload).toContain(`\"name\":\"${name}\"`);
    }
    expect(tools.payload).not.toContain("session_request");
    expect(tools.payload).not.toContain("operation_execute");

    const call = await request(3, "tools/call", {
      name: "machines_list",
      arguments: {},
    });
    expect(call.statusCode).toBe(200);
    expect(call.payload).toContain('\\"data\\": []');
    expect(machines).toHaveBeenCalledOnce();
  });

  it("binds workspace access to the Organization selected in OAuth", async () => {
    const ensureMcpInstallation = vi.fn();
    const app = remoteMcpApp({
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

  it("denies revoked installations and reports Agent entitlement limits", async () => {
    const revoked = remoteMcpApp({
      database: { ensureMcpInstallation: vi.fn(async () => null) },
    });
    const revokedResponse = await revoked.inject({
      method: "POST",
      url: "/mcp/workspace-id",
      headers: { authorization: "Bearer safe-oauth-token" },
      payload: initializeRequest(),
    });
    expect(revokedResponse.statusCode).toBe(403);
    expect(revokedResponse.json()).toEqual({ error: "mcp_installation_revoked" });

    const full = remoteMcpApp({
      database: {
        ensureMcpInstallation: vi.fn(async () => ({
          status: "agent_limit_reached" as const,
          plan: "free" as const,
          activeAgentLimit: 3,
        })),
      },
    });
    const fullResponse = await full.inject({
      method: "POST",
      url: "/mcp/workspace-id",
      headers: { authorization: "Bearer safe-oauth-token" },
      payload: initializeRequest(),
    });
    expect(fullResponse.statusCode).toBe(409);
    expect(fullResponse.json()).toEqual({
      error: "agent_limit_reached",
      details: { activeAgentLimit: 3, plan: "free" },
    });
  });
});

function remoteMcpApp(overrides: {
  authenticate?: RemoteMcpOauth["authenticate"];
  database?: Record<string, unknown>;
  runtime?: AgenticMcpRuntime;
} = {}) {
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
    authenticate: overrides.authenticate ?? vi.fn(async () => ({
      userId: "user-id",
      clientId: "client-id",
      scopes: ["openid", "odyshell:agent"],
      organizationId: "org-member",
      token: "safe-oauth-token",
    })),
    applicationName: vi.fn(async () => "Test MCP"),
  };
  registerRemoteMcp(app, {
    NODE_ENV: "test",
    ODYSHELL_MCP_URL: "https://mcp.test/mcp",
    ODYSHELL_MCP_ALLOWED_ORIGINS: "https://odyshell.com",
    ODYSHELL_IDENTITY_ISSUER: "https://identity.test",
  }, {
    database,
    oauth,
    agenticRuntime: async () => overrides.runtime ?? fakeAgenticRuntime(),
  });
  return app;
}

function fakeAgenticRuntime(
  overrides: Partial<AgenticMcpRuntime> = {},
): AgenticMcpRuntime {
  return {
    machines: vi.fn(async () => ({ data: [] })),
    requestTask: vi.fn(),
    task: vi.fn(),
    finishTask: vi.fn(),
    createCommand: vi.fn(),
    command: vi.fn(),
    output: vi.fn(),
    cancelCommand: vi.fn(),
    ...overrides,
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
