import { createHash, createPublicKey, randomUUID, timingSafeEqual } from "node:crypto";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import {
  agentTokenRequestSchema,
  allCapabilities,
  capabilityForAction,
  operationRequestSchema,
  sessionRequestSchema,
  type Capability,
  type OperationAction,
} from "@odyshell/protocol";
import {
  boundedSessionExpiry,
  createOpaqueToken,
  developmentCredentialsEnabled,
  serverAdminKey,
} from "./access.js";
import { audit, createDatabase } from "./database.js";
import { ClientGateway } from "./gateway.js";

const port = Number(process.env.PORT ?? 4100);
const host = process.env.HOST ?? "127.0.0.1";
const adminKey = serverAdminKey(process.env);
const developmentAgentKey = developmentCredentialsEnabled(process.env)
  ? (process.env.ODYSHELL_AGENT_KEY ?? "dev-agent-key")
  : undefined;

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
await app.register(websocket, { options: { maxPayload: 2 * 1024 * 1024 } });

const db = createDatabase(process.env);
await db.initialize();
const gateway = new ClientGateway(db);
gateway.register(app);

type AgentPrincipal = {
  id: string;
  name: string;
  machineIds: Set<string> | null;
  capabilities: Set<Capability>;
  expiresAt: Date | null;
};

const requestPrincipals = new WeakMap<FastifyRequest, AgentPrincipal>();

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

