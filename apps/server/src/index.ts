import { createHash, createPublicKey, randomUUID, timingSafeEqual } from "node:crypto";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import {
  agentSessionRequestInputSchema,
  allCapabilities,
  capabilityForAction,
  operationRequestSchema,
  organizationRequestSchema,
  PROTOCOL_VERSION,
  sessionRequestSchema,
  workspaceRequestSchema,
  type Capability,
  type OperationAction,
} from "@odyshell/protocol";
import {
  boundedSessionExpiry,
  createOpaqueToken,
  developmentCredentialsEnabled,
  serverAdminKey,
} from "./access.js";
import {
  approveDeviceSchema,
  CloudLiveTokenReplayGuard,
  cloudLiveOriginDecision,
  createCloudLiveToken,
  cloudIdentitySchema,
  cloudManualSessionSchema,
  cloudConnectionView,
  cloudWebRequestDecision,
  cloudWebKey,
  cloudWebUrl,
  createDeviceUserCode,
  deleteCloudAgentSchema,
  entitlementsFor,
  exchangeDeviceAuthorizationSchema,
  FixedWindowRateLimiter,
  normalizeDeviceUserCode,
  privacySafeControlMetadata,
  revokeCloudMachineSchema,
  ScopedConcurrencyLimiter,
  ScopedRateLimiter,
  sessionApprovalUrl,
  startDeviceAuthorizationSchema,
  verifyCloudLiveToken,
  sessionApprovalSchema,
} from "./cloud.js";
import {
  audit,
  createDatabase,
  DEFAULT_WORKSPACE_ID,
  type AgentCredentialPrincipal,
  type AgentSessionCredentialPrincipal,
  type AuditRecord,
  type CliTokenRecord,
} from "./database.js";
import {
  sessionOperationDecision,
  type AgentSessionPrincipal,
} from "./agent-sessions.js";
import { clientCompatibility } from "./compatibility.js";
import { ClientGateway } from "./gateway.js";
import { dataRetentionPolicy } from "./privacy.js";
import { registerRemoteMcp } from "./remote-mcp.js";
import { createRemoteMcpRuntime } from "./remote-mcp-runtime.js";
import {
  decryptEventSinkSecret,
  encryptEventSinkSecret,
  eventSinkConfigurationSchema,
  eventSinkDestination,
  eventSinkDetailLevels,
  eventSinkRetryAt,
  postSignedTimeline,
  redactEventSinkMetadata,
  redactTimelineMetadata,
  signedTimelineDelivery,
  type EventSinkDetailLevel,
  type TimelineExport,
} from "./event-sinks.js";

const port = Number(process.env.PORT ?? 4100);
const host = process.env.HOST ?? "127.0.0.1";
const adminKey = serverAdminKey(process.env);
const webKey = cloudWebKey(process.env);
const webUrl = cloudWebUrl(process.env, webKey !== undefined);
const developmentAgentKey = developmentCredentialsEnabled(process.env)
  ? (process.env.ODYSHELL_AGENT_KEY ?? "dev-agent-key")
  : undefined;
const scopedOperationRequestSchema = operationRequestSchema
  .extend({ machineId: z.string().uuid().optional() })
  .strict();
const idempotencyKeySchema = z.string().trim().min(1).max(128);
const agentIdentityReferenceSchema = z
  .object({ agentId: z.string().uuid() })
  .strict();
const renewAgentSessionSchema = agentIdentityReferenceSchema.extend({
  durationSeconds: z.number().int().min(60).max(24 * 60 * 60).optional(),
});
const completeAgentSessionSchema = agentIdentityReferenceSchema
  .extend({
    outcome: z.enum(["succeeded", "failed"]),
    summary: z.string().trim().min(1).max(512).optional(),
  })
  .strict();
const cloudSessionSchema = cloudIdentitySchema
  .extend({ sessionId: z.string().uuid() })
  .strict();
const cloudNotificationSchema = cloudIdentitySchema
  .extend({
    notificationId: z.string().uuid(),
    read: z.boolean().default(true),
  })
  .strict();
const startAgentDeviceAuthorizationSchema = z
  .object({ agentName: z.string().trim().min(1).max(80) })
  .strict();
const exchangeAgentDeviceAuthorizationSchema = z
  .object({ deviceCode: z.string().min(32).max(256) })
  .strict();
const cloudAgentDeviceSchema = cloudIdentitySchema
  .extend({ userCode: z.string().min(8).max(32) })
  .strict();
const agentPolicyProposalSchema = z
  .object({
    kind: z.enum(["autoapproval", "delegation"]).default("autoapproval"),
    scopes: agentSessionRequestInputSchema.shape.scopes,
    maxSessionSeconds: z.number().int().min(60).max(24 * 60 * 60),
    maxManagedAgents: z.number().int().min(1).max(100).optional(),
    validForSeconds: z
      .number()
      .int()
      .refine(
        (value) =>
          [1, 7, 30, 90, 365].map((days) => days * 24 * 60 * 60).includes(value),
        "Policy validity must be 1, 7, 30, 90, or 365 days",
      ),
  })
  .superRefine((value, context) => {
    if (value.kind === "delegation" && value.maxManagedAgents === undefined) {
      context.addIssue({
        code: "custom",
        path: ["maxManagedAgents"],
        message: "Delegation policies require a Managed Agent limit",
      });
    }
    if (value.kind === "autoapproval" && value.maxManagedAgents !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["maxManagedAgents"],
        message: "Autoapproval policies cannot delegate Agents",
      });
    }
  })
  .strict();
const cloudAgentPolicySchema = cloudIdentitySchema
  .extend({ approvalCode: z.string().min(32).max(256) })
  .strict();
const managedAgentInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    scopes: agentSessionRequestInputSchema.shape.scopes,
    maxSessionSeconds: z.number().int().min(60).max(24 * 60 * 60),
    validForSeconds: z.number().int().min(60).max(365 * 24 * 60 * 60),
  })
  .strict();
const attributedAgentSessionRequestSchema = agentSessionRequestInputSchema
  .extend({ runId: z.string().trim().min(1).max(128).optional() })
  .strict();

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
await app.register(websocket, { options: { maxPayload: 2 * 1024 * 1024 } });

const db = createDatabase(process.env);
await db.initialize();
const retention = dataRetentionPolicy(process.env);
const eventSinkEncryptionKey =
  process.env.ODYSHELL_EVENT_SINK_ENCRYPTION_KEY;
const purgeExpiredData = async (): Promise<void> => {
  const now = Date.now();
  const purged = await db.purgeExpiredData({
    operationDataBefore: now - retention.operationDataMilliseconds,
    auditBefore: now - retention.auditMilliseconds,
  });
  if (
    purged.agentTokens +
      purged.enrollmentTokens +
      purged.operations +
      purged.sessions +
      purged.auditEvents >
    0
  ) {
    app.log.info(purged, "Expired retained operation and audit data");
  }
};
await purgeExpiredData();
const gateway = new ClientGateway(db);
gateway.register(app);

type AgentPrincipal = {
  kind: "agent_identity" | "cli" | "development" | "session";
  id: string;
  name: string;
  workspaceId: string;
  machineIds: Set<string> | null;
  capabilities: Set<Capability>;
  expiresAt: Date | null;
  sessionScope?: AgentSessionPrincipal;
};

const requestPrincipals = new WeakMap<FastifyRequest, AgentPrincipal>();
const requestCliPrincipals = new WeakMap<FastifyRequest, CliTokenRecord>();
const requestAgentCredentialPrincipals = new WeakMap<
  FastifyRequest,
  AgentCredentialPrincipal
>();
const requestAdminWorkspaces = new WeakMap<FastifyRequest, string>();
const requestAdminPrincipals = new WeakMap<FastifyRequest, string>();
const deviceStartLimiter = new FixedWindowRateLimiter(12, 60_000);
const devicePollLimiter = new FixedWindowRateLimiter(40, 60_000);
const agentDeviceStartLimiter = new FixedWindowRateLimiter(12, 60_000);
const agentDevicePollLimiter = new FixedWindowRateLimiter(40, 60_000);
const enrollmentIssuanceLimiter = new ScopedRateLimiter(
  60,
  20,
  60 * 60_000,
);
const sessionRequestLimiter = new ScopedRateLimiter(120, 20, 60 * 60_000);
const liveTokenIssuanceLimiter = new ScopedRateLimiter(300, 30, 60_000);
const liveTokenReplayGuard = new CloudLiveTokenReplayGuard();
const liveStreamLimiter = new ScopedConcurrencyLimiter(100, 4);
const cloudPingLimiter = new ScopedRateLimiter(120, 30, 60_000);
const machinePingLimiter = new FixedWindowRateLimiter(12, 60_000);
const pingConcurrencyLimiter = new ScopedConcurrencyLimiter(20, 3);

registerRemoteMcp(app, process.env, {
  database: db,
  runtime: (installation) =>
    createRemoteMcpRuntime(installation, {
      database: db,
      gateway,
      sessionRequestLimiter,
      ...(webUrl ? { webUrl } : {}),
    }),
});

function matchesSecret(actual: string | undefined, expected: string | undefined): boolean {
  if (!actual || !expected) return false;
  const actualDigest = createHash("sha256").update(actual).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!matchesSecret(request.headers["x-odyshell-admin-key"] as string | undefined, adminKey)) {
    await reply.code(401).send({ error: "invalid_admin_key" });
  }
}

async function requireWeb(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const decision = cloudWebRequestDecision(
    webKey,
    request.headers["x-odyshell-web-key"] as string | undefined,
  );
  if (decision === "disabled") {
    await reply.code(503).send({ error: "cloud_authentication_disabled" });
    return;
  }
  if (decision === "unauthorized") {
    await reply.code(401).send({ error: "invalid_web_key" });
  }
}

function bearerTokenFor(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization;
  return typeof authorization === "string"
    ? /^Bearer\s+(.+)$/i.exec(authorization)?.[1]
    : undefined;
}

async function requireAdminWorkspace(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const header = request.headers["x-odyshell-workspace-id"];
  if (Array.isArray(header)) {
    await reply.code(400).send({ error: "invalid_workspace_header" });
    return;
  }
  const workspaceId = header ?? DEFAULT_WORKSPACE_ID;
  if (workspaceId.length === 0 || workspaceId.length > 128) {
    await reply.code(400).send({ error: "invalid_workspace_header" });
    return;
  }
  if (!(await db.workspace(workspaceId))) {
    await reply.code(404).send({ error: "workspace_not_found" });
    return;
  }
  requestAdminWorkspaces.set(request, workspaceId);
  requestAdminPrincipals.set(request, "admin");
}

async function requireWorkspaceAccess(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (matchesSecret(request.headers["x-odyshell-admin-key"] as string | undefined, adminKey)) {
    await requireAdminWorkspace(request, reply);
    return;
  }
  const token = bearerTokenFor(request);
  const principal = token ? await db.findCliByTokenHash(hashToken(token)) : null;
  if (!principal) {
    await reply.code(401).send({ error: "invalid_or_expired_cli_token" });
    return;
  }
  const requestedWorkspace = request.headers["x-odyshell-workspace-id"];
  if (
    Array.isArray(requestedWorkspace) ||
    (requestedWorkspace !== undefined && requestedWorkspace !== principal.workspaceId)
  ) {
    await reply.code(403).send({ error: "workspace_scope_denied" });
    return;
  }
  requestAdminWorkspaces.set(request, principal.workspaceId);
  requestAdminPrincipals.set(request, principal.id);
}

async function requireCli(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const token = bearerTokenFor(request);
  const principal = token ? await db.findCliByTokenHash(hashToken(token)) : null;
  if (!principal) {
    await reply.code(401).send({ error: "invalid_or_expired_cli_token" });
    return;
  }
  requestCliPrincipals.set(request, principal);
}

async function requireSessionRequester(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const token = bearerTokenFor(request);
  if (token) {
    const agent = await db.findAgentCredentialByTokenHash(hashToken(token));
    if (agent) {
      requestAgentCredentialPrincipals.set(request, agent);
      return;
    }
    const cli = await db.findCliByTokenHash(hashToken(token));
    if (cli) {
      requestCliPrincipals.set(request, cli);
      return;
    }
  }
  await reply.code(401).send({ error: "invalid_requester_credential" });
}

async function requireAgent(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const bearerToken = bearerTokenFor(request);
  const legacyHeader = request.headers["x-odyshell-agent-key"];
  const token = bearerToken ?? (typeof legacyHeader === "string" ? legacyHeader : undefined);

  if (matchesSecret(token, developmentAgentKey)) {
    requestPrincipals.set(request, {
      kind: "development",
      id: "dev-agent",
      name: "Development agent",
      workspaceId: DEFAULT_WORKSPACE_ID,
      machineIds: null,
      capabilities: new Set(allCapabilities),
      expiresAt: null,
    });
    return;
  }

  if (token) {
    const agentIdentity = await db.findAgentCredentialByTokenHash(
      hashToken(token),
    );
    if (agentIdentity) {
      requestPrincipals.set(request, {
        kind: "agent_identity",
        id: agentIdentity.agentId,
        name: agentIdentity.agentName,
        workspaceId: agentIdentity.workspaceId,
        machineIds: null,
        capabilities: new Set(),
        expiresAt: new Date(agentIdentity.expiresAt),
      });
      return;
    }
    const cliPrincipal = await db.findCliByTokenHash(hashToken(token));
    if (cliPrincipal) {
      requestPrincipals.set(request, {
        kind: "cli",
        id: cliPrincipal.id,
        name: `Clerk user ${cliPrincipal.userId}`,
        workspaceId: cliPrincipal.workspaceId,
        machineIds: null,
        capabilities: new Set(allCapabilities),
        expiresAt: new Date(cliPrincipal.expiresAt),
      });
      return;
    }
    const sessionPrincipal = await db.findSessionCredentialPrincipal(
      hashToken(token),
    );
    if (sessionPrincipal) {
      const sessionScope: AgentSessionPrincipal = {
        workspaceId: sessionPrincipal.workspaceId,
        agentId: sessionPrincipal.agentId,
        sessionId: sessionPrincipal.sessionId,
        scopes: sessionPrincipal.scopes,
        expiresAt: sessionPrincipal.expiresAt,
      };
      requestPrincipals.set(request, {
        kind: "session",
        id: sessionPrincipal.agentId,
        name: sessionPrincipal.agentName,
        workspaceId: sessionPrincipal.workspaceId,
        machineIds: new Set(
          sessionPrincipal.scopes.map((scope) => scope.machineId),
        ),
        capabilities: new Set(
          sessionPrincipal.scopes.flatMap((scope) => scope.capabilities),
        ),
        expiresAt: new Date(sessionPrincipal.expiresAt),
        sessionScope,
      });
      return;
    }
  }

  await reply.code(401).send({ error: "invalid_or_expired_agent_token" });
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function isoTimestamp(timestamp: number | undefined): string | null {
  return timestamp === undefined ? null : new Date(timestamp).toISOString();
}

function principalFor(request: FastifyRequest): AgentPrincipal {
  const principal = requestPrincipals.get(request);
  if (!principal) throw new Error("Authenticated request has no agent principal");
  return principal;
}

function cliPrincipalFor(request: FastifyRequest): CliTokenRecord {
  const principal = requestCliPrincipals.get(request);
  if (!principal) throw new Error("Authenticated request has no CLI principal");
  return principal;
}

function sessionRequesterFor(request: FastifyRequest): {
  workspaceId: string;
  humanId: string;
  agent?: AgentCredentialPrincipal;
} {
  const agent = requestAgentCredentialPrincipals.get(request);
  if (agent) {
    return {
      workspaceId: agent.workspaceId,
      humanId: agent.ownerHumanId,
      agent,
    };
  }
  const cli = cliPrincipalFor(request);
  return {
    workspaceId: cli.workspaceId,
    humanId: cli.userId,
  };
}

async function requestedAgentFor(
  principal: ReturnType<typeof sessionRequesterFor>,
  agentId: string,
): Promise<{ id: string; name: string; managed: boolean } | null> {
  if (!principal.agent) {
    const agent = await db.getAgentIdentity(principal.workspaceId, agentId);
    return agent && agent.status === "active" && !agent.deletedAt
      ? { id: agent.id, name: agent.name, managed: agent.kind === "managed" }
      : null;
  }
  if (principal.agent.agentId === agentId) {
    return {
      id: principal.agent.agentId,
      name: principal.agent.agentName,
      managed: false,
    };
  }
  const managed = await db.managedAgentForParent(
    principal.workspaceId,
    agentId,
    principal.agent.agentId,
  );
  return managed
    ? { id: managed.id, name: managed.name, managed: true }
    : null;
}

function adminWorkspaceFor(request: FastifyRequest): string {
  const workspaceId = requestAdminWorkspaces.get(request);
  if (!workspaceId) throw new Error("Authenticated administrator has no workspace context");
  return workspaceId;
}

function adminPrincipalFor(request: FastifyRequest): string {
  const principalId = requestAdminPrincipals.get(request);
  if (!principalId) throw new Error("Authenticated administrator has no principal");
  return principalId;
}

function canAccessMachine(principal: AgentPrincipal, machineId: string): boolean {
  return principal.machineIds === null || principal.machineIds.has(machineId);
}

function operationAuditMetadata(action: OperationAction): Record<string, unknown> {
  return { kind: action.kind };
}

function isUniqueConflict(error: unknown): boolean {
  return (error as { code?: unknown })?.code === "23505";
}

function controlEventView(event: AuditRecord): {
  id: string;
  principalId: string;
  action: string;
  targetType: string;
  targetId: string;
  metadata: Record<string, string>;
  createdAt: string | null;
} {
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

function privacyMinimalTimelineMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const key of [
    "machineId",
    "machineIds",
    "status",
    "expiresAt",
    "predecessorSessionId",
    "executorAgentId",
    "requesterAgentId",
    "actorHumanId",
    "actorAgentId",
    "runId",
    "kind",
    "command",
    "program",
    "args",
    "exitCode",
    "outputTruncated",
    "errorCode",
    "correlationId",
    "outcome",
  ]) {
    if (metadata[key] !== undefined) safe[key] = metadata[key];
  }
  if (Array.isArray(metadata.scopes)) {
    safe.scopes = metadata.scopes.map((scope) => {
      if (!scope || typeof scope !== "object") return {};
      const value = scope as Record<string, unknown>;
      return {
        ...(typeof value.machineId === "string"
          ? { machineId: value.machineId }
          : {}),
        ...(Array.isArray(value.capabilities)
          ? { capabilities: value.capabilities.filter((item) => typeof item === "string") }
          : {}),
      };
    });
  }
  return safe;
}

