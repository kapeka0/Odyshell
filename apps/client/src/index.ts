import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, resolve } from "node:path";
import process from "node:process";
import {
  MAX_CLIENT_CLOCK_SKEW_MILLISECONDS,
  PROTOCOL_VERSION,
  clientConfigSchema,
  localTaskDecision,
  parseServerMessage,
  type ClientConfig,
  type ClientRuntimeInfo,
  type ClientToServerMessage,
  type ServerToClientMessage,
} from "@odyshell/protocol";
import WebSocket from "ws";
import { PendingCommand } from "./command-control.js";
import { CommandJournal, type CommandResult } from "./journal.js";
import {
  assertLocalAuthorityNotQuarantined,
  quarantineLocalAuthority,
} from "./quarantine.js";
import { ShellExecutor } from "./shell-executor.js";
import {
  clientConfigPathForProfile,
  defaultClientConfigPath,
  hostAccountShell,
  hostPlatform,
  normalizeServerUrl,
} from "./platform.js";

export const CLIENT_VERSION = "0.16.1";

export {
  clientConfigPathForProfile,
  defaultClientConfigPath,
  normalizeClientProfileName,
  normalizeServerUrl,
} from "./platform.js";
export {
  activateLinuxUserService,
  clientServiceStatus,
  installClientService,
  installLinuxUserService,
  linuxServiceNameForConfig,
  linuxUserServicePath,
  removeLinuxUserService,
  removeClientService,
  renderLinuxUserService,
  restartClientService,
  stopClientService,
  stopLinuxUserService,
} from "./service.js";
export {
  listClientProfiles,
  removeAllClientProfiles,
  removeClientProfile,
  type ListedClientProfile,
  type ListClientProfilesOptions,
  type RemoveAllClientProfilesOptions,
  type RemoveClientProfileOptions,
} from "./profile.js";

export type EnrollClientOptions = {
  serverUrl: string;
  token: string;
  machineName: string;
  agentId: string;
  configPath: string;
  profileName?: string;
  previousMachineId?: string;
  replaceConfig?: boolean;
};

