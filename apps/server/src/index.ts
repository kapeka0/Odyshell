import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
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
import { audit, createDatabase, migrate } from "./database.js";
import { ClientGateway } from "./gateway.js";

const port = Number(process.env.PORT ?? 4100);
const host = process.env.HOST ?? "127.0.0.1";
const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://odyshell:odyshell@127.0.0.1:55432/odyshell";
const adminKey = process.env.ODYSHELL_ADMIN_KEY ?? "dev-admin-key";
const developmentAgentKey = process.env.ODYSHELL_AGENT_KEY ?? "dev-agent-key";

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
await app.register(websocket, { options: { maxPayload: 2 * 1024 * 1024 } });

const db = createDatabase(databaseUrl);
await migrate(db);
await db.query(`UPDATE machines SET status = 'offline' WHERE status <> 'offline'`);
const gateway = new ClientGateway(db);
gateway.register(app);

type AgentPrincipal = {
  id: string;
  name: string;
  machineIds: Set<string> | null;
  capabilities: Set<Capability>;
};

const requestPrincipals = new WeakMap<FastifyRequest, AgentPrincipal>();

function matchesSecret(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
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
    });
    return;
  }

  if (token) {
    const result = await db.query<{
      id: string;
      name: string;
      machine_ids: string[];
      capabilities: Capability[];
    }>(
      `SELECT id, name, machine_ids, capabilities
       FROM agent_tokens
       WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [hashToken(token)],
    );
    const principal = result.rows[0];
    if (principal) {
      requestPrincipals.set(request, {
        id: principal.id,
        name: principal.name,
        machineIds: new Set(principal.machine_ids),
        capabilities: new Set(principal.capabilities),
      });
      return;
    }
  }

  await reply.code(401).send({ error: "invalid_or_expired_agent_token" });
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
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

app.get("/health", async () => {
  await db.query("SELECT 1");
  return { status: "ok", protocol: 1 };
});

app.post(
  "/v1/admin/enrollment-tokens",
  { preHandler: requireAdmin },
  async (request, reply) => {
    const body = (request.body ?? {}) as { expiresInSeconds?: number };
    const expiresInSeconds = Math.min(Math.max(body.expiresInSeconds ?? 600, 60), 86_400);
    const token = `ody_enroll_${randomBytes(32).toString("base64url")}`;
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
    await db.query(
      `INSERT INTO enrollment_tokens (token_hash, expires_at) VALUES ($1, $2)`,
      [hashToken(token), expiresAt],
    );
    await audit(db, "admin", "enrollment_token.created", "enrollment_token", hashToken(token));
    return reply.code(201).send({ token, expiresAt: expiresAt.toISOString() });
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
  const machines = await db.query<{ id: string }>(
    `SELECT id FROM machines WHERE id = ANY($1::uuid[])`,
    [uniqueMachineIds],
  );
  if (machines.rowCount !== uniqueMachineIds.length) {
    return reply.code(400).send({ error: "unknown_machine" });
  }

  const id = randomUUID();
  const token = `ody_agent_${randomBytes(32).toString("base64url")}`;
  const expiresAt = new Date(Date.now() + input.expiresInSeconds * 1000);
  await db.query(
    `INSERT INTO agent_tokens
       (id, name, token_hash, machine_ids, capabilities, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      input.name,
      hashToken(token),
      JSON.stringify(uniqueMachineIds),
      JSON.stringify(uniqueCapabilities),
      expiresAt,
    ],
  );
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

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const tokenResult = await client.query(
      `SELECT token_hash FROM enrollment_tokens
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
       FOR UPDATE`,
      [hashToken(body.token)],
    );
    if (tokenResult.rowCount !== 1) {
      await client.query("ROLLBACK");
      return reply.code(401).send({ error: "invalid_or_expired_enrollment_token" });
    }
    const machineId = randomUUID();
    await client.query(
      `INSERT INTO machines (id, name, public_key) VALUES ($1, $2, $3)`,
      [machineId, body.name, body.publicKey],
    );
    await client.query(`UPDATE enrollment_tokens SET used_at = now() WHERE token_hash = $1`, [
      hashToken(body.token),
    ]);
    await client.query("COMMIT");
    await audit(db, "client-enrollment", "machine.enrolled", "machine", machineId, {
      name: body.name,
    });
    return reply.code(201).send({ machineId, name: body.name });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

app.get("/v1/machines", { preHandler: requireAgent }, async (request) => {
  const principal = principalFor(request);
  const result =
    principal.machineIds === null
      ? await db.query(
          `SELECT id, name, status, runtime_info AS runtime,
                  last_seen_at AS "lastSeenAt", enrolled_at AS "enrolledAt"
           FROM machines ORDER BY enrolled_at`,
        )
      : await db.query(
          `SELECT id, name, status, runtime_info AS runtime,
                  last_seen_at AS "lastSeenAt", enrolled_at AS "enrolledAt"
           FROM machines WHERE id = ANY($1::uuid[]) ORDER BY enrolled_at`,
          [[...principal.machineIds]],
        );
  return {
    data: result.rows.map((row) => ({ ...row, online: gateway.isOnline(row.id as string) })),
  };
});

app.get("/v1/sessions", { preHandler: requireAgent }, async (request) => {
  const principal = principalFor(request);
  const result = await db.query(
    `SELECT s.id, s.machine_id AS "machineId", m.name AS "machineName", s.profile,
            s.capabilities, s.status, s.expires_at AS "expiresAt", s.error,
            s.created_at AS "createdAt"
     FROM sessions s
     JOIN machines m ON m.id = s.machine_id
     WHERE s.principal_id = $1
     ORDER BY s.created_at DESC
     LIMIT 100`,
    [principal.id],
  );
  return { data: result.rows };
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
  const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);
  await db.query(
    `INSERT INTO sessions
       (id, machine_id, principal_id, profile, capabilities, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'opening', $6)`,
    [
      sessionId,
      input.machineId,
      principal.id,
      input.profile,
      JSON.stringify(input.capabilities),
      expiresAt,
    ],
  );
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
    const result = await db.query(
      `SELECT id, machine_id AS "machineId", profile, capabilities, status,
              expires_at AS "expiresAt", error, created_at AS "createdAt"
       FROM sessions WHERE id = $1 AND principal_id = $2`,
      [request.params.sessionId, principal.id],
    );
    if (!result.rows[0]) return reply.code(404).send({ error: "session_not_found" });
    return result.rows[0];
  },
);

