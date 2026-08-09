import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAgenticMcpServer,
  type AgenticMcpRuntime,
} from "../packages/mcp/src/agentic.js";

const closures: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(closures.splice(0).map((close) => close())));

describe("agent-native MCP adapter", () => {
  it("exposes only the resumable Session/Command workflow", async () => {
    const calls: string[] = [];
    const runtime: AgenticMcpRuntime = {
      async machines() { calls.push("machines"); return { data: [] }; },
      async requestSession(input) { calls.push(`session:${input.idempotencyKey}`); return { status: "opening" }; },
      async session(sessionId) { return { id: sessionId, status: "active" }; },
      async finishSession(sessionId, outcome) { return { id: sessionId, status: outcome }; },
      async createCommand(_sessionId, input) { calls.push(`command:${input.command}`); return { status: "queued" }; },
      async command(commandId) { return { id: commandId, status: "running" }; },
      async output() { return { data: [], nextCursor: -1 }; },
      async cancelCommand(commandId) { return { id: commandId, status: "cancellation_requested" }; },
    };
    const server = createAgenticMcpServer(runtime);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    closures.push(async () => { await client.close(); await server.close(); });

    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "machines_list",
      "session_request",
      "session_get",
      "session_complete",
      "session_cancel",
      "command_run",
      "command_get",
      "command_output",
      "command_cancel",
    ]);
    const session = await client.callTool({
      name: "session_request",
      arguments: {
        machineId: "7a354999-6a6c-42db-9467-e1416da255f1",
        title: "Repair API",
        durationSeconds: 900,
        idempotencyKey: "550e8400-e29b-41d4-a716-446655440000",
      },
    });
    expect(session.isError).not.toBe(true);
    expect(calls).toContain("session:550e8400-e29b-41d4-a716-446655440000");

    const invalid = await client.callTool({
      name: "command_run",
      arguments: {
        sessionId: "7a354999-6a6c-42db-9467-e1416da255f1",
        command: "cat",
        env: { TOKEN: "secret" },
        idempotencyKey: "550e8400-e29b-41d4-a716-446655440001",
      },
    });
    expect(invalid.isError).toBe(true);
    expect(calls.some((call) => call.startsWith("command:"))).toBe(false);
  });
});
