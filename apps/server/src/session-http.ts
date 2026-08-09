import {
  commandRequestSchema,
  sessionRequestSchema,
  type Command,
  type Session,
} from "@odyshell/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AgentOAuthAuthenticator, AgentOAuthIdentity } from "./agent-oauth.js";
import type { AgentPrincipal, SessionRepository, SessionService } from "./sessions.js";

const idempotencyKeySchema = z.string().trim().min(1).max(128);
const sessionIdSchema = z.string().uuid();
const outputCursorSchema = z.coerce.number().int().min(-1).default(-1);

export type SessionHttpDependencies = {
  authenticate: AgentOAuthAuthenticator;
  principal(identity: AgentOAuthIdentity): Promise<AgentPrincipal | null>;
  repository: Pick<
    SessionRepository,
    "session" | "command" | "commandOutput"
  > & {
    listMachineAuthorities(
      organizationId: string,
    ): Promise<Array<{
      machineId: string;
      clientProfileId: string;
      operatingSystemUser: string;
      online: boolean;
    }>>;
  };
  service: Pick<
    SessionService,
    "requestSession" | "createCommand" | "finishSession" | "cancelCommand"
  >;
};

export function registerSessionHttp(
  app: FastifyInstance,
  dependencies: SessionHttpDependencies,
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
    if (!principal) throw new Error("Authenticated Session request has no Agent principal");
    return principal;
  };

  app.get("/v1/machines", { preHandler: requireAgent }, async (request) => {
    const principal = principalFor(request);
    const machines = await dependencies.repository.listMachineAuthorities(
      principal.organizationId,
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

  app.post("/v1/sessions", { preHandler: requireAgent }, async (request, reply) => {
    const parsed = sessionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_session", details: parsed.error.flatten() });
    }
    const idempotency = idempotencyKeySchema.safeParse(request.headers["idempotency-key"]);
    if (!idempotency.success) {
      return reply.code(400).send({ error: "idempotency_key_required" });
    }
    const result = await dependencies.service.requestSession(
      principalFor(request),
      parsed.data,
      idempotency.data,
    );
    if (result.status === "denied") {
      return reply.code(sessionDenialStatus(result.code)).send({ error: result.code });
    }
    return reply
      .code(result.status === "created" ? 201 : 200)
      .header("location", `/v1/sessions/${result.session.id}`)
      .send(sessionView(result.session));
  });

  app.get<{ Params: { sessionId: string } }>(
    "/v1/sessions/:sessionId",
    { preHandler: requireAgent },
    async (request, reply) => {
      const sessionId = sessionIdSchema.safeParse(request.params.sessionId);
      if (!sessionId.success) return reply.code(400).send({ error: "invalid_session_id" });
      const principal = principalFor(request);
      const session = await dependencies.repository.session(principal.organizationId, sessionId.data);
      if (!session || session.agentId !== principal.agentId) {
        return reply.code(404).send({ error: "session_not_found" });
      }
      return sessionView(session);
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    "/v1/sessions/:sessionId/commands",
    { preHandler: requireAgent },
    async (request, reply) => {
      const sessionId = sessionIdSchema.safeParse(request.params.sessionId);
      if (!sessionId.success) return reply.code(400).send({ error: "invalid_session_id" });
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
        sessionId.data,
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
      const commandId = sessionIdSchema.safeParse(request.params.commandId);
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
      const commandId = sessionIdSchema.safeParse(request.params.commandId);
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
        retention: "organization_policy",
      };
    },
  );

  for (const outcome of ["complete", "cancel"] as const) {
    app.post<{ Params: { sessionId: string } }>(
      `/v1/sessions/:sessionId/${outcome}`,
      { preHandler: requireAgent },
      async (request, reply) => {
        const sessionId = sessionIdSchema.safeParse(request.params.sessionId);
        if (!sessionId.success) return reply.code(400).send({ error: "invalid_session_id" });
        const idempotency = idempotencyKeySchema.safeParse(request.headers["idempotency-key"]);
        if (!idempotency.success) {
          return reply.code(400).send({ error: "idempotency_key_required" });
        }
        const result = await dependencies.service.finishSession(
          principalFor(request),
          sessionId.data,
          outcome,
        );
        if (result.status === "denied") {
          return reply
            .code(result.code === "session_not_found" ? 404 : 409)
            .send({ error: result.code });
        }
        return reply.code(outcome === "cancel" ? 202 : 200).send(sessionView(result.session));
      },
    );
  }

  app.post<{ Params: { commandId: string } }>(
    "/v1/commands/:commandId/cancel",
    { preHandler: requireAgent },
    async (request, reply) => {
      const commandId = sessionIdSchema.safeParse(request.params.commandId);
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

function sessionDenialStatus(code: string): number {
  if (code === "machine_not_found") return 404;
  if (code === "idempotency_conflict") return 409;
  if (code.endsWith("_concurrency_denied") || code === "machine_offline") return 409;
  return 403;
}

function commandDenialStatus(code: string): number {
  if (code === "session_not_found") return 404;
  if (code === "idempotency_conflict" || code === "command_concurrency_denied") return 409;
  if (code === "session_expired") return 410;
  return 403;
}

function sessionView(session: Session): Session {
  return session;
}

function commandView(command: Command): Command {
  return command;
}
