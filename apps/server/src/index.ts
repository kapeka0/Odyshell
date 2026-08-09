import { createHash, createPublicKey, randomUUID } from "node:crypto";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import {
  DEFAULT_COMMAND_OUTPUT_BYTES,
  PROTOCOL_VERSION,
} from "@odyshell/protocol";
import {
  cloudWebKey,
  cloudWebRequestDecision,
  cloudWebUrl,
} from "./cloud.js";
import { registerCliHttp } from "./cli-http.js";
import { registerControlHttp } from "./control-http.js";
import { audit, createDatabase } from "./control-database.js";
import { ClientGateway } from "./gateway.js";
import { createHumanOAuthAuthenticator } from "./human-oauth.js";
import { SERVER_HTTP_BODY_LIMIT_BYTES } from "./http-limits.js";
import { dataRetentionPolicy } from "./privacy.js";
import { createAgentOAuthAuthenticator } from "./agent-oauth.js";
import { registerRemoteMcp } from "./remote-mcp.js";
import { createSessionDatabase } from "./session-database.js";
import { registerSessionHttp } from "./session-http.js";
import { createSessionMcpRuntime } from "./session-mcp-runtime.js";
import { decodeCommandOutput } from "./session-output.js";
import { sessionReconnectMessages } from "./session-reconciliation.js";
import { registerSessionSupervisionHttp } from "./session-supervision-http.js";
import { SessionClientUnavailableError, SessionService } from "./sessions.js";

const port = Number(process.env.PORT ?? 4100);
const host = process.env.HOST ?? "127.0.0.1";
const webKey = cloudWebKey(process.env);
const webUrl = cloudWebUrl(process.env, webKey !== undefined);
const retention = dataRetentionPolicy(process.env);

const enrollmentSchema = z.object({
  token: z.string().min(1).max(2_048),
  name: z.string().trim().min(1).max(128),
  publicKey: z.string().min(1).max(16_384),
  previousMachineId: z.string().uuid().optional(),
}).strict();

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? "info" },
  bodyLimit: SERVER_HTTP_BODY_LIMIT_BYTES,
});
await app.register(websocket, { options: { maxPayload: 2 * 1024 * 1024 } });

const database = createDatabase(process.env);
await database.initialize();
const sessionDatabase = createSessionDatabase(process.env);
await sessionDatabase.initialize();

