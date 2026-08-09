import { createHash, randomUUID } from "node:crypto";
import {
  commandDecision,
  type Command,
  type CommandRequest,
  type LocalPolicy,
  type Session,
  type SessionRequest,
} from "@odyshell/protocol";

export type AgentPrincipal = {
  organizationId: string;
  agentId: string;
  agentRole: AgentRole;
};

export type SessionSupervisorPrincipal = {
  organizationId: string;
  humanId: string;
  role: "owner" | "admin" | "supervisor";
};

export type MachineAuthority = {
  organizationId: string;
  machineId: string;
  clientProfileId: string;
  operatingSystemUser: string;
  online: boolean;
  localPolicy: LocalPolicy;
};

export type AgentRole = "standard" | "operator";

type SessionCreation = {
  session: Session;
  idempotencyKeyHash: string;
  requestFingerprint: string;
};

type CommandCreation = {
  command: Command;
  idempotencyKeyHash: string;
  requestFingerprint: string;
};

export interface SessionRepository {
  sessionByIdempotency(
    organizationId: string,
    agentId: string,
    idempotencyKeyHash: string,
  ): Promise<{ session: Session; requestFingerprint: string } | null>;
  machineAuthority(organizationId: string, machineId: string): Promise<MachineAuthority | null>;
  countActiveSessions(organizationId: string, machineId: string): Promise<number>;
  createSession(input: SessionCreation): Promise<
    | { status: "created"; session: Session }
    | { status: "replayed"; session: Session }
    | { status: "idempotency_conflict" }
  >;
  session(organizationId: string, sessionId: string): Promise<Session | null>;
  command(organizationId: string, commandId: string): Promise<Command | null>;
  commandOutput(
    organizationId: string,
    commandId: string,
    afterSequence: number,
  ): Promise<Array<{ sequence: number; stream: "stdout" | "stderr"; dataBase64: string }>>;
  finishSession(input: {
    organizationId: string;
    agentId: string;
    sessionId: string;
    outcome: "complete" | "cancel";
  }): Promise<
    | { status: "not_found" }
    | { status: "commands_active" }
    | { status: "finished"; session: Session; commandIds: string[] }
  >;
  requestCommandCancellation(input: {
    organizationId: string;
    agentId: string;
    commandId: string;
  }): Promise<Command | null>;
  commandByIdempotency(
    organizationId: string,
    sessionId: string,
    idempotencyKeyHash: string,
  ): Promise<{ command: Command; requestFingerprint: string } | null>;
  countActiveCommands(organizationId: string, sessionId: string): Promise<number>;
  createCommand(input: CommandCreation): Promise<
    | { status: "created"; command: Command }
    | { status: "replayed"; command: Command }
    | { status: "idempotency_conflict" }
  >;
  decideSession(input: {
    organizationId: string;
    sessionId: string;
    decision: "approve" | "deny";
  }): Promise<
    | { status: "not_found" | "conflict" }
    | { status: "approved" | "denied"; session: Session; changed: boolean }
  >;
}

export interface SessionClient {
  openSession(session: Session): Promise<void>;
  startCommand(command: Command): Promise<void>;
  closeSession(session: Session, reason: string): Promise<void>;
  cancelCommand(command: Command): Promise<void>;
}

export class SessionClientUnavailableError extends Error {
  constructor() {
    super("Machine disconnected before Session delivery");
    this.name = "SessionClientUnavailableError";
  }
}

export interface SessionAudit {
  append(event: {
    organizationId: string;
    agentId: string;
    sessionId: string;
    commandId?: string;
    type:
      | "session.requested"
      | "session.opened"
      | "session.open_failed"
      | "session.approved"
      | "session.denied"
      | "session.closed"
      | "command.created"
      | "command.completed";
    metadata: Record<string, unknown>;
  }): Promise<void>;
}

export type RequestSessionResult =
  | { status: "created" | "replayed"; session: Session }
  | {
      status: "denied";
      code:
        | "machine_not_found"
        | "machine_offline"
        | "organization_denied"
        | "supervision_denied"
        | "duration_denied"
        | "session_concurrency_denied"
        | "command_concurrency_denied"
        | "idempotency_conflict";
    };

export type CreateCommandResult =
  | { status: "created" | "replayed"; command: Command }
  | {
      status: "denied";
      code:
        | "session_not_found"
        | "session_agent_denied"
        | "session_not_active"
        | "session_expired"
        | "timeout_exceeds_session"
        | "timeout_exceeds_local_policy"
        | "command_concurrency_denied"
        | "idempotency_conflict";
    };

