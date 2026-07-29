import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { randomUUID } from "node:crypto";
import type { Capability, OperationAction } from "@odyshell/protocol";
import { MemoryDatabase } from "./memory-database.js";

const readFunction = makeFunctionReference<"query">("store:read");
const writeFunction = makeFunctionReference<"mutation">("store:write");

type Timestamped = {
  createdAt: number;
  updatedAt?: number;
};

export type MachineRecord = {
  id: string;
  name: string;
  publicKey: string;
  status: string;
  runtime?: unknown;
  lastSeenAt?: number;
  enrolledAt: number;
  revokedAt?: number;
};

export type AgentTokenRecord = Timestamped & {
  id: string;
  name: string;
  tokenHash: string;
  machineIds: string[];
  capabilities: Capability[];
  expiresAt: number;
  revokedAt?: number;
};

export type SessionRecord = Timestamped & {
  id: string;
  machineId: string;
  machineName?: string;
  principalId: string;
  profile: string;
  capabilities: Capability[];
  status: string;
  expiresAt: number;
  error?: string;
};

export type OperationRecord = Timestamped & {
  id: string;
  sessionId: string;
  principalId: string;
  action: OperationAction;
  status: string;
  timeoutSeconds: number;
  maxOutputBytes: number;
  exitCode?: number;
  error?: string;
  outputTruncated: boolean;
  idempotencyKey?: string;
};

export type OperationEventRecord = {
  operationId: string;
  sequence: number;
  stream: string;
  dataBase64: string;
  createdAt: number;
};

export type AuditRecord = {
  id: string;
  principalId: string;
  action: string;
  targetType: string;
  targetId: string;
  metadata: Record<string, unknown>;
  createdAt: number;
};

type RpcInput = Record<string, unknown>;

export class ConvexDatabase {
  private readonly client: ConvexHttpClient;

  constructor(
    convexUrl: string,
    private readonly serviceKey: string,
  ) {
    this.client = new ConvexHttpClient(convexUrl);
  }

  private async read<T>(operation: string, input: RpcInput = {}): Promise<T> {
    return (await this.client.query(readFunction, {
      serviceKey: this.serviceKey,
      operation,
      input,
    })) as T;
  }

  private async write<T>(operation: string, input: RpcInput = {}): Promise<T> {
    return (await this.client.mutation(writeFunction, {
      serviceKey: this.serviceKey,
      operation,
      input,
    })) as T;
  }

  async initialize(): Promise<void> {
    await this.write("initialize");
  }

  async health(): Promise<void> {
    await this.read("health");
  }

  async findAgentByTokenHash(tokenHash: string): Promise<AgentTokenRecord | null> {
    return await this.read("agentByTokenHash", { tokenHash });
  }

  async createEnrollmentToken(tokenHash: string, expiresAt: number): Promise<void> {
    await this.write("createEnrollmentToken", { tokenHash, expiresAt });
  }

  async listAgentTokens(): Promise<AgentTokenRecord[]> {
    return await this.read("listAgentTokens");
  }

  async listMachines(options: {
    includeRevoked?: boolean;
    machineIds?: string[];
  } = {}): Promise<MachineRecord[]> {
    return await this.read("listMachines", options);
  }

  async activeMachinesExist(machineIds: string[]): Promise<boolean> {
    return await this.read("activeMachinesExist", { machineIds });
  }

  async createAgentToken(input: {
    id: string;
    name: string;
    tokenHash: string;
    machineIds: string[];
    capabilities: Capability[];
    expiresAt: number;
  }): Promise<void> {
    await this.write("createAgentToken", input);
  }

  async revokeAgentToken(tokenId: string): Promise<AgentTokenRecord | null> {
    return await this.write("revokeAgentToken", { tokenId });
  }

  async expireAgentSessions(
    principalId: string,
  ): Promise<Array<{ id: string; machineId: string }>> {
    return await this.write("expireAgentSessions", { principalId });
  }

  async enrollMachine(input: {
    tokenHash: string;
    machineId: string;
    name: string;
    publicKey: string;
  }): Promise<{ machineId: string; name: string } | null> {
    return await this.write("enrollMachine", input);
  }

  async machinePublicKey(machineId: string): Promise<string | null> {
    return await this.read("machinePublicKey", { machineId });
  }

  async setMachineOffline(machineId: string): Promise<void> {
    await this.write("machineOffline", { machineId });
  }

  async setMachineOnline(machineId: string, runtime?: unknown): Promise<boolean> {
    return await this.write("machineOnline", { machineId, runtime });
  }

  async heartbeat(machineId: string): Promise<void> {
    await this.write("heartbeat", { machineId });
  }

  async revokeMachine(machineId: string): Promise<{
    id: string;
    name: string;
    revokedAt: number;
    operationIds: string[];
    sessionIds: string[];
  } | null> {
    return await this.write("revokeMachine", { machineId });
  }

