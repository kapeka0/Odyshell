import { randomUUID } from "node:crypto";
import type {
  Capability,
  ClientRuntimeInfo,
  OperationAction,
  OperationStatus,
  SessionMachineScope,
} from "@odyshell/protocol";
import {
  operationSessionScope,
  sessionScopeDecision,
} from "@odyshell/protocol";
import { ApiError, ExpectedError, ServerConnectionError } from "./errors.js";
import { resolveMachineReference } from "./machines.js";

export type OdyshellConfig = {
  serverUrl: string;
  agentToken?: string;
  cliToken?: string;
  adminKey?: string;
  workspaceId?: string;
  fetch?: typeof globalThis.fetch;
};

export type OperationOptions = {
  ttlSeconds?: number;
  timeoutSeconds?: number;
  maxOutputBytes?: number;
  idempotencyKey?: string;
  onEvent?: (event: OperationEvent) => void;
};

export type OperationResult = {
  operation: Operation;
  stdout: string;
  stderr: string;
  result: unknown;
  resultText: string;
};

type MachineOperation = OperationOptions & {
  machine: string;
};

export type ProcessExecInput = MachineOperation & {
  program: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
};

export type ProcessShellInput = MachineOperation & {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
};

export type FilesystemPathInput = MachineOperation & {
  path: string;
};

export type FilesystemListInput = MachineOperation & {
  path?: string;
};

export type FilesystemSearchInput = MachineOperation & {
  path?: string;
  query: string;
  maxResults?: number;
};

export type FilesystemWriteInput = FilesystemPathInput & {
  content: string | Uint8Array;
  createParents?: boolean;
};

export type FilesystemMkdirInput = FilesystemPathInput & {
  recursive?: boolean;
};

export type FilesystemRemoveInput = FilesystemPathInput & {
  recursive?: boolean;
};

export type DockerLogsInput = MachineOperation & {
  container: string;
  tail?: number;
  timestamps?: boolean;
};

export type Machine = {
  id: string;
  name: string;
  status: string;
  online: boolean;
  compatible: boolean;
  upgradeRequired: boolean;
  clientVersion: string | null;
  protocolVersion: number | null;
  runtime?: ClientRuntimeInfo | null;
  lastSeenAt: string | null;
  enrolledAt: string;
};

export type AdminMachine = Machine & {
  revokedAt: string | null;
};

export type Organization = {
  id: string;
  slug: string;
  name: string;
  createdAt: string;
};

export type Workspace = {
  id: string;
  organizationId: string;
  slug: string;
  name: string;
  createdAt: string;
};

export type Session = {
  id: string;
  machineId: string;
  machineName?: string;
  profile: string;
  capabilities: Capability[];
  status: string;
  expiresAt: string;
  error?: string | null;
  createdAt: string;
};

export type OperationEvent = {
  sequence: number;
  stream: "stdout" | "stderr" | "result";
  dataBase64: string;
  createdAt?: string;
};

export type Operation = {
  id: string;
  sessionId: string;
  action: OperationAction;
  status: OperationStatus;
  exitCode: number | null;
  error?: string | null;
  outputTruncated: boolean;
  events: OperationEvent[];
  createdAt: string;
  updatedAt: string;
};

export type AgentToken = {
  id: string;
  name: string;
  token: string;
  machineIds: string[];
  capabilities: Capability[];
  expiresAt: string;
};

export type AgentAccess = {
  id: string;
  name: string;
  machineIds: string[];
  capabilities: Capability[];
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
  status: "active" | "expired" | "revoked";
};

export type ListedAgent = {
  id: string;
  name: string;
  kind: "independent" | "managed";
  status: "active" | "disabled";
  parentAgentId: string | null;
};

export type AuditEvent = {
  id: string;
  principalId: string;
  action: string;
  targetType: string;
  targetId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type DeviceAuthorization = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
};

export type DeviceToken = {
  accessToken: string;
  tokenType: "Bearer";
  workspaceId: string;
  expiresAt: string;
};

export type AgentDeviceToken = DeviceToken & {
  agentId: string;
  agentName: string;
  credentialId: string;
};

