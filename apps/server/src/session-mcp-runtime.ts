import type { AgenticMcpRuntime } from "@odyshell/mcp";
import type { AgentPrincipal, SessionService } from "./sessions.js";
import type { PostgresSessionDatabase } from "./session-database.js";

export function createSessionMcpRuntime(
  principal: AgentPrincipal,
  service: SessionService,
  database: PostgresSessionDatabase,
): AgenticMcpRuntime {
  return {
    async machines() {
      const machines = await database.listMachineAuthorities(
        principal.organizationId,
      );
      return { data: machines.map((machine) => ({
        id: machine.machineId,
        clientProfileId: machine.clientProfileId,
        operatingSystemUser: machine.operatingSystemUser,
        online: machine.online,
      })) };
    },
    async requestSession({ idempotencyKey, ...input }) {
      return unwrap(await service.requestSession(principal, input, idempotencyKey));
    },
    async session(sessionId) {
      const session = await database.session(principal.organizationId, sessionId);
      if (!session || session.agentId !== principal.agentId) throw new Error("session_not_found");
      return session;
    },
    async finishSession(sessionId, outcome) {
      return unwrap(await service.finishSession(principal, sessionId, outcome));
    },
    async createCommand(sessionId, { idempotencyKey, ...input }) {
      return unwrap(await service.createCommand(principal, sessionId, input, idempotencyKey));
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
