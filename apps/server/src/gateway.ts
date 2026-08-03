import { createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import {
  PROTOCOL_VERSION,
  parseClientMessage,
  type ClientToServerMessage,
  type ServerToClientMessage,
} from "@odyshell/protocol";
import { audit, type Database } from "./database.js";

type AuthState = {
  connectionId: string;
  nonce: string;
  machineId?: string;
  workspaceId?: string;
  authenticated: boolean;
  lastHeartbeatPersistedAt?: number;
};

export class MachineLifecycleQueue {
  private readonly queues = new Map<string, Promise<void>>();

  async run<T>(machineId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(machineId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const settled = current.then(() => undefined, () => undefined);
    this.queues.set(machineId, settled);
    void settled.finally(() => {
      if (this.queues.get(machineId) === settled) this.queues.delete(machineId);
    });
    return await current;
  }
}

export function socketReadyForAuthentication(
  socket: Pick<WebSocket, "readyState">,
): boolean {
  return socket.readyState === 1;
}

export class ClientGateway {
  readonly events = new EventEmitter();
  private readonly connections = new Map<string, WebSocket>();
  private readonly machineLifecycles = new MachineLifecycleQueue();

  constructor(private readonly db: Database) {
    this.events.setMaxListeners(0);
  }

  register(app: FastifyInstance): void {
    app.get("/v1/connect", { websocket: true }, (socket) => {
      const state: AuthState = {
        connectionId: randomUUID(),
        nonce: randomBytes(32).toString("base64url"),
        authenticated: false,
      };

      this.sendSocket(socket, {
        type: "challenge",
        connectionId: state.connectionId,
        nonce: state.nonce,
      });

      const authTimer = setTimeout(() => {
        if (!state.authenticated) socket.close(4001, "Authentication timeout");
      }, 10_000);

      let messageQueue = Promise.resolve();
      socket.on("message", (data) => {
        messageQueue = messageQueue
          .then(() => this.handleMessage(socket, state, data.toString()))
          .catch((error: unknown) => {
            app.log.error(error, "Client message failed");
            socket.close(4002, "Protocol error");
          });
      });

      socket.on("close", () => {
        clearTimeout(authTimer);
        if (state.machineId) {
          void this.queueMachineLifecycle(state.machineId, async () => {
            if (this.connections.get(state.machineId!) !== socket) return;
            this.connections.delete(state.machineId!);
            const result = await this.db.markMachineDisconnected(state.machineId!);
              if (result && (result.operations > 0 || result.targets > 0)) {
                app.log.info(
                  {
                    machineId: state.machineId,
                    operations: result.operations,
                    targets: result.targets,
                  },
                  "Machine disconnect terminated active authority",
                );
              }
            if (state.workspaceId) this.notifyWorkspace(state.workspaceId);
          });
        }
      });
    });
  }

  isOnline(machineId: string): boolean {
    return this.connections.get(machineId)?.readyState === 1;
  }

  send(machineId: string, message: ServerToClientMessage): boolean {
    const socket = this.connections.get(machineId);
    if (!socket || socket.readyState !== 1) return false;
    this.sendSocket(socket, message);
    return true;
  }

  disconnect(machineId: string, reason = "Machine access revoked"): boolean {
    const socket = this.connections.get(machineId);
    if (!socket) return false;
    this.connections.delete(machineId);
    socket.close(4004, reason);
    return true;
  }

  notifyWorkspace(workspaceId: string): void {
    this.events.emit(`workspace:${workspaceId}`);
  }

  async ping(machineId: string, timeoutMilliseconds = 5_000): Promise<number> {
    const pingId = randomUUID();
    const startedAt = performance.now();
    return new Promise<number>((resolve, reject) => {
      const event = `ping:${pingId}`;
      const onPong = (): void => {
        clearTimeout(timeout);
        resolve(Math.max(0, Math.round(performance.now() - startedAt)));
      };
      const timeout = setTimeout(() => {
        this.events.off(event, onPong);
        reject(new Error("Machine ping timed out"));
      }, timeoutMilliseconds);
      this.events.once(event, onPong);
      if (!this.send(machineId, { type: "ping", pingId })) {
        clearTimeout(timeout);
        this.events.off(event, onPong);
        reject(new Error("Machine disconnected before ping"));
      }
    });
  }

  private sendSocket(socket: WebSocket, message: ServerToClientMessage): void {
    socket.send(JSON.stringify(message));
  }

  private async queueMachineLifecycle<T>(
    machineId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return await this.machineLifecycles.run(machineId, operation);
  }

  private async handleMessage(socket: WebSocket, state: AuthState, raw: string): Promise<void> {
    const message = parseClientMessage(raw);
    if (!state.authenticated) {
      if (message.type !== "authenticate") throw new Error("Expected authenticate message");
      await this.authenticate(socket, state, message);
      return;
    }

    if ("machineId" in message && message.machineId !== state.machineId) {
      throw new Error("Machine identity mismatch");
    }

    await this.persistMessage(message, state);
  }

  private async authenticate(
    socket: WebSocket,
    state: AuthState,
    message: Extract<ClientToServerMessage, { type: "authenticate" }>,
  ): Promise<void> {
    const machine = await this.db.machinePublicKey(message.machineId);
    if (!machine) throw new Error("Unknown machine");

    const payload = Buffer.from(`odyshell:${state.connectionId}:${state.nonce}`);
    const valid = verify(
      null,
      payload,
      createPublicKey(machine.publicKey),
      Buffer.from(message.signature, "base64url"),
    );
    if (!valid) throw new Error("Invalid client signature");
    if (message.protocolVersion !== PROTOCOL_VERSION) {
      await this.db.setMachineIncompatible(message.machineId, {
        ...(message.runtime ?? {}),
        protocolVersion: message.protocolVersion,
      });
      this.sendSocket(socket, {
        type: "error",
        code: "client_upgrade_required",
        message: `This Server requires protocol ${PROTOCOL_VERSION}; the Client reported ${message.protocolVersion}. Update the Odyshell Client and reconnect.`,
      });
      socket.close(4005, "client_upgrade_required");
      this.notifyWorkspace(machine.workspaceId);
      return;
    }

    // Record the verified identity before waiting so a concurrent close queues
    // cleanup for the same machine lifecycle.
    state.machineId = message.machineId;
    state.workspaceId = machine.workspaceId;
    await this.queueMachineLifecycle(message.machineId, async () => {
      if (!socketReadyForAuthentication(socket)) return;
      const previous = this.connections.get(message.machineId);
      if (previous && previous !== socket) previous.close(4003, "Superseded connection");

      state.authenticated = true;
      state.lastHeartbeatPersistedAt = Date.now();
      this.connections.set(message.machineId, socket);
      await this.db.setMachineOnline(message.machineId, message.runtime);
      this.sendSocket(socket, { type: "authenticated", machineId: message.machineId });
      const retryTargets = await this.db.retryAgentSessionTargets(message.machineId);
      for (const target of retryTargets) {
        this.sendSocket(socket, {
          type: "session.open",
          sessionId: target.runtimeSessionId,
          profile: target.profile,
          capabilities: target.capabilities,
          restrictions: target.restrictions,
          expiresAt: new Date(target.expiresAt).toISOString(),
          serverTime: new Date().toISOString(),
        });
      }
      this.events.emit("machine.online", message.machineId);
      this.notifyWorkspace(machine.workspaceId);
    });
  }

  private async persistMessage(
    message: ClientToServerMessage,
    state: AuthState,
  ): Promise<void> {
    if (!state.machineId || !state.workspaceId) {
      throw new Error("Authenticated client has no machine context");
    }
    switch (message.type) {
      case "heartbeat":
        if (
          state.lastHeartbeatPersistedAt === undefined ||
          Date.now() - state.lastHeartbeatPersistedAt >= 5 * 60_000
        ) {
          await this.db.heartbeat(message.machineId);
          state.lastHeartbeatPersistedAt = Date.now();
        }
        break;
      case "pong":
        this.events.emit(`ping:${message.pingId}`);
        break;
      case "session.opened":
        {
          const result = await this.db.markSessionOpened(state.machineId, message.sessionId);
          const principalId = result?.principalId;
          if (principalId) {
            await audit(
              this.db,
              result.workspaceId,
              principalId,
              "session.opened",
              "session",
              message.sessionId,
              { machineId: state.machineId },
            );
          }
          if (
            result?.reconciliation?.state === "ready"
          ) {
            const expiresAt = new Date(result.reconciliation.expiresAt).toISOString();
            const serverTime = new Date().toISOString();
            for (const target of result.reconciliation.targets) {
              this.send(target.machineId, {
                type: "session.expires",
                sessionId: target.runtimeSessionId,
                expiresAt,
                serverTime,
              });
            }
          }
          this.events.emit(`session:${message.sessionId}`);
          this.notifyWorkspace(state.workspaceId);
        }
        break;
      case "session.open_failed":
        {
          const result = await this.db.markSessionOpenFailed(
            state.machineId,
            message.sessionId,
            message.error,
          );
          const principalId = result?.principalId;
          if (principalId) {
            await audit(
              this.db,
              result.workspaceId,
              principalId,
              "session.open_failed",
              "session",
              message.sessionId,
              {
                reason: "client_rejected",
                machineId: state.machineId,
              },
            );
          }
          if (
            result?.reconciliation?.state === "ready"
          ) {
            const expiresAt = new Date(result.reconciliation.expiresAt).toISOString();
            const serverTime = new Date().toISOString();
            for (const target of result.reconciliation.targets) {
              this.send(target.machineId, {
                type: "session.expires",
                sessionId: target.runtimeSessionId,
                expiresAt,
                serverTime,
              });
            }
          }
          this.events.emit(`session:${message.sessionId}`);
          this.notifyWorkspace(state.workspaceId);
        }
        break;
      case "session.closed":
        {
          const session = await this.db.markSessionClosed(
            state.machineId,
            message.sessionId,
          );
          if (session) {
            await audit(
              this.db,
              session.workspaceId,
              session.principalId,
              "session.closed",
              "session",
              message.sessionId,
              {
                reason: message.reason,
                machineId: state.machineId,
                status: session.status,
              },
            );
          }
          this.events.emit(`session:${message.sessionId}`);
          this.notifyWorkspace(state.workspaceId);
        }
        break;
      case "operation.started":
        await this.db.markOperationStarted(state.machineId, message.operationId);
        this.events.emit(`operation:${message.operationId}`);
        break;
      case "operation.event":
        await this.db.addOperationEvent({
          machineId: state.machineId,
          operationId: message.operationId,
          sequence: message.sequence,
          stream: message.stream,
          dataBase64: message.dataBase64,
        });
        this.events.emit(`operation:${message.operationId}`, message);
        break;
      case "operation.completed":
        {
          const result = await this.db.markOperationCompleted({
            machineId: state.machineId,
            operationId: message.operationId,
            status: message.status,
            exitCode: message.exitCode,
            ...(message.error === undefined ? {} : { error: message.error }),
            outputTruncated: message.outputTruncated,
          });
          const principalId = result?.principalId;
          if (principalId) {
            await audit(
              this.db,
              result.workspaceId,
              principalId,
              "operation.completed",
              "operation",
              message.operationId,
              {
                kind: result.kind,
                machineId: state.machineId,
                status: message.status,
                exitCode: message.exitCode,
                outputTruncated: message.outputTruncated,
              },
            );
          }
          this.events.emit(`operation:${message.operationId}`);
          this.notifyWorkspace(state.workspaceId);
        }
        break;
      case "authenticate":
        throw new Error("Already authenticated");
    }
  }
}
