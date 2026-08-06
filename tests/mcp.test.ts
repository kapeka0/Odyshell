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
  type ListedAgentSession,
} from "../packages/sdk/src/index.js";
import {
  PROTOCOL_VERSION,
  type SessionMachineScope,
} from "../packages/protocol/src/index.js";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  createApprovedOdyshellMcpServer,
} from "../apps/cli/src/mcp.js";
import {
  createApprovedMcpServer,
  type ApprovedMcpSessionRequestInput,
  type ApprovedMcpRuntime,
} from "../packages/mcp/src/index.js";

const closeCallbacks: Array<() => Promise<void>> = [];
const localAgentIdentity = {
  id: "9a7a6a54-5d4a-43d0-8ef4-0e0396096eeb",
  name: "Codex",
};
const localRequestId = "7d8730ef-075c-40d5-a72d-8101abe17260";
const localSessionId = "c837dd55-fdf0-47bb-887f-e4f857245dc7";
const localMachineId = "29f34f33-418c-4624-84c3-25818db42023";
const localTaskRunId = "codex-task-2026-08-05";

type JsonSchemaNode = {
  additionalProperties?: boolean;
  const?: unknown;
  properties?: Record<string, JsonSchemaNode>;
  [key: string]: unknown;
};

function findSchemaBranch(
  value: unknown,
  kind: string,
): JsonSchemaNode | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const schema = value as JsonSchemaNode;
  if (schema.properties?.kind?.const === kind) return schema;
  for (const nested of Object.values(schema)) {
    if (Array.isArray(nested)) {
      for (const candidate of nested) {
        const found = findSchemaBranch(candidate, kind);
        if (found) return found;
      }
      continue;
    }
    const found = findSchemaBranch(nested, kind);
    if (found) return found;
  }
  return undefined;
}

afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map((close) => close()));
});

