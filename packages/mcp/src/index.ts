import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import {
  DEFAULT_OPERATION_TIMEOUT_SECONDS,
  MAX_OPERATION_TIMEOUT_SECONDS,
  scopedOperationActionSchema,
  sessionOperationActionSchema,
  type OperationAction,
  type ScopedOperationAction,
} from "@odyshell/protocol";
import { z } from "zod";

const machineSchema = z.string().trim().min(1).max(256);
const timeoutSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_OPERATION_TIMEOUT_SECONDS)
  .default(DEFAULT_OPERATION_TIMEOUT_SECONDS);
const taskRunIdSchema = z.string().trim().min(1).max(128);
const sessionRequestCommonShape = {
  title: z.string().trim().min(1).max(96).optional(),
  purpose: z.string().trim().min(1).max(280).optional(),
  durationSeconds: z.number().int().min(60).max(86_400).optional(),
};

const approvedMcpSessionRequestSchema = z.xor([
  z
    .object({
      ...sessionRequestCommonShape,
      runId: taskRunIdSchema.optional(),
      operations: z
        .array(
          z.object({
            machine: machineSchema,
            action: scopedOperationActionSchema,
          }),
        )
        .min(1)
        .max(16),
    })
    .strict(),
  z
    .object({
      ...sessionRequestCommonShape,
      runId: taskRunIdSchema,
      hostShell: z.object({ machine: machineSchema }).strict(),
      predecessorSessionId: z.string().uuid().optional(),
    })
    .strict()
    .superRefine((request, context) => {
      if (request.durationSeconds && request.durationSeconds > 3_600 && !request.purpose) {
        context.addIssue({
          code: "custom",
          message: "Host Shell tasks longer than one hour require a purpose",
          path: ["purpose"],
        });
      }
    }),
]);

type ApprovedMcpSessionRequestCommon = {
  title: string;
  purpose?: string;
  durationSeconds: number;
};

export type ApprovedMcpSessionRequestInput =
  ApprovedMcpSessionRequestCommon &
    (
      | {
          operations: Array<{ machine: string; action: ScopedOperationAction }>;
          runId?: string;
          hostShell?: never;
          predecessorSessionId?: never;
        }
      | {
          operations?: never;
          hostShell: { machine: string };
          runId: string;
          predecessorSessionId?: string;
        }
    );

