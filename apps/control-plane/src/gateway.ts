import { createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import {
  PROTOCOL_VERSION,
  parseConnectorMessage,
  type ConnectorToServerMessage,
  type ServerToConnectorMessage,
} from "@odyshell/protocol";
import type { Database } from "./database.js";

type AuthState = {
  connectionId: string;
  nonce: string;
  machineId?: string;
  authenticated: boolean;
};

export class ConnectorGateway {
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

      socket.on("message", (data) => {
        void this.handleMessage(socket, state, data.toString()).catch((error: unknown) => {
          app.log.error(error, "Connector message failed");
          socket.close(4002, "Protocol error");
        });
      });

      socket.on("close", () => {
        clearTimeout(authTimer);
        if (state.machineId && this.connections.get(state.machineId) === socket) {
          this.connections.delete(state.machineId);
          void this.db.query(`UPDATE machines SET status = 'offline' WHERE id = $1`, [state.machineId]);
        }
      });
    });
  }

  isOnline(machineId: string): boolean {
    return this.connections.get(machineId)?.readyState === 1;
  }

  send(machineId: string, message: ServerToConnectorMessage): boolean {
    const socket = this.connections.get(machineId);
    if (!socket || socket.readyState !== 1) return false;
    this.sendSocket(socket, message);
    return true;
  }

  private sendSocket(socket: WebSocket, message: ServerToConnectorMessage): void {
    socket.send(JSON.stringify(message));
  }

  private async handleMessage(socket: WebSocket, state: AuthState, raw: string): Promise<void> {
    const message = parseConnectorMessage(raw);
    if (!state.authenticated) {
      if (message.type !== "authenticate") throw new Error("Expected authenticate message");
      await this.authenticate(socket, state, message);
      return;
    }

    if ("machineId" in message && message.machineId !== state.machineId) {
      throw new Error("Machine identity mismatch");
    }

    await this.persistMessage(message);
  }

  private async authenticate(
    socket: WebSocket,
    state: AuthState,
    message: Extract<ConnectorToServerMessage, { type: "authenticate" }>,
  ): Promise<void> {
    if (message.protocolVersion !== PROTOCOL_VERSION) throw new Error("Unsupported protocol version");
    const result = await this.db.query<{ public_key: string }>(
      "SELECT public_key FROM machines WHERE id = $1",
      [message.machineId],
    );
    const machine = result.rows[0];
    if (!machine) throw new Error("Unknown machine");

    const payload = Buffer.from(`odyshell:${state.connectionId}:${state.nonce}`);
    const valid = verify(
      null,
      payload,
      createPublicKey(machine.public_key),
      Buffer.from(message.signature, "base64url"),
    );
    if (!valid) throw new Error("Invalid connector signature");

    const previous = this.connections.get(message.machineId);
    if (previous && previous !== socket) previous.close(4003, "Superseded connection");

    state.authenticated = true;
    state.machineId = message.machineId;
    this.connections.set(message.machineId, socket);
    await this.db.query(
      `UPDATE machines
       SET status = 'online',
           last_seen_at = now(),
           runtime_info = COALESCE($2::jsonb, runtime_info)
       WHERE id = $1`,
      [message.machineId, message.runtime ? JSON.stringify(message.runtime) : null],
    );
    this.sendSocket(socket, { type: "authenticated", machineId: message.machineId });
    this.events.emit("machine.online", message.machineId);
  }

  private async persistMessage(message: ConnectorToServerMessage): Promise<void> {
    switch (message.type) {
      case "heartbeat":
        await this.db.query(
          `UPDATE machines SET status = 'online', last_seen_at = now() WHERE id = $1`,
          [message.machineId],
        );
        break;
      case "session.opened":
        await this.db.query(
          `UPDATE sessions SET status = 'ready', updated_at = now(), error = NULL WHERE id = $1`,
          [message.sessionId],
        );
        this.events.emit(`session:${message.sessionId}`);
        break;
      case "session.open_failed":
        await this.db.query(
          `UPDATE sessions SET status = 'failed', updated_at = now(), error = $2 WHERE id = $1`,
          [message.sessionId, message.error],
        );
        this.events.emit(`session:${message.sessionId}`);
        break;
      case "session.closed":
        await this.db.query(
          `UPDATE sessions
           SET status = CASE WHEN expires_at <= now() THEN 'expired' ELSE 'closed' END,
               updated_at = now()
           WHERE id = $1`,
          [message.sessionId],
        );
        this.events.emit(`session:${message.sessionId}`);
        break;
      case "operation.started":
        await this.db.query(
          `UPDATE operations SET status = 'running', updated_at = now() WHERE id = $1`,
          [message.operationId],
        );
        this.events.emit(`operation:${message.operationId}`);
        break;
      case "operation.event":
        await this.db.query(
          `INSERT INTO operation_events (operation_id, sequence, stream, data)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT DO NOTHING`,
          [
            message.operationId,
            message.sequence,
            message.stream,
            Buffer.from(message.dataBase64, "base64"),
          ],
        );
        this.events.emit(`operation:${message.operationId}`, message);
        break;
      case "operation.completed":
        await this.db.query(
          `UPDATE operations
           SET status = $2, exit_code = $3, error = $4, output_truncated = $5, updated_at = now()
           WHERE id = $1`,
          [
            message.operationId,
            message.status,
            message.exitCode,
            message.error ?? null,
            message.outputTruncated,
          ],
        );
        this.events.emit(`operation:${message.operationId}`);
        break;
      case "authenticate":
        throw new Error("Already authenticated");
    }
  }
}
