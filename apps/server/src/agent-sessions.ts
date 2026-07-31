import {
  normalizeRelativePath,
  type OperationAction,
} from "@odyshell/protocol";

export type AgentSessionPrincipal = {
  workspaceId: string;
  agentId: string;
  sessionId: string;
  machineId: string;
  readPath: string;
  expiresAt: number;
};

export type SessionOperationDecision =
  | { allowed: true }
  | {
      allowed: false;
      code:
        | "session_scope_denied"
        | "session_expired"
        | "capability_denied"
        | "path_scope_denied"
        | "timeout_exceeds_session";
    };

export function sessionOperationDecision(
  principal: AgentSessionPrincipal,
  sessionId: string,
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
  if (action.kind !== "fs.read") {
    return { allowed: false, code: "capability_denied" };
  }
  if (
    normalizeRelativePath(action.path) !==
    normalizeRelativePath(principal.readPath)
  ) {
    return { allowed: false, code: "path_scope_denied" };
  }
  if (now + timeoutSeconds * 1_000 > principal.expiresAt) {
    return { allowed: false, code: "timeout_exceeds_session" };
  }
  return { allowed: true };
}
