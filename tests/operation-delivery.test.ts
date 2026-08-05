import type { OperationAction } from "@odyshell/protocol";
import { describe, expect, it, vi } from "vitest";
import { MachineLifecycleQueue } from "../apps/server/src/gateway.js";
import { deliverOperation } from "../apps/server/src/operation-delivery.js";
import { operationIdempotencyFingerprint } from "../apps/server/src/operation-idempotency.js";

type DeliveryDependencies = Parameters<typeof deliverOperation>[0];
type ReplayMethod = DeliveryDependencies["database"]["replayOperationByIdempotency"];
type ReplayResult = Awaited<ReturnType<ReplayMethod>>;
type ReplayDispatch = Parameters<ReplayMethod>[1];

const input = {
  workspaceId: "workspace-a",
  machineId: "machine-a",
  sessionId: "session-a",
  idempotencyScopeId: "canonical-session-a",
  principalId: "agent-a",
  action: {
    kind: "host.shell" as const,
    command: "printf ok",
    cwd: ".",
    env: { DEPLOY_TOKEN: "ephemeral-env-value" },
    stdinBase64: Buffer.from("ephemeral-stdin-value").toString("base64"),
  },
  timeoutSeconds: 30,
  requestedTimeoutSeconds: 30,
  maxOutputBytes: 1024,
  idempotencyKey: "operation-a",
};

const persistedHostAction: OperationAction = {
  kind: "host.shell",
  command: input.action.command,
  cwd: input.action.cwd,
  env: {},
};

function dispatchRecord(
  dispatch: ReplayDispatch,
  id = "existing-operation",
  action: OperationAction = persistedHostAction,
): boolean {
  return dispatch({
    id,
    sessionId: input.sessionId,
    action,
    timeoutSeconds: input.timeoutSeconds,
    maxOutputBytes: input.maxOutputBytes,
  });
}

function deliveryHarness(overrides?: {
  createOperation?: () => Promise<boolean>;
  replayOperationByIdempotency?: ReplayMethod;
  send?: () => boolean;
}) {
  const queue = new MachineLifecycleQueue();
  let online = true;
  let createdOperation = false;
  const createOperation = vi.fn(async () => {
    const result = overrides?.createOperation
      ? await overrides.createOperation()
      : true;
    createdOperation = result;
    return result;
  });
  const defaultReplay: ReplayMethod = async (replayInput, dispatch) => {
    if (!createdOperation) return { kind: "missing" };
    const sent = dispatchRecord(
      dispatch,
      replayInput.freshOperationId,
      persistedHostAction,
    );
    return sent
      ? {
          kind: "dispatched",
          id: replayInput.freshOperationId ?? "existing-operation",
          status: "delivered",
        }
      : {
          kind: "send_failed",
          id: replayInput.freshOperationId ?? "existing-operation",
          status: "queued",
        };
  };
  const database = {
    replayOperationByIdempotency: vi.fn(
      overrides?.replayOperationByIdempotency ?? defaultReplay,
    ),
    createOperation,
    markOperationCompleted: vi.fn(async () => null),
  } as unknown as DeliveryDependencies["database"];
  const gateway = {
    runMachineLifecycle: queue.run.bind(queue),
    isOnline: vi.fn(() => online),
    send: vi.fn(overrides?.send ?? (() => true)),
    events: { emit: vi.fn() },
  } as unknown as DeliveryDependencies["gateway"];
  return {
    database,
    gateway,
    queue,
    setOnline(value: boolean) {
      online = value;
    },
  };
}

