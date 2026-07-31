import { createHash, createPublicKey, randomUUID, timingSafeEqual } from "node:crypto";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import {
  agentSessionRequestInputSchema,
  agentTokenRequestSchema,
  allCapabilities,
  capabilityForAction,
  operationRequestSchema,
  organizationRequestSchema,
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
  createAgentAccess,
  deleteAgentAccess,
  revokeAgentAccess,
  type AgentAccessDependencies,
} from "./agent-access.js";
import {
  approveDeviceSchema,
  CloudLiveTokenReplayGuard,
  cloudLiveOriginDecision,
  createCloudAgentAccessSchema,
  createCloudLiveToken,
  cloudIdentitySchema,
  cloudConnectionView,
  cloudWebRequestDecision,
  cloudWebKey,
  cloudWebUrl,
  createDeviceUserCode,
  deleteCloudAgentAccessSchema,
  entitlementsFor,
  exchangeDeviceAuthorizationSchema,
  FixedWindowRateLimiter,
  normalizeDeviceUserCode,
  privacySafeControlMetadata,
  revokeCloudAgentAccessSchema,
  revokeCloudMachineSchema,
  ScopedConcurrencyLimiter,
  ScopedRateLimiter,
  startDeviceAuthorizationSchema,
  verifyCloudLiveToken,
  sessionApprovalSchema,
} from "./cloud.js";
import {
  audit,
  createDatabase,
  DEFAULT_WORKSPACE_ID,
  type AgentTokenRecord,
  type AuditRecord,
  type CliTokenRecord,
} from "./database.js";
import {
  sessionOperationDecision,
  type AgentSessionPrincipal,
} from "./agent-sessions.js";
import { ClientGateway } from "./gateway.js";
import { dataRetentionPolicy } from "./privacy.js";

const port = Number(process.env.PORT ?? 4100);
const host = process.env.HOST ?? "127.0.0.1";
const adminKey = serverAdminKey(process.env);
const webKey = cloudWebKey(process.env);
const webUrl = cloudWebUrl(process.env, webKey !== undefined);
const developmentAgentKey = developmentCredentialsEnabled(process.env)
  ? (process.env.ODYSHELL_AGENT_KEY ?? "dev-agent-key")
  : undefined;

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
await app.register(websocket, { options: { maxPayload: 2 * 1024 * 1024 } });

