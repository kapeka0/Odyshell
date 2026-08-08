import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { commandRequestSchema, taskRequestSchema } from "@odyshell/protocol";
import { z } from "zod";

const uuid = z.string().uuid();
const idempotencyKey = z.string().uuidv4();

export type AgenticMcpRuntime = {
  machines(): Promise<unknown>;
  requestTask(input: z.infer<typeof taskRequestSchema> & { idempotencyKey: string }): Promise<unknown>;
  task(taskId: string): Promise<unknown>;
  finishTask(taskId: string, outcome: "complete" | "cancel"): Promise<unknown>;
  createCommand(
    taskId: string,
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
  const server = new McpServer({ name: "odyshell", version: "0.16.0" });
  server.registerTool("machines_list", {
    title: "List Machines",
    description: "List online Linux Machines available to this Agent under their local policy.",
    inputSchema: z.object({}).strict(),
    annotations: readOnly,
  }, async () => run(() => runtime.machines(), reportUnexpectedError));

  server.registerTool("task_request", {
    title: "Request Task",
    description: "Request temporary shell authority for exactly one Machine. The result is opening, pending human approval, or denied.",
    inputSchema: taskRequestSchema.extend({ idempotencyKey }).strict(),
    annotations: idempotentMutation,
  }, async ({ idempotencyKey: key, ...input }) =>
    run(() => runtime.requestTask({ ...input, idempotencyKey: key }), reportUnexpectedError));

  server.registerTool("task_get", {
    title: "Get Task",
    description: "Read current Task state after approval, reconnect, cancellation, or expiry.",
    inputSchema: z.object({ taskId: uuid }).strict(),
    annotations: readOnly,
  }, async ({ taskId }) => run(() => runtime.task(taskId), reportUnexpectedError));

  for (const outcome of ["complete", "cancel"] as const) {
    server.registerTool(`task_${outcome}`, {
      title: outcome === "complete" ? "Complete Task" : "Cancel Task",
      description: outcome === "complete"
        ? "Close a Task after every Command has reached a terminal state."
        : "Cancel active Commands and close Task authority immediately.",
      inputSchema: z.object({ taskId: uuid }).strict(),
      annotations: destructive,
    }, async ({ taskId }) =>
      run(() => runtime.finishTask(taskId, outcome), reportUnexpectedError));
  }

  server.registerTool("command_run", {
    title: "Run Command",
    description: "Start one asynchronous non-interactive shell Command. Poll command_get and command_output; reuse the idempotency key only for an exact retry.",
    inputSchema: commandRequestSchema.extend({ taskId: uuid, idempotencyKey }).strict(),
    annotations: idempotentMutation,
  }, async ({ taskId, idempotencyKey: key, ...input }) =>
    run(() => runtime.createCommand(taskId, { ...input, idempotencyKey: key }), reportUnexpectedError));

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
