import type { Command, LocalPolicy, Task } from "@odyshell/protocol";
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

interface TaskDatabaseSchema {
  machineAuthorities: MachineAuthorityTable;
  autonomyPolicies: AutonomyPolicyTable;
  tasks: TaskTable;
  commands: CommandTable;
  taskAuditEvents: TaskAuditEventTable;
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

const taskMigrationProvider: MigrationProvider = {
  async getMigrations(): Promise<Record<string, Migration>> {
    return { "001_task_command_core": { up: migrateTaskCommandCore } };
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
