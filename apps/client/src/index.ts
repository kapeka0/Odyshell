import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import {
  MAX_CLIENT_CLOCK_SKEW_MILLISECONDS,
  MAX_AGENT_SESSION_SECONDS,
  PROTOCOL_VERSION,
  allCapabilities,
  capabilitySchema,
  clientConfigSchema,
  parseServerMessage,
  sessionScopeSubsetDecision,
  type Capability,
  type ClientConfig,
  type ClientRuntimeInfo,
  type ClientToServerMessage,
  type ServerToClientMessage,
} from "@odyshell/protocol";
import WebSocket from "ws";
import {
  DockerRunner,
  inspectDockerRuntime,
} from "./docker-runner.js";
import type {
  OperationExecutor,
  RunningOperation,
  RunningSession,
} from "./executor.js";
import { HostExecutor } from "./host-executor.js";
import { OperationJournal, type JournalResult } from "./journal.js";
import {
  clientConfigPathForProfile,
  defaultClientConfigPath,
  hostPlatform,
  normalizeServerUrl,
} from "./platform.js";

export const CLIENT_VERSION = "0.12.0";

export {
  clientConfigPathForProfile,
  defaultClientConfigPath,
  normalizeClientProfileName,
  normalizeServerUrl,
} from "./platform.js";

export function adjustedSessionDeadline(
  expiresAt: string,
  serverTime: string | undefined,
  localNow = Date.now(),
): Date {
  const serverNow = serverTime === undefined ? localNow : Date.parse(serverTime);
  const absoluteExpiry = Date.parse(expiresAt);
  if (!Number.isFinite(serverNow) || !Number.isFinite(absoluteExpiry)) {
    throw new Error("Session deadline is invalid");
  }
  if (
    serverTime !== undefined &&
    Math.abs(localNow - serverNow) > MAX_CLIENT_CLOCK_SKEW_MILLISECONDS
  ) {
    throw new Error("Client clock is outside the allowed Session skew");
  }
  return new Date(localNow + (absoluteExpiry - serverNow));
}
export {
  activateMacLaunchAgent,
  activateLinuxUserService,
  clientServiceStatus,
  installClientService,
  installLinuxUserService,
  installMacLaunchAgent,
  installWindowsTask,
  linuxServiceNameForConfig,
  linuxUserServicePath,
  macLaunchAgentLabelForConfig,
  macLaunchAgentPath,
  removeLinuxUserService,
  removeClientService,
  renderMacLaunchAgent,
  renderLinuxUserService,
  renderWindowsTaskAction,
  renderWindowsTaskLauncher,
  restartClientService,
  stopClientService,
  stopLinuxUserService,
  windowsTaskLauncherPath,
  windowsTaskActionIsCurrent,
  windowsTaskNameForConfig,
} from "./service.js";
export {
  removeAllClientProfiles,
  removeClientProfile,
  type RemoveAllClientProfilesOptions,
  type RemoveClientProfileOptions,
} from "./profile.js";

export type EnrollClientOptions = {
  serverUrl: string;
  token: string;
  machineName: string;
  workspaceRoot: string;
  configPath: string;
  profileName?: string;
  allowedCapabilities: Capability[];
  runner?: "host" | "docker";
  image?: string;
  previousMachineId?: string;
  replaceConfig?: boolean;
};

export async function enrollClient(options: EnrollClientOptions): Promise<{
  machineId: string;
  configPath: string;
}> {
  const serverUrl = options.serverUrl;
  const workspaceRoot = resolve(options.workspaceRoot);
  const configPath = resolve(options.configPath);
  const parsedCapabilities = capabilitySchema
    .array()
    .min(1)
    .safeParse([...new Set(options.allowedCapabilities)]);
  if (!parsedCapabilities.success) {
    throw new Error("At least one valid capability must be explicitly allowed");
  }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const response = await fetch(new URL("/v1/clients/enroll", serverUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: options.token,
      name: options.machineName,
      publicKey,
      ...(options.previousMachineId
        ? { previousMachineId: options.previousMachineId }
        : {}),
    }),
  });
  const body = (await response.json()) as {
    machineId?: string;
    workspaceId?: string;
    error?: string;
  };
  if (!response.ok || !body.machineId) throw new Error(body.error ?? `Enrollment failed: ${response.status}`);

  const runner = options.runner ?? "host";
  const profile =
    runner === "docker"
      ? {
          runner,
          workspaceRoot,
          image: options.image ?? "alpine:3.22",
          network: "none" as const,
          maxSessionTtlSeconds: MAX_AGENT_SESSION_SECONDS,
          maxConcurrentSessions: 2,
          maxOutputBytes: 1024 * 1024,
          capabilities: parsedCapabilities.data,
        }
      : {
          runner,
          workspaceRoot,
          maxSessionTtlSeconds: MAX_AGENT_SESSION_SECONDS,
          maxConcurrentSessions: 2,
          maxOutputBytes: 1024 * 1024,
          capabilities: parsedCapabilities.data,
        };
  const config: ClientConfig = {
    serverUrl,
    ...(body.workspaceId ? { workspaceId: body.workspaceId } : {}),
    ...(options.profileName ? { profileName: options.profileName } : {}),
    machineId: body.machineId,
    machineName: options.machineName,
    privateKeyPem: privateKey,
    stateDirectory: resolve(dirname(configPath), "state"),
    profiles: {
      workspace: profile,
    },
  };
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
    flag: options.replaceConfig ? "w" : "wx",
    flush: true,
  });
  return { machineId: body.machineId, configPath };
}

