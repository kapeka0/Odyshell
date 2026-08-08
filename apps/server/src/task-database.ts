import {
  DEFAULT_COMMAND_OUTPUT_BYTES,
  type Command,
  type LocalPolicy,
  type Task,
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
  AutonomyPolicy,
  MachineAuthority,
  TaskAudit,
  TaskRepository,
} from "./tasks.js";
import type { TaskReconnectState } from "./task-reconciliation.js";

const { Pool } = pg;
const DATABASE_SCHEMA = "odyshell";
const ACTIVE_TASK_STATUSES = ["pending_approval", "opening", "active"] as const;
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

interface AutonomyPolicyTable {
  organizationId: string;
  agentId: string;
  machineId: string;
  maxTaskDurationSeconds: number;
  maxConcurrentTasks: number;
  maxConcurrentCommands: number;
  expiresAt: Date;
  createdAt: Generated<Date>;
  updatedAt: Generated<Date>;
}

interface TaskTable {
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
  taskId: string;
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

interface TaskAuditEventTable {
  id: Generated<number>;
  organizationId: string;
  agentId: string;
  taskId: string;
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

interface TaskDatabaseSchema {
  machineAuthorities: MachineAuthorityTable;
  autonomyPolicies: AutonomyPolicyTable;
  tasks: TaskTable;
  commands: CommandTable;
  taskAuditEvents: TaskAuditEventTable;
  commandOutputChunks: CommandOutputChunkTable;
}

async function migrateTaskCommandCore(db: Kysely<TaskDatabaseSchema>): Promise<void> {
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
    `create table odyshell.autonomy_policies (
      organization_id text not null,
      agent_id text not null,
      machine_id uuid not null,
      max_task_duration_seconds integer not null,
      max_concurrent_tasks integer not null,
      max_concurrent_commands integer not null,
      expires_at timestamptz not null,
      created_at timestamptz not null default current_timestamp,
      updated_at timestamptz not null default current_timestamp,
      primary key (organization_id, agent_id, machine_id)
    )`,
    `create table odyshell.tasks (
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
    `create index tasks_machine_active_idx
      on odyshell.tasks (organization_id, machine_id, status)`,
    `create table odyshell.commands (
      id uuid primary key,
      task_id uuid not null references odyshell.tasks (id) on delete cascade,
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
      unique (organization_id, task_id, idempotency_key_hash)
    )`,
    `create index commands_task_active_idx
      on odyshell.commands (organization_id, task_id, status)`,
    `create table odyshell.task_audit_events (
      id bigint generated always as identity primary key,
      organization_id text not null,
      agent_id text not null,
      task_id uuid not null references odyshell.tasks (id) on delete cascade,
      command_id uuid references odyshell.commands (id) on delete cascade,
      type text not null,
      metadata jsonb not null,
      created_at timestamptz not null default current_timestamp
    )`,
    `create index task_audit_timeline_idx
      on odyshell.task_audit_events (organization_id, task_id, id)`,
  ];
  for (const statement of statements) await sql.raw(statement).execute(db);
}

async function migrateTransientCommandOutput(
  db: Kysely<TaskDatabaseSchema>,
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

const taskMigrationProvider: MigrationProvider = {
  async getMigrations(): Promise<Record<string, Migration>> {
    return {
      "001_task_command_core": { up: migrateTaskCommandCore },
      "002_transient_command_output": { up: migrateTransientCommandOutput },
    };
  },
};

export class PostgresTaskDatabase implements TaskRepository, TaskAudit {
  private readonly root: Kysely<TaskDatabaseSchema>;
  private readonly db: Kysely<TaskDatabaseSchema>;

  constructor(connectionString: string) {
    this.root = new Kysely<TaskDatabaseSchema>({
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
      provider: taskMigrationProvider,
      migrationTableName: "task_migrations",
      migrationLockTableName: "task_migration_lock",
      migrationTableSchema: DATABASE_SCHEMA,
    });
    const { error, results } = await migrator.migrateToLatest();
    const failed = results?.find((result) => result.status === "Error");
    if (failed) throw new Error(`Task database migration ${failed.migrationName} failed`);
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
    agentId: string,
  ): Promise<MachineAuthority[]> {
    const rows = await this.db
      .selectFrom("machineAuthorities")
      .selectAll()
      .where("organizationId", "=", organizationId)
      .orderBy("machineId")
      .execute();
    return rows
      .map(machineAuthorityRecord)
      .filter((authority) => authority.localPolicy.agentIds.includes(agentId));
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
  ): Promise<TaskReconnectState> {
    const tasks = await this.db
      .selectFrom("tasks")
      .selectAll()
      .where("organizationId", "=", organizationId)
      .where("machineId", "=", machineId)
      .where("status", "in", ["opening", "active", "cancellation_requested"])
      .orderBy("createdAt")
      .orderBy("id")
      .execute();
    if (tasks.length === 0) return { tasks: [], commands: [] };
    const commands = await this.db
      .selectFrom("commands")
      .selectAll()
      .where("organizationId", "=", organizationId)
      .where("machineId", "=", machineId)
      .where("taskId", "in", tasks.map((task) => task.id))
      .where("status", "in", ACTIVE_COMMAND_STATUSES)
      .orderBy("createdAt")
      .orderBy("id")
      .execute();
    return {
      tasks: tasks.map(taskRecord),
      commands: commands.map(commandRecord),
    };
  }

  async autonomyPolicy(
    organizationId: string,
    agentId: string,
    machineId: string,
  ): Promise<AutonomyPolicy | null> {
    const row = await this.db
      .selectFrom("autonomyPolicies")
      .selectAll()
      .where("organizationId", "=", organizationId)
      .where("agentId", "=", agentId)
      .where("machineId", "=", machineId)
      .executeTakeFirst();
    return row ? autonomyPolicyRecord(row) : null;
  }

  async putAutonomyPolicy(policy: AutonomyPolicy): Promise<void> {
    await this.db
      .insertInto("autonomyPolicies")
      .values({ ...policy, expiresAt: new Date(policy.expiresAt) })
      .onConflict((conflict) =>
        conflict.columns(["organizationId", "agentId", "machineId"]).doUpdateSet({
          maxTaskDurationSeconds: policy.maxTaskDurationSeconds,
          maxConcurrentTasks: policy.maxConcurrentTasks,
          maxConcurrentCommands: policy.maxConcurrentCommands,
          expiresAt: new Date(policy.expiresAt),
          updatedAt: new Date(),
        }),
      )
      .execute();
  }

  async countActiveTasks(organizationId: string, machineId: string): Promise<number> {
    const result = await this.db
      .selectFrom("tasks")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("organizationId", "=", organizationId)
      .where("machineId", "=", machineId)
      .where("status", "in", ACTIVE_TASK_STATUSES)
      .executeTakeFirstOrThrow();
    return Number(result.count);
  }

  async taskByIdempotency(
    organizationId: string,
    agentId: string,
    idempotencyKeyHash: string,
  ): Promise<{ task: Task; requestFingerprint: string } | null> {
    const row = await this.db
      .selectFrom("tasks")
      .selectAll()
      .where("organizationId", "=", organizationId)
      .where("agentId", "=", agentId)
      .where("idempotencyKeyHash", "=", idempotencyKeyHash)
      .executeTakeFirst();
    return row ? { task: taskRecord(row), requestFingerprint: row.requestFingerprint } : null;
  }

  async createTask(input: Parameters<TaskRepository["createTask"]>[0]) {
    try {
      const row = await this.db
        .insertInto("tasks")
        .values(taskInsert(input))
        .returningAll()
        .executeTakeFirstOrThrow();
      return { status: "created" as const, task: taskRecord(row) };
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
      const existing = await this.taskByIdempotency(
        input.task.organizationId,
        input.task.agentId,
        input.idempotencyKeyHash,
      );
      if (!existing || existing.requestFingerprint !== input.requestFingerprint) {
        return { status: "idempotency_conflict" as const };
      }
      return { status: "replayed" as const, task: existing.task };
    }
  }

  async task(organizationId: string, taskId: string): Promise<Task | null> {
    const row = await this.db
      .selectFrom("tasks")
      .selectAll()
      .where("organizationId", "=", organizationId)
      .where("id", "=", taskId)
      .executeTakeFirst();
    return row ? taskRecord(row) : null;
  }

  async listTasks(
    organizationId: string,
    limit = 100,
  ): Promise<Task[]> {
    const rows = await this.db
      .selectFrom("tasks")
      .selectAll()
      .where("organizationId", "=", organizationId)
      .orderBy("createdAt", "desc")
      .limit(Math.min(Math.max(limit, 1), 200))
      .execute();
    return rows.map(taskRecord);
  }

  async decideTask(input: {
    organizationId: string;
    taskId: string;
    decision: "approve" | "deny";
  }): Promise<
    | { status: "not_found" | "conflict" }
    | { status: "approved" | "denied"; task: Task; changed: boolean }
  > {
    return await this.db.transaction().execute(async (transaction) => {
      const current = await transaction
        .selectFrom("tasks")
        .selectAll()
        .where("organizationId", "=", input.organizationId)
        .where("id", "=", input.taskId)
        .forUpdate()
        .executeTakeFirst();
      if (!current) return { status: "not_found" as const };
      if (
        input.decision === "approve" &&
        (current.status === "opening" || current.status === "active")
      ) {
        return { status: "approved" as const, task: taskRecord(current), changed: false };
      }
      if (current.status !== "pending_approval") {
        return { status: "conflict" as const };
      }
      const now = new Date();
      if (current.expiresAt <= now) {
        await transaction
          .updateTable("tasks")
          .set({ status: "expired", finishedAt: now, updatedAt: now })
          .where("organizationId", "=", input.organizationId)
          .where("id", "=", input.taskId)
          .where("status", "=", "pending_approval")
          .execute();
        return { status: "conflict" as const };
      }
      const row = await transaction
        .updateTable("tasks")
        .set(input.decision === "approve"
          ? { status: "opening", updatedAt: now }
          : { status: "cancelled", finishedAt: now, updatedAt: now })
        .where("organizationId", "=", input.organizationId)
        .where("id", "=", input.taskId)
        .where("status", "=", "pending_approval")
        .returningAll()
        .executeTakeFirst();
      if (!row) return { status: "conflict" as const };
      return {
        status: input.decision === "approve" ? "approved" as const : "denied" as const,
        task: taskRecord(row),
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

  async countActiveCommands(organizationId: string, taskId: string): Promise<number> {
    const result = await this.db
      .selectFrom("commands")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("organizationId", "=", organizationId)
      .where("taskId", "=", taskId)
      .where("status", "in", ACTIVE_COMMAND_STATUSES)
      .executeTakeFirstOrThrow();
    return Number(result.count);
  }

  async commandByIdempotency(
    organizationId: string,
    taskId: string,
    idempotencyKeyHash: string,
  ): Promise<{ command: Command; requestFingerprint: string } | null> {
    const row = await this.db
      .selectFrom("commands")
      .selectAll()
      .where("organizationId", "=", organizationId)
      .where("taskId", "=", taskId)
      .where("idempotencyKeyHash", "=", idempotencyKeyHash)
      .executeTakeFirst();
    return row
      ? { command: commandRecord(row), requestFingerprint: row.requestFingerprint }
      : null;
  }

  async createCommand(input: Parameters<TaskRepository["createCommand"]>[0]) {
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
        input.command.taskId,
        input.idempotencyKeyHash,
      );
      if (!existing || existing.requestFingerprint !== input.requestFingerprint) {
        return { status: "idempotency_conflict" as const };
      }
      return { status: "replayed" as const, command: existing.command };
    }
  }

  async finishTask(input: {
    organizationId: string;
    agentId: string;
    taskId: string;
    outcome: "complete" | "cancel";
  }): Promise<
    | { status: "not_found" }
    | { status: "commands_active" }
    | { status: "finished"; task: Task; commandIds: string[] }
  > {
    return await this.db.transaction().execute(async (transaction) => {
      const current = await transaction
        .selectFrom("tasks")
        .selectAll()
        .where("organizationId", "=", input.organizationId)
        .where("agentId", "=", input.agentId)
        .where("id", "=", input.taskId)
        .forUpdate()
        .executeTakeFirst();
      if (!current) return { status: "not_found" as const };
      if (["completed", "cancelled", "revoked", "expired", "failed"].includes(current.status)) {
        return { status: "finished" as const, task: taskRecord(current), commandIds: [] };
      }
      const activeCommands = await transaction
        .selectFrom("commands")
        .select("id")
        .where("organizationId", "=", input.organizationId)
        .where("taskId", "=", input.taskId)
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
      const task = await transaction
        .updateTable("tasks")
        .set({
          status: input.outcome === "complete" ? "completed" : "cancellation_requested",
          ...(input.outcome === "complete" ? { finishedAt: now } : {}),
          updatedAt: now,
        })
        .where("organizationId", "=", input.organizationId)
        .where("id", "=", input.taskId)
        .returningAll()
        .executeTakeFirstOrThrow();
      return {
        status: "finished" as const,
        task: taskRecord(task),
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

  async append(event: Parameters<TaskAudit["append"]>[0]): Promise<void> {
    await this.db
      .insertInto("taskAuditEvents")
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
    taskId: string;
    commandId: string | null;
    type: string;
    metadata: Record<string, unknown>;
    createdAt: string;
  }>> {
    const rows = await this.db
      .selectFrom("taskAuditEvents")
      .selectAll()
      .where("organizationId", "=", organizationId)
      .orderBy("createdAt", "desc")
      .limit(Math.min(Math.max(limit, 1), 200))
      .execute();
    return rows.map((row) => ({
      id: String(row.id),
      agentId: row.agentId,
      taskId: row.taskId,
      commandId: row.commandId,
      type: row.type,
      metadata: row.metadata,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async markTaskOpened(input: {
    organizationId: string;
    machineId: string;
    taskId: string;
    clientProfileId: string;
    operatingSystemUser: string;
  }): Promise<Task | null> {
    const row = await this.db
      .updateTable("tasks")
      .set({ status: "active", readyAt: new Date(), updatedAt: new Date() })
      .where("organizationId", "=", input.organizationId)
      .where("machineId", "=", input.machineId)
      .where("id", "=", input.taskId)
      .where("clientProfileId", "=", input.clientProfileId)
      .where("operatingSystemUser", "=", input.operatingSystemUser)
      .where("status", "=", "opening")
      .returningAll()
      .executeTakeFirst();
    if (!row) return null;
    const task = taskRecord(row);
    await this.append({
      organizationId: task.organizationId,
      agentId: task.agentId,
      taskId: task.id,
      type: "task.opened",
      metadata: {
        machineId: task.machineId,
        clientProfileId: task.clientProfileId,
        operatingSystemUser: task.operatingSystemUser,
      },
    });
    return task;
  }

  async markTaskFailed(
    organizationId: string,
    machineId: string,
    taskId: string,
    error: string,
  ): Promise<boolean> {
    const now = new Date();
    const row = await this.db
      .updateTable("tasks")
      .set({ status: "failed", finishedAt: now, updatedAt: now })
      .where("organizationId", "=", organizationId)
      .where("machineId", "=", machineId)
      .where("id", "=", taskId)
      .where("status", "=", "opening")
      .returning(["agentId"])
      .executeTakeFirst();
    if (!row) return false;
    await this.append({
      organizationId,
      agentId: row.agentId,
      taskId,
      type: "task.open_failed",
      metadata: { outcome: "open_failed", error: error.slice(0, 2048) },
    });
    return true;
  }

  async markTaskClosed(
    organizationId: string,
    machineId: string,
    taskId: string,
    reason: string,
  ): Promise<boolean> {
    const now = new Date();
    const status = reason === "expired" ? "expired" : "cancelled";
    const row = await this.db
      .updateTable("tasks")
      .set({ status, finishedAt: now, updatedAt: now })
      .where("organizationId", "=", organizationId)
      .where("machineId", "=", machineId)
      .where("id", "=", taskId)
      .where("status", "in", ["opening", "active", "cancellation_requested"])
      .returning(["id", "agentId"])
      .executeTakeFirst();
    if (!row) return false;
    await this.append({
      organizationId,
      agentId: row.agentId,
      taskId,
      type: "task.closed",
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
          expiresAt: new Date(Date.now() + 60 * 60_000),
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
      taskId: command.taskId,
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

  async expireTasks(now = Date.now()): Promise<
    Array<{ task: Task; commandIds: string[] }>
  > {
    return await this.db.transaction().execute(async (transaction) => {
      await transaction
        .updateTable("tasks")
        .set({ status: "expired", finishedAt: new Date(now), updatedAt: new Date(now) })
        .where("status", "=", "pending_approval")
        .where("expiresAt", "<=", new Date(now))
        .execute();
      const expired = await transaction
        .updateTable("tasks")
        .set({ status: "cancellation_requested", updatedAt: new Date(now) })
        .where("status", "in", ["opening", "active"])
        .where("expiresAt", "<=", new Date(now))
        .returningAll()
        .execute();
      const result: Array<{ task: Task; commandIds: string[] }> = [];
      for (const task of expired) {
        const commands = await transaction
          .updateTable("commands")
          .set({ status: "cancellation_requested", updatedAt: new Date(now) })
          .where("organizationId", "=", task.organizationId)
          .where("taskId", "=", task.id)
          .where("status", "in", ACTIVE_COMMAND_STATUSES)
          .returning("id")
          .execute();
        result.push({
          task: taskRecord(task),
          commandIds: commands.map((command) => command.id),
        });
      }
      return result;
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

function autonomyPolicyRecord(row: Selectable<AutonomyPolicyTable>): AutonomyPolicy {
  return {
    organizationId: row.organizationId,
    agentId: row.agentId,
    machineId: row.machineId,
    maxTaskDurationSeconds: row.maxTaskDurationSeconds,
    maxConcurrentTasks: row.maxConcurrentTasks,
    maxConcurrentCommands: row.maxConcurrentCommands,
    expiresAt: row.expiresAt.getTime(),
  };
}

function taskInsert(input: Parameters<TaskRepository["createTask"]>[0]) {
  const task = input.task;
  return {
    ...task,
    idempotencyKeyHash: input.idempotencyKeyHash,
    requestFingerprint: input.requestFingerprint,
    createdAt: new Date(task.createdAt),
    readyAt: task.readyAt ? new Date(task.readyAt) : null,
    expiresAt: new Date(task.expiresAt),
    finishedAt: task.finishedAt ? new Date(task.finishedAt) : null,
  };
}

function commandInsert(input: Parameters<TaskRepository["createCommand"]>[0]) {
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

function taskRecord(row: Selectable<TaskTable>): Task {
  return {
    id: row.id,
    organizationId: row.organizationId,
    agentId: row.agentId,
    machineId: row.machineId,
    clientProfileId: row.clientProfileId,
    operatingSystemUser: row.operatingSystemUser,
    title: row.title,
    purpose: row.purpose,
    status: row.status as Task["status"],
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
    taskId: row.taskId,
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

export function createTaskDatabase(environment: NodeJS.ProcessEnv): PostgresTaskDatabase {
  const connectionString = environment.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  return new PostgresTaskDatabase(connectionString);
}
