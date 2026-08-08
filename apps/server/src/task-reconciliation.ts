import {
  DEFAULT_COMMAND_OUTPUT_BYTES,
  type Command,
  type Task,
  type TaskServerToClientMessage,
} from "@odyshell/protocol";

export type TaskReconnectState = {
  tasks: Task[];
  commands: Command[];
};

export function taskReconnectMessages(
  state: TaskReconnectState,
  now = new Date(),
): TaskServerToClientMessage[] {
  const messages: TaskServerToClientMessage[] = [];
  const taskById = new Map(state.tasks.map((task) => [task.id, task]));

  for (const task of state.tasks) {
    if (task.status !== "opening" && task.status !== "active") continue;
    messages.push({
      type: "task.open",
      taskId: task.id,
      organizationId: task.organizationId,
      agentId: task.agentId,
      clientProfileId: task.clientProfileId,
      expiresAt: task.expiresAt,
      maxConcurrentCommands: task.maxConcurrentCommands,
      serverTime: now.toISOString(),
    });
  }

  for (const command of state.commands) {
    const task = taskById.get(command.taskId);
    if (
      !task ||
      (task.status !== "opening" && task.status !== "active") ||
      command.status === "cancellation_requested"
    ) {
      continue;
    }
    messages.push({
      type: "command.start",
      commandId: command.id,
      taskId: command.taskId,
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

  for (const task of state.tasks) {
    if (task.status !== "cancellation_requested") continue;
    messages.push({
      type: "task.close",
      taskId: task.id,
      reason: Date.parse(task.expiresAt) <= now.getTime() ? "expired" : "cancelled",
    });
  }

  return messages;
}
