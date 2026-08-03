import {
  Client,
  InMemoryTransport,
  type CallToolResult,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import process from "node:process";
import {
  ApiError,
  type Odyshell,
  type OperationResult,
} from "../packages/sdk/src/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createApprovedOdyshellMcpServer,
} from "../apps/cli/src/mcp.js";

const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map((close) => close()));
});

describe("Odyshell MCP server", () => {
  it("publishes the approval-based typed operation workflow", async () => {
    const ods = fakeApprovedOdyshell();
    const server = createApprovedOdyshellMcpServer(ods, {
      id: "9a7a6a54-5d4a-43d0-8ef4-0e0396096eeb",
      name: "Codex",
    });
    const { client } = await connectServer(server);

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual([
      "machines_list",
      "machine_ping",
      "session_request",
      "sessions_list",
      "session_status",
      "operation_execute",
      "session_complete",
      "timeline_list",
    ]);
    expect(JSON.stringify(tools)).not.toContain("sessionToken");
    expect(
      tools.find((tool) => tool.name === "session_request")?.annotations,
    ).toMatchObject({ readOnlyHint: false, idempotentHint: false });
    expect(
      tools.find((tool) => tool.name === "session_status")?.annotations,
    ).toMatchObject({ readOnlyHint: false, idempotentHint: false });
  });

  it("recovers a Session request when the original tool response is lost", async () => {
    const ods = fakeApprovedOdyshell();
    vi.spyOn(ods, "resolveMachine").mockResolvedValue({
      id: "29f34f33-418c-4624-84c3-25818db42023",
      name: "rpi5",
      status: "online",
      online: true,
      lastSeenAt: null,
      enrolledAt: "2026-08-03T16:00:00.000Z",
      compatible: true,
      upgradeRequired: false,
      clientVersion: "0.10.2",
      protocolVersion: 1,
    });
    const server = createApprovedOdyshellMcpServer(ods, {
      id: "9a7a6a54-5d4a-43d0-8ef4-0e0396096eeb",
      name: "Codex",
    });
    const { client } = await connectServer(server);
    const requested = await client.callTool({
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
    });
    expect(textOf(requested)).toContain("Approval required");
    expect(textOf(requested)).toContain('"tool": "session_status"');
    expect(textOf(requested)).toContain(
      '"requestId": "7d8730ef-075c-40d5-a72d-8101abe17260"',
    );

    const recovered = await client.callTool({
      name: "sessions_list",
      arguments: {},
    });

    expect(recovered.isError).not.toBe(true);
    expect(textOf(recovered)).toContain(
      "7d8730ef-075c-40d5-a72d-8101abe17260",
    );
    expect(textOf(recovered)).toContain("Inspect configuration");
  });

  it("defaults Agent-requested Sessions to one hour", async () => {
    const requestSession = vi.fn(async () => ({
      id: "default-duration-request",
      status: "pending" as const,
      approvalUrl: "https://odyshell.com/sessions/approve?request=default-duration-request",
      expiresAt: "2026-07-29T18:10:00.000Z",
      scopes: [],
    }));
    const ods = fakeApprovedOdyshell({ requestSession });
    vi.spyOn(ods, "resolveMachine").mockResolvedValue({
      id: "29f34f33-418c-4624-84c3-25818db42023",
      name: "rpi5",
      status: "online",
      online: true,
      lastSeenAt: null,
      enrolledAt: "2026-08-03T16:00:00.000Z",
      compatible: true,
      upgradeRequired: false,
      clientVersion: "0.12.0",
      protocolVersion: 2,
    });
    const server = createApprovedOdyshellMcpServer(ods, {
      id: "9a7a6a54-5d4a-43d0-8ef4-0e0396096eeb",
      name: "Codex",
    });
    const { client } = await connectServer(server);

    const response = await client.callTool({
      name: "session_request",
      arguments: {
        operations: [
          {
            machine: "rpi5",
            action: { kind: "fs.read", path: "config/app.json" },
          },
        ],
        title: "Inspect configuration",
      },
    });

    expect(response.isError, textOf(response)).not.toBe(true);
    expect(requestSession).toHaveBeenCalledWith(
      expect.objectContaining({ durationSeconds: 3_600 }),
    );
  });

  it("recovers a dashboard-approved request in a fresh local MCP process", async () => {
    const ods = fakeApprovedOdyshell({
      requests: async () => [
        {
          id: "dashboard-request",
          title: "Inspect desktop storage",
          status: "approved",
          scopes: [],
          durationSeconds: 900,
          expiresAt: "2026-07-29T18:10:00.000Z",
        },
      ],
      sessions: async () => [],
    });
    const server = createApprovedOdyshellMcpServer(ods, {
      id: "9a7a6a54-5d4a-43d0-8ef4-0e0396096eeb",
      name: "Codex",
    });
    const { client } = await connectServer(server);

    const recovered = await client.callTool({
      name: "sessions_list",
      arguments: {},
    });

    expect(recovered.isError).not.toBe(true);
    expect(textOf(recovered)).toContain("dashboard-request");
    expect(textOf(recovered)).toContain("Inspect desktop storage");
    expect(textOf(recovered)).toContain('"status": "approved"');
  });

  it("accepts an exact absolute host path through local MCP approval", async () => {
    const ods = fakeApprovedOdyshell();
    vi.spyOn(ods, "resolveMachine").mockResolvedValue({
      id: "29f34f33-418c-4624-84c3-25818db42023",
      name: "rpi5",
      status: "online",
      online: true,
      lastSeenAt: null,
      enrolledAt: "2026-08-03T16:00:00.000Z",
      compatible: true,
      upgradeRequired: false,
      clientVersion: "0.11.0",
      protocolVersion: 1,
    });
    const server = createApprovedOdyshellMcpServer(ods, {
      id: "9a7a6a54-5d4a-43d0-8ef4-0e0396096eeb",
      name: "Codex",
    });
    const { client } = await connectServer(server);

    const response = await client.callTool({
      name: "session_request",
      arguments: {
        operations: [
          {
            machine: "rpi5",
            action: { kind: "fs.read", path: "/etc/hosts" },
          },
        ],
        title: "Inspect host configuration",
        purpose: "Inspect host configuration",
        durationSeconds: 900,
      },
    });

    expect(response.isError).not.toBe(true);
    expect(textOf(response)).toContain("Approval required");
  });

  it("claims an approved request without exposing the session credential", async () => {
    const ods = fakeApprovedOdyshell();
    const server = createApprovedOdyshellMcpServer(ods, {
      id: "9a7a6a54-5d4a-43d0-8ef4-0e0396096eeb",
      name: "Codex",
    });
    const { client } = await connectServer(server);

    const result = await client.callTool({
      name: "session_status",
      arguments: { requestId: "7d8730ef-075c-40d5-a72d-8101abe17260" },
    });

    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toContain('"status": "ready"');
    expect(textOf(result)).toContain(
      '"sessionId": "c837dd55-fdf0-47bb-887f-e4f857245dc7"',
    );
    expect(textOf(result)).toContain('"tool": "operation_execute"');
    expect(textOf(result)).not.toContain("ods_session_secret");
  });

  it("rejects a request that would broaden capability-path combinations", async () => {
    const server = createApprovedOdyshellMcpServer(fakeApprovedOdyshell(), {
      id: "9a7a6a54-5d4a-43d0-8ef4-0e0396096eeb",
      name: "Codex",
    });
    const { client } = await connectServer(server);

    const result = await client.callTool({
      name: "session_request",
      arguments: {
        operations: [
          {
            machine: "rpi5",
            action: { kind: "fs.read", path: "public.txt" },
          },
          {
            machine: "rpi5",
            action: {
              kind: "fs.write",
              path: "output.txt",
              contentBase64: "",
              createParents: false,
            },
          },
        ],
        title: "Copy selected data",
        purpose: "Copy selected data",
        durationSeconds: 600,
      },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("session_scope_conflict");
  });

  it("keeps the credential inside MCP while executing the approved operation", async () => {
    const execute = vi.fn(async () =>
      successfulOperation("safe content"),
    );
    const ods = fakeApprovedOdyshell({ execute });
    const server = createApprovedOdyshellMcpServer(ods, {
      id: "9a7a6a54-5d4a-43d0-8ef4-0e0396096eeb",
      name: "Codex",
    });
    const { client } = await connectServer(server);
    await client.callTool({
      name: "session_status",
      arguments: { requestId: "7d8730ef-075c-40d5-a72d-8101abe17260" },
    });

    const result = await client.callTool({
      name: "operation_execute",
      arguments: {
        sessionId: "c837dd55-fdf0-47bb-887f-e4f857245dc7",
        machine: "machine-id",
        action: { kind: "fs.read", path: "config/app.json" },
        operationId: "f87d486b-928d-4df9-b19e-f843855867dc",
      },
    });

    expect(result.isError).not.toBe(true);
    expect(execute).toHaveBeenCalledWith(
      "machine-id",
      { kind: "fs.read", path: "config/app.json" },
      {
        timeoutSeconds: 120,
        idempotencyKey: "f87d486b-928d-4df9-b19e-f843855867dc",
      },
    );
    expect(textOf(result)).not.toContain("ods_session_secret");
  });

  it("rejects an operation outside the claimed scope without leaking it", async () => {
    const execute = vi.fn(async () => {
      throw new ApiError(403, "path_scope_denied", {
        internalRestriction: "config/app.json",
      });
    });
    const ods = fakeApprovedOdyshell({ execute });
    const server = createApprovedOdyshellMcpServer(ods, {
      id: "9a7a6a54-5d4a-43d0-8ef4-0e0396096eeb",
      name: "Codex",
    });
    const { client } = await connectServer(server);
    await client.callTool({
      name: "session_status",
      arguments: { requestId: "7d8730ef-075c-40d5-a72d-8101abe17260" },
    });

    const result = await client.callTool({
      name: "operation_execute",
      arguments: {
        sessionId: "c837dd55-fdf0-47bb-887f-e4f857245dc7",
        machine: "machine-id",
        action: { kind: "fs.read", path: "secrets.env" },
        operationId: "2fc42fa3-b4d8-46e2-9384-76477aa8979f",
      },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("path_scope_denied");
    expect(textOf(result)).not.toContain("internalRestriction");
    expect(textOf(result)).not.toContain("config/app.json");
  });

  it("guides the Agent back to machine metadata when a program is unavailable", async () => {
    const failed = successfulOperation("");
    failed.operation.status = "failed";
    failed.operation.exitCode = null;
    failed.operation.error = "spawn df ENOENT";
    failed.stderr = "spawn df ENOENT";
    const execute = vi.fn(async () => failed);
    const server = createApprovedOdyshellMcpServer(
      fakeApprovedOdyshell({ execute }),
      { id: "9a7a6a54-5d4a-43d0-8ef4-0e0396096eeb", name: "Codex" },
    );
    const { client } = await connectServer(server);
    await client.callTool({
      name: "session_status",
      arguments: { requestId: "7d8730ef-075c-40d5-a72d-8101abe17260" },
    });

    const result = await client.callTool({
      name: "operation_execute",
      arguments: {
        sessionId: "c837dd55-fdf0-47bb-887f-e4f857245dc7",
        machine: "desktop",
        action: { kind: "process.exec", program: "df", args: ["-h"] },
        operationId: "f87d486b-928d-4df9-b19e-f843855867dc",
      },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("machines_list");
    expect(textOf(result)).toContain("platform");
  });

  it("closes Sessions and reads their verified timeline through the shared tools", async () => {
    const complete = vi.fn(async () => ({
      id: "c837dd55-fdf0-47bb-887f-e4f857245dc7",
      status: "completed" as const,
      transitioned: true,
    }));
    const timeline = vi.fn(async () => [
      { id: "event-id", eventType: "session.started", source: "verified" },
    ]);
    const ods = fakeApprovedOdyshell({ complete, timeline });
    const server = createApprovedOdyshellMcpServer(ods, {
      id: "9a7a6a54-5d4a-43d0-8ef4-0e0396096eeb",
      name: "Codex",
    });
    const { client } = await connectServer(server);

    const timelineResult = await client.callTool({
      name: "timeline_list",
      arguments: {
        sessionId: "c837dd55-fdf0-47bb-887f-e4f857245dc7",
        outcome: "succeeded",
      },
    });
    const completeResult = await client.callTool({
      name: "session_complete",
      arguments: { sessionId: "c837dd55-fdf0-47bb-887f-e4f857245dc7" },
    });

    expect(timelineResult.isError).not.toBe(true);
    expect(textOf(timelineResult)).toContain("session.started");
    expect(completeResult.isError).not.toBe(true);
    expect(complete).toHaveBeenCalledWith(
      "c837dd55-fdf0-47bb-887f-e4f857245dc7",
      "succeeded",
      undefined,
    );
  });

  it("serves the CLI over clean MCP stdio", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "apps/cli/src/index.ts", "mcp"],
      cwd: process.cwd(),
      env: {
        ...stringEnvironment(process.env),
        ODYSHELL_AGENT_TOKEN: "test-agent-token",
        ODYSHELL_AGENT_ID: "b1144720-58d8-4886-b8ad-d2b32ccaecc9",
        ODYSHELL_AGENT_NAME: "Test Agent",
        ODYSHELL_SERVER_URL: "http://127.0.0.1:1",
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "odyshell-stdio-test", version: "1.0.0" });
    await client.connect(transport);
    closeCallbacks.push(async () => client.close());

    const { tools } = await client.listTools();

    expect(tools.some((tool) => tool.name === "session_request")).toBe(true);
    expect(tools.some((tool) => tool.name === "operation_execute")).toBe(true);
    expect(tools.some((tool) => tool.name === "process_exec")).toBe(false);
  });
});

async function connectServer(
  server: ReturnType<typeof createApprovedOdyshellMcpServer>,
): Promise<{ client: Client }> {
  const client = new Client({ name: "odyshell-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closeCallbacks.push(async () => {
    await client.close();
    await server.close();
  });
  return { client };
}

function fakeApprovedOdyshell(
  overrides: {
    execute?: (
      machineId: string,
      action: unknown,
      options: unknown,
    ) => Promise<OperationResult>;
    complete?: (
      sessionId: string,
      outcome: "succeeded" | "failed",
      summary?: string,
    ) => Promise<unknown>;
    timeline?: (sessionId: string) => Promise<unknown>;
    requests?: () => Promise<unknown[]>;
    sessions?: () => Promise<unknown[]>;
    requestSession?: (...args: unknown[]) => Promise<unknown>;
  } = {},
): Odyshell {
  const requestAgentSession = overrides.requestSession ?? vi.fn(async () => ({
    id: "7d8730ef-075c-40d5-a72d-8101abe17260",
    status: "pending" as const,
    approvalUrl:
      "https://odyshell.com/sessions/approve?request=7d8730ef-075c-40d5-a72d-8101abe17260",
    expiresAt: "2026-07-29T18:10:00.000Z",
    scopes: [],
  }));
  const status = vi.fn(async () => ({
    id: "7d8730ef-075c-40d5-a72d-8101abe17260",
    status: "approved" as const,
    expiresAt: "2026-07-29T18:10:00.000Z",
  }));
  const claim = vi.fn(async () => ({
    sessionId: "c837dd55-fdf0-47bb-887f-e4f857245dc7",
    sessionToken: "ods_session_secret",
    scopes: [
      {
        machineId: "machine-id",
        profile: "workspace",
        capabilities: ["fs.read"],
        restrictions: {
          filesystem: {
            paths: [{ path: "config/app.json", includeDescendants: false }],
          },
        },
      },
    ],
    status: "opening" as const,
    expiresAt: "2026-07-29T19:00:00.000Z",
  }));
  return {
    machines: vi.fn(async () => []),
    resolveMachine: vi.fn(async () => ({
      id: "machine-id",
      name: "rpi5",
      status: "online",
      online: true,
      lastSeenAt: null,
      enrolledAt: "2026-07-29T18:00:00.000Z",
    })),
    agent: vi.fn(() => ({
      requestSession: requestAgentSession,
      requests: vi.fn(overrides.requests ?? (async () => [])),
      sessions: vi.fn(overrides.sessions ?? (async () => [
        {
          id: "c837dd55-fdf0-47bb-887f-e4f857245dc7",
          agentId: "9a7a6a54-5d4a-43d0-8ef4-0e0396096eeb",
          agentName: "Codex",
          title: "Inspect configuration",
          status: "active",
          expiresAt: "2026-07-29T19:00:00.000Z",
          scopes: [],
          targets: [
            { machineId: "machine-id", machineName: "rpi5", status: "ready" },
          ],
          createdAt: "2026-07-29T18:00:00.000Z",
          updatedAt: "2026-07-29T18:00:01.000Z",
        },
      ])),
      status,
      claim,
      complete:
        overrides.complete ?? vi.fn(async () => ({ status: "completed" })),
      timeline: overrides.timeline ?? vi.fn(async () => []),
    })),
    claimedSession: vi.fn(() => ({
      execute:
        overrides.execute ??
        vi.fn(async () => successfulOperation("safe content")),
    })),
    ping: vi.fn(async (machineId: string) => ({
      reply: "pong" as const,
      machineId,
      latencyMs: 1,
    })),
  } as unknown as Odyshell;
}

function successfulOperation(stdout: string): OperationResult {
  return {
    operation: {
      id: "operation-id",
      sessionId: "session-id",
      action: {
        kind: "process.exec",
        program: "printf",
        args: [],
        cwd: ".",
        env: {},
      },
      status: "succeeded",
      exitCode: 0,
      outputTruncated: false,
      events: [],
      createdAt: "2026-07-29T18:00:00.000Z",
      updatedAt: "2026-07-29T18:00:01.000Z",
    },
    stdout,
    stderr: "",
    result: undefined,
    resultText: "",
  };
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("\n");
}

function stringEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}
