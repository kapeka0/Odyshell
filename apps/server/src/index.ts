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
import { registerControlHttp } from "./control-http.js";
import { audit, createDatabase } from "./database.js";
import { ClientGateway } from "./gateway.js";
import { SERVER_HTTP_BODY_LIMIT_BYTES } from "./http-limits.js";
import { dataRetentionPolicy } from "./privacy.js";
import { createAgentOAuthAuthenticator } from "./agent-oauth.js";
import { registerRemoteMcp } from "./remote-mcp.js";
import { createTaskDatabase } from "./task-database.js";
import { registerTaskHttp } from "./task-http.js";
import { createTaskMcpRuntime } from "./task-mcp-runtime.js";
import { decodeCommandOutput } from "./task-output.js";
import { taskReconnectMessages } from "./task-reconciliation.js";
import { registerTaskSupervisionHttp } from "./task-supervision-http.js";
import { TaskClientUnavailableError, TaskService } from "./tasks.js";

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
const taskDatabase = createTaskDatabase(process.env);
await taskDatabase.initialize();

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
  async authenticated({ machineId, workspaceId, taskProfile }) {
    const workspace = await database.mcpWorkspace(workspaceId);
    if (
      !workspace ||
      workspace.organizationExternalId !==
        taskProfile.localPolicy.organizationId
    ) {
      throw new Error("Task Profile Organization does not own this Machine");
    }
    await taskDatabase.putMachineAuthority({
      organizationId: taskProfile.localPolicy.organizationId,
      machineId,
      clientProfileId: taskProfile.id,
      operatingSystemUser: taskProfile.operatingSystemUser,
      online: true,
      localPolicy: taskProfile.localPolicy,
    });
  },
  async disconnected(machineId, organizationId) {
    await taskDatabase.setMachineOnline(organizationId, machineId, false);
  },
  async reconnected({ machineId, organizationId }) {
    return taskReconnectMessages(
      await taskDatabase.reconnectState(organizationId, machineId),
    );
  },
  async message(message, context) {
    switch (message.type) {
      case "task.opened":
        await taskDatabase.markTaskOpened({
          ...context,
          taskId: message.taskId,
          clientProfileId: message.clientProfileId,
          operatingSystemUser: message.operatingSystemUser,
        });
        break;
      case "task.open_failed":
        await taskDatabase.markTaskFailed(
          context.organizationId,
          context.machineId,
          message.taskId,
          message.error,
        );
        break;
      case "task.closed":
        await taskDatabase.markTaskClosed(
          context.organizationId,
          context.machineId,
          message.taskId,
          message.reason,
        );
        break;
      case "command.started":
        await taskDatabase.markCommandStarted(
          context.organizationId,
          context.machineId,
          message.commandId,
          message.at,
        );
        break;
      case "command.output":
        if (!await taskDatabase.addCommandOutput({
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
        const command = await taskDatabase.markCommandCompleted({
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

const taskService = new TaskService(
  taskDatabase,
  {
    async openTask(task) {
      if (!gateway.send(task.machineId, {
        type: "task.open",
        taskId: task.id,
        organizationId: task.organizationId,
        agentId: task.agentId,
        clientProfileId: task.clientProfileId,
        expiresAt: task.expiresAt,
        maxConcurrentCommands: task.maxConcurrentCommands,
        serverTime: new Date().toISOString(),
      })) {
        throw new TaskClientUnavailableError();
      }
    },
    async startCommand(command) {
      if (!gateway.send(command.machineId, {
        type: "command.start",
        commandId: command.id,
        taskId: command.taskId,
        command: command.command,
        ...(command.cwd ? { cwd: command.cwd } : {}),
        timeoutSeconds: command.timeoutSeconds,
        maxOutputBytes: DEFAULT_COMMAND_OUTPUT_BYTES,
      })) {
        throw new Error("Machine disconnected before Command delivery");
      }
    },
    async closeTask(task, reason) {
      gateway.send(task.machineId, {
        type: "task.close",
        taskId: task.id,
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
  taskDatabase,
);

registerTaskSupervisionHttp(app, {
  preHandler: requireWeb,
  database: taskDatabase,
  service: taskService,
});

registerTaskHttp(app, {
  authenticate: createAgentOAuthAuthenticator(process.env),
  repository: taskDatabase,
  service: taskService,
  async principal(identity) {
    const workspaces = await database.mcpWorkspacesForOrganizations([
      identity.organizationId,
    ]);
    if (workspaces.length !== 1) return null;
    const installation = await database.ensureMcpInstallation({
      workspaceId: workspaces[0]!.workspaceId,
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
    };
  },
});

registerRemoteMcp(app, process.env, {
  database,
  async agenticRuntime(installation) {
    const workspace = await database.mcpWorkspace(installation.workspaceId);
    if (!workspace) throw new Error("Agent Organization is unavailable");
    return createTaskMcpRuntime(
      {
        organizationId: workspace.organizationExternalId,
        agentId: installation.agentId,
      },
      taskService,
      taskDatabase,
    );
  },
});

registerControlHttp(app, {
  database,
  taskDatabase,
  gateway,
  preHandler: requireWeb,
  webKey,
  webUrl,
  auditRetentionMilliseconds: retention.auditMilliseconds,
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
  if (enrolled.status === "organization_identity_required") {
    return reply.code(409).send({ error: "organization_identity_required" });
  }
  await audit(
    database,
    enrolled.workspaceId,
    "client-enrollment",
    "machine.enrolled",
    "machine",
    machineId,
    { name: parsed.data.name },
  );
  if (enrolled.createdByHumanId) {
    await database.createNotification({
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
    organizationId: enrolled.organizationId,
  });
});

let sweepingTasks = false;
const expiryTimer = setInterval(() => {
  if (sweepingTasks) return;
  sweepingTasks = true;
  void (async () => {
    for (const expired of await taskDatabase.expireTasks()) {
      for (const commandId of expired.commandIds) {
        gateway.send(expired.task.machineId, {
          type: "command.cancel",
          commandId,
        });
      }
      gateway.send(expired.task.machineId, {
        type: "task.close",
        taskId: expired.task.id,
        reason: "expired",
      });
    }
  })()
    .catch((error: unknown) => app.log.error(error, "Task expiry sweep failed"))
    .finally(() => {
      sweepingTasks = false;
    });
}, 10_000);

const retentionTimer = setInterval(() => {
  void Promise.all([
    database.purgeExpiredData({
      operationDataBefore: Date.now() - retention.operationDataMilliseconds,
      auditBefore: Date.now() - retention.auditMilliseconds,
    }),
    taskDatabase.purgeExpiredCommandOutput(),
  ]).catch((error: unknown) => app.log.error(error, "Retention sweep failed"));
}, 15 * 60_000);

app.addHook("onClose", async () => {
  clearInterval(expiryTimer);
  clearInterval(retentionTimer);
  await Promise.all([taskDatabase.close(), database.close()]);
});

await app.listen({ port, host });

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
