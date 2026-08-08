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
import type { Database } from "./control-database.js";

type AuthState = {
  connectionId: string;
  nonce: string;
  machineId?: string;
  controlOrganizationId?: string;
  organizationId?: string;
  authenticated: boolean;
  lastHeartbeatPersistedAt?: number;
};

export type ClientGatewayTaskHooks = {
  authenticated(input: {
    machineId: string;
    controlOrganizationId: string;
    taskProfile: NonNullable<
      Extract<ClientToServerMessage, { type: "authenticate" }>["taskProfile"]
    >;
  }): Promise<void>;
  reconnected(input: {
    machineId: string;
    organizationId: string;
  }): Promise<
    Extract<
      ServerToClientMessage,
      { type: `task.${string}` | `command.${string}` }
    >[]
  >;
  disconnected(machineId: string, organizationId: string): Promise<void>;
  message(
    message: Extract<
      ClientToServerMessage,
      { type: `task.${string}` | `command.${string}` }
    >,
    context: { machineId: string; organizationId: string },
  ): Promise<void>;
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

  constructor(
    private readonly db: Pick<
      Database,
      | "heartbeat"
      | "machinePublicKey"
      | "setMachineIncompatible"
      | "setMachineOffline"
      | "setMachineOnline"
    >,
    private readonly taskHooks: ClientGatewayTaskHooks,
  ) {
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
            app.log.error(error, "Machine protocol message failed");
            socket.close(4002, "Protocol error");
          });
      });
      socket.on("close", () => {
        clearTimeout(authTimer);
        if (!state.machineId) return;
        void this.runMachineLifecycle(state.machineId, async () => {
          if (this.connections.get(state.machineId!) !== socket) return;
          this.connections.delete(state.machineId!);
          await this.db.setMachineOffline(state.machineId!);
          if (state.organizationId) {
            await this.taskHooks.disconnected(
              state.machineId!,
              state.organizationId,
            );
          }
          if (state.controlOrganizationId) {
            this.notifyOrganization(state.controlOrganizationId);
          }
        });
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

  notifyOrganization(organizationId: string): void {
    this.events.emit(`organization:${organizationId}`);
  }

  async ping(machineId: string, timeoutMilliseconds = 5_000): Promise<number> {
    const pingId = randomUUID();
    const startedAt = performance.now();
    return await new Promise<number>((resolve, reject) => {
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

  async runMachineLifecycle<T>(
    machineId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return await this.machineLifecycles.run(machineId, operation);
  }

  private sendSocket(socket: WebSocket, message: ServerToClientMessage): void {
    socket.send(JSON.stringify(message));
  }

  private async handleMessage(
    socket: WebSocket,
    state: AuthState,
    raw: string,
  ): Promise<void> {
    const message = parseClientMessage(raw);
    if (!state.authenticated) {
      if (message.type !== "authenticate") {
        throw new Error("Expected authenticate message");
      }
      await this.authenticate(socket, state, message);
      return;
    }
    if ("machineId" in message && message.machineId !== state.machineId) {
      throw new Error("Machine identity mismatch");
    }
    if (!state.machineId || !state.controlOrganizationId || !state.organizationId) {
      throw new Error("Authenticated Machine has no Task authority context");
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
        return;
      case "pong":
        this.events.emit(`ping:${message.pingId}`);
        return;
      case "task.opened":
      case "task.open_failed":
      case "task.closed":
      case "command.started":
      case "command.output":
      case "command.completed":
        await this.taskHooks.message(message, {
          machineId: state.machineId,
          organizationId: state.organizationId,
        });
        this.notifyOrganization(state.controlOrganizationId);
        return;
      default:
        throw new Error(`Unsupported Machine message: ${message.type}`);
    }
  }

  private async authenticate(
    socket: WebSocket,
    state: AuthState,
    message: Extract<ClientToServerMessage, { type: "authenticate" }>,
  ): Promise<void> {
    const machine = await this.db.machinePublicKey(message.machineId);
    if (!machine) throw new Error("Unknown Machine");
    const valid = verify(
      null,
      Buffer.from(`odyshell:${state.connectionId}:${state.nonce}`),
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
      this.notifyOrganization(machine.organizationId);
      return;
    }
    state.machineId = message.machineId;
    state.controlOrganizationId = machine.organizationId;
    state.organizationId = message.taskProfile.localPolicy.organizationId;
    await this.runMachineLifecycle(message.machineId, async () => {
      if (!socketReadyForAuthentication(socket)) return;
      const current = await this.db.machinePublicKey(message.machineId);
      if (
        !current ||
        current.publicKey !== machine.publicKey ||
        current.organizationId !== machine.organizationId
      ) {
        throw new Error("Machine identity changed during authentication");
      }
      if (current.revoked) {
        socket.close(4004, "Machine access revoked");
        return;
      }
      await this.taskHooks.authenticated({
        machineId: message.machineId,
        controlOrganizationId: machine.organizationId,
        taskProfile: message.taskProfile,
      });
      const previous = this.connections.get(message.machineId);
      if (previous && previous !== socket) {
        previous.close(4003, "Superseded connection");
      }
      if (!await this.db.setMachineOnline(message.machineId, message.runtime)) {
        socket.close(4004, "Machine access revoked");
        return;
      }
      if (!socketReadyForAuthentication(socket)) {
        await this.db.setMachineOffline(message.machineId);
        return;
      }
      this.connections.set(message.machineId, socket);
      state.authenticated = true;
      state.lastHeartbeatPersistedAt = Date.now();
      this.sendSocket(socket, {
        type: "authenticated",
        machineId: message.machineId,
      });
      for (const taskMessage of await this.taskHooks.reconnected({
        machineId: message.machineId,
        organizationId: state.organizationId!,
      })) {
        this.sendSocket(socket, taskMessage);
      }
      this.events.emit("machine.online", message.machineId);
      this.notifyOrganization(machine.organizationId);
    });
  }
}
