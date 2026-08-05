import {
  capabilityForAction,
  type OperationAction,
} from "@odyshell/protocol";
import {
  clampSessionOperationTimeout,
  sessionOperationDecision,
  type AgentSessionPrincipal,
} from "./agent-sessions.js";
import type { Database } from "./database.js";
import type { ClientGateway } from "./gateway.js";
import { deliverOperation } from "./operation-delivery.js";

type DeliveryDependencies = Parameters<typeof deliverOperation>[0];
type OperationAdmissionDatabase = DeliveryDependencies["database"] &
  Pick<Database, "audit" | "getAgentSessionTargetRuntime">;
type OperationAdmissionGateway = DeliveryDependencies["gateway"] &
  Pick<ClientGateway, "notifyWorkspace">;

export type OperationAdmissionInput = {
  principal: AgentSessionPrincipal;
  sessionId: string;
  machineId: string;
  action: OperationAction;
  timeoutSeconds: number;
  maxOutputBytes: number;
  idempotencyKey: string;
  source?: "remote_mcp";
  now?: number;
};

export function createOperationAdmission(dependencies: {
  database: OperationAdmissionDatabase;
  gateway: OperationAdmissionGateway;
}) {
  const { database, gateway } = dependencies;
  return {
    async admit(input: OperationAdmissionInput) {
      const decisionTime = input.now ?? Date.now();
      const timeoutSeconds = clampSessionOperationTimeout(
        input.timeoutSeconds,
        input.principal.expiresAt,
        decisionTime,
      );
      if (timeoutSeconds === null) {
        await database.audit(
          input.principal.workspaceId,
          input.principal.agentId,
          "operation.denied",
          "session",
          input.sessionId,
          { reason: "session_expired", kind: input.action.kind },
        );
        return {
          kind: "denied" as const,
          code: "session_expired" as const,
          machineId: input.machineId,
          requiredCapability: capabilityForAction(input.action),
        };
      }
      const decision = sessionOperationDecision(
        input.principal,
        input.sessionId,
        input.machineId,
        input.action,
        timeoutSeconds,
        decisionTime,
      );
      if (!decision.allowed) {
        await database.audit(
          input.principal.workspaceId,
          input.principal.agentId,
          "operation.denied",
          "session",
          input.sessionId,
          { reason: decision.code, kind: input.action.kind },
        );
        return {
          kind: "denied" as const,
          code: decision.code,
          machineId: input.machineId,
          requiredCapability: capabilityForAction(input.action),
        };
      }
      const target = await database.getAgentSessionTargetRuntime(
        input.principal.workspaceId,
        input.sessionId,
        input.principal.agentId,
        input.machineId,
      );
      if (!target) return { kind: "session_target_not_found" as const };
      if (!target.canonicalReady || target.status !== "ready") {
        return {
          kind: "session_not_ready" as const,
          status: target.status,
        };
      }
      const delivery = await deliverOperation(
        { database, gateway },
        {
          workspaceId: input.principal.workspaceId,
          machineId: input.machineId,
          sessionId: target.runtimeSessionId,
          idempotencyScopeId: input.sessionId,
          principalId: input.principal.agentId,
          action: input.action,
          timeoutSeconds,
          requestedTimeoutSeconds: input.timeoutSeconds,
          maxOutputBytes: input.maxOutputBytes,
          idempotencyKey: input.idempotencyKey,
        },
      );
      if (delivery.kind !== "delivered") {
        return { ...delivery, timeoutSeconds };
      }

      await database.audit(
        input.principal.workspaceId,
        input.principal.agentId,
        "operation.created",
        "operation",
        delivery.id,
        {
          sessionId: input.sessionId,
          kind: input.action.kind,
          machineId: input.machineId,
          operation: { kind: input.action.kind },
          ...(input.source ? { source: input.source } : {}),
        },
      );
      gateway.notifyWorkspace(input.principal.workspaceId);
      return { ...delivery, timeoutSeconds };
    },
  };
}