export class SessionService {
  constructor(
    private readonly repository: SessionRepository,
    private readonly client: SessionClient,
    private readonly audit: SessionAudit,
    private readonly now: () => number = Date.now,
  ) {}

  async requestSession(
    principal: AgentPrincipal,
    request: SessionRequest,
    idempotencyKey: string,
  ): Promise<RequestSessionResult> {
    const idempotencyKeyHash = hash(idempotencyKey);
    const requestFingerprint = fingerprint({
      principal: {
        organizationId: principal.organizationId,
        agentId: principal.agentId,
      },
      request,
    });
    const replay = await this.repository.sessionByIdempotency(
      principal.organizationId,
      principal.agentId,
      idempotencyKeyHash,
    );
    if (replay) {
      return replay.requestFingerprint === requestFingerprint
        ? { status: "replayed", session: replay.session }
        : { status: "denied", code: "idempotency_conflict" };
    }
    const machine = await this.repository.machineAuthority(
      principal.organizationId,
      request.machineId,
    );
    if (!machine) return { status: "denied", code: "machine_not_found" };
    if (machine.organizationId !== principal.organizationId) {
      return { status: "denied", code: "organization_denied" };
    }
    if (!machine.online) return { status: "denied", code: "machine_offline" };

    const policy = machine.localPolicy;
    if (policy.organizationId !== principal.organizationId) {
      return { status: "denied", code: "organization_denied" };
    }
    if (request.durationSeconds > policy.maxSessionDurationSeconds) {
      return { status: "denied", code: "duration_denied" };
    }
    const activeSessions = await this.repository.countActiveSessions(
      principal.organizationId,
      request.machineId,
    );
    if (activeSessions >= policy.maxConcurrentSessions) {
      return { status: "denied", code: "session_concurrency_denied" };
    }

    const operator = principal.agentRole === "operator";
    const maxConcurrentCommands = policy.maxConcurrentCommands;
    if (maxConcurrentCommands < 1) {
      return { status: "denied", code: "command_concurrency_denied" };
    }
    if (!operator && !policy.allowRemoteApproval) {
      return { status: "denied", code: "supervision_denied" };
    }

    const now = this.now();
    const session: Session = {
      id: randomUUID(),
      organizationId: principal.organizationId,
      agentId: principal.agentId,
      machineId: request.machineId,
      clientProfileId: machine.clientProfileId,
      operatingSystemUser: machine.operatingSystemUser,
      title: request.title,
      purpose: request.purpose ?? null,
      status: operator ? "opening" : "pending_approval",
      maxConcurrentCommands,
      createdAt: new Date(now).toISOString(),
      readyAt: null,
      expiresAt: new Date(now + request.durationSeconds * 1_000).toISOString(),
      finishedAt: null,
    };
    const stored = await this.repository.createSession({
      session,
      idempotencyKeyHash,
      requestFingerprint,
    });
    if (stored.status === "idempotency_conflict") {
      return { status: "denied", code: "idempotency_conflict" };
    }
    if (stored.status === "replayed") return stored;

    await this.audit.append({
      organizationId: session.organizationId,
      agentId: session.agentId,
      sessionId: session.id,
      type: "session.requested",
      metadata: {
        machineId: session.machineId,
        clientProfileId: session.clientProfileId,
        operatingSystemUser: session.operatingSystemUser,
        durationSeconds: request.durationSeconds,
        agentRole: principal.agentRole,
        approval: operator ? "operator" : "human_required",
      },
    });
    if (session.status === "opening") await this.client.openSession(session);
    return { status: "created", session };
  }

