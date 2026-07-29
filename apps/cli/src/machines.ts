import { ExpectedError } from "./errors.js";

export type ResolvableMachine = {
  id: string;
  name: string;
  online: boolean;
  revokedAt?: string | null;
};

export function resolveMachineReference<T extends ResolvableMachine>(
  machines: T[],
  reference: string,
  options: { requireOnline?: boolean } = {},
): T {
  const activeMachines = machines.filter((machine) => machine.revokedAt == null);
  const exact = activeMachines.find((machine) => machine.id === reference);
  const named = activeMachines.filter(
    (machine) => machine.name.toLocaleLowerCase() === reference.toLocaleLowerCase(),
  );
  const onlineNamed = named.filter((machine) => machine.online);
  const machine =
    exact ??
    (options.requireOnline
      ? onlineNamed.length === 1
        ? onlineNamed[0]
        : named.length === 1
          ? named[0]
          : undefined
      : named.length === 1
        ? named[0]
        : undefined);

  if (!machine) {
    if (named.length > 1) {
      throw new ExpectedError(
        `Machine name "${reference}" is ambiguous; use its ID`,
        "machine_ambiguous",
      );
    }
    const revoked = machines.find(
      (candidate) =>
        candidate.revokedAt != null &&
        (candidate.id === reference ||
          candidate.name.toLocaleLowerCase() === reference.toLocaleLowerCase()),
    );
    if (revoked) {
      throw new ExpectedError(`Machine "${reference}" has been revoked`, "machine_revoked");
    }
    throw new ExpectedError(`Machine "${reference}" was not found`, "machine_not_found");
  }
  if (options.requireOnline && !machine.online) {
    throw new ExpectedError(
      `Machine "${machine.name}" is enrolled, but its Odyshell Client is not connected to the Server.`,
      "machine_offline",
    );
  }
  return machine;
}