export async function enrollClient(options: EnrollClientOptions): Promise<{
  machineId: string;
  configPath: string;
}> {
  const serverUrl = normalizeServerUrl(options.serverUrl);
  const configPath = resolve(options.configPath);
  const agentId = options.agentId.trim();
  if (agentId.length === 0 || agentId.length > 256) {
    throw new Error("One valid Agent ID must be explicitly allowed");
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
    organizationId?: string;
    error?: string;
  };
  if (!response.ok || !body.machineId || !body.organizationId) {
    throw new Error(body.error ?? `Enrollment failed: ${response.status}`);
  }

  const config: ClientConfig = clientConfigSchema.parse({
    serverUrl,
    ...(options.profileName ? { profileName: options.profileName } : {}),
    machineId: body.machineId,
    machineName: options.machineName,
    privateKeyPem: privateKey,
    stateDirectory: resolve(dirname(configPath), "state"),
    taskProfile: {
      id: options.profileName ?? "default",
      localPolicy: {
        organizationId: body.organizationId,
        agentIds: [agentId],
        maxTaskDurationSeconds: 3_600,
        maxConcurrentTasks: 1,
        maxConcurrentCommands: 1,
        maxCommandTimeoutSeconds: 600,
        maxCommandOutputBytes: 1024 * 1024,
        allowRemoteApproval: true,
      },
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

export async function inspectClientRuntime(): Promise<ClientRuntimeInfo> {
  return {
    hostPlatform: hostPlatform(),
    architecture: process.arch,
    defaultShell: hostAccountShell().program,
    privilegeEscalation: "none",
    nodeVersion: process.version,
    protocolVersion: PROTOCOL_VERSION,
    clientVersion: CLIENT_VERSION,
  };
}

export function adjustedTaskDeadline(
  expiresAt: string,
  serverTime: string | undefined,
  localNow = Date.now(),
): Date {
  const serverNow = serverTime === undefined ? localNow : Date.parse(serverTime);
  const absoluteExpiry = Date.parse(expiresAt);
  if (!Number.isFinite(serverNow) || !Number.isFinite(absoluteExpiry)) {
    throw new Error("Task deadline is invalid");
  }
  if (
    serverTime !== undefined &&
    Math.abs(localNow - serverNow) > MAX_CLIENT_CLOCK_SKEW_MILLISECONDS
  ) {
    throw new Error("Client clock is outside the allowed Task skew");
  }
  return new Date(localNow + (absoluteExpiry - serverNow));
}

export function commandTimeoutMilliseconds(
  requestedSeconds: number,
  localMaximumSeconds: number,
  taskExpiresAt: Date,
  now = Date.now(),
): number {
  if (
    !Number.isInteger(requestedSeconds) ||
    requestedSeconds <= 0 ||
    !Number.isInteger(localMaximumSeconds) ||
    localMaximumSeconds <= 0 ||
    requestedSeconds > localMaximumSeconds
  ) {
    return 0;
  }
  return Math.max(
    0,
    Math.min(requestedSeconds * 1_000, taskExpiresAt.getTime() - now),
  );
}

export async function terminateLocalAuthority(
  cancelCommands: Array<() => Promise<void>>,
  closeTasks: Array<() => Promise<void>>,
): Promise<void> {
  const results = [
    ...await Promise.allSettled(cancelCommands.map(async (cancel) => cancel())),
    ...await Promise.allSettled(closeTasks.map(async (close) => close())),
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

type ActiveTask = {
  organizationId: string;
  agentId: string;
  clientProfileId: string;
  contractExpiresAt: string;
  expiresAt: Date;
  maxConcurrentCommands: number;
  closing: boolean;
  expiryTimer: NodeJS.Timeout;
};

type BufferedClientMessage = {
  message: ClientToServerMessage;
  outputBytes: number;
};

export type ClientMessageBufferEnqueueResult =
  | { accepted: false }
  | { accepted: true; truncatedCommandId?: string };

export class ClientMessageBuffer {
  private readonly messages: BufferedClientMessage[] = [];
  private outputBytes = 0;

  constructor(
    private readonly maximumMessages = 4_096,
    private readonly maximumOutputBytes = 16 * 1024 * 1024,
    private readonly beforeOutputDiscard?: (commandId: string) => void,
  ) {}

  enqueue(message: ClientToServerMessage): ClientMessageBufferEnqueueResult {
    const output = outputMessage(message);
    const outputBytes = output ? Buffer.byteLength(output.dataBase64, "base64") : 0;
    if (output && this.outputBytes + outputBytes > this.maximumOutputBytes) {
      this.beforeOutputDiscard?.(output.commandId);
      return { accepted: false };
    }
    let truncatedCommandId: string | undefined;
    if (this.messages.length >= this.maximumMessages) {
      if (output) {
        this.beforeOutputDiscard?.(output.commandId);
        return { accepted: false };
      }
      const outputIndex = this.messages.findIndex(
        (entry) => outputMessage(entry.message) !== null,
      );
      const removeAt = outputIndex >= 0 ? outputIndex : 0;
      const outputToDiscard = this.messages[removeAt]?.message;
      const discardedOutput = outputToDiscard ? outputMessage(outputToDiscard) : null;
      if (discardedOutput) this.beforeOutputDiscard?.(discardedOutput.commandId);
      const [removed] = this.messages.splice(removeAt, 1);
      this.outputBytes -= removed?.outputBytes ?? 0;
      const removedOutput = removed ? outputMessage(removed.message) : null;
      if (removedOutput) {
        truncatedCommandId = removedOutput.commandId;
      }
    }
    this.messages.push({ message, outputBytes });
    this.outputBytes += outputBytes;
    if (truncatedCommandId) this.markOutputTruncated(truncatedCommandId);
    return {
      accepted: true,
      ...(truncatedCommandId ? { truncatedCommandId } : {}),
    };
  }

  markOutputTruncated(commandId: string): void {
    for (const entry of this.messages) {
      if (
        entry.message.type === "command.completed" &&
        entry.message.commandId === commandId &&
        !entry.message.outputTruncated
      ) {
        entry.message = {
          ...entry.message,
          error: entry.message.error ?? "Command output is incomplete",
          outputTruncated: true,
        };
      }
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

function outputMessage(
  message: ClientToServerMessage,
): { commandId: string; dataBase64: string } | null {
  return message.type === "command.output"
    ? { commandId: message.commandId, dataBase64: message.dataBase64 }
    : null;
}

export class Client {
  private socket: WebSocket | undefined;
  private authenticated = false;
  private heartbeat?: NodeJS.Timeout;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectDelay = 1_000;
  private stopped = false;
  private readonly tasks = new Map<string, ActiveTask>();
  private readonly closedTasks = new Set<string>();
  private readonly closingTasks = new Map<string, Promise<void>>();
  private readonly commands = new Map<string, PendingCommand>();
  private readonly outputTruncatedCommands = new Set<string>();
  private readonly unconfirmedOutputCommands = new Set<string>();
  private readonly bufferedMessages = new ClientMessageBuffer(
    4_096,
    16 * 1024 * 1024,
    (commandId) => this.markCommandOutputTruncated(commandId),
  );
  private readonly executor = new ShellExecutor();
  private readonly journal: CommandJournal;
  private messageQueue = Promise.resolve();
  private shutdown: Promise<void> | undefined;
  private runtime: ClientRuntimeInfo | undefined;
  private failClosedKeepalive: NodeJS.Timeout | undefined;

  constructor(private readonly config: ClientConfig) {
    if (!config.taskProfile) {
      throw new Error("Client configuration requires one Task Profile");
    }
    assertLocalAuthorityNotQuarantined(config.stateDirectory);
    this.journal = new CommandJournal(resolve(config.stateDirectory, "commands.sqlite"));
  }

  async start(): Promise<void> {
    const interruptedCommands = this.journal.recoverInterrupted();
    if (interruptedCommands > 0) {
      console.error(
        `Recovered ${interruptedCommands} interrupted Command${interruptedCommands === 1 ? "" : "s"} as execution_unknown`,
      );
    }
    this.runtime = await inspectClientRuntime();
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
        if (outputReconciliationError !== undefined) throw outputReconciliationError;
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
          socket.close(4002, "Protocol error");
        });
    });
    socket.on("close", (code) => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      try {
        this.markUnconfirmedOutputTruncated();
      } catch (error) {
        this.beginTerminalFailure("Unable to preserve unconfirmed Command output", error);
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
        if (outputReconciliationError !== undefined) throw outputReconciliationError;
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
    const output = outputMessage(message);
    if (output) this.markCommandOutputUnconfirmed(output.commandId);
    if (this.authenticated && this.socket?.readyState === WebSocket.OPEN) {
      try {
        this.send(message);
        return true;
      } catch {
        this.authenticated = false;
      }
    }
    return this.bufferedMessages.enqueue(message).accepted;
  }

  private markCommandOutputTruncated(commandId: string): void {
    this.journal.markOutputTruncated(commandId);
    this.bufferedMessages.markOutputTruncated(commandId);
    this.unconfirmedOutputCommands.delete(commandId);
    this.outputTruncatedCommands.add(commandId);
  }

  private markCommandOutputUnconfirmed(commandId: string): void {
    if (this.unconfirmedOutputCommands.has(commandId)) return;
    this.journal.markOutputUnconfirmed(commandId);
    this.unconfirmedOutputCommands.add(commandId);
  }

  private markUnconfirmedOutputTruncated(): void {
    for (const commandId of [...this.unconfirmedOutputCommands]) {
      this.markCommandOutputTruncated(commandId);
    }
  }

  private flushBufferedMessages(): void {
    while (this.authenticated && this.socket?.readyState === WebSocket.OPEN) {
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
    const commands = [...this.commands.values()];
    const tasks = [...this.tasks.values()];
    for (const task of tasks) task.closing = true;
    this.tasks.clear();
    let terminationError: unknown;
    try {
      await terminateLocalAuthority(
        commands.map((command) => async () => command.cancel()),
        tasks.map((task) => async () => clearTimeout(task.expiryTimer)),
      );
    } catch (error) {
      terminationError = error;
    }
    await Promise.all(commands.map((command) => command.waitUntilFinished()));
    this.commands.clear();
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
          taskProfile: {
            id: this.config.taskProfile!.id,
            operatingSystemUser: userInfo().username,
            localPolicy: this.config.taskProfile!.localPolicy,
          },
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
      case "task.open":
        if (this.authenticated) await this.openTask(message);
        break;
      case "task.close":
        if (this.authenticated) await this.closeTask(message.taskId, message.reason);
        break;
      case "command.start":
        if (this.authenticated) {
          void this.startCommand(message).catch((error: unknown) => {
            console.error("Client Command failed:", error);
          });
        }
        break;
      case "command.acknowledged":
        if (!this.authenticated) return;
        this.journal.acknowledge(message.commandId);
        this.unconfirmedOutputCommands.delete(message.commandId);
        this.outputTruncatedCommands.delete(message.commandId);
        break;
      case "command.cancel":
        if (this.authenticated) await this.cancelCommand(message.commandId);
        break;
    }
  }

  private async openTask(
    message: Extract<ServerToClientMessage, { type: "task.open" }>,
  ): Promise<void> {
    const taskProfile = this.config.taskProfile!;
    try {
      if (taskProfile.id !== message.clientProfileId) {
        throw new Error("Task Client Profile is not configured locally");
      }
      if (this.closedTasks.has(message.taskId)) {
        this.deliver({ type: "task.closed", taskId: message.taskId, reason: "already_closed" });
        return;
      }
      const existing = this.tasks.get(message.taskId);
      if (existing) {
        if (
          existing.closing ||
          existing.organizationId !== message.organizationId ||
          existing.agentId !== message.agentId ||
          existing.clientProfileId !== message.clientProfileId ||
          existing.contractExpiresAt !== message.expiresAt ||
          existing.maxConcurrentCommands !== message.maxConcurrentCommands
        ) {
          throw new Error("Task retry does not match active local authority");
        }
        this.sendTaskOpened(message.taskId);
        return;
      }
      const deadline = adjustedTaskDeadline(message.expiresAt, message.serverTime);
      const durationSeconds = Math.ceil((deadline.getTime() - Date.now()) / 1_000);
      const decision = localTaskDecision(taskProfile.localPolicy, {
        organizationId: message.organizationId,
        agentId: message.agentId,
        durationSeconds,
        activeTasks: this.tasks.size,
        maxConcurrentCommands: message.maxConcurrentCommands,
      });
      if (!decision.allowed) {
        throw new Error(`Task violates Local Policy: ${decision.code}`);
      }
      if (durationSeconds <= 0) throw new Error("Task expired before local authority opened");
      const task: ActiveTask = {
        organizationId: message.organizationId,
        agentId: message.agentId,
        clientProfileId: message.clientProfileId,
        contractExpiresAt: message.expiresAt,
        expiresAt: deadline,
        maxConcurrentCommands: message.maxConcurrentCommands,
        closing: false,
        expiryTimer: setTimeout(
          () => this.closeTaskSafely(message.taskId, "expired"),
          deadline.getTime() - Date.now(),
        ),
      };
      this.tasks.set(message.taskId, task);
      if (this.closedTasks.has(message.taskId)) {
        await this.closeTask(message.taskId, "closed_while_opening");
        return;
      }
      this.sendTaskOpened(message.taskId);
    } catch (error) {
      this.deliver({
        type: "task.open_failed",
        taskId: message.taskId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private sendTaskOpened(taskId: string): void {
    this.deliver({
      type: "task.opened",
      taskId,
      clientProfileId: this.config.taskProfile!.id,
      operatingSystemUser: userInfo().username,
    });
  }

  private closeTaskSafely(taskId: string, reason: string): void {
    void this.closeTask(taskId, reason).catch((error: unknown) => {
      this.beginTerminalFailure(
        `Task ${reason} cleanup could not prove local authority termination`,
        error,
      );
    });
  }

  private async closeTask(taskId: string, reason: string): Promise<void> {
    const pending = this.closingTasks.get(taskId);
    if (pending) return await pending;
    this.closedTasks.add(taskId);
    if (this.closedTasks.size > 1_000) {
      const oldest = this.closedTasks.values().next().value;
      if (oldest !== undefined) this.closedTasks.delete(oldest);
    }
    const task = this.tasks.get(taskId);
    if (task) task.closing = true;
    const commands = [...this.commands.values()].filter(
      (command) => command.taskId === taskId,
    );
    const closing = (async (): Promise<void> => {
      await terminateLocalAuthority(
        commands.map((command) => async () => command.cancel()),
        task ? [async () => clearTimeout(task.expiryTimer)] : [],
      );
      await Promise.all(commands.map((command) => command.waitUntilFinished()));
      this.deliver({ type: "task.closed", taskId, reason });
    })();
    this.closingTasks.set(taskId, closing);
    try {
      await closing;
    } finally {
      if (task && this.tasks.get(taskId) === task) this.tasks.delete(taskId);
      if (this.closingTasks.get(taskId) === closing) this.closingTasks.delete(taskId);
    }
  }

  private async startCommand(
    message: Extract<ServerToClientMessage, { type: "command.start" }>,
  ): Promise<void> {
    const receipt = this.journal.receive(message.commandId);
    if (receipt === "completed") {
      const previous = this.journal.result(message.commandId);
      if (previous) this.sendCompletion(message.commandId, previous);
      return;
    }
    if (receipt !== "new") return;

    const task = this.tasks.get(message.taskId);
    if (!task || task.closing || task.expiresAt.getTime() <= Date.now()) {
      return this.failCommand(message.commandId, "Task is not active on this Client");
    }
    const commandsForTask = [...this.commands.values()].filter(
      (command) => command.taskId === message.taskId,
    ).length;
    if (commandsForTask >= task.maxConcurrentCommands) {
      return this.failCommand(message.commandId, "Local concurrent Command limit reached");
    }

    const policy = this.config.taskProfile!.localPolicy;
    const maximumOutputBytes = Math.min(
      message.maxOutputBytes,
      policy.maxCommandOutputBytes,
    );
    const timeoutMilliseconds = commandTimeoutMilliseconds(
      message.timeoutSeconds,
      policy.maxCommandTimeoutSeconds,
      task.expiresAt,
    );
    if (maximumOutputBytes < 1 || timeoutMilliseconds <= 0) {
      return this.failCommand(message.commandId, "Command exceeds Local Policy or Task expiry");
    }

    const control = new PendingCommand(message.taskId);
    this.commands.set(message.commandId, control);
    let sequence = 0;
    let outputBytes = 0;
    let outputTruncated = false;
    let timedOut = false;
    let terminalFailure: unknown;
    let timer: NodeJS.Timeout | undefined;
    const deadlineMarker = Symbol("command-deadline");
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
    const markOutputTruncated = (): void => {
      if (outputTruncated) return;
      if (!this.outputTruncatedCommands.has(message.commandId)) {
        this.markCommandOutputTruncated(message.commandId);
      }
      outputTruncated = true;
    };
    const emit = (stream: "stdout" | "stderr", data: Buffer): void => {
      if (this.outputTruncatedCommands.has(message.commandId)) outputTruncated = true;
      if (outputTruncated) return;
      const remaining = maximumOutputBytes - outputBytes;
      if (remaining <= 0) {
        markOutputTruncated();
        return;
      }
      const accepted = data.subarray(0, remaining);
      for (let offset = 0; offset < accepted.length; offset += 256 * 1024) {
        const chunk = accepted.subarray(offset, offset + 256 * 1024);
        if (!this.deliver({
          type: "command.output",
          commandId: message.commandId,
          sequence,
          stream,
          dataBase64: chunk.toString("base64"),
        })) {
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
        task.closing ||
        this.tasks.get(message.taskId) !== task ||
        task.expiresAt.getTime() <= Date.now()
      ) {
        throw new Error("Task closed before the Command could start");
      }
      this.journal.markRunning(message.commandId);
      this.deliver({
        type: "command.started",
        commandId: message.commandId,
        at: new Date().toISOString(),
      });
      timer = setTimeout(() => {
        timedOut = true;
        void control.cancel().catch(() => {});
      }, timeoutMilliseconds);
      const preparation = this.executor.execute(
        message.command,
        message.cwd,
        { stdout: (data) => emit("stdout", data), stderr: (data) => emit("stderr", data) },
        executionSignal,
      );
      void preparation.then(
        (lateRunning) => {
          if (!executionSignal.aborted) return;
          void lateRunning.cancel().catch((error: unknown) => {
            this.beginTerminalFailure("Late Command preparation could not be terminated", error);
          });
        },
        () => {},
      );
      const prepared = await Promise.race([preparation, deadlineReached]);
      if (prepared === deadlineMarker) {
        control.failStart();
        await control.cancel();
        throw new Error(
          timedOut
            ? "Command deadline elapsed before process start"
            : "Command was cancelled before process start",
        );
      }
      control.attach(prepared);
      if (control.cancelRequested) await control.cancel();
      const { exitCode } = await Promise.race([prepared.done, cancellationFailure]);
      outputTruncated ||= this.outputTruncatedCommands.has(message.commandId);
      const result: CommandResult = {
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
      this.journal.complete(message.commandId, result);
      this.sendCompletion(message.commandId, result);
    } catch (error) {
      control.failStart();
      const terminationUnconfirmed = terminalFailure !== undefined;
      outputTruncated ||= this.outputTruncatedCommands.has(message.commandId);
      const result: CommandResult = {
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
      this.journal.complete(message.commandId, result);
      this.sendCompletion(message.commandId, result);
    } finally {
      if (timer) clearTimeout(timer);
      if (this.commands.get(message.commandId) === control) {
        this.commands.delete(message.commandId);
      }
      control.markFinished();
      if (terminalFailure !== undefined) {
        this.beginTerminalFailure(
          "Command process-tree termination could not be proved",
          terminalFailure,
        );
      }
    }
  }

  private failCommand(commandId: string, error: string): void {
    const result: CommandResult = {
      status: "failed",
      exitCode: null,
      error,
      outputTruncated: false,
    };
    this.journal.complete(commandId, result);
    this.sendCompletion(commandId, result);
  }

  private async cancelCommand(commandId: string): Promise<void> {
    const command = this.commands.get(commandId);
    if (command) {
      await command.cancel();
      return;
    }
    const previous = this.journal.result(commandId);
    if (previous) {
      this.sendCompletion(commandId, previous);
      return;
    }
    const receipt = this.journal.receive(commandId);
    const result: CommandResult = {
      status: receipt === "new" ? "cancelled" : "execution_unknown",
      exitCode: null,
      error:
        receipt === "new"
          ? "Command was cancelled before execution started"
          : "Command execution state was unavailable when cancellation arrived",
      outputTruncated: false,
    };
    this.journal.complete(commandId, result);
    this.sendCompletion(commandId, result);
  }

  private sendCompletion(commandId: string, result: CommandResult): void {
    const outputTruncated =
      result.outputTruncated || this.outputTruncatedCommands.has(commandId);
    const error = result.error ?? (outputTruncated ? "Command output is incomplete" : undefined);
    this.deliver({
      type: "command.completed",
      commandId,
      status: result.status,
      exitCode: result.exitCode,
      ...(error ? { error } : {}),
      outputTruncated,
      at: new Date().toISOString(),
    });
  }

  private reconcileJournalResults(): void {
    for (const entry of this.journal.resultsForReconciliation()) {
      this.sendCompletion(entry.commandId, entry.result);
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
    throw new Error(`Invalid Client configuration: ${details}`);
  }
  const client = new Client(parsed.data);
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