export type AgentSessionRequestInput = {
  agentId: string;
  agentName: string;
  purpose: string;
  scopes: SessionMachineScope[];
  durationSeconds: number;
  runId?: string;
};

export type AgentSessionRequest = {
  id: string;
  status: "pending" | "approved";
  approvalUrl?: string;
  autoapprovalPolicy?: { id: string; version: number };
  expiresAt: string;
  scopes: Array<{
    machineId: string;
    readiness: { ready: true } | { ready: false; reason: string };
  }>;
};

export type AgentPolicy = {
  id: string;
  agentId: string;
  version: number;
  kind: "autoapproval" | "delegation" | "managed";
  status: "proposed" | "active" | "paused" | "revoked" | "replaced";
  scopes: SessionMachineScope[];
  maxSessionSeconds: number;
  maxManagedAgents?: number;
  expiresAt: string;
  approvalUrl?: string;
  approvedAt?: string;
  approvedByHumanId?: string;
  predecessorPolicyId?: string;
  createdAt: string;
  updatedAt: string;
};

export type ManagedAgent = {
  id: string;
  name: string;
  kind: "managed";
  parentAgentId: string;
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
  policy?: AgentPolicy;
};

export type AgentSessionRequestStatus = {
  id: string;
  status: "pending" | "approved" | "denied" | "expired" | "claimed";
  expiresAt: string;
  sessionId?: string;
};

export type ClaimedAgentSession = {
  sessionId: string;
  sessionToken: string;
  scopes: SessionMachineScope[];
  status: "opening";
  expiresAt: string;
};

export type ListedAgentSession = {
  id: string;
  agentId: string;
  agentName: string;
  purpose: string;
  status: "active" | "completed" | "cancelled" | "revoked" | "expired";
  expiresAt: string;
  predecessorSessionId?: string;
  runId?: string;
  scopes: SessionMachineScope[];
  targets: Array<{
    machineId: string;
    machineName: string;
    status: string;
  }>;
  createdAt: string;
  updatedAt: string;
};

