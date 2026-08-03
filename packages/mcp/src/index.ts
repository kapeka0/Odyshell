import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { operationActionSchema, type OperationAction } from "@odyshell/protocol";
import { z } from "zod";

const machineSchema = z.string().trim().min(1).max(256);
const timeoutSchema = z.number().int().min(1).max(1800).default(120);

export type ApprovedMcpRuntime = {
  machines(): Promise<unknown>;
  ping(machine: string): Promise<unknown>;
  request(input: {
    operations: Array<{ machine: string; action: OperationAction }>;
    purpose: string;
    durationSeconds: number;
    runId?: string;
  }): Promise<ApprovedMcpSessionRequest>;
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
  status: string;
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
  const server = new McpServer(
    { name: "odyshell", version: "0.10.0" },
    {
      instructions:
        "Request an explicit temporary Session for a typed operation. When session_request returns an approval URL, show it verbatim as a clickable link and wait for the user to approve or deny it. Then check session_status before executing. Credentials stay inside Odyshell.",
    },
  );

  server.registerTool(
    "machines_list",
    {
      title: "List Odyshell machines",
      description: "List machines available for a Session request.",
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
        "Request a temporary Session scoped to one or more typed operations. If approval is required, show the returned link to the user and wait for their decision.",
      inputSchema: z.object({
        operations: z
          .array(
            z.object({
              machine: machineSchema,
              action: operationActionSchema,
            }),
          )
          .min(1)
          .max(16),
        purpose: z.string().trim().min(1).max(512),
        durationSeconds: z.number().int().min(60).max(86_400).default(900),
        runId: z.string().trim().min(1).max(128).optional(),
      }),
      annotations: requestAnnotations,
    },
    async (input) =>
      runSessionRequest(
        () =>
          runtime.request({
            operations: input.operations,
            purpose: input.purpose,
            durationSeconds: input.durationSeconds,
            ...(input.runId ? { runId: input.runId } : {}),
          }),
        reportUnexpectedError,
      ),
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
      runTool(() => runtime.status(requestId), reportUnexpectedError),
  );

  server.registerTool(
    "operation_execute",
    {
      title: "Execute approved operation",
      description:
        "Execute a typed process, filesystem or Docker operation inside an approved Session.",
      inputSchema: z.object({
        sessionId: z.string().uuid(),
        machine: machineSchema,
        action: operationActionSchema,
        timeoutSeconds: timeoutSchema,
        operationId: z.string().uuid(),
      }),
      annotations: destructiveAnnotations,
    },
    async (input) =>
      runOperation(() => runtime.execute(input), reportUnexpectedError),
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
      return textResult(result);
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
            "After the user reviews it, call session_status with the Request ID.",
          ].join("\n"),
        },
      ],
    };
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

function isExpectedError(
  error: unknown,
): error is Error & { expected: true; code: string; status?: number } {
  return (
    error instanceof Error &&
    (error as Error & { expected?: unknown }).expected === true &&
    typeof (error as Error & { code?: unknown }).code === "string"
  );
}