export type ApprovedMcpRuntime = {
  machines(): Promise<unknown>;
  ping(machine: string): Promise<unknown>;
  request(input: ApprovedMcpSessionRequestInput): Promise<ApprovedMcpSessionRequest>;
  sessions(input?: { includeHistory?: boolean }): Promise<unknown>;
  status(requestId: string, runId?: string): Promise<unknown>;
  execute(input: {
    sessionId: string;
    runId?: string;
    machine: string;
    action: OperationAction;
    timeoutSeconds: number;
    idempotencyKey: string;
  }): Promise<ApprovedMcpOperationResult>;
  complete(input: {
    sessionId: string;
    runId?: string;
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
  const server = new McpServer(
    { name: "odyshell", version: "0.16.0" },
    {
      instructions:
        "Inspect machines before choosing platform-specific operations. Before requesting authority, call sessions_list. Reuse exact typed authority only when it is bound to the current local MCP process or remote MCP installation. Use typed filesystem, Docker, or process.exec requests when the task is fully known and can be expressed as one exact or structured action. For exploratory, iterative, or multi-command host work, request hostShell at the outset without anticipating commands; it grants broad host.shell authority for the Task Run, requires manual approval, and audits every command. Generate one stable runId for the Task Run and retain it across retries and explicit continuations; never reuse Host Shell authority from another runId. Use predecessorSessionId only with hostShell when escalating an existing Session. When privilegeEscalation is sudo, explicitly mention root access in the Session title or purpose before requesting a sudo command. Show approval links verbatim, then call session_status. Generate a fresh UUIDv4 idempotencyKey for each logical operation and reuse it only when retrying that exact operation_execute call. A failed command does not close the Session: inspect its result, correct the work, and continue with the same sessionId and runId. After no Operations remain active, complete the Session only when the overall task succeeds or is abandoned; report the overall outcome rather than the last command status. Credentials stay inside Odyshell.",
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
      title: "Request task access",
      description:
        "Call sessions_list first. Choose exactly one request mode: operations retains exact typed actions for fully known work, while hostShell is the preferred mode for exploratory, iterative, or multi-command host work. Generate one stable runId for the Task Run when requesting Host Shell and retain it across retries and explicit continuations; Odyshell never reuses Host Shell authority from another runId. Host Shell requires manual approval and requests broad temporary authority without anticipating commands. Use predecessorSessionId only with hostShell to link an escalation to the current Session. A short title is optional; when omitted, Odyshell derives it from purpose or the requested authority. Inspect machine platform, defaultShell and privilegeEscalation before composing OS-specific commands. If sudo is available, explicitly disclose intended root access in the title or purpose. If approval is required, show the returned link and follow nextAction.",
      inputSchema: approvedMcpSessionRequestSchema,
      annotations: requestAnnotations,
    },
    async (input) => {
      const common = {
        title: deriveSessionRequestTitle(input),
        ...(input.purpose ? { purpose: input.purpose } : {}),
        durationSeconds: input.durationSeconds ?? 3_600,
        ...(input.runId ? { runId: input.runId } : {}),
      };
      const request: ApprovedMcpSessionRequestInput = "hostShell" in input
        ? {
            ...common,
            hostShell: input.hostShell,
            runId: input.runId!,
            ...(input.predecessorSessionId
              ? { predecessorSessionId: input.predecessorSessionId }
              : {}),
          }
        : { ...common, operations: input.operations };
      return runSessionRequest(
        () => runtime.request(request),
        reportUnexpectedError,
      );
    },
  );

  server.registerTool(
    "sessions_list",
    {
      title: "List Sessions",
      description:
        "List pending requests and active Sessions owned by this Agent. Active authority is returned by default for recovery. Exact typed authority may be reused by the same local MCP process or remote installation; Host Shell additionally requires an explicit continuation with the same Task Run runId and must never be inherited by unrelated work. Request history only when needed.",
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
        "Check whether a request was approved and make the resulting Session available to this MCP installation. Supply the stable Task Run runId for an Agent-requested Host Shell request; dashboard-created Sessions are exempt.",
      inputSchema: z.object({
        requestId: z.string().uuid(),
        runId: taskRunIdSchema.optional(),
      }),
      annotations: requestAnnotations,
    },
    async ({ requestId, runId }) =>
      runSessionStatus(
        requestId,
        () => runtime.status(requestId, runId),
        reportUnexpectedError,
      ),
  );

  server.registerTool(
    "operation_execute",
    {
      title: "Execute approved operation",
      description:
        "Execute an action inside an approved Session. Typed process, filesystem and Docker actions must match the approved scope. Agent-requested Host Shell execution must supply the stable Task Run runId; dashboard-created Sessions are exempt. A failed command does not close its Session; inspect the result and continue corrective work with a fresh UUIDv4 idempotencyKey. Reuse an idempotencyKey only for an exact retry. Odyshell safely reduces a requested timeout to the Session lifetime remaining.",
      inputSchema: z.object({
        idempotencyKey: z
          .uuidv4()
          .describe(
            "Fresh UUIDv4 for this logical Operation. Reuse it only for an exact retry of the same call.",
          ),
        sessionId: z.string().uuid(),
        runId: taskRunIdSchema.optional(),
        machine: machineSchema,
        action: sessionOperationActionSchema,
        timeoutSeconds: timeoutSchema,
      }),
      annotations: idempotentDestructiveAnnotations,
    },
    async (input) =>
      runOperation(
        input.idempotencyKey,
        () =>
          runtime.execute({
            idempotencyKey: input.idempotencyKey,
            sessionId: input.sessionId,
            ...(input.runId ? { runId: input.runId } : {}),
            machine: input.machine,
            action: input.action,
            timeoutSeconds: input.timeoutSeconds,
          }),
        reportUnexpectedError,
      ),
  );

  server.registerTool(
    "session_complete",
    {
      title: "Complete a Session",
      description:
        "Always call this after the Task Run finishes and no Operations remain active. Supply the stable Task Run runId for an Agent-requested Host Shell Session; dashboard-created Sessions are exempt. Close the Session and report succeeded only when the overall task goal was met, or failed when the task was abandoned; individual command failures do not determine the Session outcome.",
      inputSchema: z.object({
        sessionId: z.string().uuid(),
        runId: taskRunIdSchema.optional(),
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
            ...(input.runId ? { runId: input.runId } : {}),
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

function deriveSessionRequestTitle(
  input: z.infer<typeof approvedMcpSessionRequestSchema>,
): string {
  if (input.title) return input.title;
  if (input.purpose) return input.purpose.slice(0, 96);
  if ("hostShell" in input) {
    return `Run Host Shell on ${input.hostShell.machine}`.slice(0, 96);
  }
  const { machine, action } = input.operations[0]!;
  return `Run ${action.kind} on ${machine}`.slice(0, 96);
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

const idempotentDestructiveAnnotations = {
  ...destructiveAnnotations,
  idempotentHint: true,
} as const;

async function runOperation(
  idempotencyKey: string,
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
        idempotencyKey,
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
