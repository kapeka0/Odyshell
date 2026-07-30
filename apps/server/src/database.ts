import { randomUUID } from "node:crypto";
import type { Capability, OperationAction } from "@odyshell/protocol";
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

const { Pool } = pg;
export const DEFAULT_ORGANIZATION_ID = "default";
export const DEFAULT_WORKSPACE_ID = "default";
const DATABASE_SCHEMA = "odyshell";
const ACTIVE_SESSION_STATUSES = ["opening", "ready"] as const;
const CLOSABLE_SESSION_STATUSES = ["opening", "ready", "closing"] as const;
const ACTIVE_OPERATION_STATUSES = ["queued", "delivered", "running"] as const;
const RETAINED_SESSION_STATUSES = ["opening", "ready", "closing"] as const;

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

interface SessionTable {
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
  sessions: SessionTable;
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
    createdAt: timestamp(token.createdAt),
  };
}

function sessionRecord(
  session: Selectable<SessionTable>,
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
      .selectFrom("agentTokens")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("workspaceId", "=", workspaceId)
      .where("revokedAt", "is", null)
      .where("expiresAt", ">", new Date())
      .executeTakeFirstOrThrow();
    return {
      plan: workspace.plan as CloudPlanId,
      activeMachines: Number(count.count),
      activeAgents: Number(agents.count),
      cloudManaged: workspace.externalId !== null,
    };
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
    const organization = await this.db
      .selectFrom("organizations")
      .select("id")
      .where("id", "=", input.organizationId)
      .executeTakeFirst();
    if (!organization) return null;
    return workspaceRecord(
      await this.db
        .insertInto("workspaces")
        .values(input)
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  async findAgentByTokenHash(tokenHash: string): Promise<AgentTokenRecord | null> {
    const token = await this.db
      .selectFrom("agentTokens")
      .selectAll()
      .where("tokenHash", "=", tokenHash)
      .where("revokedAt", "is", null)
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
  }): Promise<void> {
    await this.db
      .insertInto("sessions")
      .values({
        ...input,
        capabilities: JSON.stringify(input.capabilities),
        status: "opening",
        expiresAt: new Date(input.expiresAt),
        error: null,
      })
      .execute();
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
    return (
      (await this.db
        .updateTable("sessions")
        .set({ status: "ready", updatedAt: new Date(), error: null })
        .where("id", "=", sessionId)
        .where("machineId", "=", machineId)
        .where("status", "=", "opening")
        .returning(["principalId", "workspaceId"])
        .executeTakeFirst()) ?? null
    );
  }

  async markSessionOpenFailed(
    machineId: string,
    sessionId: string,
    error: string,
  ): Promise<{ principalId: string; workspaceId: string } | null> {
    return (
      (await this.db
        .updateTable("sessions")
        .set({ status: "failed", updatedAt: new Date(), error })
        .where("id", "=", sessionId)
        .where("machineId", "=", machineId)
        .where("status", "=", "opening")
        .returning(["principalId", "workspaceId"])
        .executeTakeFirst()) ?? null
    );
  }

  async markSessionClosed(
    machineId: string,
    sessionId: string,
  ): Promise<{ principalId: string; workspaceId: string; status: string } | null> {
    return await this.db.transaction().execute(async (transaction) => {
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
      return {
        principalId: session.principalId,
        workspaceId: session.workspaceId,
        status,
      };
    });
  }

  async findOperationByIdempotency(
    workspaceId: string,
    principalId: string,
    idempotencyKey: string,
  ): Promise<Pick<OperationRecord, "id" | "status"> | null> {
    return (
      (await this.db
        .selectFrom("operations")
        .select(["id", "status"])
        .where("workspaceId", "=", workspaceId)
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
    idempotencyKey?: string;
  }): Promise<boolean> {
    const result = await this.db
      .insertInto("operations")
      .values({
        ...input,
        action: JSON.stringify(input.action),
        status: "queued",
        exitCode: null,
        error: null,
        outputTruncated: false,
        idempotencyKey: input.idempotencyKey ?? null,
      })
      .onConflict((conflict) =>
        conflict
          .columns(["principalId", "idempotencyKey"])
          .doNothing(),
      )
      .returning("id")
      .executeTakeFirst();
    return result !== undefined;
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
    await this.db
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
      .execute();
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
    const operation = await this.db
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
    return operation
      ? {
          principalId: operation.principalId,
          workspaceId: operation.workspaceId,
          kind: operation.action.kind,
        }
      : null;
  }

  async getOperation(
    workspaceId: string,
    operationId: string,
    principalId: string,
  ): Promise<(OperationRecord & { events: OperationEventRecord[] }) | null> {
    const operation = await this.db
      .selectFrom("operations")
      .selectAll()
      .where("workspaceId", "=", workspaceId)
      .where("id", "=", operationId)
      .where("principalId", "=", principalId)
      .executeTakeFirst();
    if (!operation) return null;
    const events = await this.listOperationEvents(workspaceId, operationId, -1);
    return { ...operationRecord(operation), events };
  }

  async getOperationTarget(
    workspaceId: string,
    operationId: string,
    principalId: string,
  ): Promise<{ machineId: string; status: string } | null> {
    return (
      (await this.db
        .selectFrom("operations")
        .innerJoin("sessions", "sessions.id", "operations.sessionId")
        .select(["sessions.machineId", "operations.status"])
        .where("operations.workspaceId", "=", workspaceId)
        .where("operations.id", "=", operationId)
        .where("operations.principalId", "=", principalId)
        .executeTakeFirst()) ?? null
    );
  }

  async operationExists(
    workspaceId: string,
    operationId: string,
    principalId: string,
  ): Promise<boolean> {
    return Boolean(
      await this.db
        .selectFrom("operations")
        .select("id")
        .where("workspaceId", "=", workspaceId)
        .where("id", "=", operationId)
        .where("principalId", "=", principalId)
        .executeTakeFirst(),
    );
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
    return await this.db
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
