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

const { Pool } = pg;
const DEFAULT_WORKSPACE_ID = "default";
const DATABASE_SCHEMA = "odyshell";
const ACTIVE_SESSION_STATUSES = ["opening", "ready"] as const;
const CLOSABLE_SESSION_STATUSES = ["opening", "ready", "closing"] as const;
const ACTIVE_OPERATION_STATUSES = ["queued", "delivered", "running"] as const;
const RETAINED_SESSION_STATUSES = ["opening", "ready", "closing"] as const;

type Json<T> = ColumnType<T, string, string>;

interface WorkspaceTable {
  id: string;
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
  workspaces: WorkspaceTable;
  machines: MachineTable;
  enrollmentTokens: EnrollmentTokenTable;
  agentTokens: AgentTokenTable;
  sessions: SessionTable;
  operations: OperationTable;
  operationEvents: OperationEventTable;
  auditEvents: AuditEventTable;
}

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

function timestamp(value: Date): number;
function timestamp(value: Date | null): number | undefined;
function timestamp(value: Date | null): number | undefined {
  return value?.getTime();
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

const migrationProvider: MigrationProvider = {
  async getMigrations(): Promise<Record<string, Migration>> {
    return {
      "001_initial_schema": {
        up: migrateInitialSchema,
      },
      "002_privacy_defaults": {
        up: redactHistoricalAuditMetadata,
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
      .insertInto("workspaces")
      .values({
        id: DEFAULT_WORKSPACE_ID,
        slug: "default",
        name: "Default workspace",
      })
      .onConflict((conflict) => conflict.column("id").doNothing())
      .execute();
    await this.db
      .updateTable("machines")
      .set({ status: "offline" })
      .where("workspaceId", "=", DEFAULT_WORKSPACE_ID)
      .where("status", "!=", "offline")
      .execute();
  }

  async close(): Promise<void> {
    await this.root.destroy();
  }

  async health(): Promise<void> {
    await sql`select 1`.execute(this.db);
  }

  async findAgentByTokenHash(tokenHash: string): Promise<AgentTokenRecord | null> {
    const token = await this.db
      .selectFrom("agentTokens")
      .selectAll()
      .where("workspaceId", "=", DEFAULT_WORKSPACE_ID)
      .where("tokenHash", "=", tokenHash)
      .where("revokedAt", "is", null)
      .where("expiresAt", ">", new Date())
      .executeTakeFirst();
    return token ? agentTokenRecord(token) : null;
  }

  async createEnrollmentToken(tokenHash: string, expiresAt: number): Promise<void> {
    await this.db
      .insertInto("enrollmentTokens")
      .values({
        workspaceId: DEFAULT_WORKSPACE_ID,
        tokenHash,
        expiresAt: new Date(expiresAt),
        usedAt: null,
      })
      .execute();
  }

  async listAgentTokens(): Promise<AgentTokenRecord[]> {
    const tokens = await this.db
      .selectFrom("agentTokens")
      .selectAll()
      .where("workspaceId", "=", DEFAULT_WORKSPACE_ID)
      .orderBy("createdAt", "desc")
      .limit(200)
      .execute();
    return tokens.map(agentTokenRecord);
  }

  async listMachines(options: {
    includeRevoked?: boolean;
    machineIds?: string[];
  } = {}): Promise<MachineRecord[]> {
    let query = this.db
      .selectFrom("machines")
      .selectAll()
      .where("workspaceId", "=", DEFAULT_WORKSPACE_ID);
    if (!options.includeRevoked) query = query.where("revokedAt", "is", null);
    if (options.machineIds) {
      if (options.machineIds.length === 0) return [];
      query = query.where("id", "in", options.machineIds);
    }
    return (await query.orderBy("enrolledAt", "asc").execute()).map(machineRecord);
  }

  async activeMachinesExist(machineIds: string[]): Promise<boolean> {
    if (machineIds.length === 0) return true;
    const result = await this.db
      .selectFrom("machines")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("workspaceId", "=", DEFAULT_WORKSPACE_ID)
      .where("id", "in", machineIds)
      .where("revokedAt", "is", null)
      .executeTakeFirstOrThrow();
    return Number(result.count) === new Set(machineIds).size;
  }

  async createAgentToken(input: {
    id: string;
    name: string;
    tokenHash: string;
    machineIds: string[];
    capabilities: Capability[];
    expiresAt: number;
  }): Promise<void> {
    await this.db
      .insertInto("agentTokens")
      .values({
        workspaceId: DEFAULT_WORKSPACE_ID,
        ...input,
        machineIds: JSON.stringify(input.machineIds),
        capabilities: JSON.stringify(input.capabilities),
        expiresAt: new Date(input.expiresAt),
        revokedAt: null,
      })
      .execute();
  }

  async revokeAgentToken(tokenId: string): Promise<AgentTokenRecord | null> {
    const now = new Date();
    const token = await this.db
      .updateTable("agentTokens")
      .set({ revokedAt: sql`coalesce(revoked_at, ${now})` })
      .where("workspaceId", "=", DEFAULT_WORKSPACE_ID)
      .where("id", "=", tokenId)
      .returningAll()
      .executeTakeFirst();
    return token ? agentTokenRecord(token) : null;
  }

  async expireAgentSessions(
    principalId: string,
  ): Promise<Array<{ id: string; machineId: string }>> {
    return await this.db
      .updateTable("sessions")
      .set({ status: "expired", updatedAt: new Date() })
      .where("workspaceId", "=", DEFAULT_WORKSPACE_ID)
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
  }): Promise<{ machineId: string; name: string } | null> {
    return await this.db.transaction().execute(async (transaction) => {
      const enrollment = await transaction
        .selectFrom("enrollmentTokens")
        .selectAll()
        .where("workspaceId", "=", DEFAULT_WORKSPACE_ID)
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
      await transaction
        .updateTable("enrollmentTokens")
        .set({ usedAt: now })
        .where("tokenHash", "=", input.tokenHash)
        .execute();
      await transaction
        .insertInto("machines")
        .values({
          workspaceId: DEFAULT_WORKSPACE_ID,
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
      return { machineId: input.machineId, name: input.name };
    });
  }

  async machinePublicKey(machineId: string): Promise<string | null> {
    const machine = await this.db
      .selectFrom("machines")
      .select("publicKey")
      .where("workspaceId", "=", DEFAULT_WORKSPACE_ID)
      .where("id", "=", machineId)
      .where("revokedAt", "is", null)
      .executeTakeFirst();
    return machine?.publicKey ?? null;
  }

  async setMachineOffline(machineId: string): Promise<void> {
    await this.db
      .updateTable("machines")
      .set({ status: "offline" })
      .where("workspaceId", "=", DEFAULT_WORKSPACE_ID)
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
      .where("workspaceId", "=", DEFAULT_WORKSPACE_ID)
      .where("id", "=", machineId)
      .where("revokedAt", "is", null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  async heartbeat(machineId: string): Promise<void> {
    await this.db
      .updateTable("machines")
      .set({ status: "online", lastSeenAt: new Date() })
      .where("workspaceId", "=", DEFAULT_WORKSPACE_ID)
      .where("id", "=", machineId)
      .where("revokedAt", "is", null)
      .execute();
  }

  async revokeMachine(machineId: string): Promise<{
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
        .where("workspaceId", "=", DEFAULT_WORKSPACE_ID)
        .where("id", "=", machineId)
        .where("revokedAt", "is", null)
        .returning(["id", "name"])
        .executeTakeFirst();
      if (!machine) return null;

      const sessions = await transaction
        .updateTable("sessions")
        .set({ status: "closed", error: "machine_revoked", updatedAt: now })
        .where("workspaceId", "=", DEFAULT_WORKSPACE_ID)
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
              .where("workspaceId", "=", DEFAULT_WORKSPACE_ID)
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

  async listSessions(principalId: string): Promise<SessionRecord[]> {
    const sessions = await this.db
      .selectFrom("sessions")
      .leftJoin("machines", "machines.id", "sessions.machineId")
      .selectAll("sessions")
      .select("machines.name as machineName")
      .where("sessions.workspaceId", "=", DEFAULT_WORKSPACE_ID)
      .where("sessions.principalId", "=", principalId)
      .orderBy("sessions.createdAt", "desc")
      .limit(100)
      .execute();
    return sessions.map((session) =>
      sessionRecord(session, session.machineName ?? "Unknown machine"),
    );
  }

  async createSession(input: {
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
        workspaceId: DEFAULT_WORKSPACE_ID,
        ...input,
        capabilities: JSON.stringify(input.capabilities),
        status: "opening",
        expiresAt: new Date(input.expiresAt),
        error: null,
      })
      .execute();
  }

  async getSession(sessionId: string, principalId: string): Promise<SessionRecord | null> {
    const session = await this.db
      .selectFrom("sessions")
      .selectAll()
      .where("workspaceId", "=", DEFAULT_WORKSPACE_ID)
      .where("id", "=", sessionId)
      .where("principalId", "=", principalId)
      .executeTakeFirst();
    return session ? sessionRecord(session) : null;
  }

  async getActiveSession(
    sessionId: string,
    principalId: string,
  ): Promise<SessionRecord | null> {
    const session = await this.db
      .selectFrom("sessions")
      .selectAll()
      .where("workspaceId", "=", DEFAULT_WORKSPACE_ID)
      .where("id", "=", sessionId)
      .where("principalId", "=", principalId)
      .where("status", "in", ACTIVE_SESSION_STATUSES)
      .executeTakeFirst();
    return session ? sessionRecord(session) : null;
  }

  async markSessionClosing(sessionId: string): Promise<void> {
    await this.db
      .updateTable("sessions")
      .set({ status: "closing", updatedAt: new Date() })
      .where("workspaceId", "=", DEFAULT_WORKSPACE_ID)
      .where("id", "=", sessionId)
      .execute();
  }

  async markSessionOpened(sessionId: string): Promise<{ principalId: string } | null> {
    return (
      (await this.db
        .updateTable("sessions")
        .set({ status: "ready", updatedAt: new Date(), error: null })
        .where("workspaceId", "=", DEFAULT_WORKSPACE_ID)
        .where("id", "=", sessionId)
        .where("status", "=", "opening")
        .returning("principalId")
        .executeTakeFirst()) ?? null
    );
  }

  async markSessionOpenFailed(
    sessionId: string,
    error: string,
  ): Promise<{ principalId: string } | null> {
    return (
      (await this.db
        .updateTable("sessions")
        .set({ status: "failed", updatedAt: new Date(), error })
        .where("workspaceId", "=", DEFAULT_WORKSPACE_ID)
        .where("id", "=", sessionId)
        .where("status", "=", "opening")
        .returning("principalId")
        .executeTakeFirst()) ?? null
    );
  }

  async markSessionClosed(
    sessionId: string,
  ): Promise<{ principalId: string; status: string } | null> {
    return await this.db.transaction().execute(async (transaction) => {
      const session = await transaction
        .selectFrom("sessions")
        .select(["principalId", "expiresAt"])
        .where("workspaceId", "=", DEFAULT_WORKSPACE_ID)
        .where("id", "=", sessionId)
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
      return { principalId: session.principalId, status };
    });
  }

  async findOperationByIdempotency(
    principalId: string,
    idempotencyKey: string,
  ): Promise<Pick<OperationRecord, "id" | "status"> | null> {
    return (
      (await this.db
        .selectFrom("operations")
        .select(["id", "status"])
        .where("workspaceId", "=", DEFAULT_WORKSPACE_ID)
        .where("principalId", "=", principalId)
        .where("idempotencyKey", "=", idempotencyKey)
        .executeTakeFirst()) ?? null
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
  }): Promise<boolean> {
    const result = await this.db
      .insertInto("operations")
      .values({
        workspaceId: DEFAULT_WORKSPACE_ID,
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

  async markOperationDelivered(operationId: string): Promise<void> {
    await this.db
      .updateTable("operations")
      .set({ status: "delivered", updatedAt: new Date() })
      .where("workspaceId", "=", DEFAULT_WORKSPACE_ID)
      .where("id", "=", operationId)
      .where("status", "=", "queued")
      .execute();
  }

  async markOperationStarted(operationId: string): Promise<void> {
    await this.db
      .updateTable("operations")
      .set({ status: "running", updatedAt: new Date() })
      .where("workspaceId", "=", DEFAULT_WORKSPACE_ID)
      .where("id", "=", operationId)
      .where("status", "in", ["queued", "delivered"])
      .execute();
  }

  async addOperationEvent(input: {
    operationId: string;
    sequence: number;
    stream: string;
    dataBase64: string;
  }): Promise<void> {
    await this.db
      .insertInto("operationEvents")
      .values({
        workspaceId: DEFAULT_WORKSPACE_ID,
        operationId: input.operationId,
        sequence: input.sequence,
        stream: input.stream,
        data: Buffer.from(input.dataBase64, "base64"),
      })
      .onConflict((conflict) =>
        conflict.columns(["operationId", "sequence"]).doNothing(),
      )
      .execute();
  }

  async markOperationCompleted(input: {
    operationId: string;
    status: string;
    exitCode: number | null;
    error?: string;
    outputTruncated: boolean;
  }): Promise<{ principalId: string } | null> {
    return (
      (await this.db
        .updateTable("operations")
        .set({
          status: input.status,
          exitCode: input.exitCode,
          error: input.error ?? null,
          outputTruncated: input.outputTruncated,
          updatedAt: new Date(),
        })
        .where("workspaceId", "=", DEFAULT_WORKSPACE_ID)
        .where("id", "=", input.operationId)
        .where("status", "in", ACTIVE_OPERATION_STATUSES)
        .returning("principalId")
        .executeTakeFirst()) ?? null
    );
  }

  async getOperation(
    operationId: string,
    principalId: string,
  ): Promise<(OperationRecord & { events: OperationEventRecord[] }) | null> {
    const operation = await this.db
      .selectFrom("operations")
      .selectAll()
      .where("workspaceId", "=", DEFAULT_WORKSPACE_ID)
      .where("id", "=", operationId)
      .where("principalId", "=", principalId)
      .executeTakeFirst();
    if (!operation) return null;
    const events = await this.listOperationEvents(operationId, -1);
    return { ...operationRecord(operation), events };
  }

  async getOperationTarget(
    operationId: string,
    principalId: string,
  ): Promise<{ machineId: string; status: string } | null> {
    return (
      (await this.db
        .selectFrom("operations")
        .innerJoin("sessions", "sessions.id", "operations.sessionId")
        .select(["sessions.machineId", "operations.status"])
        .where("operations.workspaceId", "=", DEFAULT_WORKSPACE_ID)
        .where("operations.id", "=", operationId)
        .where("operations.principalId", "=", principalId)
        .executeTakeFirst()) ?? null
    );
  }

  async operationExists(operationId: string, principalId: string): Promise<boolean> {
    return Boolean(
      await this.db
        .selectFrom("operations")
        .select("id")
        .where("workspaceId", "=", DEFAULT_WORKSPACE_ID)
        .where("id", "=", operationId)
        .where("principalId", "=", principalId)
        .executeTakeFirst(),
    );
  }

  async listOperationEvents(
    operationId: string,
    afterSequence: number,
  ): Promise<OperationEventRecord[]> {
    return (
      await this.db
        .selectFrom("operationEvents")
        .selectAll()
        .where("workspaceId", "=", DEFAULT_WORKSPACE_ID)
        .where("operationId", "=", operationId)
        .where("sequence", ">", afterSequence)
        .orderBy("sequence", "asc")
        .execute()
    ).map(operationEventRecord);
  }

  async operationStatus(operationId: string): Promise<string | null> {
    return (
      (
        await this.db
          .selectFrom("operations")
          .select("status")
          .where("workspaceId", "=", DEFAULT_WORKSPACE_ID)
          .where("id", "=", operationId)
          .executeTakeFirst()
      )?.status ?? null
    );
  }

  async listAudit(limit: number, principalId?: string): Promise<AuditRecord[]> {
    let query = this.db
      .selectFrom("auditEvents")
      .selectAll()
      .where("workspaceId", "=", DEFAULT_WORKSPACE_ID);
    if (principalId !== undefined) query = query.where("principalId", "=", principalId);
    return (await query.orderBy("createdAt", "desc").limit(limit).execute()).map(
      auditRecord,
    );
  }

  async audit(
    principalId: string,
    action: string,
    targetType: string,
    targetId: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await this.db
      .insertInto("auditEvents")
      .values({
        workspaceId: DEFAULT_WORKSPACE_ID,
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
    operations: number;
    sessions: number;
    auditEvents: number;
  }> {
    return await this.db.transaction().execute(async (transaction) => {
      const operationDataBefore = new Date(input.operationDataBefore);
      const auditBefore = new Date(input.auditBefore);
      const deletedOperations = await transaction
        .deleteFrom("operations")
        .where("workspaceId", "=", DEFAULT_WORKSPACE_ID)
        .where("status", "not in", ACTIVE_OPERATION_STATUSES)
        .where("updatedAt", "<", operationDataBefore)
        .returning("id")
        .execute();
      const deletedSessions = await transaction
        .deleteFrom("sessions")
        .where("workspaceId", "=", DEFAULT_WORKSPACE_ID)
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
        .where("workspaceId", "=", DEFAULT_WORKSPACE_ID)
        .where("createdAt", "<", auditBefore)
        .returning("id")
        .execute();
      return {
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
      .where("workspaceId", "=", DEFAULT_WORKSPACE_ID)
      .where("status", "in", ACTIVE_SESSION_STATUSES)
      .where((expression) =>
        expression.or([
          expression("sessions.expiresAt", "<=", now),
          expression.exists(
            expression
              .selectFrom("agentTokens")
              .select("agentTokens.id")
              .whereRef("agentTokens.id", "=", "sessions.principalId")
              .where((token) =>
                token.or([
                  token("agentTokens.expiresAt", "<=", now),
                  token("agentTokens.revokedAt", "is not", null),
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
  principalId: string,
  action: string,
  targetType: string,
  targetId: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await db.audit(principalId, action, targetType, targetId, metadata);
}
