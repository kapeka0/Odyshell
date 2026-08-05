import type {
  ClientProfile,
  ClientToServerMessage,
  OperationAction,
  ServerToClientMessage,
} from "@odyshell/protocol";
import type { RunningOperation } from "./executor.js";
import { OperationJournal, type JournalResult } from "./journal.js";
import { PendingOperation } from "./operation-control.js";

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

type ClientOperationReceipt = "new" | "running" | "replayed";
type OutboundDelivery = (message: ClientToServerMessage) => boolean;
type OperationStartMessage = Extract<
  ServerToClientMessage,
  { type: "operation.start" }
>;

export type ClientOperationExecutionAuthority = {
  profile: ClientProfile;
  expiresAt: Date;
  isActive(): boolean;
  execute(
    operationId: string,
    action: OperationAction,
    output: {
      stdout(data: Buffer): void;
      stderr(data: Buffer): void;
      result(data: Buffer): void;
    },
    options: { signal: AbortSignal },
  ): Promise<RunningOperation>;
};

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

export class ClientOperationLifecycle {
  private readonly journal: OperationJournal;
  private readonly outputTruncatedOperations = new Set<string>();
  private readonly unconfirmedOutputOperations = new Set<string>();
  private readonly bufferedMessages: ClientMessageBuffer;
  private readonly operations = new Map<string, PendingOperation>();
  private readonly onTerminalFailure:
    | ((context: string, error: unknown) => void)
    | undefined;

  constructor(
    journalPath: string,
    private readonly sendIfConnected: OutboundDelivery,
    options: {
      maximumMessages?: number;
      maximumOutputBytes?: number;
      onTerminalFailure?: (context: string, error: unknown) => void;
    } = {},
  ) {
    this.journal = new OperationJournal(journalPath);
    this.bufferedMessages = new ClientMessageBuffer(
      options.maximumMessages,
      options.maximumOutputBytes,
      (operationId) => this.markOutputTruncated(operationId),
    );
    this.onTerminalFailure = options.onTerminalFailure;
  }

  recoverInterrupted(): number {
    return this.journal.recoverInterrupted();
  }

