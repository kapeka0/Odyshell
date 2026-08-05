import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientToServerMessage } from "@odyshell/protocol";
import { describe, expect, it } from "vitest";
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
      expect(lifecycle.receiveStart("operation-a")).toBe("new");
      lifecycle.markRunning("operation-a");
      expect(lifecycle.deliver({
        type: "operation.event",
        operationId: "operation-a",
        sequence: 0,
        stream: "stdout",
        dataBase64: Buffer.from("hello").toString("base64"),
      })).toBe(true);
      lifecycle.complete("operation-a", {
        status: "succeeded",
        exitCode: 0,
        outputTruncated: false,
      });

      expect(lifecycle.result("operation-a")).toEqual({
        status: "succeeded",
        exitCode: 0,
        outputTruncated: false,
      });
      connected = true;
      lifecycle.flush();
      expect(outbound).toEqual([
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
      expect(lifecycle.cancelUntracked("operation-a")).toMatchObject({
        status: "cancelled",
        error: "Operation was cancelled before execution started",
      });
      expect(lifecycle.receiveStart("operation-a")).toBe("replayed");
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
      lifecycle.receiveStart("operation-a");
      lifecycle.markRunning("operation-a");
      lifecycle.deliver({
        type: "operation.event",
        operationId: "operation-a",
        sequence: 0,
        stream: "stdout",
        dataBase64: Buffer.from("uncertain").toString("base64"),
      });
      lifecycle.complete("operation-a", {
        status: "succeeded",
        exitCode: 0,
        outputTruncated: false,
      });

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
});
