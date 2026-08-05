import process from "node:process";
import { McpServer } from "@modelcontextprotocol/server";
import {
  serveStdio,
  type StdioServerHandle,
} from "@modelcontextprotocol/server/stdio";
import {
  createApprovedMcpServer,
  findReusableMcpAuthority,
  mcpClaimDecision,
  planMcpHostShellRequest,
  planMcpOperationRequest,
  type ApprovedMcpSessionRequest,
  type ApprovedMcpRuntime,
} from "@odyshell/mcp";
import {
  type ScopedOperationAction,
  type SessionMachineScope,
} from "@odyshell/protocol";
import {
  ExpectedError,
  Odyshell,
  type ClaimedAgentSession,
  type ListedAgentSession,
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
    ApprovedMcpSessionRequest & { title: string; purpose?: string }
  >();
  const runtime: ApprovedMcpRuntime = {
    machines: () => ods.machines(),
    async ping(machine) {
      const resolved = await ods.resolveMachine(machine);
      return ods.ping(resolved.id);
    },
    async request(input) {
      const agent = ods.agent(identity);
      let plan: ReturnType<typeof planMcpOperationRequest>;
      if (input.hostShell) {
        const machine = await ods.resolveMachine(input.hostShell.machine);
        let predecessorScopes: SessionMachineScope[] | null | undefined;
        if (input.predecessorSessionId) {
          const predecessor = (await agent.sessions()).find(
            (session) =>
              session.id === input.predecessorSessionId &&
              session.status === "active" &&
              Date.parse(session.expiresAt) > Date.now(),
          );
          predecessorScopes = predecessor?.scopes ?? null;
        }
        plan = planMcpHostShellRequest(machine.id, predecessorScopes);
      } else {
        const operations: Array<{
          machineId: string;
          action: ScopedOperationAction;
        }> = await Promise.all(
          input.operations.map(async (operation) => ({
            machineId: (await ods.resolveMachine(operation.machine)).id,
            action: operation.action,
          })),
        );
        plan = planMcpOperationRequest(operations);
      }
      if (!plan.allowed) {
        const message = plan.code === "host_shell_request_required"
          ? "Request Host Shell authority without anticipating a command."
          : plan.code === "session_scope_conflict"
            ? "Operations cannot be combined without broadening their scope."
            : "Host Shell can only be added to an active predecessor machine.";
        throw new ExpectedError(message, plan.code);
      }
      if (plan.reuse && claims.size > 0) {
        const sessions = await agent.sessions();
        const reusableClaim = await findReusableMcpAuthority({
          sessions: sessions.map((session) => ({
            sessionId: session.id,
            status: session.status,
            expiresAt: session.expiresAt,
            targets: session.targets,
          })),
          request: plan.reuse,
          authorityForSession: async (sessionId) => claims.get(sessionId),
        });
        if (reusableClaim) {
          return {
            id: reusableClaim.sessionId,
            sessionId: reusableClaim.sessionId,
            status: "ready",
            reused: true,
            expiresAt: reusableClaim.expiresAt,
          };
        }
      }
      const requested = await agent.requestSession({
        title: input.title,
        ...(input.purpose ? { purpose: input.purpose } : {}),
        scopes: plan.scopes,
        durationSeconds: input.durationSeconds,
        ...(input.predecessorSessionId
          ? { predecessorSessionId: input.predecessorSessionId }
          : {}),
        ...(input.runId ? { runId: input.runId } : {}),
      });
      const safeRequest = {
        id: requested.id,
        status: requested.status,
        title: input.title,
        ...(input.purpose ? { purpose: input.purpose } : {}),
        ...(requested.approvalUrl
          ? { approvalUrl: requested.approvalUrl }
          : {}),
        expiresAt: requested.expiresAt,
      };
      recentRequests.set(requested.id, safeRequest);
      return safeRequest;
    },
    async sessions({ includeHistory = false } = {}) {
      const agent = ods.agent(identity);
      const [serverRequests, serverSessions] = await Promise.all([
        agent.requests(),
        agent.sessions(),
      ]);
      const canonicalRequestIds = new Set(serverRequests.map((request) => request.id));
      const requests = [
        ...serverRequests.map((request) => ({
          id: request.id,
          status: request.status,
          title: request.title,
          ...(request.purpose ? { purpose: request.purpose } : {}),
          expiresAt: request.expiresAt,
        })),
        ...[...recentRequests.values()]
          .reverse()
          .filter((request) => !canonicalRequestIds.has(request.id)),
      ].filter(
        (request) => includeHistory || ["pending", "approved"].includes(request.status),
      );
      const claimedIds = new Set(claims.keys());
      return {
        data: [
          ...[...claims.values()].map((claim) => ({
            kind: "session",
            ...safeClaim(
              claim,
              serverSessions.find((session) => session.id === claim.sessionId),
            ),
          })),
          ...serverSessions
            .filter((session) =>
              !claimedIds.has(session.id) &&
              (includeHistory || session.status === "active"),
            )
            .map((session) => ({
              kind: "session",
              sessionId: session.id,
              title: session.title,
              status: session.status,
              ...(session.purpose ? { purpose: session.purpose } : {}),
              expiresAt: session.expiresAt,
              machines: session.targets.map((target) => ({
                id: target.machineId,
                name: target.machineName,
                status: target.status,
              })),
            })),
          ...requests.map((request) => ({ kind: "request", ...request })),
        ].slice(0, 20),
      };
    },
    async status(requestId) {
      const existingSessionId = requestSessions.get(requestId);
      const existingClaim = existingSessionId
        ? claims.get(existingSessionId)
        : undefined;
      const existingDecision = mcpClaimDecision({
        hasBoundAuthority: existingClaim !== undefined,
        status: "approved",
      });
      if (existingDecision === "return_bound" && existingClaim) {
        const canonical = (await ods.agent(identity).sessions()).find(
          (session) => session.id === existingClaim.sessionId,
        );
        return safeClaim(existingClaim, canonical);
      }

      const agent = ods.agent(identity);
      const status = await agent.status(requestId);
      const recent = recentRequests.get(requestId);
      if (recent) {
        recentRequests.set(requestId, { ...recent, status: status.status });
      }
      const decision = mcpClaimDecision({
        hasBoundAuthority: false,
        status: status.status,
      });
      if (decision === "claim") {
        const claim = await agent.claim(requestId);
        claims.set(claim.sessionId, claim);
        requestSessions.set(requestId, claim.sessionId);
        const canonical = (await agent.sessions()).find(
          (session) => session.id === claim.sessionId,
        );
        return safeClaim(claim, canonical);
      }
      if (decision === "unavailable") {
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
      const machine = await ods.resolveMachine(input.machine);
      return ods.claimedSession(claim).execute(machine.id, input.action, {
        timeoutSeconds: input.timeoutSeconds,
        idempotencyKey: input.idempotencyKey,
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

function safeClaim(
  claim: ClaimedAgentSession,
  canonical?: ListedAgentSession,
): Record<string, unknown> {
  const status = canonical
    ? canonical.status !== "active"
      ? canonical.status
      : canonical.targets.some((target) => target.status === "ready")
        ? "ready"
        : canonical.targets.some((target) => target.status === "opening")
          ? "opening"
          : "failed"
    : "opening";
  return {
    status,
    sessionId: claim.sessionId,
    machines: claim.scopes.map((scope) => ({
      machineId: scope.machineId,
      capabilities: scope.capabilities,
    })),
    expiresAt: canonical?.expiresAt ?? claim.expiresAt,
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
