import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { createHash, randomUUID } from "node:crypto";
import {
  sessionOperationActionSchema,
  type OperationAction,
} from "@odyshell/protocol";
import { z } from "zod";

const machineSchema = z.string().trim().min(1).max(256);
const timeoutSchema = z.number().int().min(1).max(1800).default(120);

export type ApprovedMcpRuntime = {
  machines(): Promise<unknown>;
  ping(machine: string): Promise<unknown>;
  request(input: {
    operations: Array<{ machine: string; action: OperationAction }>;
    title: string;
    purpose?: string;
    durationSeconds: number;
    runId?: string;
  }): Promise<ApprovedMcpSessionRequest>;
  sessions(input?: { includeHistory?: boolean }): Promise<unknown>;
  status(requestId: string): Promise<unknown>;
  execute(input: {
    sessionId: string;
    machine: string;
    action: OperationAction;
    timeoutSeconds: number;
    operationId: string;
  }): Promise<ApprovedMcpOperationResult>;
  complete(input: {
    sessionId: string;
    outcome: "succeeded" | "failed";
    summary?: string;
  }): Promise<unknown>;
  timeline(sessionId: string): Promise<unknown>;
};

export type ApprovedMcpSessionRequest = {
  id: string;
  sessionId?: string;
  status: string;
  reused?: boolean;
  approvalUrl?: string;
  expiresAt: string | null;
};

export type ApprovedMcpOperationResult = {
  operation: {
    id: string;
    sessionId: string;
    status: string;
    exitCode?: number | null;
    error?: string | null;
    outputTruncated: boolean;
  };
  stdout: string;
  stderr: string;
  result?: unknown;
  resultText?: string;
};

export function createApprovedMcpServer(
  runtime: ApprovedMcpRuntime,
  reportUnexpectedError: (error: unknown) => void = () => undefined,
): McpServer {
  const operationNamespace = randomUUID();
  const server = new McpServer(
    { name: "odyshell", version: "0.14.0" },
    {
      instructions:
        "Inspect machines before choosing platform-specific operations. Before requesting authority, call sessions_list and reuse a ready Session that already covers the machine and action. session_request also reuses compatible authority server-side. Machine and Session results include platform, architecture, runner, capabilities, default shell and privilegeEscalation. Prefer typed filesystem, Docker and process.exec operations. Request process.shell only for multi-step work that must use prior stdout or stderr; it grants broad shell access for a short Session, is never autoapproved and every command is audited. When privilegeEscalation is sudo, explicitly mention root access in the Session title or purpose before requesting a sudo command. Show approval links verbatim, then call session_status. Always pass the explicit sessionId to operation_execute. Credentials stay inside Odyshell.",
    },
  );

  server.registerTool(
    "machines_list",
    {
      title: "List Odyshell machines",
      description:
        "List machines and inspect their description, platform, runner, effective capabilities and privilege-escalation policy before requesting operations.",
      inputSchema: z.object({}),
      annotations: readOnlyAnnotations,
    },
    async () => runTool(() => runtime.machines(), reportUnexpectedError),
  );

  server.registerTool(
    "machine_ping",
    {
      title: "Ping an Odyshell machine",
      description: "Check the complete Odyshell path to a machine.",
      inputSchema: z.object({ machine: machineSchema }),
      annotations: readOnlyAnnotations,
    },
    async ({ machine }) =>
      runTool(() => runtime.ping(machine), reportUnexpectedError),
  );

  server.registerTool(
    "session_request",
    {
      title: "Request operation access",
      description:
        "Call sessions_list first and reuse compatible ready authority. Otherwise request a temporary Session scoped to one or more operations; the Server performs a final reuse check before creating approval. Prefer structured operations. Use process.shell only when a multi-step task must inspect output before choosing the next command; it grants broad shell access, requires manual approval and remains temporary. Use machine platform, defaultShell and privilegeEscalation metadata before composing OS-specific commands. If sudo is available, explicitly disclose intended root access in the title or purpose. If approval is required, show the returned link and follow nextAction.",
      inputSchema: z.object({
        operations: z
          .array(
            z.object({
              machine: machineSchema,
              action: sessionOperationActionSchema,
            }),
          )
          .min(1)
          .max(16),
        title: z.string().trim().min(1).max(96),
        purpose: z.string().trim().min(1).max(280).optional(),
        durationSeconds: z.number().int().min(60).max(86_400).optional(),
        runId: z.string().trim().min(1).max(128).optional(),
      }),
      annotations: requestAnnotations,
    },
    async (input) =>
      runSessionRequest(
        () =>
          runtime.request({
            operations: input.operations,
            title: input.title,
            ...(input.purpose ? { purpose: input.purpose } : {}),
            durationSeconds: input.durationSeconds ?? 3_600,
            ...(input.runId ? { runId: input.runId } : {}),
          }),
        reportUnexpectedError,
      ),
  );

  server.registerTool(
    "sessions_list",
    {
      title: "List Sessions",
      description:
        "List pending requests and active Sessions owned by this Agent. Active authority is returned by default so a new chat can reuse an explicit Session identifier; request history only when needed.",
      inputSchema: z.object({ includeHistory: z.boolean().default(false) }),
      annotations: readOnlyAnnotations,
    },
    async ({ includeHistory }) =>
      runTool(() => runtime.sessions({ includeHistory }), reportUnexpectedError),
  );

  server.registerTool(
    "session_status",
    {
      title: "Check access request",
      description:
        "Check whether a request was approved and make the resulting Session available to this MCP installation.",
      inputSchema: z.object({ requestId: z.string().uuid() }),
      annotations: requestAnnotations,
    },
    async ({ requestId }) =>
      runSessionStatus(
        requestId,
        () => runtime.status(requestId),
        reportUnexpectedError,
      ),
  );

  server.registerTool(
    "operation_execute",
    {
      title: "Execute approved operation",
      description:
        "Execute an exact typed process, filesystem or Docker operation inside an approved Session. The action must match what the user approved. Odyshell owns the idempotency key and safely reduces a requested timeout to the Session lifetime remaining.",
      inputSchema: z.object({
        sessionId: z.string().uuid(),
        machine: machineSchema,
        action: sessionOperationActionSchema,
        timeoutSeconds: timeoutSchema,
      }),
      annotations: destructiveAnnotations,
    },
    async (input, context) =>
      runOperation(
        () =>
          runtime.execute({
            ...input,
            operationId: operationIdForRequest(
              operationNamespace,
              context.mcpReq.id,
            ),
          }),
        reportUnexpectedError,
      ),
  );

  server.registerTool(
    "session_complete",
    {
      title: "Complete a Session",
      description:
        "Close an approved Session after all operations finish and record the agent-reported outcome.",
      inputSchema: z.object({
        sessionId: z.string().uuid(),
        outcome: z.enum(["succeeded", "failed"]).default("succeeded"),
        summary: z.string().trim().min(1).max(512).optional(),
      }),
      annotations: destructiveAnnotations,
    },
    async (input) =>
      runTool(
        () =>
          runtime.complete({
            sessionId: input.sessionId,
            outcome: input.outcome,
            ...(input.summary ? { summary: input.summary } : {}),
          }),
        reportUnexpectedError,
      ),
  );

  server.registerTool(
    "timeline_list",
    {
      title: "List Session timeline",
      description: "Read the verified activity timeline for a Session.",
      inputSchema: z.object({ sessionId: z.string().uuid() }),
      annotations: readOnlyAnnotations,
    },
    async ({ sessionId }) =>
      runTool(() => runtime.timeline(sessionId), reportUnexpectedError),
  );

  return server;
}