async function timelineExport(
  workspaceId: string,
  sessionId: string,
  events: Awaited<ReturnType<typeof db.workspaceSessionTimeline>>,
  detailLevel: EventSinkDetailLevel,
  now = Date.now(),
  audience: "timeline" | "event-sink" = "timeline",
): Promise<TimelineExport> {
  const retainedAfter = now - retention.auditMilliseconds;
  const operationMetadata =
    detailLevel !== "privacy-minimal"
      ? await db.operationTimelineMetadata(
          workspaceId,
          (events ?? []).flatMap((event) =>
            event.operationId ? [event.operationId] : [],
          ),
          detailLevel === "diagnostic",
        )
      : new Map<string, Record<string, unknown>>();
  return {
    version: "2026-07-31",
    sessionId,
    exportedAt: new Date(now).toISOString(),
    events: (events ?? [])
      .filter((event) => event.createdAt >= retainedAfter)
      .map((event) => {
        const details = event.operationId
          ? operationMetadata.get(event.operationId)
          : undefined;
        const { stdout: _stdout, stderr: _stderr, ...withoutOutput } =
          details ?? {};
        return {
          id: event.id,
          eventType: event.eventType,
          source: event.source,
          ...(event.operationId ? { operationId: event.operationId } : {}),
          metadata: (audience === "event-sink"
            ? redactEventSinkMetadata
            : redactTimelineMetadata)(
            {
              ...event.metadata,
              ...(event.eventType === "operation.completed"
                ? details
                : withoutOutput),
            },
            detailLevel,
          ),
          createdAt: new Date(event.createdAt).toISOString(),
        };
      }),
  };
}

function eventSinkView(
  sink: NonNullable<Awaited<ReturnType<typeof db.workspaceEventSink>>>,
): Record<string, unknown> {
  const { secretLastFour, ...visible } = sink;
  return {
    ...visible,
    signingSecret: `••••${secretLastFour}`,
    createdAt: isoTimestamp(sink.createdAt),
    updatedAt: isoTimestamp(sink.updatedAt),
  };
}

async function revokeWorkspaceMachine(
  workspaceId: string,
  principalId: string,
  machineId: string,
): Promise<{
  id: string;
  name: string;
  status: "revoked";
  revokedAt: string | null;
  cancelledOperations: number;
  closedSessions: number;
  disconnected: boolean;
} | null> {
  const machine = await db.revokeMachine(workspaceId, machineId);
  if (!machine) return null;

  for (const operationId of machine.operationIds) {
    gateway.send(machine.id, { type: "operation.cancel", operationId });
    gateway.events.emit(`operation:${operationId}`);
  }
  for (const sessionId of machine.sessionIds) {
    gateway.send(machine.id, {
      type: "session.close",
      sessionId,
      reason: "machine_revoked",
    });
    gateway.events.emit(`session:${sessionId}`);
  }
  const disconnected = gateway.disconnect(machine.id);
  await audit(db, workspaceId, principalId, "machine.revoked", "machine", machine.id, {
    name: machine.name,
    revokedAt: isoTimestamp(machine.revokedAt),
    cancelledOperations: machine.operationIds.length,
    closedSessions: machine.sessionIds.length,
    disconnected,
  });
  gateway.notifyWorkspace(workspaceId);
  return {
    id: machine.id,
    name: machine.name,
    status: "revoked",
    revokedAt: isoTimestamp(machine.revokedAt),
    cancelledOperations: machine.operationIds.length,
    closedSessions: machine.sessionIds.length,
    disconnected,
  };
}

async function deleteWorkspaceAgent(
  workspaceId: string,
  principalId: string,
  agentId: string,
  notifyUserId?: string,
): Promise<{
  deletedAgents: number;
  terminatedSessions: number;
} | null> {
  const agent = await db.getAgentIdentity(workspaceId, agentId);
  const hierarchy = await db.deleteWorkspaceAgent(workspaceId, agentId);
  if (!hierarchy) return null;
  let terminatedSessions = 0;
  for (const session of hierarchy.sessionIds) {
    const termination = await db.cancelAgentSession({
      workspaceId,
      sessionId: session.id,
      agentId: session.agentId,
      reason: "revoked",
    });
    if (!termination?.transitioned) continue;
    terminatedSessions += 1;
    for (const operation of termination.operations) {
      gateway.send(operation.machineId, {
        type: "operation.cancel",
        operationId: operation.id,
      });
    }
    for (const target of termination.targets) {
      gateway.send(target.machineId, {
        type: "session.close",
        sessionId: target.runtimeSessionId,
        reason: "agent_deleted",
      });
    }
  }
  await audit(db, workspaceId, principalId, "agent.deleted", "agent", agentId, {
    deletedAgents: hierarchy.agentIds.length,
    terminatedSessions,
  });
  if (notifyUserId) {
    await db.createNotification({
      workspaceId,
      userId: notifyUserId,
      kind: "agent.revoked",
      title: "Agent removed",
      description: `${agent?.name ?? "Agent"} no longer has access`,
      href: "/dashboard/agents",
      resourceId: agentId,
    });
  }
  gateway.notifyWorkspace(workspaceId);
  return {
    deletedAgents: hierarchy.agentIds.length,
    terminatedSessions,
  };
}

app.get("/health", async () => {
  await db.health();
  return { status: "ok", protocol: PROTOCOL_VERSION };
});

app.post("/v1/auth/agent/device", async (request, reply) => {
  if (!webKey || !webUrl) {
    return reply.code(503).send({ error: "cloud_authentication_disabled" });
  }
  if (!agentDeviceStartLimiter.allow(request.ip)) {
    return reply.code(429).send({ error: "device_authorization_rate_limited" });
  }
  const parsed = startAgentDeviceAuthorizationSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "invalid_request" });
  }
  const deviceCode = createOpaqueToken("agent_device");
  const userCode = createDeviceUserCode();
  const expiresIn = 600;
  await db.createAgentDeviceAuthorization({
    id: randomUUID(),
    deviceCodeHash: hashToken(deviceCode),
    userCodeHash: hashToken(normalizeDeviceUserCode(userCode)),
    agentName: parsed.data.agentName,
    expiresAt: Date.now() + expiresIn * 1_000,
  });
  const verificationUri = `${webUrl}/activate-agent`;
  return reply.code(201).send({
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete: `${verificationUri}?code=${encodeURIComponent(userCode)}`,
    expiresIn,
    interval: 2,
  });
});

app.post("/v1/auth/agent/device/token", async (request, reply) => {
  const parsed = exchangeAgentDeviceAuthorizationSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "invalid_request" });
  }
  const deviceCodeHash = hashToken(parsed.data.deviceCode);
  if (!agentDevicePollLimiter.allow(deviceCodeHash)) {
    return reply.code(429).send({ error: "slow_down" });
  }
  const accessToken = createOpaqueToken("agent");
  const expiresAt = Date.now() + 90 * 24 * 60 * 60 * 1_000;
  const exchange = await db.exchangeAgentDeviceAuthorization({
    deviceCodeHash,
    credentialId: randomUUID(),
    credentialHash: hashToken(accessToken),
    expiresAt,
  });
  if (exchange.status === "pending") {
    return reply.code(400).send({ error: "authorization_pending" });
  }
  if (exchange.status === "expired") {
    return reply.code(400).send({ error: "expired_token" });
  }
  if (exchange.status === "denied") {
    return reply.code(403).send({ error: "access_denied" });
  }
  if (exchange.status === "consumed") {
    return reply.code(409).send({ error: "device_code_already_used" });
  }
  if (exchange.status === "invalid") {
    return reply.code(401).send({ error: "invalid_device_code" });
  }
  if (exchange.status !== "authorized") {
    throw new Error(`Unhandled Agent device state: ${exchange.status}`);
  }
  return {
    accessToken,
    tokenType: "Bearer",
    workspaceId: exchange.workspaceId,
    agentId: exchange.agentId,
    agentName: exchange.agentName,
    credentialId: exchange.credentialId,
    expiresAt: isoTimestamp(exchange.expiresAt),
  };
});

app.post(
  "/v1/agent-credentials/rotate",
  { preHandler: requireSessionRequester },
  async (request, reply) => {
    const principal = requestAgentCredentialPrincipals.get(request);
    const currentToken = bearerTokenFor(request);
    if (!principal || !currentToken) {
      return reply.code(403).send({ error: "agent_credential_required" });
    }
    const accessToken = createOpaqueToken("agent");
    const expiresAt = Date.now() + 90 * 24 * 60 * 60 * 1_000;
    const rotated = await db.rotateAgentCredential({
      currentTokenHash: hashToken(currentToken),
      credentialId: randomUUID(),
      credentialHash: hashToken(accessToken),
      expiresAt,
      overlapMilliseconds: 10 * 60 * 1_000,
    });
    if (!rotated) {
      return reply.code(401).send({ error: "invalid_agent_credential" });
    }
    return {
      accessToken,
      tokenType: "Bearer",
      workspaceId: rotated.workspaceId,
      agentId: rotated.agentId,
      agentName: rotated.agentName,
      credentialId: rotated.credentialId,
      expiresAt: isoTimestamp(rotated.expiresAt),
      overlapSeconds: 600,
    };
  },
);

app.post(
  "/v1/agent-credentials/revoke",
  { preHandler: requireSessionRequester },
  async (request, reply) => {
    const principal = requestAgentCredentialPrincipals.get(request);
    const currentToken = bearerTokenFor(request);
    if (!principal || !currentToken) {
      return reply.code(403).send({ error: "agent_credential_required" });
    }
    const hierarchy = await db.revokeAgentHierarchyByTokenHash(
      hashToken(currentToken),
    );
    if (!hierarchy) {
      return reply.code(401).send({ error: "invalid_agent_credential" });
    }
    let terminatedSessions = 0;
    for (const session of hierarchy.sessionIds) {
      const termination = await db.cancelAgentSession({
        workspaceId: hierarchy.workspaceId,
        sessionId: session.id,
        agentId: session.agentId,
        requestedByHumanId: hierarchy.ownerHumanId,
        reason: "revoked",
      });
      if (!termination) continue;
      terminatedSessions += 1;
      for (const operation of termination.operations) {
        gateway.send(operation.machineId, {
          type: "operation.cancel",
          operationId: operation.id,
        });
      }
      for (const target of termination.targets) {
        gateway.send(target.machineId, {
          type: "session.close",
          sessionId: target.runtimeSessionId,
          reason: "agent_revoked",
        });
      }
    }
    await audit(
      db,
      hierarchy.workspaceId,
      hierarchy.parentAgentId,
      "agent.revoked",
      "agent",
      hierarchy.parentAgentId,
      {
        disabledManagedAgents: hierarchy.agentIds.length - 1,
        terminatedSessions,
      },
    );
    gateway.notifyWorkspace(hierarchy.workspaceId);
    return {
      revoked: true,
      disabledManagedAgents: hierarchy.agentIds.length - 1,
      terminatedSessions,
    };
  },
);

app.post(
  "/v1/agent-policies",
  { preHandler: requireSessionRequester },
  async (request, reply) => {
    const principal = requestAgentCredentialPrincipals.get(request);
    if (!principal) {
      return reply.code(403).send({ error: "agent_credential_required" });
    }
    if (!webUrl) {
      return reply.code(503).send({ error: "policy_approval_unavailable" });
    }
    const parsed = agentPolicyProposalSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", details: parsed.error.issues });
    }
    const approvalCode = createOpaqueToken("policy");
    const policy = await db.proposeAgentPolicy({
      workspaceId: principal.workspaceId,
      id: randomUUID(),
      agentId: principal.agentId,
      humanId: principal.ownerHumanId,
      kind: parsed.data.kind,
      scopes: parsed.data.scopes,
      maxSessionSeconds: parsed.data.maxSessionSeconds,
      ...(parsed.data.maxManagedAgents === undefined
        ? {}
        : { maxManagedAgents: parsed.data.maxManagedAgents }),
      expiresAt: Date.now() + parsed.data.validForSeconds * 1_000,
      approvalCodeHash: hashToken(approvalCode),
    });
    if (!policy) {
      return reply.code(403).send({ error: "policy_scope_denied" });
    }
    await audit(
      db,
      principal.workspaceId,
      principal.agentId,
      "agent_policy.proposed",
      "agent_policy",
      policy.id,
      {
        version: policy.version,
        kind: policy.kind,
        machineIds: policy.scopes.map((scope) => scope.machineId),
        capabilities: policy.scopes.map((scope) => scope.capabilities),
        maxSessionSeconds: policy.maxSessionSeconds,
        ...(policy.maxManagedAgents === undefined
          ? {}
          : { maxManagedAgents: policy.maxManagedAgents }),
        expiresAt: isoTimestamp(policy.expiresAt),
      },
    );
    gateway.notifyWorkspace(principal.workspaceId);
    return reply.code(201).send({
      ...policy,
      expiresAt: isoTimestamp(policy.expiresAt),
      approvalUrl: `${webUrl}/policies/approve?code=${encodeURIComponent(approvalCode)}`,
    });
  },
);