export async function inspectClientRuntime(
  runners: Array<"host" | "docker"> = ["host"],
  profiles?: ClientConfig["profiles"],
): Promise<ClientRuntimeInfo> {
  const uniqueRunners = [...new Set(runners)];
  const runtime: ClientRuntimeInfo = {
    hostPlatform: hostPlatform(),
    architecture: process.arch,
    defaultShell:
      process.platform === "win32"
        ? (process.env.ComSpec ?? "cmd.exe")
        : (process.env.SHELL ?? "/bin/sh"),
    nodeVersion: process.version,
    protocolVersion: PROTOCOL_VERSION,
    clientVersion: CLIENT_VERSION,
    supportedCapabilities: uniqueRunners.includes("host")
      ? allCapabilities
      : allCapabilities.filter((capability) => capability !== "docker.logs"),
    executionRunners: uniqueRunners,
    ...(profiles
      ? {
          profiles: Object.entries(profiles).map(([name, profile]) => ({
            name,
            runner: profile.runner,
            capabilities: profile.capabilities,
          })),
        }
      : {}),
  };
  if (uniqueRunners.includes("docker")) {
    const docker = await inspectDockerRuntime();
    return {
      ...runtime,
      containerEngine: "docker",
      containerOs: docker.os,
      containerArchitecture: docker.architecture,
      containerEngineVersion: docker.version,
    };
  }
  return runtime;
}

type ActiveSession = {
  session: RunningSession;
  executor: OperationExecutor;
};

export async function terminateLocalAuthority(
  cancelOperations: Array<() => Promise<void>>,
  closeSessions: Array<() => Promise<void>>,
): Promise<void> {
  const results = [
    ...await Promise.allSettled(cancelOperations.map(async (cancel) => cancel())),
    ...await Promise.allSettled(closeSessions.map(async (close) => close())),
  ];
  const failures = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      "Unable to prove local authority was terminated",
    );
  }
}

export class Client {
  private socket: WebSocket | undefined;
  private heartbeat?: NodeJS.Timeout;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectDelay = 1_000;
  private stopped = false;
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly closedSessions = new Set<string>();
  private readonly closingSessions = new Map<string, Promise<void>>();
  private readonly operations = new Map<string, RunningOperation>();
  private readonly executors = new Map<"host" | "docker", OperationExecutor>();
  private readonly journal: OperationJournal;
  private runtime: ClientRuntimeInfo | undefined;

  constructor(private readonly config: ClientConfig) {
    const runners = new Set(
      Object.values(config.profiles).map((profile) => profile.runner),
    );
    if (runners.has("host")) this.executors.set("host", new HostExecutor());
    if (runners.has("docker")) {
      this.executors.set("docker", new DockerRunner(config.machineId));
    }
    this.journal = new OperationJournal(resolve(config.stateDirectory, "operations.sqlite"));
  }

