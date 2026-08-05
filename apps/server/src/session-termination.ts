import type { Database } from "./database.js";
import type { ClientGateway } from "./gateway.js";

type SessionTerminationDatabase = Pick<
  Database,
  "cancelAgentSession" | "completeAgentSession"
>;
type SessionTerminationGateway = Pick<ClientGateway, "send" | "notifyWorkspace">;

type CancellationInput = Parameters<Database["cancelAgentSession"]>[0];
type CompletionInput = Parameters<Database["completeAgentSession"]>[0];

export type SessionTerminationPropagation = {
  closeReason: string;
  notifyWorkspace?: boolean;
};

export function createSessionTermination(dependencies: {
  database: SessionTerminationDatabase;
  gateway: SessionTerminationGateway;
}) {
  const { database, gateway } = dependencies;
  return {
    async cancel(
      input: CancellationInput,
      propagation: SessionTerminationPropagation,
    ) {
      const termination = await database.cancelAgentSession(input);
      if (!termination) return null;

      for (const operation of termination.operations) {
        gateway.send(operation.machineId, {
          type: "operation.cancel",
          operationId: operation.id,
        });
      }
      for (const target of termination.targets) {
        gateway.send(target.machineId, {
          type: "session.close",
          sessionId: target.runtimeSessionId,
          reason: propagation.closeReason,
        });
      }
      if (propagation.notifyWorkspace) {
        gateway.notifyWorkspace(input.workspaceId);
      }
      return termination;
    },
    async complete(
      input: CompletionInput,
      propagation: SessionTerminationPropagation,
    ) {
      const termination = await database.completeAgentSession(input);
      if (!termination || termination.status === "busy") return termination;

      for (const target of termination.targets) {
        gateway.send(target.machineId, {
          type: "session.close",
          sessionId: target.runtimeSessionId,
          reason: propagation.closeReason,
        });
      }
      if (propagation.notifyWorkspace) {
        gateway.notifyWorkspace(input.workspaceId);
      }
      return termination;
    },
  };
}