  async listSessions(principalId: string): Promise<SessionRecord[]> {
    return await this.read("listSessions", { principalId });
  }

  async createSession(input: {
    id: string;
    machineId: string;
    principalId: string;
    profile: string;
    capabilities: Capability[];
    expiresAt: number;
  }): Promise<void> {
    await this.write("createSession", input);
  }

  async getSession(sessionId: string, principalId: string): Promise<SessionRecord | null> {
    return await this.read("session", { sessionId, principalId });
  }

  async getActiveSession(
    sessionId: string,
    principalId: string,
  ): Promise<SessionRecord | null> {
    return await this.read("activeSession", { sessionId, principalId });
  }

  async markSessionClosing(sessionId: string): Promise<void> {
    await this.write("markSessionClosing", { sessionId });
  }

  async markSessionOpened(sessionId: string): Promise<{ principalId: string } | null> {
    return await this.write("sessionOpened", { sessionId });
  }

  async markSessionOpenFailed(
    sessionId: string,
    error: string,
  ): Promise<{ principalId: string } | null> {
    return await this.write("sessionOpenFailed", { sessionId, error });
  }

  async markSessionClosed(
    sessionId: string,
  ): Promise<{ principalId: string; status: string } | null> {
    return await this.write("sessionClosed", { sessionId });
  }

  async findOperationByIdempotency(
    principalId: string,
    idempotencyKey: string,
  ): Promise<Pick<OperationRecord, "id" | "status"> | null> {
    return await this.read("operationByIdempotency", { principalId, idempotencyKey });
  }

  async sessionForOperation(
    sessionId: string,
    principalId: string,
  ): Promise<SessionRecord | null> {
    return await this.read("sessionForOperation", { sessionId, principalId });
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
    await this.write("createOperation", input);
  }

  async markOperationDelivered(operationId: string): Promise<void> {
    await this.write("markOperationDelivered", { operationId });
  }

  async markOperationStarted(operationId: string): Promise<void> {
    await this.write("operationStarted", { operationId });
  }

  async addOperationEvent(input: {
    operationId: string;
    sequence: number;
    stream: string;
    dataBase64: string;
  }): Promise<void> {
    await this.write("operationEvent", input);
  }

  async markOperationCompleted(input: {
    operationId: string;
    status: string;
    exitCode: number | null;
    error?: string;
    outputTruncated: boolean;
  }): Promise<{ principalId: string } | null> {
    return await this.write("operationCompleted", input);
  }

  async getOperation(
    operationId: string,
    principalId: string,
  ): Promise<(OperationRecord & { events: OperationEventRecord[] }) | null> {
    return await this.read("operation", { operationId, principalId });
  }

  async getOperationTarget(
    operationId: string,
    principalId: string,
  ): Promise<{ machineId: string; status: string } | null> {
    return await this.read("operationTarget", { operationId, principalId });
  }

  async operationExists(operationId: string, principalId: string): Promise<boolean> {
    return await this.read("operationExists", { operationId, principalId });
  }

  async listOperationEvents(
    operationId: string,
    afterSequence: number,
  ): Promise<OperationEventRecord[]> {
    return await this.read("operationEvents", { operationId, afterSequence });
  }

  async operationStatus(operationId: string): Promise<string | null> {
    return await this.read("operationStatus", { operationId });
  }

  async listAudit(limit: number, principalId?: string): Promise<AuditRecord[]> {
    return await this.read("audit", { limit, principalId });
  }

  async audit(
    principalId: string,
    action: string,
    targetType: string,
    targetId: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await this.write("audit", {
      id: randomUUID(),
      principalId,
      action,
      targetType,
      targetId,
      metadata,
    });
  }

  async expireSessions(): Promise<Array<{ id: string; machineId: string }>> {
    return await this.write("expireSessions");
  }
}

export type Database = Pick<ConvexDatabase, keyof ConvexDatabase>;

export function createDatabase(environment: NodeJS.ProcessEnv): Database {
  if (environment.ODYSHELL_STORAGE === "memory") {
    if (environment.NODE_ENV === "production") {
      throw new Error("ODYSHELL_STORAGE=memory is forbidden in production");
    }
    return new MemoryDatabase();
  }
  const convexUrl = environment.CONVEX_URL;
  const serviceKey = environment.ODYSHELL_CONVEX_SERVICE_KEY;
  if (!convexUrl) throw new Error("CONVEX_URL is required");
  if (!serviceKey) throw new Error("ODYSHELL_CONVEX_SERVICE_KEY is required");
  return new ConvexDatabase(convexUrl, serviceKey);
}

export async function audit(
  db: Database,
  principalId: string,
  action: string,
  targetType: string,
  targetId: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await db.audit(principalId, action, targetType, targetId, metadata);
}
