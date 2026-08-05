import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientToServerMessage } from "@odyshell/protocol";
import { describe, expect, it, vi } from "vitest";
import { ClientOperationLifecycle } from "../apps/client/src/operation-lifecycle.js";

describe("Client Operation lifecycle", () => {
  it("turns a Server start into durable state and ordered outbound messages", async () => {
    const directory = await mkdtemp(join(tmpdir(), "odyshell-operation-lifecycle-"));
    const outbound: ClientToServerMessage[] = [];
    let connected = false;
    const lifecycle = new ClientOperationLifecycle(
      join(directory, "operations.sqlite"),
      (message) => {
        if (!connected) return false;
        outbound.push(message);
        return true;
      },
    );

    try {
      await lifecycle.start({
        type: "operation.start",
        operationId: "operation-a",
        sessionId: "session-a",
        action: { kind: "fs.read", path: "repo/package.json" },
        timeoutSeconds: 30,
        maxOutputBytes: 1024,
      }, executionAuthority((output) => {
        output.stdout(Buffer.from("hello"));
      }));

      expect(lifecycle.result("operation-a")).toEqual({
        status: "succeeded",
        exitCode: 0,
        outputTruncated: false,
      });
      connected = true;
      lifecycle.flush();
      expect(outbound).toEqual([
        expect.objectContaining({
          type: "operation.started",
          operationId: "operation-a",
        }),
        expect.objectContaining({
          type: "operation.event",
          operationId: "operation-a",
          sequence: 0,
        }),
        expect.objectContaining({
          type: "operation.completed",
          operationId: "operation-a",
          status: "succeeded",
          outputTruncated: false,
        }),
      ]);

      lifecycle.acknowledge("operation-a");
      expect(lifecycle.result("operation-a")).toBeUndefined();
    } finally {
      lifecycle.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("terminalizes cancellation before execution and replays the durable result", async () => {
    const directory = await mkdtemp(join(tmpdir(), "odyshell-operation-cancel-"));
    const outbound: ClientToServerMessage[] = [];
    const lifecycle = new ClientOperationLifecycle(
      join(directory, "operations.sqlite"),
      (message) => {
        outbound.push(message);
        return true;
      },
    );

    try {
      await expect(lifecycle.cancel("operation-a")).resolves.toMatchObject({
        status: "cancelled",
        error: "Operation was cancelled before execution started",
      });
      await lifecycle.start({
        type: "operation.start",
        operationId: "operation-a",
        sessionId: "session-a",
        action: { kind: "fs.read", path: "repo/package.json" },
        timeoutSeconds: 30,
        maxOutputBytes: 1024,
      }, executionAuthority());
      expect(outbound).toEqual([
        expect.objectContaining({
          type: "operation.completed",
          operationId: "operation-a",
          status: "cancelled",
        }),
        expect.objectContaining({
          type: "operation.completed",
          operationId: "operation-a",
          status: "cancelled",
        }),
      ]);
      expect(lifecycle.result("operation-a")).toMatchObject({ status: "cancelled" });
    } finally {
      lifecycle.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("marks unconfirmed output incomplete in both durable and buffered results", async () => {
    const directory = await mkdtemp(join(tmpdir(), "odyshell-operation-output-"));
    const outbound: ClientToServerMessage[] = [];
    let connected = false;
    const lifecycle = new ClientOperationLifecycle(
      join(directory, "operations.sqlite"),
      (message) => {
        if (!connected) return false;
        outbound.push(message);
        return true;
      },
    );

    try {
      await lifecycle.start({
        type: "operation.start",
        operationId: "operation-a",
        sessionId: "session-a",
        action: { kind: "fs.read", path: "repo/package.json" },
        timeoutSeconds: 30,
        maxOutputBytes: 1024,
      }, executionAuthority((output) => {
        output.stdout(Buffer.from("uncertain"));
      }));

      lifecycle.markUnconfirmedOutputTruncated();

      expect(lifecycle.result("operation-a")).toEqual({
        status: "succeeded",
        exitCode: 0,
        error: "Operation output is incomplete",
        outputTruncated: true,
      });
      connected = true;
      lifecycle.flush();
      expect(outbound).toEqual([
        expect.objectContaining({ type: "operation.started" }),
        expect.objectContaining({ type: "operation.event" }),
        expect.objectContaining({
          type: "operation.completed",
          operationId: "operation-a",
          error: "Operation output is incomplete",
          outputTruncated: true,
        }),
      ]);
    } finally {
      lifecycle.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("records an unknown outcome and reports terminal failure when cancellation cannot be proved", async () => {
    const directory = await mkdtemp(join(tmpdir(), "odyshell-operation-failure-"));
    const failures: Array<{ context: string; error: unknown }> = [];
    const lifecycle = new ClientOperationLifecycle(
      join(directory, "operations.sqlite"),
      () => true,
      {
        onTerminalFailure: (context, error) => failures.push({ context, error }),
      },
    );
    let executionStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      executionStarted = resolve;
    });
    const authority = executionAuthority();
    authority.execute = async () => {
      executionStarted();
      return {
        cancel: async () => {
          throw new Error("process tree still running");
        },
        done: new Promise(() => {}),
      };
    };

    try {
      const running = lifecycle.start({
        type: "operation.start",
        operationId: "operation-a",
        sessionId: "session-a",
        action: { kind: "fs.read", path: "repo/package.json" },
        timeoutSeconds: 30,
        maxOutputBytes: 1024,
      }, authority);
      await started;
      await expect(lifecycle.cancel("operation-a")).rejects.toThrow(
        "process tree still running",
      );
      await running;

      expect(lifecycle.result("operation-a")).toMatchObject({
        status: "execution_unknown",
        error: expect.stringContaining("Unable to confirm process-tree termination"),
      });
      expect(failures).toEqual([
        expect.objectContaining({
          context: "Operation process-tree termination could not be proved",
        }),
      ]);
    } finally {
      lifecycle.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("denies execution when local Session authority is inactive", async () => {
    const directory = await mkdtemp(join(tmpdir(), "odyshell-operation-inactive-"));
    const lifecycle = new ClientOperationLifecycle(
      join(directory, "operations.sqlite"),
      () => true,
    );
    const authority = executionAuthority();
    authority.isActive = () => false;
    const execute = vi.spyOn(authority, "execute");

    try {
      await lifecycle.start(operationStart("operation-inactive"), authority);

      expect(execute).not.toHaveBeenCalled();
      expect(lifecycle.result("operation-inactive")).toMatchObject({
        status: "failed",
        error: "Session is not active on this client",
      });
    } finally {
      lifecycle.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("enforces the profile concurrency limit before invoking another executor", async () => {
    const directory = await mkdtemp(join(tmpdir(), "odyshell-operation-concurrency-"));
    const lifecycle = new ClientOperationLifecycle(
      join(directory, "operations.sqlite"),
      () => true,
    );
    const authority = executionAuthority();
    authority.profile.maxConcurrentOperations = 1;
    let executionStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      executionStarted = resolve;
    });
    let finish!: (result: { exitCode: number }) => void;
    const done = new Promise<{ exitCode: number }>((resolve) => {
      finish = resolve;
    });
    const execute = vi.fn(async () => {
      executionStarted();
      return {
        cancel: async () => finish({ exitCode: 143 }),
        done,
      };
    });
    authority.execute = execute;

    try {
      const first = lifecycle.start(operationStart("operation-first"), authority);
      await started;
      await lifecycle.start(operationStart("operation-second"), authority);

      expect(execute).toHaveBeenCalledTimes(1);
      expect(lifecycle.result("operation-second")).toMatchObject({
        status: "failed",
        error: "Local concurrent Operation limit reached",
      });
      await lifecycle.cancel("operation-first");
      await first;
    } finally {
      lifecycle.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("truncates output at the lower requested and profile limit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "odyshell-operation-limit-"));
    const outbound: ClientToServerMessage[] = [];
    const lifecycle = new ClientOperationLifecycle(
      join(directory, "operations.sqlite"),
      (message) => {
        outbound.push(message);
        return true;
      },
    );
    const authority = executionAuthority((output) => {
      output.stdout(Buffer.from("too much output"));
    });
    authority.profile.maxOutputBytes = 6;

    try {
      await lifecycle.start({
        ...operationStart("operation-limited"),
        maxOutputBytes: 4,
      }, authority);

      const event = outbound.find(
        (message) => message.type === "operation.event",
      );
      expect(event?.type === "operation.event"
        ? Buffer.from(event.dataBase64, "base64").toString()
        : undefined).toBe("too ");
      expect(lifecycle.result("operation-limited")).toMatchObject({
        status: "succeeded",
        error: "Output limit reached",
        outputTruncated: true,
      });
    } finally {
      lifecycle.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("cancels attached execution when its local deadline elapses", async () => {
    const directory = await mkdtemp(join(tmpdir(), "odyshell-operation-deadline-"));
    const lifecycle = new ClientOperationLifecycle(
      join(directory, "operations.sqlite"),
      () => true,
    );
    const authority = executionAuthority();
    let finish!: (result: { exitCode: number }) => void;
    const done = new Promise<{ exitCode: number }>((resolve) => {
      finish = resolve;
    });
    const cancel = vi.fn(async () => finish({ exitCode: 143 }));
    authority.execute = async () => ({ cancel, done });

    try {
      await lifecycle.start({
        ...operationStart("operation-deadline"),
        timeoutSeconds: 0.001,
      }, authority);

      expect(cancel).toHaveBeenCalledOnce();
      expect(lifecycle.result("operation-deadline")).toMatchObject({
        status: "timed_out",
      });
    } finally {
      lifecycle.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("records execution_unknown when cancellation wins during executor preparation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "odyshell-operation-late-"));
    let reportFailure!: () => void;
    const failureReported = new Promise<void>((resolve) => {
      reportFailure = resolve;
    });
    const lifecycle = new ClientOperationLifecycle(
      join(directory, "operations.sqlite"),
      () => true,
      { onTerminalFailure: () => reportFailure() },
    );
    const authority = executionAuthority();
    let preparationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      preparationStarted = resolve;
    });
    let finishPreparation!: (running: {
      cancel(): Promise<void>;
      done: Promise<{ exitCode: number }>;
    }) => void;
    const preparation = new Promise<{
      cancel(): Promise<void>;
      done: Promise<{ exitCode: number }>;
    }>((resolve) => {
      finishPreparation = resolve;
    });
    authority.execute = async () => {
      preparationStarted();
      return preparation;
    };

    try {
      const running = lifecycle.start(operationStart("operation-late"), authority);
      await started;
      await lifecycle.cancel("operation-late");
      await running;

      expect(lifecycle.result("operation-late")).toMatchObject({
        status: "execution_unknown",
      });
      finishPreparation({
        cancel: async () => {
          throw new Error("late process tree still running");
        },
        done: new Promise(() => {}),
      });
      await failureReported;
      expect(lifecycle.result("operation-late")).toMatchObject({
        status: "execution_unknown",
      });
    } finally {
      lifecycle.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function operationStart(operationId: string) {
  return {
    type: "operation.start" as const,
    operationId,
    sessionId: "session-a",
    action: { kind: "fs.read" as const, path: "repo/package.json" },
    timeoutSeconds: 30,
    maxOutputBytes: 1024,
  };
}

function executionAuthority(
  emit?: (output: {
    stdout(data: Buffer): void;
    stderr(data: Buffer): void;
    result(data: Buffer): void;
  }) => void,
) {
  return {
    profile: {
      runner: "host" as const,
      maxSessionTtlSeconds: 3_600,
      maxConcurrentSessions: 2,
      maxConcurrentOperations: 4,
      maxOperationTimeoutSeconds: 60,
      maxOutputBytes: 1024,
      capabilities: ["fs.read" as const],
    },
    expiresAt: new Date(Date.now() + 60_000),
    isActive: () => true,
    execute: async (
      _operationId: string,
      _action: unknown,
      output: {
        stdout(data: Buffer): void;
        stderr(data: Buffer): void;
        result(data: Buffer): void;
      },
    ) => {
      emit?.(output);
      return {
        cancel: async () => {},
        done: Promise.resolve({ exitCode: 0 }),
      };
    },
  };
}