describe("Operation delivery lifecycle", () => {
  it("passively replays a terminal matching Operation", async () => {
    const harness = deliveryHarness({
      replayOperationByIdempotency: async () => ({
        kind: "replay",
        id: "existing-operation",
        status: "succeeded",
      }),
    });

    await expect(
      deliverOperation(
        { database: harness.database, gateway: harness.gateway },
        input,
      ),
    ).resolves.toEqual({
      kind: "replay",
      id: "existing-operation",
      status: "succeeded",
    });
    expect(harness.database.createOperation).not.toHaveBeenCalled();
    expect(harness.gateway.send).not.toHaveBeenCalled();
  });

  it("does not dispatch after a persisted cancellation wins the row lock", async () => {
    const harness = deliveryHarness({
      replayOperationByIdempotency: async () => ({
        kind: "replay",
        id: "existing-operation",
        status: "execution_unknown",
      }),
    });

    await expect(
      deliverOperation(
        { database: harness.database, gateway: harness.gateway },
        input,
      ),
    ).resolves.toMatchObject({
      kind: "replay",
      status: "execution_unknown",
    });
    expect(harness.gateway.send).not.toHaveBeenCalled();
  });

  it.each(["queued", "delivered"] as const)(
    "redelivers a safe matching %s Operation from persisted fields",
    async (status) => {
      const safeInput = {
        ...input,
        action: { ...input.action, env: {}, stdinBase64: undefined },
      };
      const harness = deliveryHarness({
        replayOperationByIdempotency: async (_replayInput, dispatch) => {
          const sent = dispatchRecord(dispatch);
          return sent
            ? { kind: "dispatched", id: "existing-operation", status: "delivered" }
            : { kind: "send_failed", id: "existing-operation", status };
        },
      });

      await expect(
        deliverOperation(
          { database: harness.database, gateway: harness.gateway },
          safeInput,
        ),
      ).resolves.toEqual({
        kind: "replay",
        id: "existing-operation",
        status: "delivered",
      });
      expect(harness.gateway.send).toHaveBeenCalledWith(input.machineId, {
        type: "operation.start",
        operationId: "existing-operation",
        sessionId: input.sessionId,
        action: persistedHostAction,
        timeoutSeconds: input.timeoutSeconds,
        maxOutputBytes: input.maxOutputBytes,
      });
      expect(harness.database.createOperation).not.toHaveBeenCalled();
    },
  );

  it("never substitutes retry env/stdin into an existing Operation", async () => {
    const harness = deliveryHarness({
      replayOperationByIdempotency: async () => ({
        kind: "replay",
        id: "existing-operation",
        status: "queued",
      }),
    });
    await expect(
      deliverOperation(
        { database: harness.database, gateway: harness.gateway },
        {
          ...input,
          action: {
            ...input.action,
            env: { DEPLOY_TOKEN: "changed-secret" },
            stdinBase64: Buffer.from("changed-stdin").toString("base64"),
          },
        },
      ),
    ).resolves.toEqual({
      kind: "replay",
      id: "existing-operation",
      status: "queued",
    });
    expect(harness.gateway.send).not.toHaveBeenCalled();
  });

  it("leaves an existing queued replay recoverable when redelivery loses transport", async () => {
    const harness = deliveryHarness({
      replayOperationByIdempotency: async () => ({
        kind: "send_failed",
        id: "existing-operation",
        status: "queued",
      }),
    });
    await expect(
      deliverOperation(
        { database: harness.database, gateway: harness.gateway },
        input,
      ),
    ).resolves.toEqual({ kind: "machine_offline" });
    expect(harness.database.markOperationCompleted).not.toHaveBeenCalled();
  });

  it("fails closed when the durable key reservation outlives its payload", async () => {
    const harness = deliveryHarness({
      replayOperationByIdempotency: async () => ({
        kind: "idempotency_conflict",
      }),
    });
    await expect(
      deliverOperation(
        { database: harness.database, gateway: harness.gateway },
        input,
      ),
    ).resolves.toEqual({ kind: "idempotency_conflict" });
    expect(harness.database.createOperation).not.toHaveBeenCalled();
    expect(harness.gateway.send).not.toHaveBeenCalled();
  });

  it("fails closed when a concurrent creator reserved the key for another payload", async () => {
    const replay = vi
      .fn<ReplayMethod>()
      .mockResolvedValueOnce({ kind: "missing" })
      .mockResolvedValueOnce({ kind: "idempotency_conflict" });
    const harness = deliveryHarness({
      createOperation: async () => false,
      replayOperationByIdempotency: replay,
    });
    await expect(
      deliverOperation(
        { database: harness.database, gateway: harness.gateway },
        input,
      ),
    ).resolves.toEqual({ kind: "idempotency_conflict" });
    expect(harness.gateway.send).not.toHaveBeenCalled();
  });

  it("fingerprints transient presence but never transient values", () => {
    const fingerprint = operationIdempotencyFingerprint(input);
    expect(
      operationIdempotencyFingerprint({
        ...input,
        action: {
          ...input.action,
          env: { DEPLOY_TOKEN: "different-low-entropy-secret" },
          stdinBase64: Buffer.from("different-low-entropy-input").toString("base64"),
        },
      }),
    ).toBe(fingerprint);
    expect(
      operationIdempotencyFingerprint({
        ...input,
        action: { ...input.action, env: {}, stdinBase64: undefined },
      }),
    ).not.toBe(fingerprint);
  });

  it("persists only a digest, sanitized action and transient-presence bit", async () => {
    const harness = deliveryHarness();
    await deliverOperation(
      { database: harness.database, gateway: harness.gateway },
      input,
    );

    const created = vi.mocked(harness.database.createOperation).mock.calls[0]?.[0];
    expect(created?.idempotencyFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(created?.hasTransientInput).toBe(true);
    expect(JSON.stringify(created)).not.toMatch(
      /ephemeral-env-value|ephemeral-stdin-value/u,
    );
  });

  it("sends transient input only for the freshly reserved Operation", async () => {
    let freshOperationId: string | undefined;
    const replay = vi.fn<ReplayMethod>(async (replayInput, dispatch) => {
      if (replay.mock.calls.length === 1) return { kind: "missing" };
      freshOperationId = replayInput.freshOperationId;
      const sent = dispatchRecord(
        dispatch,
        replayInput.freshOperationId,
        persistedHostAction,
      );
      return sent
        ? {
            kind: "dispatched",
            id: replayInput.freshOperationId ?? "missing",
            status: "delivered",
          }
        : {
            kind: "send_failed",
            id: replayInput.freshOperationId ?? "missing",
            status: "queued",
          };
    });
    const harness = deliveryHarness({ replayOperationByIdempotency: replay });
    await expect(
      deliverOperation(
        { database: harness.database, gateway: harness.gateway },
        input,
      ),
    ).resolves.toMatchObject({ kind: "delivered" });
    expect(freshOperationId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(harness.gateway.send).toHaveBeenCalledWith(
      input.machineId,
      expect.objectContaining({ action: input.action }),
    );
  });

  it("replays when only the Session-clamped execution timeout decreased", async () => {
    const fingerprint = operationIdempotencyFingerprint(input);
    let replayFingerprint = "";
    const harness = deliveryHarness({
      replayOperationByIdempotency: async (replayInput) => {
        replayFingerprint = replayInput.idempotencyFingerprint;
        return { kind: "replay", id: "existing-operation", status: "running" };
      },
    });
    await expect(
      deliverOperation(
        { database: harness.database, gateway: harness.gateway },
        { ...input, timeoutSeconds: input.timeoutSeconds - 5 },
      ),
    ).resolves.toMatchObject({ kind: "replay", id: "existing-operation" });
    expect(replayFingerprint).toBe(fingerprint);
    expect(harness.gateway.send).not.toHaveBeenCalled();
  });

  it("does not create or send when revocation wins the machine lifecycle", async () => {
    const harness = deliveryHarness();
    let releaseRevocation!: () => void;
    let revocationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      revocationStarted = resolve;
    });
    const revocation = harness.queue.run(input.machineId, async () => {
      revocationStarted();
      await new Promise<void>((resolve) => {
        releaseRevocation = resolve;
      });
      harness.setOnline(false);
    });
    await started;
    const delivery = deliverOperation(
      { database: harness.database, gateway: harness.gateway },
      input,
    );
    releaseRevocation();

    await expect(delivery).resolves.toEqual({ kind: "machine_offline" });
    await revocation;
    expect(harness.database.createOperation).not.toHaveBeenCalled();
    expect(harness.gateway.send).not.toHaveBeenCalled();
  });

  it("finishes dispatch before a later lifecycle revocation", async () => {
    let releaseCreation!: () => void;
    let creationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      creationStarted = resolve;
    });
    const harness = deliveryHarness({
      createOperation: async () => {
        creationStarted();
        await new Promise<void>((resolve) => {
          releaseCreation = resolve;
        });
        return true;
      },
    });
    const order: string[] = [];
    harness.gateway.send = vi.fn(() => {
      order.push("operation.start");
      return true;
    });
    const delivery = deliverOperation(
      { database: harness.database, gateway: harness.gateway },
      input,
    );
    await started;
    const revocation = harness.queue.run(input.machineId, async () => {
      order.push("machine.revoked");
      harness.setOnline(false);
    });
    releaseCreation();

    await expect(delivery).resolves.toMatchObject({ kind: "delivered" });
    await revocation;
    expect(order).toEqual(["operation.start", "machine.revoked"]);
  });

  it("terminalizes a freshly inserted Operation when transport send fails", async () => {
    const harness = deliveryHarness({ send: () => false });
    await expect(
      deliverOperation(
        { database: harness.database, gateway: harness.gateway },
        input,
      ),
    ).resolves.toEqual({ kind: "machine_offline" });
    expect(harness.database.markOperationCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        machineId: input.machineId,
        status: "failed",
        error: "machine_disconnected",
      }),
    );
    expect(harness.gateway.events.emit).toHaveBeenCalledOnce();
  });
});