async function requireAgent(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const authorization = request.headers.authorization;
  const bearerToken =
    typeof authorization === "string"
      ? /^Bearer\s+(.+)$/i.exec(authorization)?.[1]
      : undefined;
  const legacyHeader = request.headers["x-odyshell-agent-key"];
  const token = bearerToken ?? (typeof legacyHeader === "string" ? legacyHeader : undefined);

  if (matchesSecret(token, developmentAgentKey)) {
    requestPrincipals.set(request, {
      id: "dev-agent",
      name: "Development agent",
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
        id: principal.id,
        name: principal.name,
        machineIds: new Set(principal.machineIds),
        capabilities: new Set(principal.capabilities),
        expiresAt: new Date(principal.expiresAt),
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

function canAccessMachine(principal: AgentPrincipal, machineId: string): boolean {
  return principal.machineIds === null || principal.machineIds.has(machineId);
}

function operationAuditMetadata(action: OperationAction): Record<string, unknown> {
  switch (action.kind) {
    case "process.exec":
      return {
        kind: action.kind,
        program: action.program,
        args: action.args,
        cwd: action.cwd,
        environmentKeys: Object.keys(action.env),
      };
    case "process.shell":
      return {
        kind: action.kind,
        command: action.command,
        cwd: action.cwd,
        environmentKeys: Object.keys(action.env),
      };
    case "fs.write":
      return {
        kind: action.kind,
        path: action.path,
        bytes: Buffer.from(action.contentBase64, "base64").length,
        createParents: action.createParents,
      };
    case "fs.search":
      return {
        kind: action.kind,
        path: action.path,
        query: action.query,
        maxResults: action.maxResults,
      };
    case "docker.logs":
      return {
        kind: action.kind,
        container: action.container,
        tail: action.tail,
        timestamps: action.timestamps,
      };
    default:
      return { ...action };
  }
}

async function expireAgentSessions(principalId: string, reason: string): Promise<number> {
  const expired = await db.expireAgentSessions(principalId);
  for (const session of expired) {
    gateway.send(session.machineId, {
      type: "session.close",
      sessionId: session.id,
      reason,
    });
  }
  return expired.length;
}

app.get("/health", async () => {
  await db.health();
  return { status: "ok", protocol: 1 };
});

app.post(
  "/v1/admin/enrollment-tokens",
  { preHandler: requireAdmin },
  async (request, reply) => {
    const body = (request.body ?? {}) as { expiresInSeconds?: number };
    const expiresInSeconds = Math.min(Math.max(body.expiresInSeconds ?? 600, 60), 86_400);
    const token = createOpaqueToken("enroll");
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
    await db.createEnrollmentToken(hashToken(token), expiresAt.getTime());
    await audit(db, "admin", "enrollment_token.created", "enrollment_token", hashToken(token));
    return reply.code(201).send({ token, expiresAt: expiresAt.toISOString() });
  },
);

app.get("/v1/admin/agent-tokens", { preHandler: requireAdmin }, async () => {
  const tokens = await db.listAgentTokens();
  return {
    data: tokens.map((token) => ({
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
    })),
  };
});

app.get("/v1/admin/machines", { preHandler: requireAdmin }, async () => {
  const machines = await db.listMachines({ includeRevoked: true });
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
});

app.delete<{ Params: { machineId: string } }>(
  "/v1/admin/machines/:machineId",
  { preHandler: requireAdmin },
  async (request, reply) => {
    const machine = await db.revokeMachine(request.params.machineId);
    if (!machine) return reply.code(404).send({ error: "active_machine_not_found" });

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
    await audit(db, "admin", "machine.revoked", "machine", machine.id, {
      name: machine.name,
      revokedAt: isoTimestamp(machine.revokedAt),
      cancelledOperations: machine.operationIds.length,
      closedSessions: machine.sessionIds.length,
      disconnected,
    });
    return {
      id: machine.id,
      name: machine.name,
      status: "revoked",
      revokedAt: isoTimestamp(machine.revokedAt),
      cancelledOperations: machine.operationIds.length,
      closedSessions: machine.sessionIds.length,
      disconnected,
    };
  },
);

app.post("/v1/admin/agent-tokens", { preHandler: requireAdmin }, async (request, reply) => {
  const parsed = agentTokenRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
  }

  const input = parsed.data;
  const uniqueMachineIds = [...new Set(input.machineIds)];
  const uniqueCapabilities = [...new Set(input.capabilities)];
  if (!(await db.activeMachinesExist(uniqueMachineIds))) {
    return reply.code(400).send({ error: "unknown_machine" });
  }

  const id = randomUUID();
  const token = createOpaqueToken("agent");
  const expiresAt = new Date(Date.now() + input.expiresInSeconds * 1000);
  await db.createAgentToken({
    id,
    name: input.name,
    tokenHash: hashToken(token),
    machineIds: uniqueMachineIds,
    capabilities: uniqueCapabilities,
    expiresAt: expiresAt.getTime(),
  });
  await audit(db, "admin", "agent_token.created", "agent_token", id, {
    name: input.name,
    machineIds: uniqueMachineIds,
    capabilities: uniqueCapabilities,
    expiresAt: expiresAt.toISOString(),
  });
  return reply.code(201).send({
    id,
    name: input.name,
    token,
    machineIds: uniqueMachineIds,
    capabilities: uniqueCapabilities,
    expiresAt: expiresAt.toISOString(),
  });
});

app.delete<{ Params: { tokenId: string } }>(
  "/v1/admin/agent-tokens/:tokenId",
  { preHandler: requireAdmin },
  async (request, reply) => {
    const token = await db.revokeAgentToken(request.params.tokenId);
    if (!token) return reply.code(404).send({ error: "agent_token_not_found" });

    const closedSessions = await expireAgentSessions(token.id, "agent_token_revoked");
    await audit(db, "admin", "agent_token.revoked", "agent_token", token.id, {
      name: token.name,
      revokedAt: isoTimestamp(token.revokedAt),
      closedSessions,
    });
    return {
      id: token.id,
      name: token.name,
      status: "revoked",
      revokedAt: isoTimestamp(token.revokedAt),
      closedSessions,
    };
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
  await audit(db, "client-enrollment", "machine.enrolled", "machine", machineId, {
    name: body.name,
  });
  return reply.code(201).send(enrolled);
});

app.get("/v1/machines", { preHandler: requireAgent }, async (request) => {
  const principal = principalFor(request);
  const machines = await db.listMachines({
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
    if (!canAccessMachine(principal, request.params.machineId)) {
      await audit(db, principal.id, "machine.ping_denied", "machine", request.params.machineId, {
        reason: "machine_scope",
      });
      return reply.code(403).send({ error: "machine_denied" });
    }
    if (!gateway.isOnline(request.params.machineId)) {
      return reply.code(409).send({ error: "machine_offline" });
    }
    try {
      const latencyMs = await gateway.ping(request.params.machineId);
      await audit(db, principal.id, "machine.ping", "machine", request.params.machineId, {
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

app.get("/v1/sessions", { preHandler: requireAgent }, async (request) => {
  const principal = principalFor(request);
  const sessions = await db.listSessions(principal.id);
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
  const parsed = sessionRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
  }
  const input = parsed.data;
  if (!canAccessMachine(principal, input.machineId)) {
    await audit(db, principal.id, "session.denied", "machine", input.machineId, {
      reason: "machine_scope",
    });
    return reply.code(403).send({ error: "machine_denied" });
  }
  const deniedCapability = input.capabilities.find(
    (capability) => !principal.capabilities.has(capability),
  );
  if (deniedCapability) {
    await audit(db, principal.id, "session.denied", "machine", input.machineId, {
      reason: "capability_scope",
      capability: deniedCapability,
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
  await db.createSession({
    id: sessionId,
    machineId: input.machineId,
    principalId: principal.id,
    profile: input.profile,
    capabilities: input.capabilities,
    expiresAt: expiresAt.getTime(),
  });
  gateway.send(input.machineId, {
    type: "session.open",
    sessionId,
    profile: input.profile,
    capabilities: input.capabilities,
    expiresAt: expiresAt.toISOString(),
  });
  await audit(db, principal.id, "session.created", "session", sessionId, {
    machineId: input.machineId,
    profile: input.profile,
    capabilities: input.capabilities,
    expiresAt: expiresAt.toISOString(),
  });
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
    const session = await db.getSession(request.params.sessionId, principal.id);
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
    const session = await db.getActiveSession(request.params.sessionId, principal.id);
    if (!session) return reply.code(404).send({ error: "active_session_not_found" });
    gateway.send(session.machineId, {
      type: "session.close",
      sessionId: request.params.sessionId,
      reason: "agent_request",
    });
    await db.markSessionClosing(request.params.sessionId);
    await audit(
      db,
      principal.id,
      "session.close_requested",
      "session",
      request.params.sessionId,
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
    const idempotencyKey = request.headers["idempotency-key"] as string | undefined;
    if (idempotencyKey) {
      const existing = await db.findOperationByIdempotency(principal.id, idempotencyKey);
      if (existing) return reply.code(200).send({ id: existing.id, status: existing.status });
    }

    const session = await db.sessionForOperation(request.params.sessionId, principal.id);
    if (!session) return reply.code(404).send({ error: "session_not_found" });
    if (session.status !== "ready") {
      return reply.code(409).send({ error: "session_not_ready", status: session.status });
    }
    if (session.expiresAt <= Date.now()) {
      return reply.code(410).send({ error: "session_expired" });
    }
    const neededCapability = capabilityForAction(parsed.data.action);
    if (!session.capabilities.includes(neededCapability)) {
      await audit(db, principal.id, "operation.denied", "session", request.params.sessionId, {
        reason: "session_capability",
        capability: neededCapability,
        kind: parsed.data.action.kind,
      });
      return reply.code(403).send({ error: "capability_denied", capability: neededCapability });
    }
    if (!gateway.isOnline(session.machineId)) {
      return reply.code(409).send({ error: "machine_offline" });
    }

    const operationId = randomUUID();
    const created = await db.createOperation({
      id: operationId,
      sessionId: request.params.sessionId,
      principalId: principal.id,
      action: parsed.data.action,
      timeoutSeconds: parsed.data.timeoutSeconds,
      maxOutputBytes: parsed.data.maxOutputBytes,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    });
    if (!created && idempotencyKey) {
      const existing = await db.findOperationByIdempotency(principal.id, idempotencyKey);
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
      await db.markOperationDelivered(operationId);
    }
    await audit(db, principal.id, "operation.created", "operation", operationId, {
      sessionId: request.params.sessionId,
      operation: operationAuditMetadata(parsed.data.action),
    });
    return reply.code(202).send({ id: operationId, status: sent ? "delivered" : "queued" });
  },
);

app.get<{ Params: { operationId: string } }>(
  "/v1/operations/:operationId",
  { preHandler: requireAgent },
  async (request, reply) => {
    const principal = principalFor(request);
    const operation = await db.getOperation(request.params.operationId, principal.id);
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
    const operation = await db.getOperationTarget(request.params.operationId, principal.id);
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
      principal.id,
      "operation.cancel_requested",
      "operation",
      request.params.operationId,
    );
    return reply.code(202).send({ id: request.params.operationId, status: "cancellation_requested" });
  },
);

app.get<{ Params: { operationId: string }; Querystring: { after?: string } }>(
  "/v1/operations/:operationId/events",
  { preHandler: requireAgent },
  async (request, reply) => {
    const principal = principalFor(request);
    if (!(await db.operationExists(request.params.operationId, principal.id))) {
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
      const events = await db.listOperationEvents(request.params.operationId, lastSequence);
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
      const status = await db.operationStatus(request.params.operationId);
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
  { preHandler: requireAdmin },
  async (request) => {
    const requestedLimit = Number(request.query.limit ?? 50);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 200)
      : 50;
    const events = await db.listAudit(limit);
    return {
      principal: { id: "admin", name: "All agents" },
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
    const requestedLimit = Number(request.query.limit ?? 50);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 200)
      : 50;
    const events = await db.listAudit(limit, principal.id);
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

app.addHook("onClose", async () => {
  clearInterval(expiryTimer);
  await db.close();
});

await app.listen({ port, host });
