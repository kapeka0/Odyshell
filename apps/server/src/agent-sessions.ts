import {
  sessionScopeDecision,
  type Capability,
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

export type DevelopmentSessionDecision =
  | { allowed: true }
  | {
      allowed: false;
      code: "manual_approval_required";
      capability: "host.shell" | "process.exec";
    };

/** Keeps broad native execution out of the approval-free development path. */
export function developmentSessionDecision(
  capabilities: readonly Capability[],
): DevelopmentSessionDecision {
  const unsafeCapability = capabilities.includes("host.shell")
    ? "host.shell"
    : capabilities.includes("process.exec")
      ? "process.exec"
      : undefined;
  return unsafeCapability
    ? {
        allowed: false,
        code: "manual_approval_required",
        capability: unsafeCapability,
      }
    : { allowed: true };
}

/** Bounds a requested timeout to the remaining canonical Session lifetime. */
export function clampSessionOperationTimeout(
  requestedSeconds: number,
  expiresAt: number,
  now = Date.now(),
): number | null {
  const remainingSeconds = Math.floor((expiresAt - now) / 1_000);
  if (remainingSeconds < 1) return null;
  return Math.min(requestedSeconds, remainingSeconds);
}

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
