import { randomUUID } from "node:crypto";
import {
  MAX_AGENT_SESSION_SECONDS,
  type Capability,
  type OperationAction,
  type SessionMachineScope,
  type SessionRestrictions,
} from "@odyshell/protocol";
import {
  CamelCasePlugin,
  Kysely,
  PostgresDialect,
  sql,
  type ColumnType,
  type Generated,
  type Selectable,
} from "kysely";
import {
  Migrator,
  type Migration,
  type MigrationProvider,
} from "kysely/migration";
import pg from "pg";
import {
  deviceApprovalDecision,
  deviceExchangeDecision,
  entitlementsFor,
  type CloudPlanId,
} from "./cloud.js";
import {
  autoapprovalDecision,
  managedDelegationDecision,
} from "./autoapproval.js";
import {
  diagnosticTimelineMetadata,
  operationTimelineMetadata,
} from "./event-sinks.js";

const { Pool } = pg;
export const DEFAULT_ORGANIZATION_ID = "default";
export const DEFAULT_WORKSPACE_ID = "default";
const DATABASE_SCHEMA = "odyshell";
const ACTIVE_SESSION_STATUSES = ["opening", "ready"] as const;
const CLOSABLE_SESSION_STATUSES = ["opening", "ready", "closing"] as const;
const ACTIVE_OPERATION_STATUSES = ["queued", "delivered", "running"] as const;
const RETAINED_SESSION_STATUSES = ["opening", "ready", "closing"] as const;
const SESSION_CLAIM_WINDOW_MILLISECONDS = 5 * 60_000;
const DEADLOCK_RETRY_LIMIT = 3;

export async function withDatabaseDeadlockRetry<T>(
  operation: () => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (
        (error as { code?: string }).code !== "40P01" ||
        attempt >= DEADLOCK_RETRY_LIMIT
      ) {
        throw error;
      }
      await new Promise((resolveRetry) =>
        setTimeout(resolveRetry, attempt * 10),
      );
    }
  }
}

export type AuthorityCutoverInvariant = {
  missingWorkspaces: number;
  activeLegacyTokens: number;
  activeLegacySessions: number;
  activeLegacyOperations: number;
};

export function assertAuthorityCutoverInvariant(
  invariant: AuthorityCutoverInvariant,
): void {
  const failures = Object.entries(invariant).filter(([, count]) => count > 0);
  if (failures.length > 0) {
    throw new Error(
      `Authority cutover is incomplete (${failures
        .map(([name, count]) => `${name}=${count}`)
        .join(", ")})`,
    );
  }
}

type Json<T> = ColumnType<T, string, string>;

interface OrganizationTable {
  id: string;
  slug: string;
  name: string;
  externalId: ColumnType<string | null, string | null | undefined, string | null>;
  plan: Generated<string>;
  createdAt: Generated<Date>;
}

interface WorkspaceTable {
  id: string;
  organizationId: string;
  slug: string;
  name: string;
  createdAt: Generated<Date>;
}

interface MachineTable {
  workspaceId: string;
  id: string;
  name: string;
  publicKey: string;
  status: string;
  runtime: Json<unknown> | null;
  lastSeenAt: Date | null;
  enrolledAt: Generated<Date>;
  revokedAt: Date | null;
}

interface EnrollmentTokenTable {
  workspaceId: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Generated<Date>;
}

interface AgentTokenTable {
  workspaceId: string;
  id: string;
  name: string;
  tokenHash: string;
  machineIds: Json<string[]>;
  capabilities: Json<Capability[]>;
  expiresAt: Date;
  revokedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Generated<Date>;
}

interface CliTokenTable {
  workspaceId: string;
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Generated<Date>;
}

interface DeviceAuthorizationTable {
  id: string;
  deviceCodeHash: string;
  userCodeHash: string;
  clientName: string;
  status: string;
  workspaceId: string | null;
  userId: string | null;
  expiresAt: Date;
  approvedAt: Date | null;
  consumedAt: Date | null;
  createdAt: Generated<Date>;
}

interface AgentDeviceAuthorizationTable {
  id: string;
  deviceCodeHash: string;
  userCodeHash: string;
  agentName: string;
  status: string;
  workspaceId: string | null;
  userId: string | null;
  agentId: string | null;
  expiresAt: Date;
  approvedAt: Date | null;
  consumedAt: Date | null;
  createdAt: Generated<Date>;
}

interface HumanTable {
  workspaceId: string;
  id: string;
  externalId: string;
  status: string;
  createdAt: Generated<Date>;
  updatedAt: Generated<Date>;
}

interface AgentTable {
  workspaceId: string;
  id: string;
  name: string;
  kind: string;
  parentAgentId: string | null;
  createdByHumanId: string | null;
  status: string;
  deletedAt: Date | null;
  createdAt: Generated<Date>;
  updatedAt: Generated<Date>;
}

interface AgentCredentialTable {
  workspaceId: string;
  id: string;
  agentId: string;
  agentKind: Generated<string>;
  tokenHash: string;
  status: string;
  expiresAt: Date;
  retiringAt: Date | null;
  revokedAt: Date | null;
  createdAt: Generated<Date>;
}

interface AgentSessionTable {
  workspaceId: string;
  id: string;
  agentId: string;
  purpose: string;
  status: string;
  expiresAt: Date;
  predecessorSessionId: string | null;
  autoapprovalPolicyId: string | null;
  autoapprovalPolicyVersion: number | null;
  createdAt: Generated<Date>;
  updatedAt: Generated<Date>;
}

interface SessionCredentialTable {
  workspaceId: string;
  id: string;
  sessionId: string;
  tokenHash: string;
  status: string;
  expiresAt: Date;
  claimedAt: Date;
  revokedAt: Date | null;
  createdAt: Generated<Date>;
}

interface McpInstallationTable {
  workspaceId: string;
  id: string;
  provider: string;
  userId: string;
  oauthClientId: string;
  agentId: string;
  status: string;
  createdAt: Generated<Date>;
  updatedAt: Generated<Date>;
}

interface McpSessionGrantTable {
  workspaceId: string;
  installationId: string;
  sessionId: string;
  status: string;
  createdAt: Generated<Date>;
  revokedAt: Date | null;
}

interface AgentSessionRequestTable {
  workspaceId: string;
  id: string;
  agentId: string;
  requestedByHumanId: string;
  requestedByAgentId: string | null;
  runId: string | null;
  machineId: string;
  purpose: string;
  readPath: string;
  scopes: Json<SessionMachineScope[]>;
  durationSeconds: number;
  status: string;
  approvalCodeHash: string;
  expiresAt: Date;
  approvedAt: Date | null;
  approvedByHumanId: string | null;
  claimedAt: Date | null;
  sessionId: string | null;
  predecessorSessionId: string | null;
  autoapprovalPolicyId: string | null;
  autoapprovalPolicyVersion: number | null;
  createdAt: Generated<Date>;
  updatedAt: Generated<Date>;
}

interface AgentPolicyTable {
  workspaceId: string;
  id: string;
  agentId: string;
  version: number;
  kind: string;
  status: string;
  scopes: Json<SessionMachineScope[]>;
  maxSessionSeconds: number;
  maxManagedAgents: number | null;
  expiresAt: Date;
  approvalCodeHash: string;
  approvedByHumanId: string | null;
  approvedAt: Date | null;
  predecessorPolicyId: string | null;
  delegationPolicyId: string | null;
  delegationPolicyVersion: number | null;
  createdAt: Generated<Date>;
  updatedAt: Generated<Date>;
}

interface AgentSessionTargetTable {
  workspaceId: string;
  sessionId: string;
  machineId: string;
  capabilities: Json<Capability[]>;
  readPath: string;
  profile: Generated<string>;
  restrictions: Json<SessionRestrictions>;
  runtimeSessionId: string;
  status: string;
  createdAt: Generated<Date>;
  updatedAt: Generated<Date>;
}

interface SessionTimelineEventTable {
  workspaceId: string;
  id: string;
  sessionId: string | null;
  requestId: string;
  operationId: string | null;
  eventType: string;
  source: string;
  metadata: Json<Record<string, unknown>>;
  createdAt: Generated<Date>;
}

interface EventSinkTable {
  workspaceId: string;
  id: string;
  endpoint: string;
  detailLevel: string;
  secretCiphertext: string;
  secretLastFour: string;
  status: string;
  createdAt: Generated<Date>;
  updatedAt: Generated<Date>;
}

interface EventSinkDeliveryTable {
  workspaceId: string;
  id: string;
  sinkId: string;
  eventId: string;
  status: string;
  attempts: Generated<number>;
  nextAttemptAt: Generated<Date>;
  lastError: string | null;
  deliveredAt: Date | null;
  createdAt: Generated<Date>;
  updatedAt: Generated<Date>;
}

interface AuthorityCutoverTable {
  workspaceId: string;
  status: string;
  legacyAgentTokensRevoked: number;
  legacySessionsClosed: number;
  legacyOperationsCancelled: number;
  completedAt: Generated<Date>;
}

interface LegacySessionTable {
  workspaceId: string;
  id: string;
  machineId: string;
  principalId: string;
  profile: string;
  capabilities: Json<Capability[]>;
  status: string;
  expiresAt: Date;
  error: string | null;
  createdAt: Generated<Date>;
  updatedAt: Generated<Date>;
}

interface OperationTable {
  workspaceId: string;
  id: string;
  sessionId: string;
  principalId: string;
  action: Json<OperationAction>;
  status: string;
  timeoutSeconds: number;
  maxOutputBytes: number;
  exitCode: number | null;
  error: string | null;
  outputTruncated: Generated<boolean>;
  idempotencyKey: string | null;
  createdAt: Generated<Date>;
  updatedAt: Generated<Date>;
}

interface OperationEventTable {
  workspaceId: string;
  operationId: string;
  sequence: number;
  stream: string;
  data: Buffer;
  createdAt: Generated<Date>;
}

interface AuditEventTable {
  workspaceId: string;
  id: string;
  principalId: string;
  action: string;
  targetType: string;
  targetId: string;
  metadata: Json<Record<string, unknown>>;
  createdAt: Generated<Date>;
}

interface DatabaseSchema {
  organizations: OrganizationTable;
  workspaces: WorkspaceTable;
  machines: MachineTable;
  enrollmentTokens: EnrollmentTokenTable;
  agentTokens: AgentTokenTable;
  cliTokens: CliTokenTable;
  deviceAuthorizations: DeviceAuthorizationTable;
  agentDeviceAuthorizations: AgentDeviceAuthorizationTable;
  humans: HumanTable;
  agents: AgentTable;
  agentCredentials: AgentCredentialTable;
  agentSessions: AgentSessionTable;
  sessionCredentials: SessionCredentialTable;
  mcpInstallations: McpInstallationTable;
  mcpSessionGrants: McpSessionGrantTable;
  agentSessionRequests: AgentSessionRequestTable;
  agentPolicies: AgentPolicyTable;
  agentSessionTargets: AgentSessionTargetTable;
  sessionTimelineEvents: SessionTimelineEventTable;
  eventSinks: EventSinkTable;
  eventSinkDeliveries: EventSinkDeliveryTable;
  authorityCutovers: AuthorityCutoverTable;
  sessions: LegacySessionTable;
  operations: OperationTable;
  operationEvents: OperationEventTable;
  auditEvents: AuditEventTable;
}

type Timestamped = {
  createdAt: number;
  updatedAt?: number;
};

export type OrganizationRecord = {
  id: string;
  slug: string;
  name: string;
  externalId?: string;
  plan: CloudPlanId;
  createdAt: number;
};

export type WorkspaceRecord = {
  id: string;
  organizationId: string;
  slug: string;
  name: string;
  createdAt: number;
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
  workspaceId: string;
  id: string;
  name: string;
  tokenHash: string;
  machineIds: string[];
  capabilities: Capability[];
  expiresAt: number;
  revokedAt?: number;
  deletedAt?: number;
};

export type CliTokenRecord = {
  id: string;
  workspaceId: string;
  userId: string;
  expiresAt: number;
  createdAt: number;
};

export type DeviceExchangeResult =
  | { status: "pending" | "denied" | "expired" | "consumed" | "invalid" }
  | {
      status: "authorized";
      tokenId: string;
      workspaceId: string;
      userId: string;
      expiresAt: number;
    };

export type AgentDeviceExchangeResult =
  | { status: "pending" | "denied" | "expired" | "consumed" | "invalid" }
  | {
      status: "authorized";
      workspaceId: string;
      agentId: string;
      agentName: string;
      credentialId: string;
      expiresAt: number;
    };

export type HumanIdentityRecord = Timestamped & {
  workspaceId: string;
  id: string;
  externalId: string;
  status: "active" | "disabled";
};

export type AgentIdentityRecord = Timestamped & {
  workspaceId: string;
  id: string;
  name: string;
  kind: "independent" | "managed";
  parentAgentId?: string;
  createdByHumanId?: string;
  status: "active" | "disabled";
  deletedAt?: number;
};

export type AgentCredentialPrincipal = {
  workspaceId: string;
  credentialId: string;
  agentId: string;
  agentName: string;
  ownerHumanId: string;
  expiresAt: number;
};

export type McpInstallationRecord = Timestamped & {
  workspaceId: string;
  id: string;
  userId: string;
  oauthClientId: string;
  agentId: string;
  agentName: string;
  status: "active" | "revoked";
};

export type McpWorkspaceRecord = {
  workspaceId: string;
  workspaceName: string;
  organizationExternalId: string;
};

export type AgentSessionRecord = Timestamped & {
  workspaceId: string;
  id: string;
  agentId: string;
  purpose: string;
  status: "active" | "completed" | "cancelled" | "revoked" | "expired";
  expiresAt: number;
  predecessorSessionId?: string;
  autoapprovalPolicyId?: string;
  autoapprovalPolicyVersion?: number;
};

export type AgentSessionRequestRecord = Timestamped & {
  workspaceId: string;
  id: string;
  agentId: string;
  requestedByHumanId: string;
  requestedByAgentId?: string;
  runId?: string;
  machineId: string;
  purpose: string;
  readPath: string;
  scopes: SessionMachineScope[];
  durationSeconds: number;
  status: "pending" | "approved" | "denied" | "expired" | "claimed";
  expiresAt: number;
  approvedAt?: number;
  approvedByHumanId?: string;
  claimedAt?: number;
  sessionId?: string;
  predecessorSessionId?: string;
  autoapprovalPolicyId?: string;
  autoapprovalPolicyVersion?: number;
};

export type AgentPolicyRecord = Timestamped & {
  workspaceId: string;
  id: string;
  agentId: string;
  version: number;
  kind: "autoapproval" | "delegation" | "managed";
  status: "proposed" | "active" | "paused" | "revoked" | "replaced";
  scopes: SessionMachineScope[];
  maxSessionSeconds: number;
  maxManagedAgents?: number;
  expiresAt: number;
  approvedByHumanId?: string;
  approvedAt?: number;
  predecessorPolicyId?: string;
  delegationPolicyId?: string;
  delegationPolicyVersion?: number;
};

export type AgentPolicyApprovalView = AgentPolicyRecord & {
  agentName: string;
  machines: Array<{ id: string; name: string }>;
};

export type AgentPolicyApprovalResult =
  | { status: "approved"; policy: AgentPolicyRecord }
  | { status: "invalid" | "expired" | "already_used" };

export type SessionApprovalView = AgentSessionRequestRecord & {
  agentName: string;
  machines: Array<{ id: string; name: string }>;
};

export type SessionApprovalResult =
  | { status: "approved"; request: AgentSessionRequestRecord }
  | { status: "invalid" | "expired" | "already_used" };

export type SessionDenialResult =
  | { status: "denied"; request: AgentSessionRequestRecord }
  | { status: "invalid" | "expired" | "already_used" };

export type SessionClaimResult =
  | {
      status: "claimed";
      session: AgentSessionRecord;
      targets: Array<{
        machineId: string;
        runtimeSessionId: string;
        scope: SessionMachineScope;
      }>;
    }
  | {
      status:
        | "invalid"
        | "pending"
        | "denied"
        | "expired"
        | "already_claimed"
        | "agent_denied"
        | "machine_unavailable";
    };

export type AgentSessionCredentialPrincipal = {
  workspaceId: string;
  agentId: string;
  agentName: string;
  sessionId: string;
  scopes: SessionMachineScope[];
  expiresAt: number;
};

export type SessionTimelineEventRecord = {
  id: string;
  sessionId?: string;
  requestId: string;
  operationId?: string;
  eventType: string;
  source: "verified" | "agent";
  metadata: Record<string, unknown>;
  createdAt: number;
};

export type EventSinkRecord = {
  id: string;
  endpoint: string;
  detailLevel: "privacy-minimal" | "operational" | "diagnostic";
  secretLastFour: string;
  status: "active" | "paused";
  createdAt: number;
  updatedAt: number;
};

export type PendingEventSinkDelivery = {
  workspaceId: string;
  id: string;
  sinkId: string;
  endpoint: string;
  detailLevel: EventSinkRecord["detailLevel"];
  secretCiphertext: string;
  attempts: number;
  event: SessionTimelineEventRecord;
};

export type WorkspaceAgentSessionRecord = AgentSessionRecord & {
  agentName: string;
  requestedByHumanId: string;
  requestedByAgentId?: string;
  runId?: string;
  scopes: SessionMachineScope[];
  targets: Array<{
    machineId: string;
    machineName: string;
    status: string;
  }>;
};

