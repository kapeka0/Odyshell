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
  authenticated: boolean;
  lastHeartbeatPersistedAt?: number;
};

export class ClientGateway {
  readonly events = new EventEmitter();
  private readonly connections = new Map<string, WebSocket>();

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
        if (state.machineId && this.connections.get(state.machineId) === socket) {
          this.connections.delete(state.machineId);
          void this.db.setMachineOffline(state.machineId);
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
    if (message.protocolVersion !== PROTOCOL_VERSION) throw new Error("Unsupported protocol version");
    const publicKey = await this.db.machinePublicKey(message.machineId);
    if (!publicKey) throw new Error("Unknown machine");

    const payload = Buffer.from(`odyshell:${state.connectionId}:${state.nonce}`);
    const valid = verify(
      null,
      payload,
      createPublicKey(publicKey),
      Buffer.from(message.signature, "base64url"),
    );
    if (!valid) throw new Error("Invalid client signature");

    const previous = this.connections.get(message.machineId);
    if (previous && previous !== socket) previous.close(4003, "Superseded connection");

    state.authenticated = true;
    state.machineId = message.machineId;
    state.lastHeartbeatPersistedAt = Date.now();
    this.connections.set(message.machineId, socket);
    await this.db.setMachineOnline(message.machineId, message.runtime);
    this.sendSocket(socket, { type: "authenticated", machineId: message.machineId });
    this.events.emit("machine.online", message.machineId);
  }

  private async persistMessage(
    message: ClientToServerMessage,
    state: AuthState,
  ): Promise<void> {
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
          const result = await this.db.markSessionOpened(message.sessionId);
          const principalId = result?.principalId;
          if (principalId) {
            await audit(this.db, principalId, "session.opened", "session", message.sessionId);
          }
          this.events.emit(`session:${message.sessionId}`);
        }
        break;
      case "session.open_failed":
        {
          const result = await this.db.markSessionOpenFailed(message.sessionId, message.error);
          const principalId = result?.principalId;
          if (principalId) {
            await audit(this.db, principalId, "session.open_failed", "session", message.sessionId, {
              reason: "client_rejected",
            });
          }
          this.events.emit(`session:${message.sessionId}`);
        }
        break;
      case "session.closed":
        {
          const session = await this.db.markSessionClosed(message.sessionId);
          if (session) {
            await audit(this.db, session.principalId, "session.closed", "session", message.sessionId, {
              reason: message.reason,
              status: session.status,
            });
          }
          this.events.emit(`session:${message.sessionId}`);
        }
        break;
      case "operation.started":
        await this.db.markOperationStarted(message.operationId);
        this.events.emit(`operation:${message.operationId}`);
        break;
      case "operation.event":
        await this.db.addOperationEvent({
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
              principalId,
              "operation.completed",
              "operation",
              message.operationId,
              {
                status: message.status,
                exitCode: message.exitCode,
                outputTruncated: message.outputTruncated,
              },
            );
          }
          this.events.emit(`operation:${message.operationId}`);
        }
        break;
      case "authenticate":
        throw new Error("Already authenticated");
    }
  }
}
