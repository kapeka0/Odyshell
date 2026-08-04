import {
  sessionScopeSubsetDecision,
  type SessionMachineScope,
} from "@odyshell/protocol";

export type AutoapprovalPolicyCeiling = {
  status: string;
  scopes: SessionMachineScope[];
  maxSessionSeconds: number;
  expiresAt: number;
};

export type AutoapprovalDecision =
  | { approved: true }
  | {
      approved: false;
      reason:
        | "policy_inactive"
        | "policy_expired"
        | "duration_widening"
        | "scope_widening"
        | "unknown_restriction"
        | "unsafe_capability";
    };

const KNOWN_RESTRICTIONS = new Set(["filesystem", "process", "docker"]);

function hasUnknownRestriction(scope: SessionMachineScope): boolean {
  return Object.keys(scope.restrictions).some(
    (key) => !KNOWN_RESTRICTIONS.has(key),
  );
}

export function autoapprovalDecision(input: {
  requestedScopes: SessionMachineScope[];
  requestedDurationSeconds: number;
  policy: AutoapprovalPolicyCeiling;
  now: number;
}): AutoapprovalDecision {
  if (input.policy.status !== "active") {
    return { approved: false, reason: "policy_inactive" };
  }
  if (input.policy.expiresAt <= input.now) {
    return { approved: false, reason: "policy_expired" };
  }
  if (input.requestedDurationSeconds > input.policy.maxSessionSeconds) {
    return { approved: false, reason: "duration_widening" };
  }
  if (
    input.requestedScopes.some((scope) =>
      scope.capabilities.includes("host.shell"),
    )
  ) {
    return { approved: false, reason: "unsafe_capability" };
  }
  if (
    input.requestedScopes.some(hasUnknownRestriction) ||
    input.policy.scopes.some(hasUnknownRestriction)
  ) {
    return { approved: false, reason: "unknown_restriction" };
  }

  const policyMachines = new Map(
    input.policy.scopes.map((scope) => [scope.machineId, scope]),
  );
  if (policyMachines.size !== input.policy.scopes.length) {
    return { approved: false, reason: "scope_widening" };
  }
  for (const requested of input.requestedScopes) {
    const ceiling = policyMachines.get(requested.machineId);
    if (
      !ceiling ||
      requested.profile !== ceiling.profile ||
      !sessionScopeSubsetDecision(requested, ceiling).allowed
    ) {
      return { approved: false, reason: "scope_widening" };
    }
  }
  return { approved: true };
}

export type ManagedDelegationDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | "delegation_inactive"
        | "delegation_expired"
        | "managed_agent_limit"
        | "validity_widening"
        | "duration_widening"
        | "scope_widening"
        | "unsafe_capability";
    };

export function managedDelegationDecision(input: {
  childScopes: SessionMachineScope[];
  childMaxSessionSeconds: number;
  childExpiresAt: number;
  activeManagedAgents: number;
  delegation: AutoapprovalPolicyCeiling & { maxManagedAgents: number };
  now: number;
}): ManagedDelegationDecision {
  if (input.delegation.status !== "active") {
    return { allowed: false, reason: "delegation_inactive" };
  }
  if (input.delegation.expiresAt <= input.now) {
    return { allowed: false, reason: "delegation_expired" };
  }
  if (input.activeManagedAgents >= input.delegation.maxManagedAgents) {
    return { allowed: false, reason: "managed_agent_limit" };
  }
  if (input.childExpiresAt > input.delegation.expiresAt) {
    return { allowed: false, reason: "validity_widening" };
  }
  const scope = autoapprovalDecision({
    requestedScopes: input.childScopes,
    requestedDurationSeconds: input.childMaxSessionSeconds,
    policy: input.delegation,
    now: input.now,
  });
  if (scope.approved) return { allowed: true };
  if (scope.reason === "duration_widening") {
    return { allowed: false, reason: "duration_widening" };
  }
  if (scope.reason === "unsafe_capability") {
    return { allowed: false, reason: "unsafe_capability" };
  }
  return { allowed: false, reason: "scope_widening" };
}