async function requireWeb(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
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

let gateway: ClientGateway;
gateway = new ClientGateway(database, {
  async authenticated({ machineId, controlOrganizationId, sessionProfile }) {
    const organization = await database.mcpOrganization(controlOrganizationId);
    if (
      !organization ||
      organization.organizationExternalId !==
        sessionProfile.localPolicy.organizationId
    ) {
      throw new Error("Session Profile Organization does not own this Machine");
    }
    await sessionDatabase.putMachineAuthority({
      organizationId: sessionProfile.localPolicy.organizationId,
      machineId,
      clientProfileId: sessionProfile.id,
      operatingSystemUser: sessionProfile.operatingSystemUser,
      online: true,
      localPolicy: sessionProfile.localPolicy,
    });
  },
  async disconnected(machineId, organizationId) {
    await sessionDatabase.setMachineOnline(organizationId, machineId, false);
  },
  async reconnected({ machineId, organizationId }) {
    return sessionReconnectMessages(
      await sessionDatabase.reconnectState(organizationId, machineId),
    );
  },
  async message(message, context) {
    switch (message.type) {
      case "session.opened":
        await sessionDatabase.markSessionOpened({
          ...context,
          sessionId: message.sessionId,
          clientProfileId: message.clientProfileId,
          operatingSystemUser: message.operatingSystemUser,
        });
        break;
      case "session.open_failed":
        await sessionDatabase.markSessionFailed(
          context.organizationId,
          context.machineId,
          message.sessionId,
          message.error,
        );
        break;
      case "session.closed":
        await sessionDatabase.markSessionClosed(
          context.organizationId,
          context.machineId,
          message.sessionId,
          message.reason,
        );
        break;
      case "command.started":
        await sessionDatabase.markCommandStarted(
          context.organizationId,
          context.machineId,
          message.commandId,
          message.at,
        );
        break;
      case "command.output":
        if (!await sessionDatabase.addCommandOutput({
          ...context,
          commandId: message.commandId,
          stream: message.stream,
          sequence: message.sequence,
          data: decodeCommandOutput(message.dataBase64),
        })) {
          throw new Error("Command output exceeded its server-side authority");
        }
        break;
      case "command.completed": {
        const command = await sessionDatabase.markCommandCompleted({
          ...context,
          commandId: message.commandId,
          status: message.status,
          exitCode: message.exitCode,
          ...(message.error ? { error: message.error } : {}),
          outputTruncated: message.outputTruncated,
          finishedAt: message.at,
        });
        if (command) {
          gateway.send(context.machineId, {
            type: "command.acknowledged",
            commandId: command.id,
          });
        }
        break;
      }
    }
  },
});
gateway.register(app);

const sessionService = new SessionService(
  sessionDatabase,
  {
    async openSession(session) {
      if (!gateway.send(session.machineId, {
        type: "session.open",
        sessionId: session.id,
        organizationId: session.organizationId,
        agentId: session.agentId,
        clientProfileId: session.clientProfileId,
        expiresAt: session.expiresAt,
        maxConcurrentCommands: session.maxConcurrentCommands,
        serverTime: new Date().toISOString(),
      })) {
        throw new SessionClientUnavailableError();
      }
    },
    async startCommand(command) {
      if (!gateway.send(command.machineId, {
        type: "command.start",
        commandId: command.id,
        sessionId: command.sessionId,
        command: command.command,
        ...(command.cwd ? { cwd: command.cwd } : {}),
        timeoutSeconds: command.timeoutSeconds,
        maxOutputBytes: DEFAULT_COMMAND_OUTPUT_BYTES,
      })) {
        throw new Error("Machine disconnected before Command delivery");
      }
    },
    async closeSession(session, reason) {
      gateway.send(session.machineId, {
        type: "session.close",
        sessionId: session.id,
        reason,
      });
    },
    async cancelCommand(command) {
      gateway.send(command.machineId, {
        type: "command.cancel",
        commandId: command.id,
      });
    },
  },
  sessionDatabase,
);

registerSessionSupervisionHttp(app, {
  preHandler: requireWeb,
  database: sessionDatabase,
  service: sessionService,
});

registerSessionHttp(app, {
  authenticate: createAgentOAuthAuthenticator(process.env),
  repository: sessionDatabase,
  service: sessionService,
  async principal(identity) {
    const organizations = await database.mcpOrganizations([
      identity.organizationId,
    ]);
    if (organizations.length !== 1) return null;
    const installation = await database.ensureMcpInstallation({
      organizationId: organizations[0]!.organizationId,
      userId: identity.subject,
      oauthClientId: identity.clientId,
      agentName: "Agent",
    });
    if (!installation || installation.status === "agent_limit_reached") {
      return null;
    }
    return {
      organizationId: identity.organizationId,
      agentId: installation.agentId,
      agentRole: installation.agentRole,
    };
  },
});

registerRemoteMcp(app, process.env, {
  database,
  async agenticRuntime(installation) {
    const organization = await database.mcpOrganization(
      installation.organizationId,
    );
    if (!organization) throw new Error("Agent Organization is unavailable");
    return createSessionMcpRuntime(
      {
        organizationId: organization.organizationExternalId,
        agentId: installation.agentId,
        agentRole: installation.agentRole,
      },
      sessionService,
      sessionDatabase,
    );
  },
});

registerControlHttp(app, {
  database,
  sessionDatabase,
  gateway,
  preHandler: requireWeb,
  webKey,
  webUrl,
  auditRetentionMilliseconds: retention.auditMilliseconds,
});

registerCliHttp(app, {
  authenticate: createHumanOAuthAuthenticator(process.env),
  database,
  sessionDatabase,
  gateway,
  service: sessionService,
});

app.get("/health", async () => {
  await database.health();
  return { status: "ok", protocol: PROTOCOL_VERSION };
});

app.post("/v1/clients/enroll", async (request, reply) => {
  const parsed = enrollmentSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({
      error: "invalid_enrollment_request",
      details: parsed.error.issues,
    });
  }
  try {
    const key = createPublicKey(parsed.data.publicKey);
    if (key.asymmetricKeyType !== "ed25519") {
      return reply.code(400).send({ error: "client_key_must_be_ed25519" });
    }
  } catch {
    return reply.code(400).send({ error: "invalid_client_public_key" });
  }

  const machineId = randomUUID();
  const enrolled = await database.enrollMachine({
    tokenHash: hashToken(parsed.data.token),
    machineId,
    name: parsed.data.name,
    publicKey: parsed.data.publicKey,
    ...(parsed.data.previousMachineId
      ? { previousMachineId: parsed.data.previousMachineId }
      : {}),
  });
  if (!enrolled) {
    return reply.code(401).send({
      error: "invalid_or_expired_enrollment_token",
    });
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
    database,
    enrolled.controlOrganizationId,
    "client-enrollment",
    "machine.enrolled",
    "machine",
    machineId,
    { name: parsed.data.name },
  );
  if (enrolled.createdByHumanId) {
    await database.createNotification({
      organizationId: enrolled.controlOrganizationId,
      userId: enrolled.createdByHumanId,
      kind: "machine.enrolled",
      title: "Machine added",
      href: "/dashboard/machines",
      resourceId: machineId,
    });
  }
  gateway.notifyOrganization(enrolled.controlOrganizationId);
  return reply.code(201).send({
    machineId: enrolled.machineId,
    name: enrolled.name,
    organizationId: enrolled.organizationId,
  });
});

let sweepingSessions = false;
const expiryTimer = setInterval(() => {
  if (sweepingSessions) return;
  sweepingSessions = true;
  void (async () => {
    for (const expired of await sessionDatabase.expireSessions()) {
      for (const commandId of expired.commandIds) {
        gateway.send(expired.session.machineId, {
          type: "command.cancel",
          commandId,
        });
      }
      gateway.send(expired.session.machineId, {
        type: "session.close",
        sessionId: expired.session.id,
        reason: "expired",
      });
    }
  })()
    .catch((error: unknown) => app.log.error(error, "Session expiry sweep failed"))
    .finally(() => {
      sweepingSessions = false;
    });
}, 10_000);

const retentionTimer = setInterval(() => {
  void Promise.all([
    database.purgeExpiredData({
      transientDataBefore: Date.now() - retention.commandOutputMilliseconds,
      auditBefore: Date.now() - retention.auditMilliseconds,
    }),
    sessionDatabase.purgeExpiredCommandOutput(),
  ]).catch((error: unknown) => app.log.error(error, "Retention sweep failed"));
}, 15 * 60_000);

app.addHook("onClose", async () => {
  clearInterval(expiryTimer);
  clearInterval(retentionTimer);
  await Promise.all([sessionDatabase.close(), database.close()]);
});

await app.listen({ port, host });

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
