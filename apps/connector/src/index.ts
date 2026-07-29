import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import {
  PROTOCOL_VERSION,
  allCapabilities,
  parseServerMessage,
  type ConnectorConfig,
  type ConnectorRuntimeInfo,
  type ConnectorToServerMessage,
  type ServerToConnectorMessage,
} from "@odyshell/protocol";
import WebSocket from "ws";
import {
  DockerRunner,
  inspectDockerRuntime,
  type RunningOperation,
  type RunningSession,
} from "./docker-runner.js";
import { OperationJournal, type JournalResult } from "./journal.js";
import { defaultConnectorConfigPath, hostPlatform } from "./platform.js";

export { defaultConnectorConfigPath } from "./platform.js";

export type EnrollConnectorOptions = {
  serverUrl: string;
  token: string;
  machineName: string;
  workspaceRoot: string;
  configPath: string;
  image?: string;
};

export async function enrollConnector(options: EnrollConnectorOptions): Promise<{
  machineId: string;
  configPath: string;
}> {
  const serverUrl = options.serverUrl;
  const workspaceRoot = resolve(options.workspaceRoot);
  const configPath = resolve(options.configPath);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const response = await fetch(new URL("/v1/connectors/enroll", serverUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: options.token, name: options.machineName, publicKey }),
  });
  const body = (await response.json()) as { machineId?: string; error?: string };
  if (!response.ok || !body.machineId) throw new Error(body.error ?? `Enrollment failed: ${response.status}`);

  const config: ConnectorConfig = {
    serverUrl,
    machineId: body.machineId,
    machineName: options.machineName,
    privateKeyPem: privateKey,
    stateDirectory: resolve(dirname(configPath), "state"),
    profiles: {
      workspace: {
        runner: "docker",
        workspaceRoot,
        image: options.image ?? "alpine:3.22",
        network: "none",
        maxSessionTtlSeconds: 1800,
        maxConcurrentSessions: 2,
        maxOutputBytes: 1024 * 1024,
        capabilities: allCapabilities,
      },
    },
  };
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return { machineId: body.machineId, configPath };
}

export async function inspectConnectorRuntime(): Promise<ConnectorRuntimeInfo> {
  const docker = await inspectDockerRuntime();
  return {
    hostPlatform: hostPlatform(),
    architecture: process.arch,
    nodeVersion: process.version,
    containerEngine: "docker",
    containerOs: docker.os,
    containerArchitecture: docker.architecture,
    containerEngineVersion: docker.version,
  };
}

export class Connector {
  private socket: WebSocket | undefined;
  private heartbeat?: NodeJS.Timeout;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectDelay = 1_000;
  private stopped = false;
  private readonly sessions = new Map<string, RunningSession>();
  private readonly operations = new Map<string, RunningOperation>();
  private readonly runner: DockerRunner;
  private readonly journal: OperationJournal;
  private runtime: ConnectorRuntimeInfo | undefined;

  constructor(private readonly config: ConnectorConfig) {
    this.runner = new DockerRunner(config.machineId);
    this.journal = new OperationJournal(resolve(config.stateDirectory, "operations.sqlite"));
  }

