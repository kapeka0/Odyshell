import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { createEnrollmentToken } from "./access.js";
import {
  CloudLiveTokenReplayGuard,
  cloudBillingPlanUpdateSchema,
  cloudIdentitySchema,
  cloudLiveOriginDecision,
  cloudUserSettingsSchema,
  cloudOrganizationSettingsSchema,
  createCloudLiveToken,
  deleteCloudAgentSchema,
  entitlementsFor,
  privacySafeControlMetadata,
  revokeCloudMachineSchema,
  ScopedConcurrencyLimiter,
  ScopedRateLimiter,
  updateCloudMachineSchema,
  updateCloudAgentRoleSchema,
  verifyCloudLiveToken,
} from "./cloud.js";
import { audit, type AuditRecord, type Database } from "./control-database.js";
import type { ClientGateway } from "./gateway.js";
import type { PostgresSessionDatabase } from "./session-database.js";

type WebPreHandler = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<void>;

const notificationSchema = cloudIdentitySchema.extend({
  notificationId: z.string().uuid(),
  read: z.boolean().default(true),
}).strict();

export function registerControlHttp(
  app: FastifyInstance,
  dependencies: {
    database: Database;
    sessionDatabase: PostgresSessionDatabase;
    gateway: ClientGateway;
    preHandler: WebPreHandler;
    webKey: string | undefined;
    webUrl: string | undefined;
    auditRetentionMilliseconds: number;
  },
): void {
  const {
    database,
    sessionDatabase,
    gateway,
    preHandler,
    webKey,
    webUrl,
  } = dependencies;
  const enrollmentLimiter = new ScopedRateLimiter(60, 20, 60 * 60_000);
  const liveTokenLimiter = new ScopedRateLimiter(300, 30, 60_000);
  const liveReplayGuard = new CloudLiveTokenReplayGuard();
  const liveStreams = new ScopedConcurrencyLimiter(100, 4);
  const pingLimiter = new ScopedRateLimiter(120, 30, 60_000);
  const pingConcurrency = new ScopedConcurrencyLimiter(20, 3);

  app.post(
    "/v1/internal/cloud/context",
    { preHandler },
    async (request, reply) => {
      const parsed = cloudIdentitySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_request",
          details: parsed.error.issues,
        });
      }
      const context = await database.ensureCloudContext({
        externalId: parsed.data.organization.externalId,
        slug: parsed.data.organization.slug,
        name: parsed.data.organization.name,
      });
      const [
        machines,
        usage,
        agents,
        runnableAgentIds,
        sessions,
        sessionEvents,
        controlEvents,
        notifications,
        userPreferences,
      ] = await Promise.all([
        database.listMachines(context.organization.id),
        database.organizationPlan(context.organization.id),
        database.listOrganizationAgents(context.organization.id),
        database.listRunnableAgentIds(context.organization.id),
        sessionDatabase.listSessions(parsed.data.organization.externalId, 100),
        sessionDatabase.listAuditEvents(parsed.data.organization.externalId, 100),
        database.listAudit(context.organization.id, 50),
        database.listNotifications(context.organization.id, parsed.data.userId),
        database.userPreferences(parsed.data.userId),
      ]);
      const onlineMachines = machines.filter((machine) =>
        gateway.isOnline(machine.id)
      );
      const plan = entitlementsFor(context.organization.plan);
      return {
        organization: context.organization,
        userPreferences: { timeZone: userPreferences.timeZone },
        plan: {
          id: context.organization.plan,
          ...plan,
          billingManaged: usage?.cloudManaged ?? false,
          controlEventRetentionDays: Math.round(
            dependencies.auditRetentionMilliseconds / (24 * 60 * 60 * 1_000),
          ),
        },
        usage: {
          machines: usage?.activeMachines ?? machines.length,
          activeAgents: usage?.activeAgents ?? 0,
        },
        connections: {
          activeConnections: onlineMachines.length,
          connectedAgents: new Set(
            sessions
              .filter((session) => session.status === "active")
              .map((session) => session.agentId),
          ).size,
          connections: [],
        },
        machines: machines.map((machine) => ({
          id: machine.id,
          name: machine.name,
          description: machine.description ?? null,
          status: machine.status,
          runtime: machine.runtime ?? null,
          lastSeenAt: isoTimestamp(machine.lastSeenAt),
          enrolledAt: isoTimestamp(machine.enrolledAt),
          online: gateway.isOnline(machine.id),
        })),
        agents: agents.map((agent) => ({
          id: agent.id,
          name: agent.name,
          role: agent.role,
          status: agent.status,
          credentialActive: runnableAgentIds.includes(agent.id),
          createdAt: isoTimestamp(agent.createdAt),
        })),
        sessions,
        notifications: notifications.map((notification) => ({
          ...notification,
          readAt: isoTimestamp(notification.readAt),
          createdAt: isoTimestamp(notification.createdAt),
        })),
        controlEvents: [
          ...sessionEvents.map((event) => ({
            id: `session:${event.id}`,
            principalId:
              typeof event.metadata.humanId === "string"
                ? event.metadata.humanId
                : event.agentId,
            action: event.type,
            targetType: event.commandId ? "command" : "session",
            targetId: event.commandId ?? event.sessionId,
            metadata: event.metadata,
            createdAt: event.createdAt,
          })),
          ...controlEvents.map(controlEventView),
        ].sort((left, right) =>
          String(right.createdAt).localeCompare(String(left.createdAt))
        ),
      };
    },
  );

  app.post(
    "/v1/internal/cloud/billing/plan",
    { preHandler },
    async (request, reply) => {
      const parsed = cloudBillingPlanUpdateSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_billing_update" });
      const status = await database.applyStripePlan(parsed.data);
      if (status === "organization_not_found") {
        return reply.code(404).send({ error: "organization_not_found" });
      }
      return { status };
    },
  );

  app.post(
    "/v1/internal/cloud/user-settings/update",
    { preHandler },
    async (request, reply) => {
      const parsed = cloudUserSettingsSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      await ensureContext(database, parsed.data);
      const preferences = await database.upsertUserPreferences({
        externalId: parsed.data.userId,
        timeZone: parsed.data.timeZone,
      });
      return { timeZone: preferences.timeZone };
    },
  );

  app.post(
    "/v1/internal/cloud/organization/settings/update",
    { preHandler },
    async (request, reply) => {
      const parsed = cloudOrganizationSettingsSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      const context = await ensureContext(database, parsed.data);
      const organization = await database.updateOrganizationSettings(
        parsed.data.section === "details"
          ? {
              organizationId: context.organization.id,
              section: "details",
              name: parsed.data.name,
              avatarSeed: parsed.data.avatarSeed,
            }
          : {
              organizationId: context.organization.id,
              section: "logging",
              loggingLevel: parsed.data.loggingLevel,
            },
      );
      if (!organization) {
        return reply.code(404).send({ error: "organization_not_found" });
      }
      gateway.notifyOrganization(organization.id);
      return { organization };
    },
  );

  app.post(
    "/v1/internal/cloud/notifications/read",
    { preHandler },
    async (request, reply) => {
      const parsed = notificationSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      const context = await ensureContext(database, parsed.data);
      const marked = await database.markNotificationRead(
        context.organization.id,
        parsed.data.userId,
        parsed.data.notificationId,
        parsed.data.read,
      );
      if (!marked) {
        return reply.code(404).send({ error: "notification_not_found" });
      }
      gateway.notifyOrganization(context.organization.id);
      return { read: parsed.data.read };
    },
  );

  app.post(
    "/v1/internal/cloud/notifications/read-all",
    { preHandler },
    async (request, reply) => {
      const parsed = cloudIdentitySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      const context = await ensureContext(database, parsed.data);
      const marked = await database.markAllNotificationsRead(
        context.organization.id,
        parsed.data.userId,
      );
      gateway.notifyOrganization(context.organization.id);
      return { read: true, marked };
    },
  );

  app.post(
    "/v1/internal/cloud/enrollment-token",
    { preHandler },
    async (request, reply) => {
      const parsed = cloudIdentitySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_request",
          details: parsed.error.issues,
        });
      }
      const context = await ensureContext(database, parsed.data);
      if (!enrollmentLimiter.allow(context.organization.id, parsed.data.userId)) {
        return reply.code(429).send({
          error: "enrollment_issuance_rate_limited",
        });
      }
      const usage = await database.organizationPlan(context.organization.id);
      const entitlement = entitlementsFor(context.organization.plan);
      if (
        usage?.cloudManaged &&
        usage.activeMachines >= entitlement.machineLimit
      ) {
        return reply.code(409).send({
          error: "machine_limit_reached",
          details: {
            machineLimit: entitlement.machineLimit,
            plan: context.organization.plan,
          },
        });
      }
      const token = createEnrollmentToken();
      const expiresAt = Date.now() + 10 * 60_000;
      await database.createEnrollmentToken(
        context.organization.id,
        hashToken(token),
        expiresAt,
        parsed.data.userId,
      );
      await audit(
        database,
        context.organization.id,
        parsed.data.userId,
        "enrollment_token.created",
        "enrollment_token",
        hashToken(token),
      );
      gateway.notifyOrganization(context.organization.id);
      return reply.code(201).send({
        token,
        expiresAt: isoTimestamp(expiresAt),
      });
    },
  );

  app.post(
    "/v1/internal/cloud/machines/update",
    { preHandler },
    async (request, reply) => {
      const parsed = updateCloudMachineSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_request",
          details: parsed.error.issues,
        });
      }
      const context = await ensureContext(database, parsed.data);
      const machine = await database.updateMachineDetails({
        organizationId: context.organization.id,
        machineId: parsed.data.machineId,
        name: parsed.data.name,
        description: parsed.data.description,
      });
      if (!machine) {
        return reply.code(404).send({ error: "active_machine_not_found" });
      }
      await audit(
        database,
        context.organization.id,
        parsed.data.userId,
        "machine.updated",
        "machine",
        machine.id,
      );
      gateway.notifyOrganization(context.organization.id);
      return {
        id: machine.id,
        name: machine.name,
        description: machine.description ?? null,
      };
    },
  );

  app.post(
    "/v1/internal/cloud/machines/revoke",
    { preHandler },
    async (request, reply) => {
      const parsed = revokeCloudMachineSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      const context = await ensureContext(database, parsed.data);
      const machine = (await database.listMachines(context.organization.id)).find(
        (candidate) => candidate.id === parsed.data.machineId,
      );
      if (!machine) {
        return reply.code(404).send({ error: "active_machine_not_found" });
      }
      const sessions = await sessionDatabase.revokeSessions({
        organizationId: parsed.data.organization.externalId,
        machineId: parsed.data.machineId,
      });
      closeRevokedSessions(gateway, sessions, "machine_revoked");
      const disconnected = gateway.disconnect(parsed.data.machineId);
      const revoked = await database.revokeMachine(
        context.organization.id,
        parsed.data.machineId,
      );
      if (!revoked) {
        return reply.code(404).send({ error: "active_machine_not_found" });
      }
      await audit(
        database,
        context.organization.id,
        parsed.data.userId,
        "machine.revoked",
        "machine",
        parsed.data.machineId,
        { revokedSessions: sessions.length, disconnected },
      );
      gateway.notifyOrganization(context.organization.id);
      return {
        id: revoked.id,
        name: revoked.name,
        status: "revoked",
        revokedAt: isoTimestamp(revoked.revokedAt),
        revokedSessions: sessions.length,
        disconnected,
      };
    },
  );

  app.post(
    "/v1/internal/cloud/agents/role",
    { preHandler },
    async (request, reply) => {
      const parsed = updateCloudAgentRoleSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      const context = await ensureContext(database, parsed.data);
      const existing = (await database.listOrganizationAgents(context.organization.id))
        .find((agent) => agent.id === parsed.data.agentId);
      if (!existing) {
        return reply.code(404).send({ error: "agent_not_found" });
      }
      const updated = await database.updateOrganizationAgentRole(
        context.organization.id,
        parsed.data.agentId,
        parsed.data.agentRole,
      );
      if (!updated) {
        return reply.code(404).send({ error: "agent_not_found" });
      }
      let revokedSessions = 0;
      if (existing.role === "operator" && updated.role === "standard") {
        const sessions = await sessionDatabase.revokeSessions({
          organizationId: parsed.data.organization.externalId,
          agentId: parsed.data.agentId,
        });
        revokedSessions = sessions.length;
        closeRevokedSessions(gateway, sessions, "operator_role_revoked");
      }
      await audit(
        database,
        context.organization.id,
        parsed.data.userId,
        "agent.role_changed",
        "agent",
        parsed.data.agentId,
        { from: existing.role, to: updated.role, revokedSessions },
      );
      gateway.notifyOrganization(context.organization.id);
      return { agent: updated, revokedSessions };
    },
  );

  app.post(
    "/v1/internal/cloud/agents/delete",
    { preHandler },
    async (request, reply) => {
      const parsed = deleteCloudAgentSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      const context = await ensureContext(database, parsed.data);
      const agents = await database.listOrganizationAgents(context.organization.id);
      if (!agents.some((agent) => agent.id === parsed.data.agentId)) {
        return reply.code(404).send({ error: "agent_not_found" });
      }
      const agentIds = [parsed.data.agentId];
      let revokedSessions = 0;
      for (const agentId of agentIds) {
        const sessions = await sessionDatabase.revokeSessions({
          organizationId: parsed.data.organization.externalId,
          agentId,
        });
        revokedSessions += sessions.length;
        closeRevokedSessions(gateway, sessions, "agent_revoked");
      }
      const deleted = await database.deleteOrganizationAgent(
        context.organization.id,
        parsed.data.agentId,
      );
      if (!deleted) {
        return reply.code(404).send({ error: "agent_not_found" });
      }
      await audit(
        database,
        context.organization.id,
        parsed.data.userId,
        "agent.deleted",
        "agent",
        parsed.data.agentId,
        { deletedAgents: deleted.agentIds.length, revokedSessions },
      );
      await database.createNotification({
        organizationId: context.organization.id,
        userId: parsed.data.userId,
        kind: "agent.revoked",
        title: "Agent removed",
        description: "Its OAuth installation and active Sessions were revoked",
        href: "/dashboard/agents",
        resourceId: parsed.data.agentId,
      });
      gateway.notifyOrganization(context.organization.id);
      return {
        deleted: true,
        deletedAgents: deleted.agentIds.length,
        revokedSessions,
      };
    },
  );

  app.post(
    "/v1/internal/cloud/machines/ping",
    { preHandler },
    async (request, reply) => {
      const parsed = revokeCloudMachineSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      const context = await ensureContext(database, parsed.data);
      if (!pingLimiter.allow(context.organization.id, parsed.data.userId)) {
        return reply.code(429).send({ error: "machine_ping_rate_limited" });
      }
      if (
        !await database.activeMachinesExist(context.organization.id, [
          parsed.data.machineId,
        ])
      ) {
        return reply.code(404).send({ error: "active_machine_not_found" });
      }
      if (!gateway.isOnline(parsed.data.machineId)) {
        return reply.code(409).send({ error: "machine_offline" });
      }
      if (!pingConcurrency.acquire(context.organization.id, parsed.data.userId)) {
        return reply.code(429).send({ error: "machine_ping_limit_reached" });
      }
      try {
        const latencyMs = await gateway.ping(parsed.data.machineId);
        return { reply: "pong", machineId: parsed.data.machineId, latencyMs };
      } catch {
        return reply.code(504).send({ error: "machine_ping_timeout" });
      } finally {
        pingConcurrency.release(context.organization.id, parsed.data.userId);
      }
    },
  );

  app.post(
    "/v1/internal/cloud/live-token",
    { preHandler },
    async (request, reply) => {
      const parsed = cloudIdentitySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      if (!webKey || !webUrl) {
        return reply.code(503).send({ error: "cloud_authentication_disabled" });
      }
      const context = await ensureContext(database, parsed.data);
      if (!liveTokenLimiter.allow(context.organization.id, parsed.data.userId)) {
        return reply.code(429).send({ error: "live_token_rate_limited" });
      }
      const now = Date.now();
      return {
        token: createCloudLiveToken(
          webKey,
          { organizationId: context.organization.id, userId: parsed.data.userId },
          now,
          60_000,
        ),
        expiresAt: new Date(now + 60_000).toISOString(),
      };
    },
  );

  app.post<{ Body: string }>("/v1/cloud/events", async (request, reply) => {
    const origin = Array.isArray(request.headers.origin)
      ? request.headers.origin[0]
      : request.headers.origin;
    const originDecision = cloudLiveOriginDecision(webUrl, origin);
    if (originDecision === "disabled" || !webKey || !webUrl) {
      return reply.code(503).send({ error: "cloud_authentication_disabled" });
    }
    if (originDecision === "denied") {
      return reply.code(403).send({ error: "origin_not_allowed" });
    }
    const claims = typeof request.body === "string"
      ? verifyCloudLiveToken(webKey, request.body)
      : null;
    if (!claims) {
      return reply.code(401).send({ error: "invalid_or_expired_live_token" });
    }
    if (!liveReplayGuard.consume(request.body, claims.expiresAt)) {
      return reply.code(401).send({ error: "live_token_replayed" });
    }
    if (!liveStreams.acquire(claims.organizationId, claims.userId)) {
      return reply.code(429).send({ error: "live_stream_limit_reached" });
    }

    const eventName = `organization:${claims.organizationId}`;
    const emitRefresh = (): void => {
      reply.raw.write(
        `event: refresh\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`,
      );
    };
    let cleaned = false;
    let heartbeat: NodeJS.Timeout | undefined;
    let expiry: NodeJS.Timeout | undefined;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      if (heartbeat) clearInterval(heartbeat);
      if (expiry) clearTimeout(expiry);
      gateway.events.off(eventName, emitRefresh);
      liveStreams.release(claims.organizationId, claims.userId);
      if (!reply.raw.writableEnded) reply.raw.end();
    };
    try {
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "access-control-allow-origin": webUrl,
        vary: "Origin",
        "x-content-type-options": "nosniff",
      });
      gateway.events.on(eventName, emitRefresh);
      reply.raw.on("close", cleanup);
      heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 15_000);
      expiry = setTimeout(
        cleanup,
        Math.max(0, claims.expiresAt - Date.now()),
      );
      reply.raw.write(": connected\n\n");
    } catch (error) {
      cleanup();
      throw error;
    }
  });
}

async function ensureContext(
  database: Database,
  identity: z.infer<typeof cloudIdentitySchema>,
) {
  return await database.ensureCloudContext({
    externalId: identity.organization.externalId,
    slug: identity.organization.slug,
    name: identity.organization.name,
  });
}

function closeRevokedSessions(
  gateway: ClientGateway,
  revoked: Array<{ session: { id: string; machineId: string }; commandIds: string[] }>,
  reason: string,
): void {
  for (const { session, commandIds } of revoked) {
    for (const commandId of commandIds) {
      gateway.send(session.machineId, { type: "command.cancel", commandId });
    }
    gateway.send(session.machineId, { type: "session.close", sessionId: session.id, reason });
  }
}

function isoTimestamp(timestamp: number | undefined): string | null {
  return timestamp === undefined ? null : new Date(timestamp).toISOString();
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function controlEventView(event: AuditRecord) {
  return {
    id: event.id,
    principalId: event.principalId,
    action: event.action,
    targetType: event.targetType,
    targetId: event.targetId,
    metadata: privacySafeControlMetadata(event.metadata),
    createdAt: isoTimestamp(event.createdAt),
  };
}
