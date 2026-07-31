import {
  sessionScopeDecision,
  type OperationAction,
  type SessionMachineScope,
} from "@odyshell/protocol";

export type AgentSessionPrincipal = {
  workspaceId: string;
  agentId: string;
  sessionId: string;
  scopes: SessionMachineScope[];
  expiresAt: number;
};

export type SessionOperationDecision =
  | { allowed: true; scope: SessionMachineScope }
  | {
      allowed: false;
      code:
        | "session_scope_denied"
        | "session_expired"
        | "machine_scope_denied"
        | "capability_denied"
        | "path_scope_denied"
        | "program_scope_denied"
        | "container_scope_denied"
        | "timeout_exceeds_session";
      machineId?: string;
    };

export function sessionOperationDecision(
  principal: AgentSessionPrincipal,
  sessionId: string,
  machineId: string,
  action: OperationAction,
  timeoutSeconds: number,
  now = Date.now(),
): SessionOperationDecision {
  if (sessionId !== principal.sessionId) {
    return { allowed: false, code: "session_scope_denied" };
  }
  if (principal.expiresAt <= now) {
    return { allowed: false, code: "session_expired" };
  }
  if (now + timeoutSeconds * 1_000 > principal.expiresAt) {
    return { allowed: false, code: "timeout_exceeds_session" };
  }
  const scope = principal.scopes.find((candidate) => candidate.machineId === machineId);
  if (!scope) {
    return { allowed: false, code: "machine_scope_denied", machineId };
  }
  const decision = sessionScopeDecision(scope, machineId, action);
  return decision.allowed
    ? { allowed: true, scope }
    : { ...decision, machineId };
}
