import { createHash, randomUUID } from "node:crypto";
import type {
  ApprovedMcpOperationResult,
  ApprovedMcpRuntime,
} from "@odyshell/mcp";
import {
  capabilitySchema,
  operationSessionScopes,
  type Capability,
} from "@odyshell/protocol";
import { sessionApprovalUrl, type ScopedRateLimiter } from "./cloud.js";
import {
  audit,
  type AgentSessionCredentialPrincipal,
  type Database,
  type McpInstallationRecord,
} from "./database.js";
import {
  sessionOperationDecision,
  type AgentSessionPrincipal,
} from "./agent-sessions.js";
import type { ClientGateway } from "./gateway.js";

export type RemoteMcpRuntimeDependencies = {
  database: Database;
  gateway: ClientGateway;
  sessionRequestLimiter: ScopedRateLimiter;
  webUrl?: string;
};

export function createRemoteMcpRuntime(
  installation: McpInstallationRecord,
  dependencies: RemoteMcpRuntimeDependencies,
): ApprovedMcpRuntime {
  const { database: db, gateway, sessionRequestLimiter, webUrl } = dependencies;
  return {
    async machines() {
      return {
        data: (await db.listMachines(installation.workspaceId)).map((machine) => ({
          id: machine.id,
          name: machine.name,
          online: gateway.isOnline(machine.id),
          status: gateway.isOnline(machine.id) ? "online" : "offline",
          ...mcpMachineExecutionFacts(machine.runtime),
          lastSeenAt: isoTimestamp(machine.lastSeenAt),
        })),
      };
    },
    async ping(machineReference) {
      const machine = await resolveMcpMachine(db, installation, machineReference);
      if (!gateway.isOnline(machine.id)) {
        throw new RemoteMcpError("Machine is offline", "machine_offline", 409);
      }
      try {
        const latencyMs = await gateway.ping(machine.id);
        return { reply: "pong", machineId: machine.id, latencyMs };
      } catch {
        throw new RemoteMcpError("Machine ping timed out", "machine_ping_timeout", 504);
      }
    },
    async request(input) {
      if (
        !sessionRequestLimiter.allow(
          installation.workspaceId,
          installation.id,
        )
      ) {
        throw new RemoteMcpError(
          "Too many Session requests",
          "session_request_rate_limited",
          429,
        );
      }
      if (!webUrl) {
        throw new RemoteMcpError(
          "Session approval is unavailable",
          "session_approval_unavailable",
          503,
        );
      }
      const operations = await Promise.all(
        input.operations.map(async (operation) => ({
          machineId: (await resolveMcpMachine(db, installation, operation.machine))
            .id,
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
        throw new RemoteMcpError(
          shellRequested
            ? "Free-form shell cannot be safely scoped. Use process.exec."
            : "Operations cannot be combined without broadening their scope.",
          shellRequested
            ? "process_shell_unsupported"
            : "session_scope_conflict",
          400,
        );
      }
      const requestId = randomUUID();
      const created = await db.createAgentSessionRequest({
        workspaceId: installation.workspaceId,
        requestId,
        agentId: installation.agentId,
        agentName: installation.agentName,
        humanId: installation.userId,
        ...(input.runId ? { runId: input.runId } : {}),
        scopes,
        purpose: input.purpose,
        durationSeconds: input.durationSeconds,
        approvalCodeHash: hashToken(requestId),
        expiresAt: Date.now() + 10 * 60 * 1_000,
      });
      if (!created) {
        throw new RemoteMcpError(
          "Agent or machine is unavailable",
          "agent_or_machine_denied",
          403,
        );
      }
      await audit(
        db,
        installation.workspaceId,
        installation.agentId,
        "session.requested",
        "session_request",
        requestId,
        {
          machineIds: scopes.map((scope) => scope.machineId),
          kinds: input.operations.map((operation) => operation.action.kind),
          durationSeconds: input.durationSeconds,
          source: "remote_mcp",
        },
      );
      gateway.notifyWorkspace(installation.workspaceId);
      return {
        id: requestId,
        status: created.status,
        ...(created.status === "pending"
          ? {
              approvalUrl: sessionApprovalUrl(webUrl, requestId),
            }
          : {}),
        expiresAt: isoTimestamp(created.expiresAt),
      };
    },
    async requests() {
      const requests = await db.listAgentSessionRequests(
        installation.workspaceId,
        installation.agentId,
        installation.userId,
        20,
      );
      return {
        data: requests.map((request) => ({
          id: request.id,
          status: request.status,
          purpose: request.purpose,
          ...(request.status === "pending" && webUrl
            ? { approvalUrl: sessionApprovalUrl(webUrl, request.id) }
            : {}),
          expiresAt: isoTimestamp(request.expiresAt),
        })),
      };
    },
    async status(requestId) {
      const bound = await db.mcpSessionForRequest({
        workspaceId: installation.workspaceId,
        installationId: installation.id,
        requestId,
      });
      const granted = await db.mcpGrantedSessionForRequest({
        workspaceId: installation.workspaceId,
        installationId: installation.id,
        requestId,
      });
      if (granted) return remoteMcpSessionStatus(db, granted);
      if (bound) {
        return {
          status: bound.expiresAt <= Date.now() ? "expired" : bound.status,
          sessionId: bound.sessionId,
          expiresAt: isoTimestamp(bound.expiresAt),
        };
      }
      const current = await db.getAgentSessionRequest(
        installation.workspaceId,
        requestId,
        installation.agentId,
        installation.userId,
      );
      if (!current) {
        throw new RemoteMcpError(
          "Session request was not found",
          "session_request_not_found",
          404,
        );
      }
      if (current.status !== "approved") {
        if (current.status === "claimed") {
          throw new RemoteMcpError(
            "Session was claimed by another installation",
            "session_claim_unavailable",
            409,
          );
        }
        return {
          id: current.id,
          status: current.status,
          expiresAt: isoTimestamp(current.expiresAt),
        };
      }
      const result = await db.claimAgentSessionRequest({
        workspaceId: installation.workspaceId,
        requestId,
        agentId: installation.agentId,
        humanId: installation.userId,
        sessionId: randomUUID(),
        authority: { kind: "mcp", installationId: installation.id },
        now: Date.now(),
      });
      if (result.status !== "claimed") {
        throw new RemoteMcpError(
          "Session could not be claimed",
          `session_${result.status}`,
          result.status === "expired" ? 410 : 409,
        );
      }
      for (const target of result.targets) {
        const sent = gateway.send(target.machineId, {
          type: "session.open",
          sessionId: target.runtimeSessionId,
          profile: target.scope.profile,
          capabilities: target.scope.capabilities,
          restrictions: target.scope.restrictions,
          expiresAt: new Date(result.session.expiresAt).toISOString(),
          serverTime: new Date().toISOString(),
        });
        if (!sent) {
          await db.markSessionOpenFailed(
            target.machineId,
            target.runtimeSessionId,
            "machine_disconnected",
          );
        }
      }
      gateway.notifyWorkspace(installation.workspaceId);
      const principal = await db.findMcpSessionPrincipal({
        workspaceId: installation.workspaceId,
        installationId: installation.id,
        sessionId: result.session.id,
      });
      if (!principal) {
        throw new RemoteMcpError(
          "Claimed Session is unavailable",
          "session_claim_unavailable",
          409,
        );
      }
      return remoteMcpSessionStatus(db, principal);
    },
    async execute(input) {
      const principal = await db.findMcpSessionPrincipal({
        workspaceId: installation.workspaceId,
        installationId: installation.id,
        sessionId: input.sessionId,
      });
      if (!principal) {
        throw new RemoteMcpError(
          "Session is unavailable or expired",
          "session_credential_required",
          403,
        );
      }
      const machine = await resolveMcpMachine(db, installation, input.machine);
      const sessionPrincipal: AgentSessionPrincipal = {
        workspaceId: principal.workspaceId,
        agentId: principal.agentId,
        sessionId: principal.sessionId,
        scopes: principal.scopes,
        expiresAt: principal.expiresAt,
      };
      const decision = sessionOperationDecision(
        sessionPrincipal,
        input.sessionId,
        machine.id,
        input.action,
        input.timeoutSeconds,
      );
      if (!decision.allowed) {
        await audit(
          db,
          principal.workspaceId,
          principal.agentId,
          "operation.denied",
          "session",
          input.sessionId,
          { reason: decision.code, kind: input.action.kind },
        );
        throw new RemoteMcpError(
          "Operation is outside the approved Session scope",
          decision.code,
          decision.code === "session_expired" ? 410 : 403,
        );
      }
      const target = await db.getAgentSessionTargetRuntime(
        principal.workspaceId,
        input.sessionId,
        principal.agentId,
        machine.id,
      );
      if (!target) {
        throw new RemoteMcpError(
          "Session target was not found",
          "session_target_not_found",
          404,
        );
      }
      const existing = await db.findOperationByIdempotency(
        principal.workspaceId,
        target.runtimeSessionId,
        principal.agentId,
        input.operationId,
      );
      if (existing) {
        return waitForRemoteMcpOperation(
          db,
          principal.workspaceId,
          principal.agentId,
          input.sessionId,
          existing.id,
          input.timeoutSeconds,
        );
      }
      if (target.status !== "ready") {
        throw new RemoteMcpError(
          "Session target is not ready",
          "session_not_ready",
          409,
        );
      }
      if (!gateway.isOnline(machine.id)) {
        throw new RemoteMcpError("Machine is offline", "machine_offline", 409);
      }
      const operationId = randomUUID();
      const created = await db.createOperation({
        workspaceId: principal.workspaceId,
        id: operationId,
        sessionId: target.runtimeSessionId,
        principalId: principal.agentId,
        action: input.action,
        timeoutSeconds: input.timeoutSeconds,
        maxOutputBytes: 1024 * 1024,
        idempotencyKey: input.operationId,
      });
      if (!created) {
        const replay = await db.findOperationByIdempotency(
          principal.workspaceId,
          target.runtimeSessionId,
          principal.agentId,
          input.operationId,
        );
        if (!replay) {
          throw new RemoteMcpError(
            "Session is no longer active",
            "session_not_active",
            409,
          );
        }
        return waitForRemoteMcpOperation(
          db,
          principal.workspaceId,
          principal.agentId,
          input.sessionId,
          replay.id,
          input.timeoutSeconds,
        );
      }
      const sent = gateway.send(machine.id, {
        type: "operation.start",
        operationId,
        sessionId: target.runtimeSessionId,
        action: input.action,
        timeoutSeconds: input.timeoutSeconds,
        maxOutputBytes: 1024 * 1024,
      });
      if (!sent) {
        throw new RemoteMcpError("Machine is offline", "machine_offline", 409);
      }
      await db.markOperationDelivered(principal.workspaceId, operationId);
      await audit(
        db,
        principal.workspaceId,
        principal.agentId,
        "operation.created",
        "operation",
        operationId,
        {
          sessionId: input.sessionId,
          machineId: machine.id,
          kind: input.action.kind,
          source: "remote_mcp",
        },
      );
      return waitForRemoteMcpOperation(
        db,
        principal.workspaceId,
        principal.agentId,
        input.sessionId,
        operationId,
        input.timeoutSeconds,
      );
    },
    async complete(input) {
      const { sessionId } = input;
      const principal = await db.findMcpSessionPrincipal({
        workspaceId: installation.workspaceId,
        installationId: installation.id,
        sessionId,
      });
      if (!principal) {
        throw new RemoteMcpError("Session was not found", "session_not_found", 404);
      }
      const termination = await db.completeAgentSession({
        workspaceId: principal.workspaceId,
        sessionId,
        agentId: principal.agentId,
        requestedByHumanId: installation.userId,
        outcome: input.outcome,
        ...(input.summary ? { summary: input.summary } : {}),
      });
      if (!termination) {
        throw new RemoteMcpError("Session was not found", "session_not_found", 404);
      }
      if (termination.status === "busy") {
        throw new RemoteMcpError(
          "Session still has active operations",
          "session_operations_active",
          409,
        );
      }
      for (const target of termination.targets) {
        gateway.send(target.machineId, {
          type: "session.close",
          sessionId: target.runtimeSessionId,
          reason: "completed",
        });
      }
      gateway.notifyWorkspace(principal.workspaceId);
      return {
        id: sessionId,
        status: "completed",
        transitioned: termination.transitioned,
      };
    },
    async timeline(sessionId) {
      const owner = await db.mcpSessionOwner({
        workspaceId: installation.workspaceId,
        installationId: installation.id,
        sessionId,
      });
      if (!owner) {
        throw new RemoteMcpError("Session was not found", "session_not_found", 404);
      }
      const events = await db.listSessionTimeline(
        installation.workspaceId,
        sessionId,
        owner.agentId,
        owner.userId,
      );
      return {
        data: (events ?? []).map((event) => ({
          ...event,
          createdAt: isoTimestamp(event.createdAt),
        })),
      };
    },
  };
}

function mcpMachineExecutionFacts(runtime: unknown): {
  platform: "linux" | "macos" | "windows" | null;
  architecture: string | null;
  runner: "host" | "docker" | null;
  capabilities: Capability[] | null;
  clientVersion: string | null;
} {
  if (!isRecord(runtime)) {
    return {
      platform: null,
      architecture: null,
      runner: null,
      capabilities: null,
      clientVersion: null,
    };
  }
  const platform =
    runtime.hostPlatform === "linux" ||
    runtime.hostPlatform === "macos" ||
    runtime.hostPlatform === "windows"
      ? runtime.hostPlatform
      : null;
  const profiles = Array.isArray(runtime.profiles) ? runtime.profiles : [];
  const workspace = profiles.find(
    (profile) => isRecord(profile) && profile.name === "workspace",
  );
  const runner =
    isRecord(workspace) &&
    (workspace.runner === "host" || workspace.runner === "docker")
      ? workspace.runner
      : null;
  const capabilities = isRecord(workspace)
    ? safeCapabilities(workspace.capabilities)
    : null;
  return {
    platform,
    architecture: safeRuntimeString(runtime.architecture),
    runner,
    capabilities,
    clientVersion: safeRuntimeString(runtime.clientVersion),
  };
}

function safeCapabilities(value: unknown): Capability[] | null {
  if (!Array.isArray(value)) return null;
  const capabilities = value.flatMap((candidate) => {
    const parsed = capabilitySchema.safeParse(candidate);
    return parsed.success ? [parsed.data] : [];
  });
  return [...new Set(capabilities)];
}

function safeRuntimeString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 128
    ? value
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function resolveMcpMachine(
  db: Database,
  installation: McpInstallationRecord,
  reference: string,
) {
  const machines = await db.listMachines(installation.workspaceId);
  const matches = machines.filter(
    (machine) => machine.id === reference || machine.name === reference,
  );
  if (matches.length !== 1) {
    throw new RemoteMcpError(
      matches.length === 0 ? "Machine was not found" : "Machine name is ambiguous",
      matches.length === 0 ? "machine_not_found" : "machine_ambiguous",
      matches.length === 0 ? 404 : 409,
    );
  }
  return matches[0]!;
}

async function remoteMcpSessionStatus(
  db: Database,
  principal: AgentSessionCredentialPrincipal,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 3_000;
  while (true) {
    const targets = await db.listAgentSessionTargetRuntimes(
      principal.workspaceId,
      principal.sessionId,
      principal.agentId,
    );
    const failedTarget = targets.find(
      (target) => target.status !== "opening" && target.status !== "ready",
    );
    const status = failedTarget
      ? "failed"
      : targets.every((target) => target.status === "ready")
        ? "ready"
        : "opening";
    const result = {
      status,
      sessionId: principal.sessionId,
      machines: targets.map((target) => ({
        machineId: target.machineId,
        capabilities: target.capabilities,
        status: target.status,
        ...(target.status === "opening" || target.status === "ready"
          ? {}
          : { reason: sessionOpenFailureReason(target.error) }),
      })),
      ...(failedTarget
        ? { reason: sessionOpenFailureReason(failedTarget.error) }
        : {}),
      expiresAt: isoTimestamp(principal.expiresAt),
    };
    if (
      status !== "opening" ||
      Date.now() >= deadline
    ) {
      return result;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
}

function sessionOpenFailureReason(error?: string): string {
  const normalized = error?.toLowerCase() ?? "";
  if (normalized.includes("machine_disconnected")) return "machine_offline";
  if (
    normalized.includes("capability") &&
    normalized.includes("denied by local policy")
  ) {
    return "capability_denied_by_machine";
  }
  if (normalized.includes("scope violates local policy")) {
    return "scope_denied_by_machine";
  }
  if (normalized.includes("session ttl violates local policy")) {
    return "ttl_denied_by_machine";
  }
  if (normalized.includes("concurrent session limit")) {
    return "machine_session_limit";
  }
  if (normalized.includes("unknown local profile")) {
    return "profile_unavailable";
  }
  if (normalized.includes("executor") && normalized.includes("unavailable")) {
    return "executor_unavailable";
  }
  return "machine_rejected_session";
}

async function waitForRemoteMcpOperation(
  db: Database,
  workspaceId: string,
  agentId: string,
  sessionId: string,
  operationId: string,
  timeoutSeconds: number,
): Promise<ApprovedMcpOperationResult> {
  const deadline = Date.now() + (timeoutSeconds + 10) * 1_000;
  while (Date.now() < deadline) {
    const operation = await db.getOperation(
      workspaceId,
      operationId,
      agentId,
      sessionId,
    );
    if (!operation) {
      throw new RemoteMcpError("Operation was not found", "operation_not_found", 404);
    }
    if (!["queued", "delivered", "running"].includes(operation.status)) {
      const output = { stdout: "", stderr: "", result: "" };
      for (const event of operation.events) {
        if (event.stream in output) {
          output[event.stream as keyof typeof output] += Buffer.from(
            event.dataBase64,
            "base64",
          ).toString("utf8");
        }
      }
      let result: unknown;
      try {
        result = output.result ? JSON.parse(output.result) : undefined;
      } catch {
        result = output.result;
      }
      return {
        operation: {
          id: operation.id,
          sessionId,
          status: operation.status,
          exitCode: operation.exitCode ?? null,
          error: operation.error ?? null,
          outputTruncated: operation.outputTruncated,
        },
        stdout: output.stdout,
        stderr: output.stderr,
        result,
        resultText: output.result,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new RemoteMcpError("Operation timed out", "operation_timeout", 504);
}

class RemoteMcpError extends Error {
  readonly expected = true;

  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function isoTimestamp(timestamp: number | undefined): string | null {
  return timestamp === undefined ? null : new Date(timestamp).toISOString();
}