export type WorkspaceAgentSessionRequestRecord = AgentSessionRequestRecord & {
  agentName: string;
  machines: Array<{ id: string; name: string }>;
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

export type AgentSessionTargetRuntime = {
  canonicalSessionId: string;
  runtimeSessionId: string;
  machineId: string;
  profile: string;
  capabilities: Capability[];
  restrictions: SessionRestrictions;
  status: string;
  expiresAt: number;
  error?: string;
};

export type AgentSessionTermination = {
  id: string;
  status: AgentSessionRecord["status"];
  transitioned: boolean;
  targets: Array<{ machineId: string; runtimeSessionId: string }>;
  operations: Array<{ id: string; machineId: string }>;
};

export type AgentSessionCompletion =
  | { status: "busy" }
  | {
      id: string;
      status: "completed";
      transitioned: boolean;
      targets: Array<{ machineId: string; runtimeSessionId: string }>;
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

function timestamp(value: Date): number;
function timestamp(value: Date | null): number | undefined;
function timestamp(value: Date | null): number | undefined {
  return value?.getTime();
}

function organizationRecord(
  organization: Selectable<OrganizationTable>,
): OrganizationRecord {
  return {
    id: organization.id,
    slug: organization.slug,
    name: organization.name,
    ...(organization.externalId === null ? {} : { externalId: organization.externalId }),
    plan: organization.plan as CloudPlanId,
    createdAt: timestamp(organization.createdAt),
  };
}

function workspaceRecord(workspace: Selectable<WorkspaceTable>): WorkspaceRecord {
  return {
    id: workspace.id,
    organizationId: workspace.organizationId,
    slug: workspace.slug,
    name: workspace.name,
    createdAt: timestamp(workspace.createdAt),
  };
}

function machineRecord(machine: Selectable<MachineTable>): MachineRecord {
  return {
    id: machine.id,
    name: machine.name,
    publicKey: machine.publicKey,
    status: machine.status,
    ...(machine.runtime === null ? {} : { runtime: machine.runtime }),
    ...(machine.lastSeenAt === null ? {} : { lastSeenAt: timestamp(machine.lastSeenAt) }),
    enrolledAt: timestamp(machine.enrolledAt),
    ...(machine.revokedAt === null ? {} : { revokedAt: timestamp(machine.revokedAt) }),
  };
}

function agentTokenRecord(token: Selectable<AgentTokenTable>): AgentTokenRecord {
  return {
    workspaceId: token.workspaceId,
    id: token.id,
    name: token.name,
    tokenHash: token.tokenHash,
    machineIds: token.machineIds,
    capabilities: token.capabilities,
    expiresAt: timestamp(token.expiresAt),
    ...(token.revokedAt === null ? {} : { revokedAt: timestamp(token.revokedAt) }),
    ...(token.deletedAt === null ? {} : { deletedAt: timestamp(token.deletedAt) }),
    createdAt: timestamp(token.createdAt),
  };
}

function humanIdentityRecord(
  human: Selectable<HumanTable>,
): HumanIdentityRecord {
  return {
    workspaceId: human.workspaceId,
    id: human.id,
    externalId: human.externalId,
    status: human.status as HumanIdentityRecord["status"],
    createdAt: timestamp(human.createdAt),
    updatedAt: timestamp(human.updatedAt),
  };
}

function agentIdentityRecord(
  agent: Selectable<AgentTable>,
): AgentIdentityRecord {
  return {
    workspaceId: agent.workspaceId,
    id: agent.id,
    name: agent.name,
    kind: agent.kind as AgentIdentityRecord["kind"],
    ...(agent.parentAgentId === null
      ? {}
      : { parentAgentId: agent.parentAgentId }),
    ...(agent.createdByHumanId === null
      ? {}
      : { createdByHumanId: agent.createdByHumanId }),
    status: agent.status as AgentIdentityRecord["status"],
    ...(agent.deletedAt === null
      ? {}
      : { deletedAt: timestamp(agent.deletedAt) }),
    createdAt: timestamp(agent.createdAt),
    updatedAt: timestamp(agent.updatedAt),
  };
}

function agentSessionRecord(
  session: Selectable<AgentSessionTable>,
): AgentSessionRecord {
  return {
    workspaceId: session.workspaceId,
    id: session.id,
    agentId: session.agentId,
    purpose: session.purpose,
    status: session.status as AgentSessionRecord["status"],
    expiresAt: timestamp(session.expiresAt),
    ...(session.predecessorSessionId === null
      ? {}
      : { predecessorSessionId: session.predecessorSessionId }),
    ...(session.autoapprovalPolicyId === null
      ? {}
      : { autoapprovalPolicyId: session.autoapprovalPolicyId }),
    ...(session.autoapprovalPolicyVersion === null
      ? {}
      : { autoapprovalPolicyVersion: session.autoapprovalPolicyVersion }),
    createdAt: timestamp(session.createdAt),
    updatedAt: timestamp(session.updatedAt),
  };
}

function agentSessionRequestRecord(
  request: Selectable<AgentSessionRequestTable>,
): AgentSessionRequestRecord {
  return {
    workspaceId: request.workspaceId,
    id: request.id,
    agentId: request.agentId,
    requestedByHumanId: request.requestedByHumanId,
    ...(request.requestedByAgentId === null
      ? {}
      : { requestedByAgentId: request.requestedByAgentId }),
    ...(request.runId === null ? {} : { runId: request.runId }),
    machineId: request.machineId,
    purpose: request.purpose,
    readPath: request.readPath,
    scopes: request.scopes,
    durationSeconds: request.durationSeconds,
    status: request.status as AgentSessionRequestRecord["status"],
    expiresAt: timestamp(request.expiresAt),
    ...(request.approvedAt === null
      ? {}
      : { approvedAt: timestamp(request.approvedAt) }),
    ...(request.approvedByHumanId === null
      ? {}
      : { approvedByHumanId: request.approvedByHumanId }),
    ...(request.claimedAt === null
      ? {}
      : { claimedAt: timestamp(request.claimedAt) }),
    ...(request.sessionId === null ? {} : { sessionId: request.sessionId }),
    ...(request.predecessorSessionId === null
      ? {}
      : { predecessorSessionId: request.predecessorSessionId }),
    ...(request.autoapprovalPolicyId === null
      ? {}
      : { autoapprovalPolicyId: request.autoapprovalPolicyId }),
    ...(request.autoapprovalPolicyVersion === null
      ? {}
      : { autoapprovalPolicyVersion: request.autoapprovalPolicyVersion }),
    createdAt: timestamp(request.createdAt),
    updatedAt: timestamp(request.updatedAt),
  };
}

function agentPolicyRecord(
  policy: Selectable<AgentPolicyTable>,
): AgentPolicyRecord {
  return {
    workspaceId: policy.workspaceId,
    id: policy.id,
    agentId: policy.agentId,
    version: policy.version,
    kind: policy.kind as AgentPolicyRecord["kind"],
    status: policy.status as AgentPolicyRecord["status"],
    scopes: policy.scopes,
    maxSessionSeconds: policy.maxSessionSeconds,
    ...(policy.maxManagedAgents === null
      ? {}
      : { maxManagedAgents: policy.maxManagedAgents }),
    expiresAt: timestamp(policy.expiresAt),
    ...(policy.approvedByHumanId === null
      ? {}
      : { approvedByHumanId: policy.approvedByHumanId }),
    ...(policy.approvedAt === null
      ? {}
      : { approvedAt: timestamp(policy.approvedAt) }),
    ...(policy.predecessorPolicyId === null
      ? {}
      : { predecessorPolicyId: policy.predecessorPolicyId }),
    ...(policy.delegationPolicyId === null
      ? {}
      : { delegationPolicyId: policy.delegationPolicyId }),
    ...(policy.delegationPolicyVersion === null
      ? {}
      : { delegationPolicyVersion: policy.delegationPolicyVersion }),
    createdAt: timestamp(policy.createdAt),
    updatedAt: timestamp(policy.updatedAt),
  };
}

function sessionTimelineEventRecord(
  event: Selectable<SessionTimelineEventTable>,
): SessionTimelineEventRecord {
  return {
    id: event.id,
    ...(event.sessionId === null ? {} : { sessionId: event.sessionId }),
    requestId: event.requestId,
    ...(event.operationId === null
      ? {}
      : { operationId: event.operationId }),
    eventType: event.eventType,
    source: event.source as SessionTimelineEventRecord["source"],
    metadata: event.metadata,
    createdAt: timestamp(event.createdAt),
  };
}

function sessionRecord(
  session: Selectable<LegacySessionTable>,
  machineName?: string,
): SessionRecord {
  return {
    id: session.id,
    machineId: session.machineId,
    ...(machineName === undefined ? {} : { machineName }),
    principalId: session.principalId,
    profile: session.profile,
    capabilities: session.capabilities,
    status: session.status,
    expiresAt: timestamp(session.expiresAt),
    ...(session.error === null ? {} : { error: session.error }),
    createdAt: timestamp(session.createdAt),
    updatedAt: timestamp(session.updatedAt),
  };
}

function operationRecord(operation: Selectable<OperationTable>): OperationRecord {
  return {
    id: operation.id,
    sessionId: operation.sessionId,
    principalId: operation.principalId,
    action: operation.action,
    status: operation.status,
    timeoutSeconds: operation.timeoutSeconds,
    maxOutputBytes: operation.maxOutputBytes,
    ...(operation.exitCode === null ? {} : { exitCode: operation.exitCode }),
    ...(operation.error === null ? {} : { error: operation.error }),
    outputTruncated: operation.outputTruncated,
    ...(operation.idempotencyKey === null
      ? {}
      : { idempotencyKey: operation.idempotencyKey }),
    createdAt: timestamp(operation.createdAt),
    updatedAt: timestamp(operation.updatedAt),
  };
}

function operationEventRecord(
  event: Selectable<OperationEventTable>,
): OperationEventRecord {
  return {
    operationId: event.operationId,
    sequence: event.sequence,
    stream: event.stream,
    dataBase64: event.data.toString("base64"),
    createdAt: timestamp(event.createdAt),
  };
}

function auditRecord(event: Selectable<AuditEventTable>): AuditRecord {
  return {
    id: event.id,
    principalId: event.principalId,
    action: event.action,
    targetType: event.targetType,
    targetId: event.targetId,
    metadata: event.metadata,
    createdAt: timestamp(event.createdAt),
  };
}

async function migrateInitialSchema(db: Kysely<DatabaseSchema>): Promise<void> {
  await sql`create schema if not exists ${sql.id(DATABASE_SCHEMA)}`.execute(db);
  const schema = db.schema.withSchema(DATABASE_SCHEMA);

  await schema
    .createTable("workspaces")
    .ifNotExists()
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("slug", "text", (column) => column.notNull().unique())
    .addColumn("name", "text", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await schema
    .createTable("machines")
    .ifNotExists()
    .addColumn("workspace_id", "text", (column) =>
      column.notNull().references(`${DATABASE_SCHEMA}.workspaces.id`),
    )
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("name", "text", (column) => column.notNull())
    .addColumn("public_key", "text", (column) => column.notNull())
    .addColumn("status", "text", (column) => column.notNull().defaultTo("offline"))
    .addColumn("runtime", "jsonb")
    .addColumn("last_seen_at", "timestamptz")
    .addColumn("enrolled_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addColumn("revoked_at", "timestamptz")
    .execute();

  await schema
    .createTable("enrollment_tokens")
    .ifNotExists()
    .addColumn("workspace_id", "text", (column) =>
      column.notNull().references(`${DATABASE_SCHEMA}.workspaces.id`),
    )
    .addColumn("token_hash", "text", (column) => column.primaryKey())
    .addColumn("expires_at", "timestamptz", (column) => column.notNull())
    .addColumn("used_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await schema
    .createTable("agent_tokens")
    .ifNotExists()
    .addColumn("workspace_id", "text", (column) =>
      column.notNull().references(`${DATABASE_SCHEMA}.workspaces.id`),
    )
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("name", "text", (column) => column.notNull())
    .addColumn("token_hash", "text", (column) => column.notNull().unique())
    .addColumn("machine_ids", "jsonb", (column) => column.notNull())
    .addColumn("capabilities", "jsonb", (column) => column.notNull())
    .addColumn("expires_at", "timestamptz", (column) => column.notNull())
    .addColumn("revoked_at", "timestamptz")
    .addColumn("deleted_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await schema
    .createTable("sessions")
    .ifNotExists()
    .addColumn("workspace_id", "text", (column) =>
      column.notNull().references(`${DATABASE_SCHEMA}.workspaces.id`),
    )
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("machine_id", "text", (column) =>
      column.notNull().references(`${DATABASE_SCHEMA}.machines.id`),
    )
    .addColumn("principal_id", "text", (column) => column.notNull())
    .addColumn("profile", "text", (column) => column.notNull())
    .addColumn("capabilities", "jsonb", (column) => column.notNull())
    .addColumn("status", "text", (column) => column.notNull())
    .addColumn("expires_at", "timestamptz", (column) => column.notNull())
    .addColumn("error", "text")
    .addColumn("created_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addColumn("updated_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await schema
    .createTable("operations")
    .ifNotExists()
    .addColumn("workspace_id", "text", (column) =>
      column.notNull().references(`${DATABASE_SCHEMA}.workspaces.id`),
    )
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("session_id", "text", (column) =>
      column.notNull().references(`${DATABASE_SCHEMA}.sessions.id`),
    )
    .addColumn("principal_id", "text", (column) => column.notNull())
    .addColumn("action", "jsonb", (column) => column.notNull())
    .addColumn("status", "text", (column) => column.notNull())
    .addColumn("timeout_seconds", "integer", (column) => column.notNull())
    .addColumn("max_output_bytes", "integer", (column) => column.notNull())
    .addColumn("exit_code", "integer")
    .addColumn("error", "text")
    .addColumn("output_truncated", "boolean", (column) =>
      column.notNull().defaultTo(false),
    )
    .addColumn("idempotency_key", "text")
    .addColumn("created_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addColumn("updated_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addUniqueConstraint("operations_principal_idempotency_unique", [
      "principal_id",
      "idempotency_key",
    ])
    .execute();

  await schema
    .createTable("operation_events")
    .ifNotExists()
    .addColumn("workspace_id", "text", (column) =>
      column.notNull().references(`${DATABASE_SCHEMA}.workspaces.id`),
    )
    .addColumn("operation_id", "text", (column) =>
      column
        .notNull()
        .references(`${DATABASE_SCHEMA}.operations.id`)
        .onDelete("cascade"),
    )
    .addColumn("sequence", "integer", (column) => column.notNull())
    .addColumn("stream", "text", (column) => column.notNull())
    .addColumn("data", "bytea", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addPrimaryKeyConstraint("operation_events_primary_key", [
      "operation_id",
      "sequence",
    ])
    .execute();

  await schema
    .createTable("audit_events")
    .ifNotExists()
    .addColumn("workspace_id", "text", (column) =>
      column.notNull().references(`${DATABASE_SCHEMA}.workspaces.id`),
    )
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("principal_id", "text", (column) => column.notNull())
    .addColumn("action", "text", (column) => column.notNull())
    .addColumn("target_type", "text", (column) => column.notNull())
    .addColumn("target_id", "text", (column) => column.notNull())
    .addColumn("metadata", "jsonb", (column) =>
      column.notNull().defaultTo(sql`'{}'::jsonb`),
    )
    .addColumn("created_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await schema
    .createIndex("machines_workspace_enrolled_idx")
    .ifNotExists()
    .on("machines")
    .columns(["workspace_id", "enrolled_at"])
    .execute();
  await schema
    .createIndex("sessions_principal_created_idx")
    .ifNotExists()
    .on("sessions")
    .columns(["principal_id", "created_at"])
    .execute();
  await schema
    .createIndex("sessions_machine_status_idx")
    .ifNotExists()
    .on("sessions")
    .columns(["machine_id", "status"])
    .execute();
  await schema
    .createIndex("operations_session_created_idx")
    .ifNotExists()
    .on("operations")
    .columns(["session_id", "created_at"])
    .execute();
  await schema
    .createIndex("audit_events_workspace_created_idx")
    .ifNotExists()
    .on("audit_events")
    .columns(["workspace_id", "created_at"])
    .execute();
  await schema
    .createIndex("audit_events_principal_created_idx")
    .ifNotExists()
    .on("audit_events")
    .columns(["principal_id", "created_at"])
    .execute();
}

async function redactHistoricalAuditMetadata(
  db: Kysely<DatabaseSchema>,
): Promise<void> {
  await sql`
    update ${sql.table(`${DATABASE_SCHEMA}.audit_events`)}
    set metadata = jsonb_strip_nulls(
      jsonb_build_object(
        'sessionId', metadata -> 'sessionId',
        'operation', jsonb_build_object(
          'kind', metadata #> '{operation,kind}'
        )
      )
    )
    where action = 'operation.created'
  `.execute(db);
  await sql`
    update ${sql.table(`${DATABASE_SCHEMA}.audit_events`)}
    set metadata = '{"reason":"client_rejected"}'::jsonb
    where action = 'session.open_failed'
  `.execute(db);
}

async function migrateOrganizationBoundaries(
  db: Kysely<DatabaseSchema>,
): Promise<void> {
  await sql`
    create table if not exists ${sql.table(`${DATABASE_SCHEMA}.organizations`)} (
      id text primary key,
      slug text not null unique,
      name text not null,
      created_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`
    insert into ${sql.table(`${DATABASE_SCHEMA}.organizations`)} (id, slug, name)
    values (${DEFAULT_ORGANIZATION_ID}, 'default', 'Default organization')
    on conflict (id) do nothing
  `.execute(db);
  await sql`
    alter table ${sql.table(`${DATABASE_SCHEMA}.workspaces`)}
    add column if not exists organization_id text
  `.execute(db);
  await sql`
    update ${sql.table(`${DATABASE_SCHEMA}.workspaces`)}
    set organization_id = ${DEFAULT_ORGANIZATION_ID}
    where organization_id is null
  `.execute(db);
  await sql`
    alter table ${sql.table(`${DATABASE_SCHEMA}.workspaces`)}
    alter column organization_id set not null
  `.execute(db);
  await sql`
    alter table ${sql.table(`${DATABASE_SCHEMA}.workspaces`)}
    drop constraint if exists workspaces_slug_key
  `.execute(db);
  await sql`
    do $migration$
    begin
      if not exists (
        select 1
        from pg_constraint
        where conname = 'workspaces_organization_id_foreign'
          and conrelid = '${sql.raw(`${DATABASE_SCHEMA}.workspaces`)}'::regclass
      ) then
        alter table ${sql.table(`${DATABASE_SCHEMA}.workspaces`)}
        add constraint workspaces_organization_id_foreign
        foreign key (organization_id)
        references ${sql.table(`${DATABASE_SCHEMA}.organizations`)} (id);
      end if;
      if not exists (
        select 1
        from pg_constraint
        where conname = 'workspaces_organization_slug_unique'
          and conrelid = '${sql.raw(`${DATABASE_SCHEMA}.workspaces`)}'::regclass
      ) then
        alter table ${sql.table(`${DATABASE_SCHEMA}.workspaces`)}
        add constraint workspaces_organization_slug_unique
        unique (organization_id, slug);
      end if;
    end
    $migration$
  `.execute(db);
  await sql`
    create index if not exists workspaces_organization_created_idx
    on ${sql.table(`${DATABASE_SCHEMA}.workspaces`)} (organization_id, created_at)
  `.execute(db);
  await sql`
    do $migration$
    begin
      if not exists (
        select 1 from pg_constraint
        where conname = 'machines_workspace_identity_unique'
          and conrelid = '${sql.raw(`${DATABASE_SCHEMA}.machines`)}'::regclass
      ) then
        alter table ${sql.table(`${DATABASE_SCHEMA}.machines`)}
        add constraint machines_workspace_identity_unique unique (workspace_id, id);
      end if;
      if not exists (
        select 1 from pg_constraint
        where conname = 'sessions_workspace_identity_unique'
          and conrelid = '${sql.raw(`${DATABASE_SCHEMA}.sessions`)}'::regclass
      ) then
        alter table ${sql.table(`${DATABASE_SCHEMA}.sessions`)}
        add constraint sessions_workspace_identity_unique unique (workspace_id, id);
      end if;
      if not exists (
        select 1 from pg_constraint
        where conname = 'operations_workspace_identity_unique'
          and conrelid = '${sql.raw(`${DATABASE_SCHEMA}.operations`)}'::regclass
      ) then
        alter table ${sql.table(`${DATABASE_SCHEMA}.operations`)}
        add constraint operations_workspace_identity_unique unique (workspace_id, id);
      end if;
      if not exists (
        select 1 from pg_constraint
        where conname = 'sessions_workspace_machine_foreign'
          and conrelid = '${sql.raw(`${DATABASE_SCHEMA}.sessions`)}'::regclass
      ) then
        alter table ${sql.table(`${DATABASE_SCHEMA}.sessions`)}
        add constraint sessions_workspace_machine_foreign
        foreign key (workspace_id, machine_id)
        references ${sql.table(`${DATABASE_SCHEMA}.machines`)} (workspace_id, id);
      end if;
      if not exists (
        select 1 from pg_constraint
        where conname = 'operations_workspace_session_foreign'
          and conrelid = '${sql.raw(`${DATABASE_SCHEMA}.operations`)}'::regclass
      ) then
        alter table ${sql.table(`${DATABASE_SCHEMA}.operations`)}
        add constraint operations_workspace_session_foreign
        foreign key (workspace_id, session_id)
        references ${sql.table(`${DATABASE_SCHEMA}.sessions`)} (workspace_id, id);
      end if;
      if not exists (
        select 1 from pg_constraint
        where conname = 'operation_events_workspace_operation_foreign'
          and conrelid = '${sql.raw(`${DATABASE_SCHEMA}.operation_events`)}'::regclass
      ) then
        alter table ${sql.table(`${DATABASE_SCHEMA}.operation_events`)}
        add constraint operation_events_workspace_operation_foreign
        foreign key (workspace_id, operation_id)
        references ${sql.table(`${DATABASE_SCHEMA}.operations`)} (workspace_id, id)
        on delete cascade;
      end if;
    end
    $migration$
  `.execute(db);
}

async function migrateCloudIdentity(
  db: Kysely<DatabaseSchema>,
): Promise<void> {
  await sql`
    alter table ${sql.table(`${DATABASE_SCHEMA}.organizations`)}
    add column if not exists external_id text
  `.execute(db);
  await sql`
    alter table ${sql.table(`${DATABASE_SCHEMA}.organizations`)}
    add column if not exists plan text not null default 'free'
  `.execute(db);
  await sql`
    create unique index if not exists organizations_external_id_unique
    on ${sql.table(`${DATABASE_SCHEMA}.organizations`)} (external_id)
    where external_id is not null
  `.execute(db);
  await sql`
    create table if not exists ${sql.table(`${DATABASE_SCHEMA}.cli_tokens`)} (
      workspace_id text not null references ${sql.table(`${DATABASE_SCHEMA}.workspaces`)} (id),
      id text primary key,
      user_id text not null,
      token_hash text not null unique,
      expires_at timestamptz not null,
      revoked_at timestamptz,
      last_used_at timestamptz,
      created_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`
    create index if not exists cli_tokens_workspace_created_idx
    on ${sql.table(`${DATABASE_SCHEMA}.cli_tokens`)} (workspace_id, created_at)
  `.execute(db);
  await sql`
    create table if not exists ${sql.table(`${DATABASE_SCHEMA}.device_authorizations`)} (
      id text primary key,
      device_code_hash text not null unique,
      user_code_hash text not null unique,
      client_name text not null,
      status text not null,
      workspace_id text references ${sql.table(`${DATABASE_SCHEMA}.workspaces`)} (id),
      user_id text,
      expires_at timestamptz not null,
      approved_at timestamptz,
      consumed_at timestamptz,
      created_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`
    create index if not exists device_authorizations_expiry_idx
    on ${sql.table(`${DATABASE_SCHEMA}.device_authorizations`)} (expires_at)
  `.execute(db);
}

async function migrateAgentDeletion(
  db: Kysely<DatabaseSchema>,
): Promise<void> {
  await sql`
    alter table ${sql.table(`${DATABASE_SCHEMA}.agent_tokens`)}
    add column if not exists deleted_at timestamptz
  `.execute(db);
}

async function migrateIdentityAuthorityExpand(
  db: Kysely<DatabaseSchema>,
): Promise<void> {
  await sql`
    do $migration$
    begin
      if to_regclass('odyshell.sessions') is null then
        raise exception
          'Identity authority expansion requires the legacy session table';
      end if;
    end
    $migration$
  `.execute(db);
  await sql`
    create table if not exists odyshell.humans (
      workspace_id text not null references odyshell.workspaces (id),
      id text not null,
      external_id text not null,
      status text not null check (status in ('active', 'disabled')),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      primary key (workspace_id, id),
      unique (workspace_id, external_id)
    )
  `.execute(db);
  await sql`
    create table if not exists odyshell.agents (
      workspace_id text not null references odyshell.workspaces (id),
      id text not null,
      name text not null,
      kind text not null check (kind in ('independent', 'managed')),
      parent_agent_id text,
      created_by_human_id text,
      status text not null check (status in ('active', 'disabled')),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      primary key (workspace_id, id),
      unique (workspace_id, id, kind),
      foreign key (workspace_id, parent_agent_id)
        references odyshell.agents (workspace_id, id),
      foreign key (workspace_id, created_by_human_id)
        references odyshell.humans (workspace_id, id),
      check (
        (kind = 'independent' and parent_agent_id is null)
        or (kind = 'managed' and parent_agent_id is not null)
      ),
      check (parent_agent_id is null or parent_agent_id <> id)
    )
  `.execute(db);
  await sql`
    create table if not exists odyshell.agent_credentials (
      workspace_id text not null,
      id text not null,
      agent_id text not null,
      agent_kind text not null default 'independent'
        check (agent_kind = 'independent'),
      token_hash text not null,
      status text not null check (
        status in ('active', 'retiring', 'expired', 'revoked')
      ),
      expires_at timestamptz not null,
      retiring_at timestamptz,
      revoked_at timestamptz,
      created_at timestamptz not null default now(),
      primary key (workspace_id, id),
      unique (workspace_id, token_hash),
      foreign key (workspace_id, agent_id, agent_kind)
        references odyshell.agents (workspace_id, id, kind),
      check (expires_at > created_at),
      check (expires_at <= created_at + interval '1 year')
    )
  `.execute(db);
  await sql`
    create table if not exists odyshell.agent_sessions (
      workspace_id text not null,
      id text not null,
      agent_id text not null,
      purpose text not null,
      status text not null check (
        status in ('active', 'completed', 'cancelled', 'revoked', 'expired')
      ),
      expires_at timestamptz not null,
      predecessor_session_id text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      primary key (workspace_id, id),
      unique (workspace_id, id, expires_at),
      foreign key (workspace_id, agent_id)
        references odyshell.agents (workspace_id, id),
      foreign key (workspace_id, predecessor_session_id)
        references odyshell.agent_sessions (workspace_id, id),
      check (predecessor_session_id is null or predecessor_session_id <> id),
      check (length(btrim(purpose)) between 1 and 280),
      check (expires_at > created_at),
      check (expires_at <= created_at + interval '24 hours')
    )
  `.execute(db);
  await sql`
    create table if not exists odyshell.session_credentials (
      workspace_id text not null,
      id text not null,
      session_id text not null,
      token_hash text not null,
      status text not null check (status in ('active', 'expired', 'revoked')),
      expires_at timestamptz not null,
      claimed_at timestamptz not null,
      revoked_at timestamptz,
      created_at timestamptz not null default now(),
      primary key (workspace_id, id),
      unique (workspace_id, session_id),
      unique (workspace_id, token_hash),
      foreign key (workspace_id, session_id, expires_at)
        references odyshell.agent_sessions (workspace_id, id, expires_at),
      check (expires_at > claimed_at)
    )
  `.execute(db);
  await sql`
    create index if not exists humans_workspace_created_idx
    on odyshell.humans (workspace_id, created_at)
  `.execute(db);
  await sql`
    create index if not exists agents_workspace_created_idx
    on odyshell.agents (workspace_id, created_at)
  `.execute(db);
  await sql`
    create index if not exists agent_credentials_agent_status_idx
    on odyshell.agent_credentials (workspace_id, agent_id, status)
  `.execute(db);
  await sql`
    create index if not exists agent_sessions_agent_created_idx
    on odyshell.agent_sessions (workspace_id, agent_id, created_at)
  `.execute(db);
  await sql`
    create index if not exists session_credentials_status_expiry_idx
    on odyshell.session_credentials (workspace_id, status, expires_at)
  `.execute(db);
}

async function rollbackIdentityAuthorityExpand(
  db: Kysely<DatabaseSchema>,
): Promise<void> {
  await sql`
    do $migration$
    begin
      if exists (select 1 from odyshell.humans)
        or exists (select 1 from odyshell.agents)
        or exists (select 1 from odyshell.agent_credentials)
        or exists (select 1 from odyshell.agent_sessions)
        or exists (select 1 from odyshell.session_credentials)
      then
        raise exception
          'Cannot roll back identity authority expansion after target data exists';
      end if;
    end
    $migration$
  `.execute(db);
  await sql`drop table odyshell.session_credentials`.execute(db);
  await sql`drop table odyshell.agent_sessions`.execute(db);
  await sql`drop table odyshell.agent_credentials`.execute(db);
  await sql`drop table odyshell.agents`.execute(db);
  await sql`drop table odyshell.humans`.execute(db);
}

async function migrateApprovedReadSessions(
  db: Kysely<DatabaseSchema>,
): Promise<void> {
  await sql`
    create table if not exists odyshell.agent_session_requests (
      workspace_id text not null,
      id text not null,
      agent_id text not null,
      requested_by_human_id text not null,
      machine_id text not null,
      purpose text not null,
      read_path text not null,
      duration_seconds integer not null,
      status text not null check (
        status in ('pending', 'approved', 'denied', 'expired', 'claimed')
      ),
      approval_code_hash text not null,
      expires_at timestamptz not null,
      approved_at timestamptz,
      approved_by_human_id text,
      claimed_at timestamptz,
      session_id text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      primary key (workspace_id, id),
      unique (workspace_id, approval_code_hash),
      unique (workspace_id, session_id),
      foreign key (workspace_id, agent_id)
        references odyshell.agents (workspace_id, id),
      foreign key (workspace_id, requested_by_human_id)
        references odyshell.humans (workspace_id, id),
      foreign key (workspace_id, approved_by_human_id)
        references odyshell.humans (workspace_id, id),
      foreign key (workspace_id, machine_id)
        references odyshell.machines (workspace_id, id),
      foreign key (workspace_id, session_id)
        references odyshell.agent_sessions (workspace_id, id),
      check (length(btrim(purpose)) between 1 and 280),
      check (length(read_path) between 1 and 4096),
      check (duration_seconds between 60 and 86400),
      check (expires_at > created_at)
    )
  `.execute(db);
  await sql`
    create table if not exists odyshell.agent_session_targets (
      workspace_id text not null,
      session_id text not null,
      machine_id text not null,
      capabilities jsonb not null,
      read_path text not null,
      status text not null check (
        status in ('opening', 'ready', 'rejected', 'closed')
      ),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      primary key (workspace_id, session_id, machine_id),
      foreign key (workspace_id, session_id)
        references odyshell.agent_sessions (workspace_id, id),
      foreign key (workspace_id, machine_id)
        references odyshell.machines (workspace_id, id),
      check (capabilities = '["fs.read"]'::jsonb),
      check (length(read_path) between 1 and 4096)
    )
  `.execute(db);
  await sql`
    create table if not exists odyshell.session_timeline_events (
      workspace_id text not null,
      id text not null,
      session_id text,
      request_id text not null,
      operation_id text,
      event_type text not null,
      source text not null check (source in ('verified', 'agent')),
      metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      primary key (workspace_id, id),
      foreign key (workspace_id, request_id)
        references odyshell.agent_session_requests (workspace_id, id),
      foreign key (workspace_id, session_id)
        references odyshell.agent_sessions (workspace_id, id)
    )
  `.execute(db);
  await sql`
    create index if not exists agent_session_requests_agent_created_idx
    on odyshell.agent_session_requests (workspace_id, agent_id, created_at)
  `.execute(db);
  await sql`
    create index if not exists agent_session_requests_approval_idx
    on odyshell.agent_session_requests (workspace_id, approval_code_hash, status)
  `.execute(db);
  await sql`
    create index if not exists session_timeline_session_created_idx
    on odyshell.session_timeline_events (workspace_id, session_id, created_at)
  `.execute(db);
}

async function rollbackApprovedReadSessions(
  db: Kysely<DatabaseSchema>,
): Promise<void> {
  await sql`
    do $migration$
    begin
      if exists (select 1 from odyshell.agent_session_requests)
        or exists (select 1 from odyshell.agent_session_targets)
        or exists (select 1 from odyshell.session_timeline_events)
      then
        raise exception
          'Cannot roll back approved read Sessions after target data exists';
      end if;
    end
    $migration$
  `.execute(db);
  await sql`drop table odyshell.session_timeline_events`.execute(db);
  await sql`drop table odyshell.agent_session_targets`.execute(db);
  await sql`drop table odyshell.agent_session_requests`.execute(db);
}

async function migrateGlobalSessionCredentialHash(
  db: Kysely<DatabaseSchema>,
): Promise<void> {
  await sql`
    create unique index if not exists session_credentials_token_hash_global_idx
    on odyshell.session_credentials (token_hash)
  `.execute(db);
}

async function rollbackGlobalSessionCredentialHash(
  db: Kysely<DatabaseSchema>,
): Promise<void> {
  await sql`
    drop index if exists odyshell.session_credentials_token_hash_global_idx
  `.execute(db);
}

async function migrateSessionScopedIdempotency(
  db: Kysely<DatabaseSchema>,
): Promise<void> {
  await sql`
    alter table odyshell.operations
    drop constraint if exists operations_principal_idempotency_unique
  `.execute(db);
  await sql`
    alter table odyshell.operations
    add constraint operations_session_principal_idempotency_unique
    unique (session_id, principal_id, idempotency_key)
  `.execute(db);
}

async function rollbackSessionScopedIdempotency(
  db: Kysely<DatabaseSchema>,
): Promise<void> {
  await sql`
    do $migration$
    begin
      if exists (
        select 1
        from odyshell.operations
        where idempotency_key is not null
        group by principal_id, idempotency_key
        having count(*) > 1
      )
      then
        raise exception
          'Cannot restore global principal idempotency after cross-Session keys exist';
      end if;
    end
    $migration$
  `.execute(db);
  await sql`
    alter table odyshell.operations
    drop constraint if exists operations_session_principal_idempotency_unique
  `.execute(db);
  await sql`
    alter table odyshell.operations
    add constraint operations_principal_idempotency_unique
    unique (principal_id, idempotency_key)
  `.execute(db);
}

async function migrateTypedMachineScopes(
  db: Kysely<DatabaseSchema>,
): Promise<void> {
  await sql`
    alter table odyshell.agent_session_requests
    add column if not exists scopes jsonb
  `.execute(db);
  await sql`
    update odyshell.agent_session_requests
    set scopes = jsonb_build_array(
      jsonb_build_object(
        'machineId', machine_id,
        'profile', 'workspace',
        'capabilities', '["fs.read"]'::jsonb,
        'restrictions', jsonb_build_object(
          'filesystem', jsonb_build_object(
            'paths', jsonb_build_array(
              jsonb_build_object(
                'path', read_path,
                'includeDescendants', false
              )
            )
          )
        )
      )
    )
    where scopes is null
  `.execute(db);
  await sql`
    alter table odyshell.agent_session_requests
    alter column scopes set not null
  `.execute(db);

  await sql`
    alter table odyshell.agent_session_targets
    add column if not exists profile text not null default 'workspace',
    add column if not exists restrictions jsonb,
    add column if not exists runtime_session_id text
  `.execute(db);
  await sql`
    update odyshell.agent_session_targets
    set restrictions = jsonb_build_object(
      'filesystem', jsonb_build_object(
        'paths', jsonb_build_array(
          jsonb_build_object(
            'path', read_path,
            'includeDescendants', false
          )
        )
      )
    )
    where restrictions is null
  `.execute(db);
  await sql`
    update odyshell.agent_session_targets
    set runtime_session_id = session_id
    where runtime_session_id is null
  `.execute(db);
  await sql`
    alter table odyshell.agent_session_targets
    alter column restrictions set not null,
    alter column runtime_session_id set not null
  `.execute(db);
  await sql`
    alter table odyshell.agent_session_targets
    drop constraint if exists agent_session_targets_check,
    drop constraint if exists agent_session_targets_capabilities_check
  `.execute(db);
  await sql`
    create unique index if not exists agent_session_targets_runtime_idx
    on odyshell.agent_session_targets (runtime_session_id)
  `.execute(db);
}

async function rollbackTypedMachineScopes(
  db: Kysely<DatabaseSchema>,
): Promise<void> {
  await sql`
    do $migration$
    begin
      if exists (
        select 1
        from odyshell.agent_session_requests
        where jsonb_array_length(scopes) <> 1
          or scopes #>> '{0,capabilities,0}' <> 'fs.read'
          or jsonb_array_length(scopes #> '{0,capabilities}') <> 1
      )
      then
        raise exception 'Cannot roll back typed scopes after expanded scope data exists';
      end if;
    end
    $migration$
  `.execute(db);
  await sql`
    drop index if exists odyshell.agent_session_targets_runtime_idx
  `.execute(db);
  await sql`
    alter table odyshell.agent_session_targets
    drop column runtime_session_id,
    drop column restrictions,
    drop column profile
  `.execute(db);
  await sql`
    alter table odyshell.agent_session_requests
    drop column scopes
  `.execute(db);
}

async function migrateSessionRenewalLinks(
  db: Kysely<DatabaseSchema>,
): Promise<void> {
  await sql`
    alter table odyshell.agent_session_requests
    add column if not exists predecessor_session_id text
  `.execute(db);
  await sql`
    do $migration$
    begin
      if not exists (
        select 1
        from pg_constraint
        where conname = 'agent_session_requests_predecessor_fk'
          and connamespace = 'odyshell'::regnamespace
      )
      then
        alter table odyshell.agent_session_requests
        add constraint agent_session_requests_predecessor_fk
        foreign key (workspace_id, predecessor_session_id)
        references odyshell.agent_sessions (workspace_id, id);
      end if;
    end
    $migration$
  `.execute(db);
}

async function rollbackSessionRenewalLinks(
  db: Kysely<DatabaseSchema>,
): Promise<void> {
  await sql`
    alter table odyshell.agent_session_requests
    drop column predecessor_session_id
  `.execute(db);
}

async function migrateAgentDeviceAuthorization(
  db: Kysely<DatabaseSchema>,
): Promise<void> {
  await sql`
    create table if not exists odyshell.agent_device_authorizations (
      id text primary key,
      device_code_hash text not null unique,
      user_code_hash text not null unique,
      agent_name text not null,
      status text not null check (
        status in ('pending', 'approved', 'consumed', 'denied')
      ),
      workspace_id text,
      user_id text,
      agent_id text,
      expires_at timestamptz not null,
      approved_at timestamptz,
      consumed_at timestamptz,
      created_at timestamptz not null default now(),
      foreign key (workspace_id) references odyshell.workspaces (id),
      check (length(btrim(agent_name)) between 1 and 80)
    )
  `.execute(db);
  await sql`
    create index if not exists agent_device_authorizations_expiry_idx
    on odyshell.agent_device_authorizations (expires_at)
  `.execute(db);
  await sql`
    create unique index if not exists agent_credentials_token_hash_global_idx
    on odyshell.agent_credentials (token_hash)
  `.execute(db);
}

async function rollbackAgentDeviceAuthorization(
  db: Kysely<DatabaseSchema>,
): Promise<void> {
  await sql`
    drop index if exists odyshell.agent_credentials_token_hash_global_idx
  `.execute(db);
  await sql`drop table odyshell.agent_device_authorizations`.execute(db);
}

async function migrateAgentAutoapprovalPolicies(
  db: Kysely<DatabaseSchema>,
): Promise<void> {
  await sql`
    create table if not exists odyshell.agent_policies (
      workspace_id text not null,
      id text not null,
      agent_id text not null,
      version integer not null,
      status text not null check (
        status in ('proposed', 'active', 'paused', 'revoked', 'replaced')
      ),
      scopes jsonb not null,
      max_session_seconds integer not null,
      expires_at timestamptz not null,
      approval_code_hash text not null,
      approved_by_human_id text,
      approved_at timestamptz,
      predecessor_policy_id text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      primary key (workspace_id, id),
      unique (workspace_id, id, version),
      unique (workspace_id, agent_id, version),
      unique (workspace_id, approval_code_hash),
      foreign key (workspace_id, agent_id)
        references odyshell.agents (workspace_id, id),
      foreign key (workspace_id, approved_by_human_id)
        references odyshell.humans (workspace_id, id),
      foreign key (workspace_id, predecessor_policy_id)
        references odyshell.agent_policies (workspace_id, id),
      check (version > 0),
      check (jsonb_typeof(scopes) = 'array' and jsonb_array_length(scopes) > 0),
      check (max_session_seconds between 60 and 86400),
      check (expires_at > created_at),
      check (expires_at <= created_at + interval '1 year'),
      check (predecessor_policy_id is null or predecessor_policy_id <> id)
    )
  `.execute(db);
  await sql`
    create unique index if not exists agent_policies_one_active_idx
    on odyshell.agent_policies (workspace_id, agent_id)
    where status = 'active'
  `.execute(db);
  await sql`
    create index if not exists agent_policies_history_idx
    on odyshell.agent_policies (workspace_id, agent_id, version desc)
  `.execute(db);
  await sql`
    alter table odyshell.agent_session_requests
    add column if not exists autoapproval_policy_id text,
    add column if not exists autoapproval_policy_version integer
  `.execute(db);
  await sql`
    alter table odyshell.agent_sessions
    add column if not exists autoapproval_policy_id text,
    add column if not exists autoapproval_policy_version integer
  `.execute(db);
  await sql`
    alter table odyshell.agent_session_requests
    add constraint agent_session_requests_autoapproval_policy_fk
    foreign key (
      workspace_id,
      autoapproval_policy_id,
      autoapproval_policy_version
    )
    references odyshell.agent_policies (workspace_id, id, version)
  `.execute(db);
  await sql`
    alter table odyshell.agent_sessions
    add constraint agent_sessions_autoapproval_policy_fk
    foreign key (
      workspace_id,
      autoapproval_policy_id,
      autoapproval_policy_version
    )
    references odyshell.agent_policies (workspace_id, id, version)
  `.execute(db);
  await sql`
    alter table odyshell.agent_session_requests
    add constraint agent_session_requests_autoapproval_pair
    check (
      (autoapproval_policy_id is null and autoapproval_policy_version is null)
      or
      (autoapproval_policy_id is not null and autoapproval_policy_version is not null)
    )
  `.execute(db);
  await sql`
    alter table odyshell.agent_sessions
    add constraint agent_sessions_autoapproval_pair
    check (
      (autoapproval_policy_id is null and autoapproval_policy_version is null)
      or
      (autoapproval_policy_id is not null and autoapproval_policy_version is not null)
    )
  `.execute(db);
}

async function rollbackAgentAutoapprovalPolicies(
  db: Kysely<DatabaseSchema>,
): Promise<void> {
  await sql`
    alter table odyshell.agent_sessions
    drop constraint agent_sessions_autoapproval_pair,
    drop constraint agent_sessions_autoapproval_policy_fk,
    drop column autoapproval_policy_version,
    drop column autoapproval_policy_id
  `.execute(db);
  await sql`
    alter table odyshell.agent_session_requests
    drop constraint agent_session_requests_autoapproval_pair,
    drop constraint agent_session_requests_autoapproval_policy_fk,
    drop column autoapproval_policy_version,
    drop column autoapproval_policy_id
  `.execute(db);
  await sql`drop table odyshell.agent_policies`.execute(db);
}

async function migrateManagedAgentDelegation(
  db: Kysely<DatabaseSchema>,
): Promise<void> {
  await sql`
    alter table odyshell.agents
    add column deleted_at timestamptz
  `.execute(db);
  await sql`
    alter table odyshell.agent_policies
    add column kind text not null default 'autoapproval',
    add column max_managed_agents integer,
    add column delegation_policy_id text,
    add column delegation_policy_version integer
  `.execute(db);
  await sql`
    drop index odyshell.agent_policies_one_active_idx
  `.execute(db);
  await sql`
    create unique index agent_policies_one_active_kind_idx
    on odyshell.agent_policies (workspace_id, agent_id, kind)
    where status = 'active'
  `.execute(db);
  await sql`
    alter table odyshell.agent_policies
    add constraint agent_policies_kind_check
      check (kind in ('autoapproval', 'delegation', 'managed')),
    add constraint agent_policies_managed_limit_check
      check (
        (kind = 'delegation' and max_managed_agents between 1 and 100)
        or (kind <> 'delegation' and max_managed_agents is null)
      ),
    add constraint agent_policies_delegation_pair_check
      check (
        (kind = 'managed' and delegation_policy_id is not null
          and delegation_policy_version is not null)
        or
        (kind <> 'managed' and delegation_policy_id is null
          and delegation_policy_version is null)
      ),
    add constraint agent_policies_delegation_fk
      foreign key (
        workspace_id,
        delegation_policy_id,
        delegation_policy_version
      )
      references odyshell.agent_policies (workspace_id, id, version)
  `.execute(db);
  await sql`
    alter table odyshell.agent_session_requests
    add column requested_by_agent_id text,
    add column run_id text,
    add constraint agent_session_requests_requester_agent_fk
      foreign key (workspace_id, requested_by_agent_id)
      references odyshell.agents (workspace_id, id),
    add constraint agent_session_requests_run_id_length
      check (run_id is null or length(run_id) between 1 and 128)
  `.execute(db);
  await sql`
    create index agent_session_requests_requester_idx
    on odyshell.agent_session_requests (
      workspace_id,
      requested_by_agent_id,
      created_at
    )
  `.execute(db);
}

async function rollbackManagedAgentDelegation(
  db: Kysely<DatabaseSchema>,
): Promise<void> {
  await sql`
    do $$
    begin
      if exists (
        select 1 from odyshell.agents where kind = 'managed'
      ) or exists (
        select 1 from odyshell.agent_policies
        where kind <> 'autoapproval'
      ) or exists (
        select 1 from odyshell.agent_session_requests
        where requested_by_agent_id is not null or run_id is not null
      ) then
        raise exception
          'Cannot roll back Managed Agent delegation while derived records exist';
      end if;
    end
    $$
  `.execute(db);
  await sql`
    drop index odyshell.agent_policies_one_active_kind_idx
  `.execute(db);
  await sql`
    create unique index agent_policies_one_active_idx
    on odyshell.agent_policies (workspace_id, agent_id)
    where status = 'active'
  `.execute(db);
  await sql`
    alter table odyshell.agent_session_requests
    drop constraint agent_session_requests_run_id_length,
    drop constraint agent_session_requests_requester_agent_fk,
    drop column run_id,
    drop column requested_by_agent_id
  `.execute(db);
  await sql`
    alter table odyshell.agent_policies
    drop constraint agent_policies_delegation_fk,
    drop constraint agent_policies_delegation_pair_check,
    drop constraint agent_policies_managed_limit_check,
    drop constraint agent_policies_kind_check,
    drop column delegation_policy_version,
    drop column delegation_policy_id,
    drop column max_managed_agents,
    drop column kind
  `.execute(db);
  await sql`
    alter table odyshell.agents
    drop column deleted_at
  `.execute(db);
}

async function migrateTimelineEventSinks(
  db: Kysely<DatabaseSchema>,
): Promise<void> {
  await sql`
    create table odyshell.event_sinks (
      workspace_id text primary key
        references odyshell.workspaces (id) on delete cascade,
      id text not null,
      endpoint text not null,
      detail_level text not null check (
        detail_level in ('privacy-minimal', 'operational', 'diagnostic')
      ),
      secret_ciphertext text not null,
      secret_last_four text not null,
      status text not null default 'active' check (status in ('active', 'paused')),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (workspace_id, id),
      check (length(endpoint) between 1 and 2048),
      check (length(secret_last_four) = 4)
    )
  `.execute(db);
  await sql`
    create table odyshell.event_sink_deliveries (
      workspace_id text not null,
      id text not null,
      sink_id text not null,
      event_id text not null,
      status text not null default 'pending' check (
        status in ('pending', 'retrying', 'delivered', 'failed')
      ),
      attempts integer not null default 0 check (attempts between 0 and 8),
      next_attempt_at timestamptz not null default now(),
      last_error text,
      delivered_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      primary key (workspace_id, id),
      unique (workspace_id, sink_id, event_id),
      foreign key (workspace_id, sink_id)
        references odyshell.event_sinks (workspace_id, id) on delete cascade,
      foreign key (workspace_id, event_id)
        references odyshell.session_timeline_events (workspace_id, id) on delete cascade
    )
  `.execute(db);
  await sql`
    create index event_sink_deliveries_due_idx
    on odyshell.event_sink_deliveries (status, next_attempt_at)
    where status in ('pending', 'retrying')
  `.execute(db);
}

async function rollbackTimelineEventSinks(
  db: Kysely<DatabaseSchema>,
): Promise<void> {
  await sql`drop table odyshell.event_sink_deliveries`.execute(db);
  await sql`drop table odyshell.event_sinks`.execute(db);
}

async function migrateAuthorityCutover(
  db: Kysely<DatabaseSchema>,
): Promise<void> {
  await sql`
    create table odyshell.authority_cutovers (
      workspace_id text primary key
        references odyshell.workspaces (id) on delete cascade,
      status text not null check (status = 'complete'),
      legacy_agent_tokens_revoked integer not null check (
        legacy_agent_tokens_revoked >= 0
      ),
      legacy_sessions_closed integer not null check (
        legacy_sessions_closed >= 0
      ),
      legacy_operations_cancelled integer not null check (
        legacy_operations_cancelled >= 0
      ),
      completed_at timestamptz not null default now()
    )
  `.execute(db);
  await sql`
    insert into odyshell.authority_cutovers (
      workspace_id,
      status,
      legacy_agent_tokens_revoked,
      legacy_sessions_closed,
      legacy_operations_cancelled
    )
    select
      workspace.id,
      'complete',
      (
        select count(*)::integer
        from odyshell.agent_tokens token
        where token.workspace_id = workspace.id
          and token.revoked_at is null
      ),
      (
        select count(*)::integer
        from odyshell.sessions session
        where session.workspace_id = workspace.id
          and session.status in ('opening', 'ready', 'closing')
          and not exists (
            select 1
            from odyshell.agent_session_targets target
            where target.workspace_id = session.workspace_id
              and target.runtime_session_id = session.id
          )
      ),
      (
        select count(*)::integer
        from odyshell.operations operation
        join odyshell.sessions session
          on session.workspace_id = operation.workspace_id
          and session.id = operation.session_id
        where operation.workspace_id = workspace.id
          and operation.status in ('queued', 'delivered', 'running')
          and not exists (
            select 1
            from odyshell.agent_session_targets target
            where target.workspace_id = session.workspace_id
              and target.runtime_session_id = session.id
          )
      )
    from odyshell.workspaces workspace
  `.execute(db);
  await sql`
    insert into odyshell.agents (
      workspace_id,
      id,
      name,
      kind,
      parent_agent_id,
      created_by_human_id,
      status,
      deleted_at,
      created_at,
      updated_at
    )
    select
      token.workspace_id,
      token.id,
      token.name,
      'independent',
      null,
      null,
      'disabled',
      token.deleted_at,
      token.created_at,
      now()
    from odyshell.agent_tokens token
    on conflict (workspace_id, id) do nothing
  `.execute(db);
  await sql`
    update odyshell.operations operation
    set
      status = 'cancelled',
      error = 'legacy_authority_migrated',
      updated_at = now()
    from odyshell.sessions session
    where session.workspace_id = operation.workspace_id
      and session.id = operation.session_id
      and operation.status in ('queued', 'delivered', 'running')
      and not exists (
        select 1
        from odyshell.agent_session_targets target
        where target.workspace_id = session.workspace_id
          and target.runtime_session_id = session.id
      )
  `.execute(db);
  await sql`
    update odyshell.sessions session
    set
      status = 'closed',
      error = 'legacy_authority_migrated',
      updated_at = now()
    where session.status in ('opening', 'ready', 'closing')
      and not exists (
        select 1
        from odyshell.agent_session_targets target
        where target.workspace_id = session.workspace_id
          and target.runtime_session_id = session.id
      )
  `.execute(db);
  await sql`
    update odyshell.agent_tokens
    set revoked_at = coalesce(revoked_at, now())
    where revoked_at is null
  `.execute(db);
  await sql`
    insert into odyshell.audit_events (
      workspace_id,
      id,
      principal_id,
      action,
      target_type,
      target_id,
      metadata
    )
    select
      cutover.workspace_id,
      gen_random_uuid()::text,
      'system',
      'authority.cutover_completed',
      'workspace',
      cutover.workspace_id,
      jsonb_build_object(
        'legacyAgentTokensRevoked', cutover.legacy_agent_tokens_revoked,
        'legacySessionsClosed', cutover.legacy_sessions_closed,
        'legacyOperationsCancelled', cutover.legacy_operations_cancelled
      )
    from odyshell.authority_cutovers cutover
  `.execute(db);
}

async function rollbackAuthorityCutover(
  db: Kysely<DatabaseSchema>,
): Promise<void> {
  await sql`
    delete from odyshell.audit_events
    where action = 'authority.cutover_completed'
  `.execute(db);
  await sql`drop table odyshell.authority_cutovers`.execute(db);
}

async function migrateRemoteMcp(db: Kysely<DatabaseSchema>): Promise<void> {
  await sql`
    create table odyshell.mcp_installations (
      workspace_id text not null,
      id text not null,
      provider text not null check (provider = 'clerk'),
      user_id text not null,
      oauth_client_id text not null,
      agent_id text not null,
      status text not null check (status in ('active', 'revoked')),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      primary key (workspace_id, id),
      unique (workspace_id, provider, user_id, oauth_client_id),
      foreign key (workspace_id, agent_id)
        references odyshell.agents (workspace_id, id)
    )
  `.execute(db);
  await sql`
    create table odyshell.mcp_session_grants (
      workspace_id text not null,
      installation_id text not null,
      session_id text not null,
      status text not null check (status in ('active', 'revoked')),
      created_at timestamptz not null default now(),
      revoked_at timestamptz,
      primary key (workspace_id, installation_id, session_id),
      foreign key (workspace_id, installation_id)
        references odyshell.mcp_installations (workspace_id, id),
      foreign key (workspace_id, session_id)
        references odyshell.agent_sessions (workspace_id, id)
    )
  `.execute(db);
  await sql`
    create index mcp_session_grants_session_idx
    on odyshell.mcp_session_grants (workspace_id, session_id, status)
  `.execute(db);
}

async function rollbackRemoteMcp(db: Kysely<DatabaseSchema>): Promise<void> {
  await sql`drop table odyshell.mcp_session_grants`.execute(db);
  await sql`drop table odyshell.mcp_installations`.execute(db);
}

const migrationProvider: MigrationProvider = {
  async getMigrations(): Promise<Record<string, Migration>> {
    return {
      "001_initial_schema": {
        up: migrateInitialSchema,
      },
      "002_privacy_defaults": {
        up: redactHistoricalAuditMetadata,
      },
      "003_organization_boundaries": {
        up: migrateOrganizationBoundaries,
      },
      "004_cloud_identity": {
        up: migrateCloudIdentity,
      },
      "005_agent_deletion": {
        up: migrateAgentDeletion,
      },
      "006_expand_identity_authority": {
        up: migrateIdentityAuthorityExpand,
        down: rollbackIdentityAuthorityExpand,
      },
      "007_approved_read_sessions": {
        up: migrateApprovedReadSessions,
        down: rollbackApprovedReadSessions,
      },
      "008_global_session_credential_hash": {
        up: migrateGlobalSessionCredentialHash,
        down: rollbackGlobalSessionCredentialHash,
      },
      "009_session_scoped_idempotency": {
        up: migrateSessionScopedIdempotency,
        down: rollbackSessionScopedIdempotency,
      },
      "010_typed_machine_scopes": {
        up: migrateTypedMachineScopes,
        down: rollbackTypedMachineScopes,
      },
      "011_session_renewal_links": {
        up: migrateSessionRenewalLinks,
        down: rollbackSessionRenewalLinks,
      },
      "012_agent_device_authorization": {
        up: migrateAgentDeviceAuthorization,
        down: rollbackAgentDeviceAuthorization,
      },
      "013_agent_autoapproval_policies": {
        up: migrateAgentAutoapprovalPolicies,
        down: rollbackAgentAutoapprovalPolicies,
      },
      "014_managed_agent_delegation": {
        up: migrateManagedAgentDelegation,
        down: rollbackManagedAgentDelegation,
      },
      "015_timeline_event_sinks": {
        up: migrateTimelineEventSinks,
        down: rollbackTimelineEventSinks,
      },
      "016_authority_cutover": {
        up: migrateAuthorityCutover,
        down: rollbackAuthorityCutover,
      },
      "017_remote_mcp": {
        up: migrateRemoteMcp,
        down: rollbackRemoteMcp,
      },
    };
  },
};

export class PostgresDatabase {
  private readonly root: Kysely<DatabaseSchema>;
  private readonly db: Kysely<DatabaseSchema>;

  constructor(connectionString: string) {
    this.root = new Kysely<DatabaseSchema>({
      dialect: new PostgresDialect({
        pool: new Pool({
          connectionString,
          max: 10,
          connectionTimeoutMillis: 10_000,
        }),
      }),
      plugins: [new CamelCasePlugin()],
    });
    this.db = this.root.withSchema(DATABASE_SCHEMA);
  }

  async initialize(): Promise<void> {
    const migrator = new Migrator({
      db: this.root,
      provider: migrationProvider,
      migrationTableSchema: DATABASE_SCHEMA,
    });
    await sql`create schema if not exists ${sql.id(DATABASE_SCHEMA)}`.execute(this.root);
    const { error, results } = await migrator.migrateToLatest();
    for (const result of results ?? []) {
      if (result.status === "Error") {
        throw new Error(`Database migration ${result.migrationName} failed`);
      }
    }
    if (error) throw error;

    await this.db
      .insertInto("organizations")
      .values({
        id: DEFAULT_ORGANIZATION_ID,
        slug: "default",
        name: "Default organization",
      })
      .onConflict((conflict) => conflict.column("id").doNothing())
      .execute();
    await this.db
      .insertInto("workspaces")
      .values({
        id: DEFAULT_WORKSPACE_ID,
        organizationId: DEFAULT_ORGANIZATION_ID,
        slug: "default",
        name: "Default workspace",
      })
      .onConflict((conflict) => conflict.column("id").doNothing())
      .execute();
    await this.db
      .insertInto("authorityCutovers")
      .values({
        workspaceId: DEFAULT_WORKSPACE_ID,
        status: "complete",
        legacyAgentTokensRevoked: 0,
        legacySessionsClosed: 0,
        legacyOperationsCancelled: 0,
      })
      .onConflict((conflict) => conflict.column("workspaceId").doNothing())
      .execute();
    await this.assertAuthorityCutover();
    await this.db
      .updateTable("machines")
      .set({ status: "offline" })
      .where("status", "!=", "offline")
      .execute();
  }

  async close(): Promise<void> {
    await this.root.destroy();
  }

  async health(): Promise<void> {
    await sql`select 1`.execute(this.db);
  }

  async listOrganizations(): Promise<OrganizationRecord[]> {
    return (
      await this.db
        .selectFrom("organizations")
        .selectAll()
        .orderBy("createdAt", "asc")
        .execute()
    ).map(organizationRecord);
  }

  async createOrganization(input: {
    id: string;
    slug: string;
    name: string;
  }): Promise<OrganizationRecord> {
    return organizationRecord(
      await this.db
        .insertInto("organizations")
        .values(input)
        .returningAll()
      .executeTakeFirstOrThrow(),
    );
  }

  async ensureCloudContext(input: {
    externalId: string;
    slug: string;
    name: string;
  }): Promise<{ organization: OrganizationRecord; workspace: WorkspaceRecord }> {
    return await this.db.transaction().execute(async (transaction) => {
      await sql`select pg_advisory_xact_lock(hashtext(${input.externalId}))`.execute(
        transaction,
      );
      let organization = await transaction
        .selectFrom("organizations")
        .selectAll()
        .where("externalId", "=", input.externalId)
        .executeTakeFirst();
      if (!organization) {
        organization = await transaction
          .insertInto("organizations")
          .values({
            id: randomUUID(),
            externalId: input.externalId,
            slug: input.slug,
            name: input.name,
            plan: "free",
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      } else if (organization.name !== input.name) {
        organization = await transaction
          .updateTable("organizations")
          .set({ name: input.name })
          .where("id", "=", organization.id)
          .returningAll()
          .executeTakeFirstOrThrow();
      }

      let workspace = await transaction
        .selectFrom("workspaces")
        .selectAll()
        .where("organizationId", "=", organization.id)
        .orderBy("createdAt", "asc")
        .executeTakeFirst();
      if (!workspace) {
        workspace = await transaction
          .insertInto("workspaces")
          .values({
            id: randomUUID(),
            organizationId: organization.id,
            slug: "default",
            name: "Default workspace",
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      }
      await transaction
        .insertInto("authorityCutovers")
        .values({
          workspaceId: workspace.id,
          status: "complete",
          legacyAgentTokensRevoked: 0,
          legacySessionsClosed: 0,
          legacyOperationsCancelled: 0,
        })
        .onConflict((conflict) => conflict.column("workspaceId").doNothing())
        .execute();
      return {
        organization: organizationRecord(organization),
        workspace: workspaceRecord(workspace),
      };
    });
  }

  async workspacePlan(workspaceId: string): Promise<{
    plan: CloudPlanId;
    activeMachines: number;
    activeAgents: number;
    cloudManaged: boolean;
  } | null> {
    const workspace = await this.db
      .selectFrom("workspaces")
      .innerJoin("organizations", "organizations.id", "workspaces.organizationId")
      .select(["organizations.plan", "organizations.externalId"])
      .where("workspaces.id", "=", workspaceId)
      .executeTakeFirst();
    if (!workspace) return null;
    const count = await this.db
      .selectFrom("machines")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("workspaceId", "=", workspaceId)
      .where("revokedAt", "is", null)
      .executeTakeFirstOrThrow();
    const agents = await this.db
      .selectFrom("agents")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("workspaceId", "=", workspaceId)
      .where("deletedAt", "is", null)
      .where("status", "=", "active")
      .executeTakeFirstOrThrow();
    return {
      plan: workspace.plan as CloudPlanId,
      activeMachines: Number(count.count),
      activeAgents: Number(agents.count),
      cloudManaged: workspace.externalId !== null,
    };
  }

  async mcpWorkspace(workspaceId: string): Promise<McpWorkspaceRecord | null> {
    const workspace = await this.db
      .selectFrom("workspaces")
      .innerJoin("organizations", "organizations.id", "workspaces.organizationId")
      .select([
        "workspaces.id as workspaceId",
        "workspaces.name as workspaceName",
        "organizations.externalId as organizationExternalId",
      ])
      .where("workspaces.id", "=", workspaceId)
      .where("organizations.externalId", "is not", null)
      .executeTakeFirst();
    return workspace?.organizationExternalId
      ? {
          workspaceId: workspace.workspaceId,
          workspaceName: workspace.workspaceName,
          organizationExternalId: workspace.organizationExternalId,
        }
      : null;
  }

  async mcpWorkspacesForOrganizations(
    organizationExternalIds: string[],
  ): Promise<McpWorkspaceRecord[]> {
    if (organizationExternalIds.length === 0) return [];
    const rows = await this.db
      .selectFrom("workspaces")
      .innerJoin("organizations", "organizations.id", "workspaces.organizationId")
      .select([
        "workspaces.id as workspaceId",
        "workspaces.name as workspaceName",
        "organizations.externalId as organizationExternalId",
      ])
      .where("organizations.externalId", "in", organizationExternalIds)
      .orderBy("workspaces.createdAt", "asc")
      .execute();
    return rows.flatMap((row) =>
      row.organizationExternalId
        ? [{ ...row, organizationExternalId: row.organizationExternalId }]
        : [],
    );
  }

  async authorityCutoverReport(): Promise<AuthorityCutoverInvariant> {
    const result = await sql<{
      missingWorkspaces: string;
      activeLegacyTokens: string;
      activeLegacySessions: string;
      activeLegacyOperations: string;
    }>`
      select
        (
          select count(*)
          from odyshell.workspaces workspace
          left join odyshell.authority_cutovers cutover
            on cutover.workspace_id = workspace.id
          where cutover.workspace_id is null
             or cutover.status <> 'complete'
        )::text as "missingWorkspaces",
        (
          select count(*)
          from odyshell.agent_tokens
          where revoked_at is null
        )::text as "activeLegacyTokens",
        (
          select count(*)
          from odyshell.sessions session
          where session.status in ('opening', 'ready', 'closing')
            and not exists (
              select 1
              from odyshell.agent_session_targets target
              where target.workspace_id = session.workspace_id
                and target.runtime_session_id = session.id
            )
        )::text as "activeLegacySessions",
        (
          select count(*)
          from odyshell.operations operation
          join odyshell.sessions session
            on session.workspace_id = operation.workspace_id
            and session.id = operation.session_id
          where operation.status in ('queued', 'delivered', 'running')
            and not exists (
              select 1
              from odyshell.agent_session_targets target
              where target.workspace_id = session.workspace_id
                and target.runtime_session_id = session.id
            )
        )::text as "activeLegacyOperations"
    `.execute(this.root);
    const row = result.rows[0]!;
    return {
      missingWorkspaces: Number(row.missingWorkspaces),
      activeLegacyTokens: Number(row.activeLegacyTokens),
      activeLegacySessions: Number(row.activeLegacySessions),
      activeLegacyOperations: Number(row.activeLegacyOperations),
    };
  }

  async assertAuthorityCutover(): Promise<void> {
    assertAuthorityCutoverInvariant(await this.authorityCutoverReport());
  }

  async workspaceConnections(workspaceId: string): Promise<{
    activeConnections: number;
    connectedAgents: number;
    connections: Array<{
      id: string;
      machineId: string;
      principalId: string;
      status: string;
    }>;
  }> {
    const connections = await this.db
      .selectFrom("sessions")
      .select(["id", "machineId", "principalId", "status"])
      .where("workspaceId", "=", workspaceId)
      .where("status", "in", ACTIVE_SESSION_STATUSES)
      .orderBy("createdAt", "asc")
      .execute();
    return {
      activeConnections: connections.length,
      connectedAgents: new Set(
        connections.map((connection) => connection.principalId),
      ).size,
      connections,
    };
  }

  async listWorkspaces(organizationId?: string): Promise<WorkspaceRecord[]> {
    let query = this.db.selectFrom("workspaces").selectAll();
    if (organizationId !== undefined) {
      query = query.where("organizationId", "=", organizationId);
    }
    return (await query.orderBy("createdAt", "asc").execute()).map(workspaceRecord);
  }

  async workspace(workspaceId: string): Promise<WorkspaceRecord | null> {
    const workspace = await this.db
      .selectFrom("workspaces")
      .selectAll()
      .where("id", "=", workspaceId)
      .executeTakeFirst();
    return workspace ? workspaceRecord(workspace) : null;
  }

  async createWorkspace(input: {
    id: string;
    organizationId: string;
    slug: string;
    name: string;
  }): Promise<WorkspaceRecord | null> {
    return await this.db.transaction().execute(async (transaction) => {
      const organization = await transaction
        .selectFrom("organizations")
        .select("id")
        .where("id", "=", input.organizationId)
        .executeTakeFirst();
      if (!organization) return null;
      const workspace = await transaction
        .insertInto("workspaces")
        .values(input)
        .returningAll()
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("authorityCutovers")
        .values({
          workspaceId: workspace.id,
          status: "complete",
          legacyAgentTokensRevoked: 0,
          legacySessionsClosed: 0,
          legacyOperationsCancelled: 0,
        })
        .execute();
      return workspaceRecord(workspace);
    });
  }

  async createHumanIdentity(input: {
    workspaceId: string;
    id: string;
    externalId: string;
  }): Promise<HumanIdentityRecord | null> {
    const human = await this.db
      .insertInto("humans")
      .values({
        ...input,
        status: "active",
      })
      .onConflict((conflict) =>
        conflict.columns(["workspaceId", "id"]).doNothing(),
      )
      .returningAll()
      .executeTakeFirst();
    return human ? humanIdentityRecord(human) : null;
  }

  async createAgentIdentity(input: {
    workspaceId: string;
    id: string;
    name: string;
    kind: "independent" | "managed";
    parentAgentId: string | null;
    createdByHumanId: string;
  }): Promise<AgentIdentityRecord | null> {
    if (
      (input.kind === "independent" && input.parentAgentId !== null) ||
      (input.kind === "managed" && input.parentAgentId === null) ||
      input.parentAgentId === input.id
    ) {
      return null;
    }
    return await this.db.transaction().execute(async (transaction) => {
      const human = await transaction
        .selectFrom("humans")
        .select("id")
        .where("workspaceId", "=", input.workspaceId)
        .where("id", "=", input.createdByHumanId)
        .where("status", "=", "active")
        .forShare()
        .executeTakeFirst();
      if (!human) return null;

      if (input.parentAgentId !== null) {
        const parent = await transaction
          .selectFrom("agents")
          .select("id")
          .where("workspaceId", "=", input.workspaceId)
          .where("id", "=", input.parentAgentId)
          .where("kind", "=", "independent")
          .where("status", "=", "active")
          .forShare()
          .executeTakeFirst();
        if (!parent) return null;
      }

      const agent = await transaction
        .insertInto("agents")
        .values({
          ...input,
          status: "active",
          deletedAt: null,
        })
        .onConflict((conflict) =>
          conflict.columns(["workspaceId", "id"]).doNothing(),
        )
        .returningAll()
        .executeTakeFirst();
      return agent ? agentIdentityRecord(agent) : null;
    });
  }

  async ensureMcpInstallation(input: {
    workspaceId: string;
    userId: string;
    oauthClientId: string;
    agentName: string;
  }): Promise<McpInstallationRecord | null> {
    return await this.db.transaction().execute(async (transaction) => {
      await transaction
        .insertInto("humans")
        .values({
          workspaceId: input.workspaceId,
          id: input.userId,
          externalId: input.userId,
          status: "active",
        })
        .onConflict((conflict) =>
          conflict.columns(["workspaceId", "id"]).doNothing(),
        )
        .execute();
      const existing = await transaction
        .selectFrom("mcpInstallations")
        .innerJoin("agents", (join) =>
          join
            .onRef("agents.workspaceId", "=", "mcpInstallations.workspaceId")
            .onRef("agents.id", "=", "mcpInstallations.agentId"),
        )
        .selectAll("mcpInstallations")
        .select("agents.name as agentName")
        .where("mcpInstallations.workspaceId", "=", input.workspaceId)
        .where("mcpInstallations.provider", "=", "clerk")
        .where("mcpInstallations.userId", "=", input.userId)
        .where("mcpInstallations.oauthClientId", "=", input.oauthClientId)
        .executeTakeFirst();
      if (existing) {
        if (existing.status !== "active") return null;
        const genericName = /^(MCP Agent|MCP)$/i.test(existing.agentName);
        const agentName = genericName ? input.agentName : existing.agentName;
        if (agentName !== existing.agentName) {
          await transaction
            .updateTable("agents")
            .set({ name: agentName, updatedAt: new Date() })
            .where("workspaceId", "=", input.workspaceId)
            .where("id", "=", existing.agentId)
            .execute();
        }
        return {
          workspaceId: existing.workspaceId,
          id: existing.id,
          userId: existing.userId,
          oauthClientId: existing.oauthClientId,
          agentId: existing.agentId,
          agentName,
          status: "active",
          createdAt: timestamp(existing.createdAt),
          updatedAt: timestamp(existing.updatedAt),
        };
      }

      const now = new Date();
      const agentId = randomUUID();
      const installationId = randomUUID();
      const agent = await transaction
        .insertInto("agents")
        .values({
          workspaceId: input.workspaceId,
          id: agentId,
          name: input.agentName,
          kind: "independent",
          parentAgentId: null,
          createdByHumanId: input.userId,
          status: "active",
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const installation = await transaction
        .insertInto("mcpInstallations")
        .values({
          workspaceId: input.workspaceId,
          id: installationId,
          provider: "clerk",
          userId: input.userId,
          oauthClientId: input.oauthClientId,
          agentId,
          status: "active",
          createdAt: now,
          updatedAt: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return {
        workspaceId: installation.workspaceId,
        id: installation.id,
        userId: installation.userId,
        oauthClientId: installation.oauthClientId,
        agentId: installation.agentId,
        agentName: agent.name,
        status: "active",
        createdAt: timestamp(installation.createdAt),
        updatedAt: timestamp(installation.updatedAt),
      };
    });
  }

  async getAgentIdentity(
    workspaceId: string,
    agentId: string,
  ): Promise<AgentIdentityRecord | null> {
    const agent = await this.db
      .selectFrom("agents")
      .selectAll()
      .where("workspaceId", "=", workspaceId)
      .where("id", "=", agentId)
      .executeTakeFirst();
    return agent ? agentIdentityRecord(agent) : null;
  }

  async createAgentSession(input: {
    workspaceId: string;
    id: string;
    agentId: string;
    purpose: string;
    createdAt: number;
    expiresAt: number;
    predecessorSessionId: string | null;
  }): Promise<AgentSessionRecord | null> {
    const purpose = input.purpose.trim();
    const duration = input.expiresAt - input.createdAt;
    if (
      purpose.length === 0 ||
      purpose.length > 280 ||
      !Number.isFinite(input.createdAt) ||
      !Number.isFinite(input.expiresAt) ||
      duration <= 0 ||
      duration > MAX_AGENT_SESSION_SECONDS * 1_000 ||
      input.predecessorSessionId === input.id
    ) {
      return null;
    }

    return await this.db.transaction().execute(async (transaction) => {
      const agent = await transaction
        .selectFrom("agents")
        .select("id")
        .where("workspaceId", "=", input.workspaceId)
        .where("id", "=", input.agentId)
        .where("status", "=", "active")
        .forShare()
        .executeTakeFirst();
      if (!agent) return null;

      if (input.predecessorSessionId !== null) {
        const predecessor = await transaction
          .selectFrom("agentSessions")
          .select("id")
          .where("workspaceId", "=", input.workspaceId)
          .where("id", "=", input.predecessorSessionId)
          .where("agentId", "=", input.agentId)
          .forShare()
          .executeTakeFirst();
        if (!predecessor) return null;
      }

      const createdAt = new Date(input.createdAt);
      const session = await transaction
        .insertInto("agentSessions")
        .values({
          workspaceId: input.workspaceId,
          id: input.id,
          agentId: input.agentId,
          purpose,
          status: "active",
          expiresAt: new Date(input.expiresAt),
          predecessorSessionId: input.predecessorSessionId,
          autoapprovalPolicyId: null,
          autoapprovalPolicyVersion: null,
          createdAt,
          updatedAt: createdAt,
        })
        .onConflict((conflict) =>
          conflict.columns(["workspaceId", "id"]).doNothing(),
        )
        .returningAll()
        .executeTakeFirst();
      return session ? agentSessionRecord(session) : null;
    });
  }

  /**
   * Reads active target-model Session metadata. This does not authorize Operations;
   * the future cutover must also verify a Session Credential, target, and scope.
   */
  async getActiveAgentSession(
    workspaceId: string,
    sessionId: string,
    agentId: string,
  ): Promise<AgentSessionRecord | null> {
    const now = new Date();
    const session = await this.db
      .selectFrom("agentSessions")
      .innerJoin("agents", (join) =>
        join
          .onRef("agents.workspaceId", "=", "agentSessions.workspaceId")
          .onRef("agents.id", "=", "agentSessions.agentId"),
      )
      .selectAll("agentSessions")
      .where("agentSessions.workspaceId", "=", workspaceId)
      .where("agentSessions.id", "=", sessionId)
      .where("agentSessions.agentId", "=", agentId)
      .where("agentSessions.status", "=", "active")
      .where("agentSessions.createdAt", "<=", now)
      .where("agentSessions.expiresAt", ">", now)
      .where("agents.status", "=", "active")
      .executeTakeFirst();
    return session ? agentSessionRecord(session) : null;
  }

  async listWorkspaceAgents(
    workspaceId: string,
  ): Promise<AgentIdentityRecord[]> {
    return (
      await this.db
        .selectFrom("agents")
        .selectAll()
        .where("workspaceId", "=", workspaceId)
        .where("deletedAt", "is", null)
        .orderBy("createdAt", "desc")
        .execute()
    ).map(agentIdentityRecord);
  }

  async proposeAgentPolicy(input: {
    workspaceId: string;
    id: string;
    agentId: string;
    humanId: string;
    kind: "autoapproval" | "delegation";
    scopes: SessionMachineScope[];
    maxSessionSeconds: number;
    maxManagedAgents?: number;
    expiresAt: number;
    approvalCodeHash: string;
  }): Promise<AgentPolicyRecord | null> {
    return await this.db.transaction().execute(async (transaction) => {
      const agent = await transaction
        .selectFrom("agents")
        .select(["id", "createdByHumanId"])
        .where("workspaceId", "=", input.workspaceId)
        .where("id", "=", input.agentId)
        .where("kind", "=", "independent")
        .where("createdByHumanId", "=", input.humanId)
        .where("status", "=", "active")
        .forUpdate()
        .executeTakeFirst();
      if (!agent) return null;
      const machineIds = input.scopes.map((scope) => scope.machineId);
      const machines = await transaction
        .selectFrom("machines")
        .select("id")
        .where("workspaceId", "=", input.workspaceId)
        .where("id", "in", machineIds)
        .where("revokedAt", "is", null)
        .forShare()
        .execute();
      if (
        machines.length !== machineIds.length ||
        new Set(machineIds).size !== machineIds.length
      ) {
        return null;
      }
      const latest = await transaction
        .selectFrom("agentPolicies")
        .select(["id", "version"])
        .where("workspaceId", "=", input.workspaceId)
        .where("agentId", "=", input.agentId)
        .orderBy("version", "desc")
        .executeTakeFirst();
      const policy = await transaction
        .insertInto("agentPolicies")
        .values({
          workspaceId: input.workspaceId,
          id: input.id,
          agentId: input.agentId,
          version: (latest?.version ?? 0) + 1,
          kind: input.kind,
          status: "proposed",
          scopes: JSON.stringify(input.scopes),
          maxSessionSeconds: input.maxSessionSeconds,
          maxManagedAgents:
            input.kind === "delegation" ? (input.maxManagedAgents ?? null) : null,
          expiresAt: new Date(input.expiresAt),
          approvalCodeHash: input.approvalCodeHash,
          approvedByHumanId: null,
          approvedAt: null,
          predecessorPolicyId: latest?.id ?? null,
          delegationPolicyId: null,
          delegationPolicyVersion: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return agentPolicyRecord(policy);
    });
  }

  async listAgentPolicies(
    workspaceId: string,
    agentId?: string,
  ): Promise<AgentPolicyRecord[]> {
    let query = this.db
      .selectFrom("agentPolicies")
      .selectAll()
      .where("workspaceId", "=", workspaceId);
    if (agentId !== undefined) {
      query = query.where("agentId", "=", agentId);
    }
    return (await query.orderBy("createdAt", "desc").execute()).map(
      agentPolicyRecord,
    );
  }

  async agentPolicyForApproval(
    workspaceId: string,
    approvalCodeHash: string,
  ): Promise<AgentPolicyApprovalView | null> {
    const policy = await this.db
      .selectFrom("agentPolicies")
      .innerJoin("agents", (join) =>
        join
          .onRef("agents.workspaceId", "=", "agentPolicies.workspaceId")
          .onRef("agents.id", "=", "agentPolicies.agentId"),
      )
      .selectAll("agentPolicies")
      .select("agents.name as agentName")
      .where("agentPolicies.workspaceId", "=", workspaceId)
      .where("agentPolicies.approvalCodeHash", "=", approvalCodeHash)
      .executeTakeFirst();
    if (!policy) return null;
    const machines = await this.db
      .selectFrom("machines")
      .select(["id", "name"])
      .where("workspaceId", "=", workspaceId)
      .where("id", "in", policy.scopes.map((scope) => scope.machineId))
      .execute();
    if (machines.length !== policy.scopes.length) return null;
    return {
      ...agentPolicyRecord(policy),
      agentName: policy.agentName,
      machines,
    };
  }

  async approveAgentPolicy(input: {
    workspaceId: string;
    approvalCodeHash: string;
    approverHumanId: string;
    now: number;
  }): Promise<AgentPolicyApprovalResult> {
    return await this.db.transaction().execute(async (transaction) => {
      const policy = await transaction
        .selectFrom("agentPolicies")
        .selectAll()
        .where("workspaceId", "=", input.workspaceId)
        .where("approvalCodeHash", "=", input.approvalCodeHash)
        .forUpdate()
        .executeTakeFirst();
      if (!policy) return { status: "invalid" };
      if (policy.expiresAt <= new Date(input.now)) {
        return { status: "expired" };
      }
      if (policy.status !== "proposed") return { status: "already_used" };
      await transaction
        .selectFrom("agents")
        .select("id")
        .where("workspaceId", "=", input.workspaceId)
        .where("id", "=", policy.agentId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const newerActive = await transaction
        .selectFrom("agentPolicies")
        .select("version")
        .where("workspaceId", "=", input.workspaceId)
        .where("agentId", "=", policy.agentId)
        .where("status", "=", "active")
        .where("kind", "=", policy.kind)
        .where("version", ">", policy.version)
        .executeTakeFirst();
      if (newerActive) {
        await transaction
          .updateTable("agentPolicies")
          .set({ status: "replaced", updatedAt: new Date(input.now) })
          .where("workspaceId", "=", input.workspaceId)
          .where("id", "=", policy.id)
          .execute();
        return { status: "already_used" };
      }
      await transaction
        .insertInto("humans")
        .values({
          workspaceId: input.workspaceId,
          id: input.approverHumanId,
          externalId: input.approverHumanId,
          status: "active",
        })
        .onConflict((conflict) =>
          conflict.columns(["workspaceId", "id"]).doNothing(),
        )
        .execute();
      const now = new Date(input.now);
      await transaction
        .updateTable("agentPolicies")
        .set({ status: "replaced", updatedAt: now })
        .where("workspaceId", "=", input.workspaceId)
        .where("agentId", "=", policy.agentId)
        .where("status", "=", "active")
        .where("kind", "=", policy.kind)
        .execute();
      const approved = await transaction
        .updateTable("agentPolicies")
        .set({
          status: "active",
          approvedByHumanId: input.approverHumanId,
          approvedAt: now,
          updatedAt: now,
        })
        .where("workspaceId", "=", input.workspaceId)
        .where("id", "=", policy.id)
        .where("status", "=", "proposed")
        .returningAll()
        .executeTakeFirst();
      return approved
        ? { status: "approved", policy: agentPolicyRecord(approved) }
        : { status: "already_used" };
    });
  }

  async transitionAgentPolicy(input: {
    workspaceId: string;
    policyId: string;
    agentId: string;
    status: "paused" | "revoked";
  }): Promise<AgentPolicyRecord | null> {
    const policy = await this.db
      .updateTable("agentPolicies")
      .set({ status: input.status, updatedAt: new Date() })
      .where("workspaceId", "=", input.workspaceId)
      .where("id", "=", input.policyId)
      .where("agentId", "=", input.agentId)
      .where("status", "in", ["active", "paused"])
      .returningAll()
      .executeTakeFirst();
    return policy ? agentPolicyRecord(policy) : null;
  }

  async createManagedAgent(input: {
    workspaceId: string;
    id: string;
    parentAgentId: string;
    ownerHumanId: string;
    name: string;
    scopes: SessionMachineScope[];
    maxSessionSeconds: number;
    expiresAt: number;
    internalApprovalCodeHash: string;
  }): Promise<{
    agent: AgentIdentityRecord;
    policy: AgentPolicyRecord;
  } | null> {
    return await this.db.transaction().execute(async (transaction) => {
      const parent = await transaction
        .selectFrom("agents")
        .selectAll()
        .where("workspaceId", "=", input.workspaceId)
        .where("id", "=", input.parentAgentId)
        .where("kind", "=", "independent")
        .where("createdByHumanId", "=", input.ownerHumanId)
        .where("status", "=", "active")
        .where("deletedAt", "is", null)
        .forUpdate()
        .executeTakeFirst();
      if (!parent) return null;
      const delegation = await transaction
        .selectFrom("agentPolicies")
        .selectAll()
        .where("workspaceId", "=", input.workspaceId)
        .where("agentId", "=", input.parentAgentId)
        .where("kind", "=", "delegation")
        .where("status", "=", "active")
        .forShare()
        .executeTakeFirst();
      if (!delegation?.approvedByHumanId || !delegation.maxManagedAgents) {
        return null;
      }
      const managedCount = await transaction
        .selectFrom("agents")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where("workspaceId", "=", input.workspaceId)
        .where("parentAgentId", "=", input.parentAgentId)
        .where("kind", "=", "managed")
        .where("status", "=", "active")
        .where("deletedAt", "is", null)
        .executeTakeFirstOrThrow();
      const decision = managedDelegationDecision({
        childScopes: input.scopes,
        childMaxSessionSeconds: input.maxSessionSeconds,
        childExpiresAt: input.expiresAt,
        activeManagedAgents: Number(managedCount.count),
        delegation: {
          status: delegation.status,
          scopes: delegation.scopes,
          maxSessionSeconds: delegation.maxSessionSeconds,
          maxManagedAgents: delegation.maxManagedAgents,
          expiresAt: timestamp(delegation.expiresAt),
        },
        now: Date.now(),
      });
      if (!decision.allowed) return null;
      const machineIds = input.scopes.map((scope) => scope.machineId);
      const machines = await transaction
        .selectFrom("machines")
        .select("id")
        .where("workspaceId", "=", input.workspaceId)
        .where("id", "in", machineIds)
        .where("revokedAt", "is", null)
        .forShare()
        .execute();
      if (
        machines.length !== machineIds.length ||
        new Set(machineIds).size !== machineIds.length
      ) {
        return null;
      }
      const agent = await transaction
        .insertInto("agents")
        .values({
          workspaceId: input.workspaceId,
          id: input.id,
          name: input.name,
          kind: "managed",
          parentAgentId: input.parentAgentId,
          createdByHumanId: input.ownerHumanId,
          status: "active",
          deletedAt: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const policy = await transaction
        .insertInto("agentPolicies")
        .values({
          workspaceId: input.workspaceId,
          id: randomUUID(),
          agentId: input.id,
          version: 1,
          kind: "managed",
          status: "active",
          scopes: JSON.stringify(input.scopes),
          maxSessionSeconds: input.maxSessionSeconds,
          maxManagedAgents: null,
          expiresAt: new Date(input.expiresAt),
          approvalCodeHash: input.internalApprovalCodeHash,
          approvedByHumanId: delegation.approvedByHumanId,
          approvedAt: new Date(),
          predecessorPolicyId: null,
          delegationPolicyId: delegation.id,
          delegationPolicyVersion: delegation.version,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return {
        agent: agentIdentityRecord(agent),
        policy: agentPolicyRecord(policy),
      };
    });
  }

  async listManagedAgents(
    workspaceId: string,
    parentAgentId: string,
  ): Promise<AgentIdentityRecord[]> {
    return (
      await this.db
        .selectFrom("agents")
        .selectAll()
        .where("workspaceId", "=", workspaceId)
        .where("parentAgentId", "=", parentAgentId)
        .where("kind", "=", "managed")
        .where("deletedAt", "is", null)
        .orderBy("createdAt", "desc")
        .execute()
    ).map(agentIdentityRecord);
  }

  async managedAgentForParent(
    workspaceId: string,
    managedAgentId: string,
    parentAgentId: string,
  ): Promise<AgentIdentityRecord | null> {
    const agent = await this.db
      .selectFrom("agents")
      .selectAll()
      .where("workspaceId", "=", workspaceId)
      .where("id", "=", managedAgentId)
      .where("parentAgentId", "=", parentAgentId)
      .where("kind", "=", "managed")
      .where("status", "=", "active")
      .where("deletedAt", "is", null)
      .executeTakeFirst();
    return agent ? agentIdentityRecord(agent) : null;
  }

  async disableManagedAgent(input: {
    workspaceId: string;
    managedAgentId: string;
    parentAgentId: string;
    deleted: boolean;
  }): Promise<{ agent: AgentIdentityRecord; sessionIds: string[] } | null> {
    return await this.db.transaction().execute(async (transaction) => {
      const now = new Date();
      const agent = await transaction
        .updateTable("agents")
        .set({
          status: "disabled",
          ...(input.deleted ? { deletedAt: now } : {}),
          updatedAt: now,
        })
        .where("workspaceId", "=", input.workspaceId)
        .where("id", "=", input.managedAgentId)
        .where("parentAgentId", "=", input.parentAgentId)
        .where("kind", "=", "managed")
        .where("deletedAt", "is", null)
        .returningAll()
        .executeTakeFirst();
      if (!agent) return null;
      await transaction
        .updateTable("agentPolicies")
        .set({ status: "revoked", updatedAt: now })
        .where("workspaceId", "=", input.workspaceId)
        .where("agentId", "=", input.managedAgentId)
        .where("status", "in", ["active", "paused", "proposed"])
        .execute();
      const sessions = await transaction
        .selectFrom("agentSessions")
        .select("id")
        .where("workspaceId", "=", input.workspaceId)
        .where("agentId", "=", input.managedAgentId)
        .where("status", "=", "active")
        .execute();
      return {
        agent: agentIdentityRecord(agent),
        sessionIds: sessions.map((session) => session.id),
      };
    });
  }

  async listWorkspaceAgentSessions(
    workspaceId: string,
    limit = 200,
    requester?: { humanId: string; agentId?: string },
  ): Promise<WorkspaceAgentSessionRecord[]> {
    let sessionsQuery = this.db
      .selectFrom("agentSessions")
      .innerJoin("agents", (join) =>
        join
          .onRef("agents.workspaceId", "=", "agentSessions.workspaceId")
          .onRef("agents.id", "=", "agentSessions.agentId"),
      )
      .innerJoin("agentSessionRequests", (join) =>
        join
          .onRef(
            "agentSessionRequests.workspaceId",
            "=",
            "agentSessions.workspaceId",
          )
          .onRef("agentSessionRequests.sessionId", "=", "agentSessions.id"),
      )
      .selectAll("agentSessions")
      .select([
        "agents.name as agentName",
        "agentSessionRequests.requestedByHumanId",
        "agentSessionRequests.requestedByAgentId",
        "agentSessionRequests.runId",
        "agentSessionRequests.scopes",
      ])
      .where("agentSessions.workspaceId", "=", workspaceId);
    if (requester) {
      sessionsQuery = sessionsQuery.where(
        "agentSessionRequests.requestedByHumanId",
        "=",
        requester.humanId,
      );
    }
    if (requester?.agentId) {
      sessionsQuery = sessionsQuery.where((expression) =>
        expression.or([
          expression(
            "agentSessionRequests.requestedByAgentId",
            "=",
            requester.agentId!,
          ),
          expression("agentSessions.agentId", "=", requester.agentId!),
        ]),
      );
    }
    const sessions = await sessionsQuery
      .orderBy("agentSessions.createdAt", "desc")
      .limit(Math.min(Math.max(limit, 1), 500))
      .execute();
    if (sessions.length === 0) return [];

    const sessionIds = sessions.map((session) => session.id);
    const targets = await this.db
      .selectFrom("agentSessionTargets")
      .innerJoin("machines", (join) =>
        join
          .onRef("machines.workspaceId", "=", "agentSessionTargets.workspaceId")
          .onRef("machines.id", "=", "agentSessionTargets.machineId"),
      )
      .select([
        "agentSessionTargets.sessionId",
        "agentSessionTargets.machineId",
        "agentSessionTargets.status",
        "machines.name as machineName",
      ])
      .where("agentSessionTargets.workspaceId", "=", workspaceId)
      .where("agentSessionTargets.sessionId", "in", sessionIds)
      .orderBy("agentSessionTargets.machineId")
      .execute();
    const targetsBySession = new Map<
      string,
      WorkspaceAgentSessionRecord["targets"]
    >();
    for (const target of targets) {
      const values = targetsBySession.get(target.sessionId) ?? [];
      values.push({
        machineId: target.machineId,
        machineName: target.machineName,
        status: target.status,
      });
      targetsBySession.set(target.sessionId, values);
    }
    return sessions.map((session) => ({
      ...agentSessionRecord(session),
      agentName: session.agentName,
      requestedByHumanId: session.requestedByHumanId,
      ...(session.requestedByAgentId === null
        ? {}
        : { requestedByAgentId: session.requestedByAgentId }),
      ...(session.runId === null ? {} : { runId: session.runId }),
      scopes: session.scopes,
      targets: targetsBySession.get(session.id) ?? [],
    }));
  }

  async listWorkspaceAgentSessionRequests(
    workspaceId: string,
    limit = 200,
  ): Promise<WorkspaceAgentSessionRequestRecord[]> {
    const now = new Date();
    await this.db
      .updateTable("agentSessionRequests")
      .set({ status: "expired", updatedAt: now })
      .where("workspaceId", "=", workspaceId)
      .where("status", "in", ["pending", "approved"])
      .where("expiresAt", "<=", now)
      .execute();

    const requests = await this.db
      .selectFrom("agentSessionRequests")
      .innerJoin("agents", (join) =>
        join
          .onRef("agents.workspaceId", "=", "agentSessionRequests.workspaceId")
          .onRef("agents.id", "=", "agentSessionRequests.agentId"),
      )
      .selectAll("agentSessionRequests")
      .select("agents.name as agentName")
      .where("agentSessionRequests.workspaceId", "=", workspaceId)
      .where("agentSessionRequests.status", "!=", "claimed")
      .orderBy("agentSessionRequests.createdAt", "desc")
      .limit(Math.min(Math.max(limit, 1), 500))
      .execute();
    if (requests.length === 0) return [];

    const machineIds = [
      ...new Set(
        requests.flatMap((request) =>
          request.scopes.map((scope) => scope.machineId),
        ),
      ),
    ];
    const machines = await this.db
      .selectFrom("machines")
      .select(["id", "name"])
      .where("workspaceId", "=", workspaceId)
      .where("id", "in", machineIds)
      .execute();
    const machineNames = new Map(
      machines.map((machine) => [machine.id, machine.name]),
    );

    return requests.map((request) => ({
      ...agentSessionRequestRecord(request),
      agentName: request.agentName,
      machines: request.scopes.map((scope) => ({
        id: scope.machineId,
        name: machineNames.get(scope.machineId) ?? "Unavailable machine",
      })),
    }));
  }

  async listAgentSessionRequests(
    workspaceId: string,
    agentId: string,
    humanId: string,
    limit = 20,
  ): Promise<AgentSessionRequestRecord[]> {
    const now = new Date();
    await this.db
      .updateTable("agentSessionRequests")
      .set({ status: "expired", updatedAt: now })
      .where("workspaceId", "=", workspaceId)
      .where("agentId", "=", agentId)
      .where("requestedByHumanId", "=", humanId)
      .where("status", "in", ["pending", "approved"])
      .where("expiresAt", "<=", now)
      .execute();
    const requests = await this.db
      .selectFrom("agentSessionRequests")
      .selectAll()
      .where("workspaceId", "=", workspaceId)
      .where("agentId", "=", agentId)
      .where("requestedByHumanId", "=", humanId)
      .orderBy("createdAt", "desc")
      .limit(Math.min(Math.max(limit, 1), 100))
      .execute();
    return requests.map(agentSessionRequestRecord);
  }

  async workspaceAgentSession(
    workspaceId: string,
    sessionId: string,
  ): Promise<WorkspaceAgentSessionRecord | null> {
    const sessions = await this.listWorkspaceAgentSessions(workspaceId, 500);
    return sessions.find((session) => session.id === sessionId) ?? null;
  }

  async workspaceSessionTimeline(
    workspaceId: string,
    sessionId: string,
  ): Promise<SessionTimelineEventRecord[] | null> {
    const request = await this.db
      .selectFrom("agentSessionRequests")
      .select("id")
      .where("workspaceId", "=", workspaceId)
      .where("sessionId", "=", sessionId)
      .executeTakeFirst();
    if (!request) return null;
    return (
      await this.db
        .selectFrom("sessionTimelineEvents")
        .selectAll()
        .where("workspaceId", "=", workspaceId)
        .where("requestId", "=", request.id)
        .orderBy("createdAt", "asc")
        .execute()
    ).map(sessionTimelineEventRecord);
  }

  async operationTimelineMetadata(
    workspaceId: string,
    operationIds: string[],
    includeDiagnosticOutput: boolean,
  ): Promise<Map<string, Record<string, unknown>>> {
    if (operationIds.length === 0) return new Map();
    const operations = await this.db
      .selectFrom("operations")
      .select(["id", "action"])
      .where("workspaceId", "=", workspaceId)
      .where("id", "in", [...new Set(operationIds)])
      .execute();
    const metadata = new Map(
      operations.map((operation) => [
        operation.id,
        operationTimelineMetadata(operation.action),
      ]),
    );
    if (!includeDiagnosticOutput) return metadata;
    const events = await this.db
      .selectFrom("operationEvents")
      .select(["operationId", "stream", "data"])
      .where("workspaceId", "=", workspaceId)
      .where("operationId", "in", [...new Set(operationIds)])
      .where("stream", "in", ["stdout", "stderr"])
      .orderBy("operationId", "asc")
      .orderBy("sequence", "asc")
      .execute();
    const byOperation = new Map<
      string,
      Array<{ stream: string; data: Uint8Array }>
    >();
    for (const event of events) {
      const operationEvents = byOperation.get(event.operationId) ?? [];
      operationEvents.push(event);
      byOperation.set(event.operationId, operationEvents);
    }
    for (const [operationId, operationEvents] of byOperation) {
      metadata.set(operationId, {
        ...metadata.get(operationId),
        ...diagnosticTimelineMetadata(operationEvents),
      });
    }
    return metadata;
  }

  async workspaceEventSink(
    workspaceId: string,
  ): Promise<EventSinkRecord | null> {
    const sink = await this.db
      .selectFrom("eventSinks")
      .select([
        "id",
        "endpoint",
        "detailLevel",
        "secretLastFour",
        "status",
        "createdAt",
        "updatedAt",
      ])
      .where("workspaceId", "=", workspaceId)
      .executeTakeFirst();
    return sink
      ? {
          id: sink.id,
          endpoint: sink.endpoint,
          detailLevel: sink.detailLevel as EventSinkRecord["detailLevel"],
          secretLastFour: sink.secretLastFour,
          status: sink.status as EventSinkRecord["status"],
          createdAt: sink.createdAt.getTime(),
          updatedAt: sink.updatedAt.getTime(),
        }
      : null;
  }

  async upsertWorkspaceEventSink(input: {
    workspaceId: string;
    endpoint: string;
    detailLevel: EventSinkRecord["detailLevel"];
    secretCiphertext: string;
    secretLastFour: string;
  }): Promise<EventSinkRecord> {
    const id = randomUUID();
    await this.db
      .insertInto("eventSinks")
      .values({
        workspaceId: input.workspaceId,
        id,
        endpoint: input.endpoint,
        detailLevel: input.detailLevel,
        secretCiphertext: input.secretCiphertext,
        secretLastFour: input.secretLastFour,
        status: "active",
      })
      .onConflict((conflict) =>
        conflict.column("workspaceId").doUpdateSet({
          endpoint: input.endpoint,
          detailLevel: input.detailLevel,
          secretCiphertext: input.secretCiphertext,
          secretLastFour: input.secretLastFour,
          status: "active",
          updatedAt: new Date(),
        }),
      )
      .execute();
    return (await this.workspaceEventSink(input.workspaceId))!;
  }

  async deleteWorkspaceEventSink(workspaceId: string): Promise<boolean> {
    const deleted = await this.db
      .deleteFrom("eventSinks")
      .where("workspaceId", "=", workspaceId)
      .returning("id")
      .executeTakeFirst();
    return deleted !== undefined;
  }

  async activeEventSinksExist(): Promise<boolean> {
    return (
      (await this.db
        .selectFrom("eventSinks")
        .select("id")
        .where("status", "=", "active")
        .limit(1)
        .executeTakeFirst()) !== undefined
    );
  }

  async enqueueEventSinkDeliveries(
    retentionBefore: number,
    createdBefore: number,
  ): Promise<number> {
    const result = await sql`
      insert into odyshell.event_sink_deliveries (
        workspace_id, id, sink_id, event_id
      )
      select
        sink.workspace_id,
        gen_random_uuid()::text,
        sink.id,
        event.id
      from odyshell.event_sinks sink
      join odyshell.session_timeline_events event
        on event.workspace_id = sink.workspace_id
      where sink.status = 'active'
        and event.created_at >= ${new Date(retentionBefore)}
        and event.created_at < ${new Date(createdBefore)}
      on conflict (workspace_id, sink_id, event_id) do nothing
    `.execute(this.root);
    return Number(result.numAffectedRows ?? 0);
  }

  async pendingEventSinkDeliveries(
    now: number,
    limit = 25,
  ): Promise<PendingEventSinkDelivery[]> {
    const rows = await this.db
      .selectFrom("eventSinkDeliveries as delivery")
      .innerJoin("eventSinks as sink", (join) =>
        join
          .onRef("sink.workspaceId", "=", "delivery.workspaceId")
          .onRef("sink.id", "=", "delivery.sinkId"),
      )
      .innerJoin("sessionTimelineEvents as event", (join) =>
        join
          .onRef("event.workspaceId", "=", "delivery.workspaceId")
          .onRef("event.id", "=", "delivery.eventId"),
      )
      .select([
        "delivery.workspaceId as workspaceId",
        "delivery.id as id",
        "delivery.sinkId as sinkId",
        "delivery.attempts as attempts",
        "sink.endpoint as endpoint",
        "sink.detailLevel as detailLevel",
        "sink.secretCiphertext as secretCiphertext",
        "event.id as eventId",
        "event.sessionId as eventSessionId",
        "event.requestId as eventRequestId",
        "event.operationId as eventOperationId",
        "event.eventType as eventType",
        "event.source as eventSource",
        "event.metadata as eventMetadata",
        "event.createdAt as eventCreatedAt",
      ])
      .where("sink.status", "=", "active")
      .where("delivery.status", "in", ["pending", "retrying"])
      .where("delivery.nextAttemptAt", "<=", new Date(now))
      .orderBy("delivery.nextAttemptAt", "asc")
      .limit(limit)
      .execute();
    return rows.map((row) => ({
      workspaceId: row.workspaceId,
      id: row.id,
      sinkId: row.sinkId,
      endpoint: row.endpoint,
      detailLevel: row.detailLevel as EventSinkRecord["detailLevel"],
      secretCiphertext: row.secretCiphertext,
      attempts: row.attempts,
      event: {
        id: row.eventId,
        ...(row.eventSessionId === null
          ? {}
          : { sessionId: row.eventSessionId }),
        requestId: row.eventRequestId,
        ...(row.eventOperationId === null
          ? {}
          : { operationId: row.eventOperationId }),
        eventType: row.eventType,
        source: row.eventSource as SessionTimelineEventRecord["source"],
        metadata: row.eventMetadata,
        createdAt: row.eventCreatedAt.getTime(),
      },
    }));
  }

  async completeEventSinkDelivery(
    workspaceId: string,
    deliveryId: string,
    result:
      | { delivered: true; now: number }
      | {
          delivered: false;
          now: number;
          nextAttemptAt?: number;
          errorCode: string;
        },
  ): Promise<void> {
    const attempts = sql<number>`attempts + 1`;
    await this.db
      .updateTable("eventSinkDeliveries")
      .set(
        result.delivered
          ? {
              status: "delivered",
              attempts,
              deliveredAt: new Date(result.now),
              lastError: null,
              updatedAt: new Date(result.now),
            }
          : {
              status:
                result.nextAttemptAt === undefined ? "failed" : "retrying",
              attempts,
              nextAttemptAt: new Date(result.nextAttemptAt ?? result.now),
              lastError: result.errorCode.slice(0, 128),
              updatedAt: new Date(result.now),
            },
      )
      .where("workspaceId", "=", workspaceId)
      .where("id", "=", deliveryId)
      .execute();
  }

  async eventSinkDeliveryStatus(
    workspaceId: string,
    limit = 50,
  ): Promise<Array<{
    id: string;
    eventId: string;
    status: string;
    attempts: number;
    lastError?: string;
    nextAttemptAt: number;
    deliveredAt?: number;
  }>> {
    return (
      await this.db
        .selectFrom("eventSinkDeliveries")
        .select([
          "id",
          "eventId",
          "status",
          "attempts",
          "lastError",
          "nextAttemptAt",
          "deliveredAt",
        ])
        .where("workspaceId", "=", workspaceId)
        .orderBy("createdAt", "desc")
        .limit(limit)
        .execute()
    ).map((delivery) => ({
      id: delivery.id,
      eventId: delivery.eventId,
      status: delivery.status,
      attempts: delivery.attempts,
      ...(delivery.lastError === null
        ? {}
        : { lastError: delivery.lastError }),
      nextAttemptAt: delivery.nextAttemptAt.getTime(),
      ...(delivery.deliveredAt === null
        ? {}
        : { deliveredAt: delivery.deliveredAt.getTime() }),
    }));
  }

  async createAgentSessionRequest(input: {
    workspaceId: string;
    requestId: string;
    agentId: string;
    agentName: string;
    humanId: string;
    requesterAgentId?: string;
    runId?: string;
    scopes: SessionMachineScope[];
    purpose: string;
    durationSeconds: number;
    approvalCodeHash: string;
    expiresAt: number;
    predecessorSessionId?: string;
  }): Promise<AgentSessionRequestRecord | null> {
    return await this.db.transaction().execute(async (transaction) => {
      await transaction
        .insertInto("humans")
        .values({
          workspaceId: input.workspaceId,
          id: input.humanId,
          externalId: input.humanId,
          status: "active",
        })
        .onConflict((conflict) =>
          conflict.columns(["workspaceId", "id"]).doNothing(),
        )
        .execute();
      const human = await transaction
        .selectFrom("humans")
        .select("id")
        .where("workspaceId", "=", input.workspaceId)
        .where("id", "=", input.humanId)
        .where("externalId", "=", input.humanId)
        .where("status", "=", "active")
        .forShare()
        .executeTakeFirst();
      if (!human) return null;

      if (!input.requesterAgentId) {
        await transaction
          .insertInto("agents")
          .values({
            workspaceId: input.workspaceId,
            id: input.agentId,
            name: input.agentName,
            kind: "independent",
            parentAgentId: null,
            createdByHumanId: input.humanId,
            status: "active",
            deletedAt: null,
          })
          .onConflict((conflict) =>
            conflict.columns(["workspaceId", "id"]).doNothing(),
          )
          .execute();
      }
      const agent = await transaction
        .selectFrom("agents")
        .select(["id", "name", "kind", "parentAgentId"])
        .where("workspaceId", "=", input.workspaceId)
        .where("id", "=", input.agentId)
        .where("createdByHumanId", "=", input.humanId)
        .where("status", "=", "active")
        .where("deletedAt", "is", null)
        .forShare()
        .executeTakeFirst();
      if (
        !agent ||
        agent.name !== input.agentName ||
        (input.requesterAgentId
          ? !(
              (agent.kind === "independent" &&
                agent.id === input.requesterAgentId) ||
              (agent.kind === "managed" &&
                agent.parentAgentId === input.requesterAgentId)
            )
          : agent.kind !== "independent")
      ) {
        return null;
      }
      if (input.requesterAgentId) {
        const requester = await transaction
          .selectFrom("agents")
          .select("id")
          .where("workspaceId", "=", input.workspaceId)
          .where("id", "=", input.requesterAgentId)
          .where("kind", "=", "independent")
          .where("createdByHumanId", "=", input.humanId)
          .where("status", "=", "active")
          .where("deletedAt", "is", null)
          .forShare()
          .executeTakeFirst();
        if (!requester) return null;
      }

      const policy = await transaction
        .selectFrom("agentPolicies")
        .selectAll()
        .where("workspaceId", "=", input.workspaceId)
        .where("agentId", "=", input.agentId)
        .where(
          "kind",
          "=",
          agent.kind === "managed" ? "managed" : "autoapproval",
        )
        .where("status", "=", "active")
        .forShare()
        .executeTakeFirst();
      if (agent.kind === "managed") {
        if (
          !policy?.approvedByHumanId ||
          !policy.delegationPolicyId ||
          policy.delegationPolicyVersion === null ||
          !agent.parentAgentId
        ) {
          return null;
        }
        const delegation = await transaction
          .selectFrom("agentPolicies")
          .selectAll()
          .where("workspaceId", "=", input.workspaceId)
          .where("id", "=", policy.delegationPolicyId)
          .where("version", "=", policy.delegationPolicyVersion)
          .where("agentId", "=", agent.parentAgentId)
          .where("kind", "=", "delegation")
          .forShare()
          .executeTakeFirst();
        if (
          !delegation?.approvedByHumanId ||
          !delegation.maxManagedAgents ||
          !managedDelegationDecision({
            childScopes: policy.scopes,
            childMaxSessionSeconds: policy.maxSessionSeconds,
            childExpiresAt: timestamp(policy.expiresAt),
            activeManagedAgents: 0,
            delegation: {
              status: delegation.status,
              scopes: delegation.scopes,
              maxSessionSeconds: delegation.maxSessionSeconds,
              maxManagedAgents: delegation.maxManagedAgents,
              expiresAt: timestamp(delegation.expiresAt),
            },
            now: Date.now(),
          }).allowed
        ) {
          return null;
        }
      }

      const requestedMachineIds = input.scopes.map((scope) => scope.machineId);
      const machines = await transaction
        .selectFrom("machines")
        .select("id")
        .where("workspaceId", "=", input.workspaceId)
        .where("id", "in", requestedMachineIds)
        .where("revokedAt", "is", null)
        .forShare()
        .execute();
      if (machines.length !== requestedMachineIds.length) return null;

      const primaryScope = input.scopes[0]!;
      const primaryReadPath =
        primaryScope.restrictions.filesystem?.paths[0]?.path ?? ".";

      let request = await transaction
        .insertInto("agentSessionRequests")
        .values({
          workspaceId: input.workspaceId,
          id: input.requestId,
          agentId: input.agentId,
          requestedByHumanId: input.humanId,
          requestedByAgentId: input.requesterAgentId ?? null,
          runId: input.runId ?? null,
          machineId: primaryScope.machineId,
          purpose: input.purpose,
          readPath: primaryReadPath,
          scopes: JSON.stringify(input.scopes),
          durationSeconds: input.durationSeconds,
          status: "pending",
          approvalCodeHash: input.approvalCodeHash,
          expiresAt: new Date(input.expiresAt),
          approvedAt: null,
          approvedByHumanId: null,
          claimedAt: null,
          sessionId: null,
          predecessorSessionId: input.predecessorSessionId ?? null,
          autoapprovalPolicyId: null,
          autoapprovalPolicyVersion: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("sessionTimelineEvents")
        .values({
          workspaceId: input.workspaceId,
          id: randomUUID(),
          sessionId: null,
          requestId: input.requestId,
          operationId: null,
          eventType: "session.requested",
          source: "verified",
          metadata: JSON.stringify({
            machineIds: requestedMachineIds,
            capabilities: input.scopes.map((scope) => ({
              machineId: scope.machineId,
              capabilities: scope.capabilities,
            })),
            durationSeconds: input.durationSeconds,
            executorAgentId: input.agentId,
            ...(input.requesterAgentId
              ? { requesterAgentId: input.requesterAgentId }
              : {}),
            ...(input.runId ? { runId: input.runId } : {}),
            ...(input.predecessorSessionId
              ? { predecessorSessionId: input.predecessorSessionId }
              : {}),
          }),
        })
        .execute();
      const now = new Date();
      if (
        policy?.approvedByHumanId &&
        autoapprovalDecision({
          requestedScopes: input.scopes,
          requestedDurationSeconds: input.durationSeconds,
          policy: {
            status: policy.status,
            scopes: policy.scopes,
            maxSessionSeconds: policy.maxSessionSeconds,
            expiresAt: timestamp(policy.expiresAt),
          },
          now: now.getTime(),
        }).approved
      ) {
        request = await transaction
          .updateTable("agentSessionRequests")
          .set({
            status: "approved",
            approvedAt: now,
            approvedByHumanId: policy.approvedByHumanId,
            expiresAt: new Date(
              now.getTime() + SESSION_CLAIM_WINDOW_MILLISECONDS,
            ),
            autoapprovalPolicyId: policy.id,
            autoapprovalPolicyVersion: policy.version,
            updatedAt: now,
          })
          .where("workspaceId", "=", input.workspaceId)
          .where("id", "=", input.requestId)
          .where("status", "=", "pending")
          .returningAll()
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto("sessionTimelineEvents")
          .values({
            workspaceId: input.workspaceId,
            id: randomUUID(),
            sessionId: null,
            requestId: input.requestId,
            operationId: null,
            eventType: "session.autoapproved",
            source: "verified",
            metadata: JSON.stringify({
              policyId: policy.id,
              policyVersion: policy.version,
            }),
            createdAt: now,
          })
          .execute();
      }
      return agentSessionRequestRecord(request);
    });
  }

  async sessionRequestForApproval(
    workspaceId: string,
    approvalCodeHash: string,
  ): Promise<SessionApprovalView | null> {
    const request = await this.db
      .selectFrom("agentSessionRequests")
      .innerJoin("agents", (join) =>
        join
          .onRef("agents.workspaceId", "=", "agentSessionRequests.workspaceId")
          .onRef("agents.id", "=", "agentSessionRequests.agentId"),
      )
      .selectAll("agentSessionRequests")
      .select(["agents.name as agentName"])
      .where("agentSessionRequests.workspaceId", "=", workspaceId)
      .where(
        "agentSessionRequests.approvalCodeHash",
        "=",
        approvalCodeHash,
      )
      .executeTakeFirst();
    if (!request) return null;
    const scopes = request.scopes;
    const machines = await this.db
      .selectFrom("machines")
      .select(["id", "name"])
      .where("workspaceId", "=", workspaceId)
      .where("id", "in", scopes.map((scope) => scope.machineId))
      .execute();
    if (machines.length !== scopes.length) return null;
    return {
      ...agentSessionRequestRecord(request),
      agentName: request.agentName,
      machines,
    };
  }

  async getAgentSessionRequest(
    workspaceId: string,
    requestId: string,
    agentId: string,
    humanId: string,
  ): Promise<AgentSessionRequestRecord | null> {
    const request = await this.db
      .selectFrom("agentSessionRequests")
      .selectAll()
      .where("workspaceId", "=", workspaceId)
      .where("id", "=", requestId)
      .where("agentId", "=", agentId)
      .where("requestedByHumanId", "=", humanId)
      .executeTakeFirst();
    if (!request) return null;
    if (request.status !== "claimed" && request.expiresAt <= new Date()) {
      const expired = await this.db
        .updateTable("agentSessionRequests")
        .set({ status: "expired", updatedAt: new Date() })
        .where("workspaceId", "=", workspaceId)
        .where("id", "=", requestId)
        .where("status", "in", ["pending", "approved"])
        .returningAll()
        .executeTakeFirst();
      return agentSessionRequestRecord(expired ?? request);
    }
    return agentSessionRequestRecord(request);
  }

  async agentSessionForRenewal(
    workspaceId: string,
    sessionId: string,
    agentId: string,
    humanId: string,
  ): Promise<{
    agentName: string;
    purpose: string;
    scopes: SessionMachineScope[];
    durationSeconds: number;
  } | null> {
    return (
      (await this.db
        .selectFrom("agentSessionRequests")
        .innerJoin("agents", (join) =>
          join
            .onRef("agents.workspaceId", "=", "agentSessionRequests.workspaceId")
            .onRef("agents.id", "=", "agentSessionRequests.agentId"),
        )
        .innerJoin("agentSessions", (join) =>
          join
            .onRef(
              "agentSessions.workspaceId",
              "=",
              "agentSessionRequests.workspaceId",
            )
            .onRef("agentSessions.id", "=", "agentSessionRequests.sessionId"),
        )
        .select([
          "agents.name as agentName",
          "agentSessionRequests.purpose",
          "agentSessionRequests.scopes",
          "agentSessionRequests.durationSeconds",
        ])
        .where("agentSessionRequests.workspaceId", "=", workspaceId)
        .where("agentSessionRequests.sessionId", "=", sessionId)
        .where("agentSessionRequests.agentId", "=", agentId)
        .where("agentSessionRequests.requestedByHumanId", "=", humanId)
        .where("agents.status", "=", "active")
        .executeTakeFirst()) ?? null
    );
  }

  async approveAgentSessionRequest(input: {
    workspaceId: string;
    approvalCodeHash: string;
    approverHumanId: string;
    now: number;
  }): Promise<SessionApprovalResult> {
    return await this.db.transaction().execute(async (transaction) => {
      const request = await transaction
        .selectFrom("agentSessionRequests")
        .selectAll()
        .where("workspaceId", "=", input.workspaceId)
        .where("approvalCodeHash", "=", input.approvalCodeHash)
        .forUpdate()
        .executeTakeFirst();
      if (!request) return { status: "invalid" };
      if (request.expiresAt <= new Date(input.now)) {
        if (request.status === "pending") {
          await transaction
            .updateTable("agentSessionRequests")
            .set({ status: "expired", updatedAt: new Date(input.now) })
            .where("workspaceId", "=", input.workspaceId)
            .where("id", "=", request.id)
            .execute();
        }
        return { status: "expired" };
      }
      if (request.status !== "pending") return { status: "already_used" };

      await transaction
        .insertInto("humans")
        .values({
          workspaceId: input.workspaceId,
          id: input.approverHumanId,
          externalId: input.approverHumanId,
          status: "active",
        })
        .onConflict((conflict) =>
          conflict.columns(["workspaceId", "id"]).doNothing(),
        )
        .execute();
      const approver = await transaction
        .selectFrom("humans")
        .select("id")
        .where("workspaceId", "=", input.workspaceId)
        .where("id", "=", input.approverHumanId)
        .where("externalId", "=", input.approverHumanId)
        .where("status", "=", "active")
        .forShare()
        .executeTakeFirst();
      if (!approver) return { status: "invalid" };

      const approvedAt = new Date(input.now);
      const claimExpiresAt = new Date(
        input.now + SESSION_CLAIM_WINDOW_MILLISECONDS,
      );
      const approved = await transaction
        .updateTable("agentSessionRequests")
        .set({
          status: "approved",
          approvedAt,
          approvedByHumanId: input.approverHumanId,
          expiresAt: claimExpiresAt,
          updatedAt: approvedAt,
        })
        .where("workspaceId", "=", input.workspaceId)
        .where("id", "=", request.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("sessionTimelineEvents")
        .values({
          workspaceId: input.workspaceId,
          id: randomUUID(),
          sessionId: null,
          requestId: request.id,
          operationId: null,
          eventType: "session.approved",
          source: "verified",
          metadata: JSON.stringify({}),
          createdAt: approvedAt,
        })
        .execute();
      return {
        status: "approved",
        request: agentSessionRequestRecord(approved),
      };
    });
  }

  async denyAgentSessionRequest(input: {
    workspaceId: string;
    approvalCodeHash: string;
    denierHumanId: string;
    now: number;
  }): Promise<SessionDenialResult> {
    return await this.db.transaction().execute(async (transaction) => {
      const request = await transaction
        .selectFrom("agentSessionRequests")
        .selectAll()
        .where("workspaceId", "=", input.workspaceId)
        .where("approvalCodeHash", "=", input.approvalCodeHash)
        .forUpdate()
        .executeTakeFirst();
      if (!request) return { status: "invalid" };
      if (request.expiresAt <= new Date(input.now)) {
        if (request.status === "pending") {
          await transaction
            .updateTable("agentSessionRequests")
            .set({ status: "expired", updatedAt: new Date(input.now) })
            .where("workspaceId", "=", input.workspaceId)
            .where("id", "=", request.id)
            .execute();
        }
        return { status: "expired" };
      }
      if (request.status !== "pending") return { status: "already_used" };

      await transaction
        .insertInto("humans")
        .values({
          workspaceId: input.workspaceId,
          id: input.denierHumanId,
          externalId: input.denierHumanId,
          status: "active",
        })
        .onConflict((conflict) =>
          conflict.columns(["workspaceId", "id"]).doNothing(),
        )
        .execute();
      const denier = await transaction
        .selectFrom("humans")
        .select("id")
        .where("workspaceId", "=", input.workspaceId)
        .where("id", "=", input.denierHumanId)
        .where("externalId", "=", input.denierHumanId)
        .where("status", "=", "active")
        .forShare()
        .executeTakeFirst();
      if (!denier) return { status: "invalid" };

      const deniedAt = new Date(input.now);
      const denied = await transaction
        .updateTable("agentSessionRequests")
        .set({ status: "denied", updatedAt: deniedAt })
        .where("workspaceId", "=", input.workspaceId)
        .where("id", "=", request.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("sessionTimelineEvents")
        .values({
          workspaceId: input.workspaceId,
          id: randomUUID(),
          sessionId: null,
          requestId: request.id,
          operationId: null,
          eventType: "session.denied",
          source: "verified",
          metadata: JSON.stringify({}),
          createdAt: deniedAt,
        })
        .execute();
      return {
        status: "denied",
        request: agentSessionRequestRecord(denied),
      };
    });
  }

  async claimAgentSessionRequest(input: {
    workspaceId: string;
    requestId: string;
    agentId: string;
    humanId: string;
    sessionId: string;
    authority:
      | { kind: "credential"; credentialId: string; credentialHash: string }
      | { kind: "mcp"; installationId: string };
    now: number;
  }): Promise<SessionClaimResult> {
    return await this.db.transaction().execute(async (transaction) => {
      const request = await transaction
        .selectFrom("agentSessionRequests")
        .selectAll()
        .where("workspaceId", "=", input.workspaceId)
        .where("id", "=", input.requestId)
        .forUpdate()
        .executeTakeFirst();
      if (!request) return { status: "invalid" };
      if (
        request.agentId !== input.agentId ||
        request.requestedByHumanId !== input.humanId
      ) {
        return { status: "agent_denied" };
      }
      if (request.expiresAt <= new Date(input.now)) {
        if (request.status !== "claimed") {
          await transaction
            .updateTable("agentSessionRequests")
            .set({ status: "expired", updatedAt: new Date(input.now) })
            .where("workspaceId", "=", input.workspaceId)
            .where("id", "=", request.id)
            .execute();
        }
        return { status: "expired" };
      }
      if (request.status === "pending") return { status: "pending" };
      if (request.status === "denied") return { status: "denied" };
      if (request.status === "claimed") return { status: "already_claimed" };
      if (request.status !== "approved") return { status: "expired" };

      const agent = await transaction
        .selectFrom("agents")
        .select("id")
        .where("workspaceId", "=", input.workspaceId)
        .where("id", "=", input.agentId)
        .where("createdByHumanId", "=", input.humanId)
        .where("status", "=", "active")
        .forShare()
        .executeTakeFirst();
      if (input.authority.kind === "mcp") {
        const installation = await transaction
          .selectFrom("mcpInstallations")
          .select("id")
          .where("workspaceId", "=", input.workspaceId)
          .where("id", "=", input.authority.installationId)
          .where("userId", "=", input.humanId)
          .where("agentId", "=", input.agentId)
          .where("status", "=", "active")
          .forShare()
          .executeTakeFirst();
        if (!installation) return { status: "agent_denied" };
      }
      const requestedMachineIds = request.scopes.map((scope) => scope.machineId);
      const machines = await transaction
        .selectFrom("machines")
        .select("id")
        .where("workspaceId", "=", input.workspaceId)
        .where("id", "in", requestedMachineIds)
        .where("revokedAt", "is", null)
        .forShare()
        .execute();
      if (!agent) return { status: "agent_denied" };
      if (machines.length !== requestedMachineIds.length) {
        return { status: "machine_unavailable" };
      }

      const claimedAt = new Date(input.now);
      const expiresAt = new Date(
        input.now + request.durationSeconds * 1_000,
      );
      const session = await transaction
        .insertInto("agentSessions")
        .values({
          workspaceId: input.workspaceId,
          id: input.sessionId,
          agentId: input.agentId,
          purpose: request.purpose,
          status: "active",
          expiresAt,
          predecessorSessionId: request.predecessorSessionId,
          autoapprovalPolicyId: request.autoapprovalPolicyId,
          autoapprovalPolicyVersion: request.autoapprovalPolicyVersion,
          createdAt: claimedAt,
          updatedAt: claimedAt,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const targets = request.scopes.map((scope) => ({
        machineId: scope.machineId,
        runtimeSessionId:
          request.scopes.length === 1 ? input.sessionId : randomUUID(),
        scope,
      }));
      await transaction
        .insertInto("agentSessionTargets")
        .values(
          targets.map(({ machineId, runtimeSessionId, scope }) => ({
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            machineId,
            capabilities: JSON.stringify(scope.capabilities),
            readPath: scope.restrictions.filesystem?.paths[0]?.path ?? ".",
            profile: scope.profile,
            restrictions: JSON.stringify(scope.restrictions),
            runtimeSessionId,
            status: "opening",
            createdAt: claimedAt,
            updatedAt: claimedAt,
          })),
        )
        .execute();
      await transaction
        .insertInto("sessions")
        .values(
          targets.map(({ machineId, runtimeSessionId, scope }) => ({
            workspaceId: input.workspaceId,
            id: runtimeSessionId,
            machineId,
            principalId: input.agentId,
            profile: scope.profile,
            capabilities: JSON.stringify(scope.capabilities),
            status: "opening",
            expiresAt,
            error: null,
            createdAt: claimedAt,
            updatedAt: claimedAt,
          })),
        )
        .execute();
      if (input.authority.kind === "credential") {
        await transaction
          .insertInto("sessionCredentials")
          .values({
            workspaceId: input.workspaceId,
            id: input.authority.credentialId,
            sessionId: input.sessionId,
            tokenHash: input.authority.credentialHash,
            status: "active",
            expiresAt,
            claimedAt,
            revokedAt: null,
            createdAt: claimedAt,
          })
          .execute();
      } else {
        await transaction
          .insertInto("mcpSessionGrants")
          .values({
            workspaceId: input.workspaceId,
            installationId: input.authority.installationId,
            sessionId: input.sessionId,
            status: "active",
            createdAt: claimedAt,
            revokedAt: null,
          })
          .execute();
      }
      await transaction
        .updateTable("agentSessionRequests")
        .set({
          status: "claimed",
          claimedAt,
          sessionId: input.sessionId,
          updatedAt: claimedAt,
        })
        .where("workspaceId", "=", input.workspaceId)
        .where("id", "=", request.id)
        .execute();
      await transaction
        .insertInto("sessionTimelineEvents")
        .values({
          workspaceId: input.workspaceId,
          id: randomUUID(),
          sessionId: input.sessionId,
          requestId: request.id,
          operationId: null,
          eventType: "session.started",
          source: "verified",
          metadata: JSON.stringify({
            machineIds: requestedMachineIds,
            scopes: request.scopes.map((scope) => ({
              machineId: scope.machineId,
              capabilities: scope.capabilities,
            })),
            expiresAt: expiresAt.toISOString(),
            executorAgentId: request.agentId,
            ...(request.requestedByAgentId
              ? { requesterAgentId: request.requestedByAgentId }
              : {}),
            ...(request.runId ? { runId: request.runId } : {}),
            ...(request.predecessorSessionId
              ? { predecessorSessionId: request.predecessorSessionId }
              : {}),
            ...(request.autoapprovalPolicyId
              ? {
                  autoapprovalPolicyId: request.autoapprovalPolicyId,
                  autoapprovalPolicyVersion:
                    request.autoapprovalPolicyVersion,
                }
              : {}),
          }),
          createdAt: claimedAt,
        })
        .execute();
      return {
        status: "claimed",
        session: agentSessionRecord(session),
        targets,
      };
    });
  }

  async findSessionCredentialPrincipal(
    tokenHash: string,
  ): Promise<AgentSessionCredentialPrincipal | null> {
    const now = new Date();
    const principals = await this.db
      .selectFrom("sessionCredentials")
      .innerJoin("agentSessions", (join) =>
        join
          .onRef(
            "agentSessions.workspaceId",
            "=",
            "sessionCredentials.workspaceId",
          )
          .onRef("agentSessions.id", "=", "sessionCredentials.sessionId"),
      )
      .innerJoin("agents", (join) =>
        join
          .onRef("agents.workspaceId", "=", "agentSessions.workspaceId")
          .onRef("agents.id", "=", "agentSessions.agentId"),
      )
      .innerJoin("agentSessionTargets", (join) =>
        join
          .onRef(
            "agentSessionTargets.workspaceId",
            "=",
            "agentSessions.workspaceId",
          )
          .onRef(
            "agentSessionTargets.sessionId",
            "=",
            "agentSessions.id",
          ),
      )
      .select([
        "sessionCredentials.workspaceId",
        "agentSessions.agentId",
        "agents.name as agentName",
        "agentSessions.id as sessionId",
        "agentSessionTargets.machineId",
        "agentSessionTargets.profile",
        "agentSessionTargets.capabilities",
        "agentSessionTargets.restrictions",
        "agentSessions.expiresAt",
      ])
      .where("sessionCredentials.tokenHash", "=", tokenHash)
      .where("sessionCredentials.status", "=", "active")
      .where("sessionCredentials.revokedAt", "is", null)
      .where("sessionCredentials.expiresAt", ">", now)
      .where("agentSessions.status", "=", "active")
      .where("agentSessions.expiresAt", ">", now)
      .where("agents.status", "=", "active")
      .orderBy("agentSessionTargets.machineId")
      .execute();
    const principal = principals[0];
    if (!principal) return null;
    return {
      workspaceId: principal.workspaceId,
      agentId: principal.agentId,
      agentName: principal.agentName,
      sessionId: principal.sessionId,
      scopes: principals.map((target) => ({
        machineId: target.machineId,
        profile: target.profile,
        capabilities: target.capabilities,
        restrictions: target.restrictions,
      })),
      expiresAt: timestamp(principal.expiresAt),
    };
  }

  async mcpGrantedSessionForRequest(input: {
    workspaceId: string;
    installationId: string;
    requestId: string;
  }): Promise<AgentSessionCredentialPrincipal | null> {
    const request = await this.db
      .selectFrom("agentSessionRequests")
      .innerJoin("mcpSessionGrants", (join) =>
        join
          .onRef("mcpSessionGrants.workspaceId", "=", "agentSessionRequests.workspaceId")
          .onRef("mcpSessionGrants.sessionId", "=", "agentSessionRequests.sessionId"),
      )
      .select("agentSessionRequests.sessionId")
      .where("agentSessionRequests.workspaceId", "=", input.workspaceId)
      .where("agentSessionRequests.id", "=", input.requestId)
      .where("mcpSessionGrants.installationId", "=", input.installationId)
      .where("mcpSessionGrants.status", "=", "active")
      .where("mcpSessionGrants.revokedAt", "is", null)
      .executeTakeFirst();
    return request?.sessionId
      ? this.findMcpSessionPrincipal({
          workspaceId: input.workspaceId,
          installationId: input.installationId,
          sessionId: request.sessionId,
        })
      : null;
  }

  async mcpSessionForRequest(input: {
    workspaceId: string;
    installationId: string;
    requestId: string;
  }): Promise<{ sessionId: string; status: string; expiresAt: number } | null> {
    const session = await this.db
      .selectFrom("agentSessionRequests")
      .innerJoin("mcpSessionGrants", (join) =>
        join
          .onRef("mcpSessionGrants.workspaceId", "=", "agentSessionRequests.workspaceId")
          .onRef("mcpSessionGrants.sessionId", "=", "agentSessionRequests.sessionId"),
      )
      .innerJoin("agentSessions", (join) =>
        join
          .onRef("agentSessions.workspaceId", "=", "mcpSessionGrants.workspaceId")
          .onRef("agentSessions.id", "=", "mcpSessionGrants.sessionId"),
      )
      .select([
        "agentSessions.id as sessionId",
        "agentSessions.status",
        "agentSessions.expiresAt",
      ])
      .where("agentSessionRequests.workspaceId", "=", input.workspaceId)
      .where("agentSessionRequests.id", "=", input.requestId)
      .where("mcpSessionGrants.installationId", "=", input.installationId)
      .executeTakeFirst();
    return session
      ? {
          sessionId: session.sessionId,
          status: session.status,
          expiresAt: timestamp(session.expiresAt),
        }
      : null;
  }

  async findMcpSessionPrincipal(input: {
    workspaceId: string;
    installationId: string;
    sessionId: string;
  }): Promise<AgentSessionCredentialPrincipal | null> {
    const now = new Date();
    const principals = await this.db
      .selectFrom("mcpSessionGrants")
      .innerJoin("mcpInstallations", (join) =>
        join
          .onRef("mcpInstallations.workspaceId", "=", "mcpSessionGrants.workspaceId")
          .onRef("mcpInstallations.id", "=", "mcpSessionGrants.installationId"),
      )
      .innerJoin("agentSessions", (join) =>
        join
          .onRef("agentSessions.workspaceId", "=", "mcpSessionGrants.workspaceId")
          .onRef("agentSessions.id", "=", "mcpSessionGrants.sessionId"),
      )
      .innerJoin("agents", (join) =>
        join
          .onRef("agents.workspaceId", "=", "agentSessions.workspaceId")
          .onRef("agents.id", "=", "agentSessions.agentId"),
      )
      .innerJoin("agentSessionTargets", (join) =>
        join
          .onRef("agentSessionTargets.workspaceId", "=", "agentSessions.workspaceId")
          .onRef("agentSessionTargets.sessionId", "=", "agentSessions.id"),
      )
      .select([
        "agentSessions.workspaceId",
        "agentSessions.agentId",
        "agents.name as agentName",
        "agentSessions.id as sessionId",
        "agentSessionTargets.machineId",
        "agentSessionTargets.profile",
        "agentSessionTargets.capabilities",
        "agentSessionTargets.restrictions",
        "agentSessions.expiresAt",
      ])
      .where("mcpSessionGrants.workspaceId", "=", input.workspaceId)
      .where("mcpSessionGrants.installationId", "=", input.installationId)
      .where("mcpSessionGrants.sessionId", "=", input.sessionId)
      .where("mcpSessionGrants.status", "=", "active")
      .where("mcpSessionGrants.revokedAt", "is", null)
      .where("mcpInstallations.status", "=", "active")
      .where("agentSessions.status", "=", "active")
      .where("agentSessions.expiresAt", ">", now)
      .where("agents.status", "=", "active")
      .where("agentSessionTargets.status", "in", ["opening", "ready"])
      .orderBy("agentSessionTargets.machineId")
      .execute();
    const principal = principals[0];
    if (!principal) return null;
    return {
      workspaceId: principal.workspaceId,
      agentId: principal.agentId,
      agentName: principal.agentName,
      sessionId: principal.sessionId,
      scopes: principals.map((row) => ({
        machineId: row.machineId,
        profile: row.profile,
        capabilities: row.capabilities,
        restrictions: row.restrictions,
      })),
      expiresAt: timestamp(principal.expiresAt),
    };
  }

  async mcpSessionOwner(input: {
    workspaceId: string;
    installationId: string;
    sessionId: string;
  }): Promise<{ agentId: string; userId: string } | null> {
    return (
      (await this.db
        .selectFrom("mcpSessionGrants")
        .innerJoin("mcpInstallations", (join) =>
          join
            .onRef("mcpInstallations.workspaceId", "=", "mcpSessionGrants.workspaceId")
            .onRef("mcpInstallations.id", "=", "mcpSessionGrants.installationId"),
        )
        .select([
          "mcpInstallations.agentId",
          "mcpInstallations.userId",
        ])
        .where("mcpSessionGrants.workspaceId", "=", input.workspaceId)
        .where("mcpSessionGrants.installationId", "=", input.installationId)
        .where("mcpSessionGrants.sessionId", "=", input.sessionId)
        .where("mcpInstallations.status", "=", "active")
        .executeTakeFirst()) ?? null
    );
  }

  async getAgentSessionTargetRuntime(
    workspaceId: string,
    canonicalSessionId: string,
    agentId: string,
    machineId: string,
  ): Promise<AgentSessionTargetRuntime | null> {
    const target = await this.db
      .selectFrom("agentSessionTargets")
      .innerJoin("agentSessions", (join) =>
        join
          .onRef(
            "agentSessions.workspaceId",
            "=",
            "agentSessionTargets.workspaceId",
          )
          .onRef("agentSessions.id", "=", "agentSessionTargets.sessionId"),
      )
      .innerJoin(
        "sessions",
        "sessions.id",
        "agentSessionTargets.runtimeSessionId",
      )
      .select([
        "agentSessionTargets.sessionId as canonicalSessionId",
        "agentSessionTargets.runtimeSessionId",
        "agentSessionTargets.machineId",
        "agentSessionTargets.profile",
        "agentSessionTargets.capabilities",
        "agentSessionTargets.restrictions",
        "sessions.status",
        "sessions.expiresAt",
        "sessions.error",
      ])
      .where("agentSessionTargets.workspaceId", "=", workspaceId)
      .where("agentSessionTargets.sessionId", "=", canonicalSessionId)
      .where("agentSessionTargets.machineId", "=", machineId)
      .where("agentSessions.agentId", "=", agentId)
      .executeTakeFirst();
    if (!target) return null;
    const { error, ...record } = target;
    return {
      ...record,
      expiresAt: timestamp(target.expiresAt),
      ...(error === null ? {} : { error }),
    };
  }

  async listAgentSessionTargetRuntimes(
    workspaceId: string,
    canonicalSessionId: string,
    agentId: string,
  ): Promise<AgentSessionTargetRuntime[]> {
    const targets = await this.db
      .selectFrom("agentSessionTargets")
      .innerJoin("agentSessions", (join) =>
        join
          .onRef(
            "agentSessions.workspaceId",
            "=",
            "agentSessionTargets.workspaceId",
          )
          .onRef("agentSessions.id", "=", "agentSessionTargets.sessionId"),
      )
      .innerJoin(
        "sessions",
        "sessions.id",
        "agentSessionTargets.runtimeSessionId",
      )
      .select([
        "agentSessionTargets.sessionId as canonicalSessionId",
        "agentSessionTargets.runtimeSessionId",
        "agentSessionTargets.machineId",
        "agentSessionTargets.profile",
        "agentSessionTargets.capabilities",
        "agentSessionTargets.restrictions",
        "sessions.status",
        "sessions.expiresAt",
        "sessions.error",
      ])
      .where("agentSessionTargets.workspaceId", "=", workspaceId)
      .where("agentSessionTargets.sessionId", "=", canonicalSessionId)
      .where("agentSessions.agentId", "=", agentId)
      .orderBy("agentSessionTargets.machineId")
      .execute();
    return targets.map((target) => {
      const { error, ...record } = target;
      return {
        ...record,
        expiresAt: timestamp(target.expiresAt),
        ...(error === null ? {} : { error }),
      };
    });
  }

  async cancelAgentSession(input: {
    workspaceId: string;
    sessionId: string;
    agentId: string;
    requestedByHumanId?: string;
    reason: "cancelled" | "revoked";
    now?: number;
  }): Promise<AgentSessionTermination | null> {
    return await withDatabaseDeadlockRetry(() =>
      this.db.transaction().execute(async (transaction) => {
      const session = await transaction
        .selectFrom("agentSessions")
        .selectAll()
        .where("workspaceId", "=", input.workspaceId)
        .where("id", "=", input.sessionId)
        .where("agentId", "=", input.agentId)
        .forUpdate()
        .executeTakeFirst();
      if (!session) return null;
      const request = await transaction
        .selectFrom("agentSessionRequests")
        .select(["id", "requestedByHumanId"])
        .where("workspaceId", "=", input.workspaceId)
        .where("sessionId", "=", input.sessionId)
        .executeTakeFirst();
      if (
        input.requestedByHumanId !== undefined &&
        request?.requestedByHumanId !== input.requestedByHumanId
      ) {
        return null;
      }
      const targets = await transaction
        .selectFrom("agentSessionTargets")
        .select(["machineId", "runtimeSessionId"])
        .where("workspaceId", "=", input.workspaceId)
        .where("sessionId", "=", input.sessionId)
        .execute();
      const runtimeIds = targets.map((target) => target.runtimeSessionId);
      const operations =
        runtimeIds.length === 0
          ? []
          : await transaction
              .selectFrom("operations")
              .innerJoin("sessions", "sessions.id", "operations.sessionId")
              .select(["operations.id", "sessions.machineId"])
              .where("operations.workspaceId", "=", input.workspaceId)
              .where("operations.sessionId", "in", runtimeIds)
              .where("operations.status", "in", ACTIVE_OPERATION_STATUSES)
              .execute();
      if (session.status !== "active") {
        return {
          id: session.id,
          status: session.status as AgentSessionRecord["status"],
          transitioned: false,
          targets,
          operations: [],
        };
      }

      const now = new Date(input.now ?? Date.now());
      await transaction
        .updateTable("sessionCredentials")
        .set({ status: "revoked", revokedAt: now })
        .where("workspaceId", "=", input.workspaceId)
        .where("sessionId", "=", input.sessionId)
        .where("status", "=", "active")
        .execute();
      await transaction
        .updateTable("mcpSessionGrants")
        .set({ status: "revoked", revokedAt: now })
        .where("workspaceId", "=", input.workspaceId)
        .where("sessionId", "=", input.sessionId)
        .where("status", "=", "active")
        .execute();
      await transaction
        .updateTable("agentSessions")
        .set({ status: input.reason, updatedAt: now })
        .where("workspaceId", "=", input.workspaceId)
        .where("id", "=", input.sessionId)
        .where("status", "=", "active")
        .execute();
      if (runtimeIds.length > 0) {
        await transaction
          .updateTable("operations")
          .set({
            status: "cancelled",
            error: input.reason,
            updatedAt: now,
          })
          .where("workspaceId", "=", input.workspaceId)
          .where("sessionId", "in", runtimeIds)
          .where("status", "in", ACTIVE_OPERATION_STATUSES)
          .execute();
        await transaction
          .updateTable("sessions")
          .set({ status: "closing", updatedAt: now })
          .where("workspaceId", "=", input.workspaceId)
          .where("id", "in", runtimeIds)
          .where("status", "in", ACTIVE_SESSION_STATUSES)
          .execute();
      }
      await transaction
        .updateTable("agentSessionTargets")
        .set({ status: "closed", updatedAt: now })
        .where("workspaceId", "=", input.workspaceId)
        .where("sessionId", "=", input.sessionId)
        .execute();
      if (request) {
        await transaction
          .insertInto("sessionTimelineEvents")
          .values({
            workspaceId: input.workspaceId,
            id: randomUUID(),
            sessionId: input.sessionId,
            requestId: request.id,
            operationId: null,
            eventType: `session.${input.reason}`,
            source: "verified",
            metadata: JSON.stringify({}),
            createdAt: now,
          })
          .execute();
      }
      return {
        id: session.id,
        status: input.reason,
        transitioned: true,
        targets,
        operations,
      };
      }),
    );
  }

  async completeAgentSession(input: {
    workspaceId: string;
    sessionId: string;
    agentId: string;
    requestedByHumanId?: string;
    outcome: "succeeded" | "failed";
    summary?: string;
    now?: number;
  }): Promise<AgentSessionCompletion | null> {
    return await withDatabaseDeadlockRetry(() =>
      this.db.transaction().execute(async (transaction) => {
        const session = await transaction
          .selectFrom("agentSessions")
          .selectAll()
          .where("workspaceId", "=", input.workspaceId)
          .where("id", "=", input.sessionId)
          .where("agentId", "=", input.agentId)
          .forUpdate()
          .executeTakeFirst();
        if (!session) return null;
        const request = await transaction
          .selectFrom("agentSessionRequests")
          .select(["id", "requestedByHumanId"])
          .where("workspaceId", "=", input.workspaceId)
          .where("sessionId", "=", input.sessionId)
          .executeTakeFirst();
        if (
          !request ||
          (input.requestedByHumanId !== undefined &&
            request.requestedByHumanId !== input.requestedByHumanId)
        ) {
          return null;
        }
        const targets = await transaction
          .selectFrom("agentSessionTargets")
          .select(["machineId", "runtimeSessionId"])
          .where("workspaceId", "=", input.workspaceId)
          .where("sessionId", "=", input.sessionId)
          .execute();
        if (session.status === "completed") {
          return {
            id: session.id,
            status: "completed",
            transitioned: false,
            targets,
          };
        }
        if (session.status !== "active") return null;
        const runtimeIds = targets.map((target) => target.runtimeSessionId);
        if (runtimeIds.length > 0) {
          const activeOperation = await transaction
            .selectFrom("operations")
            .select("id")
            .where("workspaceId", "=", input.workspaceId)
            .where("sessionId", "in", runtimeIds)
            .where("status", "in", ACTIVE_OPERATION_STATUSES)
            .executeTakeFirst();
          if (activeOperation) return { status: "busy" };
        }

        const now = new Date(input.now ?? Date.now());
        await transaction
          .updateTable("sessionCredentials")
          .set({ status: "revoked", revokedAt: now })
          .where("workspaceId", "=", input.workspaceId)
          .where("sessionId", "=", input.sessionId)
          .where("status", "=", "active")
          .execute();
        await transaction
          .updateTable("mcpSessionGrants")
          .set({ status: "revoked", revokedAt: now })
          .where("workspaceId", "=", input.workspaceId)
          .where("sessionId", "=", input.sessionId)
          .where("status", "=", "active")
          .execute();
        await transaction
          .updateTable("agentSessions")
          .set({ status: "completed", updatedAt: now })
          .where("workspaceId", "=", input.workspaceId)
          .where("id", "=", input.sessionId)
          .where("status", "=", "active")
          .execute();
        if (runtimeIds.length > 0) {
          await transaction
            .updateTable("sessions")
            .set({ status: "closing", updatedAt: now })
            .where("workspaceId", "=", input.workspaceId)
            .where("id", "in", runtimeIds)
            .where("status", "in", ACTIVE_SESSION_STATUSES)
            .execute();
        }
        await transaction
          .updateTable("agentSessionTargets")
          .set({ status: "closed", updatedAt: now })
          .where("workspaceId", "=", input.workspaceId)
          .where("sessionId", "=", input.sessionId)
          .execute();
        await transaction
          .insertInto("sessionTimelineEvents")
          .values([
            {
              workspaceId: input.workspaceId,
              id: randomUUID(),
              sessionId: input.sessionId,
              requestId: request.id,
              operationId: null,
              eventType: "session.completed",
              source: "verified",
              metadata: JSON.stringify({}),
              createdAt: now,
            },
            {
              workspaceId: input.workspaceId,
              id: randomUUID(),
              sessionId: input.sessionId,
              requestId: request.id,
              operationId: null,
              eventType: "session.outcome_reported",
              source: "agent",
              metadata: JSON.stringify({
                outcome: input.outcome,
                ...(input.summary ? { summary: input.summary } : {}),
              }),
              createdAt: now,
            },
          ])
          .execute();
        return {
          id: session.id,
          status: "completed",
          transitioned: true,
          targets,
        };
      }),
    );
  }

  async failClaimedAgentSession(
    workspaceId: string,
    sessionId: string,
    machineId: string,
    reason: "machine_disconnected",
  ): Promise<void> {
    await this.db.transaction().execute(async (transaction) => {
      const request = await transaction
        .selectFrom("agentSessionRequests")
        .select("id")
        .where("workspaceId", "=", workspaceId)
        .where("sessionId", "=", sessionId)
        .forUpdate()
        .executeTakeFirst();
      if (!request) return;
      const now = new Date();
      const targets = await transaction
        .selectFrom("agentSessionTargets")
        .select("runtimeSessionId")
        .where("workspaceId", "=", workspaceId)
        .where("sessionId", "=", sessionId)
        .execute();
      await transaction
        .updateTable("sessions")
        .set({ status: "failed", error: reason, updatedAt: now })
        .where("workspaceId", "=", workspaceId)
        .where("id", "in", targets.map((target) => target.runtimeSessionId))
        .where("status", "in", ACTIVE_SESSION_STATUSES)
        .execute();
      await transaction
        .updateTable("agentSessionTargets")
        .set({ status: "rejected", updatedAt: now })
        .where("workspaceId", "=", workspaceId)
        .where("sessionId", "=", sessionId)
        .execute();
      await transaction
        .updateTable("agentSessions")
        .set({ status: "cancelled", updatedAt: now })
        .where("workspaceId", "=", workspaceId)
        .where("id", "=", sessionId)
        .where("status", "=", "active")
        .execute();
      await transaction
        .updateTable("sessionCredentials")
        .set({ status: "revoked", revokedAt: now })
        .where("workspaceId", "=", workspaceId)
        .where("sessionId", "=", sessionId)
        .where("status", "=", "active")
        .execute();
      await transaction
        .updateTable("mcpSessionGrants")
        .set({ status: "revoked", revokedAt: now })
        .where("workspaceId", "=", workspaceId)
        .where("sessionId", "=", sessionId)
        .where("status", "=", "active")
        .execute();
      await transaction
        .insertInto("sessionTimelineEvents")
        .values({
          workspaceId,
          id: randomUUID(),
          sessionId,
          requestId: request.id,
          operationId: null,
          eventType: "target.rejected",
          source: "verified",
          metadata: JSON.stringify({ machineId, reason }),
          createdAt: now,
        })
        .execute();
    });
  }

  async listSessionTimeline(
    workspaceId: string,
    sessionId: string,
    agentId: string,
    humanId: string,
  ): Promise<SessionTimelineEventRecord[] | null> {
    const owned = await this.db
      .selectFrom("agentSessionRequests")
      .select("id")
      .where("workspaceId", "=", workspaceId)
      .where("sessionId", "=", sessionId)
      .where("agentId", "=", agentId)
      .where("requestedByHumanId", "=", humanId)
      .executeTakeFirst();
    if (!owned) return null;
    return (
      await this.db
        .selectFrom("sessionTimelineEvents")
        .selectAll()
        .where("workspaceId", "=", workspaceId)
        .where("requestId", "=", owned.id)
        .orderBy("createdAt", "asc")
        .execute()
    ).map(sessionTimelineEventRecord);
  }

  async findAgentByTokenHash(tokenHash: string): Promise<AgentTokenRecord | null> {
    const token = await this.db
      .selectFrom("agentTokens")
      .selectAll()
      .where("tokenHash", "=", tokenHash)
      .where("revokedAt", "is", null)
      .where("deletedAt", "is", null)
      .where("expiresAt", ">", new Date())
      .executeTakeFirst();
    return token ? agentTokenRecord(token) : null;
  }

  async findCliByTokenHash(tokenHash: string): Promise<CliTokenRecord | null> {
    const now = new Date();
    const token = await this.db
      .updateTable("cliTokens")
      .set({ lastUsedAt: now })
      .where("tokenHash", "=", tokenHash)
      .where("revokedAt", "is", null)
      .where("expiresAt", ">", now)
      .returningAll()
      .executeTakeFirst();
    if (!token) return null;
    return {
      id: token.id,
      workspaceId: token.workspaceId,
      userId: token.userId,
      expiresAt: timestamp(token.expiresAt),
      createdAt: timestamp(token.createdAt),
    };
  }

  async revokeCliByTokenHash(tokenHash: string): Promise<boolean> {
    const revoked = await this.db
      .updateTable("cliTokens")
      .set({ revokedAt: new Date() })
      .where("tokenHash", "=", tokenHash)
      .where("revokedAt", "is", null)
      .returning("id")
      .executeTakeFirst();
    return revoked !== undefined;
  }

  async createDeviceAuthorization(input: {
    id: string;
    deviceCodeHash: string;
    userCodeHash: string;
    clientName: string;
    expiresAt: number;
  }): Promise<void> {
    await this.db
      .insertInto("deviceAuthorizations")
      .values({
        ...input,
        status: "pending",
        workspaceId: null,
        userId: null,
        expiresAt: new Date(input.expiresAt),
        approvedAt: null,
        consumedAt: null,
      })
      .execute();
  }

  async approveDeviceAuthorization(input: {
    userCodeHash: string;
    userId: string;
    workspaceId: string;
  }): Promise<"approved" | "expired" | "invalid" | "already_used"> {
    return await this.db.transaction().execute(async (transaction) => {
      const authorization = await transaction
        .selectFrom("deviceAuthorizations")
        .selectAll()
        .where("userCodeHash", "=", input.userCodeHash)
        .forUpdate()
        .executeTakeFirst();
      const decision = deviceApprovalDecision(authorization ?? null);
      if (decision !== "approved") return decision;
      if (!authorization) {
        throw new Error("Approved device authorization record is missing");
      }
      await transaction
        .updateTable("deviceAuthorizations")
        .set({
          status: "approved",
          workspaceId: input.workspaceId,
          userId: input.userId,
          approvedAt: new Date(),
        })
        .where("id", "=", authorization.id)
        .execute();
      return "approved";
    });
  }

  async exchangeDeviceAuthorization(input: {
    deviceCodeHash: string;
    tokenId: string;
    tokenHash: string;
    tokenExpiresAt: number;
  }): Promise<DeviceExchangeResult> {
    return await this.db.transaction().execute(async (transaction) => {
      const authorization = await transaction
        .selectFrom("deviceAuthorizations")
        .selectAll()
        .where("deviceCodeHash", "=", input.deviceCodeHash)
        .forUpdate()
        .executeTakeFirst();
      const decision = deviceExchangeDecision(authorization ?? null);
      if (decision !== "authorized") return { status: decision };
      if (!authorization?.workspaceId || !authorization.userId) {
        throw new Error("Authorized device record is missing its workspace or user");
      }
      const workspaceId = authorization.workspaceId;
      const userId = authorization.userId;
      const expiresAt = new Date(input.tokenExpiresAt);
      await transaction
        .insertInto("cliTokens")
        .values({
          workspaceId,
          id: input.tokenId,
          userId,
          tokenHash: input.tokenHash,
          expiresAt,
          revokedAt: null,
          lastUsedAt: null,
        })
        .execute();
      await transaction
        .updateTable("deviceAuthorizations")
        .set({ status: "consumed", consumedAt: new Date() })
        .where("id", "=", authorization.id)
        .execute();
      return {
        status: "authorized",
        tokenId: input.tokenId,
        workspaceId,
        userId,
        expiresAt: expiresAt.getTime(),
      };
    });
  }

  async createAgentDeviceAuthorization(input: {
    id: string;
    deviceCodeHash: string;
    userCodeHash: string;
    agentName: string;
    expiresAt: number;
  }): Promise<void> {
    await this.db
      .insertInto("agentDeviceAuthorizations")
      .values({
        ...input,
        agentName: input.agentName.trim(),
        status: "pending",
        workspaceId: null,
        userId: null,
        agentId: null,
        expiresAt: new Date(input.expiresAt),
        approvedAt: null,
        consumedAt: null,
      })
      .execute();
  }

  async inspectAgentDeviceAuthorization(
    userCodeHash: string,
  ): Promise<
    | { status: "pending"; agentName: string; expiresAt: number }
    | { status: "expired" | "invalid" | "already_used" }
  > {
    const authorization = await this.db
      .selectFrom("agentDeviceAuthorizations")
      .selectAll()
      .where("userCodeHash", "=", userCodeHash)
      .executeTakeFirst();
    const decision = deviceApprovalDecision(authorization ?? null);
    if (decision !== "approved") return { status: decision };
    if (!authorization) return { status: "invalid" };
    return {
      status: "pending",
      agentName: authorization.agentName,
      expiresAt: timestamp(authorization.expiresAt),
    };
  }

  async approveAgentDeviceAuthorization(input: {
    userCodeHash: string;
    userId: string;
    workspaceId: string;
    agentId: string;
  }): Promise<"approved" | "expired" | "invalid" | "already_used"> {
    return await this.db.transaction().execute(async (transaction) => {
      const authorization = await transaction
        .selectFrom("agentDeviceAuthorizations")
        .selectAll()
        .where("userCodeHash", "=", input.userCodeHash)
        .forUpdate()
        .executeTakeFirst();
      const decision = deviceApprovalDecision(authorization ?? null);
      if (decision !== "approved") return decision;
      if (!authorization) return "invalid";

      await transaction
        .insertInto("humans")
        .values({
          workspaceId: input.workspaceId,
          id: input.userId,
          externalId: input.userId,
          status: "active",
        })
        .onConflict((conflict) =>
          conflict.columns(["workspaceId", "id"]).doNothing(),
        )
        .execute();
      await transaction
        .insertInto("agents")
        .values({
          workspaceId: input.workspaceId,
          id: input.agentId,
          name: authorization.agentName,
          kind: "independent",
          parentAgentId: null,
          createdByHumanId: input.userId,
          status: "active",
          deletedAt: null,
        })
        .execute();
      await transaction
        .updateTable("agentDeviceAuthorizations")
        .set({
          status: "approved",
          workspaceId: input.workspaceId,
          userId: input.userId,
          agentId: input.agentId,
          approvedAt: new Date(),
        })
        .where("id", "=", authorization.id)
        .execute();
      return "approved";
    });
  }

  async exchangeAgentDeviceAuthorization(input: {
    deviceCodeHash: string;
    credentialId: string;
    credentialHash: string;
    expiresAt: number;
  }): Promise<AgentDeviceExchangeResult> {
    return await this.db.transaction().execute(async (transaction) => {
      const authorization = await transaction
        .selectFrom("agentDeviceAuthorizations")
        .selectAll()
        .where("deviceCodeHash", "=", input.deviceCodeHash)
        .forUpdate()
        .executeTakeFirst();
      const decision = deviceExchangeDecision(authorization ?? null);
      if (decision !== "authorized") return { status: decision };
      if (
        !authorization?.workspaceId ||
        !authorization.userId ||
        !authorization.agentId
      ) {
        throw new Error("Authorized Agent device record is incomplete");
      }
      const expiresAt = new Date(input.expiresAt);
      await transaction
        .insertInto("agentCredentials")
        .values({
          workspaceId: authorization.workspaceId,
          id: input.credentialId,
          agentId: authorization.agentId,
          tokenHash: input.credentialHash,
          status: "active",
          expiresAt,
          retiringAt: null,
          revokedAt: null,
        })
        .execute();
      await transaction
        .updateTable("agentDeviceAuthorizations")
        .set({ status: "consumed", consumedAt: new Date() })
        .where("id", "=", authorization.id)
        .execute();
      return {
        status: "authorized",
        workspaceId: authorization.workspaceId,
        agentId: authorization.agentId,
        agentName: authorization.agentName,
        credentialId: input.credentialId,
        expiresAt: expiresAt.getTime(),
      };
    });
  }

  async findAgentCredentialByTokenHash(
    tokenHash: string,
  ): Promise<AgentCredentialPrincipal | null> {
    const now = new Date();
    const credential = await this.db
      .selectFrom("agentCredentials")
      .innerJoin("agents", (join) =>
        join
          .onRef("agents.workspaceId", "=", "agentCredentials.workspaceId")
          .onRef("agents.id", "=", "agentCredentials.agentId"),
      )
      .select([
        "agentCredentials.workspaceId",
        "agentCredentials.id as credentialId",
        "agentCredentials.agentId",
        "agentCredentials.expiresAt",
        "agents.name as agentName",
        "agents.createdByHumanId as ownerHumanId",
      ])
      .where("agentCredentials.tokenHash", "=", tokenHash)
      .where("agentCredentials.revokedAt", "is", null)
      .where("agentCredentials.expiresAt", ">", now)
      .where("agents.kind", "=", "independent")
      .where("agents.status", "=", "active")
      .where((builder) =>
        builder.or([
          builder("agentCredentials.status", "=", "active"),
          builder.and([
            builder("agentCredentials.status", "=", "retiring"),
            builder("agentCredentials.retiringAt", ">", now),
          ]),
        ]),
      )
      .executeTakeFirst();
    if (!credential?.ownerHumanId) return null;
    return {
      workspaceId: credential.workspaceId,
      credentialId: credential.credentialId,
      agentId: credential.agentId,
      agentName: credential.agentName,
      ownerHumanId: credential.ownerHumanId,
      expiresAt: timestamp(credential.expiresAt),
    };
  }

  async rotateAgentCredential(input: {
    currentTokenHash: string;
    credentialId: string;
    credentialHash: string;
    expiresAt: number;
    overlapMilliseconds: number;
  }): Promise<AgentCredentialPrincipal | null> {
    return await this.db.transaction().execute(async (transaction) => {
      const now = new Date();
      const current = await transaction
        .selectFrom("agentCredentials")
        .innerJoin("agents", (join) =>
          join
            .onRef("agents.workspaceId", "=", "agentCredentials.workspaceId")
            .onRef("agents.id", "=", "agentCredentials.agentId"),
        )
        .select([
          "agentCredentials.workspaceId",
          "agentCredentials.id",
          "agentCredentials.agentId",
          "agentCredentials.expiresAt",
          "agentCredentials.status",
          "agentCredentials.revokedAt",
          "agents.name as agentName",
          "agents.createdByHumanId as ownerHumanId",
          "agents.status as agentStatus",
        ])
        .where("agentCredentials.tokenHash", "=", input.currentTokenHash)
        .forUpdate()
        .executeTakeFirst();
      if (
        !current?.ownerHumanId ||
        current.revokedAt ||
        current.agentStatus !== "active" ||
        current.expiresAt <= now ||
        current.status !== "active"
      ) {
        return null;
      }
      const expiresAt = new Date(input.expiresAt);
      if (
        expiresAt <= now ||
        expiresAt.getTime() > now.getTime() + 365 * 24 * 60 * 60 * 1_000
      ) {
        return null;
      }
      const retiringAt = new Date(
        Math.min(
          current.expiresAt.getTime(),
          now.getTime() + Math.min(input.overlapMilliseconds, 10 * 60 * 1_000),
        ),
      );
      await transaction
        .updateTable("agentCredentials")
        .set({ status: "retiring", retiringAt })
        .where("workspaceId", "=", current.workspaceId)
        .where("id", "=", current.id)
        .execute();
      await transaction
        .insertInto("agentCredentials")
        .values({
          workspaceId: current.workspaceId,
          id: input.credentialId,
          agentId: current.agentId,
          tokenHash: input.credentialHash,
          status: "active",
          expiresAt,
          retiringAt: null,
          revokedAt: null,
        })
        .execute();
      return {
        workspaceId: current.workspaceId,
        credentialId: input.credentialId,
        agentId: current.agentId,
        agentName: current.agentName,
        ownerHumanId: current.ownerHumanId,
        expiresAt: expiresAt.getTime(),
      };
    });
  }

  async revokeAgentHierarchyByTokenHash(
    tokenHash: string,
  ): Promise<{
    workspaceId: string;
    parentAgentId: string;
    ownerHumanId: string;
    agentIds: string[];
    sessionIds: Array<{ id: string; agentId: string }>;
  } | null> {
    return await this.db.transaction().execute(async (transaction) => {
      const now = new Date();
      const credential = await transaction
        .selectFrom("agentCredentials")
        .innerJoin("agents", (join) =>
          join
            .onRef("agents.workspaceId", "=", "agentCredentials.workspaceId")
            .onRef("agents.id", "=", "agentCredentials.agentId"),
        )
        .select([
          "agentCredentials.workspaceId",
          "agentCredentials.agentId",
          "agents.createdByHumanId as ownerHumanId",
        ])
        .where("agentCredentials.tokenHash", "=", tokenHash)
        .where("agentCredentials.revokedAt", "is", null)
        .forUpdate()
        .executeTakeFirst();
      if (!credential?.ownerHumanId) return null;
      const descendants = await transaction
        .selectFrom("agents")
        .select("id")
        .where("workspaceId", "=", credential.workspaceId)
        .where("parentAgentId", "=", credential.agentId)
        .where("kind", "=", "managed")
        .where("deletedAt", "is", null)
        .forUpdate()
        .execute();
      const agentIds = [
        credential.agentId,
        ...descendants.map((agent) => agent.id),
      ];
      await transaction
        .updateTable("agentCredentials")
        .set({
          status: "revoked",
          revokedAt: now,
          retiringAt: null,
        })
        .where("workspaceId", "=", credential.workspaceId)
        .where("agentId", "=", credential.agentId)
        .where("revokedAt", "is", null)
        .execute();
      await transaction
        .updateTable("agents")
        .set({ status: "disabled", updatedAt: now })
        .where("workspaceId", "=", credential.workspaceId)
        .where("id", "in", agentIds)
        .execute();
      await transaction
        .updateTable("agentPolicies")
        .set({ status: "revoked", updatedAt: now })
        .where("workspaceId", "=", credential.workspaceId)
        .where("agentId", "in", agentIds)
        .where("status", "in", ["active", "paused", "proposed"])
        .execute();
      const sessions = await transaction
        .selectFrom("agentSessions")
        .select(["id", "agentId"])
        .where("workspaceId", "=", credential.workspaceId)
        .where("agentId", "in", agentIds)
        .where("status", "=", "active")
        .execute();
      return {
        workspaceId: credential.workspaceId,
        parentAgentId: credential.agentId,
        ownerHumanId: credential.ownerHumanId,
        agentIds,
        sessionIds: sessions,
      };
    });
  }

  async createEnrollmentToken(
    workspaceId: string,
    tokenHash: string,
    expiresAt: number,
  ): Promise<void> {
    await this.db
      .insertInto("enrollmentTokens")
      .values({
        workspaceId,
        tokenHash,
        expiresAt: new Date(expiresAt),
        usedAt: null,
      })
      .execute();
  }

  async listAgentTokens(workspaceId: string): Promise<AgentTokenRecord[]> {
    const tokens = await this.db
      .selectFrom("agentTokens")
      .selectAll()
      .where("workspaceId", "=", workspaceId)
      .where("deletedAt", "is", null)
      .orderBy("createdAt", "desc")
      .limit(200)
      .execute();
    return tokens.map(agentTokenRecord);
  }

  async listMachines(workspaceId: string, options: {
    includeRevoked?: boolean;
    machineIds?: string[];
  } = {}): Promise<MachineRecord[]> {
    let query = this.db
      .selectFrom("machines")
      .selectAll()
      .where("workspaceId", "=", workspaceId);
    if (!options.includeRevoked) query = query.where("revokedAt", "is", null);
    if (options.machineIds) {
      if (options.machineIds.length === 0) return [];
      query = query.where("id", "in", options.machineIds);
    }
    return (await query.orderBy("enrolledAt", "asc").execute()).map(machineRecord);
  }

  async activeMachinesExist(workspaceId: string, machineIds: string[]): Promise<boolean> {
    if (machineIds.length === 0) return true;
    const result = await this.db
      .selectFrom("machines")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("workspaceId", "=", workspaceId)
      .where("id", "in", machineIds)
      .where("revokedAt", "is", null)
      .executeTakeFirstOrThrow();
    return Number(result.count) === new Set(machineIds).size;
  }

  async createAgentToken(input: {
    workspaceId: string;
    id: string;
    name: string;
    tokenHash: string;
    machineIds: string[];
    capabilities: Capability[];
    expiresAt: number;
  }): Promise<
    | { created: true }
    | { created: false; plan: CloudPlanId; activeAgentLimit: number }
  > {
    return await this.db.transaction().execute(async (transaction) => {
      await sql`select pg_advisory_xact_lock(hashtext(${input.workspaceId}))`.execute(
        transaction,
      );
      const workspace = await transaction
        .selectFrom("workspaces")
        .innerJoin("organizations", "organizations.id", "workspaces.organizationId")
        .select(["organizations.plan", "organizations.externalId"])
        .where("workspaces.id", "=", input.workspaceId)
        .executeTakeFirstOrThrow();
      const plan = workspace.plan as CloudPlanId;
      const activeAgentLimit = entitlementsFor(plan).activeAgentLimit;
      if (workspace.externalId !== null) {
        const activeAgents = await transaction
          .selectFrom("agentTokens")
          .select(({ fn }) => fn.countAll<number>().as("count"))
          .where("workspaceId", "=", input.workspaceId)
          .where("revokedAt", "is", null)
          .where("deletedAt", "is", null)
          .where("expiresAt", ">", new Date())
          .executeTakeFirstOrThrow();
        if (Number(activeAgents.count) >= activeAgentLimit) {
          return { created: false, plan, activeAgentLimit };
        }
      }
      await transaction
        .insertInto("agentTokens")
        .values({
          ...input,
          machineIds: JSON.stringify(input.machineIds),
          capabilities: JSON.stringify(input.capabilities),
          expiresAt: new Date(input.expiresAt),
          revokedAt: null,
          deletedAt: null,
        })
        .execute();
      return { created: true };
    });
  }

  async revokeAgentToken(
    workspaceId: string,
    tokenId: string,
  ): Promise<AgentTokenRecord | null> {
    const now = new Date();
    const token = await this.db
      .updateTable("agentTokens")
      .set({ revokedAt: sql`coalesce(revoked_at, ${now})` })
      .where("workspaceId", "=", workspaceId)
      .where("id", "=", tokenId)
      .where("revokedAt", "is", null)
      .returningAll()
      .executeTakeFirst();
    return token ? agentTokenRecord(token) : null;
  }

  async deleteAgentToken(
    workspaceId: string,
    tokenId: string,
  ): Promise<{
    token: AgentTokenRecord;
    sessions: Array<{ id: string; machineId: string }>;
  } | null> {
    return await this.db.transaction().execute(async (transaction) => {
      const now = new Date();
      const token = await transaction
        .updateTable("agentTokens")
        .set({
          revokedAt: sql`coalesce(revoked_at, ${now})`,
          deletedAt: now,
        })
        .where("workspaceId", "=", workspaceId)
        .where("id", "=", tokenId)
        .where("deletedAt", "is", null)
        .returningAll()
        .executeTakeFirst();
      if (!token) return null;

      const sessions = await transaction
        .updateTable("sessions")
        .set({ status: "expired", updatedAt: now })
        .where("workspaceId", "=", workspaceId)
        .where("principalId", "=", tokenId)
        .where("status", "in", ACTIVE_SESSION_STATUSES)
        .returning(["id", "machineId"])
        .execute();
      return {
        token: agentTokenRecord(token),
        sessions,
      };
    });
  }

  async expireAgentSessions(
    workspaceId: string,
    principalId: string,
  ): Promise<Array<{ id: string; machineId: string }>> {
    return await this.db
      .updateTable("sessions")
      .set({ status: "expired", updatedAt: new Date() })
      .where("workspaceId", "=", workspaceId)
      .where("principalId", "=", principalId)
      .where("status", "in", ACTIVE_SESSION_STATUSES)
      .returning(["id", "machineId"])
      .execute();
  }

  async enrollMachine(input: {
    tokenHash: string;
    machineId: string;
    name: string;
    publicKey: string;
  }): Promise<
    | { status: "enrolled"; machineId: string; name: string; workspaceId: string }
    | { status: "machine_limit_reached"; workspaceId: string; machineLimit: number }
    | null
  > {
    return await this.db.transaction().execute(async (transaction) => {
      const enrollment = await transaction
        .selectFrom("enrollmentTokens")
        .selectAll()
        .where("tokenHash", "=", input.tokenHash)
        .forUpdate()
        .executeTakeFirst();
      const now = new Date();
      if (
        !enrollment ||
        enrollment.usedAt !== null ||
        enrollment.expiresAt <= now
      ) {
        return null;
      }
      const organization = await transaction
        .selectFrom("workspaces")
        .innerJoin("organizations", "organizations.id", "workspaces.organizationId")
        .select(["organizations.plan", "organizations.externalId"])
        .where("workspaces.id", "=", enrollment.workspaceId)
        .executeTakeFirstOrThrow();
      const entitlement = entitlementsFor(organization.plan);
      const activeMachines = await transaction
        .selectFrom("machines")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where("workspaceId", "=", enrollment.workspaceId)
        .where("revokedAt", "is", null)
        .executeTakeFirstOrThrow();
      if (
        organization.externalId !== null &&
        Number(activeMachines.count) >= entitlement.machineLimit
      ) {
        return {
          status: "machine_limit_reached",
          workspaceId: enrollment.workspaceId,
          machineLimit: entitlement.machineLimit,
        };
      }
      await transaction
        .updateTable("enrollmentTokens")
        .set({ usedAt: now })
        .where("tokenHash", "=", input.tokenHash)
        .execute();
      await transaction
        .insertInto("machines")
        .values({
          workspaceId: enrollment.workspaceId,
          id: input.machineId,
          name: input.name,
          publicKey: input.publicKey,
          status: "offline",
          runtime: null,
          lastSeenAt: null,
          revokedAt: null,
          enrolledAt: now,
        })
        .execute();
      return {
        status: "enrolled",
        machineId: input.machineId,
        name: input.name,
        workspaceId: enrollment.workspaceId,
      };
    });
  }

  async machinePublicKey(
    machineId: string,
  ): Promise<{ publicKey: string; workspaceId: string } | null> {
    const machine = await this.db
      .selectFrom("machines")
      .select(["publicKey", "workspaceId"])
      .where("id", "=", machineId)
      .where("revokedAt", "is", null)
      .executeTakeFirst();
    return machine ?? null;
  }

  async setMachineOffline(machineId: string): Promise<void> {
    await this.db
      .updateTable("machines")
      .set({ status: "offline" })
      .where("id", "=", machineId)
      .execute();
  }

  async markMachineDisconnected(machineId: string): Promise<{
    workspaceId: string;
    operations: number;
    targets: number;
  } | null> {
    return await this.db.transaction().execute(async (transaction) => {
      const machine = await transaction
        .updateTable("machines")
        .set({ status: "offline" })
        .where("id", "=", machineId)
        .returning("workspaceId")
        .executeTakeFirst();
      if (!machine) return null;
      const now = new Date();
      const runtimes = await transaction
        .selectFrom("sessions")
        .select("id")
        .where("workspaceId", "=", machine.workspaceId)
        .where("machineId", "=", machineId)
        .where("status", "in", ACTIVE_SESSION_STATUSES)
        .execute();
      const runtimeIds = runtimes.map((runtime) => runtime.id);
      const operations =
        runtimeIds.length === 0
          ? []
          : await transaction
              .updateTable("operations")
              .set({
                status: "execution_unknown",
                error: "machine_disconnected",
                updatedAt: now,
              })
              .where("workspaceId", "=", machine.workspaceId)
              .where("sessionId", "in", runtimeIds)
              .where("status", "in", ACTIVE_OPERATION_STATUSES)
              .returning("id")
              .execute();
      if (runtimeIds.length > 0) {
        await transaction
          .updateTable("sessions")
          .set({
            status: "failed",
            error: "machine_disconnected",
            updatedAt: now,
          })
          .where("workspaceId", "=", machine.workspaceId)
          .where("id", "in", runtimeIds)
          .where("status", "in", ACTIVE_SESSION_STATUSES)
          .execute();
      }
      const targets =
        runtimeIds.length === 0
          ? []
          : await transaction
              .updateTable("agentSessionTargets")
              .set({ status: "rejected", updatedAt: now })
              .where("workspaceId", "=", machine.workspaceId)
              .where("runtimeSessionId", "in", runtimeIds)
              .where("status", "in", ["opening", "ready"])
              .returning(["sessionId", "runtimeSessionId"])
              .execute();
      for (const target of targets) {
        const request = await transaction
          .selectFrom("agentSessionRequests")
          .select("id")
          .where("workspaceId", "=", machine.workspaceId)
          .where("sessionId", "=", target.sessionId)
          .executeTakeFirst();
        if (request) {
          await transaction
            .insertInto("sessionTimelineEvents")
            .values({
              workspaceId: machine.workspaceId,
              id: randomUUID(),
              sessionId: target.sessionId,
              requestId: request.id,
              operationId: null,
              eventType: "target.disconnected",
              source: "verified",
              metadata: JSON.stringify({ machineId }),
              createdAt: now,
            })
            .execute();
        }
        const remaining = await transaction
          .selectFrom("agentSessionTargets")
          .select("machineId")
          .where("workspaceId", "=", machine.workspaceId)
          .where("sessionId", "=", target.sessionId)
          .where("status", "in", ["opening", "ready"])
          .executeTakeFirst();
        if (!remaining) {
          await transaction
            .updateTable("agentSessions")
            .set({ status: "cancelled", updatedAt: now })
            .where("workspaceId", "=", machine.workspaceId)
            .where("id", "=", target.sessionId)
            .where("status", "=", "active")
            .execute();
          await transaction
            .updateTable("sessionCredentials")
            .set({ status: "revoked", revokedAt: now })
            .where("workspaceId", "=", machine.workspaceId)
            .where("sessionId", "=", target.sessionId)
            .where("status", "=", "active")
            .execute();
        }
      }
      return {
        workspaceId: machine.workspaceId,
        operations: operations.length,
        targets: targets.length,
      };
    });
  }

  async setMachineOnline(machineId: string, runtime?: unknown): Promise<boolean> {
    const update = {
      status: "online",
      lastSeenAt: new Date(),
      ...(runtime === undefined ? {} : { runtime: JSON.stringify(runtime) }),
    };
    const result = await this.db
      .updateTable("machines")
      .set(update)
      .where("id", "=", machineId)
      .where("revokedAt", "is", null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  async setMachineIncompatible(
    machineId: string,
    runtime: unknown,
  ): Promise<boolean> {
    const result = await this.db
      .updateTable("machines")
      .set({
        status: "offline",
        lastSeenAt: new Date(),
        runtime: JSON.stringify(runtime),
      })
      .where("id", "=", machineId)
      .where("revokedAt", "is", null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  async heartbeat(machineId: string): Promise<void> {
    await this.db
      .updateTable("machines")
      .set({ status: "online", lastSeenAt: new Date() })
      .where("id", "=", machineId)
      .where("revokedAt", "is", null)
      .execute();
  }

  async revokeMachine(workspaceId: string, machineId: string): Promise<{
    id: string;
    name: string;
    revokedAt: number;
    operationIds: string[];
    sessionIds: string[];
  } | null> {
    return await this.db.transaction().execute(async (transaction) => {
      const now = new Date();
      const machine = await transaction
        .updateTable("machines")
        .set({ status: "offline", revokedAt: now })
        .where("workspaceId", "=", workspaceId)
        .where("id", "=", machineId)
        .where("revokedAt", "is", null)
        .returning(["id", "name"])
        .executeTakeFirst();
      if (!machine) return null;

      const sessions = await transaction
        .updateTable("sessions")
        .set({ status: "closed", error: "machine_revoked", updatedAt: now })
        .where("workspaceId", "=", workspaceId)
        .where("machineId", "=", machineId)
        .where("status", "in", CLOSABLE_SESSION_STATUSES)
        .returning("id")
        .execute();
      const sessionIds = sessions.map((session) => session.id);
      const operations =
        sessionIds.length === 0
          ? []
          : await transaction
              .updateTable("operations")
              .set({ status: "cancelled", error: "machine_revoked", updatedAt: now })
              .where("workspaceId", "=", workspaceId)
              .where("sessionId", "in", sessionIds)
              .where("status", "in", ACTIVE_OPERATION_STATUSES)
              .returning("id")
              .execute();
      return {
        ...machine,
        revokedAt: timestamp(now),
        sessionIds,
        operationIds: operations.map((operation) => operation.id),
      };
    });
  }

  async listSessions(workspaceId: string, principalId: string): Promise<SessionRecord[]> {
    const sessions = await this.db
      .selectFrom("sessions")
      .leftJoin("machines", "machines.id", "sessions.machineId")
      .selectAll("sessions")
      .select("machines.name as machineName")
      .where("sessions.workspaceId", "=", workspaceId)
      .where("sessions.principalId", "=", principalId)
      .orderBy("sessions.createdAt", "desc")
      .limit(100)
      .execute();
    return sessions.map((session) =>
      sessionRecord(session, session.machineName ?? "Unknown machine"),
    );
  }

  async createSession(input: {
    workspaceId: string;
    id: string;
    machineId: string;
    principalId: string;
    profile: string;
    capabilities: Capability[];
    expiresAt: number;
    requireActiveAgentToken: boolean;
  }): Promise<boolean> {
    return await this.db.transaction().execute(async (transaction) => {
      if (input.requireActiveAgentToken) {
        const token = await transaction
          .selectFrom("agentTokens")
          .select("id")
          .where("workspaceId", "=", input.workspaceId)
          .where("id", "=", input.principalId)
          .where("revokedAt", "is", null)
          .where("deletedAt", "is", null)
          .where("expiresAt", ">", new Date())
          .forShare()
          .executeTakeFirst();
        if (!token) return false;
      }
      await transaction
        .insertInto("sessions")
        .values({
          workspaceId: input.workspaceId,
          id: input.id,
          machineId: input.machineId,
          principalId: input.principalId,
          profile: input.profile,
          capabilities: JSON.stringify(input.capabilities),
          status: "opening",
          expiresAt: new Date(input.expiresAt),
          error: null,
        })
        .execute();
      return true;
    });
  }

  async getSession(
    workspaceId: string,
    sessionId: string,
    principalId: string,
  ): Promise<SessionRecord | null> {
    const session = await this.db
      .selectFrom("sessions")
      .selectAll()
      .where("workspaceId", "=", workspaceId)
      .where("id", "=", sessionId)
      .where("principalId", "=", principalId)
      .executeTakeFirst();
    return session ? sessionRecord(session) : null;
  }

  async getActiveSession(
    workspaceId: string,
    sessionId: string,
    principalId: string,
  ): Promise<SessionRecord | null> {
    const session = await this.db
      .selectFrom("sessions")
      .selectAll()
      .where("workspaceId", "=", workspaceId)
      .where("id", "=", sessionId)
      .where("principalId", "=", principalId)
      .where("status", "in", ACTIVE_SESSION_STATUSES)
      .executeTakeFirst();
    return session ? sessionRecord(session) : null;
  }

  async markSessionClosing(workspaceId: string, sessionId: string): Promise<void> {
    await this.db
      .updateTable("sessions")
      .set({ status: "closing", updatedAt: new Date() })
      .where("workspaceId", "=", workspaceId)
      .where("id", "=", sessionId)
      .execute();
  }

  async markSessionOpened(
    machineId: string,
    sessionId: string,
  ): Promise<{ principalId: string; workspaceId: string } | null> {
    return await withDatabaseDeadlockRetry(() =>
      this.db.transaction().execute(async (transaction) => {
      const result =
        (await transaction
        .updateTable("sessions")
        .set({ status: "ready", updatedAt: new Date(), error: null })
        .where("id", "=", sessionId)
        .where("machineId", "=", machineId)
        .where("status", "=", "opening")
        .returning(["principalId", "workspaceId"])
        .executeTakeFirst()) ?? null;
      if (!result) return null;
      const target = await transaction
        .selectFrom("agentSessionTargets")
        .innerJoin("agentSessionRequests", (join) =>
          join
            .onRef(
              "agentSessionRequests.workspaceId",
              "=",
              "agentSessionTargets.workspaceId",
            )
            .onRef(
              "agentSessionRequests.sessionId",
              "=",
              "agentSessionTargets.sessionId",
            ),
        )
        .select([
          "agentSessionRequests.id as requestId",
          "agentSessionTargets.sessionId as canonicalSessionId",
        ])
        .where("agentSessionTargets.workspaceId", "=", result.workspaceId)
        .where("agentSessionTargets.runtimeSessionId", "=", sessionId)
        .executeTakeFirst();
      if (target) {
        const now = new Date();
        await transaction
          .updateTable("agentSessionTargets")
          .set({ status: "ready", updatedAt: now })
          .where("workspaceId", "=", result.workspaceId)
          .where("runtimeSessionId", "=", sessionId)
          .execute();
        await transaction
          .insertInto("sessionTimelineEvents")
          .values({
            workspaceId: result.workspaceId,
            id: randomUUID(),
            sessionId: target.canonicalSessionId,
            requestId: target.requestId,
            operationId: null,
            eventType: "target.ready",
            source: "verified",
            metadata: JSON.stringify({ machineId }),
            createdAt: now,
          })
          .execute();
      }
        return result;
      }),
    );
  }

  async markSessionOpenFailed(
    machineId: string,
    sessionId: string,
    error: string,
  ): Promise<{ principalId: string; workspaceId: string } | null> {
    return await withDatabaseDeadlockRetry(() =>
      this.db.transaction().execute(async (transaction) => {
      const result =
        (await transaction
        .updateTable("sessions")
        .set({ status: "failed", updatedAt: new Date(), error })
        .where("id", "=", sessionId)
        .where("machineId", "=", machineId)
        .where("status", "=", "opening")
        .returning(["principalId", "workspaceId"])
        .executeTakeFirst()) ?? null;
      if (!result) return null;
      const target = await transaction
        .selectFrom("agentSessionTargets")
        .innerJoin("agentSessionRequests", (join) =>
          join
            .onRef(
              "agentSessionRequests.workspaceId",
              "=",
              "agentSessionTargets.workspaceId",
            )
            .onRef(
              "agentSessionRequests.sessionId",
              "=",
              "agentSessionTargets.sessionId",
            ),
        )
        .select([
          "agentSessionRequests.id as requestId",
          "agentSessionTargets.sessionId as canonicalSessionId",
        ])
        .where("agentSessionTargets.workspaceId", "=", result.workspaceId)
        .where("agentSessionTargets.runtimeSessionId", "=", sessionId)
        .executeTakeFirst();
      if (target) {
        const now = new Date();
        await transaction
          .updateTable("agentSessionTargets")
          .set({ status: "rejected", updatedAt: now })
          .where("workspaceId", "=", result.workspaceId)
          .where("runtimeSessionId", "=", sessionId)
          .execute();
        await transaction
          .insertInto("sessionTimelineEvents")
          .values({
            workspaceId: result.workspaceId,
            id: randomUUID(),
            sessionId: target.canonicalSessionId,
            requestId: target.requestId,
            operationId: null,
            eventType: "target.rejected",
            source: "verified",
            metadata: JSON.stringify({ machineId, reason: "client_rejected" }),
            createdAt: now,
          })
          .execute();
      }
        return result;
      }),
    );
  }

  async markSessionClosed(
    machineId: string,
    sessionId: string,
  ): Promise<{ principalId: string; workspaceId: string; status: string } | null> {
    return await withDatabaseDeadlockRetry(() =>
      this.db.transaction().execute(async (transaction) => {
      const session = await transaction
        .selectFrom("sessions")
        .select(["principalId", "workspaceId", "expiresAt"])
        .where("id", "=", sessionId)
        .where("machineId", "=", machineId)
        .where("status", "in", CLOSABLE_SESSION_STATUSES)
        .forUpdate()
        .executeTakeFirst();
      if (!session) return null;
      const status = session.expiresAt <= new Date() ? "expired" : "closed";
      await transaction
        .updateTable("sessions")
        .set({ status, updatedAt: new Date() })
        .where("id", "=", sessionId)
        .execute();
      const target = await transaction
        .selectFrom("agentSessionTargets")
        .innerJoin("agentSessionRequests", (join) =>
          join
            .onRef(
              "agentSessionRequests.workspaceId",
              "=",
              "agentSessionTargets.workspaceId",
            )
            .onRef(
              "agentSessionRequests.sessionId",
              "=",
              "agentSessionTargets.sessionId",
            ),
        )
        .select([
          "agentSessionRequests.id as requestId",
          "agentSessionTargets.sessionId as canonicalSessionId",
        ])
        .where("agentSessionTargets.workspaceId", "=", session.workspaceId)
        .where("agentSessionTargets.runtimeSessionId", "=", sessionId)
        .executeTakeFirst();
      if (target) {
        const now = new Date();
        await transaction
          .updateTable("agentSessionTargets")
          .set({ status: "closed", updatedAt: now })
          .where("workspaceId", "=", session.workspaceId)
          .where("runtimeSessionId", "=", sessionId)
          .execute();
        const remaining = await transaction
          .selectFrom("agentSessionTargets")
          .select("machineId")
          .where("workspaceId", "=", session.workspaceId)
          .where("sessionId", "=", target.canonicalSessionId)
          .where("status", "in", ["opening", "ready"])
          .executeTakeFirst();
        if (!remaining) {
          const canonicalStatus =
            status === "expired" ? "expired" : "completed";
          await transaction
            .updateTable("agentSessions")
            .set({ status: canonicalStatus, updatedAt: now })
            .where("workspaceId", "=", session.workspaceId)
            .where("id", "=", target.canonicalSessionId)
            .where("status", "=", "active")
            .execute();
          await transaction
            .updateTable("sessionCredentials")
            .set({ status: "revoked", revokedAt: now })
            .where("workspaceId", "=", session.workspaceId)
            .where("sessionId", "=", target.canonicalSessionId)
            .where("status", "=", "active")
            .execute();
        }
        await transaction
          .insertInto("sessionTimelineEvents")
          .values({
            workspaceId: session.workspaceId,
            id: randomUUID(),
            sessionId: target.canonicalSessionId,
            requestId: target.requestId,
            operationId: null,
            eventType: "session.closed",
            source: "verified",
            metadata: JSON.stringify({ machineId, status }),
            createdAt: now,
          })
          .execute();
      }
        return {
          principalId: session.principalId,
          workspaceId: session.workspaceId,
          status,
        };
      }),
    );
  }

  async findOperationByIdempotency(
    workspaceId: string,
    sessionId: string,
    principalId: string,
    idempotencyKey: string,
  ): Promise<Pick<OperationRecord, "id" | "status"> | null> {
    return (
      (await this.db
        .selectFrom("operations")
        .select(["id", "status"])
        .where("workspaceId", "=", workspaceId)
        .where("sessionId", "=", sessionId)
        .where("principalId", "=", principalId)
        .where("idempotencyKey", "=", idempotencyKey)
        .executeTakeFirst()) ?? null
    );
  }

  async sessionForOperation(
    workspaceId: string,
    sessionId: string,
    principalId: string,
  ): Promise<SessionRecord | null> {
    return await this.getSession(workspaceId, sessionId, principalId);
  }

  async createOperation(input: {
    workspaceId: string;
    id: string;
    sessionId: string;
    principalId: string;
    action: OperationAction;
    timeoutSeconds: number;
    maxOutputBytes: number;
    idempotencyKey: string;
  }): Promise<boolean> {
    return await this.db.transaction().execute(async (transaction) => {
      const canonical = await transaction
        .selectFrom("agentSessionTargets")
        .innerJoin("agentSessions", (join) =>
          join
            .onRef(
              "agentSessions.workspaceId",
              "=",
              "agentSessionTargets.workspaceId",
            )
            .onRef("agentSessions.id", "=", "agentSessionTargets.sessionId"),
        )
        .select(["agentSessions.agentId", "agentSessions.status"])
        .where("agentSessionTargets.workspaceId", "=", input.workspaceId)
        .where("agentSessionTargets.runtimeSessionId", "=", input.sessionId)
        .forShare()
        .executeTakeFirst();
      if (
        canonical &&
        (canonical.agentId !== input.principalId ||
          canonical.status !== "active")
      ) {
        return false;
      }
      const result = await transaction
        .insertInto("operations")
        .values({
          ...input,
          action: JSON.stringify(input.action),
          status: "queued",
          exitCode: null,
          error: null,
          outputTruncated: false,
        })
        .onConflict((conflict) =>
          conflict
            .columns(["sessionId", "principalId", "idempotencyKey"])
            .doNothing(),
        )
        .returning("id")
        .executeTakeFirst();
      return result !== undefined;
    });
  }

  async markOperationDelivered(workspaceId: string, operationId: string): Promise<void> {
    await this.db
      .updateTable("operations")
      .set({ status: "delivered", updatedAt: new Date() })
      .where("workspaceId", "=", workspaceId)
      .where("id", "=", operationId)
      .where("status", "=", "queued")
      .execute();
  }

  async markOperationStarted(machineId: string, operationId: string): Promise<void> {
    await this.db.transaction().execute(async (transaction) => {
      const operation = await transaction
        .updateTable("operations")
        .set({ status: "running", updatedAt: new Date() })
        .where("id", "=", operationId)
        .where("status", "in", ["queued", "delivered"])
        .where(({ exists, selectFrom }) =>
          exists(
            selectFrom("sessions")
              .select("sessions.id")
              .whereRef("sessions.id", "=", "operations.sessionId")
              .where("sessions.machineId", "=", machineId),
          ),
        )
        .returning(["workspaceId", "sessionId", "action"])
        .executeTakeFirst();
      if (!operation) return;
      const request = await transaction
        .selectFrom("agentSessionTargets")
        .innerJoin("agentSessionRequests", (join) =>
          join
            .onRef(
              "agentSessionRequests.workspaceId",
              "=",
              "agentSessionTargets.workspaceId",
            )
            .onRef(
              "agentSessionRequests.sessionId",
              "=",
              "agentSessionTargets.sessionId",
            ),
        )
        .select([
          "agentSessionRequests.id",
          "agentSessionTargets.sessionId as canonicalSessionId",
        ])
        .where("agentSessionTargets.workspaceId", "=", operation.workspaceId)
        .where("agentSessionTargets.runtimeSessionId", "=", operation.sessionId)
        .executeTakeFirst();
      if (!request) return;
      await transaction
        .insertInto("sessionTimelineEvents")
        .values({
          workspaceId: operation.workspaceId,
          id: randomUUID(),
          sessionId: request.canonicalSessionId,
          requestId: request.id,
          operationId,
          eventType: "operation.started",
          source: "verified",
          metadata: JSON.stringify({
            machineId,
            kind: operation.action.kind,
          }),
        })
        .execute();
    });
  }

  async addOperationEvent(input: {
    machineId: string;
    operationId: string;
    sequence: number;
    stream: string;
    dataBase64: string;
  }): Promise<boolean> {
    return await this.db.transaction().execute(async (transaction) => {
      const operation = await transaction
        .selectFrom("operations")
        .innerJoin("sessions", "sessions.id", "operations.sessionId")
        .select("operations.workspaceId")
        .where("operations.id", "=", input.operationId)
        .where("sessions.machineId", "=", input.machineId)
        .executeTakeFirst();
      if (!operation) return false;
      await transaction
        .insertInto("operationEvents")
        .values({
          workspaceId: operation.workspaceId,
          operationId: input.operationId,
          sequence: input.sequence,
          stream: input.stream,
          data: Buffer.from(input.dataBase64, "base64"),
        })
        .onConflict((conflict) =>
          conflict.columns(["operationId", "sequence"]).doNothing(),
        )
        .execute();
      return true;
    });
  }

  async markOperationCompleted(input: {
    machineId: string;
    operationId: string;
    status: string;
    exitCode: number | null;
    error?: string;
    outputTruncated: boolean;
  }): Promise<{
    principalId: string;
    workspaceId: string;
    kind: Capability;
  } | null> {
    return await this.db.transaction().execute(async (transaction) => {
      const operation = await transaction
        .updateTable("operations")
        .set({
          status: input.status,
          exitCode: input.exitCode,
          error: input.error ?? null,
          outputTruncated: input.outputTruncated,
          updatedAt: new Date(),
        })
        .where("id", "=", input.operationId)
        .where("status", "in", ACTIVE_OPERATION_STATUSES)
        .where(({ exists, selectFrom }) =>
          exists(
            selectFrom("sessions")
              .select("sessions.id")
              .whereRef("sessions.id", "=", "operations.sessionId")
              .where("sessions.machineId", "=", input.machineId),
          ),
        )
        .returning(["principalId", "workspaceId", "action"])
        .executeTakeFirst();
      if (!operation) return null;
      const session = await transaction
        .selectFrom("operations")
        .select("sessionId")
        .where("workspaceId", "=", operation.workspaceId)
        .where("id", "=", input.operationId)
        .executeTakeFirstOrThrow();
      const request = await transaction
        .selectFrom("agentSessionTargets")
        .innerJoin("agentSessionRequests", (join) =>
          join
            .onRef(
              "agentSessionRequests.workspaceId",
              "=",
              "agentSessionTargets.workspaceId",
            )
            .onRef(
              "agentSessionRequests.sessionId",
              "=",
              "agentSessionTargets.sessionId",
            ),
        )
        .select([
          "agentSessionRequests.id",
          "agentSessionTargets.sessionId as canonicalSessionId",
        ])
        .where("agentSessionTargets.workspaceId", "=", operation.workspaceId)
        .where("agentSessionTargets.runtimeSessionId", "=", session.sessionId)
        .executeTakeFirst();
      if (request) {
        await transaction
          .insertInto("sessionTimelineEvents")
          .values({
            workspaceId: operation.workspaceId,
            id: randomUUID(),
            sessionId: request.canonicalSessionId,
            requestId: request.id,
            operationId: input.operationId,
            eventType: "operation.completed",
            source: "verified",
            metadata: JSON.stringify({
              machineId: input.machineId,
              kind: operation.action.kind,
              status: input.status,
              exitCode: input.exitCode,
              outputTruncated: input.outputTruncated,
            }),
          })
          .execute();
      }
      return {
        principalId: operation.principalId,
        workspaceId: operation.workspaceId,
        kind: operation.action.kind,
      };
    });
  }

  async getOperation(
    workspaceId: string,
    operationId: string,
    principalId: string,
    sessionId?: string,
  ): Promise<(OperationRecord & { events: OperationEventRecord[] }) | null> {
    let query = this.db
      .selectFrom("operations")
      .selectAll()
      .where("workspaceId", "=", workspaceId)
      .where("id", "=", operationId)
      .where("principalId", "=", principalId);
    if (sessionId !== undefined) {
      query = query.where(({ exists, selectFrom }) =>
        exists(
          selectFrom("agentSessionTargets")
            .select("agentSessionTargets.machineId")
            .whereRef(
              "agentSessionTargets.runtimeSessionId",
              "=",
              "operations.sessionId",
            )
            .where("agentSessionTargets.sessionId", "=", sessionId),
        ),
      );
    }
    const operation = await query.executeTakeFirst();
    if (!operation) return null;
    const events = await this.listOperationEvents(workspaceId, operationId, -1);
    return { ...operationRecord(operation), events };
  }

  async getOperationTarget(
    workspaceId: string,
    operationId: string,
    principalId: string,
    sessionId?: string,
  ): Promise<{ machineId: string; sessionId: string; status: string } | null> {
    let query = this.db
        .selectFrom("operations")
        .innerJoin("sessions", "sessions.id", "operations.sessionId")
        .select(["sessions.machineId", "operations.sessionId", "operations.status"])
        .where("operations.workspaceId", "=", workspaceId)
        .where("operations.id", "=", operationId)
        .where("operations.principalId", "=", principalId);
    if (sessionId !== undefined) {
      query = query.where(({ exists, selectFrom }) =>
        exists(
          selectFrom("agentSessionTargets")
            .select("agentSessionTargets.machineId")
            .whereRef(
              "agentSessionTargets.runtimeSessionId",
              "=",
              "operations.sessionId",
            )
            .where("agentSessionTargets.sessionId", "=", sessionId),
        ),
      );
    }
    return (await query.executeTakeFirst()) ?? null;
  }

  async operationExists(
    workspaceId: string,
    operationId: string,
    principalId: string,
    sessionId?: string,
  ): Promise<boolean> {
    let query = this.db
        .selectFrom("operations")
        .select("id")
        .where("workspaceId", "=", workspaceId)
        .where("id", "=", operationId)
        .where("principalId", "=", principalId);
    if (sessionId !== undefined) {
      query = query.where(({ exists, selectFrom }) =>
        exists(
          selectFrom("agentSessionTargets")
            .select("agentSessionTargets.machineId")
            .whereRef(
              "agentSessionTargets.runtimeSessionId",
              "=",
              "operations.sessionId",
            )
            .where("agentSessionTargets.sessionId", "=", sessionId),
        ),
      );
    }
    return Boolean(await query.executeTakeFirst());
  }

  async listOperationEvents(
    workspaceId: string,
    operationId: string,
    afterSequence: number,
  ): Promise<OperationEventRecord[]> {
    return (
      await this.db
        .selectFrom("operationEvents")
        .selectAll()
        .where("workspaceId", "=", workspaceId)
        .where("operationId", "=", operationId)
        .where("sequence", ">", afterSequence)
        .orderBy("sequence", "asc")
        .execute()
    ).map(operationEventRecord);
  }

  async operationStatus(workspaceId: string, operationId: string): Promise<string | null> {
    return (
      (
        await this.db
          .selectFrom("operations")
          .select("status")
          .where("workspaceId", "=", workspaceId)
          .where("id", "=", operationId)
          .executeTakeFirst()
      )?.status ?? null
    );
  }

  async listAudit(
    workspaceId: string,
    limit: number,
    principalId?: string,
  ): Promise<AuditRecord[]> {
    let query = this.db
      .selectFrom("auditEvents")
      .selectAll()
      .where("workspaceId", "=", workspaceId);
    if (principalId !== undefined) query = query.where("principalId", "=", principalId);
    return (await query.orderBy("createdAt", "desc").limit(limit).execute()).map(
      auditRecord,
    );
  }

  async audit(
    workspaceId: string,
    principalId: string,
    action: string,
    targetType: string,
    targetId: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await this.db
      .insertInto("auditEvents")
      .values({
        workspaceId,
        id: randomUUID(),
        principalId,
        action,
        targetType,
        targetId,
        metadata: JSON.stringify(metadata),
      })
      .execute();
  }

  async purgeExpiredData(input: {
    operationDataBefore: number;
    auditBefore: number;
  }): Promise<{
    agentTokens: number;
    enrollmentTokens: number;
    operations: number;
    sessions: number;
    auditEvents: number;
  }> {
    return await this.db.transaction().execute(async (transaction) => {
      const operationDataBefore = new Date(input.operationDataBefore);
      const auditBefore = new Date(input.auditBefore);
      await transaction
        .deleteFrom("deviceAuthorizations")
        .where("expiresAt", "<", operationDataBefore)
        .execute();
      const deletedEnrollmentTokens = await transaction
        .deleteFrom("enrollmentTokens")
        .where("expiresAt", "<", operationDataBefore)
        .returning("tokenHash")
        .execute();
      const deletedOperations = await transaction
        .deleteFrom("operations")
        .where("status", "not in", ACTIVE_OPERATION_STATUSES)
        .where("updatedAt", "<", operationDataBefore)
        .returning("id")
        .execute();
      const deletedSessions = await transaction
        .deleteFrom("sessions")
        .where("status", "not in", RETAINED_SESSION_STATUSES)
        .where("updatedAt", "<", operationDataBefore)
        .where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom("operations")
                .select("operations.id")
                .whereRef("operations.sessionId", "=", "sessions.id"),
            ),
          ),
        )
        .returning("id")
        .execute();
      const deletedAuditEvents = await transaction
        .deleteFrom("auditEvents")
        .where("createdAt", "<", auditBefore)
        .returning("id")
        .execute();
      const deletedAgentTokens = await transaction
        .deleteFrom("agentTokens")
        .where((expression) =>
          expression.or([
            expression("expiresAt", "<", auditBefore),
            expression("revokedAt", "<", auditBefore),
          ]),
        )
        .where(({ not, exists, selectFrom, or }) =>
          not(
            or([
              exists(
                selectFrom("sessions")
                  .select("sessions.id")
                  .whereRef(
                    "sessions.workspaceId",
                    "=",
                    "agentTokens.workspaceId",
                  )
                  .whereRef(
                    "sessions.principalId",
                    "=",
                    "agentTokens.id",
                  ),
              ),
              exists(
                selectFrom("auditEvents")
                  .select("auditEvents.id")
                  .whereRef(
                    "auditEvents.workspaceId",
                    "=",
                    "agentTokens.workspaceId",
                  )
                  .where((audit) =>
                    audit.or([
                      audit
                        .eb(
                          "auditEvents.principalId",
                          "=",
                          audit.ref("agentTokens.id"),
                        ),
                      audit.and([
                        audit(
                          "auditEvents.targetType",
                          "=",
                          "agent_token",
                        ),
                        audit
                          .eb(
                            "auditEvents.targetId",
                            "=",
                            audit.ref("agentTokens.id"),
                          ),
                      ]),
                    ]),
                  ),
              ),
            ]),
          ),
        )
        .returning("id")
        .execute();
      return {
        agentTokens: deletedAgentTokens.length,
        enrollmentTokens: deletedEnrollmentTokens.length,
        operations: deletedOperations.length,
        sessions: deletedSessions.length,
        auditEvents: deletedAuditEvents.length,
      };
    });
  }

  async expireSessions(): Promise<Array<{ id: string; machineId: string }>> {
    const now = new Date();
    return await this.db.transaction().execute(async (transaction) => {
      const canonical = await transaction
        .updateTable("agentSessions")
        .set({ status: "expired", updatedAt: now })
        .where("status", "=", "active")
        .where("expiresAt", "<=", now)
        .returning(["workspaceId", "id"])
        .execute();
      for (const session of canonical) {
        await transaction
          .updateTable("sessionCredentials")
          .set({ status: "expired", revokedAt: now })
          .where("workspaceId", "=", session.workspaceId)
          .where("sessionId", "=", session.id)
          .where("status", "=", "active")
          .execute();
        const targets = await transaction
          .updateTable("agentSessionTargets")
          .set({ status: "closed", updatedAt: now })
          .where("workspaceId", "=", session.workspaceId)
          .where("sessionId", "=", session.id)
          .returning("runtimeSessionId")
          .execute();
        const runtimeIds = targets.map((target) => target.runtimeSessionId);
        if (runtimeIds.length > 0) {
          await transaction
            .updateTable("operations")
            .set({ status: "timed_out", error: "session_expired", updatedAt: now })
            .where("workspaceId", "=", session.workspaceId)
            .where("sessionId", "in", runtimeIds)
            .where("status", "in", ACTIVE_OPERATION_STATUSES)
            .execute();
        }
        const request = await transaction
          .selectFrom("agentSessionRequests")
          .select("id")
          .where("workspaceId", "=", session.workspaceId)
          .where("sessionId", "=", session.id)
          .executeTakeFirst();
        if (request) {
          await transaction
            .insertInto("sessionTimelineEvents")
            .values({
              workspaceId: session.workspaceId,
              id: randomUUID(),
              sessionId: session.id,
              requestId: request.id,
              operationId: null,
              eventType: "session.expired",
              source: "verified",
              metadata: JSON.stringify({}),
              createdAt: now,
            })
            .execute();
        }
      }
      return await transaction
        .updateTable("sessions")
        .set({ status: "expired", updatedAt: now })
        .where("status", "in", ACTIVE_SESSION_STATUSES)
        .where((expression) =>
          expression.or([
            expression("sessions.expiresAt", "<=", now),
            expression.exists(
              expression
                .selectFrom("agentTokens")
                .select("agentTokens.id")
                .whereRef("agentTokens.id", "=", "sessions.principalId")
                .whereRef("agentTokens.workspaceId", "=", "sessions.workspaceId")
                .where((token) =>
                  token.or([
                    token("agentTokens.expiresAt", "<=", now),
                    token("agentTokens.revokedAt", "is not", null),
                  ]),
                ),
            ),
            expression.exists(
              expression
                .selectFrom("cliTokens")
                .select("cliTokens.id")
                .whereRef("cliTokens.id", "=", "sessions.principalId")
                .whereRef("cliTokens.workspaceId", "=", "sessions.workspaceId")
                .where((token) =>
                  token.or([
                    token("cliTokens.expiresAt", "<=", now),
                    token("cliTokens.revokedAt", "is not", null),
                  ]),
                ),
            ),
          ]),
        )
        .returning(["id", "machineId"])
        .execute();
    });
  }
}

export type Database = PostgresDatabase;

export function createDatabase(environment: NodeJS.ProcessEnv): Database {
  const connectionString = environment.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  return new PostgresDatabase(connectionString);
}

export async function audit(
  db: Database,
  workspaceId: string,
  principalId: string,
  action: string,
  targetType: string,
  targetId: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await db.audit(workspaceId, principalId, action, targetType, targetId, metadata);
}
