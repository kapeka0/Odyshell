import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { ApiError, Odyshell } from "../packages/sdk/src/index.js";

type CapturedRequest = {
  path: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
};

describe("Odyshell SDK", () => {
  it("does not expose the legacy direct Session execution surface", () => {
    type LegacySurface = Extract<
      keyof Odyshell,
      "process" | "fs" | "docker" | "execute" | "sessions" | "createSession"
    >;

    expectTypeOf<LegacySurface>().toEqualTypeOf<never>();

    const ods = new Odyshell({
      serverUrl: "https://ods.example",
      agentToken: "agent-secret",
      fetch: vi.fn(),
    });
    for (const property of [
      "process",
      "fs",
      "docker",
      "execute",
      "sessions",
      "createSession",
    ]) {
      expect(ods).not.toHaveProperty(property);
    }
  });

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
      { idempotencyKey: "stable-operation-key" },
    );

    expect(requests.find((request) => request.path.endsWith("/operations"))).toMatchObject({
      path: "/v1/sessions/session-id/operations",
      method: "POST",
      headers: expect.objectContaining({
        authorization: "Bearer session-secret",
        "idempotency-key": "stable-operation-key",
      }),
      body: expect.objectContaining({
        machineId: "7a354999-6a6c-42db-9467-e1416da255f1",
        action: { kind: "fs.read", path: "config/app.json" },
        timeoutSeconds: 600,
        maxOutputBytes: 1024 * 1024,
      }),
    });
    expect(JSON.stringify(requests)).not.toContain("human-secret");
    expect(JSON.stringify(requests)).not.toContain("agent-secret");
    expect(JSON.stringify(requests)).not.toContain("capabilities");
  });

  it("cancels Operations through both low-level and claimed Session clients", async () => {
    const requests: CapturedRequest[] = [];
    const fetch = mockFetch(requests, () => ({
      id: "operation-id",
      status: "cancellation_requested",
    }));
    const ods = new Odyshell({
      serverUrl: "https://ods.example",
      agentToken: "agent-secret",
      fetch,
    });
    const session = ods.claimedSession({
      sessionId: "session-id",
      sessionToken: "session-secret",
      scopes: [],
      status: "opening",
      expiresAt: "2026-07-31T01:00:00.000Z",
    });

    await ods.cancelOperation("operation-id");
    await session.cancelOperation("operation-id");

    expect(requests).toMatchObject([
      {
        path: "/v1/operations/operation-id/cancel",
        method: "POST",
        headers: { authorization: "Bearer agent-secret" },
      },
      {
        path: "/v1/operations/operation-id/cancel",
        method: "POST",
        headers: { authorization: "Bearer session-secret" },
      },
    ]);
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
      title: "Read configuration",
      purpose: "Read configuration",
      durationSeconds: 600,
      action: { kind: "fs.read", path: "config/app.json" },
    });

    expect(requests[0]?.body).toMatchObject({
      agentId: "9a7a6a54-5d4a-43d0-8ef4-0e0396096eeb",
      agentName: "Codex",
      title: "Read configuration",
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

  it("requests Host Shell authority without anticipating a command", async () => {
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
    }).requestHostShellSession({
      machineId: "7a354999-6a6c-42db-9467-e1416da255f1",
      title: "Diagnose the build",
      purpose: "Run dependent commands",
      durationSeconds: 900,
      runId: "task-run-2026-08-05",
      predecessorSessionId: "c837dd55-fdf0-47bb-887f-e4f857245dc7",
    });

    expect(requests[0]?.body).toMatchObject({
      agentId: "9a7a6a54-5d4a-43d0-8ef4-0e0396096eeb",
      title: "Diagnose the build",
      runId: "task-run-2026-08-05",
      predecessorSessionId: "c837dd55-fdf0-47bb-887f-e4f857245dc7",
      scopes: [{
        machineId: "7a354999-6a6c-42db-9467-e1416da255f1",
        profile: "workspace",
        capabilities: ["host.shell"],
        restrictions: {},
      }],
    });
    expect(requests[0]?.body).not.toHaveProperty("command");
    expect(requests[0]?.body).not.toHaveProperty("action");
    expect(requests[0]?.body).not.toHaveProperty("scopes.0.action");
  });

  it("rejects Host Shell authority without a Task Run identifier", async () => {
    const requests: CapturedRequest[] = [];
    const ods = new Odyshell({
      serverUrl: "https://ods.example",
      agentToken: "agent-secret",
      fetch: mockFetch(requests, () => ({})),
    });
    const agent = ods.agent({
      id: "9a7a6a54-5d4a-43d0-8ef4-0e0396096eeb",
      name: "Codex",
    });

    await expect(agent.requestHostShellSession({
      machineId: "7a354999-6a6c-42db-9467-e1416da255f1",
      title: "Unattributed host work",
      durationSeconds: 900,
    } as never)).rejects.toMatchObject({ code: "task_run_id_required" });
    expect(requests).toHaveLength(0);
  });

  it("rejects unattributed Host Shell through the low-level Session request", async () => {
    const requests: CapturedRequest[] = [];
    const ods = new Odyshell({
      serverUrl: "https://ods.example",
      agentToken: "agent-secret",
      fetch: mockFetch(requests, () => ({})),
    });

    await expect(ods.requestAgentSession({
      agentId: "9a7a6a54-5d4a-43d0-8ef4-0e0396096eeb",
      agentName: "Codex",
      title: "Unattributed low-level host work",
      durationSeconds: 900,
      scopes: [{
        machineId: "7a354999-6a6c-42db-9467-e1416da255f1",
        profile: "workspace",
        capabilities: ["host.shell"],
        restrictions: {},
      }],
    })).rejects.toMatchObject({ code: "task_run_id_required" });
    expect(requests).toHaveLength(0);
  });

  it("rejects Host Shell on the typed-operation request helper", async () => {
    const requests: CapturedRequest[] = [];
    const ods = new Odyshell({
      serverUrl: "https://ods.example",
      agentToken: "agent-secret",
      fetch: mockFetch(requests, () => ({})),
    });
    const agent = ods.agent({
      id: "9a7a6a54-5d4a-43d0-8ef4-0e0396096eeb",
      name: "Codex",
    });

    await expect(agent.requestOperationSession({
      machineId: "7a354999-6a6c-42db-9467-e1416da255f1",
      title: "Invalid anticipated shell command",
      durationSeconds: 900,
      action: {
        kind: "host.shell",
        command: "npm test",
        cwd: ".",
        env: {},
      },
    } as never)).rejects.toMatchObject({ code: "host_shell_request_required" });
    expect(requests).toHaveLength(0);
  });

  it("forwards the Task Run when renewing Host Shell authority", async () => {
    const requests: CapturedRequest[] = [];
    const ods = new Odyshell({
      serverUrl: "https://ods.example",
      agentToken: "agent-secret",
      fetch: mockFetch(requests, () => ({
        id: "renewal-request",
        predecessorSessionId: "c837dd55-fdf0-47bb-887f-e4f857245dc7",
        status: "pending",
        expiresAt: "2026-07-31T00:10:00.000Z",
        scopes: [],
      })),
    });

    await ods.renewAgentSession(
      "c837dd55-fdf0-47bb-887f-e4f857245dc7",
      "9a7a6a54-5d4a-43d0-8ef4-0e0396096eeb",
      { durationSeconds: 3_600, runId: "task-run-2026-08-05" },
    );

    expect(requests[0]).toMatchObject({
      path:
        "/v1/agent-sessions/c837dd55-fdf0-47bb-887f-e4f857245dc7/renew",
      method: "POST",
      body: {
        agentId: "9a7a6a54-5d4a-43d0-8ef4-0e0396096eeb",
        durationSeconds: 3_600,
        runId: "task-run-2026-08-05",
      },
    });
  });

  it("forwards the Task Run when claiming Host Shell authority", async () => {
    const requests: CapturedRequest[] = [];
    const ods = new Odyshell({
      serverUrl: "https://ods.example",
      agentToken: "agent-secret",
      fetch: mockFetch(requests, () => ({
        sessionId: "c837dd55-fdf0-47bb-887f-e4f857245dc7",
        sessionToken: "session-secret",
        scopes: [],
        status: "opening",
        expiresAt: "2026-07-31T01:00:00.000Z",
      })),
    });

    await ods.claimAgentSession(
      "7d8730ef-075c-40d5-a72d-8101abe17260",
      "9a7a6a54-5d4a-43d0-8ef4-0e0396096eeb",
      "task-run-2026-08-05",
    );

    expect(requests[0]).toMatchObject({
      path:
        "/v1/agent-session-requests/7d8730ef-075c-40d5-a72d-8101abe17260/claim",
      method: "POST",
      body: {
        agentId: "9a7a6a54-5d4a-43d0-8ef4-0e0396096eeb",
        runId: "task-run-2026-08-05",
      },
    });
  });

  it("executes Host Shell only through a claimed Session", async () => {
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
          capabilities: ["host.shell"],
          status: "ready",
          expiresAt: "2026-07-31T01:00:00.000Z",
          createdAt: "2026-07-31T00:00:00.000Z",
        };
      }
      return {
        id: "operation-id",
        sessionId: "session-id",
        action: { kind: "host.shell", command: "npm test", cwd: ".", env: {} },
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
      agentToken: "agent-secret",
      fetch,
    });
    const session = ods.claimedSession({
      sessionId: "session-id",
      sessionToken: "session-secret",
      scopes: [{
        machineId: "7a354999-6a6c-42db-9467-e1416da255f1",
        profile: "workspace",
        capabilities: ["host.shell"],
        restrictions: {},
      }],
      status: "opening",
      expiresAt: "2026-07-31T01:00:00.000Z",
    });

    await session.host.shell({
      machineId: "7a354999-6a6c-42db-9467-e1416da255f1",
      command: "npm test",
      env: { CI: "true" },
      stdinBase64: Buffer.from("yes\n").toString("base64"),
    });

    expect(requests.find((request) => request.path.endsWith("/operations")))
      .toMatchObject({
        path: "/v1/sessions/session-id/operations",
        headers: expect.objectContaining({ authorization: "Bearer session-secret" }),
        body: expect.objectContaining({
          machineId: "7a354999-6a6c-42db-9467-e1416da255f1",
          action: {
            kind: "host.shell",
            command: "npm test",
            cwd: ".",
            env: { CI: "true" },
            stdinBase64: Buffer.from("yes\n").toString("base64"),
          },
        }),
      });
    expect(ods).not.toHaveProperty("process");
    expect(ods).not.toHaveProperty("host");
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

  it("lists canonical Agent Sessions without using the legacy runtime endpoint", async () => {
    const requests: CapturedRequest[] = [];
    const fetch = mockFetch(requests, () => ({ data: [] }));
    const ods = new Odyshell({
      serverUrl: "https://ods.example",
      cliToken: "cli-secret",
      fetch,
    });

    await ods.human().sessions();

    expect(requests).toMatchObject([
      {
        path: "/v1/agent-sessions",
        method: "GET",
        headers: { authorization: "Bearer cli-secret" },
      },
    ]);
    expect(requests[0]?.path).not.toBe("/v1/sessions");
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

  it("rejects Host Shell before proposing autoapproval or delegation policy", async () => {
    const requests: CapturedRequest[] = [];
    const ods = new Odyshell({
      serverUrl: "https://ods.example",
      agentToken: "agent-secret",
      fetch: mockFetch(requests, () => ({})),
    });

    await expect(
      ods.proposeAgentPolicy({
        scopes: [{
          machineId: "11111111-1111-4111-8111-111111111111",
          profile: "host",
          capabilities: ["host.shell"],
          restrictions: {},
        }] as never,
        maxSessionSeconds: 600,
        validForSeconds: 2_592_000,
      }),
    ).rejects.toMatchObject({ code: "unsafe_capability" });
    expect(requests).toEqual([]);
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

});

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