  async start(): Promise<void> {
    this.runtime = await inspectClientRuntime(
      [...this.executors.keys()],
      this.config.profiles,
    );
    await Promise.all([...this.executors.values()].map((executor) => executor.cleanupOrphans()));
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
    try {
      await this.dropLocalAuthority();
    } finally {
      this.journal.close();
    }
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
        console.error("Client message failed:", error);
      });
    });
    socket.on("close", () => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      if (this.socket !== socket) return;
      this.socket = undefined;
      void this.dropLocalAuthority()
        .then(() => {
          if (this.stopped) return;
          console.error(`Disconnected; reconnecting in ${this.reconnectDelay}ms`);
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            void this.connect();
          }, this.reconnectDelay);
          this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
        })
        .catch((error: unknown) => {
          this.stopped = true;
          console.error(
            "Local authority cleanup could not be verified; Client stopped",
            error,
          );
        });
    });
    socket.on("error", (error) => console.error("Client socket error:", error.message));
  }

  private send(message: ClientToServerMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Server is disconnected");
    }
    this.socket.send(JSON.stringify(message));
  }

  private async dropLocalAuthority(): Promise<void> {
    const operations = [...this.operations.values()];
    this.operations.clear();
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await terminateLocalAuthority(
      operations.map((operation) => async () => operation.cancel()),
      sessions.map(
        (active) => async () =>
          active.executor.closeSession(active.session),
      ),
    );
  }

  private async handle(message: ServerToClientMessage): Promise<void> {
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
      case "error":
        console.error(`${message.code}: ${message.message}`);
        this.socket?.close(4005, message.code);
        break;
      case "ping":
        this.send({
          type: "pong",
          machineId: this.config.machineId,
          pingId: message.pingId,
        });
        break;
      case "session.open":
        await this.openSession(message);
        break;
      case "session.expires":
        this.updateSessionExpiry(message);
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
    message: Extract<ServerToClientMessage, { type: "session.open" }>,
  ): Promise<void> {
    try {
      if (this.closedSessions.has(message.sessionId)) {
        this.send({
          type: "session.closed",
          sessionId: message.sessionId,
          reason: "already_closed",
        });
        return;
      }
      const existing = this.sessions.get(message.sessionId);
      if (existing) {
        const requested = {
          machineId: this.config.machineId,
          profile: message.profile,
          capabilities: message.capabilities,
          restrictions: message.restrictions ?? {},
        };
        const current = {
          machineId: this.config.machineId,
          profile: message.profile,
          capabilities: [...existing.session.capabilities],
          restrictions: existing.session.restrictions ?? {},
        };
        if (
          existing.session.profile !== this.config.profiles[message.profile] ||
          !sessionScopeSubsetDecision(requested, current).allowed ||
          !sessionScopeSubsetDecision(current, requested).allowed
        ) {
          throw new Error("Session retry scope does not match active local authority");
        }
        this.updateSessionExpiry({
          type: "session.expires",
          sessionId: message.sessionId,
          expiresAt: message.expiresAt,
          ...(message.serverTime ? { serverTime: message.serverTime } : {}),
        });
        this.send({
          type: "session.opened",
          sessionId: message.sessionId,
          runner: existing.session.runner,
          runtimeId: existing.session.runtimeId,
          ...(existing.session.containerId
            ? { containerId: existing.session.containerId }
            : {}),
        });
        return;
      }
      const localDeadline = adjustedSessionDeadline(
        message.expiresAt,
        message.serverTime,
      );
      const profile = this.config.profiles[message.profile];
      if (!profile) throw new Error(`Unknown local profile: ${message.profile}`);
      const activeForProfile = [...this.sessions.values()].filter(
        (item) => item.session.profile === profile,
      ).length;
      if (activeForProfile >= profile.maxConcurrentSessions) {
        throw new Error("Local concurrent session limit reached");
      }
      const executor = this.executors.get(profile.runner);
      if (!executor) throw new Error(`Executor ${profile.runner} is unavailable`);
      const session = await executor.openSession(
        message.sessionId,
        profile,
        message.capabilities,
        message.restrictions,
        localDeadline,
        () => void this.closeSession(message.sessionId, "expired"),
      );
      if (this.closedSessions.has(message.sessionId)) {
        await executor.closeSession(session);
        this.send({
          type: "session.closed",
          sessionId: message.sessionId,
          reason: "closed_while_opening",
        });
        return;
      }
      this.sessions.set(message.sessionId, { session, executor });
      this.send({
        type: "session.opened",
        sessionId: message.sessionId,
        runner: session.runner,
        runtimeId: session.runtimeId,
        ...(session.containerId ? { containerId: session.containerId } : {}),
      });
    } catch (error) {
      this.send({
        type: "session.open_failed",
        sessionId: message.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private updateSessionExpiry(
    message: Extract<ServerToClientMessage, { type: "session.expires" }>,
  ): void {
    const active = this.sessions.get(message.sessionId);
    if (!active) return;
    const expiresAt = adjustedSessionDeadline(message.expiresAt, message.serverTime);
    const ttlMilliseconds = expiresAt.getTime() - Date.now();
    if (
      ttlMilliseconds <= 0 ||
      ttlMilliseconds > active.session.profile.maxSessionTtlSeconds * 1_000
    ) {
      void this.closeSession(message.sessionId, "invalid_expiry");
      return;
    }
    clearTimeout(active.session.expiryTimer);
    active.session.expiresAt = expiresAt;
    active.session.expiryTimer = setTimeout(
      () => void this.closeSession(message.sessionId, "expired"),
      ttlMilliseconds,
    );
  }

  private async closeSession(sessionId: string, reason: string): Promise<void> {
    const pending = this.closingSessions.get(sessionId);
    if (pending) {
      await pending;
      return;
    }
    this.closedSessions.add(sessionId);
    if (this.closedSessions.size > 1_000) {
      const oldest = this.closedSessions.values().next().value;
      if (oldest !== undefined) this.closedSessions.delete(oldest);
    }
    const active = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    const closing = (async (): Promise<void> => {
      if (active) {
        await active.executor.closeSession(active.session);
      }
      this.send({ type: "session.closed", sessionId, reason });
    })();
    this.closingSessions.set(sessionId, closing);
    try {
      await closing;
    } finally {
      if (this.closingSessions.get(sessionId) === closing) {
        this.closingSessions.delete(sessionId);
      }
    }
  }

  private async startOperation(
    message: Extract<ServerToClientMessage, { type: "operation.start" }>,
  ): Promise<void> {
    const receipt = this.journal.receive(message.operationId);
    if (receipt === "completed" || receipt === "unknown") {
      const previous = this.journal.result(message.operationId);
      if (previous) this.sendCompletion(message.operationId, previous);
      return;
    }
    if (receipt !== "new") return;

    const active = this.sessions.get(message.sessionId);
    if (!active) {
      const result: JournalResult = {
        status: "failed",
        exitCode: null,
        error: "Session is not active on this client",
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
    const maximum = Math.min(message.maxOutputBytes, active.session.profile.maxOutputBytes);
    const maximumEventBytes = 256 * 1024;
    const emit = (stream: "stdout" | "stderr" | "result", data: Buffer): void => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
      if (outputTruncated) return;
      const remaining = maximum - outputBytes;
      if (remaining <= 0) {
        outputTruncated = true;
        return;
      }
      const accepted = data.subarray(0, remaining);
      outputBytes += accepted.length;
      if (accepted.length < data.length) outputTruncated = true;
      for (let offset = 0; offset < accepted.length; offset += maximumEventBytes) {
        this.send({
          type: "operation.event",
          operationId: message.operationId,
          sequence: sequence++,
          stream,
          dataBase64: accepted.subarray(offset, offset + maximumEventBytes).toString("base64"),
        });
      }
    };

    try {
      this.journal.markRunning(message.operationId);
      this.send({ type: "operation.started", operationId: message.operationId, at: new Date().toISOString() });
      const running = await active.executor.execute(
        message.operationId,
        active.session,
        message.action,
        {
        stdout: (data) => emit("stdout", data),
        stderr: (data) => emit("stderr", data),
        result: (data) => emit("result", data),
        },
      );
      const originalCancel = running.cancel;
      running.cancel = async () => {
        cancelled = true;
        await originalCancel();
      };
      this.operations.set(message.operationId, running);
      void (async () => {
        const timer = setTimeout(() => {
          timedOut = true;
          void originalCancel();
        }, Math.min(message.timeoutSeconds, 1800) * 1000);
        try {
          const { exitCode } = await running.done;
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
            status: timedOut
              ? "timed_out"
              : cancelled
                ? "cancelled"
                : "failed",
            exitCode: null,
            error: error instanceof Error ? error.message : String(error),
            outputTruncated,
          };
          this.journal.complete(message.operationId, result);
          this.sendCompletion(message.operationId, result);
        } finally {
          clearTimeout(timer);
          this.operations.delete(message.operationId);
        }
      })();
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
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
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

export async function runClient(
  configPathInput = defaultClientConfigPath(),
): Promise<Client> {
  const configPath = resolve(configPathInput);
  const parsed = clientConfigSchema.safeParse(JSON.parse(await readFile(configPath, "utf8")));
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid client configuration: ${details}`);
  }
  const config: ClientConfig = parsed.data;
  const client = new Client(config);
  const shutdown = (): void => {
    void client.stop().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await client.start();
  return client;
}
