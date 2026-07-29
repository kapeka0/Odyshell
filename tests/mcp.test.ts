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
import { createOdyshellMcpServer } from "../apps/cli/src/mcp.js";

const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map((close) => close()));
});

describe("Odyshell MCP server", () => {
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
        ODYSHELL_SERVER_URL: "http://127.0.0.1:1",
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "odyshell-stdio-test", version: "1.0.0" });
    await client.connect(transport);
    closeCallbacks.push(async () => client.close());

    const { tools } = await client.listTools();

    expect(tools.some((tool) => tool.name === "process_exec")).toBe(true);
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