function operationIdForRequest(
  namespace: string,
  requestId: string | number,
): string {
  const bytes = createHash("sha256")
    .update(`${namespace}:${typeof requestId}:${String(requestId)}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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

const destructiveAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;

async function runOperation(
  operation: () => Promise<ApprovedMcpOperationResult>,
  reportUnexpectedError: (error: unknown) => void,
): Promise<CallToolResult> {
  try {
    const result = await operation();
    const unavailableProgram = [
      result.operation.error,
      result.stderr,
    ].some((value) => typeof value === "string" && /(?:ENOENT|not recognized|not found)/i.test(value));
    return {
      ...textResult({
        operationId: result.operation.id,
        sessionId: result.operation.sessionId,
        status: result.operation.status,
        exitCode: result.operation.exitCode ?? null,
        ...(result.operation.error ? { error: result.operation.error } : {}),
        outputTruncated: result.operation.outputTruncated,
        stdout: result.stdout,
        stderr: result.stderr,
        result: result.result,
        resultText: result.resultText,
        ...(unavailableProgram
          ? {
              guidance:
                "The requested program is unavailable on this machine. Call machines_list, inspect platform and defaultShell, then choose a native command and request a new Session if its scope must change.",
            }
          : {}),
      }),
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

async function runSessionRequest(
  action: () => Promise<ApprovedMcpSessionRequest>,
  reportUnexpectedError: (error: unknown) => void,
): Promise<CallToolResult> {
  try {
    const result = await action();
    if (result.status !== "pending" || !result.approvalUrl) {
      return textResult({
        ...result,
        ...(result.status === "ready" && result.sessionId
          ? {
              nextAction: {
                tool: "operation_execute",
                sessionId: result.sessionId,
              },
            }
          : {}),
      });
    }
    return {
      content: [
        {
          type: "text",
          text: [
            "Approval required.",
            "",
            "Open this link to approve or deny the Session:",
            result.approvalUrl,
            "",
            `Request ID: ${result.id}`,
            ...(result.expiresAt
              ? [`Approval expires: ${result.expiresAt}`]
              : []),
            "",
            "After the user reviews it, follow this next action:",
            JSON.stringify(
              {
                nextAction: {
                  tool: "session_status",
                  requestId: result.id,
                },
              },
              null,
              2,
            ),
          ].join("\n"),
        },
      ],
    };
  } catch (error) {
    return toolError(error, reportUnexpectedError);
  }
}

async function runSessionStatus(
  requestId: string,
  action: () => Promise<unknown>,
  reportUnexpectedError: (error: unknown) => void,
): Promise<CallToolResult> {
  try {
    const result = await action();
    if (!isRecord(result) || typeof result.status !== "string") {
      return textResult(result);
    }
    if (result.status === "ready" && typeof result.sessionId === "string") {
      return textResult({
        ...result,
        nextAction: {
          tool: "operation_execute",
          sessionId: result.sessionId,
          instruction: "Execute only an operation approved for this Session.",
        },
      });
    }
    if (result.status === "pending" || result.status === "opening") {
      return textResult({
        ...result,
        nextAction: {
          tool: "session_status",
          requestId,
          instruction:
            result.status === "pending"
              ? "Wait for the user decision, then check again."
              : "The Client is opening the Session; check again shortly.",
        },
      });
    }
    return textResult(result);
  } catch (error) {
    return toolError(error, reportUnexpectedError);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

function isExpectedError(
  error: unknown,
): error is Error & { expected: true; code: string; status?: number } {
  return (
    error instanceof Error &&
    (error as Error & { expected?: unknown }).expected === true &&
    typeof (error as Error & { code?: unknown }).code === "string"
  );
}
