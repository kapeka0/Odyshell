import type { OperationAction } from "@odyshell/protocol";

/**
 * Returns the temporary Operation payload that may be persisted by the Server.
 * Host Shell environment values and stdin are transport-only secrets: they are
 * delivered to the Client once and never written to the database or Timeline.
 */
export function persistedOperationAction(
  action: OperationAction,
): OperationAction {
  if (action.kind !== "host.shell") return action;
  return {
    kind: action.kind,
    command: action.command,
    cwd: action.cwd,
    env: {},
  };
}

/**
 * Records only whether a Host Shell request carried transport-only input. The
 * values themselves must never be persisted or hashed. Presence is part of
 * the idempotency contract so a retry cannot add or remove env/stdin while
 * retaining the same payload fingerprint.
 */
export function hasTransientOperationInput(action: OperationAction): boolean {
  return (
    action.kind === "host.shell" &&
    (Object.keys(action.env).length > 0 || action.stdinBase64 !== undefined)
  );
}
