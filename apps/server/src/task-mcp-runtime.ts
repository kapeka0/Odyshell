import type { AgenticMcpRuntime } from "@odyshell/mcp";
import type { AgentPrincipal, TaskService } from "./tasks.js";
import type { PostgresTaskDatabase } from "./task-database.js";

export function createTaskMcpRuntime(
  principal: AgentPrincipal,
  service: TaskService,
  database: PostgresTaskDatabase,
): AgenticMcpRuntime {
  return {
    async machines() {
      const machines = await database.listMachineAuthorities(
        principal.organizationId,
        principal.agentId,
      );
      return { data: machines.map((machine) => ({
        id: machine.machineId,
        clientProfileId: machine.clientProfileId,
        operatingSystemUser: machine.operatingSystemUser,
        online: machine.online,
      })) };
    },
    async requestTask({ idempotencyKey, ...input }) {
      return unwrap(await service.requestTask(principal, input, idempotencyKey));
    },
    async task(taskId) {
      const task = await database.task(principal.organizationId, taskId);
      if (!task || task.agentId !== principal.agentId) throw new Error("task_not_found");
      return task;
    },
    async finishTask(taskId, outcome) {
      return unwrap(await service.finishTask(principal, taskId, outcome));
    },
    async createCommand(taskId, { idempotencyKey, ...input }) {
      return unwrap(await service.createCommand(principal, taskId, input, idempotencyKey));
    },
    async command(commandId) {
      const command = await database.command(principal.organizationId, commandId);
      if (!command || command.agentId !== principal.agentId) throw new Error("command_not_found");
      return command;
    },
    async output(commandId, after) {
      const command = await database.command(principal.organizationId, commandId);
      if (!command || command.agentId !== principal.agentId) throw new Error("command_not_found");
      const data = await database.commandOutput(principal.organizationId, commandId, after);
      return { data, nextCursor: data.at(-1)?.sequence ?? after, retention: "transient" };
    },
    async cancelCommand(commandId) {
      return unwrap(await service.cancelCommand(principal, commandId));
    },
  };
}

function unwrap<T extends { status: string }>(result: T): T {
  if (result.status === "denied") {
    const code = "code" in result ? String(result.code) : "request_denied";
    throw new Error(code);
  }
  return result;
}
