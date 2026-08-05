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
import {
  hostShellTaskRunAccessDecision,
  mergeSessionMachineScopes,
  operationSessionScopes,
  sessionScopeDecision,
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
  const requestTaskRuns = new Map<
    string,
    { runId?: string; scopes: SessionMachineScope[] }
  >();
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
      let scopes: SessionMachineScope[];
      let operations: Array<{
        machineId: string;
        action: ScopedOperationAction;
      }> = [];
      let hostShellMachineId: string | undefined;
      if (input.hostShell) {
        const machine = await ods.resolveMachine(input.hostShell.machine);
        hostShellMachineId = machine.id;
        if (input.predecessorSessionId) {
          const predecessor = (await ods.agent(identity).sessions()).find(
            (session) =>
              session.id === input.predecessorSessionId &&
              session.status === "active" &&
              Date.parse(session.expiresAt) > Date.now(),
          );
          const inherited = predecessor?.scopes.find(
            (scope) => scope.machineId === machine.id,
          );
          if (!predecessor || !inherited) {
            throw new ExpectedError(
              "Host Shell can only be added to an active predecessor machine.",
              "predecessor_session_unavailable",
            );
          }
          scopes = mergeSessionMachineScopes([
            ...predecessor.scopes,
            {
              machineId: machine.id,
              profile: inherited.profile,
              capabilities: ["host.shell"],
              restrictions: {},
            },
          ]);
        } else {
          scopes = [
            {
              machineId: machine.id,
              profile: "workspace",
              capabilities: ["host.shell"],
              restrictions: {},
            },
          ];
        }
      } else {
        if (
          input.operations.some(
            (operation) =>
              (operation.action as { kind: string }).kind === "host.shell",
          )
        ) {
          throw new ExpectedError(
            "Request Host Shell authority without anticipating a command.",
            "host_shell_request_required",
          );
        }
        operations = await Promise.all(
          input.operations.map(async (operation) => ({
            machineId: (await ods.resolveMachine(operation.machine)).id,
            action: operation.action,
          })),
        );
        try {
          scopes = operationSessionScopes(operations);
        } catch {
          throw new ExpectedError(
            "Operations cannot be combined without broadening their scope.",
            "session_scope_conflict",
          );
        }
      }
      const agent = ods.agent(identity);
      if (!input.predecessorSessionId && claims.size > 0) {
        const sessions = await agent.sessions();
        const reusableClaim = input.hostShell
          ? findReusableLocalHostShellClaim(
              claims.values(),
              sessions,
              hostShellMachineId!,
              input.runId,
            )
          : findReusableLocalOperationClaim(
              claims.values(),
              sessions,
              operations,
            );
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
        scopes,
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
      requestTaskRuns.set(requested.id, {
        ...(input.runId ? { runId: input.runId } : {}),
        scopes,
      });
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
    async status(requestId, runId) {
      const agent = ods.agent(identity);
      const existingSessionId = requestSessions.get(requestId);
      const existingClaim = existingSessionId
        ? claims.get(existingSessionId)
        : undefined;
      if (existingClaim) {
        const canonical = (await ods.agent(identity).sessions()).find(
          (session) => session.id === existingClaim.sessionId,
        );
        requireLocalTaskRun(canonical, runId);
        return safeClaim(existingClaim, canonical);
      }

      const requestedAccess = requestTaskRuns.get(requestId) ??
        (await agent.requests()).find((request) => request.id === requestId);
      if (requestedAccess) {
        requireTaskRun(
          requestedAccess.scopes,
          requestedAccess.runId,
          runId,
        );
      }
      const status = await agent.status(requestId);
      const recent = recentRequests.get(requestId);
      if (recent) {
        recentRequests.set(requestId, { ...recent, status: status.status });
      }
      if (status.status === "approved") {
        const claim = await agent.claim(requestId, runId);
        claims.set(claim.sessionId, claim);
        requestSessions.set(requestId, claim.sessionId);
        const canonical = (await agent.sessions()).find(
          (session) => session.id === claim.sessionId,
        );
        requireLocalTaskRun(canonical, runId);
        return safeClaim(claim, canonical);
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
      const canonical = (await ods.agent(identity).sessions()).find(
        (session) => session.id === claim.sessionId,
      );
      requireLocalTaskRun(canonical, input.runId);
      const machine = await ods.resolveMachine(input.machine);
      return ods.claimedSession(claim).execute(machine.id, input.action, {
        timeoutSeconds: input.timeoutSeconds,
        idempotencyKey: input.idempotencyKey,
      });
    },
    async complete(input) {
      const agent = ods.agent(identity);
      const canonical = (await agent.sessions()).find(
        (session) => session.id === input.sessionId,
      );
      requireLocalTaskRun(canonical, input.runId);
      return agent.complete(
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

function requireLocalTaskRun(
  session: ListedAgentSession | undefined,
  runId: string | undefined,
): void {
  if (!session) {
    throw new ExpectedError(
      "Session state is unavailable for Task Run validation.",
      "session_claim_unavailable",
    );
  }
  requireTaskRun(session.scopes, session.runId, runId);
}

function requireTaskRun(
  scopes: SessionMachineScope[],
  expectedRunId: string | undefined,
  providedRunId: string | undefined,
): void {
  const decision = hostShellTaskRunAccessDecision(
    scopes,
    expectedRunId,
    providedRunId,
  );
  if (!decision.allowed) {
    throw new ExpectedError(
      decision.code === "task_run_id_required"
        ? "Host Shell authority requires its Task Run identifier."
        : "Host Shell authority belongs to a different Task Run.",
      decision.code,
    );
  }
}

function findReusableLocalOperationClaim(
  claims: Iterable<ClaimedAgentSession>,
  sessions: ListedAgentSession[],
  operations: Array<{ machineId: string; action: ScopedOperationAction }>,
): ClaimedAgentSession | undefined {
  return findReusableLocalClaim(
    claims,
    sessions,
    (claim, session) =>
      operations.every(
        ({ machineId, action }) =>
          session.targets.some(
            (target) =>
              target.machineId === machineId && target.status === "ready",
          ) &&
          claim.scopes.some(
            (scope) => sessionScopeDecision(scope, machineId, action).allowed,
          ),
      ),
  );
}

function findReusableLocalHostShellClaim(
  claims: Iterable<ClaimedAgentSession>,
  sessions: ListedAgentSession[],
  machineId: string,
  runId: string,
): ClaimedAgentSession | undefined {
  return findReusableLocalClaim(
    claims,
    sessions,
    (claim, session) =>
      session.runId === runId &&
      session.targets.some(
        (target) =>
          target.machineId === machineId && target.status === "ready",
      ) &&
      claim.scopes.some(
        (scope) =>
          scope.machineId === machineId &&
          scope.capabilities.includes("host.shell"),
      ),
  );
}

function findReusableLocalClaim(
  claims: Iterable<ClaimedAgentSession>,
  sessions: ListedAgentSession[],
  isCompatible: (
    claim: ClaimedAgentSession,
    session: ListedAgentSession,
  ) => boolean,
): ClaimedAgentSession | undefined {
  const now = Date.now();
  for (const claim of claims) {
    const session = sessions.find((candidate) => candidate.id === claim.sessionId);
    if (
      !session ||
      session.status !== "active" ||
      !isFutureTimestamp(claim.expiresAt, now) ||
      !isFutureTimestamp(session.expiresAt, now) ||
      !isCompatible(claim, session)
    ) {
      continue;
    }
    return claim;
  }
  return undefined;
}

function isFutureTimestamp(value: string, now: number): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > now;
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
