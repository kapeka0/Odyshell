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
import { PendingOperation } from "./operation-control.js";
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

export const CLIENT_VERSION = "0.16.0";

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

type BufferedClientMessage = {
  message: ClientToServerMessage;
  outputBytes: number;
};

export type ClientMessageBufferEnqueueResult =
  | { accepted: false }
  | { accepted: true; truncatedOperationId?: string };

export class ClientMessageBuffer {
  private readonly messages: BufferedClientMessage[] = [];
  private outputBytes = 0;

  constructor(
    private readonly maximumMessages = 4_096,
    private readonly maximumOutputBytes = 16 * 1024 * 1024,
    private readonly beforeOutputDiscard?: (operationId: string) => void,
  ) {}

  enqueue(message: ClientToServerMessage): ClientMessageBufferEnqueueResult {
    const outputBytes = message.type === "operation.event"
      ? Buffer.byteLength(message.dataBase64, "base64")
      : 0;
    if (
      message.type === "operation.event" &&
      this.outputBytes + outputBytes > this.maximumOutputBytes
    ) {
      this.beforeOutputDiscard?.(message.operationId);
      return { accepted: false };
    }
    let truncatedOperationId: string | undefined;
    if (this.messages.length >= this.maximumMessages) {
      if (message.type === "operation.event") {
        this.beforeOutputDiscard?.(message.operationId);
        return { accepted: false };
      }
      const eventIndex = this.messages.findIndex(
        (entry) => entry.message.type === "operation.event",
      );
      const removeAt = eventIndex >= 0 ? eventIndex : 0;
      const outputToDiscard = this.messages[removeAt]?.message;
      if (outputToDiscard?.type === "operation.event") {
        this.beforeOutputDiscard?.(outputToDiscard.operationId);
      }
      const [removed] = this.messages.splice(removeAt, 1);
      this.outputBytes -= removed?.outputBytes ?? 0;
      if (removed?.message.type === "operation.event") {
        truncatedOperationId = removed.message.operationId;
      }
    }
    this.messages.push({ message, outputBytes });
    this.outputBytes += outputBytes;
    if (truncatedOperationId) {
      this.markOutputTruncated(truncatedOperationId);
    }
    return {
      accepted: true,
      ...(truncatedOperationId ? { truncatedOperationId } : {}),
    };
  }

  markOutputTruncated(operationId: string): void {
    for (const entry of this.messages) {
      if (
        entry.message.type !== "operation.completed" ||
        entry.message.operationId !== operationId ||
        entry.message.outputTruncated
      ) {
        continue;
      }
      entry.message = {
        ...entry.message,
        error: entry.message.error ?? "Operation output is incomplete",
        outputTruncated: true,
      };
    }
  }

  peek(): ClientToServerMessage | undefined {
    return this.messages[0]?.message;
  }

  shift(): ClientToServerMessage | undefined {
    const entry = this.messages.shift();
    if (!entry) return undefined;
    this.outputBytes -= entry.outputBytes;
    return entry.message;
  }

  drain(): ClientToServerMessage[] {
    const messages = this.messages.map((entry) => entry.message);
    this.messages.length = 0;
    this.outputBytes = 0;
    return messages;
  }
}