describe("Odyshell MCP server", () => {
  it("excludes Host Shell commands from the operations request contract", () => {
    type OperationsRequest = Extract<
      ApprovedMcpSessionRequestInput,
      { operations: unknown }
    >;
    type RequestedAction = OperationsRequest["operations"][number]["action"];
    expectTypeOf<
      Extract<RequestedAction, { kind: "host.shell" }>
    >().toEqualTypeOf<never>();
  });

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
    expect(
      tools.find((tool) => tool.name === "session_request")?.description,
    ).toContain("Call sessions_list first");
    expect(client.getInstructions()).toContain(
      "For exploratory, iterative, or multi-command host work",
    );
    expect(client.getInstructions()).toContain(
      "A failed command does not close the Session",
    );
    expect(client.getInstructions()).toContain(
      "complete the Session only when the overall task succeeds or is abandoned",
    );
    expect(
      tools.find((tool) => tool.name === "session_request")?.description,
    ).toContain("Generate one stable runId for the Task Run");
    expect(
      tools.find((tool) => tool.name === "session_complete")?.description,
    ).toContain("Always call this after the Task Run finishes");
  });

  it("publishes mutually exclusive typed and Host Shell request schemas", async () => {
    const { client } = await connectServer(
      createApprovedOdyshellMcpServer(fakeApprovedOdyshell(), localAgentIdentity),
    );
    const { tools } = await client.listTools();
    const schema = tools.find((tool) => tool.name === "session_request")
      ?.inputSchema as { oneOf?: Array<{ required?: string[] }> } | undefined;

    expect(schema?.oneOf).toHaveLength(2);
    expect(schema?.oneOf?.map((branch) => branch.required)).toEqual(
      expect.arrayContaining([
        expect.arrayContaining(["operations"]),
        expect.arrayContaining(["hostShell", "runId"]),
      ]),
    );
    expect(schema?.oneOf?.every((branch) => !branch.required?.includes("title")))
      .toBe(true);
    expect(JSON.stringify(schema)).not.toContain('"const":"host.shell"');
    expect(JSON.stringify(schema)).not.toContain('"env"');
    expect(JSON.stringify(schema).match(/predecessorSessionId/gu)).toHaveLength(1);
  });

  it("publishes process execution without an environment property", async () => {
    const { client } = await connectServer(
      createApprovedOdyshellMcpServer(fakeApprovedOdyshell(), localAgentIdentity),
    );
    const { tools } = await client.listTools();
    const operationSchema = tools.find(
      (tool) => tool.name === "operation_execute",
    )?.inputSchema;
    const processSchema = findSchemaBranch(operationSchema, "process.exec");
    const hostShellSchema = findSchemaBranch(operationSchema, "host.shell");

    expect(processSchema).toBeDefined();
    expect(processSchema?.properties).not.toHaveProperty("env");
    expect(processSchema?.additionalProperties).toBe(false);
    expect(hostShellSchema?.properties).toHaveProperty("env");
  });

  it("requests Host Shell authority without anticipating a command", async () => {
    const request = vi.fn<ApprovedMcpRuntime["request"]>(async () => ({
      id: "7d8730ef-075c-40d5-a72d-8101abe17260",
      status: "pending",
      approvalUrl: "https://odyshell.test/approve",
      expiresAt: "2026-08-04T18:00:00.000Z",
    }));
    const runtime: ApprovedMcpRuntime = {
      machines: async () => [],
      ping: async () => ({ online: true }),
      request,
      sessions: async () => [],
      status: async () => ({ status: "pending" }),
      execute: async (input) => ({
        operation: {
          id: "server-operation-id",
          sessionId: input.sessionId,
          status: "succeeded",
          exitCode: 0,
          outputTruncated: false,
        },
        stdout: "",
        stderr: "",
      }),
      complete: async () => ({ status: "completed" }),
      timeline: async () => [],
    };
    const { client } = await connectServer(createApprovedMcpServer(runtime));

    const result = await client.callTool({
      name: "session_request",
      arguments: {
        hostShell: { machine: "desktop" },
        runId: localTaskRunId,
        predecessorSessionId: "c837dd55-fdf0-47bb-887f-e4f857245dc7",
        title: "Escalate to Host Shell",
      },
    });

    expect(result.isError, textOf(result)).not.toBe(true);
    expect(request).toHaveBeenCalledWith({
      hostShell: { machine: "desktop" },
      runId: localTaskRunId,
      predecessorSessionId: "c837dd55-fdf0-47bb-887f-e4f857245dc7",
      title: "Escalate to Host Shell",
      durationSeconds: 3_600,
    });

    const derivedTitle = await client.callTool({
      name: "session_request",
      arguments: {
        hostShell: { machine: "raspberrypi-5" },
        purpose: "Read current IP address",
        runId: localTaskRunId,
      },
    });

    expect(derivedTitle.isError, textOf(derivedTitle)).not.toBe(true);
    expect(request).toHaveBeenNthCalledWith(2, {
      hostShell: { machine: "raspberrypi-5" },
      title: "Read current IP address",
      purpose: "Read current IP address",
      runId: localTaskRunId,
      durationSeconds: 3_600,
    });

    const derivedOperationsTitle = await client.callTool({
      name: "session_request",
      arguments: {
        operations: [{
          machine: "raspberrypi-5",
          action: {
            kind: "process.exec",
            program: "hostname",
            args: ["-I"],
          },
        }],
      },
    });

    expect(
      derivedOperationsTitle.isError,
      textOf(derivedOperationsTitle),
    ).not.toBe(true);
    expect(request).toHaveBeenNthCalledWith(3, {
      operations: [{
        machine: "raspberrypi-5",
        action: {
          kind: "process.exec",
          program: "hostname",
          args: ["-I"],
          cwd: ".",
        },
      }],
      title: "Run process.exec on raspberrypi-5",
      durationSeconds: 3_600,
    });

    for (const arguments_ of [
      { title: "Missing request mode" },
      {
        title: "Missing Task Run",
        hostShell: { machine: "desktop" },
      },
      {
        title: "Blank Task Run",
        hostShell: { machine: "desktop" },
        runId: "   ",
      },
      {
        title: "Unjustified long Host Shell task",
        hostShell: { machine: "desktop" },
        runId: "long-task-run",
        durationSeconds: 3_601,
      },
      {
        title: "Ambiguous request mode",
        hostShell: { machine: "desktop" },
        operations: [{
          machine: "desktop",
          action: { kind: "fs.read", path: "README.md" },
        }],
      },
      {
        title: "Anticipated Host Shell command",
        operations: [{
          machine: "desktop",
          action: { kind: "host.shell", command: "whoami" },
        }],
      },
      {
        title: "Typed predecessor request",
        predecessorSessionId: "c837dd55-fdf0-47bb-887f-e4f857245dc7",
        operations: [{
          machine: "desktop",
          action: { kind: "fs.read", path: "README.md" },
        }],
      },
    ]) {
      const invalid = await client.callTool({
        name: "session_request",
        arguments: arguments_,
      });
      expect(invalid.isError).toBe(true);
    }
    expect(request).toHaveBeenCalledTimes(3);
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
      clientVersion: "0.13.1",
      protocolVersion: PROTOCOL_VERSION,
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

  it("reuses exact typed authority claimed by the same local MCP process", async () => {
    const { ods, requestSession } = localClaimedMcpFixture(
      localFilesystemScope(),
    );
    const { client } = await connectServer(
      createApprovedOdyshellMcpServer(ods, localAgentIdentity),
    );
    await claimLocalSession(client);

    const result = await requestLocalFile(client, "config/app.json");

    expect(result.isError, textOf(result)).not.toBe(true);
    expect(JSON.parse(textOf(result))).toMatchObject({
      id: localSessionId,
      sessionId: localSessionId,
      status: "ready",
      reused: true,
    });
    expect(requestSession).not.toHaveBeenCalled();

    const differentScope = await requestLocalFile(client, "secrets.env");
    expect(differentScope.isError, textOf(differentScope)).not.toBe(true);
    expect(textOf(differentScope)).toContain("Approval required");
    expect(requestSession).toHaveBeenCalledTimes(1);
  });

  it("reuses broad Host Shell authority claimed by the same local MCP process", async () => {
    const { ods, requestSession } = localClaimedMcpFixture(
      localHostShellScope(),
    );
    const { client } = await connectServer(
      createApprovedOdyshellMcpServer(ods, localAgentIdentity),
    );
    await claimLocalSession(client, localTaskRunId);

    const result = await client.callTool({
      name: "session_request",
      arguments: {
        hostShell: { machine: "rpi5" },
        runId: localTaskRunId,
        title: "Continue host diagnostics",
      },
    });

    expect(result.isError, textOf(result)).not.toBe(true);
    expect(JSON.parse(textOf(result))).toMatchObject({
      id: localSessionId,
      sessionId: localSessionId,
      status: "ready",
      reused: true,
    });
    expect(requestSession).not.toHaveBeenCalled();
  });

  it("does not reuse local Host Shell authority from a different Task Run", async () => {
    const { ods, requestSession } = localClaimedMcpFixture(
      localHostShellScope(),
    );
    const { client } = await connectServer(
      createApprovedOdyshellMcpServer(ods, localAgentIdentity),
    );
    await claimLocalSession(client, localTaskRunId);

    const result = await client.callTool({
      name: "session_request",
      arguments: {
        hostShell: { machine: "rpi5" },
        runId: "another-task-run",
        title: "Start unrelated host work",
      },
    });

    expect(result.isError, textOf(result)).not.toBe(true);
    expect(textOf(result)).toContain("Approval required");
    expect(requestSession).toHaveBeenCalledOnce();
  });

  it("rejects local Host Shell use and completion outside its Task Run", async () => {
    const { ods, claimSession } = localClaimedMcpFixture(localHostShellScope());
    const { client } = await connectServer(
      createApprovedOdyshellMcpServer(ods, localAgentIdentity),
    );
    const missingStatusRun = await claimLocalSession(client);
    expect(missingStatusRun.isError).toBe(true);
    expect(textOf(missingStatusRun)).toContain("task_run_id_required");
    expect(claimSession).not.toHaveBeenCalled();
    await claimLocalSession(client, localTaskRunId);
    expect(claimSession).toHaveBeenCalledWith(localRequestId, localTaskRunId);

    const operation = {
      idempotencyKey: "70843b92-1db1-4d67-9fa4-86e74227d8f2",
      sessionId: localSessionId,
      machine: "rpi5",
      action: { kind: "host.shell", command: "pwd" },
    };
    const missing = await client.callTool({
      name: "operation_execute",
      arguments: operation,
    });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("task_run_id_required");

    const mismatchedCompletion = await client.callTool({
      name: "session_complete",
      arguments: {
        sessionId: localSessionId,
        runId: "another-task-run",
        outcome: "failed",
      },
    });
    expect(mismatchedCompletion.isError).toBe(true);
    expect(textOf(mismatchedCompletion)).toContain("task_run_id_mismatch");

    const allowed = await client.callTool({
      name: "operation_execute",
      arguments: { ...operation, runId: localTaskRunId },
    });
    expect(allowed.isError, textOf(allowed)).not.toBe(true);
  });

  it("never reuses claimed authority for a linked Host Shell escalation", async () => {
    const predecessorSessionId = "40d867e5-a2a1-4cd2-8753-9928b737dcfa";
    const predecessor = localCanonicalSession(
      predecessorSessionId,
      [localFilesystemScope()],
    );
    const { ods, requestSession } = localClaimedMcpFixture(
      localHostShellScope(),
      { additionalSessions: [predecessor] },
    );
    const { client } = await connectServer(
      createApprovedOdyshellMcpServer(ods, localAgentIdentity),
    );
    await claimLocalSession(client, localTaskRunId);

    const result = await client.callTool({
      name: "session_request",
      arguments: {
        hostShell: { machine: "rpi5" },
        runId: localTaskRunId,
        predecessorSessionId,
        title: "Escalate configuration inspection",
      },
    });

    expect(result.isError, textOf(result)).not.toBe(true);
    expect(textOf(result)).toContain("Approval required");
    expect(requestSession).toHaveBeenCalledWith(
      expect.objectContaining({ predecessorSessionId }),
    );
  });

  it("does not reuse local claimed authority across MCP process restarts", async () => {
    const { ods, requestSession } = localClaimedMcpFixture(
      localFilesystemScope(),
    );
    const first = await connectServer(
      createApprovedOdyshellMcpServer(ods, localAgentIdentity),
    );
    await claimLocalSession(first.client);
    const restarted = await connectServer(
      createApprovedOdyshellMcpServer(ods, localAgentIdentity),
    );

    const result = await requestLocalFile(restarted.client, "config/app.json");

    expect(result.isError, textOf(result)).not.toBe(true);
    expect(textOf(result)).toContain("Approval required");
    expect(requestSession).toHaveBeenCalledTimes(1);
  });

  it("fails closed when local Session state cannot be revalidated", async () => {
    const { ods, requestSession } = localClaimedMcpFixture(
      localFilesystemScope(),
      { failSessionRevalidation: true },
    );
    const { client } = await connectServer(
      createApprovedOdyshellMcpServer(ods, localAgentIdentity),
    );
    await claimLocalSession(client);

    const result = await requestLocalFile(client, "config/app.json");

    expect(result.isError).toBe(true);
    expect(requestSession).not.toHaveBeenCalled();
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
        idempotencyKey: "a6e9dd35-5882-4167-a30b-9aa0382d2630",
        sessionId: "c837dd55-fdf0-47bb-887f-e4f857245dc7",
        machine: "rpi5",
        action: { kind: "fs.read", path: "config/app.json" },
      },
    });

    expect(result.isError).not.toBe(true);
    expect(execute).toHaveBeenCalledWith(
      "machine-id",
      { kind: "fs.read", path: "config/app.json" },
      {
        timeoutSeconds: 600,
        idempotencyKey: "a6e9dd35-5882-4167-a30b-9aa0382d2630",
      },
    );
    expect(textOf(result)).not.toContain("ods_session_secret");
  });

  it("rejects operation_execute without an explicit UUID idempotency key", async () => {
    const execute = vi.fn(
      async (_machineId: string, _action: unknown, _options: unknown) =>
        successfulOperation("ok"),
    );
    const server = createApprovedOdyshellMcpServer(
      fakeApprovedOdyshell({ execute }),
      {
        id: "9a7a6a54-5d4a-43d0-8ef4-0e0396096eeb",
        name: "Claude",
      },
    );
    const { client } = await connectServer(server);
    const { tools } = await client.listTools();
    const operationTool = tools.find((tool) => tool.name === "operation_execute");
    expect(JSON.stringify(operationTool?.inputSchema)).toContain("idempotencyKey");
    await client.callTool({
      name: "session_status",
      arguments: { requestId: "7d8730ef-075c-40d5-a72d-8101abe17260" },
    });

    const result = await client.callTool({
      name: "operation_execute",
      arguments: {
        sessionId: "c837dd55-fdf0-47bb-887f-e4f857245dc7",
        machine: "machine-id",
        action: { kind: "host.shell", command: "node -v" },
        timeoutSeconds: 120,
      },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("idempotencyKey");
    expect(execute).not.toHaveBeenCalled();
  });

  it("forwards the same UUID on retry and a new UUID for identical new work", async () => {
    const execute = vi.fn(
      async (_machineId: string, _action: unknown, _options: unknown) =>
        successfulOperation("ok"),
    );
    const { client } = await connectServer(
      createApprovedOdyshellMcpServer(
        fakeApprovedOdyshell({ execute }),
        localAgentIdentity,
      ),
    );
    await client.callTool({
      name: "session_status",
      arguments: { requestId: localRequestId },
    });
    const retryKey = "a6e9dd35-5882-4167-a30b-9aa0382d2630";
    const newKey = "2bb990a0-beb5-45ac-9086-88cdb3e579a6";
    const logicalOperation = {
      sessionId: localSessionId,
      machine: "machine-id",
      action: { kind: "host.shell" as const, command: "node -v" },
      timeoutSeconds: 120,
    };

    const first = await client.callTool({
      name: "operation_execute",
      arguments: { idempotencyKey: retryKey, ...logicalOperation },
    });
    const retry = await client.callTool({
      name: "operation_execute",
      arguments: { idempotencyKey: retryKey, ...logicalOperation },
    });
    const newLogicalOperation = await client.callTool({
      name: "operation_execute",
      arguments: { idempotencyKey: newKey, ...logicalOperation },
    });

    expect(first.isError).not.toBe(true);
    expect(retry.isError).not.toBe(true);
    expect(newLogicalOperation.isError).not.toBe(true);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(
      execute.mock.calls.map(
        (call) => (call[2] as { idempotencyKey: string }).idempotencyKey,
      ),
    ).toEqual([retryKey, retryKey, newKey]);
    expect(execute.mock.calls[0]?.[1]).toEqual(execute.mock.calls[2]?.[1]);
    expect(textOf(first)).toContain(`"idempotencyKey": "${retryKey}"`);
    expect(textOf(first)).toContain('"operationId": "operation-id"');
    expect(retryKey).not.toBe("operation-id");
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
        idempotencyKey: "f8ad5ef8-6a3f-4c92-b521-0a1a2642d797",
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
        idempotencyKey: "6ca103cb-daad-481d-828f-b29b62348d6a",
        sessionId: "c837dd55-fdf0-47bb-887f-e4f857245dc7",
        machine: "desktop",
        action: { kind: "process.exec", program: "df", args: ["-h"] },
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

  it(
    "serves the CLI over clean MCP stdio",
    async () => {
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
    },
    15_000,
  );
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

function localFilesystemScope(): SessionMachineScope {
  return {
    machineId: localMachineId,
    profile: "workspace",
    capabilities: ["fs.read"],
    restrictions: {
      filesystem: {
        paths: [{ path: "config/app.json", includeDescendants: false }],
      },
    },
  };
}

function localHostShellScope(): SessionMachineScope {
  return {
    machineId: localMachineId,
    profile: "workspace",
    capabilities: ["host.shell"],
    restrictions: {},
  };
}

function localCanonicalSession(
  sessionId: string,
  scopes: SessionMachineScope[],
): ListedAgentSession {
  return {
    id: sessionId,
    agentId: localAgentIdentity.id,
    agentName: localAgentIdentity.name,
    title: "Local MCP authority",
    status: "active",
    runId: localTaskRunId,
    expiresAt: "2099-08-04T19:00:00.000Z",
    scopes,
    targets: [
      { machineId: localMachineId, machineName: "rpi5", status: "ready" },
    ],
    createdAt: "2099-08-04T18:00:00.000Z",
    updatedAt: "2099-08-04T18:00:01.000Z",
  };
}

function localClaimedMcpFixture(
  scope: SessionMachineScope,
  options: {
    additionalSessions?: ListedAgentSession[];
    failSessionRevalidation?: boolean;
  } = {},
): {
  ods: Odyshell;
  requestSession: ReturnType<typeof vi.fn>;
  claimSession: ReturnType<typeof vi.fn>;
} {
  const requestSession = vi.fn(async () => ({
    id: "837544aa-ad50-4c8c-a3c8-8a41b25a14db",
    status: "pending" as const,
    approvalUrl: "https://odyshell.test/approve-new-session",
    expiresAt: "2099-08-04T18:10:00.000Z",
    scopes: [],
  }));
  const claimSession = vi.fn(async () => ({
    sessionId: localSessionId,
    sessionToken: "ods_session_secret",
    scopes: [scope],
    status: "opening" as const,
    expiresAt: "2099-08-04T19:00:00.000Z",
  }));
  const canonical = localCanonicalSession(localSessionId, [scope]);
  let sessionReads = 0;
  const ods = fakeApprovedOdyshell({
    requestSession,
    requests: async () => [{
      id: localRequestId,
      title: "Local MCP authority",
      status: "approved" as const,
      runId: localTaskRunId,
      scopes: [scope],
      durationSeconds: 3_600,
      expiresAt: "2099-08-04T18:10:00.000Z",
    }],
    claim: claimSession,
    sessions: async () => {
      sessionReads += 1;
      if (options.failSessionRevalidation && sessionReads > 1) {
        throw new Error("Session state unavailable");
      }
      return [canonical, ...(options.additionalSessions ?? [])];
    },
  });
  vi.spyOn(ods, "resolveMachine").mockResolvedValue({
    id: localMachineId,
    name: "rpi5",
    status: "online",
    online: true,
    lastSeenAt: null,
    enrolledAt: "2099-08-04T18:00:00.000Z",
    compatible: true,
    upgradeRequired: false,
    clientVersion: "0.14.0",
    protocolVersion: PROTOCOL_VERSION,
  });
  return { ods, requestSession, claimSession };
}

function claimLocalSession(
  client: Client,
  runId?: string,
): Promise<CallToolResult> {
  return client.callTool({
    name: "session_status",
    arguments: { requestId: localRequestId, ...(runId ? { runId } : {}) },
  });
}

function requestLocalFile(
  client: Client,
  path: string,
): Promise<CallToolResult> {
  return client.callTool({
    name: "session_request",
    arguments: {
      operations: [
        { machine: "rpi5", action: { kind: "fs.read", path } },
      ],
      title: `Read ${path}`,
    },
  });
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
    claim?: (...args: unknown[]) => Promise<unknown>;
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
  const claim = vi.fn(overrides.claim ?? (async () => ({
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
  })));
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
