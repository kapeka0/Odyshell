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
  RunningSession,
} from "./executor.js";
import { HostExecutor } from "./host-executor.js";
import { ClientOperationLifecycle } from "./operation-lifecycle.js";
import { passwordlessSudoAvailable } from "./profile.js";
import {
  assertLocalAuthorityNotQuarantined,
  quarantineLocalAuthority,
} from "./quarantine.js";
import {
  clientConfigPathForProfile,
  defaultClientConfigPath,
  hostAccountShell,
  hostPlatform,
  normalizeServerUrl,
} from "./platform.js";

export const CLIENT_VERSION = "0.15.0";

export {
  clientConfigPathForProfile,
  defaultClientConfigPath,
  normalizeClientProfileName,
  normalizeServerUrl,
} from "./platform.js";
export {
  ClientMessageBuffer,
  operationTimeoutMilliseconds,
  type ClientMessageBufferEnqueueResult,
} from "./operation-lifecycle.js";

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
  configureClientPrivilegeEscalation,
  listClientProfiles,
  removeAllClientProfiles,
  removeClientProfile,
  verifyPasswordlessSudo,
  type ConfigureClientPrivilegeEscalationOptions,
  type ListedClientProfile,
  type ListClientProfilesOptions,
  type RemoveAllClientProfilesOptions,
  type RemoveClientProfileOptions,
} from "./profile.js";

