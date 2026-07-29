import type { Capability, OperationAction } from "@odyshell/protocol";
import type {
  AgentTokenRecord,
  AuditRecord,
  Database,
  MachineRecord,
  OperationEventRecord,
  OperationRecord,
  SessionRecord,
} from "./database.js";

type EnrollmentToken = {
  tokenHash: string;
  expiresAt: number;
  usedAt?: number;
  createdAt: number;
};

export class MemoryDatabase implements Database {
  private readonly machines = new Map<string, MachineRecord>();
  private readonly enrollmentTokens = new Map<string, EnrollmentToken>();
  private readonly agentTokens = new Map<string, AgentTokenRecord>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly operations = new Map<string, OperationRecord>();
  private readonly operationEvents = new Map<string, OperationEventRecord[]>();
  private readonly auditEvents: AuditRecord[] = [];

  async initialize(): Promise<void> {
    for (const machine of this.machines.values()) machine.status = "offline";
  }

  async health(): Promise<void> {}

  async findAgentByTokenHash(tokenHash: string): Promise<AgentTokenRecord | null> {
    const token = [...this.agentTokens.values()].find((item) => item.tokenHash === tokenHash);
    return token && token.revokedAt === undefined && token.expiresAt > Date.now() ? token : null;
  }

  async createEnrollmentToken(tokenHash: string, expiresAt: number): Promise<void> {
    this.enrollmentTokens.set(tokenHash, { tokenHash, expiresAt, createdAt: Date.now() });
  }

