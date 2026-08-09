import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { commandRequestSchema, sessionRequestSchema } from "@odyshell/protocol";
import { z } from "zod";

const uuid = z.string().uuid();
const idempotencyKey = z.string().uuidv4();

export type AgenticMcpRuntime = {
  machines(): Promise<unknown>;
  requestSession(input: z.infer<typeof sessionRequestSchema> & { idempotencyKey: string }): Promise<unknown>;
  session(sessionId: string): Promise<unknown>;
  finishSession(sessionId: string, outcome: "complete" | "cancel"): Promise<unknown>;
  createCommand(
    sessionId: string,
    input: z.infer<typeof commandRequestSchema> & { idempotencyKey: string },
  ): Promise<unknown>;
  command(commandId: string): Promise<unknown>;
  output(commandId: string, after: number): Promise<unknown>;
  cancelCommand(commandId: string): Promise<unknown>;
};

export function createAgenticMcpServer(
  runtime: AgenticMcpRuntime,
  reportUnexpectedError: (error: unknown) => void = () => {},
): McpServer {
  const server = new McpServer({ name: "odyshell", version: "0.18.0" });
  server.registerTool("machines_list", {
    title: "List Machines",
    description: "List Windows, Linux, and macOS Machines in the Agent's Organization that can receive a Session request.",
    inputSchema: z.object({}).strict(),
    annotations: readOnly,
  }, async () => run(() => runtime.machines(), reportUnexpectedError));

  server.registerTool("session_request", {
    title: "Request Session",
    description: "Request temporary shell authority for exactly one Machine. The result is opening, pending human approval, or denied.",
    inputSchema: sessionRequestSchema.extend({ idempotencyKey }).strict(),
    annotations: idempotentMutation,
  }, async ({ idempotencyKey: key, ...input }) =>
    run(() => runtime.requestSession({ ...input, idempotencyKey: key }), reportUnexpectedError));

  server.registerTool("session_get", {
    title: "Get Session",
    description: "Read current Session state after approval, reconnect, cancellation, or expiry.",
    inputSchema: z.object({ sessionId: uuid }).strict(),
    annotations: readOnly,
  }, async ({ sessionId }) => run(() => runtime.session(sessionId), reportUnexpectedError));

  for (const outcome of ["complete", "cancel"] as const) {
    server.registerTool(`session_${outcome}`, {
      title: outcome === "complete" ? "Complete Session" : "Cancel Session",
      description: outcome === "complete"
        ? "Close a Session after every Command has reached a terminal state."
        : "Cancel active Commands and close Session authority immediately.",
      inputSchema: z.object({ sessionId: uuid }).strict(),
      annotations: destructive,
    }, async ({ sessionId }) =>
      run(() => runtime.finishSession(sessionId, outcome), reportUnexpectedError));
  }

  server.registerTool("command_run", {
    title: "Run Command",
    description: "Start one asynchronous non-interactive shell Command. Poll command_get and command_output; reuse the idempotency key only for an exact retry.",
    inputSchema: commandRequestSchema.extend({ sessionId: uuid, idempotencyKey }).strict(),
    annotations: idempotentMutation,
  }, async ({ sessionId, idempotencyKey: key, ...input }) =>
    run(() => runtime.createCommand(sessionId, { ...input, idempotencyKey: key }), reportUnexpectedError));

  server.registerTool("command_get", {
    title: "Get Command",
    description: "Read asynchronous Command state and bounded output byte counts.",
    inputSchema: z.object({ commandId: uuid }).strict(),
    annotations: readOnly,
  }, async ({ commandId }) => run(() => runtime.command(commandId), reportUnexpectedError));

  server.registerTool("command_output", {
    title: "Read Command Output",
    description: "Read transient stdout/stderr chunks after a sequence cursor. Output is base64 and retained briefly for reconnect.",
    inputSchema: z.object({ commandId: uuid, after: z.number().int().min(-1).default(-1) }).strict(),
    annotations: readOnly,
  }, async ({ commandId, after }) =>
    run(() => runtime.output(commandId, after), reportUnexpectedError));

  server.registerTool("command_cancel", {
    title: "Cancel Command",
    description: "Request process-tree termination for an active Command.",
    inputSchema: z.object({ commandId: uuid }).strict(),
    annotations: destructive,
  }, async ({ commandId }) => run(() => runtime.cancelCommand(commandId), reportUnexpectedError));
  return server;
}

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
const destructive = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const;
const idempotentMutation = { ...destructive, destructiveHint: false } as const;

async function run(
  action: () => Promise<unknown>,
  reportUnexpectedError: (error: unknown) => void,
): Promise<CallToolResult> {
  try {
    const value = await action();
    return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
  } catch (error) {
    reportUnexpectedError(error);
    return {
      isError: true,
      content: [{
        type: "text",
        text: JSON.stringify({
          error: error instanceof Error ? error.message : "Odyshell request failed",
        }),
      }],
    };
  }
}