app.get(
  "/v1/agent-policies",
  { preHandler: requireSessionRequester },
  async (request, reply) => {
    const principal = requestAgentCredentialPrincipals.get(request);
    if (!principal) {
      return reply.code(403).send({ error: "agent_credential_required" });
    }
    const policies = await db.listAgentPolicies(
      principal.workspaceId,
      principal.agentId,
    );
    return {
      data: policies.map((policy) => ({
        ...policy,
        expiresAt: isoTimestamp(policy.expiresAt),
      })),
    };
  },
);

for (const transition of ["pause", "revoke"] as const) {
  app.post<{ Params: { policyId: string } }>(
    `/v1/agent-policies/:policyId/${transition}`,
    { preHandler: requireSessionRequester },
    async (request, reply) => {
      const principal = requestAgentCredentialPrincipals.get(request);
      if (!principal) {
        return reply.code(403).send({ error: "agent_credential_required" });
      }
      const policy = await db.transitionAgentPolicy({
        workspaceId: principal.workspaceId,
        policyId: request.params.policyId,
        agentId: principal.agentId,
        status: transition === "pause" ? "paused" : "revoked",
      });
      if (!policy) {
        return reply.code(404).send({ error: "agent_policy_not_found" });
      }
      await audit(
        db,
        principal.workspaceId,
        principal.agentId,
        `agent_policy.${transition}d`,
        "agent_policy",
        policy.id,
        { version: policy.version },
      );
      gateway.notifyWorkspace(principal.workspaceId);
      return {
        ...policy,
        expiresAt: isoTimestamp(policy.expiresAt),
      };
    },
  );
}

app.post(
  "/v1/managed-agents",
  { preHandler: requireSessionRequester },
  async (request, reply) => {
    const principal = requestAgentCredentialPrincipals.get(request);
    if (!principal) {
      return reply.code(403).send({ error: "agent_credential_required" });
    }
    const parsed = managedAgentInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", details: parsed.error.issues });
    }
    const created = await db.createManagedAgent({
      workspaceId: principal.workspaceId,
      id: randomUUID(),
      parentAgentId: principal.agentId,
      ownerHumanId: principal.ownerHumanId,
      name: parsed.data.name,
      scopes: parsed.data.scopes,
      maxSessionSeconds: parsed.data.maxSessionSeconds,
      expiresAt: Date.now() + parsed.data.validForSeconds * 1_000,
      internalApprovalCodeHash: hashToken(createOpaqueToken("policy")),
    });
    if (!created) {
      return reply.code(403).send({ error: "delegation_scope_denied" });
    }
    await audit(
      db,
      principal.workspaceId,
      principal.agentId,
      "managed_agent.created",
      "agent",
      created.agent.id,
      {
        parentAgentId: principal.agentId,
        policyId: created.policy.id,
        policyVersion: created.policy.version,
        machineIds: created.policy.scopes.map((scope) => scope.machineId),
      },
    );
    gateway.notifyWorkspace(principal.workspaceId);
    return reply.code(201).send({
      ...created.agent,
      policy: {
        ...created.policy,
        expiresAt: isoTimestamp(created.policy.expiresAt),
      },
    });
  },
);

app.get(
  "/v1/managed-agents",
  { preHandler: requireSessionRequester },
  async (request, reply) => {
    const principal = requestAgentCredentialPrincipals.get(request);
    if (!principal) {
      return reply.code(403).send({ error: "agent_credential_required" });
    }
    return {
      data: await db.listManagedAgents(
        principal.workspaceId,
        principal.agentId,
      ),
    };
  },
);

for (const transition of ["disable", "delete"] as const) {
  app.route<{ Params: { agentId: string } }>({
    method: transition === "delete" ? "DELETE" : "POST",
    url: `/v1/managed-agents/:agentId${
      transition === "disable" ? "/disable" : ""
    }`,
    preHandler: requireSessionRequester,
    handler: async (request, reply) => {
      const principal = requestAgentCredentialPrincipals.get(request);
      if (!principal) {
        return reply.code(403).send({ error: "agent_credential_required" });
      }
      const result = await db.disableManagedAgent({
        workspaceId: principal.workspaceId,
        managedAgentId: request.params.agentId,
        parentAgentId: principal.agentId,
        deleted: transition === "delete",
      });
      if (!result) {
        return reply.code(404).send({ error: "managed_agent_not_found" });
      }
      let terminatedSessions = 0;
      for (const sessionId of result.sessionIds) {
        const termination = await db.cancelAgentSession({
          workspaceId: principal.workspaceId,
          sessionId,
          agentId: result.agent.id,
          requestedByHumanId: principal.ownerHumanId,
          reason: "revoked",
        });
        if (!termination) continue;
        terminatedSessions += 1;
        for (const operation of termination.operations) {
          gateway.send(operation.machineId, {
            type: "operation.cancel",
            operationId: operation.id,
          });
        }
        for (const target of termination.targets) {
          gateway.send(target.machineId, {
            type: "session.close",
            sessionId: target.runtimeSessionId,
            reason: "policy_revoked",
          });
        }
      }
      await audit(
        db,
        principal.workspaceId,
        principal.agentId,
        `managed_agent.${transition}d`,
        "agent",
        result.agent.id,
        {
          parentAgentId: principal.agentId,
          terminatedSessions,
        },
      );
      gateway.notifyWorkspace(principal.workspaceId);
      return {
        id: result.agent.id,
        status: "disabled",
        deleted: transition === "delete",
        terminatedSessions,
      };
    },
  });
}

app.post("/v1/auth/device", async (request, reply) => {
  if (!webKey || !webUrl) {
    return reply.code(503).send({ error: "cloud_authentication_disabled" });
  }
  if (!deviceStartLimiter.allow(request.ip)) {
    return reply.code(429).send({ error: "device_authorization_rate_limited" });
  }
  const parsed = startDeviceAuthorizationSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
  }
  const deviceCode = createOpaqueToken("device");
  const userCode = createDeviceUserCode();
  const expiresIn = 600;
  await db.createDeviceAuthorization({
    id: randomUUID(),
    deviceCodeHash: hashToken(deviceCode),
    userCodeHash: hashToken(normalizeDeviceUserCode(userCode)),
    clientName: parsed.data.clientName,
    expiresAt: Date.now() + expiresIn * 1_000,
  });
  const verificationUri = `${webUrl}/activate`;
  return reply.code(201).send({
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete: `${verificationUri}?code=${encodeURIComponent(userCode)}`,
    expiresIn,
    interval: 2,
  });
});

app.post("/v1/auth/device/token", async (request, reply) => {
  const parsed = exchangeDeviceAuthorizationSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
  }
  const deviceHash = hashToken(parsed.data.deviceCode);
  if (!devicePollLimiter.allow(deviceHash)) {
    return reply.code(429).send({ error: "slow_down" });
  }
  const accessToken = createOpaqueToken("cli");
  const tokenId = randomUUID();
  const tokenExpiresAt = Date.now() + 30 * 24 * 60 * 60 * 1_000;
  const exchange = await db.exchangeDeviceAuthorization({
    deviceCodeHash: deviceHash,
    tokenId,
    tokenHash: hashToken(accessToken),
    tokenExpiresAt,
  });
  if (exchange.status === "pending") {
    return reply.code(400).send({ error: "authorization_pending" });
  }
  if (exchange.status === "expired") {
    return reply.code(400).send({ error: "expired_token" });
  }
  if (exchange.status === "denied") {
    return reply.code(403).send({ error: "access_denied" });
  }
  if (exchange.status === "consumed") {
    return reply.code(409).send({ error: "device_code_already_used" });
  }
  if (exchange.status === "invalid") {
    return reply.code(401).send({ error: "invalid_device_code" });
  }
  if (exchange.status !== "authorized") {
    throw new Error(`Unhandled device authorization state: ${exchange.status}`);
  }
  await audit(
    db,
    exchange.workspaceId,
    exchange.tokenId,
    "cli.login",
    "cli_token",
    exchange.tokenId,
    { userId: exchange.userId, expiresAt: isoTimestamp(exchange.expiresAt) },
  );
  return {
    accessToken,
    tokenType: "Bearer",
    workspaceId: exchange.workspaceId,
    expiresAt: isoTimestamp(exchange.expiresAt),
  };
});

app.post("/v1/auth/logout", async (request, reply) => {
  const token = bearerTokenFor(request);
  if (!token || !(await db.revokeCliByTokenHash(hashToken(token)))) {
    return reply.code(401).send({ error: "invalid_or_expired_cli_token" });
  }
  return { revoked: true };
});

app.post(
  "/v1/internal/cloud/context",
  { preHandler: requireWeb },
  async (request, reply) => {
    const parsed = cloudIdentitySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
    }
    const context = await db.ensureCloudContext({
      externalId: parsed.data.organization.externalId,
      slug: parsed.data.organization.slug,
      name: parsed.data.organization.name,
    });
    const [
      machines,
      usage,
      connections,
      agents,
      runnableAgentIds,
      sessions,
      sessionRequests,
      policies,
      controlEvents,
      notifications,
    ] = await Promise.all([
      db.listMachines(context.workspace.id),
      db.workspacePlan(context.workspace.id),
      db.workspaceConnections(context.workspace.id),
      db.listWorkspaceAgents(context.workspace.id),
      db.listRunnableAgentIds(context.workspace.id),
      db.listWorkspaceAgentSessions(context.workspace.id),
      db.listWorkspaceAgentSessionRequests(context.workspace.id),
      db.listAgentPolicies(context.workspace.id),
      db.listAudit(context.workspace.id, 50),
      db.listNotifications(context.workspace.id, parsed.data.userId),
    ]);
    const plan = entitlementsFor(context.organization.plan);
    return {
      organization: context.organization,
      workspace: context.workspace,
      plan: {
        id: context.organization.plan,
        ...plan,
        controlEventRetentionDays: Math.round(
          retention.auditMilliseconds / (24 * 60 * 60 * 1_000),
        ),
      },
      usage: {
        machines: usage?.activeMachines ?? machines.length,
        workspaces: 1,
        activeAgents: usage?.activeAgents ?? 0,
      },
      connections: {
        activeConnections: connections.activeConnections,
        connectedAgents: connections.connectedAgents,
        connections: connections.connections.map((connection) =>
          cloudConnectionView(
            connection,
            agents.find((agent) => agent.id === connection.principalId)
              ?.name ?? "CLI",
          ),
        ),
      },
      machines: machines.map((machine) => ({
        id: machine.id,
        name: machine.name,
        status: machine.status,
        runtime: machine.runtime ?? null,
        lastSeenAt: isoTimestamp(machine.lastSeenAt),
        enrolledAt: isoTimestamp(machine.enrolledAt),
        online: gateway.isOnline(machine.id),
        ...clientCompatibility(machine.runtime),
      })),
      agents: agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        kind: agent.kind,
        status: agent.status,
        parentAgentId: agent.parentAgentId ?? null,
        credentialActive: runnableAgentIds.includes(agent.id),
      })),
      notifications: notifications.map((notification) => ({
        ...notification,
        readAt: isoTimestamp(notification.readAt),
        createdAt: isoTimestamp(notification.createdAt),
      })),
      sessions: sessions.map((session) => ({
        id: session.id,
        agentId: session.agentId,
        agentName: session.agentName,
        title: session.title,
        purpose: session.purpose,
        status: session.status,
        expiresAt: isoTimestamp(session.expiresAt),
        readyAt: isoTimestamp(session.readyAt),
        createdAt: isoTimestamp(session.createdAt),
        requestedByHumanId: session.requestedByHumanId,
        requestedByAgentId: session.requestedByAgentId ?? null,
        runId: session.runId ?? null,
        scopes: session.scopes,
        targets: session.targets,
      })),
      sessionRequests: sessionRequests.map((sessionRequest) => ({
        id: sessionRequest.id,
        agentId: sessionRequest.agentId,
        agentName: sessionRequest.agentName,
        title: sessionRequest.title,
        purpose: sessionRequest.purpose,
        durationSeconds: sessionRequest.durationSeconds,
        status: sessionRequest.status,
        expiresAt: isoTimestamp(sessionRequest.expiresAt),
        createdAt: isoTimestamp(sessionRequest.createdAt),
        requestedByHumanId: sessionRequest.requestedByHumanId,
        requestedByAgentId: sessionRequest.requestedByAgentId ?? null,
        runId: sessionRequest.runId ?? null,
        machines: sessionRequest.machines,
        ...(sessionRequest.status === "pending" && webUrl
          ? { approvalUrl: sessionApprovalUrl(webUrl, sessionRequest.id) }
          : {}),
      })),
      policies: policies.map((policy) => ({
        ...policy,
        expiresAt: isoTimestamp(policy.expiresAt),
        approvedAt: isoTimestamp(policy.approvedAt),
        createdAt: isoTimestamp(policy.createdAt),
        updatedAt: isoTimestamp(policy.updatedAt),
      })),
      controlEvents: controlEvents.map(controlEventView),
    };
  },
);

app.post(
  "/v1/internal/cloud/sessions/list",
  { preHandler: requireWeb },
  async (request, reply) => {
    const parsed = cloudIdentitySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const context = await db.ensureCloudContext({
      externalId: parsed.data.organization.externalId,
      slug: parsed.data.organization.slug,
      name: parsed.data.organization.name,
    });
    const sessions = await db.listWorkspaceAgentSessions(context.workspace.id);
    return {
      data: sessions.map((session) => ({
        ...session,
        expiresAt: isoTimestamp(session.expiresAt),
        readyAt: isoTimestamp(session.readyAt),
        createdAt: isoTimestamp(session.createdAt),
        updatedAt: isoTimestamp(session.updatedAt),
      })),
    };
  },
);

app.post(
  "/v1/internal/cloud/sessions/create",
  { preHandler: requireWeb },
  async (request, reply) => {
    const parsed = cloudManualSessionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const context = await db.ensureCloudContext({
      externalId: parsed.data.organization.externalId,
      slug: parsed.data.organization.slug,
      name: parsed.data.organization.name,
    });
    const [agent, runnableAgentIds] = await Promise.all([
      db.getAgentIdentity(context.workspace.id, parsed.data.agentId),
      db.listRunnableAgentIds(context.workspace.id),
    ]);
    if (!agent || agent.status !== "active" || !runnableAgentIds.includes(agent.id)) {
      return reply.code(409).send({ error: "agent_credential_unavailable" });
    }
    const requestId = randomUUID();
    const approvalCodeHash = hashToken(requestId);
    const created = await db.createAgentSessionRequest({
      workspaceId: context.workspace.id,
      requestId,
      agentId: agent.id,
      agentName: agent.name,
      humanId: parsed.data.userId,
      scopes: parsed.data.scopes,
      title: parsed.data.title,
      ...(parsed.data.purpose ? { purpose: parsed.data.purpose } : {}),
      durationSeconds: parsed.data.durationSeconds,
      approvalCodeHash,
      expiresAt: Date.now() + 10 * 60_000,
      allowWorkspaceAgent: true,
      notifyRequester: false,
    });
    if (!created) return reply.code(403).send({ error: "session_scope_denied" });
    if (created.status === "pending") {
      const approved = await db.approveAgentSessionRequest({
        workspaceId: context.workspace.id,
        approvalCodeHash,
        approverHumanId: parsed.data.userId,
        now: Date.now(),
      });
      if (approved.status !== "approved") {
        return reply.code(409).send({ error: `session_${approved.status}` });
      }
    }

    const installation = await db.activeMcpInstallationForAgent(
      context.workspace.id,
      agent.id,
    );
    if (!installation) {
      gateway.notifyWorkspace(context.workspace.id);
      return reply.code(201).send({ requestId, status: "approved" });
    }
    const claimed = await db.claimAgentSessionRequest({
      workspaceId: context.workspace.id,
      requestId,
      agentId: agent.id,
      humanId: installation.userId,
      sessionId: randomUUID(),
      authority: { kind: "mcp", installationId: installation.id },
      now: Date.now(),
    });
    if (claimed.status !== "claimed") {
      return reply.code(409).send({ error: `session_${claimed.status}` });
    }
    for (const target of claimed.targets) {
      const sent = gateway.send(target.machineId, {
        type: "session.open",
        sessionId: target.runtimeSessionId,
        profile: target.scope.profile,
        capabilities: target.scope.capabilities,
        restrictions: target.scope.restrictions,
        expiresAt: new Date(claimed.session.expiresAt).toISOString(),
        serverTime: new Date().toISOString(),
      });
      if (!sent) {
        await db.markSessionOpenFailed(
          target.machineId,
          target.runtimeSessionId,
          "machine_disconnected",
        );
      }
    }
    gateway.notifyWorkspace(context.workspace.id);
    return reply.code(201).send({
      requestId,
      sessionId: claimed.session.id,
      status: "opening",
    });
  },
);

