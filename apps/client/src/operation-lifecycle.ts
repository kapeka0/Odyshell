import type { ClientToServerMessage } from "@odyshell/protocol";
import { OperationJournal, type JournalResult } from "./journal.js";

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

export type ClientOperationReceipt = "new" | "running" | "replayed";
type OutboundDelivery = (message: ClientToServerMessage) => boolean;

export class ClientOperationLifecycle {
  private readonly journal: OperationJournal;
  private readonly outputTruncatedOperations = new Set<string>();
  private readonly unconfirmedOutputOperations = new Set<string>();
  private readonly bufferedMessages: ClientMessageBuffer;

  constructor(
    journalPath: string,
    private readonly sendIfConnected: OutboundDelivery,
    limits: { maximumMessages?: number; maximumOutputBytes?: number } = {},
  ) {
    this.journal = new OperationJournal(journalPath);
    this.bufferedMessages = new ClientMessageBuffer(
      limits.maximumMessages,
      limits.maximumOutputBytes,
      (operationId) => this.markOutputTruncated(operationId),
    );
  }

  recoverInterrupted(): number {
    return this.journal.recoverInterrupted();
  }

  receiveStart(operationId: string): ClientOperationReceipt {
    const receipt = this.journal.receive(operationId);
    if (receipt !== "completed") return receipt;
    const previous = this.journal.result(operationId);
    if (previous) this.deliverCompletion(operationId, previous);
    return "replayed";
  }

  markRunning(operationId: string): void {
    this.journal.markRunning(operationId);
  }

  deliver(message: ClientToServerMessage): boolean {
    if (message.type === "operation.event") {
      this.markOutputUnconfirmed(message.operationId);
    }
    if (this.sendIfConnected(message)) return true;
    return this.bufferedMessages.enqueue(message).accepted;
  }

  complete(operationId: string, result: JournalResult): void {
    this.journal.complete(operationId, result);
    this.deliverCompletion(operationId, result);
  }

  cancelUntracked(operationId: string): JournalResult {
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

  markOutputTruncated(operationId: string): void {
    this.journal.markOutputTruncated(operationId);
    this.bufferedMessages.markOutputTruncated(operationId);
    this.unconfirmedOutputOperations.delete(operationId);
    this.outputTruncatedOperations.add(operationId);
  }

  isOutputTruncated(operationId: string): boolean {
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
}