  async start(): Promise<void> {
    this.runtime = await inspectConnectorRuntime();
    await this.runner.cleanupOrphans();
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
    for (const operation of this.operations.values()) await operation.cancel();
    for (const session of this.sessions.values()) await this.runner.closeSession(session);
    this.journal.close();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const url = new URL("/v1/connect", this.config.serverUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.on("open", () => console.log(`Connected to ${url.toString()}`));
    socket.on("message", (data) => {
      void this.handle(parseServerMessage(data.toString())).catch((error: unknown) => {
        console.error("Connector message failed:", error);
      });
    });
    socket.on("close", () => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      if (this.socket === socket) this.socket = undefined;
      if (!this.stopped) {
        console.error(`Disconnected; reconnecting in ${this.reconnectDelay}ms`);
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = undefined;
          void this.connect();
        }, this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
      }
    });
    socket.on("error", (error) => console.error("Connector socket error:", error.message));
  }

  private send(message: ConnectorToServerMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Control plane is disconnected");
    }
    this.socket.send(JSON.stringify(message));
  }

  private async handle(message: ServerToConnectorMessage): Promise<void> {
    switch (message.type) {
      case "challenge": {
        const signature = sign(
          null,
          Buffer.from(`odyshell:${message.connectionId}:${message.nonce}`),
          this.config.privateKeyPem,
        ).toString("base64url");
        this.send({
          type: "authenticate",
          machineId: this.config.machineId,
          protocolVersion: PROTOCOL_VERSION,
          signature,
          ...(this.runtime ? { runtime: this.runtime } : {}),
        });
        break;
      }
      case "authenticated":
        this.reconnectDelay = 1_000;
        console.log(`Authenticated as ${this.config.machineName} (${message.machineId})`);
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.heartbeat = setInterval(() => {
          try {
            this.send({
              type: "heartbeat",
              machineId: this.config.machineId,
              at: new Date().toISOString(),
            });
          } catch {}
        }, 10_000);
        break;
      case "session.open":
        await this.openSession(message);
        break;
      case "session.close":
        await this.closeSession(message.sessionId, message.reason);
        break;
      case "operation.start":
        await this.startOperation(message);
        break;
      case "operation.cancel":
        await this.operations.get(message.operationId)?.cancel();
        break;
    }
  }

  private async openSession(
    message: Extract<ServerToConnectorMessage, { type: "session.open" }>,
  ): Promise<void> {
    try {
      const profile = this.config.profiles[message.profile];
      if (!profile) throw new Error(`Unknown local profile: ${message.profile}`);
      const activeForProfile = [...this.sessions.values()].filter((item) => item.profile === profile).length;
      if (activeForProfile >= profile.maxConcurrentSessions) {
        throw new Error("Local concurrent session limit reached");
      }
      const session = await this.runner.openSession(
        message.sessionId,
        profile,
        message.capabilities,
        new Date(message.expiresAt),
        () => void this.closeSession(message.sessionId, "expired"),
      );
      this.sessions.set(message.sessionId, session);
      this.send({
        type: "session.opened",
        sessionId: message.sessionId,
        containerId: session.containerId,
      });
    } catch (error) {
      this.send({
        type: "session.open_failed",
        sessionId: message.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async closeSession(sessionId: string, reason: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      await this.runner.closeSession(session);
      this.sessions.delete(sessionId);
    }
    this.send({ type: "session.closed", sessionId, reason });
  }

  private async startOperation(
    message: Extract<ServerToConnectorMessage, { type: "operation.start" }>,
  ): Promise<void> {
    const receipt = this.journal.receive(message.operationId);
    if (receipt === "completed" || receipt === "unknown") {
      const previous = this.journal.result(message.operationId);
      if (previous) this.sendCompletion(message.operationId, previous);
      return;
    }
    if (receipt !== "new") return;

    const session = this.sessions.get(message.sessionId);
    if (!session) {
      const result: JournalResult = {
        status: "failed",
        exitCode: null,
        error: "Session is not active on this connector",
        outputTruncated: false,
      };
      this.journal.complete(message.operationId, result);
      this.sendCompletion(message.operationId, result);
      return;
    }

    let sequence = 0;
    let outputBytes = 0;
    let outputTruncated = false;
    let timedOut = false;
    let cancelled = false;
    const maximum = Math.min(message.maxOutputBytes, session.profile.maxOutputBytes);
    const emit = (stream: "stdout" | "stderr" | "result", data: Buffer): void => {
      if (outputTruncated) return;
      const remaining = maximum - outputBytes;
      if (remaining <= 0) {
        outputTruncated = true;
        return;
      }
      const accepted = data.subarray(0, remaining);
      outputBytes += accepted.length;
      if (accepted.length < data.length) outputTruncated = true;
      this.send({
        type: "operation.event",
        operationId: message.operationId,
        sequence: sequence++,
        stream,
        dataBase64: accepted.toString("base64"),
      });
    };

    try {
      this.journal.markRunning(message.operationId);
      this.send({ type: "operation.started", operationId: message.operationId, at: new Date().toISOString() });
      const running = await this.runner.execute(message.operationId, session, message.action, {
        stdout: (data) => emit("stdout", data),
        stderr: (data) => emit("stderr", data),
        result: (data) => emit("result", data),
      });
      const originalCancel = running.cancel;
      running.cancel = async () => {
        cancelled = true;
        await originalCancel();
      };
      this.operations.set(message.operationId, running);
      const timer = setTimeout(() => {
        timedOut = true;
        void originalCancel();
      }, Math.min(message.timeoutSeconds, 1800) * 1000);
      const { exitCode } = await running.done;
      clearTimeout(timer);
      this.operations.delete(message.operationId);
      const result: JournalResult = {
        status: timedOut
          ? "timed_out"
          : cancelled
            ? "cancelled"
            : exitCode === 0
              ? "succeeded"
              : "failed",
        exitCode,
        ...(outputTruncated ? { error: "Output limit reached" } : {}),
        outputTruncated,
      };
      this.journal.complete(message.operationId, result);
      this.sendCompletion(message.operationId, result);
    } catch (error) {
      const result: JournalResult = {
        status: timedOut ? "timed_out" : cancelled ? "cancelled" : "failed",
        exitCode: null,
        error: error instanceof Error ? error.message : String(error),
        outputTruncated,
      };
      this.journal.complete(message.operationId, result);
      this.sendCompletion(message.operationId, result);
    }
  }

  private sendCompletion(operationId: string, result: JournalResult): void {
    this.send({
      type: "operation.completed",
      operationId,
      status: result.status,
      exitCode: result.exitCode,
      ...(result.error ? { error: result.error } : {}),
      outputTruncated: result.outputTruncated,
      at: new Date().toISOString(),
    });
  }
}

export async function runConnector(
  configPathInput = defaultConnectorConfigPath(),
): Promise<Connector> {
  const configPath = resolve(configPathInput);
  const config = JSON.parse(await readFile(configPath, "utf8")) as ConnectorConfig;
  const connector = new Connector(config);
  const shutdown = (): void => {
    void connector.stop().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await connector.start();
  return connector;
}