const db = createDatabase(process.env);
await db.initialize();
const retention = dataRetentionPolicy(process.env);
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
  kind: "agent" | "cli" | "development" | "session";
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
const requestAdminWorkspaces = new WeakMap<FastifyRequest, string>();
const requestAdminPrincipals = new WeakMap<FastifyRequest, string>();
const deviceStartLimiter = new FixedWindowRateLimiter(12, 60_000);
const devicePollLimiter = new FixedWindowRateLimiter(40, 60_000);
const enrollmentIssuanceLimiter = new ScopedRateLimiter(
  60,
  20,
  60 * 60_000,
);
const agentAccessIssuanceLimiter = new ScopedRateLimiter(
  120,
  40,
  60 * 60_000,
);
const sessionRequestLimiter = new ScopedRateLimiter(120, 20, 60 * 60_000);
const liveTokenIssuanceLimiter = new ScopedRateLimiter(300, 30, 60_000);
const liveTokenReplayGuard = new CloudLiveTokenReplayGuard();
const liveStreamLimiter = new ScopedConcurrencyLimiter(100, 4);
const cloudPingLimiter = new ScopedRateLimiter(120, 30, 60_000);
const machinePingLimiter = new FixedWindowRateLimiter(12, 60_000);
const pingConcurrencyLimiter = new ScopedConcurrencyLimiter(20, 3);

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
    const principal = await db.findAgentByTokenHash(hashToken(token));
    if (principal) {
      requestPrincipals.set(request, {
        kind: "agent",
        id: principal.id,
        name: principal.name,
        workspaceId: principal.workspaceId,
        machineIds: new Set(principal.machineIds),
        capabilities: new Set(principal.capabilities),
        expiresAt: new Date(principal.expiresAt),
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
        machineId: sessionPrincipal.machineId,
        readPath: sessionPrincipal.readPath,
        expiresAt: sessionPrincipal.expiresAt,
      };
      requestPrincipals.set(request, {
        kind: "session",
        id: sessionPrincipal.agentId,
        name: sessionPrincipal.agentName,
        workspaceId: sessionPrincipal.workspaceId,
        machineIds: new Set([sessionPrincipal.machineId]),
        capabilities: new Set(["fs.read"]),
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

async function expireAgentSessions(
  workspaceId: string,
  principalId: string,
  reason: string,
): Promise<number> {
  const expired = await db.expireAgentSessions(workspaceId, principalId);
  for (const session of expired) {
    gateway.send(session.machineId, {
      type: "session.close",
      sessionId: session.id,
      reason,
    });
  }
  return expired.length;
}

function agentAccessView(token: AgentTokenRecord): {
  id: string;
  name: string;
  machineIds: string[];
  capabilities: Capability[];
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string | null;
  status: "active" | "expired" | "revoked";
} {
  return {
    id: token.id,
    name: token.name,
    machineIds: token.machineIds,
    capabilities: token.capabilities,
    expiresAt: isoTimestamp(token.expiresAt),
    revokedAt: isoTimestamp(token.revokedAt),
    createdAt: isoTimestamp(token.createdAt),
    status:
      token.revokedAt !== undefined
        ? "revoked"
        : token.expiresAt <= Date.now()
          ? "expired"
          : "active",
  };
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

const agentAccessDependencies: AgentAccessDependencies = {
  activeMachinesExist: (workspaceId, machineIds) =>
    db.activeMachinesExist(workspaceId, machineIds),
  createAgentToken: (input) => db.createAgentToken(input),
  revokeAgentToken: (workspaceId, tokenId) =>
    db.revokeAgentToken(workspaceId, tokenId),
  deleteAgentToken: async (workspaceId, tokenId) => {
    const deletion = await db.deleteAgentToken(workspaceId, tokenId);
    if (!deletion) return null;
    for (const session of deletion.sessions) {
      gateway.send(session.machineId, {
        type: "session.close",
        sessionId: session.id,
        reason: "agent_token_deleted",
      });
    }
    return {
      token: deletion.token,
      closedSessions: deletion.sessions.length,
    };
  },
  expireAgentSessions,
  audit: async (workspaceId, principalId, action, targetType, targetId, metadata) => {
    await audit(
      db,
      workspaceId,
      principalId,
      action,
      targetType,
      targetId,
      metadata,
    );
    gateway.notifyWorkspace(workspaceId);
  },
  createId: randomUUID,
  createToken: () => createOpaqueToken("agent"),
  hashToken,
  now: Date.now,
};

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

app.get("/health", async () => {
  await db.health();
  return { status: "ok", protocol: 1 };
});

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
    const [machines, usage, connections, agentAccess, controlEvents] = await Promise.all([
      db.listMachines(context.workspace.id),
      db.workspacePlan(context.workspace.id),
      db.workspaceConnections(context.workspace.id),
      db.listAgentTokens(context.workspace.id),
      db.listAudit(context.workspace.id, 50),
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
            agentAccess.find((agent) => agent.id === connection.principalId)
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
      })),
      agentAccess: agentAccess.map(agentAccessView),
      controlEvents: controlEvents.map(controlEventView),
    };
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
      hashToken(parsed.data.approvalCode),
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
      machine: {
        id: sessionRequest.machineId,
        name: sessionRequest.machineName,
      },
      purpose: sessionRequest.purpose,
      capability: "fs.read",
      path: sessionRequest.readPath,
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
      approvalCodeHash: hashToken(parsed.data.approvalCode),
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
    gateway.notifyWorkspace(context.workspace.id);
    return { approved: true, requestId: result.request.id };
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
    await db.createEnrollmentToken(context.workspace.id, hashToken(token), expiresAt);
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
  async (request, reply) => {
    const parsed = createCloudAgentAccessSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
    }
    const context = await db.ensureCloudContext({
      externalId: parsed.data.organization.externalId,
      slug: parsed.data.organization.slug,
      name: parsed.data.organization.name,
    });
    if (
      !agentAccessIssuanceLimiter.allow(
        context.workspace.id,
        parsed.data.userId,
      )
    ) {
      return reply
        .code(429)
        .send({ error: "agent_access_issuance_rate_limited" });
    }
    const result = await createAgentAccess(
      agentAccessDependencies,
      context.workspace.id,
      parsed.data.userId,
      parsed.data,
    );
    if (result.status === "unknown_machine") {
      return reply.code(400).send({ error: "unknown_machine" });
    }
    if (result.status === "limit_reached") {
      return reply.code(409).send({
        error: "agent_token_limit_reached",
        details: {
          plan: result.plan,
          activeAgentLimit: result.activeAgentLimit,
        },
      });
    }
    return reply.code(201).send(result.access);
  },
);

app.post(
  "/v1/internal/cloud/agent-access/revoke",
  { preHandler: requireWeb },
  async (request, reply) => {
    const parsed = revokeCloudAgentAccessSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
    }
    const context = await db.ensureCloudContext({
      externalId: parsed.data.organization.externalId,
      slug: parsed.data.organization.slug,
      name: parsed.data.organization.name,
    });
    const result = await revokeAgentAccess(
      agentAccessDependencies,
      context.workspace.id,
      parsed.data.userId,
      parsed.data.tokenId,
    );
    if (!result) return reply.code(404).send({ error: "agent_token_not_found" });
    return result;
  },
);