app.post(
  "/v1/internal/cloud/notifications/read",
  { preHandler: requireWeb },
  async (request, reply) => {
    const parsed = cloudNotificationSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const context = await db.ensureCloudContext({
      externalId: parsed.data.organization.externalId,
      slug: parsed.data.organization.slug,
      name: parsed.data.organization.name,
    });
    const marked = await db.markNotificationRead(
      context.workspace.id,
      parsed.data.userId,
      parsed.data.notificationId,
      parsed.data.read,
    );
    if (!marked) return reply.code(404).send({ error: "notification_not_found" });
    gateway.notifyWorkspace(context.workspace.id);
    return { read: parsed.data.read };
  },
);

app.post(
  "/v1/internal/cloud/notifications/read-all",
  { preHandler: requireWeb },
  async (request, reply) => {
    const parsed = cloudIdentitySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const context = await db.ensureCloudContext({
      externalId: parsed.data.organization.externalId,
      slug: parsed.data.organization.slug,
      name: parsed.data.organization.name,
    });
    const marked = await db.markAllNotificationsRead(
      context.workspace.id,
      parsed.data.userId,
    );
    gateway.notifyWorkspace(context.workspace.id);
    return { read: true, marked };
  },
);

app.post(
  "/v1/internal/cloud/sessions/inspect",
  { preHandler: requireWeb },
  async (request, reply) => {
    const parsed = cloudSessionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const context = await db.ensureCloudContext({
      externalId: parsed.data.organization.externalId,
      slug: parsed.data.organization.slug,
      name: parsed.data.organization.name,
    });
    const [session, timeline] = await Promise.all([
      db.workspaceAgentSession(context.workspace.id, parsed.data.sessionId),
      db.workspaceSessionTimeline(context.workspace.id, parsed.data.sessionId),
    ]);
    if (!session || !timeline) {
      return reply.code(404).send({ error: "session_not_found" });
    }
    return {
      session: {
        ...session,
        expiresAt: isoTimestamp(session.expiresAt),
        createdAt: isoTimestamp(session.createdAt),
        updatedAt: isoTimestamp(session.updatedAt),
      },
      timeline: timeline.map((event) => ({
        ...event,
        metadata: privacyMinimalTimelineMetadata(event.metadata),
        createdAt: isoTimestamp(event.createdAt),
      })),
    };
  },
);

app.post(
  "/v1/internal/cloud/sessions/export",
  { preHandler: requireWeb },
  async (request, reply) => {
    const parsed = cloudIdentitySchema
      .extend({
        sessionId: z.string().uuid(),
        detailLevel: z.enum(eventSinkDetailLevels).default("privacy-minimal"),
      })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const context = await db.ensureCloudContext({
      externalId: parsed.data.organization.externalId,
      slug: parsed.data.organization.slug,
      name: parsed.data.organization.name,
    });
    const events = await db.workspaceSessionTimeline(
      context.workspace.id,
      parsed.data.sessionId,
    );
    if (!events) return reply.code(404).send({ error: "session_not_found" });
    return await timelineExport(
      context.workspace.id,
      parsed.data.sessionId,
      events,
      parsed.data.detailLevel,
    );
  },
);

app.post(
  "/v1/internal/cloud/event-sink",
  { preHandler: requireWeb },
  async (request, reply) => {
    const parsed = cloudIdentitySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const context = await db.ensureCloudContext({
      externalId: parsed.data.organization.externalId,
      slug: parsed.data.organization.slug,
      name: parsed.data.organization.name,
    });
    const sink = await db.workspaceEventSink(context.workspace.id);
    return {
      data: sink ? eventSinkView(sink) : null,
      deliveries: await db.eventSinkDeliveryStatus(context.workspace.id, 20),
    };
  },
);

app.post(
  "/v1/internal/cloud/event-sink/configure",
  { preHandler: requireWeb },
  async (request, reply) => {
    const parsed = cloudIdentitySchema
      .extend(eventSinkConfigurationSchema.shape)
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    if (!eventSinkEncryptionKey) {
      return reply
        .code(503)
        .send({ error: "event_sink_encryption_unavailable" });
    }
    try {
      await eventSinkDestination(parsed.data.endpoint);
      const context = await db.ensureCloudContext({
        externalId: parsed.data.organization.externalId,
        slug: parsed.data.organization.slug,
        name: parsed.data.organization.name,
      });
      const sink = await db.upsertWorkspaceEventSink({
        workspaceId: context.workspace.id,
        endpoint: parsed.data.endpoint,
        detailLevel: parsed.data.detailLevel,
        secretCiphertext: encryptEventSinkSecret(
          parsed.data.signingSecret,
          eventSinkEncryptionKey,
        ),
        secretLastFour: parsed.data.signingSecret.slice(-4),
      });
      await audit(
        db,
        context.workspace.id,
        parsed.data.userId,
        "event_sink.configured",
        "event_sink",
        sink.id,
        { detailLevel: sink.detailLevel },
      );
      return { data: eventSinkView(sink) };
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "event_sink_destination_denied"
      ) {
        return reply.code(400).send({ error: error.code });
      }
      throw error;
    }
  },
);

app.post(
  "/v1/internal/cloud/event-sink/delete",
  { preHandler: requireWeb },
  async (request, reply) => {
    const parsed = cloudIdentitySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const context = await db.ensureCloudContext({
      externalId: parsed.data.organization.externalId,
      slug: parsed.data.organization.slug,
      name: parsed.data.organization.name,
    });
    const sink = await db.workspaceEventSink(context.workspace.id);
    if (!sink) return reply.code(404).send({ error: "event_sink_not_found" });
    await db.deleteWorkspaceEventSink(context.workspace.id);
    await audit(
      db,
      context.workspace.id,
      parsed.data.userId,
      "event_sink.deleted",
      "event_sink",
      sink.id,
    );
    return { deleted: true };
  },
);

app.post(
  "/v1/internal/cloud/sessions/cancel",
  { preHandler: requireWeb },
  async (request, reply) => {
    const parsed = cloudSessionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const context = await db.ensureCloudContext({
      externalId: parsed.data.organization.externalId,
      slug: parsed.data.organization.slug,
      name: parsed.data.organization.name,
    });
    const session = await db.workspaceAgentSession(
      context.workspace.id,
      parsed.data.sessionId,
    );
    if (!session) {
      return reply.code(404).send({ error: "session_not_found" });
    }
    const result = await db.cancelAgentSession({
      workspaceId: context.workspace.id,
      sessionId: session.id,
      agentId: session.agentId,
      requestedByHumanId: parsed.data.userId,
      reason: "cancelled",
      now: Date.now(),
    });
    if (!result) {
      return reply.code(403).send({ error: "session_cancel_denied" });
    }
    for (const operation of result.operations) {
      gateway.send(operation.machineId, {
        type: "operation.cancel",
        operationId: operation.id,
      });
    }
    for (const target of result.targets) {
      gateway.send(target.machineId, {
        type: "session.close",
        sessionId: target.runtimeSessionId,
        reason: "workspace_member_cancelled",
      });
    }
    gateway.notifyWorkspace(context.workspace.id);
    return { id: result.id, status: result.status, transitioned: result.transitioned };
  },
);