  async listAgentTokens(): Promise<AgentTokenRecord[]> {
    return [...this.agentTokens.values()]
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, 200);
  }

  async listMachines(options: {
    includeRevoked?: boolean;
    machineIds?: string[];
  } = {}): Promise<MachineRecord[]> {
    return [...this.machines.values()]
      .filter(
        (machine) =>
          (options.includeRevoked || machine.revokedAt === undefined) &&
          (!options.machineIds || options.machineIds.includes(machine.id)),
      )
      .sort((left, right) => left.enrolledAt - right.enrolledAt);
  }

  async activeMachinesExist(machineIds: string[]): Promise<boolean> {
    return machineIds.every((id) => {
      const machine = this.machines.get(id);
      return machine !== undefined && machine.revokedAt === undefined;
    });
  }

  async createAgentToken(input: {
    id: string;
    name: string;
    tokenHash: string;
    machineIds: string[];
    capabilities: Capability[];
    expiresAt: number;
  }): Promise<void> {
    this.agentTokens.set(input.id, { ...input, createdAt: Date.now() });
  }

  async revokeAgentToken(tokenId: string): Promise<AgentTokenRecord | null> {
    const token = this.agentTokens.get(tokenId);
    if (!token) return null;
    token.revokedAt ??= Date.now();
    return token;
  }

  async expireAgentSessions(
    principalId: string,
  ): Promise<Array<{ id: string; machineId: string }>> {
    const expired = [...this.sessions.values()].filter(
      (session) =>
        session.principalId === principalId && ["opening", "ready"].includes(session.status),
    );
    for (const session of expired) {
      session.status = "expired";
      session.updatedAt = Date.now();
    }
    return expired.map((session) => ({ id: session.id, machineId: session.machineId }));
  }

  async enrollMachine(input: {
    tokenHash: string;
    machineId: string;
    name: string;
    publicKey: string;
  }): Promise<{ machineId: string; name: string } | null> {
    const token = this.enrollmentTokens.get(input.tokenHash);
    if (!token || token.usedAt !== undefined || token.expiresAt <= Date.now()) return null;
    token.usedAt = Date.now();
    this.machines.set(input.machineId, {
      id: input.machineId,
      name: input.name,
      publicKey: input.publicKey,
      status: "offline",
      enrolledAt: Date.now(),
    });
    return { machineId: input.machineId, name: input.name };
  }

  async machinePublicKey(machineId: string): Promise<string | null> {
    const machine = this.machines.get(machineId);
    return machine && machine.revokedAt === undefined ? machine.publicKey : null;
  }

  async setMachineOffline(machineId: string): Promise<void> {
    const machine = this.machines.get(machineId);
    if (machine) machine.status = "offline";
  }

  async setMachineOnline(machineId: string, runtime?: unknown): Promise<boolean> {
    const machine = this.machines.get(machineId);
    if (!machine || machine.revokedAt !== undefined) return false;
    machine.status = "online";
    machine.lastSeenAt = Date.now();
    if (runtime !== undefined) machine.runtime = runtime;
    return true;
  }

  async heartbeat(machineId: string): Promise<void> {
    const machine = this.machines.get(machineId);
    if (machine && machine.revokedAt === undefined) {
      machine.status = "online";
      machine.lastSeenAt = Date.now();
    }
  }

  async revokeMachine(machineId: string): Promise<{
    id: string;
    name: string;
    revokedAt: number;
    operationIds: string[];
    sessionIds: string[];
  } | null> {
    const machine = this.machines.get(machineId);
    if (!machine || machine.revokedAt !== undefined) return null;
    machine.revokedAt = Date.now();
    machine.status = "offline";
    const sessions = [...this.sessions.values()].filter(
      (session) =>
        session.machineId === machineId && ["opening", "ready", "closing"].includes(session.status),
    );
    const sessionIds = new Set(sessions.map((session) => session.id));
    const operations = [...this.operations.values()].filter(
      (operation) =>
        sessionIds.has(operation.sessionId) &&
        ["queued", "delivered", "running"].includes(operation.status),
    );
    for (const session of sessions) {
      session.status = "closed";
      session.error = "machine_revoked";
      session.updatedAt = Date.now();
    }
    for (const operation of operations) {
      operation.status = "cancelled";
      operation.error = "machine_revoked";
      operation.updatedAt = Date.now();
    }
    return {
      id: machine.id,
      name: machine.name,
      revokedAt: machine.revokedAt,
      operationIds: operations.map((operation) => operation.id),
      sessionIds: sessions.map((session) => session.id),
    };
  }

  async listSessions(principalId: string): Promise<SessionRecord[]> {
    return [...this.sessions.values()]
      .filter((session) => session.principalId === principalId)
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, 100)
      .map((session) => ({
        ...session,
        machineName: this.machines.get(session.machineId)?.name ?? "Unknown machine",
      }));
  }

  async createSession(input: {
    id: string;
    machineId: string;
    principalId: string;
    profile: string;
    capabilities: Capability[];
    expiresAt: number;
  }): Promise<void> {
    const now = Date.now();
    this.sessions.set(input.id, { ...input, status: "opening", createdAt: now, updatedAt: now });
  }

  async getSession(sessionId: string, principalId: string): Promise<SessionRecord | null> {
    const session = this.sessions.get(sessionId);
    return session?.principalId === principalId ? session : null;
  }

  async getActiveSession(
    sessionId: string,
    principalId: string,
  ): Promise<SessionRecord | null> {
    const session = await this.getSession(sessionId, principalId);
    return session && ["opening", "ready"].includes(session.status) ? session : null;
  }

  async markSessionClosing(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = "closing";
      session.updatedAt = Date.now();
    }
  }

  async markSessionOpened(sessionId: string): Promise<{ principalId: string } | null> {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== "opening") return null;
    session.status = "ready";
    delete session.error;
    session.updatedAt = Date.now();
    return { principalId: session.principalId };
  }

  async markSessionOpenFailed(
    sessionId: string,
    error: string,
  ): Promise<{ principalId: string } | null> {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== "opening") return null;
    session.status = "failed";
    session.error = error;
    session.updatedAt = Date.now();
    return { principalId: session.principalId };
  }

  async markSessionClosed(
    sessionId: string,
  ): Promise<{ principalId: string; status: string } | null> {
    const session = this.sessions.get(sessionId);
    if (!session || !["opening", "ready", "closing"].includes(session.status)) return null;
    session.status = session.expiresAt <= Date.now() ? "expired" : "closed";
    session.updatedAt = Date.now();
    return { principalId: session.principalId, status: session.status };
  }

  async findOperationByIdempotency(
    principalId: string,
    idempotencyKey: string,
  ): Promise<Pick<OperationRecord, "id" | "status"> | null> {
    return (
      [...this.operations.values()].find(
        (operation) =>
          operation.principalId === principalId &&
          operation.idempotencyKey === idempotencyKey,
      ) ?? null
    );
  }

  async sessionForOperation(
    sessionId: string,
    principalId: string,
  ): Promise<SessionRecord | null> {
    return await this.getSession(sessionId, principalId);
  }

  async createOperation(input: {
    id: string;
    sessionId: string;
    principalId: string;
    action: OperationAction;
    timeoutSeconds: number;
    maxOutputBytes: number;
    idempotencyKey?: string;
  }): Promise<void> {
    const now = Date.now();
    this.operations.set(input.id, {
      ...input,
      status: "queued",
      outputTruncated: false,
      createdAt: now,
      updatedAt: now,
    });
  }

  async markOperationDelivered(operationId: string): Promise<void> {
    const operation = this.operations.get(operationId);
    if (operation) {
      operation.status = "delivered";
      operation.updatedAt = Date.now();
    }
  }

  async markOperationStarted(operationId: string): Promise<void> {
    const operation = this.operations.get(operationId);
    if (operation && ["queued", "delivered"].includes(operation.status)) {
      operation.status = "running";
      operation.updatedAt = Date.now();
    }
  }

  async addOperationEvent(input: {
    operationId: string;
    sequence: number;
    stream: string;
    dataBase64: string;
  }): Promise<void> {
    const events = this.operationEvents.get(input.operationId) ?? [];
    if (!events.some((event) => event.sequence === input.sequence)) {
      events.push({ ...input, createdAt: Date.now() });
      events.sort((left, right) => left.sequence - right.sequence);
      this.operationEvents.set(input.operationId, events);
    }
  }

  async markOperationCompleted(input: {
    operationId: string;
    status: string;
    exitCode: number | null;
    error?: string;
    outputTruncated: boolean;
  }): Promise<{ principalId: string } | null> {
    const operation = this.operations.get(input.operationId);
    if (!operation || !["queued", "delivered", "running"].includes(operation.status)) return null;
    operation.status = input.status;
    if (input.exitCode === null) delete operation.exitCode;
    else operation.exitCode = input.exitCode;
    if (input.error === undefined) delete operation.error;
    else operation.error = input.error;
    operation.outputTruncated = input.outputTruncated;
    operation.updatedAt = Date.now();
    return { principalId: operation.principalId };
  }

  async getOperation(
    operationId: string,
    principalId: string,
  ): Promise<(OperationRecord & { events: OperationEventRecord[] }) | null> {
    const operation = this.operations.get(operationId);
    return operation?.principalId === principalId
      ? { ...operation, events: this.operationEvents.get(operationId) ?? [] }
      : null;
  }

  async getOperationTarget(
    operationId: string,
    principalId: string,
  ): Promise<{ machineId: string; status: string } | null> {
    const operation = this.operations.get(operationId);
    if (!operation || operation.principalId !== principalId) return null;
    const session = this.sessions.get(operation.sessionId);
    return session ? { machineId: session.machineId, status: operation.status } : null;
  }

  async operationExists(operationId: string, principalId: string): Promise<boolean> {
    return this.operations.get(operationId)?.principalId === principalId;
  }

  async listOperationEvents(
    operationId: string,
    afterSequence: number,
  ): Promise<OperationEventRecord[]> {
    return (this.operationEvents.get(operationId) ?? []).filter(
      (event) => event.sequence > afterSequence,
    );
  }

  async operationStatus(operationId: string): Promise<string | null> {
    return this.operations.get(operationId)?.status ?? null;
  }

  async listAudit(limit: number, principalId?: string): Promise<AuditRecord[]> {
    return this.auditEvents
      .filter((event) => principalId === undefined || event.principalId === principalId)
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, limit);
  }

  async audit(
    principalId: string,
    action: string,
    targetType: string,
    targetId: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    const createdAt = Date.now();
    this.auditEvents.push({
      id: `${createdAt}-${crypto.randomUUID()}`,
      principalId,
      action,
      targetType,
      targetId,
      metadata,
      createdAt,
    });
  }

  async expireSessions(): Promise<Array<{ id: string; machineId: string }>> {
    const now = Date.now();
    const expired = [...this.sessions.values()].filter((session) => {
      if (!["opening", "ready"].includes(session.status)) return false;
      const token = this.agentTokens.get(session.principalId);
      return (
        session.expiresAt <= now ||
        (token !== undefined && (token.expiresAt <= now || token.revokedAt !== undefined))
      );
    });
    for (const session of expired) {
      session.status = "expired";
      session.updatedAt = now;
    }
    return expired.map((session) => ({ id: session.id, machineId: session.machineId }));
  }
}
