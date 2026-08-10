import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { audit, type Database, type OrganizationRecord } from "./control-database.js";
import type { ClientGateway } from "./gateway.js";
import type { HumanOAuthAuthenticator, HumanOAuthIdentity } from "./human-oauth.js";
import type { PostgresSessionDatabase } from "./session-database.js";
import type { SessionService } from "./sessions.js";

const idSchema = z.string().uuid();
const roleSchema = z.object({ role: z.enum(["standard", "operator"]) }).strict();

type CliPrincipal = {
  identity: HumanOAuthIdentity;
  organization: OrganizationRecord;
};

export function registerCliHttp(
  app: FastifyInstance,
  dependencies: {
    authenticate: HumanOAuthAuthenticator;
    database: Database;
    sessionDatabase: PostgresSessionDatabase;
    gateway: ClientGateway;
    service: Pick<SessionService, "superviseSession">;
  },
): void {
  const { database, sessionDatabase, gateway, service } = dependencies;

  async function authorize(
    request: FastifyRequest,
    reply: FastifyReply,
    allowedRoles: HumanOAuthIdentity["role"][] = ["owner", "admin", "supervisor"],
  ): Promise<CliPrincipal | null> {
    const identity = await dependencies.authenticate(request.headers.authorization);
    if (!identity) {
      await reply.code(401).header("www-authenticate", "Bearer").send({ error: "invalid_cli_token" });
      return null;
    }
    if (!allowedRoles.includes(identity.role)) {
      await reply.code(403).send({ error: "insufficient_organization_role" });
      return null;
    }
    const organization = await database.organizationByExternalId(identity.organizationId);
    if (!organization) {
      await reply.code(404).send({ error: "organization_not_found" });
      return null;
    }
    return { identity, organization };
  }

  app.get("/v1/cli/context", async (request, reply) => {
    const principal = await authorize(request, reply);
    if (!principal) return;
    const [machines, agents, sessions, usage] = await Promise.all([
      database.listMachines(principal.organization.id),
      database.listOrganizationAgents(principal.organization.id),
      sessionDatabase.listSessions(principal.identity.organizationId, 200),
      database.organizationUsage(principal.organization.id),
    ]);
    return {
      organization: {
        id: principal.organization.id,
        externalId: principal.organization.externalId,
        slug: principal.organization.slug,
        name: principal.organization.name,
      },
      usage,
      machines: machines.map((machine) => ({ ...machine, online: gateway.isOnline(machine.id) })),
      agents,
      sessions,
    };
  });

  app.get<{ Params: { sessionId: string } }>(
    "/v1/cli/sessions/:sessionId/timeline",
    async (request, reply) => {
      const principal = await authorize(request, reply);
      if (!principal) return;
      const sessionId = idSchema.safeParse(request.params.sessionId);
      if (!sessionId.success) return reply.code(400).send({ error: "invalid_session_id" });
      const timeline = await sessionDatabase.sessionTimeline(principal.identity.organizationId, sessionId.data);
      return timeline ?? reply.code(404).send({ error: "session_not_found" });
    },
  );

  for (const decision of ["approve", "deny"] as const) {
    app.post<{ Params: { sessionId: string } }>(
      `/v1/cli/sessions/:sessionId/${decision}`,
      async (request, reply) => {
        const principal = await authorize(request, reply);
        if (!principal) return;
        const sessionId = idSchema.safeParse(request.params.sessionId);
        if (!sessionId.success) return reply.code(400).send({ error: "invalid_session_id" });
        const result = await service.superviseSession({
          organizationId: principal.identity.organizationId,
          humanId: principal.identity.humanId,
          role: principal.identity.role,
        }, sessionId.data, decision);
        if (result.status === "denied_request") {
          return reply.code(result.code === "session_not_found" ? 404 : 409).send({ error: result.code });
        }
        return reply.code(result.status === "approved" ? 202 : 200).send(result);
      },
    );
  }

  app.patch<{ Params: { agentId: string } }>(
    "/v1/cli/agents/:agentId/role",
    async (request, reply) => {
      const principal = await authorize(request, reply, ["owner", "admin"]);
      if (!principal) return;
      const agentId = idSchema.safeParse(request.params.agentId);
      const body = roleSchema.safeParse(request.body);
      if (!agentId.success || !body.success) return reply.code(400).send({ error: "invalid_agent_role" });
      const existing = (await database.listOrganizationAgents(principal.organization.id))
        .find((agent) => agent.id === agentId.data);
      if (!existing) return reply.code(404).send({ error: "agent_not_found" });
      const agent = await database.updateOrganizationAgentRole(
        principal.organization.id, agentId.data, body.data.role,
      );
      if (!agent) return reply.code(404).send({ error: "agent_not_found" });
      const revoked = existing.role === "operator" && agent.role === "standard"
        ? await sessionDatabase.revokeSessions({
            organizationId: principal.identity.organizationId,
            agentId: agent.id,
          })
        : [];
      closeRevokedSessions(gateway, revoked, "operator_role_revoked");
      await audit(database, principal.organization.id, principal.identity.humanId,
        "agent.role_changed", "agent", agent.id,
        { from: existing.role, to: agent.role, revokedSessions: revoked.length, source: "cli" });
      gateway.notifyOrganization(principal.organization.id);
      return { agent, revokedSessions: revoked.length };
    },
  );

  app.delete<{ Params: { agentId: string } }>(
    "/v1/cli/agents/:agentId",
    async (request, reply) => {
      const principal = await authorize(request, reply, ["owner", "admin"]);
      if (!principal) return;
      const agentId = idSchema.safeParse(request.params.agentId);
      if (!agentId.success) return reply.code(400).send({ error: "invalid_agent_id" });
      const existing = (await database.listOrganizationAgents(principal.organization.id))
        .some((agent) => agent.id === agentId.data);
      if (!existing) return reply.code(404).send({ error: "agent_not_found" });
      const revoked = await sessionDatabase.revokeSessions({
        organizationId: principal.identity.organizationId,
        agentId: agentId.data,
      });
      const deleted = await database.deleteOrganizationAgent(principal.organization.id, agentId.data);
      if (!deleted) return reply.code(404).send({ error: "agent_not_found" });
      closeRevokedSessions(gateway, revoked, "agent_revoked");
      await audit(database, principal.organization.id, principal.identity.humanId,
        "agent.deleted", "agent", agentId.data,
        { revokedSessions: revoked.length, source: "cli" });
      gateway.notifyOrganization(principal.organization.id);
      return { deleted: true, revokedSessions: revoked.length };
    },
  );

  app.post<{ Params: { machineId: string } }>(
    "/v1/cli/machines/:machineId/ping",
    async (request, reply) => {
      const principal = await authorize(request, reply);
      if (!principal) return;
      const machineId = idSchema.safeParse(request.params.machineId);
      if (!machineId.success) return reply.code(400).send({ error: "invalid_machine_id" });
      if (!await database.activeMachinesExist(principal.organization.id, [machineId.data])) {
        return reply.code(404).send({ error: "active_machine_not_found" });
      }
      if (!gateway.isOnline(machineId.data)) return reply.code(409).send({ error: "machine_offline" });
      try {
        return { reply: "pong", machineId: machineId.data, latencyMs: await gateway.ping(machineId.data) };
      } catch {
        return reply.code(504).send({ error: "machine_ping_timeout" });
      }
    },
  );
}

function closeRevokedSessions(
  gateway: ClientGateway,
  revoked: Array<{ session: { id: string; machineId: string }; commandIds: string[] }>,
  reason: string,
): void {
  for (const { session, commandIds } of revoked) {
    for (const commandId of commandIds) gateway.send(session.machineId, { type: "command.cancel", commandId });
    gateway.send(session.machineId, { type: "session.close", sessionId: session.id, reason });
  }
}