app.post(
  "/v1/internal/cloud/live-token",
  { preHandler: requireWeb },
  async (request, reply) => {
    const parsed = cloudIdentitySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
    }
    if (!webKey || !webUrl) {
      return reply.code(503).send({ error: "cloud_authentication_disabled" });
    }
    const context = await db.ensureCloudContext({
      externalId: parsed.data.organization.externalId,
      slug: parsed.data.organization.slug,
      name: parsed.data.organization.name,
    });
    if (
      !liveTokenIssuanceLimiter.allow(
        context.workspace.id,
        parsed.data.userId,
      )
    ) {
      return reply.code(429).send({ error: "live_token_rate_limited" });
    }
    const now = Date.now();
    const expiresAt = now + 60_000;
    return {
      token: createCloudLiveToken(
        webKey,
        {
          workspaceId: context.workspace.id,
          userId: parsed.data.userId,
        },
        now,
        60_000,
      ),
      expiresAt: new Date(expiresAt).toISOString(),
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
  const claims =
    typeof request.body === "string"
      ? verifyCloudLiveToken(webKey, request.body)
      : null;
  if (!claims) {
    return reply.code(401).send({ error: "invalid_or_expired_live_token" });
  }
  if (!liveTokenReplayGuard.consume(request.body, claims.expiresAt)) {
    return reply.code(401).send({ error: "live_token_replayed" });
  }
  if (!liveStreamLimiter.acquire(claims.workspaceId, claims.userId)) {
    return reply.code(429).send({ error: "live_stream_limit_reached" });
  }

  const eventName = `workspace:${claims.workspaceId}`;
  const emitRefresh = (): void => {
    reply.raw.write(`event: refresh\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
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
    liveStreamLimiter.release(claims.workspaceId, claims.userId);
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
    heartbeat = setInterval(
      () => reply.raw.write(": heartbeat\n\n"),
      15_000,
    );
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

app.post(
  "/v1/internal/cloud/device/approve",
  { preHandler: requireWeb },
  async (request, reply) => {
    const parsed = approveDeviceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
    }
    const context = await db.ensureCloudContext({
      externalId: parsed.data.organization.externalId,
      slug: parsed.data.organization.slug,
      name: parsed.data.organization.name,
    });
    const result = await db.approveDeviceAuthorization({
      userCodeHash: hashToken(normalizeDeviceUserCode(parsed.data.userCode)),
      userId: parsed.data.userId,
      workspaceId: context.workspace.id,
    });
    if (result === "invalid") return reply.code(404).send({ error: "device_code_not_found" });
    if (result === "expired") return reply.code(410).send({ error: "device_code_expired" });
    if (result === "already_used") {
      return reply.code(409).send({ error: "device_code_already_used" });
    }
    await audit(
      db,
      context.workspace.id,
      parsed.data.userId,
      "cli.login_approved",
      "workspace",
      context.workspace.id,
    );
    gateway.notifyWorkspace(context.workspace.id);
    return { approved: true, workspace: context.workspace };
  },
);

app.post(
  "/v1/internal/cloud/agent-device/inspect",
  { preHandler: requireWeb },
  async (request, reply) => {
    const parsed = cloudAgentDeviceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    await db.ensureCloudContext({
      externalId: parsed.data.organization.externalId,
      slug: parsed.data.organization.slug,
      name: parsed.data.organization.name,
    });
    const result = await db.inspectAgentDeviceAuthorization(
      hashToken(normalizeDeviceUserCode(parsed.data.userCode)),
    );
    if (result.status === "invalid") {
      return reply.code(404).send({ error: "device_code_not_found" });
    }
    if (result.status === "expired") {
      return reply.code(410).send({ error: "device_code_expired" });
    }
    if (result.status === "already_used") {
      return reply.code(409).send({ error: "device_code_already_used" });
    }
    if (result.status !== "pending") {
      throw new Error(`Unhandled Agent approval state: ${result.status}`);
    }
    return {
      agentName: result.agentName,
      expiresAt: isoTimestamp(result.expiresAt),
    };
  },
);

app.post(
  "/v1/internal/cloud/agent-device/approve",
  { preHandler: requireWeb },
  async (request, reply) => {
    const parsed = cloudAgentDeviceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const context = await db.ensureCloudContext({
      externalId: parsed.data.organization.externalId,
      slug: parsed.data.organization.slug,
      name: parsed.data.organization.name,
    });
    const agentId = randomUUID();
    const result = await db.approveAgentDeviceAuthorization({
      userCodeHash: hashToken(
        normalizeDeviceUserCode(parsed.data.userCode),
      ),
      userId: parsed.data.userId,
      workspaceId: context.workspace.id,
      agentId,
    });
    if (result === "invalid") {
      return reply.code(404).send({ error: "device_code_not_found" });
    }
    if (result === "expired") {
      return reply.code(410).send({ error: "device_code_expired" });
    }
    if (result === "already_used") {
      return reply.code(409).send({ error: "device_code_already_used" });
    }
    await audit(
      db,
      context.workspace.id,
      parsed.data.userId,
      "agent.registered",
      "agent",
      agentId,
    );
    gateway.notifyWorkspace(context.workspace.id);
    return { approved: true, agentId };
  },
);

app.post(
  "/v1/internal/cloud/agent-policies/inspect",
  { preHandler: requireWeb },
  async (request, reply) => {
    const parsed = cloudAgentPolicySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", details: parsed.error.issues });
    }
    const context = await db.ensureCloudContext({
      externalId: parsed.data.organization.externalId,
      slug: parsed.data.organization.slug,
      name: parsed.data.organization.name,
    });
    const policy = await db.agentPolicyForApproval(
      context.workspace.id,
      hashToken(parsed.data.approvalCode),
    );
    if (!policy) {
      return reply.code(404).send({ error: "agent_policy_not_found" });
    }
    if (policy.expiresAt <= Date.now()) {
      return reply.code(410).send({ error: "agent_policy_expired" });
    }
    if (policy.status !== "proposed") {
      return reply.code(409).send({ error: "agent_policy_already_used" });
    }
    return {
      id: policy.id,
      version: policy.version,
      kind: policy.kind,
      agent: { id: policy.agentId, name: policy.agentName },
      scopes: policy.scopes.map((scope) => ({
        ...scope,
        machine: {
          id: scope.machineId,
          name:
            policy.machines.find((machine) => machine.id === scope.machineId)
              ?.name ?? scope.machineId,
        },
      })),
      maxSessionSeconds: policy.maxSessionSeconds,
      maxManagedAgents: policy.maxManagedAgents ?? null,
      expiresAt: isoTimestamp(policy.expiresAt),
    };
  },
);

app.post(
  "/v1/internal/cloud/agent-policies/approve",
  { preHandler: requireWeb },
  async (request, reply) => {
    const parsed = cloudAgentPolicySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", details: parsed.error.issues });
    }
    const context = await db.ensureCloudContext({
      externalId: parsed.data.organization.externalId,
      slug: parsed.data.organization.slug,
      name: parsed.data.organization.name,
    });
    const result = await db.approveAgentPolicy({
      workspaceId: context.workspace.id,
      approvalCodeHash: hashToken(parsed.data.approvalCode),
      approverHumanId: parsed.data.userId,
      now: Date.now(),
    });
    if (result.status === "invalid") {
      return reply.code(404).send({ error: "agent_policy_not_found" });
    }
    if (result.status === "expired") {
      return reply.code(410).send({ error: "agent_policy_expired" });
    }
    if (result.status === "already_used") {
      return reply.code(409).send({ error: "agent_policy_already_used" });
    }
    if (result.status !== "approved") {
      throw new Error(`Unhandled Agent policy state: ${result.status}`);
    }
    await audit(
      db,
      context.workspace.id,
      parsed.data.userId,
      "agent_policy.approved",
      "agent_policy",
      result.policy.id,
      { version: result.policy.version },
    );
    gateway.notifyWorkspace(context.workspace.id);
    return {
      approved: true,
      policyId: result.policy.id,
      version: result.policy.version,
    };
  },
);

app.post(
  "/v1/internal/cloud/session-requests/inspect",
  { preHandler: requireWeb },
  async (request, reply) => {
    const parsed = sessionApprovalSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", details: parsed.error.issues });
    }
    const context = await db.ensureCloudContext({
      externalId: parsed.data.organization.externalId,
      slug: parsed.data.organization.slug,
      name: parsed.data.organization.name,
    });
    const sessionRequest = await db.sessionRequestForApproval(
      context.workspace.id,
      hashToken(parsed.data.requestId),
    );
    if (!sessionRequest) {
      return reply.code(404).send({ error: "session_request_not_found" });
    }
    if (sessionRequest.expiresAt <= Date.now()) {
      return reply.code(410).send({ error: "session_request_expired" });
    }
    if (sessionRequest.status !== "pending") {
      return reply
        .code(409)
        .send({ error: "session_request_already_used" });
    }
    return {
      id: sessionRequest.id,
      agent: { id: sessionRequest.agentId, name: sessionRequest.agentName },
      purpose: sessionRequest.purpose,
      predecessorSessionId: sessionRequest.predecessorSessionId ?? null,
      scopes: sessionRequest.scopes.map((scope) => {
        const machine = sessionRequest.machines.find(
          (candidate) => candidate.id === scope.machineId,
        );
        return {
          ...scope,
          machine: {
            id: scope.machineId,
            name: machine?.name ?? scope.machineId,
          },
          readiness: gateway.isOnline(scope.machineId)
            ? { ready: true }
            : { ready: false, reason: "machine_offline" },
        };
      }),
      durationSeconds: sessionRequest.durationSeconds,
      status: sessionRequest.status,
      expiresAt: isoTimestamp(sessionRequest.expiresAt),
    };
  },
);

app.post(
  "/v1/internal/cloud/session-requests/approve",
  { preHandler: requireWeb },
  async (request, reply) => {
    const parsed = sessionApprovalSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", details: parsed.error.issues });
    }
    const context = await db.ensureCloudContext({
      externalId: parsed.data.organization.externalId,
      slug: parsed.data.organization.slug,
      name: parsed.data.organization.name,
    });
    const result = await db.approveAgentSessionRequest({
      workspaceId: context.workspace.id,
      approvalCodeHash: hashToken(parsed.data.requestId),
      approverHumanId: parsed.data.userId,
      now: Date.now(),
    });
    if (result.status === "invalid") {
      return reply.code(404).send({ error: "session_request_not_found" });
    }
    if (result.status === "expired") {
      return reply.code(410).send({ error: "session_request_expired" });
    }
    if (result.status === "already_used") {
      return reply.code(409).send({ error: "session_request_already_used" });
    }
    if (result.status !== "approved") {
      return reply.code(500).send({ error: "session_approval_failed" });
    }
    await audit(
      db,
      context.workspace.id,
      parsed.data.userId,
      "session_request.approved",
      "session_request",
      result.request.id,
    );
    gateway.notifyWorkspace(context.workspace.id);
    return { approved: true, requestId: result.request.id };
  },
);

app.post(
  "/v1/internal/cloud/session-requests/deny",
  { preHandler: requireWeb },
  async (request, reply) => {
    const parsed = sessionApprovalSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", details: parsed.error.issues });
    }
    const context = await db.ensureCloudContext({
      externalId: parsed.data.organization.externalId,
      slug: parsed.data.organization.slug,
      name: parsed.data.organization.name,
    });
    const result = await db.denyAgentSessionRequest({
      workspaceId: context.workspace.id,
      approvalCodeHash: hashToken(parsed.data.requestId),
      denierHumanId: parsed.data.userId,
      now: Date.now(),
    });
    if (result.status === "invalid") {
      return reply.code(404).send({ error: "session_request_not_found" });
    }
    if (result.status === "expired") {
      return reply.code(410).send({ error: "session_request_expired" });
    }
    if (result.status === "already_used") {
      return reply.code(409).send({ error: "session_request_already_used" });
    }
    if (result.status !== "denied") {
      return reply.code(500).send({ error: "session_denial_failed" });
    }
    await audit(
      db,
      context.workspace.id,
      parsed.data.userId,
      "session_request.denied",
      "session_request",
      result.request.id,
    );
    gateway.notifyWorkspace(context.workspace.id);
    return { denied: true, requestId: result.request.id };
  },
);

app.post(
  "/v1/internal/cloud/enrollment-token",
  { preHandler: requireWeb },
  async (request, reply) => {
    const parsed = cloudIdentitySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
    }
    const context = await db.ensureCloudContext({
      externalId: parsed.data.organization.externalId,
      slug: parsed.data.organization.slug,
      name: parsed.data.organization.name,
    });
    if (
      !enrollmentIssuanceLimiter.allow(
        context.workspace.id,
        parsed.data.userId,
      )
    ) {
      return reply
        .code(429)
        .send({ error: "enrollment_issuance_rate_limited" });
    }
    const usage = await db.workspacePlan(context.workspace.id);
    const entitlement = entitlementsFor(context.organization.plan);
    if (usage?.cloudManaged && usage.activeMachines >= entitlement.machineLimit) {
      return reply.code(409).send({
        error: "machine_limit_reached",
        details: { machineLimit: entitlement.machineLimit, plan: context.organization.plan },
      });
    }
    const token = createOpaqueToken("enroll");
    const expiresAt = Date.now() + 10 * 60 * 1_000;
    await db.createEnrollmentToken(
      context.workspace.id,
      hashToken(token),
      expiresAt,
      parsed.data.userId,
    );
    await audit(
      db,
      context.workspace.id,
      parsed.data.userId,
      "enrollment_token.created",
      "enrollment_token",
      hashToken(token),
    );
    gateway.notifyWorkspace(context.workspace.id);
    return reply.code(201).send({ token, expiresAt: isoTimestamp(expiresAt) });
  },
);

app.post(
  "/v1/internal/cloud/agent-access",
  { preHandler: requireWeb },
  async (_request, reply) =>
    reply.code(410).send({
      error: "legacy_agent_access_migrated",
      replacement: "agent_device_authorization",
    }),
);

app.post(
  "/v1/internal/cloud/agent-access/revoke",
  { preHandler: requireWeb },
  async (_request, reply) =>
    reply.code(410).send({
      error: "legacy_agent_access_migrated",
      replacement: "agent_credentials",
    }),
);

app.post(
  "/v1/internal/cloud/agent-access/delete",
  { preHandler: requireWeb },
  async (_request, reply) =>
    reply.code(410).send({
      error: "legacy_agent_access_migrated",
      replacement: "agents",
    }),
);

app.post(
  "/v1/internal/cloud/machines/revoke",
  { preHandler: requireWeb },
  async (request, reply) => {
    const parsed = revokeCloudMachineSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
    }
    const context = await db.ensureCloudContext({
      externalId: parsed.data.organization.externalId,
      slug: parsed.data.organization.slug,
      name: parsed.data.organization.name,
    });
    const result = await revokeWorkspaceMachine(
      context.workspace.id,
      parsed.data.userId,
      parsed.data.machineId,
    );
    if (!result) return reply.code(404).send({ error: "active_machine_not_found" });
    return result;
  },
);

app.post(
  "/v1/internal/cloud/agents/delete",
  { preHandler: requireWeb },
  async (request, reply) => {
    const parsed = deleteCloudAgentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
    }
    const context = await db.ensureCloudContext({
      externalId: parsed.data.organization.externalId,
      slug: parsed.data.organization.slug,
      name: parsed.data.organization.name,
    });
    const result = await deleteWorkspaceAgent(
      context.workspace.id,
      parsed.data.userId,
      parsed.data.agentId,
      parsed.data.userId,
    );
    if (!result) return reply.code(404).send({ error: "agent_not_found" });
    return { deleted: true, ...result };
  },
);

app.post(
  "/v1/internal/cloud/machines/ping",
  { preHandler: requireWeb },
  async (request, reply) => {
    const parsed = revokeCloudMachineSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
    }
    const context = await db.ensureCloudContext({
      externalId: parsed.data.organization.externalId,
      slug: parsed.data.organization.slug,
      name: parsed.data.organization.name,
    });
    if (
      !cloudPingLimiter.allow(context.workspace.id, parsed.data.userId) ||
      !machinePingLimiter.allow(
        `${context.workspace.id}:${parsed.data.machineId}`,
      )
    ) {
      return reply.code(429).send({ error: "machine_ping_rate_limited" });
    }
    if (
      !(await db.activeMachinesExist(context.workspace.id, [
        parsed.data.machineId,
      ]))
    ) {
      return reply.code(404).send({ error: "active_machine_not_found" });
    }
    if (!gateway.isOnline(parsed.data.machineId)) {
      return reply.code(409).send({ error: "machine_offline" });
    }
    if (
      !pingConcurrencyLimiter.acquire(
        context.workspace.id,
        parsed.data.userId,
      )
    ) {
      return reply.code(429).send({ error: "machine_ping_limit_reached" });
    }
    try {
      const latencyMs = await gateway.ping(parsed.data.machineId);
      await audit(
        db,
        context.workspace.id,
        parsed.data.userId,
        "machine.ping",
        "machine",
        parsed.data.machineId,
      );
      gateway.notifyWorkspace(context.workspace.id);
      return {
        reply: "pong",
        machineId: parsed.data.machineId,
        latencyMs,
      };
    } catch {
      return reply.code(504).send({ error: "machine_ping_timeout" });
    } finally {
      pingConcurrencyLimiter.release(
        context.workspace.id,
        parsed.data.userId,
      );
    }
  },
);

app.get("/v1/admin/organizations", { preHandler: requireAdmin }, async () => ({
  data: (await db.listOrganizations()).map((organization) => ({
    ...organization,
    createdAt: isoTimestamp(organization.createdAt),
  })),
}));

app.post(
  "/v1/admin/organizations",
  { preHandler: requireAdmin },
  async (request, reply) => {
    const parsed = organizationRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid_request",
        details: parsed.error.issues,
      });
    }
    try {
      const organization = await db.createOrganization({
        id: randomUUID(),
        ...parsed.data,
      });
      return reply.code(201).send({
        ...organization,
        createdAt: isoTimestamp(organization.createdAt),
      });
    } catch (error) {
      if (isUniqueConflict(error)) {
        return reply.code(409).send({ error: "organization_slug_exists" });
      }
      throw error;
    }
  },
);

app.get("/v1/admin/workspaces", { preHandler: requireAdmin }, async () => ({
  data: (await db.listWorkspaces()).map((workspace) => ({
    ...workspace,
    createdAt: isoTimestamp(workspace.createdAt),
  })),
}));

app.get<{ Params: { organizationId: string } }>(
  "/v1/admin/organizations/:organizationId/workspaces",
  { preHandler: requireAdmin },
  async (request) => ({
    data: (await db.listWorkspaces(request.params.organizationId)).map((workspace) => ({
      ...workspace,
      createdAt: isoTimestamp(workspace.createdAt),
    })),
  }),
);

app.post<{ Params: { organizationId: string } }>(
  "/v1/admin/organizations/:organizationId/workspaces",
  { preHandler: requireAdmin },
  async (request, reply) => {
    const parsed = workspaceRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid_request",
        details: parsed.error.issues,
      });
    }
    try {
      const workspace = await db.createWorkspace({
        id: randomUUID(),
        organizationId: request.params.organizationId,
        ...parsed.data,
      });
      if (!workspace) {
        return reply.code(404).send({ error: "organization_not_found" });
      }
      return reply.code(201).send({
        ...workspace,
        createdAt: isoTimestamp(workspace.createdAt),
      });
    } catch (error) {
      if (isUniqueConflict(error)) {
        return reply.code(409).send({ error: "workspace_slug_exists" });
      }
      throw error;
    }
  },
);

app.post(
  "/v1/admin/enrollment-tokens",
  { preHandler: requireWorkspaceAccess },
  async (request, reply) => {
    const workspaceId = adminWorkspaceFor(request);
    const usage = await db.workspacePlan(workspaceId);
    if (usage?.cloudManaged) {
      const entitlement = entitlementsFor(usage.plan);
      if (usage.activeMachines >= entitlement.machineLimit) {
        return reply.code(409).send({
          error: "machine_limit_reached",
          details: { machineLimit: entitlement.machineLimit, plan: usage.plan },
        });
      }
    }
    const body = (request.body ?? {}) as { expiresInSeconds?: number };
    const expiresInSeconds = Math.min(Math.max(body.expiresInSeconds ?? 600, 60), 86_400);
    const token = createOpaqueToken("enroll");
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
    await db.createEnrollmentToken(
      workspaceId,
      hashToken(token),
      expiresAt.getTime(),
      adminPrincipalFor(request),
    );
    await audit(
      db,
      workspaceId,
      adminPrincipalFor(request),
      "enrollment_token.created",
      "enrollment_token",
      hashToken(token),
    );
    return reply.code(201).send({ token, expiresAt: expiresAt.toISOString() });
  },
);

app.get(
  "/v1/admin/agent-tokens",
  { preHandler: requireWorkspaceAccess },
  async (_request, reply) =>
    reply.code(410).send({
      error: "legacy_agent_access_migrated",
      replacement: "agents",
    }),
);

app.get(
  "/v1/admin/agents",
  { preHandler: requireWorkspaceAccess },
  async (request) => ({
    data: (await db.listWorkspaceAgents(adminWorkspaceFor(request))).map(
      (agent) => ({
        id: agent.id,
        name: agent.name,
        kind: agent.kind,
        status: agent.status,
        parentAgentId: agent.parentAgentId ?? null,
      }),
    ),
  }),
);

app.get(
  "/v1/admin/machines",
  { preHandler: requireWorkspaceAccess },
  async (request) => {
    const machines = await db.listMachines(adminWorkspaceFor(request), {
      includeRevoked: true,
    });
    return {
      data: machines.map((machine) => ({
        id: machine.id,
        name: machine.name,
        status: machine.status,
        runtime: machine.runtime ?? null,
        lastSeenAt: isoTimestamp(machine.lastSeenAt),
        enrolledAt: isoTimestamp(machine.enrolledAt),
        revokedAt: isoTimestamp(machine.revokedAt),
        online: machine.revokedAt === undefined && gateway.isOnline(machine.id),
        ...clientCompatibility(machine.runtime),
      })),
    };
  },
);

app.get(
  "/v1/admin/event-sink",
  { preHandler: requireWorkspaceAccess },
  async (request) => {
    const sink = await db.workspaceEventSink(adminWorkspaceFor(request));
    return { data: sink ? eventSinkView(sink) : null };
  },
);

app.put(
  "/v1/admin/event-sink",
  { preHandler: [requireAdmin, requireAdminWorkspace] },
  async (request, reply) => {
    const parsed = eventSinkConfigurationSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    if (!eventSinkEncryptionKey) {
      return reply
        .code(503)
        .send({ error: "event_sink_encryption_unavailable" });
    }
    try {
      await eventSinkDestination(parsed.data.endpoint);
      const sink = await db.upsertWorkspaceEventSink({
        workspaceId: adminWorkspaceFor(request),
        endpoint: parsed.data.endpoint,
        detailLevel: parsed.data.detailLevel,
        secretCiphertext: encryptEventSinkSecret(
          parsed.data.signingSecret,
          eventSinkEncryptionKey,
        ),
        secretLastFour: parsed.data.signingSecret.slice(-4),
      });
      await audit(
        db,
        adminWorkspaceFor(request),
        adminPrincipalFor(request),
        "event_sink.configured",
        "event_sink",
        sink.id,
        { detailLevel: sink.detailLevel },
      );
      return { data: eventSinkView(sink) };
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "event_sink_destination_denied"
      ) {
        return reply.code(400).send({ error: error.code });
      }
      throw error;
    }
  },
);

app.delete(
  "/v1/admin/event-sink",
  { preHandler: [requireAdmin, requireAdminWorkspace] },
  async (request, reply) => {
    const workspaceId = adminWorkspaceFor(request);
    const sink = await db.workspaceEventSink(workspaceId);
    if (!sink) return reply.code(404).send({ error: "event_sink_not_found" });
    await db.deleteWorkspaceEventSink(workspaceId);
    await audit(
      db,
      workspaceId,
      adminPrincipalFor(request),
      "event_sink.deleted",
      "event_sink",
      sink.id,
    );
    return { deleted: true };
  },
);

app.get(
  "/v1/admin/event-sink/deliveries",
  { preHandler: requireWorkspaceAccess },
  async (request) => ({
    data: (await db.eventSinkDeliveryStatus(adminWorkspaceFor(request))).map(
      (delivery) => ({
        ...delivery,
        nextAttemptAt: isoTimestamp(delivery.nextAttemptAt),
        ...(delivery.deliveredAt === undefined
          ? {}
          : { deliveredAt: isoTimestamp(delivery.deliveredAt) }),
      }),
    ),
  }),
);

app.get<{
  Params: { sessionId: string };
  Querystring: { detailLevel?: string };
}>(
  "/v1/admin/sessions/:sessionId/timeline/export",
  { preHandler: requireWorkspaceAccess },
  async (request, reply) => {
    const detail = z.enum(eventSinkDetailLevels).safeParse(
      request.query.detailLevel ?? "privacy-minimal",
    );
    if (!detail.success) {
      return reply.code(400).send({ error: "invalid_detail_level" });
    }
    const workspaceId = adminWorkspaceFor(request);
    const events = await db.workspaceSessionTimeline(
      workspaceId,
      request.params.sessionId,
    );
    if (!events) return reply.code(404).send({ error: "session_not_found" });
    return await timelineExport(
      workspaceId,
      request.params.sessionId,
      events,
      detail.data,
    );
  },
);

app.delete<{ Params: { machineId: string } }>(
  "/v1/admin/machines/:machineId",
  { preHandler: requireWorkspaceAccess },
  async (request, reply) => {
    const workspaceId = adminWorkspaceFor(request);
    const result = await revokeWorkspaceMachine(
      workspaceId,
      adminPrincipalFor(request),
      request.params.machineId,
    );
    if (!result) return reply.code(404).send({ error: "active_machine_not_found" });
    return result;
  },
);

app.delete<{ Params: { agentId: string } }>(
  "/v1/admin/agents/:agentId",
  { preHandler: [requireAdmin, requireAdminWorkspace] },
  async (request, reply) => {
    const parsed = z.string().uuid().safeParse(request.params.agentId);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_agent_id" });
    }
    const workspaceId = adminWorkspaceFor(request);
    const result = await deleteWorkspaceAgent(
      workspaceId,
      adminPrincipalFor(request),
      parsed.data,
    );
    if (!result) return reply.code(404).send({ error: "agent_not_found" });
    return { deleted: true, ...result };
  },
);

app.post("/v1/admin/agent-tokens", {
  preHandler: requireWorkspaceAccess,
}, async (_request, reply) => {
  return reply.code(410).send({
    error: "legacy_agent_access_migrated",
    replacement: "agent_device_authorization",
  });
});

app.delete<{ Params: { tokenId: string } }>(
  "/v1/admin/agent-tokens/:tokenId",
  { preHandler: requireWorkspaceAccess },
  async (_request, reply) =>
    reply.code(410).send({
      error: "legacy_agent_access_migrated",
      replacement: "agent_credentials",
    }),
);

app.post("/v1/clients/enroll", async (request, reply) => {
  const body = request.body as {
    token?: string;
    name?: string;
    publicKey?: string;
    previousMachineId?: string;
  };
  if (!body?.token || !body.name || !body.publicKey) {
    return reply.code(400).send({ error: "token_name_and_public_key_required" });
  }
  try {
    const key = createPublicKey(body.publicKey);
    if (key.asymmetricKeyType !== "ed25519") {
      return reply.code(400).send({ error: "client_key_must_be_ed25519" });
    }
  } catch {
    return reply.code(400).send({ error: "invalid_client_public_key" });
  }
  if (
    body.previousMachineId !== undefined &&
    !z.string().uuid().safeParse(body.previousMachineId).success
  ) {
    return reply.code(400).send({ error: "invalid_previous_machine_id" });
  }

  const machineId = randomUUID();
  const enrolled = await db.enrollMachine({
    tokenHash: hashToken(body.token),
    machineId,
    name: body.name,
    publicKey: body.publicKey,
    ...(body.previousMachineId
      ? { previousMachineId: body.previousMachineId }
      : {}),
  });
  if (!enrolled) {
    return reply.code(401).send({ error: "invalid_or_expired_enrollment_token" });
  }
  if (enrolled.status === "machine_limit_reached") {
    return reply.code(409).send({
      error: "machine_limit_reached",
      details: { machineLimit: enrolled.machineLimit },
    });
  }
  if (enrolled.status === "previous_machine_active") {
    return reply.code(409).send({ error: "previous_machine_still_active" });
  }
  await audit(
    db,
    enrolled.workspaceId,
    "client-enrollment",
    "machine.enrolled",
    "machine",
    machineId,
    { name: body.name },
  );
  if (enrolled.createdByHumanId) {
    await db.createNotification({
      workspaceId: enrolled.workspaceId,
      userId: enrolled.createdByHumanId,
      kind: "machine.enrolled",
      title: "Machine added",
      href: "/dashboard/machines",
      resourceId: machineId,
    });
  }
  gateway.notifyWorkspace(enrolled.workspaceId);
  return reply.code(201).send({
    machineId: enrolled.machineId,
    name: enrolled.name,
    workspaceId: enrolled.workspaceId,
  });
});

app.get("/v1/machines", { preHandler: requireAgent }, async (request) => {
  const principal = principalFor(request);
  const machines = await db.listMachines(principal.workspaceId, {
    ...(principal.machineIds === null ? {} : { machineIds: [...principal.machineIds] }),
  });
  return {
    data: machines.map((machine) => ({
      id: machine.id,
      name: machine.name,
      status: machine.status,
      runtime: machine.runtime ?? null,
      lastSeenAt: isoTimestamp(machine.lastSeenAt),
      enrolledAt: isoTimestamp(machine.enrolledAt),
      online: gateway.isOnline(machine.id),
      ...clientCompatibility(machine.runtime),
    })),
  };
});

app.post<{ Params: { machineId: string } }>(
  "/v1/machines/:machineId/ping",
  { preHandler: requireAgent },
  async (request, reply) => {
    const principal = principalFor(request);
    if (
      !canAccessMachine(principal, request.params.machineId) ||
      !(await db.activeMachinesExist(principal.workspaceId, [
        request.params.machineId,
      ]))
    ) {
      await audit(db, principal.workspaceId, principal.id, "machine.ping_denied", "machine", request.params.machineId, {
        reason: "machine_scope",
      });
      return reply.code(403).send({ error: "machine_denied" });
    }
    if (!gateway.isOnline(request.params.machineId)) {
      return reply.code(409).send({ error: "machine_offline" });
    }
    try {
      const latencyMs = await gateway.ping(request.params.machineId);
      await audit(db, principal.workspaceId, principal.id, "machine.ping", "machine", request.params.machineId, {
        latencyMs,
      });
      return { reply: "pong", machineId: request.params.machineId, latencyMs };
    } catch {
      return reply.code(504).send({
        error: "machine_ping_timeout",
        details: {
          machineId: request.params.machineId,
          timeoutMilliseconds: 5_000,
          possibleCause: "client_outdated_or_unresponsive",
        },
      });
    }
  },
);

app.post(
  "/v1/agent-session-requests",
  { preHandler: requireSessionRequester },
  async (request, reply) => {
    if (!webUrl) {
      return reply
        .code(503)
        .send({ error: "session_approval_unavailable" });
    }
    const parsed = attributedAgentSessionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", details: parsed.error.issues });
    }
    const principal = sessionRequesterFor(request);
    const agentId = parsed.data.agentId;
    let agentName = parsed.data.agentName;
    if (principal.agent) {
      const target = await requestedAgentFor(principal, agentId);
      if (!target || target.name !== parsed.data.agentName) {
        return reply.code(403).send({ error: "agent_identity_mismatch" });
      }
      agentName = target.name;
    }
    if (
      !sessionRequestLimiter.allow(
        principal.workspaceId,
        principal.agent?.credentialId ?? principal.humanId,
      )
    ) {
      return reply
        .code(429)
        .send({ error: "session_request_rate_limited" });
    }
    const requestId = randomUUID();
    const expiresAt = Date.now() + 10 * 60 * 1_000;
    const created = await db.createAgentSessionRequest({
      workspaceId: principal.workspaceId,
      requestId,
      agentId,
      agentName,
      humanId: principal.humanId,
      ...(principal.agent
        ? { requesterAgentId: principal.agent.agentId }
        : {}),
      ...(parsed.data.runId ? { runId: parsed.data.runId } : {}),
      scopes: parsed.data.scopes,
      title: parsed.data.title,
      ...(parsed.data.purpose ? { purpose: parsed.data.purpose } : {}),
      durationSeconds: parsed.data.durationSeconds,
      approvalCodeHash: hashToken(requestId),
      expiresAt,
    });
    if (!created) {
      return reply.code(403).send({ error: "agent_or_machine_denied" });
    }
    await audit(
      db,
      principal.workspaceId,
      agentId,
      "session.requested",
      "session_request",
      requestId,
      {
        scopes: parsed.data.scopes.map((scope) => ({
          machineId: scope.machineId,
          capabilities: scope.capabilities,
        })),
        durationSeconds: parsed.data.durationSeconds,
        executorAgentId: agentId,
        ...(principal.agent
          ? { requesterAgentId: principal.agent.agentId }
          : {}),
        ...(parsed.data.runId ? { runId: parsed.data.runId } : {}),
      },
    );
    gateway.notifyWorkspace(principal.workspaceId);
    return reply.code(201).send({
      id: requestId,
      status: created.status,
      scopes: parsed.data.scopes.map((scope) => ({
        machineId: scope.machineId,
        readiness: gateway.isOnline(scope.machineId)
          ? { ready: true }
          : { ready: false, reason: "machine_offline" },
      })),
      ...(created.status === "pending" && webUrl
        ? {
            approvalUrl: sessionApprovalUrl(webUrl, requestId),
          }
        : {}),
      ...(created.autoapprovalPolicyId
        ? {
            autoapprovalPolicy: {
              id: created.autoapprovalPolicyId,
              version: created.autoapprovalPolicyVersion,
            },
          }
        : {}),
      expiresAt: isoTimestamp(created.expiresAt),
    });
  },
);

app.get(
  "/v1/agent-session-requests",
  { preHandler: requireSessionRequester },
  async (request, reply) => {
    const parsed = agentIdentityReferenceSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const principal = sessionRequesterFor(request);
    if (
      principal.agent &&
      !(await requestedAgentFor(principal, parsed.data.agentId))
    ) {
      return reply.code(403).send({ error: "agent_identity_mismatch" });
    }
    const requests = await db.listAgentSessionRequests(
      principal.workspaceId,
      parsed.data.agentId,
      principal.humanId,
      20,
    );
    return {
      data: requests.map((sessionRequest) => ({
        id: sessionRequest.id,
        title: sessionRequest.title,
        ...(sessionRequest.purpose
          ? { purpose: sessionRequest.purpose }
          : {}),
        scopes: sessionRequest.scopes,
        durationSeconds: sessionRequest.durationSeconds,
        status: sessionRequest.status,
        expiresAt: isoTimestamp(sessionRequest.expiresAt),
        ...(sessionRequest.sessionId
          ? { sessionId: sessionRequest.sessionId }
          : {}),
      })),
    };
  },
);

app.post<{ Params: { requestId: string } }>(
  "/v1/agent-session-requests/:requestId/status",
  { preHandler: requireSessionRequester },
  async (request, reply) => {
    const parsed = agentIdentityReferenceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", details: parsed.error.issues });
    }
    const principal = sessionRequesterFor(request);
    if (
      principal.agent &&
      !(await requestedAgentFor(principal, parsed.data.agentId))
    ) {
      return reply.code(403).send({ error: "agent_identity_mismatch" });
    }
    const sessionRequest = await db.getAgentSessionRequest(
      principal.workspaceId,
      request.params.requestId,
      parsed.data.agentId,
      principal.humanId,
    );
    if (!sessionRequest) {
      return reply.code(404).send({ error: "session_request_not_found" });
    }
    return {
      id: sessionRequest.id,
      status: sessionRequest.status,
      expiresAt: isoTimestamp(sessionRequest.expiresAt),
      ...(sessionRequest.sessionId
        ? { sessionId: sessionRequest.sessionId }
        : {}),
    };
  },
);

app.post<{ Params: { requestId: string } }>(
  "/v1/agent-session-requests/:requestId/claim",
  { preHandler: requireSessionRequester },
  async (request, reply) => {
    const parsed = agentIdentityReferenceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", details: parsed.error.issues });
    }
    const principal = sessionRequesterFor(request);
    if (
      principal.agent &&
      !(await requestedAgentFor(principal, parsed.data.agentId))
    ) {
      return reply.code(403).send({ error: "agent_identity_mismatch" });
    }
    const current = await db.getAgentSessionRequest(
      principal.workspaceId,
      request.params.requestId,
      parsed.data.agentId,
      principal.humanId,
    );
    if (!current) {
      return reply.code(404).send({ error: "session_request_not_found" });
    }
    const sessionToken = createOpaqueToken("session");
    const result = await db.claimAgentSessionRequest({
      workspaceId: principal.workspaceId,
      requestId: request.params.requestId,
      agentId: parsed.data.agentId,
      humanId: principal.humanId,
      sessionId: randomUUID(),
      authority: {
        kind: "credential",
        credentialId: randomUUID(),
        credentialHash: hashToken(sessionToken),
      },
      now: Date.now(),
    });
    if (result.status === "invalid") {
      return reply.code(404).send({ error: "session_request_not_found" });
    }
    if (result.status === "pending") {
      return reply.code(409).send({ error: "session_request_pending" });
    }
    if (result.status === "denied" || result.status === "agent_denied") {
      return reply.code(403).send({ error: result.status });
    }
    if (result.status === "expired") {
      return reply.code(410).send({ error: "session_request_expired" });
    }
    if (result.status === "already_claimed") {
      return reply.code(409).send({ error: "session_request_already_claimed" });
    }
    if (result.status === "machine_unavailable") {
      return reply.code(409).send({ error: "machine_unavailable" });
    }
    if (result.status !== "claimed") {
      return reply.code(500).send({ error: "session_claim_failed" });
    }
    const readiness: Array<{
      machineId: string;
      ready: boolean;
      reason?: string;
    }> = [];
    for (const target of result.targets) {
      const sent = gateway.send(target.machineId, {
        type: "session.open",
        sessionId: target.runtimeSessionId,
        profile: target.scope.profile,
        capabilities: target.scope.capabilities,
        restrictions: target.scope.restrictions,
        expiresAt: new Date(result.session.expiresAt).toISOString(),
        serverTime: new Date().toISOString(),
      });
      if (!sent) {
        await db.markSessionOpenFailed(
          target.machineId,
          target.runtimeSessionId,
          "machine_disconnected",
        );
        readiness.push({
          machineId: target.machineId,
          ready: false,
          reason: "machine_offline",
        });
      } else {
        readiness.push({ machineId: target.machineId, ready: true });
      }
    }
    gateway.notifyWorkspace(principal.workspaceId);
    return reply.code(201).send({
      sessionId: result.session.id,
      sessionToken,
      scopes: result.targets.map((target) => target.scope),
      readiness,
      status: "opening",
      expiresAt: isoTimestamp(result.session.expiresAt),
    });
  },
);

app.post<{ Params: { sessionId: string } }>(
  "/v1/agent-sessions/:sessionId/timeline",
  { preHandler: requireSessionRequester },
  async (request, reply) => {
    const parsed = agentIdentityReferenceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", details: parsed.error.issues });
    }
    const principal = sessionRequesterFor(request);
    if (
      principal.agent &&
      !(await requestedAgentFor(principal, parsed.data.agentId))
    ) {
      return reply.code(403).send({ error: "agent_identity_mismatch" });
    }
    const events = await db.listSessionTimeline(
      principal.workspaceId,
      request.params.sessionId,
      parsed.data.agentId,
      principal.humanId,
    );
    if (!events) {
      return reply.code(404).send({ error: "session_not_found" });
    }
    return {
      data: events.map((event) => ({
        ...event,
        createdAt: isoTimestamp(event.createdAt),
      })),
    };
  },
);

app.post<{ Params: { sessionId: string } }>(
  "/v1/agent-sessions/:sessionId/timeline/export",
  { preHandler: requireSessionRequester },
  async (request, reply) => {
    const parsed = agentIdentityReferenceSchema
      .extend({
        detailLevel: z.enum(eventSinkDetailLevels).default("privacy-minimal"),
      })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const principal = sessionRequesterFor(request);
    if (
      principal.agent &&
      !(await requestedAgentFor(principal, parsed.data.agentId))
    ) {
      return reply.code(403).send({ error: "agent_identity_mismatch" });
    }
    const events = await db.listSessionTimeline(
      principal.workspaceId,
      request.params.sessionId,
      parsed.data.agentId,
      principal.humanId,
    );
    if (!events) return reply.code(404).send({ error: "session_not_found" });
    return await timelineExport(
      principal.workspaceId,
      request.params.sessionId,
      events,
      parsed.data.detailLevel,
    );
  },
);

app.get(
  "/v1/agent-sessions",
  { preHandler: requireSessionRequester },
  async (request) => {
    const principal = sessionRequesterFor(request);
    const sessions = await db.listWorkspaceAgentSessions(
      principal.workspaceId,
      200,
      principal.agent
        ? { agentId: principal.agent.agentId }
        : { humanId: principal.humanId },
    );
    return {
      data: sessions.map((session) => ({
        ...session,
        expiresAt: isoTimestamp(session.expiresAt),
        createdAt: isoTimestamp(session.createdAt),
        updatedAt: isoTimestamp(session.updatedAt),
      })),
    };
  },
);

app.get("/v1/sessions", { preHandler: requireAgent }, async (request, reply) => {
  const principal = principalFor(request);
  if (principal.kind !== "session" && principal.kind !== "development") {
    return reply.code(403).send({ error: "session_credential_required" });
  }
  const sessions = (
    await db.listSessions(principal.workspaceId, principal.id)
  ).filter(
    (session) =>
      principal.sessionScope === undefined ||
      session.id === principal.sessionScope.sessionId,
  );
  return {
    data: sessions.map((session) => ({
      id: session.id,
      machineId: session.machineId,
      machineName: session.machineName,
      profile: session.profile,
      capabilities: session.capabilities,
      status: session.status,
      expiresAt: isoTimestamp(session.expiresAt),
      error: session.error ?? null,
      createdAt: isoTimestamp(session.createdAt),
    })),
  };
});

app.post("/v1/sessions", async (_request, reply) =>
  reply.code(410).send({
    error: "legacy_session_creation_migrated",
    replacement: "agent_session_requests",
  }),
);

app.post("/v1/development/sessions", { preHandler: requireAgent }, async (request, reply) => {
  const principal = principalFor(request);
  if (principal.kind !== "development") {
    return reply.code(403).send({ error: "development_credential_required" });
  }
  const parsed = sessionRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
  }
  const input = parsed.data;
  if (
    !canAccessMachine(principal, input.machineId) ||
    !(await db.activeMachinesExist(principal.workspaceId, [input.machineId]))
  ) {
    await audit(db, principal.workspaceId, principal.id, "session.denied", "machine", input.machineId, {
      reason: "machine_scope",
    });
    return reply.code(403).send({ error: "machine_denied" });
  }
  const deniedCapability = input.capabilities.find(
    (capability) => !principal.capabilities.has(capability),
  );
  if (deniedCapability) {
    await audit(db, principal.workspaceId, principal.id, "session.denied", "machine", input.machineId, {
      reason: "capability_scope",
      kind: deniedCapability,
    });
    return reply
      .code(403)
      .send({ error: "capability_denied", capability: deniedCapability });
  }
  if (!gateway.isOnline(input.machineId)) {
    return reply.code(409).send({ error: "machine_offline" });
  }
  const sessionId = randomUUID();
  const expiresAt = boundedSessionExpiry(new Date(), input.ttlSeconds, principal.expiresAt);
  if (expiresAt.getTime() <= Date.now()) {
    return reply.code(401).send({ error: "invalid_or_expired_agent_token" });
  }
  const sessionCreated = await db.createSession({
    workspaceId: principal.workspaceId,
    id: sessionId,
    machineId: input.machineId,
    principalId: principal.id,
    profile: input.profile,
    capabilities: input.capabilities,
    expiresAt: expiresAt.getTime(),
    requireActiveAgentToken: false,
  });
  if (!sessionCreated) {
    return reply.code(401).send({ error: "invalid_or_expired_agent_token" });
  }
  gateway.send(input.machineId, {
    type: "session.open",
    sessionId,
    profile: input.profile,
    capabilities: input.capabilities,
    expiresAt: expiresAt.toISOString(),
    serverTime: new Date().toISOString(),
  });
  await audit(db, principal.workspaceId, principal.id, "session.created", "session", sessionId, {
    machineId: input.machineId,
    profile: input.profile,
    capabilities: input.capabilities,
    expiresAt: expiresAt.toISOString(),
  });
  gateway.notifyWorkspace(principal.workspaceId);
  return reply.code(202).send({
    id: sessionId,
    machineId: input.machineId,
    status: "opening",
    expiresAt: expiresAt.toISOString(),
  });
});

app.get<{ Params: { sessionId: string } }>(
  "/v1/sessions/:sessionId",
  { preHandler: requireAgent },
  async (request, reply) => {
    const principal = principalFor(request);
    if (principal.kind !== "session" && principal.kind !== "development") {
      return reply.code(403).send({ error: "session_credential_required" });
    }
    if (
      principal.sessionScope !== undefined &&
      request.params.sessionId !== principal.sessionScope.sessionId
    ) {
      return reply.code(404).send({ error: "session_not_found" });
    }
    if (principal.sessionScope !== undefined) {
      const targets = await db.listAgentSessionTargetRuntimes(
        principal.workspaceId,
        request.params.sessionId,
        principal.id,
      );
      if (targets.length === 0) {
        return reply.code(404).send({ error: "session_not_found" });
      }
      const status = targets.some((target) => target.status === "ready")
        ? "ready"
        : targets.some((target) => target.status === "opening")
          ? "opening"
            : targets.some((target) => target.status === "failed")
              ? "failed"
          : targets.every((target) =>
                ["closed", "expired"].includes(target.status),
              )
            ? "closed"
            : "failed";
      return {
        id: request.params.sessionId,
        status,
        expiresAt: isoTimestamp(
          Math.min(...targets.map((target) => target.expiresAt)),
        ),
        targets: targets.map((target) => ({
          machineId: target.machineId,
          profile: target.profile,
          capabilities: target.capabilities,
          restrictions: target.restrictions,
          status: target.status,
          error: target.error ?? null,
        })),
      };
    }
    const session = await db.getSession(
      principal.workspaceId,
      request.params.sessionId,
      principal.id,
    );
    if (!session) return reply.code(404).send({ error: "session_not_found" });
    return {
      id: session.id,
      machineId: session.machineId,
      profile: session.profile,
      capabilities: session.capabilities,
      status: session.status,
      expiresAt: isoTimestamp(session.expiresAt),
      error: session.error ?? null,
      createdAt: isoTimestamp(session.createdAt),
    };
  },
);

app.delete<{ Params: { sessionId: string } }>(
  "/v1/sessions/:sessionId",
  { preHandler: requireAgent },
  async (request, reply) => {
    const principal = principalFor(request);
    if (principal.kind !== "session" && principal.kind !== "development") {
      return reply.code(403).send({ error: "session_credential_required" });
    }
    if (
      principal.sessionScope !== undefined &&
      request.params.sessionId !== principal.sessionScope.sessionId
    ) {
      return reply.code(404).send({ error: "active_session_not_found" });
    }
    if (principal.sessionScope !== undefined) {
      const termination = await db.cancelAgentSession({
        workspaceId: principal.workspaceId,
        sessionId: request.params.sessionId,
        agentId: principal.id,
        reason: "cancelled",
      });
      if (!termination) {
        return reply.code(404).send({ error: "active_session_not_found" });
      }
      for (const operation of termination.operations) {
        gateway.send(operation.machineId, {
          type: "operation.cancel",
          operationId: operation.id,
        });
      }
      for (const target of termination.targets) {
        gateway.send(target.machineId, {
          type: "session.close",
          sessionId: target.runtimeSessionId,
          reason: "agent_request",
        });
      }
      await audit(
        db,
        principal.workspaceId,
        principal.id,
        "session.close_requested",
        "session",
        request.params.sessionId,
        { machineIds: termination.targets.map((target) => target.machineId) },
      );
      return reply
        .code(202)
        .send({
          id: request.params.sessionId,
          status: termination.status,
          transitioned: termination.transitioned,
        });
    }
    const session = await db.getActiveSession(
      principal.workspaceId,
      request.params.sessionId,
      principal.id,
    );
    if (!session) return reply.code(404).send({ error: "active_session_not_found" });
    gateway.send(session.machineId, {
      type: "session.close",
      sessionId: request.params.sessionId,
      reason: "agent_request",
    });
    await db.markSessionClosing(principal.workspaceId, request.params.sessionId);
    await audit(
      db,
      principal.workspaceId,
      principal.id,
      "session.close_requested",
      "session",
      request.params.sessionId,
      { machineId: session.machineId },
    );
    return reply.code(202).send({ id: request.params.sessionId, status: "closing" });
  },
);

app.post<{ Params: { sessionId: string } }>(
  "/v1/agent-sessions/:sessionId/cancel",
  { preHandler: requireSessionRequester },
  async (request, reply) => {
    const parsed = agentIdentityReferenceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", details: parsed.error.issues });
    }
    const principal = sessionRequesterFor(request);
    if (
      principal.agent &&
      !(await requestedAgentFor(principal, parsed.data.agentId))
    ) {
      return reply.code(403).send({ error: "agent_identity_mismatch" });
    }
    const termination = await db.cancelAgentSession({
      workspaceId: principal.workspaceId,
      sessionId: request.params.sessionId,
      agentId: parsed.data.agentId,
      requestedByHumanId: principal.humanId,
      ...(principal.agent
        ? { actorAgentId: principal.agent.agentId }
        : { actorHumanId: principal.humanId }),
      reason: "cancelled",
    });
    if (!termination) {
      return reply.code(404).send({ error: "session_not_found" });
    }
    for (const operation of termination.operations) {
      gateway.send(operation.machineId, {
        type: "operation.cancel",
        operationId: operation.id,
      });
    }
    for (const target of termination.targets) {
      gateway.send(target.machineId, {
        type: "session.close",
        sessionId: target.runtimeSessionId,
        reason: "human_request",
      });
    }
    if (termination.transitioned) {
      await audit(
        db,
        principal.workspaceId,
        parsed.data.agentId,
        "session.cancelled",
        "session",
        request.params.sessionId,
      );
      gateway.notifyWorkspace(principal.workspaceId);
    }
    return {
      id: termination.id,
      status: termination.status,
      transitioned: termination.transitioned,
    };
  },
);

app.post<{ Params: { sessionId: string } }>(
  "/v1/agent-sessions/:sessionId/complete",
  { preHandler: requireSessionRequester },
  async (request, reply) => {
    const parsed = completeAgentSessionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", details: parsed.error.issues });
    }
    const principal = sessionRequesterFor(request);
    if (
      principal.agent &&
      !(await requestedAgentFor(principal, parsed.data.agentId))
    ) {
      return reply.code(403).send({ error: "agent_identity_mismatch" });
    }
    const completion = await db.completeAgentSession({
      workspaceId: principal.workspaceId,
      sessionId: request.params.sessionId,
      agentId: parsed.data.agentId,
      requestedByHumanId: principal.humanId,
      ...(principal.agent
        ? { actorAgentId: principal.agent.agentId }
        : { actorHumanId: principal.humanId }),
      outcome: parsed.data.outcome,
      ...(parsed.data.summary ? { summary: parsed.data.summary } : {}),
    });
    if (!completion) {
      return reply.code(404).send({ error: "session_not_found" });
    }
    if (completion.status === "busy") {
      return reply.code(409).send({ error: "session_operations_active" });
    }
    for (const target of completion.targets) {
      gateway.send(target.machineId, {
        type: "session.close",
        sessionId: target.runtimeSessionId,
        reason: "completed",
      });
    }
    if (completion.transitioned) {
      await audit(
        db,
        principal.workspaceId,
        parsed.data.agentId,
        "session.completed",
        "session",
        request.params.sessionId,
        { outcome: parsed.data.outcome },
      );
      gateway.notifyWorkspace(principal.workspaceId);
    }
    return completion;
  },
);

app.post<{ Params: { sessionId: string } }>(
  "/v1/agent-sessions/:sessionId/renew",
  { preHandler: requireSessionRequester },
  async (request, reply) => {
    if (!webUrl) {
      return reply.code(503).send({ error: "session_approval_unavailable" });
    }
    const parsed = renewAgentSessionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", details: parsed.error.issues });
    }
    const principal = sessionRequesterFor(request);
    if (
      principal.agent &&
      !(await requestedAgentFor(principal, parsed.data.agentId))
    ) {
      return reply.code(403).send({ error: "agent_identity_mismatch" });
    }
    if (
      !sessionRequestLimiter.allow(
        principal.workspaceId,
        principal.agent?.credentialId ?? principal.humanId,
      )
    ) {
      return reply
        .code(429)
        .send({ error: "session_request_rate_limited" });
    }
    const predecessor = await db.agentSessionForRenewal(
      principal.workspaceId,
      request.params.sessionId,
      parsed.data.agentId,
      principal.humanId,
    );
    if (!predecessor) {
      return reply.code(404).send({ error: "session_not_found" });
    }
    const requestId = randomUUID();
    const expiresAt = Date.now() + 10 * 60_000;
    const created = await db.createAgentSessionRequest({
      workspaceId: principal.workspaceId,
      requestId,
      agentId: parsed.data.agentId,
      agentName: predecessor.agentName,
      humanId: principal.humanId,
      ...(principal.agent
        ? { requesterAgentId: principal.agent.agentId }
        : {}),
      scopes: predecessor.scopes,
      title: predecessor.title,
      ...(predecessor.purpose ? { purpose: predecessor.purpose } : {}),
      durationSeconds:
        parsed.data.durationSeconds ?? predecessor.durationSeconds,
      approvalCodeHash: hashToken(requestId),
      expiresAt,
      predecessorSessionId: request.params.sessionId,
    });
    if (!created) {
      return reply.code(403).send({ error: "session_renewal_denied" });
    }
    await audit(
      db,
      principal.workspaceId,
      parsed.data.agentId,
      "session.renewal_requested",
      "session_request",
      requestId,
      { predecessorSessionId: request.params.sessionId },
    );
    gateway.notifyWorkspace(principal.workspaceId);
    return reply.code(201).send({
      id: requestId,
      predecessorSessionId: request.params.sessionId,
      status: created.status,
      scopes: predecessor.scopes.map((scope) => ({
        machineId: scope.machineId,
        readiness: gateway.isOnline(scope.machineId)
          ? { ready: true }
          : { ready: false, reason: "machine_offline" },
      })),
      ...(created.status === "pending" && webUrl
        ? {
            approvalUrl: sessionApprovalUrl(webUrl, requestId),
          }
        : {}),
      ...(created.autoapprovalPolicyId
        ? {
            autoapprovalPolicy: {
              id: created.autoapprovalPolicyId,
              version: created.autoapprovalPolicyVersion,
            },
          }
        : {}),
      expiresAt: isoTimestamp(created.expiresAt),
    });
  },
);

app.post<{ Params: { sessionId: string } }>(
  "/v1/sessions/:sessionId/operations",
  { preHandler: requireAgent },
  async (request, reply) => {
    const principal = principalFor(request);
    const parsed = scopedOperationRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
    }
    const parsedIdempotencyKey = idempotencyKeySchema.safeParse(
      request.headers["idempotency-key"],
    );
    if (!parsedIdempotencyKey.success) {
      return reply.code(400).send({ error: "invalid_idempotency_key" });
    }
    const idempotencyKey = parsedIdempotencyKey.data;
    if (principal.sessionScope !== undefined) {
      const machineId =
        parsed.data.machineId ??
        (principal.sessionScope.scopes.length === 1
          ? principal.sessionScope.scopes[0]!.machineId
          : undefined);
      if (!machineId) {
        return reply.code(400).send({ error: "machine_id_required" });
      }
      const decision = sessionOperationDecision(
        principal.sessionScope,
        request.params.sessionId,
        machineId,
        parsed.data.action,
        parsed.data.timeoutSeconds,
      );
      if (!decision.allowed) {
        await audit(
          db,
          principal.workspaceId,
          principal.id,
          "operation.denied",
          "session",
          request.params.sessionId,
          {
            reason: decision.code,
            kind: parsed.data.action.kind,
          },
        );
        const status =
          decision.code === "session_expired"
            ? 410
            : decision.code === "timeout_exceeds_session"
              ? 400
              : 403;
        return reply.code(status).send({
          error: decision.code,
          details: {
            machineId,
            requiredCapability: capabilityForAction(parsed.data.action),
          },
        });
      }
      const target = await db.getAgentSessionTargetRuntime(
        principal.workspaceId,
        request.params.sessionId,
        principal.id,
        machineId,
      );
      if (!target) {
        return reply.code(404).send({ error: "session_target_not_found" });
      }
      if (!target.canonicalReady || target.status !== "ready") {
        return reply
          .code(409)
          .send({ error: "session_not_ready", status: target.status });
      }
      if (!gateway.isOnline(target.machineId)) {
        return reply.code(409).send({ error: "machine_offline" });
      }
      if (idempotencyKey) {
        const existing = await db.findOperationByIdempotency(
          principal.workspaceId,
          target.runtimeSessionId,
          principal.id,
          idempotencyKey,
        );
        if (existing) {
          return reply
            .code(200)
            .send({ id: existing.id, status: existing.status });
        }
      }
      const operationId = randomUUID();
      const created = await db.createOperation({
        workspaceId: principal.workspaceId,
        id: operationId,
        sessionId: target.runtimeSessionId,
        principalId: principal.id,
        action: parsed.data.action,
        timeoutSeconds: parsed.data.timeoutSeconds,
        maxOutputBytes: parsed.data.maxOutputBytes,
        idempotencyKey,
      });
      if (!created && idempotencyKey) {
        const existing = await db.findOperationByIdempotency(
          principal.workspaceId,
          target.runtimeSessionId,
          principal.id,
          idempotencyKey,
        );
        if (existing) {
          return reply
            .code(200)
            .send({ id: existing.id, status: existing.status });
        }
        return reply.code(409).send({ error: "session_not_active" });
      }
      const sent = gateway.send(target.machineId, {
        type: "operation.start",
        operationId,
        sessionId: target.runtimeSessionId,
        action: parsed.data.action,
        timeoutSeconds: parsed.data.timeoutSeconds,
        maxOutputBytes: parsed.data.maxOutputBytes,
      });
      if (sent) {
        await db.markOperationDelivered(principal.workspaceId, operationId);
      }
      await audit(
        db,
        principal.workspaceId,
        principal.id,
        "operation.created",
        "operation",
        operationId,
        {
          sessionId: request.params.sessionId,
          kind: parsed.data.action.kind,
          machineId: target.machineId,
          operation: operationAuditMetadata(parsed.data.action),
        },
      );
      gateway.notifyWorkspace(principal.workspaceId);
      return reply
        .code(202)
        .send({ id: operationId, status: sent ? "delivered" : "queued" });
    }
    if (principal.kind !== "development") {
      return reply.code(403).send({ error: "session_credential_required" });
    }
    if (idempotencyKey) {
      const existing = await db.findOperationByIdempotency(
        principal.workspaceId,
        request.params.sessionId,
        principal.id,
        idempotencyKey,
      );
      if (existing) return reply.code(200).send({ id: existing.id, status: existing.status });
    }

    const session = await db.sessionForOperation(
      principal.workspaceId,
      request.params.sessionId,
      principal.id,
    );
    if (!session) return reply.code(404).send({ error: "session_not_found" });
    if (session.status !== "ready") {
      return reply.code(409).send({ error: "session_not_ready", status: session.status });
    }
    if (session.expiresAt <= Date.now()) {
      return reply.code(410).send({ error: "session_expired" });
    }
    const neededCapability = capabilityForAction(parsed.data.action);
    if (!session.capabilities.includes(neededCapability)) {
      await audit(db, principal.workspaceId, principal.id, "operation.denied", "session", request.params.sessionId, {
        reason: "session_capability",
        capability: neededCapability,
        kind: parsed.data.action.kind,
        machineId: session.machineId,
      });
      return reply.code(403).send({ error: "capability_denied", capability: neededCapability });
    }
    if (!gateway.isOnline(session.machineId)) {
      return reply.code(409).send({ error: "machine_offline" });
    }

    const operationId = randomUUID();
    const created = await db.createOperation({
      workspaceId: principal.workspaceId,
      id: operationId,
      sessionId: request.params.sessionId,
      principalId: principal.id,
      action: parsed.data.action,
      timeoutSeconds: parsed.data.timeoutSeconds,
      maxOutputBytes: parsed.data.maxOutputBytes,
      idempotencyKey,
    });
    if (!created && idempotencyKey) {
      const existing = await db.findOperationByIdempotency(
        principal.workspaceId,
        request.params.sessionId,
        principal.id,
        idempotencyKey,
      );
      if (existing) return reply.code(200).send({ id: existing.id, status: existing.status });
      return reply.code(409).send({ error: "session_not_active" });
    }
    const sent = gateway.send(session.machineId, {
      type: "operation.start",
      operationId,
      sessionId: request.params.sessionId,
      action: parsed.data.action,
      timeoutSeconds: parsed.data.timeoutSeconds,
      maxOutputBytes: parsed.data.maxOutputBytes,
    });
    if (sent) {
      await db.markOperationDelivered(principal.workspaceId, operationId);
    }
    await audit(db, principal.workspaceId, principal.id, "operation.created", "operation", operationId, {
      sessionId: request.params.sessionId,
      kind: parsed.data.action.kind,
      machineId: session.machineId,
      operation: operationAuditMetadata(parsed.data.action),
    });
    gateway.notifyWorkspace(principal.workspaceId);
    return reply.code(202).send({ id: operationId, status: sent ? "delivered" : "queued" });
  },
);

app.get<{ Params: { operationId: string } }>(
  "/v1/operations/:operationId",
  { preHandler: requireAgent },
  async (request, reply) => {
    const principal = principalFor(request);
    if (principal.kind !== "session" && principal.kind !== "development") {
      return reply.code(403).send({ error: "session_credential_required" });
    }
    const operation = await db.getOperation(
      principal.workspaceId,
      request.params.operationId,
      principal.id,
      principal.sessionScope?.sessionId,
    );
    if (!operation) return reply.code(404).send({ error: "operation_not_found" });
    return {
      id: operation.id,
      sessionId: operation.sessionId,
      action: operation.action,
      status: operation.status,
      exitCode: operation.exitCode ?? null,
      error: operation.error ?? null,
      outputTruncated: operation.outputTruncated,
      createdAt: isoTimestamp(operation.createdAt),
      updatedAt: isoTimestamp(operation.updatedAt),
      events: operation.events.map((event) => ({
        sequence: event.sequence,
        stream: event.stream,
        dataBase64: event.dataBase64,
        createdAt: isoTimestamp(event.createdAt),
      })),
    };
  },
);

app.post<{ Params: { operationId: string } }>(
  "/v1/operations/:operationId/cancel",
  { preHandler: requireAgent },
  async (request, reply) => {
    const principal = principalFor(request);
    if (principal.kind !== "session" && principal.kind !== "development") {
      return reply.code(403).send({ error: "session_credential_required" });
    }
    const operation = await db.getOperationTarget(
      principal.workspaceId,
      request.params.operationId,
      principal.id,
      principal.sessionScope?.sessionId,
    );
    if (!operation) return reply.code(404).send({ error: "operation_not_found" });
    if (!["queued", "delivered", "running"].includes(operation.status)) {
      return reply.code(409).send({ error: "operation_not_cancellable", status: operation.status });
    }
    gateway.send(operation.machineId, {
      type: "operation.cancel",
      operationId: request.params.operationId,
    });
    await audit(
      db,
      principal.workspaceId,
      principal.id,
      "operation.cancel_requested",
      "operation",
      request.params.operationId,
      { machineId: operation.machineId },
    );
    return reply.code(202).send({ id: request.params.operationId, status: "cancellation_requested" });
  },
);

app.get<{ Params: { operationId: string }; Querystring: { after?: string } }>(
  "/v1/operations/:operationId/events",
  { preHandler: requireAgent },
  async (request, reply) => {
    const principal = principalFor(request);
    if (principal.kind !== "session" && principal.kind !== "development") {
      return reply.code(403).send({ error: "session_credential_required" });
    }
    if (
      !(await db.operationExists(
        principal.workspaceId,
        request.params.operationId,
        principal.id,
        principal.sessionScope?.sessionId,
      ))
    ) {
      return reply.code(404).send({ error: "operation_not_found" });
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    let lastSequence = Number(request.query.after ?? -1);
    const emitRows = async (): Promise<void> => {
      const events = await db.listOperationEvents(
        principal.workspaceId,
        request.params.operationId,
        lastSequence,
      );
      for (const event of events) {
        lastSequence = event.sequence;
        reply.raw.write(
          `id: ${lastSequence}\nevent: output\ndata: ${JSON.stringify({
            sequence: event.sequence,
            stream: event.stream,
            dataBase64: event.dataBase64,
          })}\n\n`,
        );
      }
      const status = await db.operationStatus(
        principal.workspaceId,
        request.params.operationId,
      );
      if (status && !["queued", "delivered", "running"].includes(status)) {
        reply.raw.write(`event: completed\ndata: ${JSON.stringify({ status })}\n\n`);
        cleanup();
      }
    };
    const onEvent = (): void => void emitRows();
    const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 15_000);
    const cleanup = (): void => {
      clearInterval(heartbeat);
      gateway.events.off(`operation:${request.params.operationId}`, onEvent);
      if (!reply.raw.writableEnded) reply.raw.end();
    };
    gateway.events.on(`operation:${request.params.operationId}`, onEvent);
    request.raw.on("close", cleanup);
    await emitRows();
  },
);

app.get<{ Querystring: { limit?: string } }>(
  "/v1/admin/audit",
  { preHandler: requireWorkspaceAccess },
  async (request) => {
    const requestedLimit = Number(request.query.limit ?? 50);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 200)
      : 50;
    const events = await db.listAudit(adminWorkspaceFor(request), limit);
    return {
      principal: { id: adminPrincipalFor(request), name: "All agents" },
      data: events.map((event) => ({
        ...event,
        createdAt: isoTimestamp(event.createdAt),
      })),
    };
  },
);

app.get<{ Querystring: { limit?: string } }>(
  "/v1/audit",
  { preHandler: requireAgent },
  async (request) => {
    const principal = principalFor(request);
    if (principal.kind === "session") {
      return {
        principal: { id: principal.id, name: principal.name },
        data: [],
      };
    }
    const requestedLimit = Number(request.query.limit ?? 50);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 200)
      : 50;
    const events = await db.listAudit(principal.workspaceId, limit, principal.id);
    return {
      principal: { id: principal.id, name: principal.name },
      data: events.map((event) => ({
        ...event,
        createdAt: isoTimestamp(event.createdAt),
      })),
    };
  },
);

const expiryTimer = setInterval(() => {
  void (async () => {
    const staleOpenings = await db.failStaleSessionOpenings();
    const changedWorkspaces = new Set<string>();
    for (const session of staleOpenings.failed) {
      gateway.send(session.machineId, {
        type: "session.close",
        sessionId: session.id,
        reason: "opening_timeout",
      });
      changedWorkspaces.add(session.workspaceId);
    }
    for (const session of staleOpenings.ready) {
      const expiresAt = new Date(session.expiresAt).toISOString();
      const serverTime = new Date().toISOString();
      for (const target of session.targets) {
        gateway.send(target.machineId, {
          type: "session.expires",
          sessionId: target.runtimeSessionId,
          expiresAt,
          serverTime,
        });
      }
      changedWorkspaces.add(session.workspaceId);
    }
    for (const workspaceId of await db.notifyStaleOfflineMachines()) {
      changedWorkspaces.add(workspaceId);
    }
    const expired = await db.expireSessions();
    for (const session of expired) {
      gateway.send(session.machineId, {
        type: "session.close",
        sessionId: session.id,
        reason: "expired",
      });
    }
    for (const workspaceId of changedWorkspaces) {
      gateway.notifyWorkspace(workspaceId);
    }
  })().catch((error: unknown) => app.log.error(error, "Session expiry sweep failed"));
}, 10_000);

const retentionTimer = setInterval(() => {
  void purgeExpiredData().catch((error: unknown) =>
    app.log.error(error, "Data retention sweep failed"),
  );
}, 15 * 60_000);

let deliveringEventSinks = false;
const deliverEventSinks = async (): Promise<void> => {
  if (deliveringEventSinks || !eventSinkEncryptionKey) return;
  deliveringEventSinks = true;
  try {
    if (!(await db.activeEventSinksExist())) return;
    const now = Date.now();
    await db.enqueueEventSinkDeliveries(
      now - retention.auditMilliseconds,
      now - 5_000,
    );
    const deliveries = await db.pendingEventSinkDeliveries(now);
    for (const delivery of deliveries) {
      try {
        const destination = await eventSinkDestination(delivery.endpoint);
        const secret = decryptEventSinkSecret(
          delivery.secretCiphertext,
          eventSinkEncryptionKey,
        );
        const exported = await timelineExport(
          delivery.workspaceId,
          delivery.event.sessionId ?? `request:${delivery.event.requestId}`,
          [delivery.event],
          delivery.detailLevel,
          now,
          "event-sink",
        );
        const signed = signedTimelineDelivery(
          exported,
          secret,
          delivery.id,
          new Date(delivery.event.createdAt).toISOString(),
        );
        await postSignedTimeline(destination, signed.body, signed.headers);
        await db.completeEventSinkDelivery(
          delivery.workspaceId,
          delivery.id,
          { delivered: true, now: Date.now() },
        );
      } catch (error) {
        const attempts = delivery.attempts + 1;
        const errorCode =
          error instanceof Error &&
          "code" in error &&
          typeof error.code === "string"
            ? error.code
            : "event_sink_delivery_failed";
        const nextAttemptAt = eventSinkRetryAt(attempts, Date.now());
        await db.completeEventSinkDelivery(
          delivery.workspaceId,
          delivery.id,
          {
            delivered: false,
            now: Date.now(),
            ...(nextAttemptAt === undefined ? {} : { nextAttemptAt }),
            errorCode,
          },
        );
        app.log.warn(
          { deliveryId: delivery.id, errorCode, attempts },
          "Event Sink delivery failed",
        );
      }
    }
  } finally {
    deliveringEventSinks = false;
  }
};

const eventSinkTimer = setInterval(() => {
  void deliverEventSinks().catch((error: unknown) =>
    app.log.error(
      { errorCode: "event_sink_worker_failed" },
      "Event Sink worker failed",
    ),
  );
}, 5_000);
void deliverEventSinks();

app.addHook("onClose", async () => {
  clearInterval(expiryTimer);
  clearInterval(retentionTimer);
  clearInterval(eventSinkTimer);
  await db.close();
});

await app.listen({ port, host });
