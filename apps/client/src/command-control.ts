import type { RunningCommand } from "./shell-executor.js";

export class PendingCommand {
  readonly taskId: string;
  cancelRequested = false;

  private running: RunningCommand | undefined;
  private readySettled = false;
  private readonly ready: Promise<RunningCommand | undefined>;
  private resolveReady!: (running: RunningCommand | undefined) => void;
  private cancellation: Promise<void> | undefined;
  private readonly preparationAbort = new AbortController();
  private readonly cancellationFailure: Promise<never>;
  private rejectCancellationFailure!: (error: unknown) => void;
  private cancellationFailureReported = false;
  private readonly finished: Promise<void>;
  private resolveFinished!: () => void;

  constructor(taskId: string) {
    this.taskId = taskId;
    this.ready = new Promise((resolveReady) => {
      this.resolveReady = resolveReady;
    });
    this.cancellationFailure = new Promise((_, reject) => {
      this.rejectCancellationFailure = reject;
    });
    void this.cancellationFailure.catch(() => {});
    this.finished = new Promise((resolveFinished) => {
      this.resolveFinished = resolveFinished;
    });
  }

  attach(running: RunningCommand): void {
    if (this.readySettled) throw new Error("Command execution was already registered");
    this.running = running;
    this.readySettled = true;
    this.resolveReady(running);
  }

  failStart(): void {
    if (this.readySettled) return;
    this.readySettled = true;
    this.resolveReady(undefined);
  }

  async cancel(): Promise<void> {
    this.cancelRequested = true;
    this.preparationAbort.abort();
    this.cancellation ??= this.ready.then(async (running) => {
      await running?.cancel();
    });
    try {
      await this.cancellation;
    } catch (error) {
      if (!this.cancellationFailureReported) {
        this.cancellationFailureReported = true;
        this.rejectCancellationFailure(error);
      }
      throw error;
    }
  }

  markFinished(): void {
    this.failStart();
    this.resolveFinished();
  }

  async waitUntilFinished(): Promise<void> {
    await this.finished;
  }

  waitForCancellationFailure(): Promise<never> {
    return this.cancellationFailure;
  }

  executionSignal(): AbortSignal {
    return this.preparationAbort.signal;
  }
}