app.post(
  "/v1/internal/cloud/agent-access/delete",
  { preHandler: requireWeb },
  async (request, reply) => {
    const parsed = deleteCloudAgentAccessSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
    }
    const context = await db.ensureCloudContext({
      externalId: parsed.data.organization.externalId,
      slug: parsed.data.organization.slug,
      name: parsed.data.organization.name,
    });
    const result = await deleteAgentAccess(
      agentAccessDependencies,
      context.workspace.id,
      parsed.data.userId,
      parsed.data.tokenId,
    );
    if (!result) return reply.code(404).send({ error: "agent_token_not_found" });
    return result;
  },
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
    await db.createEnrollmentToken(workspaceId, hashToken(token), expiresAt.getTime());
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
  async (request) => {
    const tokens = await db.listAgentTokens(adminWorkspaceFor(request));
    return {
      data: tokens.map(agentAccessView),
    };
  },
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
      })),
    };
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

app.post("/v1/admin/agent-tokens", {
  preHandler: requireWorkspaceAccess,
}, async (request, reply) => {
  const workspaceId = adminWorkspaceFor(request);
  const parsed = agentTokenRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
  }

  const result = await createAgentAccess(
    agentAccessDependencies,
    workspaceId,
    adminPrincipalFor(request),
    parsed.data,
  );
  if (result.status === "unknown_machine") {
    return reply.code(400).send({ error: "unknown_machine" });
  }
  if (result.status === "limit_reached") {
    return reply.code(409).send({
      error: "agent_token_limit_reached",
      details: {
        plan: result.plan,
        activeAgentLimit: result.activeAgentLimit,
      },
    });
  }
  return reply.code(201).send(result.access);
});

app.delete<{ Params: { tokenId: string } }>(
  "/v1/admin/agent-tokens/:tokenId",
  { preHandler: requireWorkspaceAccess },
  async (request, reply) => {
    const workspaceId = adminWorkspaceFor(request);
    const result = await revokeAgentAccess(
      agentAccessDependencies,
      workspaceId,
      adminPrincipalFor(request),
      request.params.tokenId,
    );
    if (!result) return reply.code(404).send({ error: "agent_token_not_found" });
    return result;
  },
);