  async start(
    message: OperationStartMessage,
    authority: ClientOperationExecutionAuthority | null,
  ): Promise<void> {
    const receipt = this.receiveStart(message.operationId);
    if (receipt !== "new") return;
    if (!authority || !authority.isActive()) {
      this.complete(message.operationId, {
        status: "failed",
        exitCode: null,
        error: "Session is not active on this client",
        outputTruncated: false,
      });
      return;
    }
    const operationsForProfile = [...this.operations.values()].filter(
      (operation) => operation.profile === authority.profile,
    ).length;
    if (operationsForProfile >= authority.profile.maxConcurrentOperations) {
      this.complete(message.operationId, {
        status: "failed",
        exitCode: null,
        error: "Local concurrent Operation limit reached",
        outputTruncated: false,
      });
      return;
    }

    const control = new PendingOperation(message.sessionId, authority.profile);
    this.operations.set(message.operationId, control);
    let sequence = 0;
    let outputBytes = 0;
    let outputTruncated = false;
    let timedOut = false;
    let preparationOutcomeUnknown = false;
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
    const cancellationFailure = control.waitForCancellationFailure();
    void cancellationFailure.catch((error: unknown) => {
      terminalFailure = error;
    });
    const requestedMaximum = Number.isInteger(message.maxOutputBytes) &&
        message.maxOutputBytes > 0
      ? message.maxOutputBytes
      : 0;
    const maximum = Math.min(requestedMaximum, authority.profile.maxOutputBytes);
    const maximumEventBytes = 256 * 1024;
    const markOutputTruncated = (): void => {
      if (outputTruncated) return;
      if (!this.isOutputTruncated(message.operationId)) {
        this.markOutputTruncated(message.operationId);
      }
      outputTruncated = true;
    };
    const emit = (stream: "stdout" | "stderr" | "result", data: Buffer): void => {
      if (this.isOutputTruncated(message.operationId)) outputTruncated = true;
      if (outputTruncated) return;
      const remaining = maximum - outputBytes;
      if (remaining <= 0) {
        markOutputTruncated();
        return;
      }
      const accepted = data.subarray(0, remaining);
      for (let offset = 0; offset < accepted.length; offset += maximumEventBytes) {
        const chunk = accepted.subarray(offset, offset + maximumEventBytes);
        if (!this.deliver({
          type: "operation.event",
          operationId: message.operationId,
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
      if (!authority.isActive() || authority.expiresAt.getTime() <= Date.now()) {
        throw new Error("Session closed before the Operation could start");
      }
      this.markRunning(message.operationId);
      this.deliver({
        type: "operation.started",
        operationId: message.operationId,
        at: new Date().toISOString(),
      });
      const timeoutMilliseconds = operationTimeoutMilliseconds(
        message.timeoutSeconds,
        authority.profile.maxOperationTimeoutSeconds,
        authority.expiresAt,
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
      const executionPreparation = authority.execute(
        message.operationId,
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
            this.onTerminalFailure?.(
              "Late Operation preparation could not be terminated",
              error,
            );
          });
        },
        () => {},
      );
      const prepared = await Promise.race([executionPreparation, deadlineReached]);
      if (prepared === deadlineMarker) {
        preparationOutcomeUnknown = true;
        control.failStart();
        await control.cancel();
        throw new Error(
          timedOut
            ? "Operation deadline elapsed before process start"
            : "Operation was cancelled before process start",
        );
      }
      control.attach(prepared);
      if (control.cancelRequested) await control.cancel();
      const { exitCode } = await Promise.race([
        prepared.done,
        cancellationFailure,
      ]);
      outputTruncated ||= this.isOutputTruncated(message.operationId);
      this.complete(message.operationId, {
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
      });
    } catch (error) {
      control.failStart();
      const terminationUnconfirmed =
        terminalFailure !== undefined || preparationOutcomeUnknown;
      outputTruncated ||= this.isOutputTruncated(message.operationId);
      this.complete(message.operationId, {
        status: terminationUnconfirmed
          ? "execution_unknown"
          : timedOut
            ? "timed_out"
            : control.cancelRequested
              ? "cancelled"
              : "failed",
        exitCode: null,
        error: terminationUnconfirmed
          ? preparationOutcomeUnknown && terminalFailure === undefined
            ? "Unable to confirm whether executor preparation started a process before cancellation"
            : `Unable to confirm process-tree termination: ${error instanceof Error ? error.message : String(error)}`
          : error instanceof Error
            ? error.message
            : String(error),
        outputTruncated,
      });
    } finally {
      if (timer) clearTimeout(timer);
      if (this.operations.get(message.operationId) === control) {
        this.operations.delete(message.operationId);
      }
      control.markFinished();
      if (terminalFailure !== undefined) {
        this.onTerminalFailure?.(
          "Operation process-tree termination could not be proved",
          terminalFailure,
        );
      }
    }
  }

  async cancel(operationId: string): Promise<JournalResult | undefined> {
    const operation = this.operations.get(operationId);
    if (operation) {
      await operation.cancel();
      return undefined;
    }
    return this.cancelUntracked(operationId);
  }

  async terminateSession(sessionId: string): Promise<void> {
    await this.terminateOperations(
      [...this.operations.values()].filter(
        (operation) => operation.sessionId === sessionId,
      ),
    );
  }

  async terminateAll(): Promise<void> {
    await this.terminateOperations([...this.operations.values()]);
  }

  private receiveStart(operationId: string): ClientOperationReceipt {
    const receipt = this.journal.receive(operationId);
    if (receipt !== "completed") return receipt;
    const previous = this.journal.result(operationId);
    if (previous) this.deliverCompletion(operationId, previous);
    return "replayed";
  }

  private markRunning(operationId: string): void {
    this.journal.markRunning(operationId);
  }

  deliver(message: ClientToServerMessage): boolean {
    if (message.type === "operation.event") {
      this.markOutputUnconfirmed(message.operationId);
    }
    if (this.sendIfConnected(message)) return true;
    return this.bufferedMessages.enqueue(message).accepted;
  }

  private complete(operationId: string, result: JournalResult): void {
    this.journal.complete(operationId, result);
    this.deliverCompletion(operationId, result);
  }

  private cancelUntracked(operationId: string): JournalResult {
    const previous = this.journal.result(operationId);
    if (previous) {
      this.deliverCompletion(operationId, previous);
      return previous;
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
    this.deliverCompletion(operationId, result);
    return result;
  }

  private markOutputTruncated(operationId: string): void {
    this.journal.markOutputTruncated(operationId);
    this.bufferedMessages.markOutputTruncated(operationId);
    this.unconfirmedOutputOperations.delete(operationId);
    this.outputTruncatedOperations.add(operationId);
  }

  private isOutputTruncated(operationId: string): boolean {
    return this.outputTruncatedOperations.has(operationId);
  }

  markUnconfirmedOutputTruncated(): void {
    for (const operationId of [...this.unconfirmedOutputOperations]) {
      this.markOutputTruncated(operationId);
    }
  }

  flush(): void {
    while (true) {
      const message = this.bufferedMessages.peek();
      if (!message || !this.sendIfConnected(message)) return;
      this.bufferedMessages.shift();
    }
  }

  reconcile(): void {
    for (const entry of this.journal.resultsForReconciliation()) {
      this.deliverCompletion(entry.operationId, entry.result);
    }
  }

  acknowledge(operationId: string): void {
    this.journal.acknowledge(operationId);
    this.unconfirmedOutputOperations.delete(operationId);
    this.outputTruncatedOperations.delete(operationId);
  }

  result(operationId: string): JournalResult | undefined {
    return this.journal.result(operationId);
  }

  close(): void {
    this.journal.close();
  }

  private markOutputUnconfirmed(operationId: string): void {
    if (this.unconfirmedOutputOperations.has(operationId)) return;
    this.journal.markOutputUnconfirmed(operationId);
    this.unconfirmedOutputOperations.add(operationId);
  }

  private deliverCompletion(operationId: string, result: JournalResult): void {
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

  private async terminateOperations(operations: PendingOperation[]): Promise<void> {
    const cancellations = await Promise.allSettled(
      operations.map(async (operation) => operation.cancel()),
    );
    const failures = cancellations.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        "Unable to prove local Operation authority was terminated",
      );
    }
    await Promise.all(
      operations.map(async (operation) => operation.waitUntilFinished()),
    );
  }
}
