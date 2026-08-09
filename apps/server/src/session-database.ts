import {
  DEFAULT_COMMAND_OUTPUT_BYTES,
  type Command,
  type LocalPolicy,
  type Session,
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
import { Migrator, type Migration, type MigrationProvider } from "kysely/migration";
import pg from "pg";
import type {
  MachineAuthority,
  SessionAudit,
  SessionRepository,
} from "./sessions.js";
import type { SessionReconnectState } from "./session-reconciliation.js";

const { Pool } = pg;
const DATABASE_SCHEMA = "odyshell";
const ACTIVE_SESSION_STATUSES = ["pending_approval", "opening", "active"] as const;
const ACTIVE_COMMAND_STATUSES = [
  "queued",
  "delivered",
  "running",
  "cancellation_requested",
] as const;
type Json<T> = ColumnType<T, string, string>;

interface MachineAuthorityTable {
  organizationId: string;
  machineId: string;
  clientProfileId: string;
  operatingSystemUser: string;
  online: boolean;
  localPolicy: Json<LocalPolicy>;
  updatedAt: Generated<Date>;
}

interface SessionTable {
  id: string;
  organizationId: string;
  agentId: string;
  machineId: string;
  clientProfileId: string;
  operatingSystemUser: string;
  title: string;
  purpose: string | null;
  status: string;
  maxConcurrentCommands: number;
  idempotencyKeyHash: string;
  requestFingerprint: string;
  createdAt: Date;
  readyAt: Date | null;
  expiresAt: Date;
  finishedAt: Date | null;
  updatedAt: Generated<Date>;
}

interface CommandTable {
  id: string;
  sessionId: string;
  organizationId: string;
  agentId: string;
  machineId: string;
  command: string;
  cwd: string | null;
  timeoutSeconds: number;
  status: string;
  idempotencyKeyHash: string;
  requestFingerprint: string;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  exitCode: number | null;
  outputTruncated: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  error: string | null;
  updatedAt: Generated<Date>;
}

interface SessionAuditEventTable {
  id: Generated<number>;
  organizationId: string;
  agentId: string;
  sessionId: string;
  commandId: string | null;
  type: string;
  metadata: Json<Record<string, unknown>>;
  createdAt: Generated<Date>;
}

interface CommandOutputChunkTable {
  organizationId: string;
  commandId: string;
  sequence: number;
  stream: string;
  data: Buffer;
  expiresAt: Date;
  createdAt: Generated<Date>;
}

interface SessionDatabaseSchema {
  machineAuthorities: MachineAuthorityTable;
  sessions: SessionTable;
  commands: CommandTable;
  sessionAuditEvents: SessionAuditEventTable;
  commandOutputChunks: CommandOutputChunkTable;
}

async function migrateSessionCommandCore(db: Kysely<SessionDatabaseSchema>): Promise<void> {
  const statements = [
    `create table odyshell.machine_authorities (
      organization_id text not null,
      machine_id uuid not null,
      client_profile_id text not null,
      operating_system_user text not null,
      online boolean not null default false,
      local_policy jsonb not null,
      updated_at timestamptz not null default current_timestamp,
      primary key (organization_id, machine_id)
    )`,
    `create table odyshell.sessions (
      id uuid primary key,
      organization_id text not null,
      agent_id text not null,
      machine_id uuid not null,
      client_profile_id text not null,
      operating_system_user text not null,
      title text not null,
      purpose text,
      status text not null,
      max_concurrent_commands integer not null,
      idempotency_key_hash text not null,
      request_fingerprint text not null,
      created_at timestamptz not null,
      ready_at timestamptz,
      expires_at timestamptz not null,
      finished_at timestamptz,
      updated_at timestamptz not null default current_timestamp,
      unique (organization_id, agent_id, idempotency_key_hash)
    )`,
    `create index sessions_machine_active_idx
      on odyshell.sessions (organization_id, machine_id, status)`,
    `create table odyshell.commands (
      id uuid primary key,
      session_id uuid not null references odyshell.sessions (id) on delete cascade,
      organization_id text not null,
      agent_id text not null,
      machine_id uuid not null,
      command text not null,
      cwd text,
      timeout_seconds integer not null,
      status text not null,
      idempotency_key_hash text not null,
      request_fingerprint text not null,
      created_at timestamptz not null,
      started_at timestamptz,
      finished_at timestamptz,
      exit_code integer,
      output_truncated boolean not null default false,
      stdout_bytes integer not null default 0,
      stderr_bytes integer not null default 0,
      error text,
      updated_at timestamptz not null default current_timestamp,
      unique (organization_id, session_id, idempotency_key_hash)
    )`,
    `create index commands_session_active_idx
      on odyshell.commands (organization_id, session_id, status)`,
    `create table odyshell.session_audit_events (
      id bigint generated always as identity primary key,
      organization_id text not null,
      agent_id text not null,
      session_id uuid not null references odyshell.sessions (id) on delete cascade,
      command_id uuid references odyshell.commands (id) on delete cascade,
      type text not null,
      metadata jsonb not null,
      created_at timestamptz not null default current_timestamp
    )`,
    `create index session_audit_timeline_idx
      on odyshell.session_audit_events (organization_id, session_id, id)`,
  ];
  for (const statement of statements) await sql.raw(statement).execute(db);
}

async function migrateTransientCommandOutput(
  db: Kysely<SessionDatabaseSchema>,
): Promise<void> {
  await sql.raw(`create table odyshell.command_output_chunks (
    organization_id text not null,
    command_id uuid not null references odyshell.commands (id) on delete cascade,
    sequence integer not null,
    stream text not null,
    data bytea not null,
    expires_at timestamptz not null,
    created_at timestamptz not null default current_timestamp,
    primary key (organization_id, command_id, sequence)
  )`).execute(db);
  await sql.raw(`create index command_output_expiry_idx
    on odyshell.command_output_chunks (expires_at)`).execute(db);
}

const sessionMigrationProvider: MigrationProvider = {
  async getMigrations(): Promise<Record<string, Migration>> {
    return {
      "001_session_command_core": { up: migrateSessionCommandCore },
      "002_transient_command_output": { up: migrateTransientCommandOutput },
    };
  },
};

export class PostgresSessionDatabase implements SessionRepository, SessionAudit {
  private readonly root: Kysely<SessionDatabaseSchema>;
  private readonly db: Kysely<SessionDatabaseSchema>;

  constructor(
    connectionString: string,
    private readonly commandOutputRetentionMilliseconds = 30 * 24 * 60 * 60_000,
  ) {
    this.root = new Kysely<SessionDatabaseSchema>({
      dialect: new PostgresDialect({
        pool: new Pool({ connectionString, max: 5, connectionTimeoutMillis: 10_000 }),
      }),
      plugins: [new CamelCasePlugin()],
    });
    this.db = this.root.withSchema(DATABASE_SCHEMA);
  }

  async initialize(): Promise<void> {
    await sql`create schema if not exists ${sql.id(DATABASE_SCHEMA)}`.execute(this.root);
    const migrator = new Migrator({
      db: this.root,
      provider: sessionMigrationProvider,
      migrationTableName: "session_migrations",
      migrationLockTableName: "session_migration_lock",
      migrationTableSchema: DATABASE_SCHEMA,
    });
    const { error, results } = await migrator.migrateToLatest();
    const failed = results?.find((result) => result.status === "Error");
    if (failed) throw new Error(`Session database migration ${failed.migrationName} failed`);
    if (error) throw error;
  }

  async close(): Promise<void> {
    await this.root.destroy();
  }

  async machineAuthority(
    organizationId: string,
    machineId: string,
  ): Promise<MachineAuthority | null> {
    const row = await this.db
      .selectFrom("machineAuthorities")
      .selectAll()
      .where("organizationId", "=", organizationId)
      .where("machineId", "=", machineId)
      .executeTakeFirst();
    return row ? machineAuthorityRecord(row) : null;
  }

  async listMachineAuthorities(
    organizationId: string,
  ): Promise<MachineAuthority[]> {
    const rows = await this.db
      .selectFrom("machineAuthorities")
      .selectAll()
      .where("organizationId", "=", organizationId)
      .orderBy("machineId")
      .execute();
    return rows.map(machineAuthorityRecord);
  }

  async putMachineAuthority(authority: MachineAuthority): Promise<void> {
    await this.db
      .insertInto("machineAuthorities")
      .values({ ...authority, localPolicy: JSON.stringify(authority.localPolicy) })
      .onConflict((conflict) => conflict.columns(["organizationId", "machineId"]).doUpdateSet({
        clientProfileId: authority.clientProfileId,
        operatingSystemUser: authority.operatingSystemUser,
        online: authority.online,
        localPolicy: JSON.stringify(authority.localPolicy),
        updatedAt: new Date(),
      }))
      .execute();
  }

  async setMachineOnline(
    organizationId: string,
    machineId: string,
    online: boolean,
  ): Promise<boolean> {
    const updated = await this.db
      .updateTable("machineAuthorities")
      .set({ online, updatedAt: new Date() })
      .where("organizationId", "=", organizationId)
      .where("machineId", "=", machineId)
      .returning("machineId")
      .executeTakeFirst();
    return updated !== undefined;
  }

  async reconnectState(
    organizationId: string,
    machineId: string,
  ): Promise<SessionReconnectState> {
    const sessions = await this.db
      .selectFrom("sessions")
      .selectAll()
      .where("organizationId", "=", organizationId)
      .where("machineId", "=", machineId)
      .where("status", "in", ["opening", "active", "cancellation_requested"])
      .orderBy("createdAt")
      .orderBy("id")
      .execute();
    if (sessions.length === 0) return { sessions: [], commands: [] };
    const commands = await this.db
      .selectFrom("commands")
      .selectAll()
      .where("organizationId", "=", organizationId)
      .where("machineId", "=", machineId)
      .where("sessionId", "in", sessions.map((session) => session.id))
      .where("status", "in", ACTIVE_COMMAND_STATUSES)
      .orderBy("createdAt")
      .orderBy("id")
      .execute();
    return {
      sessions: sessions.map(sessionRecord),
      commands: commands.map(commandRecord),
    };
  }

  async countActiveSessions(organizationId: string, machineId: string): Promise<number> {
    const result = await this.db
      .selectFrom("sessions")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("organizationId", "=", organizationId)
      .where("machineId", "=", machineId)
      .where("status", "in", ACTIVE_SESSION_STATUSES)
      .executeTakeFirstOrThrow();
    return Number(result.count);
  }

  async sessionByIdempotency(
    organizationId: string,
    agentId: string,
    idempotencyKeyHash: string,
  ): Promise<{ session: Session; requestFingerprint: string } | null> {
    const row = await this.db
      .selectFrom("sessions")
      .selectAll()
      .where("organizationId", "=", organizationId)
      .where("agentId", "=", agentId)
      .where("idempotencyKeyHash", "=", idempotencyKeyHash)
      .executeTakeFirst();
    return row ? { session: sessionRecord(row), requestFingerprint: row.requestFingerprint } : null;
  }

  async createSession(input: Parameters<SessionRepository["createSession"]>[0]) {
    try {
      const row = await this.db
        .insertInto("sessions")
        .values(sessionInsert(input))
        .returningAll()
        .executeTakeFirstOrThrow();
      return { status: "created" as const, session: sessionRecord(row) };
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
      const existing = await this.sessionByIdempotency(
        input.session.organizationId,
        input.session.agentId,
        input.idempotencyKeyHash,
      );
      if (!existing || existing.requestFingerprint !== input.requestFingerprint) {
        return { status: "idempotency_conflict" as const };
      }
      return { status: "replayed" as const, session: existing.session };
    }
  }

  async session(organizationId: string, sessionId: string): Promise<Session | null> {
    const row = await this.db
      .selectFrom("sessions")
      .selectAll()
      .where("organizationId", "=", organizationId)
      .where("id", "=", sessionId)
      .executeTakeFirst();
    return row ? sessionRecord(row) : null;
  }

  async listSessions(
    organizationId: string,
    limit = 100,
  ): Promise<Session[]> {
    const rows = await this.db
      .selectFrom("sessions")
      .selectAll()
      .where("organizationId", "=", organizationId)
      .orderBy("createdAt", "desc")
      .limit(Math.min(Math.max(limit, 1), 200))
      .execute();
    return rows.map(sessionRecord);
  }

  async sessionTimeline(organizationId: string, sessionId: string): Promise<{
    session: Session;
    commands: Array<Command & {
      output: Array<{ sequence: number; stream: "stdout" | "stderr"; dataBase64: string }>;
    }>;
    events: Array<{
      id: string;
      agentId: string;
      sessionId: string;
      commandId: string | null;
      type: string;
      metadata: Record<string, unknown>;
      createdAt: string;
    }>;
  } | null> {
    const session = await this.session(organizationId, sessionId);
    if (!session) return null;
    const [commandRows, eventRows] = await Promise.all([
      this.db
        .selectFrom("commands")
        .selectAll()
        .where("organizationId", "=", organizationId)
        .where("sessionId", "=", sessionId)
        .orderBy("createdAt")
        .execute(),
      this.db
        .selectFrom("sessionAuditEvents")
        .selectAll()
        .where("organizationId", "=", organizationId)
        .where("sessionId", "=", sessionId)
        .orderBy("createdAt")
        .execute(),
    ]);
    const commands = await Promise.all(commandRows.map(async (row) => {
      const command = commandRecord(row);
      return {
        ...command,
        output: await this.commandOutput(organizationId, command.id, -1),
      };
    }));
    return {
      session,
      commands,
      events: eventRows.map((row) => ({
        id: String(row.id),
        agentId: row.agentId,
        sessionId: row.sessionId,
        commandId: row.commandId,
        type: row.type,
        metadata: row.metadata,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  async decideSession(input: {
    organizationId: string;
    sessionId: string;
    decision: "approve" | "deny";
  }): Promise<
    | { status: "not_found" | "conflict" }
    | { status: "approved" | "denied"; session: Session; changed: boolean }
  > {
    return await this.db.transaction().execute(async (transaction) => {
      const current = await transaction
        .selectFrom("sessions")
        .selectAll()
        .where("organizationId", "=", input.organizationId)
        .where("id", "=", input.sessionId)
        .forUpdate()
        .executeTakeFirst();
      if (!current) return { status: "not_found" as const };
      if (
        input.decision === "approve" &&
        (current.status === "opening" || current.status === "active")
      ) {
        return { status: "approved" as const, session: sessionRecord(current), changed: false };
      }
      if (current.status !== "pending_approval") {
        return { status: "conflict" as const };
      }
      const now = new Date();
      if (current.expiresAt <= now) {
        await transaction
          .updateTable("sessions")
          .set({ status: "expired", finishedAt: now, updatedAt: now })
          .where("organizationId", "=", input.organizationId)
          .where("id", "=", input.sessionId)
          .where("status", "=", "pending_approval")
          .execute();
        return { status: "conflict" as const };
      }
      const row = await transaction
        .updateTable("sessions")
        .set(input.decision === "approve"
          ? {
              status: "opening",
              expiresAt: new Date(
                now.getTime() + current.expiresAt.getTime() - current.createdAt.getTime(),
              ),
              updatedAt: now,
            }
          : { status: "cancelled", finishedAt: now, updatedAt: now })
        .where("organizationId", "=", input.organizationId)
        .where("id", "=", input.sessionId)
        .where("status", "=", "pending_approval")
        .returningAll()
        .executeTakeFirst();
      if (!row) return { status: "conflict" as const };
      return {
        status: input.decision === "approve" ? "approved" as const : "denied" as const,
        session: sessionRecord(row),
        changed: true,
      };
    });
  }

  async command(organizationId: string, commandId: string): Promise<Command | null> {
    const row = await this.db
      .selectFrom("commands")
      .selectAll()
      .where("organizationId", "=", organizationId)
      .where("id", "=", commandId)
      .executeTakeFirst();
    return row ? commandRecord(row) : null;
  }

  async countActiveCommands(organizationId: string, sessionId: string): Promise<number> {
    const result = await this.db
      .selectFrom("commands")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("organizationId", "=", organizationId)
      .where("sessionId", "=", sessionId)
      .where("status", "in", ACTIVE_COMMAND_STATUSES)
      .executeTakeFirstOrThrow();
    return Number(result.count);
  }

  async commandByIdempotency(
    organizationId: string,
    sessionId: string,
    idempotencyKeyHash: string,
  ): Promise<{ command: Command; requestFingerprint: string } | null> {
    const row = await this.db
      .selectFrom("commands")
      .selectAll()
      .where("organizationId", "=", organizationId)
      .where("sessionId", "=", sessionId)
      .where("idempotencyKeyHash", "=", idempotencyKeyHash)
      .executeTakeFirst();
    return row
      ? { command: commandRecord(row), requestFingerprint: row.requestFingerprint }
      : null;
  }

  async createCommand(input: Parameters<SessionRepository["createCommand"]>[0]) {
    try {
      const row = await this.db
        .insertInto("commands")
        .values(commandInsert(input))
        .returningAll()
        .executeTakeFirstOrThrow();
      return { status: "created" as const, command: commandRecord(row) };
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
      const existing = await this.commandByIdempotency(
        input.command.organizationId,
        input.command.sessionId,
        input.idempotencyKeyHash,
      );
      if (!existing || existing.requestFingerprint !== input.requestFingerprint) {
        return { status: "idempotency_conflict" as const };
      }
      return { status: "replayed" as const, command: existing.command };
    }
  }

  async finishSession(input: {
    organizationId: string;
    agentId: string;
    sessionId: string;
    outcome: "complete" | "cancel";
  }): Promise<
    | { status: "not_found" }
    | { status: "commands_active" }
    | { status: "finished"; session: Session; commandIds: string[] }
  > {
    return await this.db.transaction().execute(async (transaction) => {
      const current = await transaction
        .selectFrom("sessions")
        .selectAll()
        .where("organizationId", "=", input.organizationId)
        .where("agentId", "=", input.agentId)
        .where("id", "=", input.sessionId)
        .forUpdate()
        .executeTakeFirst();
      if (!current) return { status: "not_found" as const };
      if (["completed", "cancelled", "revoked", "expired", "failed"].includes(current.status)) {
        return { status: "finished" as const, session: sessionRecord(current), commandIds: [] };
      }
      const activeCommands = await transaction
        .selectFrom("commands")
        .select("id")
        .where("organizationId", "=", input.organizationId)
        .where("sessionId", "=", input.sessionId)
        .where("status", "in", ACTIVE_COMMAND_STATUSES)
        .forUpdate()
        .execute();
      if (input.outcome === "complete" && activeCommands.length > 0) {
        return { status: "commands_active" as const };
      }
      const now = new Date();
      if (input.outcome === "cancel" && activeCommands.length > 0) {
        await transaction
          .updateTable("commands")
          .set({ status: "cancellation_requested", updatedAt: now })
          .where("organizationId", "=", input.organizationId)
          .where("id", "in", activeCommands.map((command) => command.id))
          .execute();
      }
      const session = await transaction
        .updateTable("sessions")
        .set({
          status: input.outcome === "complete" ? "completed" : "cancellation_requested",
          ...(input.outcome === "complete" ? { finishedAt: now } : {}),
          updatedAt: now,
        })
        .where("organizationId", "=", input.organizationId)
        .where("id", "=", input.sessionId)
        .returningAll()
        .executeTakeFirstOrThrow();
      return {
        status: "finished" as const,
        session: sessionRecord(session),
        commandIds: activeCommands.map((command) => command.id),
      };
    });
  }

  async requestCommandCancellation(input: {
    organizationId: string;
    agentId: string;
    commandId: string;
  }): Promise<Command | null> {
    return await this.db.transaction().execute(async (transaction) => {
      const current = await transaction
        .selectFrom("commands")
        .selectAll()
        .where("organizationId", "=", input.organizationId)
        .where("agentId", "=", input.agentId)
        .where("id", "=", input.commandId)
        .forUpdate()
        .executeTakeFirst();
      if (!current) return null;
      if (!ACTIVE_COMMAND_STATUSES.includes(current.status as typeof ACTIVE_COMMAND_STATUSES[number])) {
        return commandRecord(current);
      }
      const row = await transaction
        .updateTable("commands")
        .set({ status: "cancellation_requested", updatedAt: new Date() })
        .where("organizationId", "=", input.organizationId)
        .where("id", "=", input.commandId)
        .returningAll()
        .executeTakeFirstOrThrow();
      return commandRecord(row);
    });
  }

  async append(event: Parameters<SessionAudit["append"]>[0]): Promise<void> {
    await this.db
      .insertInto("sessionAuditEvents")
      .values({
        ...event,
        commandId: event.commandId ?? null,
        metadata: JSON.stringify(event.metadata),
      })
      .execute();
  }

  async listAuditEvents(organizationId: string, limit = 100): Promise<Array<{
    id: string;
    agentId: string;
    sessionId: string;
    commandId: string | null;
    type: string;
    metadata: Record<string, unknown>;
    createdAt: string;
  }>> {
    const rows = await this.db
      .selectFrom("sessionAuditEvents")
      .selectAll()
      .where("organizationId", "=", organizationId)
      .orderBy("createdAt", "desc")
      .limit(Math.min(Math.max(limit, 1), 200))
      .execute();
    return rows.map((row) => ({
      id: String(row.id),
      agentId: row.agentId,
      sessionId: row.sessionId,
      commandId: row.commandId,
      type: row.type,
      metadata: row.metadata,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async markSessionOpened(input: {
    organizationId: string;
    machineId: string;
    sessionId: string;
    clientProfileId: string;
    operatingSystemUser: string;
  }): Promise<Session | null> {
    const row = await this.db
      .updateTable("sessions")
      .set({ status: "active", readyAt: new Date(), updatedAt: new Date() })
      .where("organizationId", "=", input.organizationId)
      .where("machineId", "=", input.machineId)
      .where("id", "=", input.sessionId)
      .where("clientProfileId", "=", input.clientProfileId)
      .where("operatingSystemUser", "=", input.operatingSystemUser)
      .where("status", "=", "opening")
      .returningAll()
      .executeTakeFirst();
    if (!row) return null;
    const session = sessionRecord(row);
    await this.append({
      organizationId: session.organizationId,
      agentId: session.agentId,
      sessionId: session.id,
      type: "session.opened",
      metadata: {
        machineId: session.machineId,
        clientProfileId: session.clientProfileId,
        operatingSystemUser: session.operatingSystemUser,
      },
    });
    return session;
  }

  async markSessionFailed(
    organizationId: string,
    machineId: string,
    sessionId: string,
    error: string,
  ): Promise<boolean> {
    const now = new Date();
    const row = await this.db
      .updateTable("sessions")
      .set({ status: "failed", finishedAt: now, updatedAt: now })
      .where("organizationId", "=", organizationId)
      .where("machineId", "=", machineId)
      .where("id", "=", sessionId)
      .where("status", "=", "opening")
      .returning(["agentId"])
      .executeTakeFirst();
    if (!row) return false;
    await this.append({
      organizationId,
      agentId: row.agentId,
      sessionId,
      type: "session.open_failed",
      metadata: { outcome: "open_failed", error: error.slice(0, 2048) },
    });
    return true;
  }

  async markSessionClosed(
    organizationId: string,
    machineId: string,
    sessionId: string,
    reason: string,
  ): Promise<boolean> {
    const now = new Date();
    const status = reason === "expired" ? "expired" : "cancelled";
    const row = await this.db
      .updateTable("sessions")
      .set({ status, finishedAt: now, updatedAt: now })
      .where("organizationId", "=", organizationId)
      .where("machineId", "=", machineId)
      .where("id", "=", sessionId)
      .where("status", "in", ["opening", "active", "cancellation_requested"])
      .returning(["id", "agentId"])
      .executeTakeFirst();
    if (!row) return false;
    await this.append({
      organizationId,
      agentId: row.agentId,
      sessionId,
      type: "session.closed",
      metadata: { reason },
    });
    return true;
  }

  async markCommandStarted(
    organizationId: string,
    machineId: string,
    commandId: string,
    startedAt: string,
  ): Promise<boolean> {
    const row = await this.db
      .updateTable("commands")
      .set({ status: "running", startedAt: new Date(startedAt), updatedAt: new Date() })
      .where("organizationId", "=", organizationId)
      .where("machineId", "=", machineId)
      .where("id", "=", commandId)
      .where("status", "in", ["queued", "delivered"])
      .returning("id")
      .executeTakeFirst();
    return row !== undefined;
  }

  async addCommandOutput(input: {
    organizationId: string;
    machineId: string;
    commandId: string;
    stream: "stdout" | "stderr";
    sequence: number;
    data: Buffer;
  }): Promise<boolean> {
    return await this.db.transaction().execute(async (transaction) => {
      const command = await transaction
        .selectFrom("commands")
        .select(["stdoutBytes", "stderrBytes"])
        .where("organizationId", "=", input.organizationId)
        .where("machineId", "=", input.machineId)
        .where("id", "=", input.commandId)
        .where("status", "in", ACTIVE_COMMAND_STATUSES)
        .forUpdate()
        .executeTakeFirst();
      if (!command) return false;
      if (
        command.stdoutBytes + command.stderrBytes + input.data.length >
        DEFAULT_COMMAND_OUTPUT_BYTES
      ) {
        return false;
      }
      const inserted = await transaction
        .insertInto("commandOutputChunks")
        .values({
          organizationId: input.organizationId,
          commandId: input.commandId,
          sequence: input.sequence,
          stream: input.stream,
          data: input.data,
          expiresAt: new Date(Date.now() + this.commandOutputRetentionMilliseconds),
        })
        .onConflict((conflict) =>
          conflict.columns(["organizationId", "commandId", "sequence"]).doNothing(),
        )
        .returning("sequence")
        .executeTakeFirst();
      if (!inserted) return true;
      const column = input.stream === "stdout" ? "stdoutBytes" : "stderrBytes";
      await transaction
        .updateTable("commands")
        .set({ [column]: sql`${sql.ref(column)} + ${input.data.length}`, updatedAt: new Date() })
        .where("organizationId", "=", input.organizationId)
        .where("id", "=", input.commandId)
        .execute();
      return true;
    });
  }

  async commandOutput(
    organizationId: string,
    commandId: string,
    afterSequence: number,
  ): Promise<Array<{ sequence: number; stream: "stdout" | "stderr"; dataBase64: string }>> {
    const chunks = await this.db
      .selectFrom("commandOutputChunks")
      .innerJoin("commands", (join) => join
        .onRef("commands.organizationId", "=", "commandOutputChunks.organizationId")
        .onRef("commands.id", "=", "commandOutputChunks.commandId"))
      .select([
        "commandOutputChunks.sequence",
        "commandOutputChunks.stream",
        "commandOutputChunks.data",
      ])
      .where("commandOutputChunks.organizationId", "=", organizationId)
      .where("commandOutputChunks.commandId", "=", commandId)
      .where("commandOutputChunks.sequence", ">", afterSequence)
      .where("commandOutputChunks.expiresAt", ">", new Date())
      .orderBy("commandOutputChunks.sequence")
      .limit(256)
      .execute();
    return chunks.map((chunk) => ({
      sequence: chunk.sequence,
      stream: chunk.stream as "stdout" | "stderr",
      dataBase64: chunk.data.toString("base64"),
    }));
  }

  async markCommandCompleted(input: {
    organizationId: string;
    machineId: string;
    commandId: string;
    status: Command["status"];
    exitCode: number | null;
    error?: string;
    outputTruncated: boolean;
    finishedAt: string;
  }): Promise<Command | null> {
    const row = await this.db
      .updateTable("commands")
      .set({
        status: input.status,
        exitCode: input.exitCode,
        error: input.error?.slice(0, 2048) ?? null,
        outputTruncated: input.outputTruncated,
        finishedAt: new Date(input.finishedAt),
        updatedAt: new Date(),
      })
      .where("organizationId", "=", input.organizationId)
      .where("machineId", "=", input.machineId)
      .where("id", "=", input.commandId)
      .where("status", "in", ACTIVE_COMMAND_STATUSES)
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      return await this.command(input.organizationId, input.commandId);
    }
    const command = commandRecord(row);
    await this.append({
      organizationId: command.organizationId,
      agentId: command.agentId,
      sessionId: command.sessionId,
      commandId: command.id,
      type: "command.completed",
      metadata: {
        outcome: command.status,
        exitCode: command.exitCode,
        outputTruncated: command.outputTruncated,
        stdoutBytes: command.stdoutBytes,
        stderrBytes: command.stderrBytes,
      },
    });
    return command;
  }

  async expireSessions(now = Date.now()): Promise<
    Array<{ session: Session; commandIds: string[] }>
  > {
    return await this.db.transaction().execute(async (transaction) => {
      await transaction
        .updateTable("sessions")
        .set({ status: "expired", finishedAt: new Date(now), updatedAt: new Date(now) })
        .where("status", "=", "pending_approval")
        .where("expiresAt", "<=", new Date(now))
        .execute();
      const expired = await transaction
        .updateTable("sessions")
        .set({ status: "cancellation_requested", updatedAt: new Date(now) })
        .where("status", "in", ["opening", "active"])
        .where("expiresAt", "<=", new Date(now))
        .returningAll()
        .execute();
      const result: Array<{ session: Session; commandIds: string[] }> = [];
      for (const session of expired) {
        const commands = await transaction
          .updateTable("commands")
          .set({ status: "cancellation_requested", updatedAt: new Date(now) })
          .where("organizationId", "=", session.organizationId)
          .where("sessionId", "=", session.id)
          .where("status", "in", ACTIVE_COMMAND_STATUSES)
          .returning("id")
          .execute();
        result.push({
          session: sessionRecord(session),
          commandIds: commands.map((command) => command.id),
        });
      }
      return result;
    });
  }

  async revokeSessions(input: {
    organizationId: string;
    agentId?: string;
    machineId?: string;
    now?: number;
  }): Promise<Array<{ session: Session; commandIds: string[] }>> {
    if (input.agentId === undefined && input.machineId === undefined) {
      throw new Error("Session revocation requires an Agent or Machine scope");
    }
    const now = new Date(input.now ?? Date.now());
    return await this.db.transaction().execute(async (transaction) => {
      let sessions = transaction
        .selectFrom("sessions")
        .selectAll()
        .where("organizationId", "=", input.organizationId)
        .where("status", "in", ACTIVE_SESSION_STATUSES)
        .forUpdate();
      if (input.agentId !== undefined) {
        sessions = sessions.where("agentId", "=", input.agentId);
      }
      if (input.machineId !== undefined) {
        sessions = sessions.where("machineId", "=", input.machineId);
      }
      const activeSessions = await sessions.execute();
      const revoked: Array<{ session: Session; commandIds: string[] }> = [];
      for (const activeSession of activeSessions) {
        const commands = await transaction
          .updateTable("commands")
          .set({ status: "cancellation_requested", updatedAt: now })
          .where("organizationId", "=", input.organizationId)
          .where("sessionId", "=", activeSession.id)
          .where("status", "in", ACTIVE_COMMAND_STATUSES)
          .returning("id")
          .execute();
        const session = await transaction
          .updateTable("sessions")
          .set({ status: "revoked", finishedAt: now, updatedAt: now })
          .where("organizationId", "=", input.organizationId)
          .where("id", "=", activeSession.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        revoked.push({
          session: sessionRecord(session),
          commandIds: commands.map((command) => command.id),
        });
      }
      if (input.machineId !== undefined) {
        await transaction
          .deleteFrom("machineAuthorities")
          .where("organizationId", "=", input.organizationId)
          .where("machineId", "=", input.machineId)
          .execute();
      }
      return revoked;
    });
  }

  async purgeExpiredCommandOutput(now = Date.now()): Promise<number> {
    const deleted = await this.db
      .deleteFrom("commandOutputChunks")
      .where("expiresAt", "<=", new Date(now))
      .returning("sequence")
      .execute();
    return deleted.length;
  }
}

function machineAuthorityRecord(row: Selectable<MachineAuthorityTable>): MachineAuthority {
  return {
    organizationId: row.organizationId,
    machineId: row.machineId,
    clientProfileId: row.clientProfileId,
    operatingSystemUser: row.operatingSystemUser,
    online: row.online,
    localPolicy: row.localPolicy,
  };
}

function sessionInsert(input: Parameters<SessionRepository["createSession"]>[0]) {
  const session = input.session;
  return {
    ...session,
    idempotencyKeyHash: input.idempotencyKeyHash,
    requestFingerprint: input.requestFingerprint,
    createdAt: new Date(session.createdAt),
    readyAt: session.readyAt ? new Date(session.readyAt) : null,
    expiresAt: new Date(session.expiresAt),
    finishedAt: session.finishedAt ? new Date(session.finishedAt) : null,
  };
}

function commandInsert(input: Parameters<SessionRepository["createCommand"]>[0]) {
  const command = input.command;
  return {
    ...command,
    idempotencyKeyHash: input.idempotencyKeyHash,
    requestFingerprint: input.requestFingerprint,
    createdAt: new Date(command.createdAt),
    startedAt: command.startedAt ? new Date(command.startedAt) : null,
    finishedAt: command.finishedAt ? new Date(command.finishedAt) : null,
  };
}

function sessionRecord(row: Selectable<SessionTable>): Session {
  return {
    id: row.id,
    organizationId: row.organizationId,
    agentId: row.agentId,
    machineId: row.machineId,
    clientProfileId: row.clientProfileId,
    operatingSystemUser: row.operatingSystemUser,
    title: row.title,
    purpose: row.purpose,
    status: row.status as Session["status"],
    maxConcurrentCommands: row.maxConcurrentCommands,
    createdAt: row.createdAt.toISOString(),
    readyAt: row.readyAt?.toISOString() ?? null,
    expiresAt: row.expiresAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

function commandRecord(row: Selectable<CommandTable>): Command {
  return {
    id: row.id,
    sessionId: row.sessionId,
    organizationId: row.organizationId,
    agentId: row.agentId,
    machineId: row.machineId,
    command: row.command,
    cwd: row.cwd,
    timeoutSeconds: row.timeoutSeconds,
    status: row.status as Command["status"],
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    exitCode: row.exitCode,
    outputTruncated: row.outputTruncated,
    stdoutBytes: row.stdoutBytes,
    stderrBytes: row.stderrBytes,
    error: row.error,
  };
}

function isUniqueConflict(error: unknown): boolean {
  return (error as { code?: unknown })?.code === "23505";
}

export function createSessionDatabase(environment: NodeJS.ProcessEnv): PostgresSessionDatabase {
  const connectionString = environment.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const retentionDays = Number(environment.ODYSHELL_COMMAND_OUTPUT_RETENTION_DAYS ?? 30);
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) {
    throw new Error("ODYSHELL_COMMAND_OUTPUT_RETENTION_DAYS must be an integer between 1 and 365");
  }
  return new PostgresSessionDatabase(connectionString, retentionDays * 24 * 60 * 60_000);
}