  async createCommand(
    principal: AgentPrincipal,
    sessionId: string,
    request: CommandRequest,
    idempotencyKey: string,
  ): Promise<CreateCommandResult> {
    const idempotencyKeyHash = hash(idempotencyKey);
    const requestFingerprint = fingerprint({
      principal: {
        organizationId: principal.organizationId,
        agentId: principal.agentId,
      },
      sessionId,
      request,
    });
    const replay = await this.repository.commandByIdempotency(
      principal.organizationId,
      sessionId,
      idempotencyKeyHash,
    );
    if (replay) {
      return replay.requestFingerprint === requestFingerprint
        ? { status: "replayed", command: replay.command }
        : { status: "denied", code: "idempotency_conflict" };
    }
    const session = await this.repository.session(principal.organizationId, sessionId);
    if (!session) return { status: "denied", code: "session_not_found" };
    if (session.agentId !== principal.agentId) {
      return { status: "denied", code: "session_agent_denied" };
    }
    const machine = await this.repository.machineAuthority(
      principal.organizationId,
      session.machineId,
    );
    if (!machine) return { status: "denied", code: "session_not_found" };
    const decision = commandDecision(session, request, machine.localPolicy, this.now());
    if (!decision.allowed) return { status: "denied", code: decision.code };
    if (
      await this.repository.countActiveCommands(principal.organizationId, session.id) >=
      session.maxConcurrentCommands
    ) {
      return { status: "denied", code: "command_concurrency_denied" };
    }

    const now = this.now();
    const command: Command = {
      id: randomUUID(),
      sessionId: session.id,
      organizationId: session.organizationId,
      agentId: session.agentId,
      machineId: session.machineId,
      command: request.command,
      cwd: request.cwd ?? null,
      timeoutSeconds: decision.timeoutSeconds,
      status: "queued",
      createdAt: new Date(now).toISOString(),
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      outputTruncated: false,
      stdoutBytes: 0,
      stderrBytes: 0,
      error: null,
    };
    const stored = await this.repository.createCommand({
      command,
      idempotencyKeyHash,
      requestFingerprint,
    });
    if (stored.status === "idempotency_conflict") {
      return { status: "denied", code: "idempotency_conflict" };
    }
    if (stored.status === "replayed") return stored;

    await this.audit.append({
      organizationId: command.organizationId,
      agentId: command.agentId,
      sessionId: command.sessionId,
      commandId: command.id,
      type: "command.created",
      metadata: {
        machineId: command.machineId,
        command: command.command,
        cwd: command.cwd,
        timeoutSeconds: command.timeoutSeconds,
      },
    });
    await this.client.startCommand(command);
    return { status: "created", command };
  }

  async superviseSession(
    principal: SessionSupervisorPrincipal,
    sessionId: string,
    decision: "approve" | "deny",
  ): Promise<
    | { status: "approved" | "denied"; session: Session; delivery: "sent" | "pending" }
    | { status: "denied_request"; code: "session_not_found" | "session_already_decided" }
  > {
    const result = await this.repository.decideSession({
      organizationId: principal.organizationId,
      sessionId,
      decision,
    });
    if (!("session" in result)) {
      return {
        status: "denied_request",
        code: result.status === "not_found" ? "session_not_found" : "session_already_decided",
      };
    }
    if (result.changed) {
      await this.audit.append({
        organizationId: result.session.organizationId,
        agentId: result.session.agentId,
        sessionId: result.session.id,
        type: decision === "approve" ? "session.approved" : "session.denied",
        metadata: { humanId: principal.humanId, role: principal.role },
      });
    }
    if (result.status === "denied") {
      return { status: "denied", session: result.session, delivery: "sent" };
    }
    try {
      await this.client.openSession(result.session);
      return { status: "approved", session: result.session, delivery: "sent" };
    } catch (error) {
      if (!(error instanceof SessionClientUnavailableError)) throw error;
      return { status: "approved", session: result.session, delivery: "pending" };
    }
  }

  async finishSession(
    principal: AgentPrincipal,
    sessionId: string,
    outcome: "complete" | "cancel",
  ): Promise<
    | { status: "completed" | "cancellation_requested"; session: Session }
    | { status: "denied"; code: "session_not_found" | "commands_active" }
  > {
    const result = await this.repository.finishSession({
      ...principal,
      sessionId,
      outcome,
    });
    if (result.status === "not_found" || result.status === "commands_active") {
      return {
        status: "denied",
        code: result.status === "not_found" ? "session_not_found" : "commands_active",
      };
    }
    if (outcome === "cancel") {
      for (const commandId of result.commandIds) {
        const command = await this.repository.command(principal.organizationId, commandId);
        if (command) await this.client.cancelCommand(command);
      }
    }
    await this.client.closeSession(result.session, outcome === "complete" ? "completed" : "cancelled");
    return {
      status: outcome === "complete" ? "completed" : "cancellation_requested",
      session: result.session,
    };
  }

  async cancelCommand(
    principal: AgentPrincipal,
    commandId: string,
  ): Promise<
    | { status: "cancellation_requested"; command: Command }
    | { status: "denied"; code: "command_not_found" }
  > {
    const command = await this.repository.requestCommandCancellation({
      ...principal,
      commandId,
    });
    if (!command) return { status: "denied", code: "command_not_found" };
    await this.client.cancelCommand(command);
    return { status: "cancellation_requested", command };
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fingerprint(value: unknown): string {
  return hash(JSON.stringify(value));
}
