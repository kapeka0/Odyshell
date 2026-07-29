import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import {
  capabilityForAction,
  operationRequestSchema,
  sessionRequestSchema,
  type Capability,
} from "@odyshell/protocol";
import { audit, createDatabase, migrate } from "./database.js";
import { ConnectorGateway } from "./gateway.js";

const port = Number(process.env.PORT ?? 4100);
const host = process.env.HOST ?? "127.0.0.1";
const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://odyshell:odyshell@127.0.0.1:55432/odyshell";
const adminKey = process.env.ODYSHELL_ADMIN_KEY ?? "dev-admin-key";
const agentKey = process.env.ODYSHELL_AGENT_KEY ?? "dev-agent-key";

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
await app.register(websocket, { options: { maxPayload: 2 * 1024 * 1024 } });

const db = createDatabase(databaseUrl);
await migrate(db);
const gateway = new ConnectorGateway(db);
gateway.register(app);

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
  if (!matchesSecret(request.headers["x-odyshell-agent-key"] as string | undefined, agentKey)) {
    await reply.code(401).send({ error: "invalid_agent_key" });
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
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

app.post("/v1/connectors/enroll", async (request, reply) => {
  const body = request.body as { token?: string; name?: string; publicKey?: string };
  if (!body?.token || !body.name || !body.publicKey) {
    return reply.code(400).send({ error: "token_name_and_public_key_required" });
  }
  try {
    const key = createPublicKey(body.publicKey);
    if (key.asymmetricKeyType !== "ed25519") {
      return reply.code(400).send({ error: "connector_key_must_be_ed25519" });
    }
  } catch {
    return reply.code(400).send({ error: "invalid_connector_public_key" });
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
    await audit(db, "connector-enrollment", "machine.enrolled", "machine", machineId, {
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

app.get("/v1/machines", { preHandler: requireAgent }, async () => {
  const result = await db.query(
    `SELECT id, name, status, runtime_info AS runtime,
            last_seen_at AS "lastSeenAt", enrolled_at AS "enrolledAt"
     FROM machines ORDER BY enrolled_at`,
  );
  return {
    data: result.rows.map((row) => ({ ...row, online: gateway.isOnline(row.id as string) })),
  };
});

app.get("/v1/sessions", { preHandler: requireAgent }, async () => {
  const result = await db.query(
    `SELECT s.id, s.machine_id AS "machineId", m.name AS "machineName", s.profile,
            s.capabilities, s.status, s.expires_at AS "expiresAt", s.error,
            s.created_at AS "createdAt"
     FROM sessions s
     JOIN machines m ON m.id = s.machine_id
     WHERE s.principal_id = 'dev-agent'
     ORDER BY s.created_at DESC
     LIMIT 100`,
  );
  return { data: result.rows };
});

app.post("/v1/sessions", { preHandler: requireAgent }, async (request, reply) => {
  const parsed = sessionRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
  }
  const input = parsed.data;
  if (!gateway.isOnline(input.machineId)) {
    return reply.code(409).send({ error: "machine_offline" });
  }
  const sessionId = randomUUID();
  const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);
  await db.query(
    `INSERT INTO sessions
       (id, machine_id, principal_id, profile, capabilities, status, expires_at)
     VALUES ($1, $2, 'dev-agent', $3, $4, 'opening', $5)`,
    [sessionId, input.machineId, input.profile, JSON.stringify(input.capabilities), expiresAt],
  );
  gateway.send(input.machineId, {
    type: "session.open",
    sessionId,
    profile: input.profile,
    capabilities: input.capabilities,
    expiresAt: expiresAt.toISOString(),
  });
  await audit(db, "dev-agent", "session.created", "session", sessionId, {
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
    const result = await db.query(
      `SELECT id, machine_id AS "machineId", profile, capabilities, status,
              expires_at AS "expiresAt", error, created_at AS "createdAt"
       FROM sessions WHERE id = $1 AND principal_id = 'dev-agent'`,
      [request.params.sessionId],
    );
    if (!result.rows[0]) return reply.code(404).send({ error: "session_not_found" });
    return result.rows[0];
  },
);

app.delete<{ Params: { sessionId: string } }>(
  "/v1/sessions/:sessionId",
  { preHandler: requireAgent },
  async (request, reply) => {
    const result = await db.query<{ machine_id: string }>(
      `SELECT machine_id FROM sessions
       WHERE id = $1 AND principal_id = 'dev-agent' AND status IN ('opening', 'ready')`,
      [request.params.sessionId],
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
    await audit(db, "dev-agent", "session.close_requested", "session", request.params.sessionId);
    return reply.code(202).send({ id: request.params.sessionId, status: "closing" });
  },
);

app.post<{ Params: { sessionId: string } }>(
  "/v1/sessions/:sessionId/operations",
  { preHandler: requireAgent },
  async (request, reply) => {
    const parsed = operationRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
    }
    const idempotencyKey = request.headers["idempotency-key"] as string | undefined;
    if (idempotencyKey) {
      const existing = await db.query(
        `SELECT id, status FROM operations
         WHERE principal_id = 'dev-agent' AND idempotency_key = $1`,
        [idempotencyKey],
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
       FROM sessions WHERE id = $1 AND principal_id = 'dev-agent'`,
      [request.params.sessionId],
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
      return reply.code(403).send({ error: "capability_denied", capability: neededCapability });
    }
    if (!gateway.isOnline(session.machine_id)) {
      return reply.code(409).send({ error: "machine_offline" });
    }

    const operationId = randomUUID();
    await db.query(
      `INSERT INTO operations
       (id, session_id, principal_id, action, status, timeout_seconds, max_output_bytes, idempotency_key)
       VALUES ($1, $2, 'dev-agent', $3, 'queued', $4, $5, $6)`,
      [
        operationId,
        request.params.sessionId,
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
    await audit(db, "dev-agent", "operation.created", "operation", operationId, {
      sessionId: request.params.sessionId,
      kind: parsed.data.action.kind,
    });
    return reply.code(202).send({ id: operationId, status: sent ? "delivered" : "queued" });
  },
);

app.get<{ Params: { operationId: string } }>(
  "/v1/operations/:operationId",
  { preHandler: requireAgent },
  async (request, reply) => {
    const result = await db.query(
      `SELECT id, session_id AS "sessionId", action, status, exit_code AS "exitCode",
              error, output_truncated AS "outputTruncated",
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM operations WHERE id = $1 AND principal_id = 'dev-agent'`,
      [request.params.operationId],
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
    const result = await db.query<{ machine_id: string; status: string }>(
      `SELECT s.machine_id, o.status
       FROM operations o JOIN sessions s ON s.id = o.session_id
       WHERE o.id = $1 AND o.principal_id = 'dev-agent'`,
      [request.params.operationId],
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
    return reply.code(202).send({ id: request.params.operationId, status: "cancellation_requested" });
  },
);

app.get<{ Params: { operationId: string }; Querystring: { after?: string } }>(
  "/v1/operations/:operationId/events",
  { preHandler: requireAgent },
  async (request, reply) => {
    const found = await db.query(`SELECT 1 FROM operations WHERE id = $1 AND principal_id = 'dev-agent'`, [
      request.params.operationId,
    ]);
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
