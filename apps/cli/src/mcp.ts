import process from "node:process";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import {
  serveStdio,
  type StdioServerHandle,
} from "@modelcontextprotocol/server/stdio";
import {
  operationActionSchema,
  operationEnvironmentSchema,
  relativePathSchema,
} from "@odyshell/protocol";
import {
  ExpectedError,
  Odyshell,
  type ClaimedAgentSession,
  type OperationResult,
} from "@odyshell/sdk";
import { z } from "zod";

const machineSchema = z.string().trim().min(1).max(256);
const timeoutSchema = z.number().int().min(1).max(1800).default(120);
const environmentSchema = operationEnvironmentSchema.default({});

export type McpAgentIdentity = {
  id: string;
  name: string;
};

export function createApprovedOdyshellMcpServer(
  ods: Odyshell,
  identity: McpAgentIdentity,
  reportUnexpectedError: (error: unknown) => void = () => undefined,
): McpServer {
  const claims = new Map<string, ClaimedAgentSession>();
  const requestSessions = new Map<string, string>();
  const server = new McpServer(
    { name: "odyshell", version: "0.2.0" },
    {
      instructions:
        "Request an explicit temporary Session for one typed operation. Ask the user to approve the URL, check session_status, then call operation_execute. Session credentials remain inside this MCP process.",
    },
  );

  server.registerTool(
    "machines_list",
    {
      title: "List Odyshell machines",
      description: "List the signed-in workspace machines available for a request.",
      inputSchema: z.object({}),
      annotations: readOnlyAnnotations,
    },
    async () => runTool(() => ods.machines(), reportUnexpectedError),
  );

  server.registerTool(
    "session_request",
    {
      title: "Request operation access",
      description:
        "Request a temporary Session scoped to one typed operation. The user approves the returned URL unless a matching policy applies.",
      inputSchema: z.object({
        machine: machineSchema,
        action: operationActionSchema,
        purpose: z.string().trim().min(1).max(512),
        durationSeconds: z.number().int().min(60).max(86_400).default(900),
        runId: z.string().trim().min(1).max(128).optional(),
      }),
      annotations: requestAnnotations,
    },
    async (input) =>
      runTool(async () => {
        const machine = await ods.resolveMachine(input.machine);
        return ods.agent(identity).requestOperationSession({
          machineId: machine.id,
          purpose: input.purpose,
          action: input.action,
          durationSeconds: input.durationSeconds,
          ...(input.runId ? { runId: input.runId } : {}),
        });
      }, reportUnexpectedError),
  );

  server.registerTool(
    "session_status",
    {
      title: "Check access request",
      description:
        "Check whether a request was approved. An approved credential is claimed once and kept private inside MCP.",
      inputSchema: z.object({ requestId: z.string().uuid() }),
      annotations: claimAnnotations,
    },
    async ({ requestId }) =>
      runTool(async () => {
        const existingSessionId = requestSessions.get(requestId);
        const existingClaim = existingSessionId
          ? claims.get(existingSessionId)
          : undefined;
        if (existingClaim) return safeClaim(existingClaim);

        const agent = ods.agent(identity);
        const status = await agent.status(requestId);
        if (status.status === "approved") {
          const claim = await agent.claim(requestId);
          claims.set(claim.sessionId, claim);
          requestSessions.set(requestId, claim.sessionId);
          return safeClaim(claim);
        }
        if (status.status === "claimed") {
          throw new ExpectedError(
            "This request was already claimed by another MCP process.",
            "session_claim_unavailable",
          );
        }
        return status;
      }, reportUnexpectedError),
  );

  server.registerTool(
    "operation_execute",
    {
      title: "Execute approved operation",
      description:
        "Execute a typed process, filesystem or Docker operation inside a claimed Session.",
      inputSchema: z.object({
        sessionId: z.string().uuid(),
        machine: machineSchema,
        action: operationActionSchema,
        timeoutSeconds: timeoutSchema,
      }),
      annotations: {
        title: "Execute approved operation",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      runOperation(async () => {
        const claim = claims.get(input.sessionId);
        if (!claim) {
          throw new ExpectedError(
            "No claimed credential is available for this session.",
            "session_claim_unavailable",
          );
        }
        return ods.claimedSession(claim).execute(
          input.machine,
          input.action,
          { timeoutSeconds: input.timeoutSeconds },
        );
      }, reportUnexpectedError),
  );

  return server;
}

function safeClaim(claim: ClaimedAgentSession): Record<string, unknown> {
  return {
    status: "ready",
    sessionId: claim.sessionId,
    machines: claim.scopes.map((scope) => ({
      machineId: scope.machineId,
      capabilities: scope.capabilities,
    })),
    expiresAt: claim.expiresAt,
  };
}

export function createOdyshellMcpServer(
  ods: Odyshell,
  reportUnexpectedError: (error: unknown) => void = () => undefined,
): McpServer {
  const server = new McpServer(
    { name: "odyshell", version: "0.1.0" },
    {
      instructions:
        "Use typed filesystem and process tools on machines already allowed by the current Odyshell agent token. Prefer process_exec over process_shell. All paths are relative to the machine workspace.",
    },
  );

  server.registerTool(
    "machines_list",
    {
      title: "List Odyshell machines",
      description: "List the private machines this agent token may access.",
      inputSchema: z.object({}),
      annotations: readOnlyAnnotations,
    },
    async () => runTool(() => ods.machines(), reportUnexpectedError),
  );

  server.registerTool(
    "machine_ping",
    {
      title: "Ping an Odyshell machine",
      description: "Check the complete Odyshell path to an allowed machine.",
      inputSchema: z.object({ machine: machineSchema }),
      annotations: readOnlyAnnotations,
    },
    async ({ machine }) =>
      runTool(async () => {
        const resolved = await ods.resolveMachine(machine);
        return ods.ping(resolved.id);
      }, reportUnexpectedError),
  );

  server.registerTool(
    "process_exec",
    {
      title: "Execute a program",
      description:
        "Execute one program without a shell in a disposable, audited session. Prefer this over process_shell.",
      inputSchema: z.object({
        machine: machineSchema,
        program: z.string().min(1).max(1024),
        args: z.array(z.string().max(16_384)).max(256).default([]),
        cwd: relativePathSchema.default("."),
        env: environmentSchema,
        timeoutSeconds: timeoutSchema,
      }),
      annotations: {
        title: "Execute a program",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      runOperation(
        () =>
          ods.process.exec({
            ...operationOptions(input.timeoutSeconds),
            machine: input.machine,
            program: input.program,
            args: input.args,
            cwd: input.cwd,
            env: input.env,
          }),
        reportUnexpectedError,
      ),
  );

  server.registerTool(
    "process_shell",
    {
      title: "Execute a shell command",
      description:
        "Execute a command through the machine shell in a disposable, audited session. Requires the separate process.shell capability.",
      inputSchema: z.object({
        machine: machineSchema,
        command: z.string().min(1).max(65_536),
        cwd: relativePathSchema.default("."),
        env: environmentSchema,
        timeoutSeconds: timeoutSchema,
      }),
      annotations: {
        title: "Execute a shell command",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      runOperation(
        () =>
          ods.process.shell({
            ...operationOptions(input.timeoutSeconds),
            machine: input.machine,
            command: input.command,
            cwd: input.cwd,
            env: input.env,
          }),
        reportUnexpectedError,
      ),
  );

  registerFilesystemTools(server, ods, reportUnexpectedError);

  server.registerTool(
    "docker_logs",
    {
      title: "Read Docker logs",
      description: "Read recent logs from an allowed container on a machine.",
      inputSchema: z.object({
        machine: machineSchema,
        container: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
        tail: z.number().int().min(1).max(10_000).default(200),
        timestamps: z.boolean().default(false),
        timeoutSeconds: timeoutSchema,
      }),
      annotations: readOnlyAnnotations,
    },
    async (input) =>
      runOperation(
        () =>
          ods.docker.logs({
            ...operationOptions(input.timeoutSeconds),
            machine: input.machine,
            container: input.container,
            tail: input.tail,
            timestamps: input.timestamps,
          }),
        reportUnexpectedError,
      ),
  );

  server.registerTool(
    "audit_list",
    {
      title: "List this agent's audit trail",
      description: "Show recent Odyshell audit events for the current agent token.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(500).default(100),
      }),
      annotations: readOnlyAnnotations,
    },
    async ({ limit }) =>
      runTool(() => ods.audit(limit, false), reportUnexpectedError),
  );

  return server;
}

export function serveOdyshellMcp(ods: Odyshell): StdioServerHandle {
  return serveStdio(
    () =>
      createOdyshellMcpServer(ods, (error) => {
        process.stderr.write(
          `[odyshell-mcp] Unexpected tool error: ${formatUnexpectedError(error)}\n`,
        );
      }),
    {
      onerror: (error) => {
        process.stderr.write(`[odyshell-mcp] Transport error: ${error.stack ?? error.message}\n`);
      },
    },
  );
}

export function serveApprovedOdyshellMcp(
  ods: Odyshell,
  identity: McpAgentIdentity,
): StdioServerHandle {
  return serveStdio(
    () =>
      createApprovedOdyshellMcpServer(ods, identity, (error) => {
        process.stderr.write(
          `[odyshell-mcp] Unexpected tool error: ${formatUnexpectedError(error)}\n`,
        );
      }),
    {
      onerror: (error) => {
        process.stderr.write(
          `[odyshell-mcp] Transport error: ${error.stack ?? error.message}\n`,
        );
      },
    },
  );
}

function registerFilesystemTools(
  server: McpServer,
  ods: Odyshell,
  reportUnexpectedError: (error: unknown) => void,
): void {
  server.registerTool(
    "filesystem_stat",
    {
      title: "Inspect a filesystem path",
      description: "Read metadata for a path relative to the machine workspace.",
      inputSchema: z.object({ machine: machineSchema, path: relativePathSchema }),
      annotations: readOnlyAnnotations,
    },
    async (input) =>
      runOperation(() => ods.fs.stat(input), reportUnexpectedError),
  );

  server.registerTool(
    "filesystem_list",
    {
      title: "List a directory",
      description: "List a directory relative to the machine workspace.",
      inputSchema: z.object({
        machine: machineSchema,
        path: relativePathSchema.default("."),
      }),
      annotations: readOnlyAnnotations,
    },
    async (input) =>
      runOperation(() => ods.fs.list(input), reportUnexpectedError),
  );

  server.registerTool(
    "filesystem_search",
    {
      title: "Search the workspace",
      description: "Search for matching filenames below a workspace-relative path.",
      inputSchema: z.object({
        machine: machineSchema,
        query: z.string().min(1).max(256),
        path: relativePathSchema.default("."),
        maxResults: z.number().int().min(1).max(1_000).default(100),
      }),
      annotations: readOnlyAnnotations,
    },
    async (input) =>
      runOperation(() => ods.fs.search(input), reportUnexpectedError),
  );

  server.registerTool(
    "filesystem_read",
    {
      title: "Read a file",
      description: "Read a file relative to the machine workspace.",
      inputSchema: z.object({ machine: machineSchema, path: relativePathSchema }),
      annotations: readOnlyAnnotations,
    },
    async (input) =>
      runOperation(() => ods.fs.read(input), reportUnexpectedError),
  );

  server.registerTool(
    "filesystem_write",
    {
      title: "Write a file",
      description: "Write UTF-8 content to a file relative to the machine workspace.",
      inputSchema: z.object({
        machine: machineSchema,
        path: relativePathSchema,
        content: z.string().max(8 * 1024 * 1024),
        createParents: z.boolean().default(false),
      }),
      annotations: {
        title: "Write a file",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) =>
      runOperation(() => ods.fs.write(input), reportUnexpectedError),
  );

  server.registerTool(
    "filesystem_mkdir",
    {
      title: "Create a directory",
      description: "Create a directory relative to the machine workspace.",
      inputSchema: z.object({
        machine: machineSchema,
        path: relativePathSchema,
        recursive: z.boolean().default(true),
      }),
      annotations: {
        title: "Create a directory",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) =>
      runOperation(() => ods.fs.mkdir(input), reportUnexpectedError),
  );

  server.registerTool(
    "filesystem_remove",
    {
      title: "Remove a filesystem path",
      description: "Remove a path relative to the machine workspace.",
      inputSchema: z.object({
        machine: machineSchema,
        path: relativePathSchema,
        recursive: z.boolean().default(false),
      }),
      annotations: {
        title: "Remove a filesystem path",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) =>
      runOperation(() => ods.fs.remove(input), reportUnexpectedError),
  );
}

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const requestAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const claimAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

function operationOptions(timeoutSeconds: number): {
  ttlSeconds: number;
  timeoutSeconds: number;
} {
  return {
    ttlSeconds: Math.min(3600, Math.max(10, timeoutSeconds + 30)),
    timeoutSeconds,
  };
}

async function runOperation(
  operation: () => Promise<OperationResult>,
  reportUnexpectedError: (error: unknown) => void,
): Promise<CallToolResult> {
  try {
    const result = await operation();
    return {
      ...textResult(operationPayload(result)),
      ...(result.operation.status === "succeeded" ? {} : { isError: true }),
    };
  } catch (error) {
    return toolError(error, reportUnexpectedError);
  }
}

async function runTool(
  action: () => Promise<unknown>,
  reportUnexpectedError: (error: unknown) => void,
): Promise<CallToolResult> {
  try {
    return textResult(await action());
  } catch (error) {
    return toolError(error, reportUnexpectedError);
  }
}

function toolError(
  error: unknown,
  reportUnexpectedError: (error: unknown) => void,
): CallToolResult {
  if (isExpectedError(error)) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: error.message,
            code: error.code,
            ...(typeof error.status === "number" ? { status: error.status } : {}),
          }),
        },
      ],
      isError: true,
    };
  }
  reportUnexpectedError(error);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: "Odyshell operation failed unexpectedly" }),
      },
    ],
    isError: true,
  };
}

function textResult(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function operationPayload(result: OperationResult): Record<string, unknown> {
  return {
    operationId: result.operation.id,
    sessionId: result.operation.sessionId,
    status: result.operation.status,
    exitCode: result.operation.exitCode,
    ...(result.operation.error ? { error: result.operation.error } : {}),
    outputTruncated: result.operation.outputTruncated,
    stdout: result.stdout,
    stderr: result.stderr,
    result: result.result,
    resultText: result.resultText,
  };
}

function isExpectedError(
  error: unknown,
): error is Error & { expected: true; code: string; status?: number } {
  return (
    error instanceof Error &&
    (error as Error & { expected?: unknown }).expected === true &&
    typeof (error as Error & { code?: unknown }).code === "string"
  );
}

function formatUnexpectedError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.stack ?? error.message;
}
