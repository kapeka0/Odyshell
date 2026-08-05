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
  remoteMcpAgentName,
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

  it("uses a recognizable MCP Agent display name without trusting it for access", () => {
    expect(remoteMcpAgentName(undefined, "ChatGPT/1.0")).toBe("ChatGPT");
    expect(remoteMcpAgentName("MCP Client", "Claude-Connectors/1.0")).toBe(
      "Claude",
    );
    expect(remoteMcpAgentName("Internal Operator", undefined)).toBe(
      "Internal Operator",
    );
    expect(remoteMcpAgentName(undefined, undefined)).toBe("MCP");
  });

  it("exposes only the execution facts an Agent needs to choose safe operations", async () => {
    const runtime = remoteRuntime({
      listMachines: vi.fn(async () => [
        machineRecord({
          hostPlatform: "windows",
          architecture: "x64",
          nodeVersion: "v24.6.0",
          clientVersion: "0.10.2",
          protocolVersion: 1,
          executionRunners: ["host"],
          supportedCapabilities: ["process.exec", "fs.read"],
          privilegeEscalation: "sudo",
          defaultShell: "cmd.exe",
          profiles: [
            {
              name: "workspace",
              runner: "host",
              capabilities: ["fs.read"],
              workspaceRoot: "C:\\Users\\karim",
            },
          ],
        }),
      ]),
    });

    const result = await runtime.machines();

    expect(result).toEqual({
      data: [
        {
          id: "machine-id",
          name: "rpi5",
          online: true,
          status: "online",
          platform: "windows",
          architecture: "x64",
          runner: "host",
          capabilities: ["fs.read"],
          clientVersion: "0.10.2",
          defaultShell: "cmd.exe",
          privilegeEscalation: "sudo",
          lastSeenAt: "1970-01-01T00:00:00.000Z",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("workspaceRoot");
    expect(JSON.stringify(result)).not.toContain("nodeVersion");
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

  it("rejects an MCP installation whose persistent Agent was deleted", async () => {
    const database = await readFile("apps/server/src/database.ts", "utf8");
    const installation = database.slice(
      database.indexOf("async ensureMcpInstallation("),
      database.indexOf("async getAgentIdentity("),
    );
    expect(installation).toContain('"agents.status as agentStatus"');
    expect(installation).toContain('"agents.deletedAt as agentDeletedAt"');
    expect(installation).toContain('existing.agentStatus !== "active"');
    expect(installation).toContain("existing.agentDeletedAt !== null");
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

  it("serves authenticated MCP 2025-11-25 clients", async () => {
    const app = remoteMcpApp();

    const response = await app.inject({
      method: "POST",
      url: "/mcp/workspace-id",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: "Bearer safe-oauth-token",
      },
      payload: initializeRequest(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    const data = response.payload
      .split("\n")
      .find((line) => line.startsWith("data: "));
    expect(data).toBeDefined();
    expect(JSON.parse(data!.slice("data: ".length))).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: "2025-11-25" },
    });

    const toolsResponse = await app.inject({
      method: "POST",
      url: "/mcp/workspace-id",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: "Bearer safe-oauth-token",
        "mcp-protocol-version": "2025-11-25",
      },
      payload: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      },
    });

    expect(toolsResponse.statusCode).toBe(200);
    expect(toolsResponse.payload).toContain('"name":"machines_list"');
    expect(toolsResponse.payload).toContain('"name":"session_request"');
    expect(toolsResponse.payload).toContain(
      "Relative paths resolve from the Client Home",
    );
    expect(toolsResponse.payload).toContain('"const":"host.shell"');
    expect(toolsResponse.payload).not.toContain('"const":"process.shell"');
    expect(toolsResponse.payload).toContain("requires manual approval");
  });

  it("uses the explicit idempotency key across stateless HTTP calls", async () => {
    const execute = vi.fn<ApprovedMcpRuntime["execute"]>(async (input) => ({
      operation: {
        id: "server-operation-id",
        sessionId: input.sessionId,
        status: "succeeded",
        exitCode: 0,
        outputTruncated: false,
      },
      stdout: "ok",
      stderr: "",
    }));
    const app = remoteMcpApp({ runtime: fakeRuntime({ execute }) });
    const request = {
      method: "POST" as const,
      url: "/mcp/workspace-id",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: "Bearer safe-oauth-token",
        "mcp-protocol-version": "2025-11-25",
      },
      payload: {
        jsonrpc: "2.0",
        id: 73,
        method: "tools/call",
        params: {
          name: "operation_execute",
          arguments: {
            idempotencyKey: "d7afba47-a504-4aa3-b37e-68782364aab3",
            sessionId: "c837dd55-fdf0-47bb-887f-e4f857245dc7",
            machine: "rpi5",
            action: { kind: "fs.read", path: "README.md" },
          },
        },
      },
    };

    expect((await app.inject(request)).statusCode).toBe(200);
    expect((await app.inject(request)).statusCode).toBe(200);
    expect(
      (await app.inject({
        ...request,
        payload: {
          ...request.payload,
          params: {
            ...request.payload.params,
            arguments: {
              ...request.payload.params.arguments,
              idempotencyKey: "0f8f60f9-dd80-465c-961f-c3007d006f75",
            },
          },
        },
      })).statusCode,
    ).toBe(200);

    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls.map(([input]) => input.idempotencyKey)).toEqual([
      "d7afba47-a504-4aa3-b37e-68782364aab3",
      "d7afba47-a504-4aa3-b37e-68782364aab3",
      "0f8f60f9-dd80-465c-961f-c3007d006f75",
    ]);
  });

  it("requests exact absolute filesystem paths and exact host commands", async () => {
    const request = vi.fn(async () => ({
      id: "7d8730ef-075c-40d5-a72d-8101abe17260",
      status: "pending",
      approvalUrl:
        "https://odyshell.com/sessions/approve?request=7d8730ef-075c-40d5-a72d-8101abe17260",
      expiresAt: "2026-08-03T11:17:26.648Z",
    }));
    const app = remoteMcpApp({ runtime: fakeRuntime({ request }) });

    const absolutePathResponse = await app.inject({
      method: "POST",
      url: "/mcp/workspace-id",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: "Bearer safe-oauth-token",
        "mcp-protocol-version": "2025-11-25",
      },
      payload: {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "session_request",
          arguments: {
            operations: [
              {
                machine: "rpi5",
                action: {
                  kind: "fs.read",
                  path: "/etc/network/interfaces",
                },
              },
            ],
            title: "Inspect network configuration",
            purpose: "Inspect network configuration",
            durationSeconds: 900,
          },
        },
      },
    });

    expect(absolutePathResponse.statusCode).toBe(200);
    expect(absolutePathResponse.payload).toContain(
      "Open this link to approve or deny",
    );
    expect(request).toHaveBeenNthCalledWith(1, {
      operations: [
        {
          machine: "rpi5",
          action: {
            kind: "fs.read",
            path: "/etc/network/interfaces",
          },
        },
      ],
      title: "Inspect network configuration",
      purpose: "Inspect network configuration",
      durationSeconds: 900,
    });

    const exactCommandResponse = await app.inject({
      method: "POST",
      url: "/mcp/workspace-id",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: "Bearer safe-oauth-token",
        "mcp-protocol-version": "2025-11-25",
      },
      payload: {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "session_request",
          arguments: {
            operations: [
              {
                machine: "rpi5",
                action: {
                  kind: "process.exec",
                  program: "cat",
                  args: ["/etc/network/interfaces"],
                  cwd: ".",
                },
              },
            ],
            title: "Inspect network configuration",
            purpose: "Inspect network configuration",
            durationSeconds: 900,
          },
        },
      },
    });

    expect(exactCommandResponse.statusCode).toBe(200);
    expect(exactCommandResponse.payload).toContain(
      "Open this link to approve or deny",
    );
    expect(request).toHaveBeenNthCalledWith(2, {
      operations: [
        {
          machine: "rpi5",
          action: {
            kind: "process.exec",
            program: "cat",
            args: ["/etc/network/interfaces"],
            cwd: ".",
          },
        },
      ],
      title: "Inspect network configuration",
      purpose: "Inspect network configuration",
      durationSeconds: 900,
    });
  });

  it("tells the MCP client to show the Session approval link", async () => {
    const request = vi.fn(async () => ({
      id: "7d8730ef-075c-40d5-a72d-8101abe17260",
      status: "pending",
      approvalUrl:
        "https://odyshell.com/sessions/approve?request=7d8730ef-075c-40d5-a72d-8101abe17260",
      expiresAt: "2026-08-03T11:17:26.648Z",
    }));
    const app = remoteMcpApp({ runtime: fakeRuntime({ request }) });

    const response = await app.inject({
      method: "POST",
      url: "/mcp/workspace-id",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: "Bearer safe-oauth-token",
        "mcp-protocol-version": "2025-11-25",
      },
      payload: {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "session_request",
          arguments: {
            operations: [
              {
                machine: "rpi5",
                action: { kind: "fs.read", path: "config/app.json" },
              },
            ],
            title: "Inspect configuration",
            purpose: "Inspect configuration",
            durationSeconds: 900,
          },
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload).toContain("Open this link to approve or deny");
    expect(response.payload).toContain(
      "https://odyshell.com/sessions/approve?request=7d8730ef-075c-40d5-a72d-8101abe17260",
    );
    expect(request).toHaveBeenCalledOnce();
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

  it("recovers Sessions with titles and machine execution facts", async () => {
    const listAgentSessionRequests = vi.fn(async () => [
      {
        id: "7d8730ef-075c-40d5-a72d-8101abe17260",
        status: "pending",
        purpose: "Check disk space",
        expiresAt: Date.parse("2026-08-03T16:20:00.000Z"),
      },
    ]);
    const runtime = remoteRuntime({
      listAgentSessionRequests,
      listWorkspaceAgentSessions: vi.fn(async () => [
        {
          id: "29f34f33-418c-4624-84c3-25818db42023",
          title: "Inspect desktop storage",
          purpose: "Check disk space",
          status: "active",
          expiresAt: Date.parse("2026-08-03T17:20:00.000Z"),
          targets: [
            {
              machineId: "machine-id",
              machineName: "desktop",
              status: "ready",
              machineRuntime: {
                hostPlatform: "windows",
                architecture: "x64",
                defaultShell: "powershell.exe",
                profiles: [
                  {
                    name: "default",
                    runner: "host",
                    capabilities: ["process.exec"],
                  },
                ],
              },
            },
          ],
        },
      ]),
    });

    await expect(runtime.sessions()).resolves.toEqual({
      data: [
        {
          kind: "session",
          sessionId: "29f34f33-418c-4624-84c3-25818db42023",
          title: "Inspect desktop storage",
          status: "active",
          purpose: "Check disk space",
          expiresAt: "2026-08-03T17:20:00.000Z",
          machines: [
            {
              id: "machine-id",
              name: "desktop",
              status: "ready",
              platform: "windows",
              architecture: "x64",
              runner: "host",
              capabilities: ["process.exec"],
              clientVersion: null,
              defaultShell: "powershell.exe",
              privilegeEscalation: null,
            },
          ],
        },
        {
          kind: "request",
          id: "7d8730ef-075c-40d5-a72d-8101abe17260",
          status: "pending",
          purpose: "Check disk space",
          approvalUrl:
            "https://odyshell.com/sessions/approve?request=7d8730ef-075c-40d5-a72d-8101abe17260",
          expiresAt: "2026-08-03T16:20:00.000Z",
        },
      ],
    });
    expect(listAgentSessionRequests).toHaveBeenCalledWith(
      "workspace-id",
      "7e5e118e-07ce-430a-a20a-b89562acae61",
      "user-id",
      20,
    );
  });

  it("reuses a compatible ready Session before requesting approval", async () => {
    const machineId = "9d0cb00d-8665-4a33-bd3f-308c42d6070d";
    const principal = sessionPrincipal(machineId);
    const createAgentSessionRequest = vi.fn();
    const runtime = remoteRuntime({
      listMachines: vi.fn(async () => [{ ...machineRecord(), id: machineId }]),
      listWorkspaceAgentSessions: vi.fn(async () => [
        reusableSessionRecord(principal),
      ]),
      findMcpSessionPrincipal: vi.fn(async () => principal),
      createAgentSessionRequest,
    });

    await expect(
      runtime.request({
        operations: [{
          machine: "rpi5",
          action: { kind: "fs.read", path: "config/app.json" },
        }],
        title: "Inspect configuration",
        durationSeconds: 900,
      }),
    ).resolves.toMatchObject({
      status: "ready",
      reused: true,
      sessionId: principal.sessionId,
    });
    expect(createAgentSessionRequest).not.toHaveBeenCalled();
  });

  it("does not reuse a Session whose scope misses the requested operation", async () => {
    const machineId = "9d0cb00d-8665-4a33-bd3f-308c42d6070d";
    const principal = sessionPrincipal(machineId);
    const createAgentSessionRequest = vi.fn(async (_input: unknown) => ({
      status: "pending",
      expiresAt: Date.now() + 10 * 60_000,
    }));
    const runtime = remoteRuntime({
      listMachines: vi.fn(async () => [{ ...machineRecord(), id: machineId }]),
      listWorkspaceAgentSessions: vi.fn(async () => [
        reusableSessionRecord(principal),
      ]),
      findMcpSessionPrincipal: vi.fn(async () => principal),
      createAgentSessionRequest,
      audit: vi.fn(async () => undefined),
    });

    const result = await runtime.request({
      operations: [{
        machine: "rpi5",
        action: { kind: "fs.read", path: "secrets.env" },
      }],
      title: "Inspect secrets",
      durationSeconds: 900,
    });

    expect(result.status).toBe("pending");
    expect(createAgentSessionRequest).toHaveBeenCalledOnce();
  });

  it("notifies the responsible member when remote MCP requests approval", async () => {
    const createAgentSessionRequest = vi.fn(async () => ({
      status: "pending",
      expiresAt: Date.parse("2026-08-03T18:20:00.000Z"),
    }));
    const runtime = remoteRuntime({
      listMachines: vi.fn(async () => [
        {
          ...machineRecord(),
          id: "29f34f33-418c-4624-84c3-25818db42023",
        },
      ]),
      createAgentSessionRequest,
      audit: vi.fn(async () => undefined),
    });

    const request = await runtime.request({
      operations: [
        {
          machine: "rpi5",
          action: { kind: "fs.read", path: "config/app.json" },
        },
      ],
      title: "Inspect configuration",
      purpose: "Inspect configuration",
      durationSeconds: 900,
    });

    expect(request.status).toBe("pending");
    expect(createAgentSessionRequest).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-id",
      humanId: "user-id",
      requestId: request.id,
    }));
  });

  it("links Host Shell escalation without asking the agent to predict a command", async () => {
    const machineId = "9d0cb00d-8665-4a33-bd3f-308c42d6070d";
    const predecessorSessionId = "29f34f33-418c-4624-84c3-25818db42023";
    const predecessorScopes = [
      {
        machineId,
        profile: "workspace",
        capabilities: ["fs.read" as const],
        restrictions: {
          filesystem: {
            paths: [{ path: "config", includeDescendants: true }],
          },
        },
      },
    ];
    const createAgentSessionRequest = vi.fn(async (_input: unknown) => ({
      status: "pending" as const,
      expiresAt: Date.now() + 10 * 60_000,
    }));
    const runtime = remoteRuntime({
      listMachines: vi.fn(async () => [{ ...machineRecord(), id: machineId }]),
      agentSessionForRenewal: vi.fn(async () => ({
        agentName: "Test MCP",
        title: "Inspect configuration",
        scopes: predecessorScopes,
        durationSeconds: 900,
      })),
      createAgentSessionRequest,
      audit: vi.fn(async () => undefined),
    });

    await expect(
      runtime.request({
        hostShell: { machine: "rpi5" },
        predecessorSessionId,
        title: "Continue with Host Shell",
        purpose: "Typed capabilities were insufficient",
        durationSeconds: 3_600,
      }),
    ).resolves.toMatchObject({ status: "pending" });

    expect(createAgentSessionRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        predecessorSessionId,
        scopes: [
          {
            machineId,
            profile: "workspace",
            capabilities: ["fs.read", "host.shell"],
            restrictions: predecessorScopes[0]!.restrictions,
          },
        ],
      }),
    );
    expect(JSON.stringify(createAgentSessionRequest.mock.calls[0]?.[0])).not.toContain(
      "command",
    );
  });

  it("cancels predecessor commands before opening a claimed replacement", async () => {
    const send = vi.fn((_machineId: string, _message: unknown) => true);
    const runtime = remoteRuntime(
      {
        mcpSessionForRequest: vi.fn(async () => null),
        mcpGrantedSessionForRequest: vi.fn(async () => null),
        getAgentSessionRequest: vi.fn(async () => ({
          status: "approved",
          expiresAt: Date.now() + 60_000,
        })),
        claimAgentSessionRequest: vi.fn(async () => ({
          status: "claimed" as const,
          session: {
            id: "99de9879-3be8-42a1-8bd5-13cbf6866fd0",
            expiresAt: Date.now() + 3_600_000,
          },
          targets: [
            {
              machineId: "machine-id",
              runtimeSessionId: "replacement-runtime-id",
              scope: {
                machineId: "machine-id",
                profile: "workspace",
                capabilities: ["fs.read", "host.shell"],
                restrictions: {},
              },
            },
          ],
          superseded: {
            id: "29f34f33-418c-4624-84c3-25818db42023",
            status: "revoked" as const,
            transitioned: true,
            operations: [{ id: "old-operation", machineId: "machine-id" }],
            targets: [
              { machineId: "machine-id", runtimeSessionId: "old-runtime-id" },
            ],
          },
        })),
        markSessionOpenFailed: vi.fn(async () => undefined),
        findMcpSessionPrincipal: vi.fn(async () => ({
          ...sessionPrincipal(),
          sessionId: "99de9879-3be8-42a1-8bd5-13cbf6866fd0",
        })),
        listAgentSessionTargetRuntimes: vi.fn(async () => [
          { machineId: "machine-id", capabilities: ["host.shell"], status: "ready" },
        ]),
      },
      { send },
    );

    await runtime.status("7d8730ef-075c-40d5-a72d-8101abe17260");

    expect(send.mock.calls.slice(0, 2)).toEqual([
      ["machine-id", { type: "operation.cancel", operationId: "old-operation" }],
      [
        "machine-id",
        { type: "session.close", sessionId: "old-runtime-id", reason: "revoked" },
      ],
    ]);
    expect(send.mock.calls[2]?.[1]).toMatchObject({
      type: "session.open",
      sessionId: "replacement-runtime-id",
    });
  });

  it("waits for the Client to acknowledge a newly opened Session", async () => {
    const listAgentSessionTargetRuntimes = vi
      .fn()
      .mockResolvedValueOnce([
        {
          machineId: "machine-id",
          capabilities: ["fs.read"],
          status: "opening",
        },
      ])
      .mockResolvedValueOnce([
        {
          machineId: "machine-id",
          capabilities: ["fs.read"],
          status: "ready",
        },
      ]);
    const runtime = remoteRuntime({
      mcpSessionForRequest: vi.fn(async () => null),
      mcpGrantedSessionForRequest: vi.fn(async () => sessionPrincipal()),
      listAgentSessionTargetRuntimes,
    });

    await expect(
      runtime.status("7d8730ef-075c-40d5-a72d-8101abe17260"),
    ).resolves.toMatchObject({ status: "ready" });
    expect(listAgentSessionTargetRuntimes).toHaveBeenCalledTimes(2);
  });

  it("reports a local capability rejection instead of leaving the Session opening", async () => {
    const runtime = remoteRuntime({
      mcpSessionForRequest: vi.fn(async () => null),
      mcpGrantedSessionForRequest: vi.fn(async () => sessionPrincipal()),
      listAgentSessionTargetRuntimes: vi.fn(async () => [
        {
          machineId: "machine-id",
          capabilities: ["process.exec"],
          status: "failed",
          error: "Capability process.exec is denied by local policy",
        },
      ]),
    });

    await expect(
      runtime.status("7d8730ef-075c-40d5-a72d-8101abe17260"),
    ).resolves.toMatchObject({
      status: "failed",
      reason: "capability_denied_by_machine",
      machines: [
        {
          machineId: "machine-id",
          capabilities: ["process.exec"],
          status: "failed",
          reason: "capability_denied_by_machine",
        },
      ],
    });
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
        idempotencyKey: "a6e9dd35-5882-4167-a30b-9aa0382d2630",
      }),
    ).rejects.toMatchObject({ code: "path_scope_denied", status: 403 });
    expect(createOperation).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects Host Shell commands smuggled into a direct operations request", async () => {
    const runtime = remoteRuntime({
      listMachines: vi.fn(async () => [machineRecord()]),
    });

    await expect(
      runtime.request({
        operations: [
          {
            machine: "rpi5",
            action: {
              kind: "host.shell",
              command: "whoami",
              cwd: ".",
              env: {},
            },
          },
        ],
        title: "Smuggled Host Shell command",
        durationSeconds: 600,
      } as Parameters<ApprovedMcpRuntime["request"]>[0]),
    ).rejects.toMatchObject({
      code: "host_shell_request_required",
      status: 400,
    });
  });

  it("bounds an MCP Operation timeout to the remaining Session lifetime", async () => {
    const principal = {
      ...sessionPrincipal(),
      scopes: [{
        machineId: "machine-id",
        profile: "workspace",
        capabilities: ["host.shell" as const],
        restrictions: {},
      }],
      expiresAt: Date.now() + 5 * 60_000,
    };
    const createOperation = vi.fn(async (_input: unknown) => true);
    const replayOperationByIdempotency = vi.fn<
      Database["replayOperationByIdempotency"]
    >(async (replayInput, dispatch) => {
      if (replayInput.freshOperationId === undefined) return { kind: "missing" };
      const created = createOperation.mock.calls[0]?.[0] as {
        timeoutSeconds: number;
        maxOutputBytes: number;
      };
      const sent = dispatch({
        id: replayInput.freshOperationId,
        sessionId: "runtime-session-id",
        action: { kind: "host.shell", command: "npm -v", cwd: ".", env: {} },
        timeoutSeconds: created.timeoutSeconds,
        maxOutputBytes: created.maxOutputBytes,
      });
      return sent
        ? {
            kind: "dispatched",
            id: replayInput.freshOperationId,
            status: "delivered",
          }
        : {
            kind: "send_failed",
            id: replayInput.freshOperationId,
            status: "queued",
          };
    });
    const send = vi.fn(() => true);
    const runtime = remoteRuntime(
      {
        findMcpSessionPrincipal: vi.fn(async () => principal),
        listMachines: vi.fn(async () => [machineRecord()]),
        getAgentSessionTargetRuntime: vi.fn(async () => ({
          status: "ready",
          canonicalReady: true,
          runtimeSessionId: "runtime-session-id",
        })),
        replayOperationByIdempotency,
        createOperation,
        getOperation: vi.fn(async () => ({
          id: "created-operation-id",
          sessionId: "runtime-session-id",
          principalId: principal.agentId,
          action: { kind: "host.shell", command: "npm -v", cwd: ".", env: {} },
          status: "succeeded",
          timeoutSeconds: 299,
          maxOutputBytes: 1024,
          exitCode: 0,
          outputTruncated: false,
          events: [],
          createdAt: 0,
          updatedAt: 0,
        })),
        audit: vi.fn(async () => undefined),
      },
      { send, isOnline: vi.fn(() => true) },
    );

    await expect(runtime.execute({
      sessionId: principal.sessionId,
      machine: "rpi5",
      action: {
        kind: "host.shell",
        command: "npm -v",
        cwd: ".",
        env: { DEPLOY_TOKEN: "ephemeral-env-value" },
        stdinBase64: Buffer.from("ephemeral-stdin-value").toString("base64"),
      },
      timeoutSeconds: 600,
      idempotencyKey: "a6e9dd35-5882-4167-a30b-9aa0382d2630",
    })).resolves.toMatchObject({ operation: { status: "succeeded" } });
    const created = createOperation.mock.calls[0]?.[0] as {
      timeoutSeconds: number;
      action: Record<string, unknown>;
    };
    expect(created.timeoutSeconds).toBeGreaterThanOrEqual(295);
    expect(created.timeoutSeconds).toBeLessThanOrEqual(300);
    expect(JSON.stringify(created.action)).not.toMatch(
      /DEPLOY_TOKEN|ephemeral-env-value|stdinBase64|ephemeral-stdin-value/u,
    );
    expect(send).toHaveBeenCalledWith(
      "machine-id",
      expect.objectContaining({
        timeoutSeconds: created.timeoutSeconds,
        action: expect.objectContaining({
          kind: "host.shell",
          env: { DEPLOY_TOKEN: "ephemeral-env-value" },
          stdinBase64: Buffer.from("ephemeral-stdin-value").toString("base64"),
        }),
      }),
    );
  });

  it("returns the original operation for an idempotent replay", async () => {
    const send = vi.fn();
    const createOperation = vi.fn();
    const sessionId = "29f34f33-418c-4624-84c3-25818db42023";
    const action = { kind: "fs.read" as const, path: "config/app.json" };
    const replayOperationByIdempotency = vi.fn<
      Database["replayOperationByIdempotency"]
    >(async () => ({
      kind: "replay",
      id: "existing-operation-id",
      status: "succeeded",
    }));
    const runtime = remoteRuntime(
      {
        findMcpSessionPrincipal: vi.fn(async () => sessionPrincipal()),
        listMachines: vi.fn(async () => [machineRecord()]),
        getAgentSessionTargetRuntime: vi.fn(async () => ({
          status: "ready",
          canonicalReady: true,
          runtimeSessionId: "runtime-session-id",
        })),
        replayOperationByIdempotency,
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
      sessionId,
      machine: "rpi5",
      action,
      timeoutSeconds: 120,
      idempotencyKey: "a6e9dd35-5882-4167-a30b-9aa0382d2630",
    });

    expect(result.operation.id).toBe("existing-operation-id");
    expect(createOperation).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(replayOperationByIdempotency).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-id",
        idempotencyScopeId: sessionId,
        principalId: "7e5e118e-07ce-430a-a20a-b89562acae61",
        idempotencyKey: "a6e9dd35-5882-4167-a30b-9aa0382d2630",
      }),
      expect.any(Function),
    );
  });

  it("returns a conflict when an MCP Operation key belongs to another payload", async () => {
    const send = vi.fn();
    const createOperation = vi.fn();
    const runtime = remoteRuntime(
      {
        findMcpSessionPrincipal: vi.fn(async () => sessionPrincipal()),
        listMachines: vi.fn(async () => [machineRecord()]),
        getAgentSessionTargetRuntime: vi.fn(async () => ({
          status: "ready",
          canonicalReady: true,
          runtimeSessionId: "runtime-session-id",
        })),
        replayOperationByIdempotency: vi.fn(async () => ({
          kind: "idempotency_conflict",
        })),
        createOperation,
      },
      { send, isOnline: vi.fn(() => true) },
    );

    await expect(
      runtime.execute({
        sessionId: "29f34f33-418c-4624-84c3-25818db42023",
        machine: "rpi5",
        action: { kind: "fs.read", path: "config/app.json" },
        timeoutSeconds: 120,
        idempotencyKey: "a6e9dd35-5882-4167-a30b-9aa0382d2630",
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
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
    runtime?: ApprovedMcpRuntime;
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
    { database, oauth, runtime: () => overrides.runtime ?? fakeRuntime() },
  );
  return app;
}

function fakeRuntime(
  overrides: Partial<ApprovedMcpRuntime> = {},
): ApprovedMcpRuntime {
  return {
    machines: vi.fn(async () => ({ data: [] })),
    ping: vi.fn(),
    request: vi.fn(),
    sessions: vi.fn(async () => ({ data: [] })),
    status: vi.fn(),
    execute: vi.fn(),
    complete: vi.fn(),
    timeline: vi.fn(),
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
      database: {
        listWorkspaceAgentSessions: vi.fn(async () => []),
        ...database,
      } as unknown as Database,
      gateway: {
        isOnline: vi.fn(() => true),
        send: vi.fn(() => true),
        runMachineLifecycle: vi.fn(
          async (_machineId: string, operation: () => Promise<unknown>) =>
            await operation(),
        ),
        events: { emit: vi.fn() },
        notifyWorkspace: vi.fn(),
        ...gateway,
      } as unknown as ClientGateway,
      sessionRequestLimiter: new ScopedRateLimiter(10, 10, 60_000),
      webUrl: "https://odyshell.com",
    },
  );
}

function reusableSessionRecord(principal: ReturnType<typeof sessionPrincipal>) {
  return {
    id: principal.sessionId,
    agentId: principal.agentId,
    agentName: principal.agentName,
    title: "Inspect configuration",
    purpose: "Inspect configuration",
    status: "active",
    expiresAt: principal.expiresAt,
    readyAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    requestedByHumanId: "user-id",
    scopes: principal.scopes,
    targets: [{
      machineId: principal.scopes[0]!.machineId,
      machineName: "rpi5",
      status: "ready",
    }],
  };
}

function sessionPrincipal(machineId = "machine-id") {
  return {
    workspaceId: "workspace-id",
    agentId: "7e5e118e-07ce-430a-a20a-b89562acae61",
    agentName: "Test MCP",
    sessionId: "29f34f33-418c-4624-84c3-25818db42023",
    scopes: [
      {
        machineId,
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

function machineRecord(runtime?: unknown) {
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
    ...(runtime === undefined ? {} : { runtime }),
  };
}
