import {
  DEFAULT_COMMAND_OUTPUT_BYTES,
  type Command,
  type Session,
  type SessionServerToClientMessage,
} from "@odyshell/protocol";

export type SessionReconnectState = {
  sessions: Session[];
  commands: Command[];
};

export function sessionReconnectMessages(
  state: SessionReconnectState,
  now = new Date(),
): SessionServerToClientMessage[] {
  const messages: SessionServerToClientMessage[] = [];
  const sessionById = new Map(state.sessions.map((session) => [session.id, session]));

  for (const session of state.sessions) {
    if (session.status !== "opening" && session.status !== "active") continue;
    messages.push({
      type: "session.open",
      sessionId: session.id,
      organizationId: session.organizationId,
      agentId: session.agentId,
      clientProfileId: session.clientProfileId,
      expiresAt: session.expiresAt,
      maxConcurrentCommands: session.maxConcurrentCommands,
      serverTime: now.toISOString(),
    });
  }

  for (const command of state.commands) {
    const session = sessionById.get(command.sessionId);
    if (
      !session ||
      (session.status !== "opening" && session.status !== "active") ||
      command.status === "cancellation_requested"
    ) {
      continue;
    }
    messages.push({
      type: "command.start",
      commandId: command.id,
      sessionId: command.sessionId,
      command: command.command,
      ...(command.cwd ? { cwd: command.cwd } : {}),
      timeoutSeconds: command.timeoutSeconds,
      maxOutputBytes: DEFAULT_COMMAND_OUTPUT_BYTES,
    });
  }

  for (const command of state.commands) {
    if (command.status === "cancellation_requested") {
      messages.push({ type: "command.cancel", commandId: command.id });
    }
  }

  for (const session of state.sessions) {
    if (session.status !== "cancellation_requested") continue;
    messages.push({
      type: "session.close",
      sessionId: session.id,
      reason: Date.parse(session.expiresAt) <= now.getTime() ? "expired" : "cancelled",
    });
  }

  return messages;
}