export type SessionTimelineEvent = {
  id: string;
  sessionId?: string;
  requestId: string;
  operationId?: string;
  eventType: string;
  source: "verified" | "agent";
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type TimelineExport = {
  version: "2026-07-31";
  sessionId: string;
  exportedAt: string;
  events: Array<Record<string, unknown>>;
};

export type EventSink = {
  id: string;
  endpoint: string;
  detailLevel: "privacy-minimal" | "operational" | "diagnostic";
  signingSecret: string;
  status: "active" | "paused";
  createdAt: string;
  updatedAt: string;
};

export type AgentIdentity = {
  id: string;
  name: string;
};

export type OperationSessionRequestInput = {
  machineId: string;
  purpose: string;
  action: OperationAction;
  durationSeconds: number;
  profile?: string;
  runId?: string;
};

export class HumanClient {
  constructor(private readonly ods: Odyshell) {}

  machines(): Promise<Machine[]> {
    return this.ods.machines();
  }

  sessions(): Promise<ListedAgentSession[]> {
    return this.ods.agentSessions();
  }
}

export class AgentClient {
  constructor(
    private readonly ods: Odyshell,
    readonly identity: AgentIdentity,
  ) {}

  requestSession(input: Omit<AgentSessionRequestInput, "agentId" | "agentName">) {
    return this.ods.requestAgentSession({
      ...input,
      agentId: this.identity.id,
      agentName: this.identity.name,
    });
  }

  requestOperationSession(input: OperationSessionRequestInput) {
    if (input.action.kind === "process.shell") {
      throw new ExpectedError(
        "process.shell cannot be safely scoped. Use process.exec with an explicit program and arguments.",
        "process_shell_unsupported",
      );
    }
    return this.requestSession({
      purpose: input.purpose,
      scopes: [
        operationSessionScope(
          input.machineId,
          input.action,
          input.profile ?? "workspace",
        ),
      ],
      durationSeconds: input.durationSeconds,
      ...(input.runId ? { runId: input.runId } : {}),
    });
  }

  status(requestId: string) {
    return this.ods.agentSessionRequestStatus(requestId, this.identity.id);
  }

  claim(requestId: string) {
    return this.ods.claimAgentSession(requestId, this.identity.id);
  }

  cancel(sessionId: string) {
    return this.ods.cancelAgentSession(sessionId, this.identity.id);
  }

  complete(
    sessionId: string,
    outcome: "succeeded" | "failed",
    summary?: string,
  ) {
    return this.ods.completeAgentSession(
      sessionId,
      this.identity.id,
      outcome,
      summary,
    );
  }

  timeline(sessionId: string) {
    return this.ods.sessionTimeline(sessionId, this.identity.id);
  }

  exportTimeline(
    sessionId: string,
    detailLevel: EventSink["detailLevel"] = "privacy-minimal",
  ) {
    return this.ods.exportSessionTimeline(
      sessionId,
      this.identity.id,
      detailLevel,
    );
  }
}

export class SessionClient {
  private readonly scoped: Odyshell;

  constructor(
    serverUrl: string,
    readonly claim: ClaimedAgentSession,
    fetcher: typeof globalThis.fetch,
  ) {
    this.scoped = new Odyshell({
      serverUrl,
      agentToken: claim.sessionToken,
      fetch: fetcher,
    });
  }

  async execute(
    machineId: string,
    action: OperationAction,
    options: Pick<
      OperationOptions,
      "timeoutSeconds" | "maxOutputBytes" | "idempotencyKey" | "onEvent"
    > = {},
  ): Promise<OperationResult> {
    const scope = this.claim.scopes.find(
      (candidate) => candidate.machineId === machineId,
    );
    if (!scope) {
      throw new ExpectedError(
        "The machine is outside this Session.",
        "machine_scope_denied",
      );
    }
    const decision = sessionScopeDecision(scope, machineId, action);
    if (!decision.allowed) {
      throw new ExpectedError(
        "The operation is outside this Session.",
        decision.code,
      );
    }
    await this.scoped.waitForSession(this.claim.sessionId);
    const operation = await this.scoped.createOperation(
      this.claim.sessionId,
      action,
      options.timeoutSeconds ?? 120,
      options.maxOutputBytes ?? 1024 * 1024,
      machineId,
      options.idempotencyKey,
    );
    return decodeOperation(
      await this.scoped.waitForOperation(operation.id, options.onEvent),
    );
  }
}

export class Odyshell {
  private readonly fetcher: typeof globalThis.fetch;

  readonly process = {
    exec: (input: ProcessExecInput): Promise<OperationResult> =>
      this.execute(
        input.machine,
        "process.exec",
        {
          kind: "process.exec",
          program: input.program,
          args: input.args ?? [],
          cwd: input.cwd ?? ".",
          env: input.env ?? {},
        },
        input,
      ),
    shell: (input: ProcessShellInput): Promise<OperationResult> =>
      this.execute(
        input.machine,
        "process.shell",
        {
          kind: "process.shell",
          command: input.command,
          cwd: input.cwd ?? ".",
          env: input.env ?? {},
        },
        input,
      ),
  };

  readonly fs = {
    stat: (input: FilesystemPathInput): Promise<OperationResult> =>
      this.execute(input.machine, "fs.stat", { kind: "fs.stat", path: input.path }, input),
    list: (input: FilesystemListInput): Promise<OperationResult> =>
      this.execute(
        input.machine,
        "fs.list",
        { kind: "fs.list", path: input.path ?? "." },
        input,
      ),
    search: (input: FilesystemSearchInput): Promise<OperationResult> =>
      this.execute(
        input.machine,
        "fs.search",
        {
          kind: "fs.search",
          path: input.path ?? ".",
          query: input.query,
          maxResults: input.maxResults ?? 100,
        },
        input,
      ),
    read: (input: FilesystemPathInput): Promise<OperationResult> =>
      this.execute(input.machine, "fs.read", { kind: "fs.read", path: input.path }, input),
    write: (input: FilesystemWriteInput): Promise<OperationResult> =>
      this.execute(
        input.machine,
        "fs.write",
        {
          kind: "fs.write",
          path: input.path,
          contentBase64: Buffer.from(input.content).toString("base64"),
          createParents: input.createParents ?? false,
        },
        input,
      ),
    mkdir: (input: FilesystemMkdirInput): Promise<OperationResult> =>
      this.execute(
        input.machine,
        "fs.mkdir",
        {
          kind: "fs.mkdir",
          path: input.path,
          recursive: input.recursive ?? true,
        },
        input,
      ),
    remove: (input: FilesystemRemoveInput): Promise<OperationResult> =>
      this.execute(
        input.machine,
        "fs.remove",
        {
          kind: "fs.remove",
          path: input.path,
          recursive: input.recursive ?? false,
        },
        input,
      ),
  };

  readonly docker = {
    logs: (input: DockerLogsInput): Promise<OperationResult> =>
      this.execute(
        input.machine,
        "docker.logs",
        {
          kind: "docker.logs",
          container: input.container,
          tail: input.tail ?? 200,
          timestamps: input.timestamps ?? false,
        },
        input,
      ),
  };

  constructor(private readonly config: OdyshellConfig) {
    this.fetcher = config.fetch ?? globalThis.fetch;
  }

  get serverUrl(): string {
    return this.config.serverUrl;
  }

  human(): HumanClient {
    if (!this.config.cliToken && !this.config.adminKey) {
      throw new ExpectedError(
        "Human context requires a signed-in CLI credential.",
        "human_credentials_missing",
      );
    }
    return new HumanClient(this);
  }

  agent(identity: AgentIdentity): AgentClient {
    if (!this.config.agentToken && !this.config.cliToken) {
      throw new ExpectedError(
        "Agent context requires an Agent Credential or signed-in CLI credential.",
        "agent_credentials_missing",
      );
    }
    return new AgentClient(this, identity);
  }

  claimedSession(claim: ClaimedAgentSession): SessionClient {
    return new SessionClient(this.config.serverUrl, claim, this.fetcher);
  }

  async health(): Promise<{ status: string; protocol: number }> {
    return this.request("/health", { authenticated: false });
  }

  async startDeviceAuthorization(clientName = "Odyshell CLI"): Promise<DeviceAuthorization> {
    return this.request("/v1/auth/device", {
      method: "POST",
      authenticated: false,
      body: { clientName },
    });
  }

  async exchangeDeviceAuthorization(deviceCode: string): Promise<DeviceToken> {
    return this.request("/v1/auth/device/token", {
      method: "POST",
      authenticated: false,
      body: { deviceCode },
    });
  }

  async startAgentDeviceAuthorization(
    agentName: string,
  ): Promise<DeviceAuthorization> {
    return this.request("/v1/auth/agent/device", {
      method: "POST",
      authenticated: false,
      body: { agentName },
    });
  }

  async exchangeAgentDeviceAuthorization(
    deviceCode: string,
  ): Promise<AgentDeviceToken> {
    return this.request("/v1/auth/agent/device/token", {
      method: "POST",
      authenticated: false,
      body: { deviceCode },
    });
  }

  async rotateAgentCredential(): Promise<
    AgentDeviceToken & { overlapSeconds: number }
  > {
    if (!this.config.agentToken) {
      throw new ExpectedError(
        "No Agent Credential configured.",
        "credentials_missing",
      );
    }
    return this.request("/v1/agent-credentials/rotate", {
      method: "POST",
      credential: this.config.agentToken,
    });
  }

  async revokeAgentCredential(): Promise<{
    revoked: true;
    disabledManagedAgents: number;
    terminatedSessions: number;
  }> {
    return this.request("/v1/agent-credentials/revoke", {
      method: "POST",
      credential: this.agentCredential(),
    });
  }

  async proposeAgentPolicy(input: {
    kind?: "autoapproval" | "delegation";
    scopes: SessionMachineScope[];
    maxSessionSeconds: number;
    maxManagedAgents?: number;
    validForSeconds: number;
  }): Promise<AgentPolicy> {
    return this.request("/v1/agent-policies", {
      method: "POST",
      credential: this.agentCredential(),
      body: input,
    });
  }

  async agentPolicies(): Promise<AgentPolicy[]> {
    const response = await this.request<{ data: AgentPolicy[] }>(
      "/v1/agent-policies",
      { credential: this.agentCredential() },
    );
    return response.data;
  }

  async pauseAgentPolicy(policyId: string): Promise<AgentPolicy> {
    return this.request(
      `/v1/agent-policies/${encodeURIComponent(policyId)}/pause`,
      { method: "POST", credential: this.agentCredential() },
    );
  }

  async revokeAgentPolicy(policyId: string): Promise<AgentPolicy> {
    return this.request(
      `/v1/agent-policies/${encodeURIComponent(policyId)}/revoke`,
      { method: "POST", credential: this.agentCredential() },
    );
  }

  async createManagedAgent(input: {
    name: string;
    scopes: SessionMachineScope[];
    maxSessionSeconds: number;
    validForSeconds: number;
  }): Promise<ManagedAgent> {
    return this.request("/v1/managed-agents", {
      method: "POST",
      credential: this.agentCredential(),
      body: input,
    });
  }

  async managedAgents(): Promise<ManagedAgent[]> {
    const response = await this.request<{ data: ManagedAgent[] }>(
      "/v1/managed-agents",
      { credential: this.agentCredential() },
    );
    return response.data;
  }

  async disableManagedAgent(
    agentId: string,
  ): Promise<{ id: string; status: "disabled"; terminatedSessions: number }> {
    return this.request(
      `/v1/managed-agents/${encodeURIComponent(agentId)}/disable`,
      { method: "POST", credential: this.agentCredential() },
    );
  }

  async deleteManagedAgent(
    agentId: string,
  ): Promise<{
    id: string;
    status: "disabled";
    deleted: true;
    terminatedSessions: number;
  }> {
    return this.request(
      `/v1/managed-agents/${encodeURIComponent(agentId)}`,
      { method: "DELETE", credential: this.agentCredential() },
    );
  }

  async logoutCli(): Promise<{ revoked: true }> {
    if (!this.config.cliToken) {
      throw new ExpectedError(
        "No CLI token configured.",
        "credentials_missing",
      );
    }
    return this.request("/v1/auth/logout", {
      method: "POST",
      credential: this.config.cliToken,
    });
  }

  async machines(): Promise<Machine[]> {
    const response = await this.request<{ data: Machine[] }>("/v1/machines");
    return response.data;
  }

  async requestAgentSession(
    input: AgentSessionRequestInput,
  ): Promise<AgentSessionRequest> {
    return this.request("/v1/agent-session-requests", {
      method: "POST",
      body: input,
    });
  }

  async agentSessionRequestStatus(
    requestId: string,
    agentId: string,
  ): Promise<AgentSessionRequestStatus> {
    return this.request(
      `/v1/agent-session-requests/${encodeURIComponent(requestId)}/status`,
      {
        method: "POST",
        body: { agentId },
      },
    );
  }

  async claimAgentSession(
    requestId: string,
    agentId: string,
  ): Promise<ClaimedAgentSession> {
    return this.request(
      `/v1/agent-session-requests/${encodeURIComponent(requestId)}/claim`,
      {
        method: "POST",
        body: { agentId },
      },
    );
  }

  async sessionTimeline(
    sessionId: string,
    agentId: string,
  ): Promise<SessionTimelineEvent[]> {
    const response = await this.request<{ data: SessionTimelineEvent[] }>(
      `/v1/agent-sessions/${encodeURIComponent(sessionId)}/timeline`,
      {
        method: "POST",
        body: { agentId },
      },
    );
    return response.data;
  }

  async agentSessions(): Promise<ListedAgentSession[]> {
    const response = await this.request<{ data: ListedAgentSession[] }>(
      "/v1/agent-sessions",
    );
    return response.data;
  }

  async exportSessionTimeline(
    sessionId: string,
    agentId: string,
    detailLevel: EventSink["detailLevel"] = "privacy-minimal",
  ): Promise<TimelineExport> {
    return this.request(
      `/v1/agent-sessions/${encodeURIComponent(sessionId)}/timeline/export`,
      {
        method: "POST",
        body: { agentId, detailLevel },
      },
    );
  }

  async cancelAgentSession(
    sessionId: string,
    agentId: string,
  ): Promise<{
    id: string;
    status: "cancelled" | "revoked" | "completed" | "expired";
    transitioned: boolean;
  }> {
    return this.request(
      `/v1/agent-sessions/${encodeURIComponent(sessionId)}/cancel`,
      {
        method: "POST",
        body: { agentId },
      },
    );
  }

  async completeAgentSession(
    sessionId: string,
    agentId: string,
    outcome: "succeeded" | "failed",
    summary?: string,
  ): Promise<{
    id: string;
    status: "completed";
    transitioned: boolean;
  }> {
    return this.request(
      `/v1/agent-sessions/${encodeURIComponent(sessionId)}/complete`,
      {
        method: "POST",
        body: { agentId, outcome, ...(summary ? { summary } : {}) },
      },
    );
  }

  async renewAgentSession(
    sessionId: string,
    agentId: string,
    durationSeconds?: number,
  ): Promise<
    AgentSessionRequest & { predecessorSessionId: string }
  > {
    return this.request(
      `/v1/agent-sessions/${encodeURIComponent(sessionId)}/renew`,
      {
        method: "POST",
        body: {
          agentId,
          ...(durationSeconds === undefined ? {} : { durationSeconds }),
        },
      },
    );
  }

  async readApprovedSession(
    claim: ClaimedAgentSession,
    options: Pick<OperationOptions, "timeoutSeconds" | "maxOutputBytes" | "onEvent"> = {},
  ): Promise<OperationResult> {
    const approvedScope = claim.scopes.find(
      (scope) =>
        scope.capabilities.includes("fs.read") &&
        scope.restrictions.filesystem?.paths.length === 1,
    );
    const approvedPath = approvedScope?.restrictions.filesystem?.paths[0];
    if (!approvedScope || !approvedPath || approvedPath.includeDescendants) {
      throw new ExpectedError(
        "The Session does not contain one exact file read scope.",
        "path_scope_denied",
      );
    }
    try {
      return await this.claimedSession(claim).execute(
        approvedScope.machineId,
        { kind: "fs.read", path: approvedPath.path },
        options,
      );
    } finally {
      const scoped = new Odyshell({
        serverUrl: this.config.serverUrl,
        agentToken: claim.sessionToken,
        fetch: this.fetcher,
      });
      await scoped.closeSession(claim.sessionId).catch(() => undefined);
    }
  }

  async adminMachines(): Promise<AdminMachine[]> {
    const response = await this.request<{ data: AdminMachine[] }>("/v1/admin/machines", {
      admin: true,
    });
    return response.data;
  }

  async eventSink(): Promise<EventSink | null> {
    const response = await this.request<{ data: EventSink | null }>(
      "/v1/admin/event-sink",
      { admin: true },
    );
    return response.data;
  }

  async configureEventSink(input: {
    endpoint: string;
    detailLevel: EventSink["detailLevel"];
    signingSecret: string;
  }): Promise<EventSink> {
    const response = await this.request<{ data: EventSink }>(
      "/v1/admin/event-sink",
      { method: "PUT", admin: true, body: input },
    );
    return response.data;
  }

  async deleteEventSink(): Promise<{ deleted: true }> {
    return this.request("/v1/admin/event-sink", {
      method: "DELETE",
      admin: true,
    });
  }

  async exportWorkspaceSessionTimeline(
    sessionId: string,
    detailLevel: EventSink["detailLevel"] = "privacy-minimal",
  ): Promise<TimelineExport> {
    return this.request(
      `/v1/admin/sessions/${encodeURIComponent(sessionId)}/timeline/export?detailLevel=${encodeURIComponent(detailLevel)}`,
      { admin: true },
    );
  }

  async organizations(): Promise<Organization[]> {
    const response = await this.request<{ data: Organization[] }>(
      "/v1/admin/organizations",
      { admin: true },
    );
    return response.data;
  }

  async createOrganization(slug: string, name: string): Promise<Organization> {
    return this.request("/v1/admin/organizations", {
      method: "POST",
      admin: true,
      body: { slug, name },
    });
  }

  async workspaces(organizationId?: string): Promise<Workspace[]> {
    const path =
      organizationId === undefined
        ? "/v1/admin/workspaces"
        : `/v1/admin/organizations/${encodeURIComponent(organizationId)}/workspaces`;
    const response = await this.request<{ data: Workspace[] }>(path, { admin: true });
    return response.data;
  }

  async createWorkspace(
    organizationId: string,
    slug: string,
    name: string,
  ): Promise<Workspace> {
    return this.request(
      `/v1/admin/organizations/${encodeURIComponent(organizationId)}/workspaces`,
      {
        method: "POST",
        admin: true,
        body: { slug, name },
      },
    );
  }

  async ping(machineId: string): Promise<{ reply: "pong"; machineId: string; latencyMs: number }> {
    return this.request(`/v1/machines/${machineId}/ping`, { method: "POST" });
  }

  async resolveMachine(reference: string): Promise<Machine> {
    return resolveMachineReference(await this.machines(), reference, { requireOnline: true });
  }

  async resolveAdminMachineIds(references: string[]): Promise<string[]> {
    const machines = await this.adminMachines();
    return [
      ...new Set(
        references.map((reference) => resolveMachineReference(machines, reference).id),
      ),
    ];
  }

  async revokeMachine(machineId: string): Promise<{
    id: string;
    name: string;
    status: "revoked";
    revokedAt: string;
    cancelledOperations: number;
    closedSessions: number;
    disconnected: boolean;
  }> {
    return this.request(`/v1/admin/machines/${machineId}`, {
      method: "DELETE",
      admin: true,
    });
  }

  async sessions(): Promise<Session[]> {
    const response = await this.request<{ data: Session[] }>("/v1/sessions");
    return response.data;
  }

  async createSession(
    machineId: string,
    capabilities: Capability[],
    ttlSeconds: number,
  ): Promise<Session> {
    return this.request("/v1/sessions", {
      method: "POST",
      body: { machineId, profile: "workspace", ttlSeconds, capabilities },
    });
  }

  async session(sessionId: string): Promise<Session> {
    return this.request(`/v1/sessions/${sessionId}`);
  }

  async closeSession(sessionId: string): Promise<{ id: string; status: string }> {
    return this.request(`/v1/sessions/${sessionId}`, { method: "DELETE" });
  }

  async waitForSession(sessionId: string): Promise<Session> {
    for (;;) {
      const session = await this.session(sessionId);
      if (session.status === "ready") return session;
      if (["failed", "closed", "expired"].includes(session.status)) {
        throw new ExpectedError(
          `Session ${session.status}: ${session.error ?? "no additional details"}`,
          `session_${session.status}`,
        );
      }
      await delay(200);
    }
  }

  async createOperation(
    sessionId: string,
    action: OperationAction,
    timeoutSeconds = 120,
    maxOutputBytes = 1024 * 1024,
    machineId?: string,
    idempotencyKey: string = randomUUID(),
  ): Promise<{ id: string; status: string }> {
    return this.request(`/v1/sessions/${sessionId}/operations`, {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: {
        action,
        timeoutSeconds,
        maxOutputBytes,
        ...(machineId === undefined ? {} : { machineId }),
      },
    });
  }

  async operation(operationId: string): Promise<Operation> {
    return this.request(`/v1/operations/${operationId}`);
  }

  async cancelOperation(operationId: string): Promise<{ id: string; status: string }> {
    return this.request(`/v1/operations/${operationId}/cancel`, { method: "POST" });
  }

  async waitForOperation(
    operationId: string,
    onEvent?: (event: OperationEvent) => void,
  ): Promise<Operation> {
    let lastSequence = -1;
    for (;;) {
      const operation = await this.operation(operationId);
      for (const event of operation.events) {
        if (event.sequence <= lastSequence) continue;
        lastSequence = event.sequence;
        onEvent?.(event);
      }
      if (!["queued", "delivered", "running"].includes(operation.status)) return operation;
      await delay(150);
    }
  }

  async execute(
    machineReference: string,
    capability: Capability,
    action: OperationAction,
    options: OperationOptions = {},
  ): Promise<OperationResult> {
    const machine = await this.resolveMachine(machineReference);
    const created = await this.createSession(
      machine.id,
      [capability],
      options.ttlSeconds ?? 600,
    );
    const session = await this.waitForSession(created.id);
    try {
      const operation = await this.createOperation(
        session.id,
        action,
        options.timeoutSeconds ?? 120,
        options.maxOutputBytes ?? 1024 * 1024,
      );
      return decodeOperation(
        await this.waitForOperation(operation.id, options.onEvent),
      );
    } finally {
      await this.closeSession(session.id).catch(() => undefined);
    }
  }

  async createEnrollmentToken(ttlSeconds: number): Promise<{ token: string; expiresAt: string }> {
    return this.request("/v1/admin/enrollment-tokens", {
      method: "POST",
      admin: true,
      body: { expiresInSeconds: ttlSeconds },
    });
  }

  async createAgentToken(
    name: string,
    machineIds: string[],
    capabilities: Capability[],
    expiresInSeconds: number,
  ): Promise<AgentToken> {
    return this.request("/v1/admin/agent-tokens", {
      method: "POST",
      admin: true,
      body: { name, machineIds, capabilities, expiresInSeconds },
    });
  }

  async agents(): Promise<ListedAgent[]> {
    const response = await this.request<{ data: ListedAgent[] }>("/v1/admin/agents", {
      admin: true,
    });
    return response.data;
  }

  async revokeAgent(tokenId: string): Promise<{
    id: string;
    name: string;
    status: "revoked";
    revokedAt: string;
    closedSessions: number;
  }> {
    return this.request(`/v1/admin/agent-tokens/${tokenId}`, {
      method: "DELETE",
      admin: true,
    });
  }

  async audit(limit: number, allAgents = false): Promise<{
    principal: { id: string; name: string };
    data: AuditEvent[];
  }> {
    return this.request(
      `${allAgents ? "/v1/admin/audit" : "/v1/audit"}?limit=${encodeURIComponent(String(limit))}`,
      allAgents ? { admin: true } : {},
    );
  }

  private agentCredential(): string {
    if (!this.config.agentToken) {
      throw new ExpectedError(
        "No Agent Credential configured.",
        "credentials_missing",
      );
    }
    return this.config.agentToken;
  }

  private async request<T>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
      admin?: boolean;
      authenticated?: boolean;
      credential?: string;
    } = {},
  ): Promise<T> {
    const authenticated = options.authenticated ?? true;
    const credential =
      options.credential ??
      (options.admin
        ? (this.config.adminKey ?? this.config.cliToken)
        : (this.config.agentToken ?? this.config.cliToken));
    if (authenticated && !credential) {
      throw new ExpectedError(
        `No ${options.admin ? "workspace credential" : "agent or CLI token"} configured. Run "ods login" or set the corresponding environment variable.`,
        "credentials_missing",
      );
    }
    let response: Response;
    try {
      response = await this.fetcher(new URL(path, this.config.serverUrl), {
        method: options.method ?? "GET",
        headers: {
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
          ...(authenticated
            ? options.admin && this.config.adminKey
              ? {
                  "x-odyshell-admin-key": credential!,
                  ...(this.config.workspaceId
                    ? { "x-odyshell-workspace-id": this.config.workspaceId }
                    : {}),
                }
              : {
                  authorization: `Bearer ${credential!}`,
                  ...(options.admin && this.config.workspaceId
                    ? { "x-odyshell-workspace-id": this.config.workspaceId }
                    : {}),
                }
            : {}),
          ...options.headers,
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } catch (error) {
      throw new ServerConnectionError(this.config.serverUrl, error);
    }
    const text = await response.text();
    const body = (text ? JSON.parse(text) : {}) as T & { error?: string; details?: unknown };
    if (!response.ok) {
      throw new ApiError(response.status, body.error ?? response.statusText, body.details);
    }
    return body;
  }
}

export { Odyshell as OdyshellApi };

export function decodeOperation(operation: Operation): OperationResult {
  const decoded = { stdout: "", stderr: "", result: "" };
  for (const event of operation.events) {
    decoded[event.stream] += Buffer.from(event.dataBase64, "base64").toString("utf8");
  }
  return {
    operation,
    stdout: decoded.stdout,
    stderr: decoded.stderr,
    result: parseResult(decoded.result),
    resultText: decoded.result,
  };
}

function parseResult(value: string): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
