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
  createOdyshellMcpServer,
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
    expect(textOf(result)).not.toContain("ods_session_secret");
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
      },
    });

    expect(result.isError).not.toBe(true);
    expect(execute).toHaveBeenCalledWith(
      "machine-id",
      { kind: "fs.read", path: "config/app.json" },
      { timeoutSeconds: 120 },
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
      },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("path_scope_denied");
    expect(textOf(result)).not.toContain("internalRestriction");
    expect(textOf(result)).not.toContain("config/app.json");
  });

  it("closes Sessions and reads their verified timeline through the shared tools", async () => {
    const cancel = vi.fn(async () => ({
      id: "c837dd55-fdf0-47bb-887f-e4f857245dc7",
      status: "cancelled" as const,
      transitioned: true,
    }));
    const timeline = vi.fn(async () => [
      { id: "event-id", eventType: "session.started", source: "verified" },
    ]);
    const ods = fakeApprovedOdyshell({ cancel, timeline });
    const server = createApprovedOdyshellMcpServer(ods, {
      id: "9a7a6a54-5d4a-43d0-8ef4-0e0396096eeb",
      name: "Codex",
    });
    const { client } = await connectServer(server);

    const timelineResult = await client.callTool({
      name: "timeline_list",
      arguments: { sessionId: "c837dd55-fdf0-47bb-887f-e4f857245dc7" },
    });
    const completeResult = await client.callTool({
      name: "session_complete",
      arguments: { sessionId: "c837dd55-fdf0-47bb-887f-e4f857245dc7" },
    });

    expect(timelineResult.isError).not.toBe(true);
    expect(textOf(timelineResult)).toContain("session.started");
    expect(completeResult.isError).not.toBe(true);
    expect(cancel).toHaveBeenCalledWith(
      "c837dd55-fdf0-47bb-887f-e4f857245dc7",
    );
  });

  it("publishes agent operations without administrator controls", async () => {
    const { client } = await connectMcp(fakeOdyshell());

    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);

    expect(names).toEqual([
      "machines_list",
      "machine_ping",
      "process_exec",
      "process_shell",
      "filesystem_stat",
      "filesystem_list",
      "filesystem_search",
      "filesystem_read",
      "filesystem_write",
      "filesystem_mkdir",
      "filesystem_remove",
      "docker_logs",
      "audit_list",
    ]);
    expect(names.join(" ")).not.toMatch(/admin|token|enroll|revoke|session/);
    expect(
      tools.find((tool) => tool.name === "filesystem_remove")?.annotations,
    ).toMatchObject({ destructiveHint: true, readOnlyHint: false });
  });

  it("maps typed process arguments to a bounded disposable operation", async () => {
    const processExec = vi.fn(async () => successfulOperation("hello\n"));
    const { client } = await connectMcp(fakeOdyshell({ processExec }));

    const response = await client.callTool({
      name: "process_exec",
      arguments: {
        machine: "rpi5",
        program: "printf",
        args: ["hello\\n"],
      },
    });

    expect(response.isError).not.toBe(true);
    expect(processExec).toHaveBeenCalledWith({
      machine: "rpi5",
      program: "printf",
      args: ["hello\\n"],
      cwd: ".",
      env: {},
      timeoutSeconds: 120,
      ttlSeconds: 150,
    });
    expect(textOf(response)).toContain('"stdout": "hello\\n"');
  });

  it("rejects paths outside the workspace before calling Odyshell", async () => {
    const filesystemRead = vi.fn(async () => successfulOperation(""));
    const { client } = await connectMcp(fakeOdyshell({ filesystemRead }));

    const response = await client.callTool({
      name: "filesystem_read",
      arguments: { machine: "rpi5", path: "../../etc/shadow" },
    });

    expect(response.isError).toBe(true);
    expect(textOf(response)).toContain("Parent traversal is not allowed");
    expect(filesystemRead).not.toHaveBeenCalled();
  });

  it("returns expected access errors without stack traces", async () => {
    const processExec = vi.fn(async () => {
      throw new ApiError(403, "capability_denied");
    });
    const { client } = await connectMcp(fakeOdyshell({ processExec }));

    const response = await client.callTool({
      name: "process_exec",
      arguments: { machine: "rpi5", program: "id" },
    });

    expect(response.isError).toBe(true);
    expect(textOf(response)).toContain('"code":"capability_denied"');
    expect(textOf(response)).not.toContain("at ");
  });

  it("marks failed machine operations as MCP tool errors", async () => {
    const processExec = vi.fn(async () => ({
      ...successfulOperation(""),
      operation: {
        ...successfulOperation("").operation,
        status: "failed" as const,
        exitCode: 1,
        error: "program exited with status 1",
      },
      stderr: "failed\n",
    }));
    const { client } = await connectMcp(fakeOdyshell({ processExec }));

    const response = await client.callTool({
      name: "process_exec",
      arguments: { machine: "rpi5", program: "false" },
    });

    expect(response.isError).toBe(true);
    expect(textOf(response)).toContain('"status": "failed"');
  });

  it("does not expose unexpected internal errors to the agent", async () => {
    const reportUnexpectedError = vi.fn();
    const processExec = vi.fn(async () => {
      throw new Error("database password: internal-secret");
    });
    const { client } = await connectMcp(
      fakeOdyshell({ processExec }),
      reportUnexpectedError,
    );

    const response = await client.callTool({
      name: "process_exec",
      arguments: { machine: "rpi5", program: "id" },
    });

    expect(response.isError).toBe(true);
    expect(textOf(response)).toContain("failed unexpectedly");
    expect(textOf(response)).not.toContain("internal-secret");
    expect(reportUnexpectedError).toHaveBeenCalledOnce();
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

async function connectMcp(
  ods: Odyshell,
  reportUnexpectedError?: (error: unknown) => void,
): Promise<{ client: Client }> {
  const server = createOdyshellMcpServer(
    ods,
    reportUnexpectedError ?? (() => undefined),
  );
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

async function connectServer(
  server: ReturnType<typeof createOdyshellMcpServer>,
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

function fakeOdyshell(
  overrides: {
    processExec?: (input: unknown) => Promise<OperationResult>;
    filesystemRead?: (input: unknown) => Promise<OperationResult>;
  } = {},
): Odyshell {
  const operation = async () => successfulOperation("");
  return {
    machines: vi.fn(async () => []),
    resolveMachine: vi.fn(async (machine: string) => ({
      id: `${machine}-id`,
      name: machine,
      status: "online",
      online: true,
      lastSeenAt: null,
      enrolledAt: "2026-07-29T18:00:00.000Z",
    })),
    ping: vi.fn(async (machineId: string) => ({
      reply: "pong" as const,
      machineId,
      latencyMs: 1,
    })),
    audit: vi.fn(async () => ({
      principal: { id: "agent-id", name: "agent" },
      data: [],
    })),
    process: {
      exec: overrides.processExec ?? operation,
      shell: operation,
    },
    fs: {
      stat: operation,
      list: operation,
      search: operation,
      read: overrides.filesystemRead ?? operation,
      write: operation,
      mkdir: operation,
      remove: operation,
    },
    docker: { logs: operation },
  } as unknown as Odyshell;
}

function fakeApprovedOdyshell(
  overrides: {
    execute?: (
      machineId: string,
      action: unknown,
      options: unknown,
    ) => Promise<OperationResult>;
    cancel?: (sessionId: string) => Promise<unknown>;
    timeline?: (sessionId: string) => Promise<unknown>;
  } = {},
): Odyshell {
  const requestAgentSession = vi.fn(async () => ({
    id: "7d8730ef-075c-40d5-a72d-8101abe17260",
    status: "pending" as const,
    approvalUrl: "https://odyshell.com/sessions/approve?code=SAFE",
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
      requestOperationSession: requestAgentSession,
      status,
      claim,
      cancel: overrides.cancel ?? vi.fn(async () => ({ status: "cancelled" })),
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