app.delete<{ Params: { sessionId: string } }>(
  "/v1/sessions/:sessionId",
  { preHandler: requireAgent },
  async (request, reply) => {
    const principal = principalFor(request);
    const result = await db.query<{ machine_id: string }>(
      `SELECT machine_id FROM sessions
       WHERE id = $1 AND principal_id = $2 AND status IN ('opening', 'ready')`,
      [request.params.sessionId, principal.id],
    );
    const session = result.rows[0];
    if (!session) return reply.code(404).send({ error: "active_session_not_found" });
    gateway.send(session.machine_id, {
      type: "session.close",
      sessionId: request.params.sessionId,
      reason: "agent_request",
    });
    await db.query(`UPDATE sessions SET status = 'closing', updated_at = now() WHERE id = $1`, [
      request.params.sessionId,
    ]);
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
      const existing = await db.query(
        `SELECT id, status FROM operations
         WHERE principal_id = $1 AND idempotency_key = $2`,
        [principal.id, idempotencyKey],
      );
      if (existing.rows[0]) return reply.code(200).send(existing.rows[0]);
    }

    const sessionResult = await db.query<{
      machine_id: string;
      capabilities: Capability[];
      expires_at: Date;
      status: string;
    }>(
      `SELECT machine_id, capabilities, expires_at, status
       FROM sessions WHERE id = $1 AND principal_id = $2`,
      [request.params.sessionId, principal.id],
    );
    const session = sessionResult.rows[0];
    if (!session) return reply.code(404).send({ error: "session_not_found" });
    if (session.status !== "ready") {
      return reply.code(409).send({ error: "session_not_ready", status: session.status });
    }
    if (session.expires_at.getTime() <= Date.now()) {
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
    if (!gateway.isOnline(session.machine_id)) {
      return reply.code(409).send({ error: "machine_offline" });
    }

    const operationId = randomUUID();
    await db.query(
      `INSERT INTO operations
       (id, session_id, principal_id, action, status, timeout_seconds, max_output_bytes, idempotency_key)
       VALUES ($1, $2, $3, $4, 'queued', $5, $6, $7)`,
      [
        operationId,
        request.params.sessionId,
        principal.id,
        JSON.stringify(parsed.data.action),
        parsed.data.timeoutSeconds,
        parsed.data.maxOutputBytes,
        idempotencyKey ?? null,
      ],
    );
    const sent = gateway.send(session.machine_id, {
      type: "operation.start",
      operationId,
      sessionId: request.params.sessionId,
      action: parsed.data.action,
      timeoutSeconds: parsed.data.timeoutSeconds,
      maxOutputBytes: parsed.data.maxOutputBytes,
    });
    if (sent) {
      await db.query(`UPDATE operations SET status = 'delivered', updated_at = now() WHERE id = $1`, [
        operationId,
      ]);
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
    const result = await db.query(
      `SELECT id, session_id AS "sessionId", action, status, exit_code AS "exitCode",
              error, output_truncated AS "outputTruncated",
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM operations WHERE id = $1 AND principal_id = $2`,
      [request.params.operationId, principal.id],
    );
    const operation = result.rows[0];
    if (!operation) return reply.code(404).send({ error: "operation_not_found" });
    const events = await db.query(
      `SELECT sequence, stream, encode(data, 'base64') AS "dataBase64", created_at AS "createdAt"
       FROM operation_events WHERE operation_id = $1 ORDER BY sequence`,
      [request.params.operationId],
    );
    return { ...operation, events: events.rows };
  },
);

app.post<{ Params: { operationId: string } }>(
  "/v1/operations/:operationId/cancel",
  { preHandler: requireAgent },
  async (request, reply) => {
    const principal = principalFor(request);
    const result = await db.query<{ machine_id: string; status: string }>(
      `SELECT s.machine_id, o.status
       FROM operations o JOIN sessions s ON s.id = o.session_id
       WHERE o.id = $1 AND o.principal_id = $2`,
      [request.params.operationId, principal.id],
    );
    const operation = result.rows[0];
    if (!operation) return reply.code(404).send({ error: "operation_not_found" });
    if (!["queued", "delivered", "running"].includes(operation.status)) {
      return reply.code(409).send({ error: "operation_not_cancellable", status: operation.status });
    }
    gateway.send(operation.machine_id, {
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
    const found = await db.query(
      `SELECT 1 FROM operations WHERE id = $1 AND principal_id = $2`,
      [request.params.operationId, principal.id],
    );
    if (!found.rowCount) return reply.code(404).send({ error: "operation_not_found" });

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    let lastSequence = Number(request.query.after ?? -1);
    const emitRows = async (): Promise<void> => {
      const rows = await db.query(
        `SELECT sequence, stream, encode(data, 'base64') AS "dataBase64"
         FROM operation_events WHERE operation_id = $1 AND sequence > $2 ORDER BY sequence`,
        [request.params.operationId, lastSequence],
      );
      for (const row of rows.rows) {
        lastSequence = row.sequence as number;
        reply.raw.write(`id: ${lastSequence}\nevent: output\ndata: ${JSON.stringify(row)}\n\n`);
      }
      const state = await db.query(`SELECT status FROM operations WHERE id = $1`, [
        request.params.operationId,
      ]);
      const status = state.rows[0]?.status as string | undefined;
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
    const result = await db.query(
      `SELECT id, principal_id AS "principalId", action,
              target_type AS "targetType", target_id AS "targetId",
              metadata, created_at AS "createdAt"
       FROM audit_events
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit],
    );
    return {
      principal: { id: "admin", name: "All agents" },
      data: result.rows,
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
    const result = await db.query(
      `SELECT id, principal_id AS "principalId", action,
              target_type AS "targetType", target_id AS "targetId",
              metadata, created_at AS "createdAt"
       FROM audit_events
       WHERE principal_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [principal.id, limit],
    );
    return {
      principal: { id: principal.id, name: principal.name },
      data: result.rows,
    };
  },
);

const expiryTimer = setInterval(() => {
  void (async () => {
    const expired = await db.query<{ id: string; machine_id: string }>(
      `UPDATE sessions SET status = 'expired', updated_at = now()
       WHERE status IN ('opening', 'ready') AND expires_at <= now()
       RETURNING id, machine_id`,
    );
    for (const session of expired.rows) {
      gateway.send(session.machine_id, {
        type: "session.close",
        sessionId: session.id,
        reason: "expired",
      });
    }
  })().catch((error: unknown) => app.log.error(error, "Session expiry sweep failed"));
}, 1_000);

app.addHook("onClose", async () => {
  clearInterval(expiryTimer);
  await db.end();
});

await app.listen({ port, host });
