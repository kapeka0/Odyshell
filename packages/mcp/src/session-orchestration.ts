import {
  mergeSessionMachineScopes,
  operationSessionScopes,
  sessionScopeDecision,
  type ScopedOperationAction,
  type SessionMachineScope,
} from "@odyshell/protocol";

export type ResolvedMcpOperation = {
  machineId: string;
  action: ScopedOperationAction;
};

export type McpAuthorityReuseRequest =
  | { kind: "operations"; operations: ResolvedMcpOperation[] }
  | { kind: "host_shell"; machineId: string };

export type McpSessionRequestPlan = {
  allowed: true;
  operations: ResolvedMcpOperation[];
  scopes: SessionMachineScope[];
  kinds: string[];
  reuse: McpAuthorityReuseRequest | null;
};

export type McpSessionRequestDenial = {
  allowed: false;
  code:
    | "host_shell_request_required"
    | "session_scope_conflict"
    | "predecessor_session_unavailable"
    | "predecessor_machine_denied";
};

export function planMcpOperationRequest(
  operations: ResolvedMcpOperation[],
): McpSessionRequestPlan | McpSessionRequestDenial {
  if (
    operations.some(
      (operation) => (operation.action as { kind: string }).kind === "host.shell",
    )
  ) {
    return { allowed: false, code: "host_shell_request_required" };
  }
  try {
    return {
      allowed: true,
      operations,
      scopes: operationSessionScopes(operations),
      kinds: operations.map((operation) => operation.action.kind),
      reuse: { kind: "operations", operations },
    };
  } catch {
    return { allowed: false, code: "session_scope_conflict" };
  }
}

export function planMcpHostShellRequest(
  machineId: string,
  predecessorScopes?: SessionMachineScope[] | null,
): McpSessionRequestPlan | McpSessionRequestDenial {
  if (predecessorScopes === null) {
    return { allowed: false, code: "predecessor_session_unavailable" };
  }
  if (predecessorScopes === undefined) {
    return {
      allowed: true,
      operations: [],
      scopes: [{
        machineId,
        profile: "workspace",
        capabilities: ["host.shell"],
        restrictions: {},
      }],
      kinds: ["host.shell"],
      reuse: { kind: "host_shell", machineId },
    };
  }
  const predecessor = predecessorScopes.find(
    (scope) => scope.machineId === machineId,
  );
  if (!predecessor) {
    return { allowed: false, code: "predecessor_machine_denied" };
  }
  return {
    allowed: true,
    operations: [],
    scopes: mergeSessionMachineScopes([
      ...predecessorScopes,
      {
        machineId,
        profile: predecessor.profile,
        capabilities: ["host.shell"],
        restrictions: {},
      },
    ]),
    kinds: ["host.shell"],
    reuse: null,
  };
}

export type McpCanonicalSession = {
  sessionId: string;
  status: string;
  expiresAt: number | string;
  targets: Array<{ machineId: string; status: string }>;
};

export type McpBoundAuthority = {
  sessionId: string;
  expiresAt: number | string;
  scopes: SessionMachineScope[];
};

export async function findReusableMcpAuthority<A extends McpBoundAuthority>(
  input: {
    sessions: McpCanonicalSession[];
    request: McpAuthorityReuseRequest;
    authorityForSession(sessionId: string): Promise<A | null | undefined>;
    now?: number;
  },
): Promise<A | undefined> {
  const now = input.now ?? Date.now();
  const machineIds = input.request.kind === "host_shell"
    ? [input.request.machineId]
    : [...new Set(input.request.operations.map((operation) => operation.machineId))];
  for (const session of input.sessions) {
    if (
      session.status !== "active" ||
      !isFuture(session.expiresAt, now) ||
      machineIds.some(
        (machineId) => !session.targets.some(
          (target) => target.machineId === machineId && target.status === "ready",
        ),
      )
    ) {
      continue;
    }
    const authority = await input.authorityForSession(session.sessionId);
    if (!authority || !isFuture(authority.expiresAt, now)) continue;
    const request = input.request;
    const compatible = request.kind === "host_shell"
      ? authority.scopes.some(
          (scope) =>
            scope.machineId === request.machineId &&
            scope.capabilities.includes("host.shell"),
        )
      : request.operations.every(({ machineId, action }) =>
          authority.scopes.some(
            (scope) => sessionScopeDecision(scope, machineId, action).allowed,
          ),
        );
    if (compatible) return authority;
  }
  return undefined;
}

export type McpClaimDecision =
  | "return_bound"
  | "claim"
  | "unavailable"
  | "return_status";

export function mcpClaimDecision(input: {
  hasBoundAuthority: boolean;
  status: string;
}): McpClaimDecision {
  if (input.hasBoundAuthority) return "return_bound";
  if (input.status === "approved") return "claim";
  if (input.status === "claimed") return "unavailable";
  return "return_status";
}

function isFuture(value: number | string, now: number): boolean {
  const timestamp = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > now;
}
