import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { createOpaqueToken } from "./access.js";
import {
  CloudLiveTokenReplayGuard,
  cloudIdentitySchema,
  cloudLiveOriginDecision,
  cloudUserSettingsSchema,
  cloudWorkspaceSettingsSchema,
  createCloudLiveToken,
  deleteCloudAgentSchema,
  entitlementsFor,
  privacySafeControlMetadata,
  revokeCloudMachineSchema,
  ScopedConcurrencyLimiter,
  ScopedRateLimiter,
  updateCloudMachineSchema,
  verifyCloudLiveToken,
} from "./cloud.js";
import { audit, type AuditRecord, type Database } from "./database.js";
import type { ClientGateway } from "./gateway.js";
import type { PostgresTaskDatabase } from "./task-database.js";

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
    taskDatabase: PostgresTaskDatabase;
    gateway: ClientGateway;
    preHandler: WebPreHandler;
    webKey: string | undefined;
    webUrl: string | undefined;
    auditRetentionMilliseconds: number;
  },
): void {
  const {
    database,
    taskDatabase,
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
        ...(parsed.data.userName ? { userName: parsed.data.userName } : {}),
      });
      const [
        machines,
        usage,
        agents,
        runnableAgentIds,
        tasks,
        taskEvents,
        controlEvents,
        notifications,
        userPreferences,
      ] = await Promise.all([
        database.listMachines(context.workspace.id),
        database.workspacePlan(context.workspace.id),
        database.listWorkspaceAgents(context.workspace.id),
        database.listRunnableAgentIds(context.workspace.id),
        taskDatabase.listTasks(parsed.data.organization.externalId, 100),
        taskDatabase.listAuditEvents(parsed.data.organization.externalId, 100),
        database.listAudit(context.workspace.id, 50),
        database.listNotifications(context.workspace.id, parsed.data.userId),
        database.userPreferences(parsed.data.userId),
      ]);
      const onlineMachines = machines.filter((machine) =>
        gateway.isOnline(machine.id)
      );
      const plan = entitlementsFor(context.organization.plan);
      return {
        organization: context.organization,
        workspace: context.workspace,
        userPreferences: { timeZone: userPreferences.timeZone },
        plan: {
          id: context.organization.plan,
          ...plan,
          controlEventRetentionDays: Math.round(
            dependencies.auditRetentionMilliseconds / (24 * 60 * 60 * 1_000),
          ),
        },
        usage: {
          machines: usage?.activeMachines ?? machines.length,
          workspaces: 1,
          activeAgents: usage?.activeAgents ?? 0,
        },
        connections: {
          activeConnections: onlineMachines.length,
          connectedAgents: new Set(
            tasks
              .filter((task) => task.status === "active")
              .map((task) => task.agentId),
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
          kind: agent.kind,
          status: agent.status,
          parentAgentId: agent.parentAgentId ?? null,
          credentialActive: runnableAgentIds.includes(agent.id),
          createdAt: isoTimestamp(agent.createdAt),
        })),
        tasks,
        notifications: notifications
          .filter((notification) => !notification.kind.startsWith("session."))
          .map((notification) => ({
            ...notification,
            readAt: isoTimestamp(notification.readAt),
            createdAt: isoTimestamp(notification.createdAt),
          })),
        controlEvents: [
          ...taskEvents.map((event) => ({
            id: `task:${event.id}`,
            principalId:
              typeof event.metadata.humanId === "string"
                ? event.metadata.humanId
                : event.agentId,
            action: event.type,
            targetType: event.commandId ? "command" : "task",
            targetId: event.commandId ?? event.taskId,
            metadata: event.metadata,
            createdAt: event.createdAt,
          })),
          ...controlEvents
            .filter((event) => {
              const domain = event.action.split(".")[0];
              return domain !== "session" && domain !== "operation";
            })
            .map(controlEventView),
        ].sort((left, right) =>
          String(right.createdAt).localeCompare(String(left.createdAt))
        ),
      };
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
    "/v1/internal/cloud/workspace/settings/update",
    { preHandler },
    async (request, reply) => {
      const parsed = cloudWorkspaceSettingsSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      const context = await ensureContext(database, parsed.data);
      const workspace = await database.updateWorkspaceSettings(
        parsed.data.section === "details"
          ? {
              workspaceId: context.workspace.id,
              section: "details",
              name: parsed.data.name,
              avatarSeed: parsed.data.avatarSeed,
            }
          : {
              workspaceId: context.workspace.id,
              section: "logging",
              loggingLevel: parsed.data.loggingLevel,
            },
      );
      if (!workspace) {
        return reply.code(404).send({ error: "organization_not_found" });
      }
      gateway.notifyWorkspace(workspace.id);
      return { workspace };
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
        context.workspace.id,
        parsed.data.userId,
        parsed.data.notificationId,
        parsed.data.read,
      );
      if (!marked) {
        return reply.code(404).send({ error: "notification_not_found" });
      }
      gateway.notifyWorkspace(context.workspace.id);
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
        context.workspace.id,
        parsed.data.userId,
      );
      gateway.notifyWorkspace(context.workspace.id);
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
      if (!enrollmentLimiter.allow(context.workspace.id, parsed.data.userId)) {
        return reply.code(429).send({
          error: "enrollment_issuance_rate_limited",
        });
      }
      const usage = await database.workspacePlan(context.workspace.id);
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
      const token = createOpaqueToken("enroll");
      const expiresAt = Date.now() + 10 * 60_000;
      await database.createEnrollmentToken(
        context.workspace.id,
        hashToken(token),
        expiresAt,
        parsed.data.userId,
      );
      await audit(
        database,
        context.workspace.id,
        parsed.data.userId,
        "enrollment_token.created",
        "enrollment_token",
        hashToken(token),
      );
      gateway.notifyWorkspace(context.workspace.id);
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
        workspaceId: context.workspace.id,
        machineId: parsed.data.machineId,
        name: parsed.data.name,
        description: parsed.data.description,
      });
      if (!machine) {
        return reply.code(404).send({ error: "active_machine_not_found" });
      }
      await audit(
        database,
        context.workspace.id,
        parsed.data.userId,
        "machine.updated",
        "machine",
        machine.id,
      );
      gateway.notifyWorkspace(context.workspace.id);
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
      const machine = (await database.listMachines(context.workspace.id)).find(
        (candidate) => candidate.id === parsed.data.machineId,
      );
      if (!machine) {
        return reply.code(404).send({ error: "active_machine_not_found" });
      }
      const tasks = await taskDatabase.revokeTasks({
        organizationId: parsed.data.organization.externalId,
        machineId: parsed.data.machineId,
      });
      closeRevokedTasks(gateway, tasks, "machine_revoked");
      const disconnected = gateway.disconnect(parsed.data.machineId);
      const revoked = await database.revokeMachine(
        context.workspace.id,
        parsed.data.machineId,
      );
      if (!revoked) {
        return reply.code(404).send({ error: "active_machine_not_found" });
      }
      await audit(
        database,
        context.workspace.id,
        parsed.data.userId,
        "machine.revoked",
        "machine",
        parsed.data.machineId,
        { revokedTasks: tasks.length, disconnected },
      );
      gateway.notifyWorkspace(context.workspace.id);
      return {
        id: revoked.id,
        name: revoked.name,
        status: "revoked",
        revokedAt: isoTimestamp(revoked.revokedAt),
        revokedTasks: tasks.length,
        disconnected,
      };
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
      const agents = await database.listWorkspaceAgents(context.workspace.id);
      if (!agents.some((agent) => agent.id === parsed.data.agentId)) {
        return reply.code(404).send({ error: "agent_not_found" });
      }
      const agentIds = descendantAgentIds(agents, parsed.data.agentId);
      let revokedTasks = 0;
      for (const agentId of agentIds) {
        const tasks = await taskDatabase.revokeTasks({
          organizationId: parsed.data.organization.externalId,
          agentId,
        });
        revokedTasks += tasks.length;
        closeRevokedTasks(gateway, tasks, "agent_revoked");
      }
      const deleted = await database.deleteWorkspaceAgent(
        context.workspace.id,
        parsed.data.agentId,
      );
      if (!deleted) {
        return reply.code(404).send({ error: "agent_not_found" });
      }
      await audit(
        database,
        context.workspace.id,
        parsed.data.userId,
        "agent.deleted",
        "agent",
        parsed.data.agentId,
        { deletedAgents: deleted.agentIds.length, revokedTasks },
      );
      await database.createNotification({
        workspaceId: context.workspace.id,
        userId: parsed.data.userId,
        kind: "agent.revoked",
        title: "Agent removed",
        description: "Its OAuth installation and active Tasks were revoked",
        href: "/dashboard/agents",
        resourceId: parsed.data.agentId,
      });
      gateway.notifyWorkspace(context.workspace.id);
      return {
        deleted: true,
        deletedAgents: deleted.agentIds.length,
        revokedTasks,
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
      if (!pingLimiter.allow(context.workspace.id, parsed.data.userId)) {
        return reply.code(429).send({ error: "machine_ping_rate_limited" });
      }
      if (
        !await database.activeMachinesExist(context.workspace.id, [
          parsed.data.machineId,
        ])
      ) {
        return reply.code(404).send({ error: "active_machine_not_found" });
      }
      if (!gateway.isOnline(parsed.data.machineId)) {
        return reply.code(409).send({ error: "machine_offline" });
      }
      if (!pingConcurrency.acquire(context.workspace.id, parsed.data.userId)) {
        return reply.code(429).send({ error: "machine_ping_limit_reached" });
      }
      try {
        const latencyMs = await gateway.ping(parsed.data.machineId);
        return { reply: "pong", machineId: parsed.data.machineId, latencyMs };
      } catch {
        return reply.code(504).send({ error: "machine_ping_timeout" });
      } finally {
        pingConcurrency.release(context.workspace.id, parsed.data.userId);
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
      if (!liveTokenLimiter.allow(context.workspace.id, parsed.data.userId)) {
        return reply.code(429).send({ error: "live_token_rate_limited" });
      }
      const now = Date.now();
      return {
        token: createCloudLiveToken(
          webKey,
          { workspaceId: context.workspace.id, userId: parsed.data.userId },
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
    if (!liveStreams.acquire(claims.workspaceId, claims.userId)) {
      return reply.code(429).send({ error: "live_stream_limit_reached" });
    }

    const eventName = `workspace:${claims.workspaceId}`;
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
      liveStreams.release(claims.workspaceId, claims.userId);
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

function descendantAgentIds(
  agents: Array<{ id: string; parentAgentId?: string | null }>,
  rootAgentId: string,
): string[] {
  const selected = new Set([rootAgentId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const agent of agents) {
      if (
        agent.parentAgentId &&
        selected.has(agent.parentAgentId) &&
        !selected.has(agent.id)
      ) {
        selected.add(agent.id);
        changed = true;
      }
    }
  }
  return [...selected];
}

async function ensureContext(
  database: Database,
  identity: z.infer<typeof cloudIdentitySchema>,
) {
  return await database.ensureCloudContext({
    externalId: identity.organization.externalId,
    slug: identity.organization.slug,
    name: identity.organization.name,
    ...(identity.userName ? { userName: identity.userName } : {}),
  });
}

function closeRevokedTasks(
  gateway: ClientGateway,
  revoked: Array<{ task: { id: string; machineId: string }; commandIds: string[] }>,
  reason: string,
): void {
  for (const { task, commandIds } of revoked) {
    for (const commandId of commandIds) {
      gateway.send(task.machineId, { type: "command.cancel", commandId });
    }
    gateway.send(task.machineId, { type: "task.close", taskId: task.id, reason });
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