export type EnrollClientOptions = {
  serverUrl: string;
  token: string;
  machineName: string;
  mountSource?: string;
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
  const configPath = resolve(options.configPath);
  const parsedCapabilities = capabilitySchema
    .array()
    .min(1)
    .safeParse([...new Set(options.allowedCapabilities)]);
  if (!parsedCapabilities.success) {
    throw new Error("At least one valid capability must be explicitly allowed");
  }
  const runner = options.runner ?? "host";
  if (runner === "docker" && parsedCapabilities.data.includes("host.shell")) {
    throw new Error("host.shell is only available through the host runner");
  }
  if (runner === "docker" && !options.mountSource) {
    throw new Error("Docker enrollment requires an explicit mount source");
  }
  if (runner === "host" && options.mountSource !== undefined) {
    throw new Error("--mount-source is only available with the Docker runner");
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

  const profile =
    runner === "docker"
      ? {
          runner,
          mountSource: resolve(options.mountSource!),
          image: options.image ?? "alpine:3.22",
          network: "none" as const,
          maxSessionTtlSeconds: MAX_AGENT_SESSION_SECONDS,
          maxConcurrentSessions: 2,
          maxConcurrentOperations: 4,
          maxOperationTimeoutSeconds: 3_600,
          maxOutputBytes: 1024 * 1024,
          capabilities: parsedCapabilities.data,
        }
      : {
          runner,
          maxSessionTtlSeconds: MAX_AGENT_SESSION_SECONDS,
          maxConcurrentSessions: 2,
          maxConcurrentOperations: 4,
          maxOperationTimeoutSeconds: 3_600,
          maxOutputBytes: 1024 * 1024,
          capabilities: parsedCapabilities.data,
        };
  const config: ClientConfig = clientConfigSchema.parse({
    serverUrl,
    ...(body.workspaceId ? { workspaceId: body.workspaceId } : {}),
    ...(options.profileName ? { profileName: options.profileName } : {}),
    machineId: body.machineId,
    machineName: options.machineName,
    privateKeyPem: privateKey,
    stateDirectory: resolve(dirname(configPath), "state"),
    allowPrivilegeEscalation: false,
    profiles: {
      workspace: profile,
    },
  });
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
  allowPrivilegeEscalation = false,
): Promise<ClientRuntimeInfo> {
  const uniqueRunners = [...new Set(runners)];
  const effectivePasswordlessSudo =
    process.platform === "linux" && uniqueRunners.includes("host")
      ? await passwordlessSudoAvailable()
      : false;
  const runtime: ClientRuntimeInfo = {
    hostPlatform: hostPlatform(),
    architecture: process.arch,
    defaultShell: hostAccountShell().program,
    privilegeEscalation: reportedPrivilegeEscalation(
      allowPrivilegeEscalation,
      effectivePasswordlessSudo,
    ),
    nodeVersion: process.version,
    protocolVersion: PROTOCOL_VERSION,
    clientVersion: CLIENT_VERSION,
    supportedCapabilities: supportedCapabilitiesForRunners(uniqueRunners),
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

export function reportedPrivilegeEscalation(
  configured: boolean,
  passwordlessSudoAvailable: boolean,
): "none" | "sudo" {
  return configured || passwordlessSudoAvailable ? "sudo" : "none";
}

export function supportedCapabilitiesForRunners(
  runners: Array<"host" | "docker">,
): Capability[] {
  if (runners.includes("host")) return [...allCapabilities];
  return allCapabilities.filter(
    (capability) => capability !== "docker.logs" && capability !== "host.shell",
  );
}

type ActiveSession = {
  session: RunningSession;
  executor: OperationExecutor;
  closing: boolean;
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

export function terminalMachineClose(code: number): boolean {
  return code === 4004;
}

export class Client {
  private socket: WebSocket | undefined;
  private authenticated = false;
  private heartbeat?: NodeJS.Timeout;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectDelay = 1_000;
  private stopped = false;
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly closedSessions = new Set<string>();
  private readonly closingSessions = new Map<string, Promise<void>>();
  private readonly executors = new Map<"host" | "docker", OperationExecutor>();
  private readonly operationLifecycle: ClientOperationLifecycle;
  private messageQueue = Promise.resolve();
  private shutdown: Promise<void> | undefined;
  private runtime: ClientRuntimeInfo | undefined;
  private failClosedKeepalive: NodeJS.Timeout | undefined;

  constructor(private readonly config: ClientConfig) {
    assertLocalAuthorityNotQuarantined(config.stateDirectory);
    const runners = new Set(
      Object.values(config.profiles).map((profile) => profile.runner),
    );
    if (runners.has("host")) this.executors.set("host", new HostExecutor());
    if (runners.has("docker")) {
      this.executors.set("docker", new DockerRunner(config.machineId));
    }
    this.operationLifecycle = new ClientOperationLifecycle(
      resolve(config.stateDirectory, "operations.sqlite"),
      (message) => this.sendIfConnected(message),
      {
        onTerminalFailure: (context, error) =>
          this.beginTerminalFailure(context, error),
      },
    );
  }

  async start(): Promise<void> {
    const interruptedOperations = this.operationLifecycle.recoverInterrupted();
    if (interruptedOperations > 0) {
      console.error(
        `Recovered ${interruptedOperations} interrupted Operation${interruptedOperations === 1 ? "" : "s"} as execution_unknown`,
      );
    }
    this.runtime = await inspectClientRuntime(
      [...this.executors.keys()],
      this.config.profiles,
      this.config.allowPrivilegeEscalation,
    );
    await Promise.all([...this.executors.values()].map((executor) => executor.cleanupOrphans()));
    await this.connect();
  }

  async stop(): Promise<void> {
    if (this.shutdown) return await this.shutdown;
    this.stopped = true;
    this.authenticated = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const socket = this.socket;
    this.shutdown = (async (): Promise<void> => {
      let outputReconciliationError: unknown;
      try {
        this.operationLifecycle.markUnconfirmedOutputTruncated();
      } catch (error) {
        outputReconciliationError = error;
      }
      socket?.close();
      await this.messageQueue;
      try {
        await this.dropLocalAuthority();
        if (outputReconciliationError !== undefined) {
          throw outputReconciliationError;
        }
      } finally {
        this.operationLifecycle.close();
      }
    })();
    await this.shutdown;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const url = new URL("/v1/connect", this.config.serverUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    this.socket = socket;
    this.authenticated = false;

    socket.on("open", () => console.log(`Connected to ${url.toString()}`));
    socket.on("message", (data) => {
      this.messageQueue = this.messageQueue
        .then(() => {
          if (this.socket !== socket || this.stopped) return;
          return this.handle(parseServerMessage(data.toString()));
        })
        .catch((error: unknown) => {
          console.error("Client message failed:", error);
        });
    });
    socket.on("close", (code) => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      try {
        this.operationLifecycle.markUnconfirmedOutputTruncated();
      } catch (error) {
        this.beginTerminalFailure(
          "Unable to preserve unconfirmed Operation output",
          error,
        );
        return;
      }
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.authenticated = false;
      if (terminalMachineClose(code)) {
        this.beginTerminalRevocation();
        return;
      }
      if (this.stopped) return;
      console.error(`Disconnected; reconnecting in ${this.reconnectDelay}ms`);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined;
        void this.connect();
      }, this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
    });
    socket.on("error", (error) => console.error("Client socket error:", error.message));
  }

  private beginTerminalRevocation(): void {
    console.error("Machine access was revoked; terminating local authority");
    this.beginTerminalShutdown("Machine revocation");
  }

  private beginTerminalFailure(context: string, error: unknown): void {
    console.error(`${context}; terminating local authority:`, error);
    try {
      quarantineLocalAuthority(this.config.stateDirectory);
    } catch (quarantineError) {
      console.error("Unable to persist the local authority quarantine:", quarantineError);
      this.failClosedKeepalive ??= setInterval(() => {}, 24 * 60 * 60_000);
    }
    this.beginTerminalShutdown(context);
  }

  private beginTerminalShutdown(context: string): void {
    if (this.shutdown) return;
    let outputReconciliationError: unknown;
    try {
      this.operationLifecycle.markUnconfirmedOutputTruncated();
    } catch (error) {
      outputReconciliationError = error;
    }
    this.stopped = true;
    this.authenticated = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const socket = this.socket;
    this.socket = undefined;
    socket?.close(1011, "Local authority enforcement failed");
    this.shutdown = (async (): Promise<void> => {
      try {
        await this.messageQueue;
        await this.dropLocalAuthority();
        if (outputReconciliationError !== undefined) {
          throw outputReconciliationError;
        }
      } finally {
        this.operationLifecycle.close();
      }
    })();
    void this.shutdown.catch((error: unknown) => {
      console.error(`${context} cleanup failed:`, error);
    });
  }

  private send(message: ClientToServerMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Server is disconnected");
    }
    this.socket.send(JSON.stringify(message));
  }

  private sendIfConnected(message: ClientToServerMessage): boolean {
    if (
      this.authenticated &&
      this.socket?.readyState === WebSocket.OPEN
    ) {
      try {
        this.send(message);
        return true;
      } catch {
        this.authenticated = false;
      }
    }
    return false;
  }

  private async dropLocalAuthority(): Promise<void> {
    const sessions = [...this.sessions.values()];
    for (const active of sessions) active.closing = true;
    this.sessions.clear();
    let terminationError: unknown;
    try {
      await terminateLocalAuthority(
        [async () => this.operationLifecycle.terminateAll()],
        sessions.map(
          (active) => async () =>
            active.executor.closeSession(active.session),
        ),
      );
    } catch (error) {
      terminationError = error;
    }
    if (terminationError !== undefined) throw terminationError;
  }

  private async handle(message: ServerToClientMessage): Promise<void> {
    if (this.stopped) return;
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
        this.authenticated = true;
        this.reconnectDelay = 1_000;
        console.log(`Authenticated as ${this.config.machineName} (${message.machineId})`);
        this.operationLifecycle.flush();
        this.operationLifecycle.reconcile();
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
        if (!this.authenticated) return;
        await this.openSession(message);
        break;
      case "session.expires":
        if (!this.authenticated) return;
        this.updateSessionExpiry(message);
        break;
      case "session.close":
        if (!this.authenticated) return;
        await this.closeSession(message.sessionId, message.reason);
        break;
      case "operation.start":
        if (!this.authenticated) return;
        void this.startOperation(message).catch((error: unknown) => {
          console.error("Client Operation failed:", error);
        });
        break;
      case "operation.acknowledged":
        if (!this.authenticated) return;
        this.operationLifecycle.acknowledge(message.operationId);
        break;
      case "operation.cancel":
        if (!this.authenticated) return;
        await this.cancelOperation(message.operationId);
        break;
    }
  }

  private async openSession(
    message: Extract<ServerToClientMessage, { type: "session.open" }>,
  ): Promise<void> {
    try {
      if (this.closedSessions.has(message.sessionId)) {
        this.operationLifecycle.deliver({
          type: "session.closed",
          sessionId: message.sessionId,
          reason: "already_closed",
        });
        return;
      }
      const existing = this.sessions.get(message.sessionId);
      if (existing) {
        if (existing.closing) {
          throw new Error("Session is already closing on this client");
        }
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
        this.operationLifecycle.deliver({
          type: "session.opened",
          sessionId: message.sessionId,
          runner: existing.session.runner,
          runtimeId: existing.session.runtimeId,
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
        () => this.closeSessionSafely(message.sessionId, "expired"),
      );
      if (this.closedSessions.has(message.sessionId)) {
        await executor.closeSession(session);
        this.operationLifecycle.deliver({
          type: "session.closed",
          sessionId: message.sessionId,
          reason: "closed_while_opening",
        });
        return;
      }
      this.sessions.set(message.sessionId, { session, executor, closing: false });
      this.operationLifecycle.deliver({
        type: "session.opened",
        sessionId: message.sessionId,
        runner: session.runner,
        runtimeId: session.runtimeId,
      });
    } catch (error) {
      this.operationLifecycle.deliver({
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
      this.closeSessionSafely(message.sessionId, "invalid_expiry");
      return;
    }
    clearTimeout(active.session.expiryTimer);
    active.session.expiresAt = expiresAt;
    active.session.expiryTimer = setTimeout(
      () => this.closeSessionSafely(message.sessionId, "expired"),
      ttlMilliseconds,
    );
  }

  private closeSessionSafely(sessionId: string, reason: string): void {
    void this.closeSession(sessionId, reason).catch((error: unknown) => {
      this.beginTerminalFailure(
        `Session ${reason} cleanup could not prove local authority termination`,
        error,
      );
    });
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
    if (active) active.closing = true;
    const closing = (async (): Promise<void> => {
      await terminateLocalAuthority(
        [async () => this.operationLifecycle.terminateSession(sessionId)],
        active
          ? [async () => active.executor.closeSession(active.session)]
          : [],
      );
      this.operationLifecycle.deliver({
        type: "session.closed",
        sessionId,
        reason,
      });
    })();
    this.closingSessions.set(sessionId, closing);
    try {
      await closing;
    } finally {
      if (active && this.sessions.get(sessionId) === active) {
        this.sessions.delete(sessionId);
      }
      if (this.closingSessions.get(sessionId) === closing) {
        this.closingSessions.delete(sessionId);
      }
    }
  }

  private async startOperation(
    message: Extract<ServerToClientMessage, { type: "operation.start" }>,
  ): Promise<void> {
    const active = this.sessions.get(message.sessionId);
    await this.operationLifecycle.start(
      message,
      !active || active.closing
        ? null
        : {
            profile: active.session.profile,
            expiresAt: active.session.expiresAt,
            isActive: () =>
              !active.closing &&
              this.sessions.get(message.sessionId) === active,
            execute: (operationId, action, output, options) =>
              active.executor.execute(
                operationId,
                active.session,
                action,
                output,
                options,
              ),
          },
    );
  }

  private async cancelOperation(operationId: string): Promise<void> {
    await this.operationLifecycle.cancel(operationId);
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
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void client.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error("Client shutdown could not prove local authority termination:", error);
        process.exit(1);
      },
    );
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await client.start();
  return client;
}
