import { describe, expect, it, vi } from "vitest";
import {
  ApiError,
  Odyshell,
} from "../packages/sdk/src/index.js";

type CapturedRequest = {
  path: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
};

describe("Odyshell SDK", () => {
  it("executes through a claimed Session without sending broader credentials", async () => {
    const requests: CapturedRequest[] = [];
    const fetch = mockFetch(requests, (request) => {
      if (request.path.endsWith("/operations")) {
        return { id: "operation-id", status: "queued" };
      }
      if (request.path === "/v1/sessions/session-id") {
        return {
          id: "session-id",
          machineId: "7a354999-6a6c-42db-9467-e1416da255f1",
          profile: "workspace",
          capabilities: ["fs.read"],
          status: "ready",
          expiresAt: "2026-07-31T01:00:00.000Z",
          createdAt: "2026-07-31T00:00:00.000Z",
        };
      }
      return {
        id: "operation-id",
        sessionId: "session-id",
        action: { kind: "fs.read", path: "config/app.json" },
        status: "succeeded",
        exitCode: 0,
        outputTruncated: false,
        events: [],
        createdAt: "2026-07-31T00:00:00.000Z",
        updatedAt: "2026-07-31T00:00:00.000Z",
      };
    });
    const ods = new Odyshell({
      serverUrl: "https://ods.example",
      cliToken: "human-secret",
      agentToken: "agent-secret",
      fetch,
    });
    const session = ods.claimedSession({
      sessionId: "session-id",
      sessionToken: "session-secret",
      scopes: [{
        machineId: "7a354999-6a6c-42db-9467-e1416da255f1",
        profile: "workspace",
        capabilities: ["fs.read"],
        restrictions: {
          filesystem: {
            paths: [{ path: "config/app.json", includeDescendants: false }],
          },
        },
      }],
      status: "opening",
      expiresAt: "2026-07-31T01:00:00.000Z",
    });

    await session.execute(
      "7a354999-6a6c-42db-9467-e1416da255f1",
      { kind: "fs.read", path: "config/app.json" },
    );

    expect(requests.find((request) => request.path.endsWith("/operations"))).toMatchObject({
      path: "/v1/sessions/session-id/operations",
      method: "POST",
      headers: expect.objectContaining({ authorization: "Bearer session-secret" }),
      body: expect.objectContaining({
        machineId: "7a354999-6a6c-42db-9467-e1416da255f1",
        action: { kind: "fs.read", path: "config/app.json" },
      }),
    });
    expect(JSON.stringify(requests)).not.toContain("human-secret");
    expect(JSON.stringify(requests)).not.toContain("agent-secret");
    expect(JSON.stringify(requests)).not.toContain("capabilities");
  });

  it("derives an exact scope when an Agent requests an operation Session", async () => {
    const requests: CapturedRequest[] = [];
    const fetch = mockFetch(requests, () => ({
      id: "request-id",
      status: "pending",
      expiresAt: "2026-07-31T00:10:00.000Z",
      scopes: [],
    }));
    const ods = new Odyshell({
      serverUrl: "https://ods.example",
      agentToken: "agent-secret",
      fetch,
    });

    await ods.agent({
      id: "9a7a6a54-5d4a-43d0-8ef4-0e0396096eeb",
      name: "Codex",
    }).requestOperationSession({
      machineId: "7a354999-6a6c-42db-9467-e1416da255f1",
      purpose: "Read configuration",
      durationSeconds: 600,
      action: { kind: "fs.read", path: "config/app.json" },
    });

    expect(requests[0]?.body).toMatchObject({
      agentId: "9a7a6a54-5d4a-43d0-8ef4-0e0396096eeb",
      agentName: "Codex",
      scopes: [{
        machineId: "7a354999-6a6c-42db-9467-e1416da255f1",
        capabilities: ["fs.read"],
        restrictions: {
          filesystem: {
            paths: [{ path: "config/app.json", includeDescendants: false }],
          },
        },
      }],
    });
  });

  it("keeps agent and administrator credentials on separate request surfaces", async () => {
    const requests: CapturedRequest[] = [];
    const fetch = mockFetch(requests, () => ({ data: [] }));
    const ods = new Odyshell({
      serverUrl: "https://ods.example",
      agentToken: "agent-secret",
      adminKey: "admin-secret",
      workspaceId: "workspace-123",
      fetch,
    });

    await ods.machines();
    await ods.adminMachines();

    expect(requests[0]?.headers).toMatchObject({
      authorization: "Bearer agent-secret",
    });
    expect(requests[0]?.headers).not.toHaveProperty("x-odyshell-admin-key");
    expect(requests[0]?.headers).not.toHaveProperty("x-odyshell-workspace-id");
    expect(requests[1]?.headers).toMatchObject({
      "x-odyshell-admin-key": "admin-secret",
      "x-odyshell-workspace-id": "workspace-123",
    });
    expect(requests[1]?.headers).not.toHaveProperty("authorization");
  });

  it("fails closed when the required credential is absent", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const ods = new Odyshell({
      serverUrl: "https://ods.example",
      agentToken: "agent-secret",
      fetch,
    });

    await expect(ods.adminMachines()).rejects.toMatchObject({
      code: "credentials_missing",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses a workspace-bound CLI token without exposing the admin key surface", async () => {
    const requests: CapturedRequest[] = [];
    const fetch = mockFetch(requests, () => ({ data: [] }));
    const ods = new Odyshell({
      serverUrl: "https://ods.example",
      cliToken: "cli-secret",
      workspaceId: "workspace-123",
      fetch,
    });

    await ods.machines();
    await ods.adminMachines();

    expect(requests[0]?.headers).toMatchObject({
      authorization: "Bearer cli-secret",
    });
    expect(requests[1]?.headers).toMatchObject({
      authorization: "Bearer cli-secret",
      "x-odyshell-workspace-id": "workspace-123",
    });
    expect(requests[0]?.headers).not.toHaveProperty("x-odyshell-admin-key");
    expect(requests[1]?.headers).not.toHaveProperty("x-odyshell-admin-key");
  });

  it("keeps device authorization public and exchanges only the opaque device code", async () => {
    const requests: CapturedRequest[] = [];
    const fetch = mockFetch(requests, (request) =>
      request.path.endsWith("/token")
        ? {
            accessToken: "ods_cli_result",
            tokenType: "Bearer",
            workspaceId: "workspace-123",
            expiresAt: "2026-08-29T18:00:00.000Z",
          }
        : {
            deviceCode: "ods_device_secret",
            userCode: "ABCD-EFGH",
            verificationUri: "https://app.ods.example/activate",
            verificationUriComplete: "https://app.ods.example/activate?code=ABCD-EFGH",
            expiresAt: "2026-07-29T18:10:00.000Z",
            intervalSeconds: 2,
          },
    );
    const ods = new Odyshell({ serverUrl: "https://ods.example", fetch });

    await ods.startDeviceAuthorization("Test CLI");
    await ods.exchangeDeviceAuthorization("ods_device_secret");

    expect(requests[0]).toMatchObject({
      path: "/v1/auth/device",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: { clientName: "Test CLI" },
    });
    expect(requests[0]?.headers).not.toHaveProperty("authorization");
    expect(requests[1]).toMatchObject({
      path: "/v1/auth/device/token",
      method: "POST",
      body: { deviceCode: "ods_device_secret" },
    });
    expect(requests[1]?.headers).not.toHaveProperty("authorization");
  });

  it("registers and rotates an Agent without exposing its credential to public calls", async () => {
    const requests: CapturedRequest[] = [];
    const fetch = mockFetch(requests, () => ({
      accessToken: "ods_agent_result",
      tokenType: "Bearer",
      workspaceId: "workspace-123",
      agentId: "agent-123",
      agentName: "OpenClaw",
      credentialId: "credential-123",
      expiresAt: "2026-10-29T18:00:00.000Z",
      overlapSeconds: 600,
    }));
    const publicClient = new Odyshell({
      serverUrl: "https://ods.example",
      fetch,
    });
    await publicClient.startAgentDeviceAuthorization("OpenClaw");
    await publicClient.exchangeAgentDeviceAuthorization("device-secret");

    const agent = new Odyshell({
      serverUrl: "https://ods.example",
      agentToken: "agent-secret",
      fetch,
    });
    await agent.rotateAgentCredential();

    expect(requests[0]).toMatchObject({
      path: "/v1/auth/agent/device",
      body: { agentName: "OpenClaw" },
    });
    expect(requests[0]?.headers).not.toHaveProperty("authorization");
    expect(requests[1]).toMatchObject({
      path: "/v1/auth/agent/device/token",
      body: { deviceCode: "device-secret" },
    });
    expect(requests[1]?.headers).not.toHaveProperty("authorization");
    expect(requests[2]).toMatchObject({
      path: "/v1/agent-credentials/rotate",
      headers: { authorization: "Bearer agent-secret" },
    });
  });

  it("manages scoped autoapproval policies only with the Agent Credential", async () => {
    const requests: CapturedRequest[] = [];
    const fetch = mockFetch(requests, (request) =>
      request.path === "/v1/agent-policies"
        ? request.method === "GET"
          ? { data: [] }
          : {
              id: "policy-id",
              version: 1,
              status: "proposed",
              approvalUrl: "https://ods.example/policies/approve?code=secret",
            }
        : { id: "policy-id", version: 1, status: "paused" },
    );
    const ods = new Odyshell({
      serverUrl: "https://ods.example",
      agentToken: "agent-secret",
      fetch,
    });
    const scopes = [
      {
        machineId: "11111111-1111-4111-8111-111111111111",
        profile: "host" as const,
        capabilities: ["fs.read" as const],
        restrictions: {
          filesystem: {
            paths: [{ path: "docs", includeDescendants: true }],
          },
        },
      },
    ];

    await ods.proposeAgentPolicy({
      scopes,
      maxSessionSeconds: 600,
      validForSeconds: 2_592_000,
    });
    await ods.agentPolicies();
    await ods.pauseAgentPolicy("policy-id");

    expect(requests).toMatchObject([
      {
        path: "/v1/agent-policies",
        method: "POST",
        headers: { authorization: "Bearer agent-secret" },
        body: {
          scopes,
          maxSessionSeconds: 600,
          validForSeconds: 2_592_000,
        },
      },
      {
        path: "/v1/agent-policies",
        method: "GET",
        headers: { authorization: "Bearer agent-secret" },
      },
      {
        path: "/v1/agent-policies/policy-id/pause",
        method: "POST",
        headers: { authorization: "Bearer agent-secret" },
      },
    ]);
  });

  it("creates and manages one-level Managed Agent identities", async () => {
    const requests: CapturedRequest[] = [];
    const fetch = mockFetch(requests, (request) =>
      request.path === "/v1/managed-agents" && request.method === "GET"
        ? { data: [] }
        : { id: "managed-id", name: "Updater", status: "active" },
    );
    const ods = new Odyshell({
      serverUrl: "https://ods.example",
      agentToken: "agent-secret",
      fetch,
    });
    const scopes = [
      {
        machineId: "11111111-1111-4111-8111-111111111111",
        profile: "host" as const,
        capabilities: ["fs.read" as const],
        restrictions: {
          filesystem: {
            paths: [{ path: "app", includeDescendants: true }],
          },
        },
      },
    ];

    await ods.createManagedAgent({
      name: "Updater",
      scopes,
      maxSessionSeconds: 600,
      validForSeconds: 86_400,
    });
    await ods.managedAgents();
    await ods.disableManagedAgent("managed-id");
    await ods.deleteManagedAgent("managed-id");
    await ods.revokeAgentCredential();

    expect(requests).toMatchObject([
      {
        path: "/v1/managed-agents",
        method: "POST",
        headers: { authorization: "Bearer agent-secret" },
      },
      {
        path: "/v1/managed-agents",
        method: "GET",
        headers: { authorization: "Bearer agent-secret" },
      },
      {
        path: "/v1/managed-agents/managed-id/disable",
        method: "POST",
      },
      {
        path: "/v1/managed-agents/managed-id",
        method: "DELETE",
      },
      {
        path: "/v1/agent-credentials/revoke",
        method: "POST",
      },
    ]);
  });

  it("revokes a CLI token through its bearer credential", async () => {
    const requests: CapturedRequest[] = [];
    const fetch = mockFetch(requests, () => ({ revoked: true }));
    const ods = new Odyshell({
      serverUrl: "https://ods.example",
      cliToken: "cli-secret",
      agentToken: "agent-secret",
      fetch,
    });

    await expect(ods.logoutCli()).resolves.toEqual({ revoked: true });
    expect(requests[0]).toMatchObject({
      path: "/v1/auth/logout",
      method: "POST",
      headers: { authorization: "Bearer cli-secret" },
    });
    expect(requests[0]?.headers).not.toHaveProperty("x-odyshell-admin-key");
  });

  it("does not expose credentials through API errors", async () => {
    const ods = new Odyshell({
      serverUrl: "https://ods.example",
      agentToken: "agent-super-secret",
      fetch: vi.fn(async () =>
        new Response(JSON.stringify({ error: "forbidden" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        })),
    });

    const error = await ods.machines().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(JSON.stringify(error)).not.toContain("agent-super-secret");
    expect(String(error)).not.toContain("agent-super-secret");
  });

  it("runs a typed operation in a least-privilege temporary session", async () => {
    const requests: CapturedRequest[] = [];
    const fetch = mockFetch(requests, (request) => {
      if (request.path === "/v1/machines") {
        return {
          data: [
            {
              id: "machine-id",
              name: "rpi5",
              status: "online",
              online: true,
              lastSeenAt: "2026-07-29T18:00:00.000Z",
              enrolledAt: "2026-07-29T17:00:00.000Z",
            },
          ],
        };
      }
      if (request.path === "/v1/sessions" && request.method === "POST") {
        return session("opening");
      }
      if (request.path === "/v1/sessions/session-id" && request.method === "GET") {
        return session("ready");
      }
      if (
        request.path === "/v1/sessions/session-id/operations" &&
        request.method === "POST"
      ) {
        return { id: "operation-id", status: "queued" };
      }
      if (request.path === "/v1/operations/operation-id") {
        return {
          id: "operation-id",
          sessionId: "session-id",
          action: {
            kind: "fs.write",
            path: "config/app.json",
            contentBase64: "eyJvayI6dHJ1ZX0=",
            createParents: true,
          },
          status: "succeeded",
          exitCode: 0,
          outputTruncated: false,
          events: [
            {
              sequence: 0,
              stream: "result",
              dataBase64: Buffer.from('{"bytesWritten":11}').toString("base64"),
            },
          ],
          createdAt: "2026-07-29T18:00:00.000Z",
          updatedAt: "2026-07-29T18:00:01.000Z",
        };
      }
      if (
        request.path === "/v1/sessions/session-id" &&
        request.method === "DELETE"
      ) {
        return { id: "session-id", status: "closed" };
      }
      throw new Error(`Unexpected request: ${request.method} ${request.path}`);
    });
    const ods = new Odyshell({
      serverUrl: "https://ods.example",
      agentToken: "agent-secret",
      fetch,
    });

    const result = await ods.fs.write({
      machine: "rpi5",
      path: "config/app.json",
      content: '{"ok":true}',
      createParents: true,
      ttlSeconds: 60,
      timeoutSeconds: 15,
    });

    expect(result.result).toEqual({ bytesWritten: 11 });
    expect(requests.find((request) => request.path === "/v1/sessions")?.body).toEqual({
      machineId: "machine-id",
      profile: "workspace",
      ttlSeconds: 60,
      capabilities: ["fs.write"],
    });
    expect(
      requests.find((request) => request.path.endsWith("/operations"))?.body,
    ).toEqual({
      action: {
        kind: "fs.write",
        path: "config/app.json",
        contentBase64: Buffer.from('{"ok":true}').toString("base64"),
        createParents: true,
      },
      timeoutSeconds: 15,
      maxOutputBytes: 1024 * 1024,
    });
    expect(requests.at(-1)).toMatchObject({
      method: "DELETE",
      path: "/v1/sessions/session-id",
    });
  });
});

function session(status: "opening" | "ready") {
  return {
    id: "session-id",
    machineId: "machine-id",
    profile: "workspace",
    capabilities: ["fs.write"],
    status,
    expiresAt: "2026-07-29T19:00:00.000Z",
    createdAt: "2026-07-29T18:00:00.000Z",
  };
}

function mockFetch(
  requests: CapturedRequest[],
  responder: (request: CapturedRequest) => unknown,
): typeof globalThis.fetch {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const request: CapturedRequest = {
      path: `${url.pathname}${url.search}`,
      method: init?.method ?? "GET",
      headers,
      ...(typeof init?.body === "string"
        ? { body: JSON.parse(init.body) as unknown }
        : {}),
    };
    requests.push(request);
    return new Response(JSON.stringify(responder(request)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}