export function operationTimeoutMilliseconds(
  requestedSeconds: number,
  localMaximumSeconds: number,
  sessionExpiresAt: Date,
  now = Date.now(),
): number {
  if (
    !Number.isFinite(requestedSeconds) ||
    requestedSeconds <= 0 ||
    !Number.isFinite(localMaximumSeconds) ||
    localMaximumSeconds <= 0
  ) {
    return 0;
  }
  return Math.max(
    0,
    Math.min(
      Math.floor(requestedSeconds * 1_000),
      Math.floor(localMaximumSeconds * 1_000),
      sessionExpiresAt.getTime() - now,
    ),
  );
}

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
  private readonly operations = new Map<string, PendingOperation>();
  private readonly outputTruncatedOperations = new Set<string>();
  private readonly unconfirmedOutputOperations = new Set<string>();
  private readonly bufferedMessages = new ClientMessageBuffer(
    4_096,
    16 * 1024 * 1024,
    (operationId) => this.markOperationOutputTruncated(operationId),
  );
  private readonly executors = new Map<"host" | "docker", OperationExecutor>();
  private readonly journal: OperationJournal;
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
    this.journal = new OperationJournal(resolve(config.stateDirectory, "operations.sqlite"));
  }

  async start(): Promise<void> {
    const interruptedOperations = this.journal.recoverInterrupted();
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
        this.markUnconfirmedOutputTruncated();
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
        this.journal.close();
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
        this.markUnconfirmedOutputTruncated();
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
      this.markUnconfirmedOutputTruncated();
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
        this.journal.close();
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

  private deliver(message: ClientToServerMessage): boolean {
    if (message.type === "operation.event") {
      this.markOperationOutputUnconfirmed(message.operationId);
    }
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
    return this.bufferedMessages.enqueue(message).accepted;
  }

  private markOperationOutputTruncated(operationId: string): void {
    this.journal.markOutputTruncated(operationId);
    this.bufferedMessages.markOutputTruncated(operationId);
    this.unconfirmedOutputOperations.delete(operationId);
    this.outputTruncatedOperations.add(operationId);
  }

  private markOperationOutputUnconfirmed(operationId: string): void {
    if (this.unconfirmedOutputOperations.has(operationId)) return;
    this.journal.markOutputUnconfirmed(operationId);
    this.unconfirmedOutputOperations.add(operationId);
  }

  private markUnconfirmedOutputTruncated(): void {
    for (const operationId of [...this.unconfirmedOutputOperations]) {
      this.markOperationOutputTruncated(operationId);
    }
  }

  private flushBufferedMessages(): void {
    while (
      this.authenticated &&
      this.socket?.readyState === WebSocket.OPEN
    ) {
      const message = this.bufferedMessages.peek();
      if (!message) return;
      try {
        this.send(message);
        this.bufferedMessages.shift();
      } catch {
        this.authenticated = false;
        return;
      }
    }
  }

  private async dropLocalAuthority(): Promise<void> {
    const operations = [...this.operations.values()];
    const sessions = [...this.sessions.values()];
    for (const active of sessions) active.closing = true;
    this.sessions.clear();
    let terminationError: unknown;
    try {
      await terminateLocalAuthority(
        operations.map((operation) => async () => operation.cancel()),
        sessions.map(
          (active) => async () =>
            active.executor.closeSession(active.session),
        ),
      );
    } catch (error) {
      terminationError = error;
    }
    await Promise.all(operations.map((operation) => operation.waitUntilFinished()));
    this.operations.clear();
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
        this.flushBufferedMessages();
        this.reconcileJournalResults();
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
        this.journal.acknowledge(message.operationId);
        this.unconfirmedOutputOperations.delete(message.operationId);
        this.outputTruncatedOperations.delete(message.operationId);
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
        this.deliver({
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
        this.deliver({
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
        this.deliver({
          type: "session.closed",
          sessionId: message.sessionId,
          reason: "closed_while_opening",
        });
        return;
      }
      this.sessions.set(message.sessionId, { session, executor, closing: false });
      this.deliver({
        type: "session.opened",
        sessionId: message.sessionId,
        runner: session.runner,
        runtimeId: session.runtimeId,
      });
    } catch (error) {
      this.deliver({
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
    const operations = [...this.operations.values()].filter(
      (operation) => operation.sessionId === sessionId,
    );
    const closing = (async (): Promise<void> => {
      await terminateLocalAuthority(
        operations.map((operation) => async () => operation.cancel()),
        active
          ? [async () => active.executor.closeSession(active.session)]
          : [],
      );
      await Promise.all(
        operations.map((operation) => operation.waitUntilFinished()),
      );
      this.deliver({ type: "session.closed", sessionId, reason });
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
    const receipt = this.journal.receive(message.operationId);
    if (receipt === "completed") {
      const previous = this.journal.result(message.operationId);
      if (previous) this.sendCompletion(message.operationId, previous);
      return;
    }
    if (receipt !== "new") return;

    const active = this.sessions.get(message.sessionId);
    if (!active || active.closing) {
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

    const operationsForProfile = [...this.operations.values()].filter(
      (operation) => operation.profile === active.session.profile,
    ).length;
    if (
      operationsForProfile >= active.session.profile.maxConcurrentOperations
    ) {
      const result: JournalResult = {
        status: "failed",
        exitCode: null,
        error: "Local concurrent Operation limit reached",
        outputTruncated: false,
      };
      this.journal.complete(message.operationId, result);
      this.sendCompletion(message.operationId, result);
      return;
    }

    const control = new PendingOperation(
      message.sessionId,
      active.session.profile,
    );
    this.operations.set(message.operationId, control);

    let sequence = 0;
    let outputBytes = 0;
    let outputTruncated = false;
    let timedOut = false;
    let terminalFailure: unknown;
    let timer: NodeJS.Timeout | undefined;
    const deadlineMarker = Symbol("operation-deadline");
    const executionSignal = control.executionSignal();
    const deadlineReached = new Promise<typeof deadlineMarker>((resolveDeadline) => {
      if (executionSignal.aborted) {
        resolveDeadline(deadlineMarker);
        return;
      }
      executionSignal.addEventListener(
        "abort",
        () => resolveDeadline(deadlineMarker),
        { once: true },
      );
    });
    const cancellationFailure = control.waitForCancellationFailure().catch(
      (error: unknown) => {
        terminalFailure = error;
        throw error;
      },
    );
    const requestedMaximum = Number.isInteger(message.maxOutputBytes) &&
        message.maxOutputBytes > 0
      ? message.maxOutputBytes
      : 0;
    const maximum = Math.min(
      requestedMaximum,
      active.session.profile.maxOutputBytes,
    );
    const maximumEventBytes = 256 * 1024;
    const markOutputTruncated = (): void => {
      if (outputTruncated) return;
      if (!this.outputTruncatedOperations.has(message.operationId)) {
        this.markOperationOutputTruncated(message.operationId);
      }
      outputTruncated = true;
    };
    const emit = (stream: "stdout" | "stderr" | "result", data: Buffer): void => {
      if (this.outputTruncatedOperations.has(message.operationId)) {
        outputTruncated = true;
      }
      if (outputTruncated) return;
      const remaining = maximum - outputBytes;
      if (remaining <= 0) {
        markOutputTruncated();
        return;
      }
      const accepted = data.subarray(0, remaining);
      for (let offset = 0; offset < accepted.length; offset += maximumEventBytes) {
        const chunk = accepted.subarray(offset, offset + maximumEventBytes);
        const delivered = this.deliver({
          type: "operation.event",
          operationId: message.operationId,
          sequence,
          stream,
          dataBase64: chunk.toString("base64"),
        });
        if (!delivered) {
          markOutputTruncated();
          return;
        }
        sequence += 1;
        outputBytes += chunk.length;
      }
      if (accepted.length < data.length) markOutputTruncated();
    };

    try {
      if (
        active.closing ||
        this.sessions.get(message.sessionId) !== active ||
        active.session.expiresAt.getTime() <= Date.now()
      ) {
        throw new Error("Session closed before the Operation could start");
      }
      this.journal.markRunning(message.operationId);
      this.deliver({
        type: "operation.started",
        operationId: message.operationId,
        at: new Date().toISOString(),
      });
      const timeoutMilliseconds = operationTimeoutMilliseconds(
        message.timeoutSeconds,
        active.session.profile.maxOperationTimeoutSeconds,
        active.session.expiresAt,
      );
      if (timeoutMilliseconds <= 0) {
        timedOut = true;
        control.failStart();
        await control.cancel();
        throw new Error("Operation deadline elapsed before process start");
      }
      timer = setTimeout(() => {
        timedOut = true;
        void control.cancel().catch(() => {});
      }, timeoutMilliseconds);
      const executionPreparation = active.executor.execute(
        message.operationId,
        active.session,
        message.action,
        {
          stdout: (data) => emit("stdout", data),
          stderr: (data) => emit("stderr", data),
          result: (data) => emit("result", data),
        },
        { signal: executionSignal },
      );
      void executionPreparation.then(
        (lateRunning) => {
          if (!executionSignal.aborted) return;
          void lateRunning.cancel().catch((error: unknown) => {
            this.beginTerminalFailure(
              "Late Operation preparation could not be terminated",
              error,
            );
          });
        },
        () => {},
      );
      const prepared = await Promise.race([executionPreparation, deadlineReached]);
      if (prepared === deadlineMarker) {
        control.failStart();
        await control.cancel();
        throw new Error(
          timedOut
            ? "Operation deadline elapsed before process start"
            : "Operation was cancelled before process start",
        );
      }
      const running = prepared;
      control.attach(running);
      if (control.cancelRequested) await control.cancel();
      const { exitCode } = await Promise.race([running.done, cancellationFailure]);
      outputTruncated ||= this.outputTruncatedOperations.has(
        message.operationId,
      );
      const result: JournalResult = {
        status: timedOut
          ? "timed_out"
          : control.cancelRequested
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
      control.failStart();
      const terminationUnconfirmed = terminalFailure !== undefined;
      outputTruncated ||= this.outputTruncatedOperations.has(
        message.operationId,
      );
      const result: JournalResult = {
        status: terminationUnconfirmed
          ? "execution_unknown"
          : timedOut
            ? "timed_out"
            : control.cancelRequested
              ? "cancelled"
              : "failed",
        exitCode: null,
        error: terminationUnconfirmed
          ? `Unable to confirm process-tree termination: ${error instanceof Error ? error.message : String(error)}`
          : error instanceof Error
            ? error.message
            : String(error),
        outputTruncated,
      };
      this.journal.complete(message.operationId, result);
      this.sendCompletion(message.operationId, result);
    } finally {
      if (timer) clearTimeout(timer);
      if (this.operations.get(message.operationId) === control) {
        this.operations.delete(message.operationId);
      }
      control.markFinished();
      if (terminalFailure !== undefined) {
        this.beginTerminalFailure(
          "Operation process-tree termination could not be proved",
          terminalFailure,
        );
      }
    }
  }

  private async cancelOperation(operationId: string): Promise<void> {
    const operation = this.operations.get(operationId);
    if (operation) {
      await operation.cancel();
      return;
    }
    const previous = this.journal.result(operationId);
    if (previous) {
      this.sendCompletion(operationId, previous);
      return;
    }
    const receipt = this.journal.receive(operationId);
    const result: JournalResult = {
      status: receipt === "new" ? "cancelled" : "execution_unknown",
      exitCode: null,
      error:
        receipt === "new"
          ? "Operation was cancelled before execution started"
          : "Operation execution state was unavailable when cancellation arrived",
      outputTruncated: false,
    };
    this.journal.complete(operationId, result);
    this.sendCompletion(operationId, result);
  }

  private sendCompletion(operationId: string, result: JournalResult): void {
    const outputTruncated =
      result.outputTruncated || this.outputTruncatedOperations.has(operationId);
    const error =
      result.error ??
      (outputTruncated ? "Operation output is incomplete" : undefined);
    this.deliver({
      type: "operation.completed",
      operationId,
      status: result.status,
      exitCode: result.exitCode,
      ...(error ? { error } : {}),
      outputTruncated,
      at: new Date().toISOString(),
    });
  }

  private reconcileJournalResults(): void {
    for (const entry of this.journal.resultsForReconciliation()) {
      this.sendCompletion(entry.operationId, entry.result);
    }
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
