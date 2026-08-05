import {
  capabilityForAction,
  type OperationAction,
} from "@odyshell/protocol";
import {
  clampSessionOperationTimeout,
  developmentSessionDecision,
  sessionOperationDecision,
  type AgentSessionPrincipal,
} from "./agent-sessions.js";
import type { Database } from "./database.js";
import type { ClientGateway } from "./gateway.js";
import { deliverOperation } from "./operation-delivery.js";

type DeliveryDependencies = Parameters<typeof deliverOperation>[0];
type OperationAdmissionDatabase = DeliveryDependencies["database"] &
  Pick<
    Database,
    "audit" | "getAgentSessionTargetRuntime" | "sessionForOperation"
  >;
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

export type DevelopmentOperationAdmissionInput = {
  workspaceId: string;
  principalId: string;
  sessionId: string;
  action: OperationAction;
  timeoutSeconds: number;
  maxOutputBytes: number;
  idempotencyKey: string;
  now?: number;
};

export function createOperationAdmission(dependencies: {
  database: OperationAdmissionDatabase;
  gateway: OperationAdmissionGateway;
}) {
  const { database, gateway } = dependencies;
  const dispatch = async (input: {
    workspaceId: string;
    principalId: string;
    canonicalSessionId: string;
    runtimeSessionId: string;
    machineId: string;
    action: OperationAction;
    timeoutSeconds: number;
    requestedTimeoutSeconds: number;
    maxOutputBytes: number;
    idempotencyKey: string;
    source?: "remote_mcp";
  }) => {
    const delivery = await deliverOperation(
      { database, gateway },
      {
        workspaceId: input.workspaceId,
        machineId: input.machineId,
        sessionId: input.runtimeSessionId,
        idempotencyScopeId: input.canonicalSessionId,
        principalId: input.principalId,
        action: input.action,
        timeoutSeconds: input.timeoutSeconds,
        requestedTimeoutSeconds: input.requestedTimeoutSeconds,
        maxOutputBytes: input.maxOutputBytes,
        idempotencyKey: input.idempotencyKey,
      },
    );
    if (delivery.kind !== "delivered") {
      return { ...delivery, timeoutSeconds: input.timeoutSeconds };
    }

    await database.audit(
      input.workspaceId,
      input.principalId,
      "operation.created",
      "operation",
      delivery.id,
      {
        sessionId: input.canonicalSessionId,
        kind: input.action.kind,
        machineId: input.machineId,
        operation: { kind: input.action.kind },
        ...(input.source ? { source: input.source } : {}),
      },
    );
    gateway.notifyWorkspace(input.workspaceId);
    return { ...delivery, timeoutSeconds: input.timeoutSeconds };
  };

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
      return dispatch({
        workspaceId: input.principal.workspaceId,
        principalId: input.principal.agentId,
        canonicalSessionId: input.sessionId,
        runtimeSessionId: target.runtimeSessionId,
        machineId: input.machineId,
        action: input.action,
        timeoutSeconds,
        requestedTimeoutSeconds: input.timeoutSeconds,
        maxOutputBytes: input.maxOutputBytes,
        idempotencyKey: input.idempotencyKey,
        ...(input.source ? { source: input.source } : {}),
      });
    },
    async admitDevelopment(input: DevelopmentOperationAdmissionInput) {
      const capability = capabilityForAction(input.action);
      const decision = developmentSessionDecision([capability]);
      if (!decision.allowed) {
        await database.audit(
          input.workspaceId,
          input.principalId,
          "operation.denied",
          "session",
          input.sessionId,
          { reason: decision.code, kind: input.action.kind },
        );
        return {
          kind: "denied" as const,
          code: decision.code,
          requiredCapability: decision.capability,
        };
      }
      const session = await database.sessionForOperation(
        input.workspaceId,
        input.sessionId,
        input.principalId,
      );
      if (!session) return { kind: "session_not_found" as const };
      if (session.status !== "ready") {
        return { kind: "session_not_ready" as const, status: session.status };
      }
      if (session.expiresAt <= (input.now ?? Date.now())) {
        await database.audit(
          input.workspaceId,
          input.principalId,
          "operation.denied",
          "session",
          input.sessionId,
          { reason: "session_expired", kind: input.action.kind },
        );
        return {
          kind: "denied" as const,
          code: "session_expired" as const,
          requiredCapability: capability,
        };
      }
      if (!session.capabilities.includes(capability)) {
        await database.audit(
          input.workspaceId,
          input.principalId,
          "operation.denied",
          "session",
          input.sessionId,
          {
            reason: "session_capability",
            capability,
            kind: input.action.kind,
            machineId: session.machineId,
          },
        );
        return {
          kind: "denied" as const,
          code: "capability_denied" as const,
          requiredCapability: capability,
        };
      }
      return dispatch({
        workspaceId: input.workspaceId,
        principalId: input.principalId,
        canonicalSessionId: input.sessionId,
        runtimeSessionId: input.sessionId,
        machineId: session.machineId,
        action: input.action,
        timeoutSeconds: input.timeoutSeconds,
        requestedTimeoutSeconds: input.timeoutSeconds,
        maxOutputBytes: input.maxOutputBytes,
        idempotencyKey: input.idempotencyKey,
      });
    },
  };
}
