import {
  commandRequestSchema,
  taskRequestSchema,
  type Command,
  type Task,
} from "@odyshell/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AgentOAuthAuthenticator, AgentOAuthIdentity } from "./agent-oauth.js";
import type { AgentPrincipal, TaskRepository, TaskService } from "./tasks.js";

const idempotencyKeySchema = z.string().trim().min(1).max(128);
const taskIdSchema = z.string().uuid();
const outputCursorSchema = z.coerce.number().int().min(-1).default(-1);

export type TaskHttpDependencies = {
  authenticate: AgentOAuthAuthenticator;
  principal(identity: AgentOAuthIdentity): Promise<AgentPrincipal | null>;
  repository: Pick<
    TaskRepository,
    "task" | "command" | "commandOutput"
  > & {
    listMachineAuthorities(
      organizationId: string,
      agentId: string,
    ): Promise<Array<{
      machineId: string;
      clientProfileId: string;
      operatingSystemUser: string;
      online: boolean;
    }>>;
  };
  service: Pick<
    TaskService,
    "requestTask" | "createCommand" | "finishTask" | "cancelCommand"
  >;
};

export function registerTaskHttp(
  app: FastifyInstance,
  dependencies: TaskHttpDependencies,
): void {
  const principals = new WeakMap<FastifyRequest, AgentPrincipal>();
  const requireAgent = async (request: FastifyRequest, reply: FastifyReply) => {
    const authorization = typeof request.headers.authorization === "string"
      ? request.headers.authorization
      : undefined;
    const identity = await dependencies.authenticate(authorization);
    if (!identity) {
      await reply.code(401).send({ error: "oauth_token_required" });
      return;
    }
    const principal = await dependencies.principal(identity);
    if (!principal) {
      await reply.code(403).send({ error: "agent_registration_required" });
      return;
    }
    principals.set(request, principal);
  };
  const principalFor = (request: FastifyRequest): AgentPrincipal => {
    const principal = principals.get(request);
    if (!principal) throw new Error("Authenticated Task request has no Agent principal");
    return principal;
  };

  app.get("/v1/machines", { preHandler: requireAgent }, async (request) => {
    const principal = principalFor(request);
    const machines = await dependencies.repository.listMachineAuthorities(
      principal.organizationId,
      principal.agentId,
    );
    return {
      data: machines.map((machine) => ({
        id: machine.machineId,
        clientProfileId: machine.clientProfileId,
        operatingSystemUser: machine.operatingSystemUser,
        online: machine.online,
      })),
    };
  });

  app.post("/v1/tasks", { preHandler: requireAgent }, async (request, reply) => {
    const parsed = taskRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_task", details: parsed.error.flatten() });
    }
    const idempotency = idempotencyKeySchema.safeParse(request.headers["idempotency-key"]);
    if (!idempotency.success) {
      return reply.code(400).send({ error: "idempotency_key_required" });
    }
    const result = await dependencies.service.requestTask(
      principalFor(request),
      parsed.data,
      idempotency.data,
    );
    if (result.status === "denied") {
      return reply.code(taskDenialStatus(result.code)).send({ error: result.code });
    }
    return reply
      .code(result.status === "created" ? 201 : 200)
      .header("location", `/v1/tasks/${result.task.id}`)
      .send(taskView(result.task));
  });

  app.get<{ Params: { taskId: string } }>(
    "/v1/tasks/:taskId",
    { preHandler: requireAgent },
    async (request, reply) => {
      const taskId = taskIdSchema.safeParse(request.params.taskId);
      if (!taskId.success) return reply.code(400).send({ error: "invalid_task_id" });
      const principal = principalFor(request);
      const task = await dependencies.repository.task(principal.organizationId, taskId.data);
      if (!task || task.agentId !== principal.agentId) {
        return reply.code(404).send({ error: "task_not_found" });
      }
      return taskView(task);
    },
  );

  app.post<{ Params: { taskId: string } }>(
    "/v1/tasks/:taskId/commands",
    { preHandler: requireAgent },
    async (request, reply) => {
      const taskId = taskIdSchema.safeParse(request.params.taskId);
      if (!taskId.success) return reply.code(400).send({ error: "invalid_task_id" });
      const parsed = commandRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_command", details: parsed.error.flatten() });
      }
      const idempotency = idempotencyKeySchema.safeParse(request.headers["idempotency-key"]);
      if (!idempotency.success) {
        return reply.code(400).send({ error: "idempotency_key_required" });
      }
      const result = await dependencies.service.createCommand(
        principalFor(request),
        taskId.data,
        parsed.data,
        idempotency.data,
      );
      if (result.status === "denied") {
        return reply.code(commandDenialStatus(result.code)).send({ error: result.code });
      }
      return reply
        .code(result.status === "created" ? 202 : 200)
        .header("location", `/v1/commands/${result.command.id}`)
        .send(commandView(result.command));
    },
  );

  app.get<{ Params: { commandId: string } }>(
    "/v1/commands/:commandId",
    { preHandler: requireAgent },
    async (request, reply) => {
      const commandId = taskIdSchema.safeParse(request.params.commandId);
      if (!commandId.success) return reply.code(400).send({ error: "invalid_command_id" });
      const principal = principalFor(request);
      const command = await dependencies.repository.command(
        principal.organizationId,
        commandId.data,
      );
      if (!command || command.agentId !== principal.agentId) {
        return reply.code(404).send({ error: "command_not_found" });
      }
      return commandView(command);
    },
  );

  app.get<{ Params: { commandId: string }; Querystring: { after?: string } }>(
    "/v1/commands/:commandId/output",
    { preHandler: requireAgent },
    async (request, reply) => {
      const commandId = taskIdSchema.safeParse(request.params.commandId);
      const cursor = outputCursorSchema.safeParse(request.query.after);
      if (!commandId.success || !cursor.success) {
        return reply.code(400).send({ error: "invalid_output_cursor" });
      }
      const principal = principalFor(request);
      const command = await dependencies.repository.command(
        principal.organizationId,
        commandId.data,
      );
      if (!command || command.agentId !== principal.agentId) {
        return reply.code(404).send({ error: "command_not_found" });
      }
      const chunks = await dependencies.repository.commandOutput(
        principal.organizationId,
        command.id,
        cursor.data,
      );
      return {
        data: chunks,
        nextCursor: chunks.at(-1)?.sequence ?? cursor.data,
        retention: "transient",
      };
    },
  );

  for (const outcome of ["complete", "cancel"] as const) {
    app.post<{ Params: { taskId: string } }>(
      `/v1/tasks/:taskId/${outcome}`,
      { preHandler: requireAgent },
      async (request, reply) => {
        const taskId = taskIdSchema.safeParse(request.params.taskId);
        if (!taskId.success) return reply.code(400).send({ error: "invalid_task_id" });
        const idempotency = idempotencyKeySchema.safeParse(request.headers["idempotency-key"]);
        if (!idempotency.success) {
          return reply.code(400).send({ error: "idempotency_key_required" });
        }
        const result = await dependencies.service.finishTask(
          principalFor(request),
          taskId.data,
          outcome,
        );
        if (result.status === "denied") {
          return reply
            .code(result.code === "task_not_found" ? 404 : 409)
            .send({ error: result.code });
        }
        return reply.code(outcome === "cancel" ? 202 : 200).send(taskView(result.task));
      },
    );
  }

  app.post<{ Params: { commandId: string } }>(
    "/v1/commands/:commandId/cancel",
    { preHandler: requireAgent },
    async (request, reply) => {
      const commandId = taskIdSchema.safeParse(request.params.commandId);
      if (!commandId.success) return reply.code(400).send({ error: "invalid_command_id" });
      const idempotency = idempotencyKeySchema.safeParse(request.headers["idempotency-key"]);
      if (!idempotency.success) {
        return reply.code(400).send({ error: "idempotency_key_required" });
      }
      const result = await dependencies.service.cancelCommand(
        principalFor(request),
        commandId.data,
      );
      if (result.status === "denied") {
        return reply.code(404).send({ error: result.code });
      }
      return reply.code(202).send(commandView(result.command));
    },
  );
}

function taskDenialStatus(code: string): number {
  if (code === "machine_not_found") return 404;
  if (code === "idempotency_conflict") return 409;
  if (code.endsWith("_concurrency_denied") || code === "machine_offline") return 409;
  return 403;
}

function commandDenialStatus(code: string): number {
  if (code === "task_not_found") return 404;
  if (code === "idempotency_conflict" || code === "command_concurrency_denied") return 409;
  if (code === "task_expired") return 410;
  return 403;
}

function taskView(task: Task): Task {
  return task;
}

function commandView(command: Command): Command {
  return command;
}
