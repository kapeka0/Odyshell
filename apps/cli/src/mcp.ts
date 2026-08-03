import process from "node:process";
import { McpServer } from "@modelcontextprotocol/server";
import {
  serveStdio,
  type StdioServerHandle,
} from "@modelcontextprotocol/server/stdio";
import {
  createApprovedMcpServer,
  type ApprovedMcpSessionRequest,
  type ApprovedMcpRuntime,
} from "@odyshell/mcp";
import { operationSessionScopes } from "@odyshell/protocol";
import {
  ExpectedError,
  Odyshell,
  type ClaimedAgentSession,
} from "@odyshell/sdk";

export type McpAgentIdentity = {
  id: string;
  name: string;
};

export function createApprovedOdyshellMcpServer(
  ods: Odyshell,
  identity: McpAgentIdentity,
  reportUnexpectedError: (error: unknown) => void = () => undefined,
): McpServer {
  const claims = new Map<string, ClaimedAgentSession>();
  const requestSessions = new Map<string, string>();
  const recentRequests = new Map<
    string,
    ApprovedMcpSessionRequest & { purpose: string }
  >();
  const runtime: ApprovedMcpRuntime = {
    machines: () => ods.machines(),
    async ping(machine) {
      const resolved = await ods.resolveMachine(machine);
      return ods.ping(resolved.id);
    },
    async request(input) {
      const operations = await Promise.all(
        input.operations.map(async (operation) => ({
          machineId: (await ods.resolveMachine(operation.machine)).id,
          action: operation.action,
        })),
      );
      let scopes;
      try {
        scopes = operationSessionScopes(operations);
      } catch {
        const shellRequested = input.operations.some(
          (operation) => operation.action.kind === "process.shell",
        );
        throw new ExpectedError(
          shellRequested
            ? "Free-form shell cannot be safely scoped. Use process.exec."
            : "Operations cannot be combined without broadening their scope.",
          shellRequested
            ? "process_shell_unsupported"
            : "session_scope_conflict",
        );
      }
      const requested = await ods.agent(identity).requestSession({
        purpose: input.purpose,
        scopes,
        durationSeconds: input.durationSeconds,
        ...(input.runId ? { runId: input.runId } : {}),
      });
      const safeRequest = {
        id: requested.id,
        status: requested.status,
        purpose: input.purpose,
        ...(requested.approvalUrl
          ? { approvalUrl: requested.approvalUrl }
          : {}),
        expiresAt: requested.expiresAt,
      };
      recentRequests.set(requested.id, safeRequest);
      return safeRequest;
    },
    async requests() {
      return { data: [...recentRequests.values()].reverse().slice(0, 20) };
    },
    async status(requestId) {
      const existingSessionId = requestSessions.get(requestId);
      const existingClaim = existingSessionId
        ? claims.get(existingSessionId)
        : undefined;
      if (existingClaim) return safeClaim(existingClaim);

      const agent = ods.agent(identity);
      const status = await agent.status(requestId);
      const recent = recentRequests.get(requestId);
      if (recent) {
        recentRequests.set(requestId, { ...recent, status: status.status });
      }
      if (status.status === "approved") {
        const claim = await agent.claim(requestId);
        claims.set(claim.sessionId, claim);
        requestSessions.set(requestId, claim.sessionId);
        return safeClaim(claim);
      }
      if (status.status === "claimed") {
        throw new ExpectedError(
          "This request was already claimed by another MCP process.",
          "session_claim_unavailable",
        );
      }
      return status;
    },
    async execute(input) {
      const claim = claims.get(input.sessionId);
      if (!claim) {
        throw new ExpectedError(
          "No claimed credential is available for this session.",
          "session_claim_unavailable",
        );
      }
      return ods.claimedSession(claim).execute(input.machine, input.action, {
        timeoutSeconds: input.timeoutSeconds,
        idempotencyKey: input.operationId,
      });
    },
    complete(input) {
      return ods.agent(identity).complete(
        input.sessionId,
        input.outcome,
        input.summary,
      );
    },
    timeline(sessionId) {
      return ods.agent(identity).timeline(sessionId);
    },
  };
  return createApprovedMcpServer(runtime, reportUnexpectedError);
}

function safeClaim(claim: ClaimedAgentSession): Record<string, unknown> {
  return {
    status: "ready",
    sessionId: claim.sessionId,
    machines: claim.scopes.map((scope) => ({
      machineId: scope.machineId,
      capabilities: scope.capabilities,
    })),
    expiresAt: claim.expiresAt,
  };
}

export function serveApprovedOdyshellMcp(
  ods: Odyshell,
  identity: McpAgentIdentity,
): StdioServerHandle {
  return serveStdio(
    () =>
      createApprovedOdyshellMcpServer(ods, identity, (error) => {
        process.stderr.write(
          `[odyshell-mcp] Unexpected tool error: ${formatUnexpectedError(error)}\n`,
        );
      }),
    {
      onerror: (error) => {
        process.stderr.write(
          `[odyshell-mcp] Transport error: ${error.stack ?? error.message}\n`,
        );
      },
    },
  );
}

function formatUnexpectedError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.stack ?? error.message;
}