app.post("/v1/clients/enroll", async (request, reply) => {
  const body = request.body as { token?: string; name?: string; publicKey?: string };
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

  const machineId = randomUUID();
  const enrolled = await db.enrollMachine({
    tokenHash: hashToken(body.token),
    machineId,
    name: body.name,
    publicKey: body.publicKey,
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
  await audit(
    db,
    enrolled.workspaceId,
    "client-enrollment",
    "machine.enrolled",
    "machine",
    machineId,
    { name: body.name },
  );
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
  { preHandler: requireCli },
  async (request, reply) => {
    if (!webUrl) {
      return reply
        .code(503)
        .send({ error: "session_approval_unavailable" });
    }
    const parsed = agentSessionRequestInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", details: parsed.error.issues });
    }
    const principal = cliPrincipalFor(request);
    if (
      !sessionRequestLimiter.allow(principal.workspaceId, principal.userId)
    ) {
      return reply
        .code(429)
        .send({ error: "session_request_rate_limited" });
    }
    if (!gateway.isOnline(parsed.data.machineId)) {
      return reply.code(409).send({ error: "machine_offline" });
    }
    const requestId = randomUUID();
    const approvalCode = createOpaqueToken("approval");
    const expiresAt = Date.now() + 10 * 60 * 1_000;
    const created = await db.createAgentSessionRequest({
      workspaceId: principal.workspaceId,
      requestId,
      agentId: parsed.data.agentId,
      agentName: parsed.data.agentName,
      humanId: principal.userId,
      machineId: parsed.data.machineId,
      purpose: parsed.data.purpose,
      readPath: parsed.data.path,
      durationSeconds: parsed.data.durationSeconds,
      approvalCodeHash: hashToken(approvalCode),
      expiresAt,
    });
    if (!created) {
      return reply.code(403).send({ error: "agent_or_machine_denied" });
    }
    await audit(
      db,
      principal.workspaceId,
      parsed.data.agentId,
      "session.requested",
      "session_request",
      requestId,
      {
        machineId: parsed.data.machineId,
        kind: "fs.read",
        durationSeconds: parsed.data.durationSeconds,
      },
    );
    gateway.notifyWorkspace(principal.workspaceId);
    return reply.code(201).send({
      id: requestId,
      status: "pending",
      approvalUrl: `${webUrl}/sessions/approve?code=${encodeURIComponent(approvalCode)}`,
      expiresAt: isoTimestamp(expiresAt),
    });
  },
);

app.post<{ Params: { requestId: string } }>(
  "/v1/agent-session-requests/:requestId/status",
  { preHandler: requireCli },
  async (request, reply) => {
    const parsed = agentSessionRequestInputSchema
      .pick({ agentId: true })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", details: parsed.error.issues });
    }
    const principal = cliPrincipalFor(request);
    const sessionRequest = await db.getAgentSessionRequest(
      principal.workspaceId,
      request.params.requestId,
      parsed.data.agentId,
      principal.userId,
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
  { preHandler: requireCli },
  async (request, reply) => {
    const parsed = agentSessionRequestInputSchema
      .pick({ agentId: true })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", details: parsed.error.issues });
    }
    const principal = cliPrincipalFor(request);
    const current = await db.getAgentSessionRequest(
      principal.workspaceId,
      request.params.requestId,
      parsed.data.agentId,
      principal.userId,
    );
    if (!current) {
      return reply.code(404).send({ error: "session_request_not_found" });
    }
    if (!gateway.isOnline(current.machineId)) {
      return reply.code(409).send({ error: "machine_offline" });
    }
    const sessionToken = createOpaqueToken("session");
    const result = await db.claimAgentSessionRequest({
      workspaceId: principal.workspaceId,
      requestId: request.params.requestId,
      agentId: parsed.data.agentId,
      humanId: principal.userId,
      sessionId: randomUUID(),
      credentialId: randomUUID(),
      credentialHash: hashToken(sessionToken),
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
    const sent = gateway.send(result.machineId, {
      type: "session.open",
      sessionId: result.session.id,
      profile: "workspace",
      capabilities: ["fs.read"],
      expiresAt: new Date(result.session.expiresAt).toISOString(),
    });
    if (!sent) {
      await db.failClaimedAgentSession(
        principal.workspaceId,
        result.session.id,
        result.machineId,
        "machine_disconnected",
      );
      return reply.code(409).send({ error: "machine_disconnected" });
    }
    gateway.notifyWorkspace(principal.workspaceId);
    return reply.code(201).send({
      sessionId: result.session.id,
      sessionToken,
      machineId: result.machineId,
      path: result.readPath,
      status: "opening",
      expiresAt: isoTimestamp(result.session.expiresAt),
    });
  },
);

app.post<{ Params: { sessionId: string } }>(
  "/v1/agent-sessions/:sessionId/timeline",
  { preHandler: requireCli },
  async (request, reply) => {
    const parsed = agentSessionRequestInputSchema
      .pick({ agentId: true })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", details: parsed.error.issues });
    }
    const principal = cliPrincipalFor(request);
    const events = await db.listSessionTimeline(
      principal.workspaceId,
      request.params.sessionId,
      parsed.data.agentId,
      principal.userId,
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

app.get("/v1/sessions", { preHandler: requireAgent }, async (request) => {
  const principal = principalFor(request);
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

app.post("/v1/sessions", { preHandler: requireAgent }, async (request, reply) => {
  const principal = principalFor(request);
  if (principal.kind === "session") {
    return reply.code(403).send({ error: "session_scope_denied" });
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
    requireActiveAgentToken: principal.kind === "agent",
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
    if (
      principal.sessionScope !== undefined &&
      request.params.sessionId !== principal.sessionScope.sessionId
    ) {
      return reply.code(404).send({ error: "session_not_found" });
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
    if (
      principal.sessionScope !== undefined &&
      request.params.sessionId !== principal.sessionScope.sessionId
    ) {
      return reply.code(404).send({ error: "active_session_not_found" });
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
  "/v1/sessions/:sessionId/operations",
  { preHandler: requireAgent },
  async (request, reply) => {
    const principal = principalFor(request);
    const parsed = operationRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
    }
    if (principal.sessionScope !== undefined) {
      const decision = sessionOperationDecision(
        principal.sessionScope,
        request.params.sessionId,
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
        return reply.code(status).send({ error: decision.code });
      }
    }
    const idempotencyKey = request.headers["idempotency-key"] as string | undefined;
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
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    });
    if (!created && idempotencyKey) {
      const existing = await db.findOperationByIdempotency(
        principal.workspaceId,
        request.params.sessionId,
        principal.id,
        idempotencyKey,
      );
      if (existing) return reply.code(200).send({ id: existing.id, status: existing.status });
      throw new Error("Idempotency conflict did not resolve to an operation");
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
    const expired = await db.expireSessions();
    for (const session of expired) {
      gateway.send(session.machineId, {
        type: "session.close",
        sessionId: session.id,
        reason: "expired",
      });
    }
  })().catch((error: unknown) => app.log.error(error, "Session expiry sweep failed"));
}, 60_000);

const retentionTimer = setInterval(() => {
  void purgeExpiredData().catch((error: unknown) =>
    app.log.error(error, "Data retention sweep failed"),
  );
}, 15 * 60_000);

app.addHook("onClose", async () => {
  clearInterval(expiryTimer);
  clearInterval(retentionTimer);
  await db.close();
});

await app.listen({ port, host });
