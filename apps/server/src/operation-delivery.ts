import { randomUUID } from "node:crypto";
import type { OperationAction } from "@odyshell/protocol";
import type { Database } from "./database.js";
import type { ClientGateway } from "./gateway.js";
import {
  hasTransientOperationInput,
  persistedOperationAction,
} from "./operation-data.js";
import { operationIdempotencyFingerprint } from "./operation-idempotency.js";

type OperationDeliveryDatabase = Pick<
  Database,
  | "createOperation"
  | "replayOperationByIdempotency"
  | "markOperationCompleted"
>;

type OperationDeliveryGateway = Pick<
  ClientGateway,
  "isOnline" | "runMachineLifecycle" | "send"
> & {
  events: Pick<ClientGateway["events"], "emit">;
};

export type OperationDeliveryResult =
  | { kind: "delivered"; id: string; status: "delivered" }
  | { kind: "replay"; id: string; status: string }
  | { kind: "idempotency_conflict" }
  | { kind: "machine_offline" }
  | { kind: "session_not_active" };

export async function deliverOperation(
  dependencies: {
    database: OperationDeliveryDatabase;
    gateway: OperationDeliveryGateway;
  },
  input: {
    workspaceId: string;
    machineId: string;
    sessionId: string;
    idempotencyScopeId: string;
    principalId: string;
    action: OperationAction;
    timeoutSeconds: number;
    requestedTimeoutSeconds: number;
    maxOutputBytes: number;
    idempotencyKey: string;
  },
): Promise<OperationDeliveryResult> {
  const { database, gateway } = dependencies;
  const idempotencyFingerprint = operationIdempotencyFingerprint({
    machineId: input.machineId,
    action: input.action,
    timeoutSeconds: input.requestedTimeoutSeconds,
    maxOutputBytes: input.maxOutputBytes,
  });
  return await gateway.runMachineLifecycle(input.machineId, async () => {
    const replayInput = {
      workspaceId: input.workspaceId,
      idempotencyScopeId: input.idempotencyScopeId,
      principalId: input.principalId,
      idempotencyKey: input.idempotencyKey,
      idempotencyFingerprint,
    };
    const replayOrDispatch = async (freshOperationId?: string) =>
      await database.replayOperationByIdempotency(
        {
          ...replayInput,
          ...(freshOperationId === undefined ? {} : { freshOperationId }),
        },
        (operation) => {
          if (!gateway.isOnline(input.machineId)) return false;
          try {
            return gateway.send(input.machineId, {
              type: "operation.start",
              operationId: operation.id,
              sessionId: operation.sessionId,
              action:
                operation.id === freshOperationId
                  ? input.action
                  : operation.action,
              timeoutSeconds: operation.timeoutSeconds,
              maxOutputBytes: operation.maxOutputBytes,
            });
          } catch {
            return false;
          }
        },
      );
    const replayResult = (
      replay: Awaited<ReturnType<typeof replayOrDispatch>>,
    ): OperationDeliveryResult | null => {
      switch (replay.kind) {
        case "missing":
          return null;
        case "idempotency_conflict":
          return { kind: "idempotency_conflict" };
        case "send_failed":
          return { kind: "machine_offline" };
        case "dispatched":
        case "replay":
          return { kind: "replay", id: replay.id, status: replay.status };
      }
    };

    const replay = replayResult(await replayOrDispatch());
    if (replay) return replay;
    if (!gateway.isOnline(input.machineId)) {
      return { kind: "machine_offline" };
    }

    const operationId = randomUUID();
    const created = await database.createOperation({
      workspaceId: input.workspaceId,
      id: operationId,
      sessionId: input.sessionId,
      idempotencyScopeId: input.idempotencyScopeId,
      machineId: input.machineId,
      principalId: input.principalId,
      action: persistedOperationAction(input.action),
      timeoutSeconds: input.timeoutSeconds,
      maxOutputBytes: input.maxOutputBytes,
      idempotencyKey: input.idempotencyKey,
      idempotencyFingerprint,
      hasTransientInput: hasTransientOperationInput(input.action),
    });
    if (!created) {
      return (
        replayResult(await replayOrDispatch()) ?? {
          kind: "session_not_active",
        }
      );
    }

    const dispatched = await replayOrDispatch(operationId);
    if (dispatched.kind === "send_failed") {
      await database.markOperationCompleted({
        machineId: input.machineId,
        operationId,
        status: "failed",
        exitCode: null,
        error: "machine_disconnected",
        outputTruncated: false,
      });
      gateway.events.emit(`operation:${operationId}`);
      return { kind: "machine_offline" };
    }
    if (dispatched.kind === "dispatched") {
      return { kind: "delivered", id: operationId, status: "delivered" };
    }
    return (
      replayResult(dispatched) ?? {
        kind: "session_not_active",
      }
    );
  });
}
