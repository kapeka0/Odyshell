import { createHash, randomUUID } from "node:crypto";
import {
  commandDecision,
  type Command,
  type CommandRequest,
  type LocalPolicy,
  type Task,
  type TaskRequest,
} from "@odyshell/protocol";

export type AgentPrincipal = {
  organizationId: string;
  agentId: string;
};

export type TaskSupervisorPrincipal = {
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

export type AutonomyPolicy = {
  organizationId: string;
  agentId: string;
  machineId: string;
  maxTaskDurationSeconds: number;
  maxConcurrentTasks: number;
  maxConcurrentCommands: number;
  expiresAt: number;
};

type TaskCreation = {
  task: Task;
  idempotencyKeyHash: string;
  requestFingerprint: string;
};

type CommandCreation = {
  command: Command;
  idempotencyKeyHash: string;
  requestFingerprint: string;
};

export interface TaskRepository {
  taskByIdempotency(
    organizationId: string,
    agentId: string,
    idempotencyKeyHash: string,
  ): Promise<{ task: Task; requestFingerprint: string } | null>;
  machineAuthority(organizationId: string, machineId: string): Promise<MachineAuthority | null>;
  autonomyPolicy(
    organizationId: string,
    agentId: string,
    machineId: string,
  ): Promise<AutonomyPolicy | null>;
  countActiveTasks(organizationId: string, machineId: string): Promise<number>;
  createTask(input: TaskCreation): Promise<
    | { status: "created"; task: Task }
    | { status: "replayed"; task: Task }
    | { status: "idempotency_conflict" }
  >;
  task(organizationId: string, taskId: string): Promise<Task | null>;
  command(organizationId: string, commandId: string): Promise<Command | null>;
  commandOutput(
    organizationId: string,
    commandId: string,
    afterSequence: number,
  ): Promise<Array<{ sequence: number; stream: "stdout" | "stderr"; dataBase64: string }>>;
  finishTask(input: {
    organizationId: string;
    agentId: string;
    taskId: string;
    outcome: "complete" | "cancel";
  }): Promise<
    | { status: "not_found" }
    | { status: "commands_active" }
    | { status: "finished"; task: Task; commandIds: string[] }
  >;
  requestCommandCancellation(input: {
    organizationId: string;
    agentId: string;
    commandId: string;
  }): Promise<Command | null>;
  commandByIdempotency(
    organizationId: string,
    taskId: string,
    idempotencyKeyHash: string,
  ): Promise<{ command: Command; requestFingerprint: string } | null>;
  countActiveCommands(organizationId: string, taskId: string): Promise<number>;
  createCommand(input: CommandCreation): Promise<
    | { status: "created"; command: Command }
    | { status: "replayed"; command: Command }
    | { status: "idempotency_conflict" }
  >;
  decideTask(input: {
    organizationId: string;
    taskId: string;
    decision: "approve" | "deny";
  }): Promise<
    | { status: "not_found" | "conflict" }
    | { status: "approved" | "denied"; task: Task; changed: boolean }
  >;
}

export interface TaskClient {
  openTask(task: Task): Promise<void>;
  startCommand(command: Command): Promise<void>;
  closeTask(task: Task, reason: string): Promise<void>;
  cancelCommand(command: Command): Promise<void>;
}

export class TaskClientUnavailableError extends Error {
  constructor() {
    super("Machine disconnected before Task delivery");
    this.name = "TaskClientUnavailableError";
  }
}

export interface TaskAudit {
  append(event: {
    organizationId: string;
    agentId: string;
    taskId: string;
    commandId?: string;
    type:
      | "task.requested"
      | "task.opened"
      | "task.open_failed"
      | "task.approved"
      | "task.denied"
      | "task.closed"
      | "command.created"
      | "command.completed";
    metadata: Record<string, unknown>;
  }): Promise<void>;
}

export type RequestTaskResult =
  | { status: "created" | "replayed"; task: Task }
  | {
      status: "denied";
      code:
        | "machine_not_found"
        | "machine_offline"
        | "organization_denied"
        | "agent_denied"
        | "duration_denied"
        | "task_concurrency_denied"
        | "command_concurrency_denied"
        | "idempotency_conflict";
    };

export type CreateCommandResult =
  | { status: "created" | "replayed"; command: Command }
  | {
      status: "denied";
      code:
        | "task_not_found"
        | "task_agent_denied"
        | "task_not_active"
        | "task_expired"
        | "timeout_exceeds_task"
        | "timeout_exceeds_local_policy"
        | "command_concurrency_denied"
        | "idempotency_conflict";
    };

export class TaskService {
  constructor(
    private readonly repository: TaskRepository,
    private readonly client: TaskClient,
    private readonly audit: TaskAudit,
    private readonly now: () => number = Date.now,
  ) {}

  async requestTask(
    principal: AgentPrincipal,
    request: TaskRequest,
    idempotencyKey: string,
  ): Promise<RequestTaskResult> {
    const idempotencyKeyHash = hash(idempotencyKey);
    const requestFingerprint = fingerprint({ principal, request });
    const replay = await this.repository.taskByIdempotency(
      principal.organizationId,
      principal.agentId,
      idempotencyKeyHash,
    );
    if (replay) {
      return replay.requestFingerprint === requestFingerprint
        ? { status: "replayed", task: replay.task }
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
    if (!policy.agentIds.includes(principal.agentId)) {
      return { status: "denied", code: "agent_denied" };
    }
    if (request.durationSeconds > policy.maxTaskDurationSeconds) {
      return { status: "denied", code: "duration_denied" };
    }
    const activeTasks = await this.repository.countActiveTasks(
      principal.organizationId,
      request.machineId,
    );
    if (activeTasks >= policy.maxConcurrentTasks) {
      return { status: "denied", code: "task_concurrency_denied" };
    }

    const autonomy = await this.repository.autonomyPolicy(
      principal.organizationId,
      principal.agentId,
      request.machineId,
    );
    const autonomous = autonomy !== null &&
      autonomy.expiresAt > this.now() &&
      request.durationSeconds <= autonomy.maxTaskDurationSeconds &&
      activeTasks < autonomy.maxConcurrentTasks;
    const maxConcurrentCommands = Math.min(
      policy.maxConcurrentCommands,
      autonomous ? autonomy.maxConcurrentCommands : policy.maxConcurrentCommands,
    );
    if (maxConcurrentCommands < 1) {
      return { status: "denied", code: "command_concurrency_denied" };
    }
    if (!autonomous && !policy.allowRemoteApproval) {
      return { status: "denied", code: "agent_denied" };
    }

    const now = this.now();
    const task: Task = {
      id: randomUUID(),
      organizationId: principal.organizationId,
      agentId: principal.agentId,
      machineId: request.machineId,
      clientProfileId: machine.clientProfileId,
      operatingSystemUser: machine.operatingSystemUser,
      title: request.title,
      purpose: request.purpose ?? null,
      status: autonomous ? "opening" : "pending_approval",
      maxConcurrentCommands,
      createdAt: new Date(now).toISOString(),
      readyAt: null,
      expiresAt: new Date(now + request.durationSeconds * 1_000).toISOString(),
      finishedAt: null,
    };
    const stored = await this.repository.createTask({
      task,
      idempotencyKeyHash,
      requestFingerprint,
    });
    if (stored.status === "idempotency_conflict") {
      return { status: "denied", code: "idempotency_conflict" };
    }
    if (stored.status === "replayed") return stored;

    await this.audit.append({
      organizationId: task.organizationId,
      agentId: task.agentId,
      taskId: task.id,
      type: "task.requested",
      metadata: {
        machineId: task.machineId,
        clientProfileId: task.clientProfileId,
        operatingSystemUser: task.operatingSystemUser,
        durationSeconds: request.durationSeconds,
        autonomous,
      },
    });
    if (task.status === "opening") await this.client.openTask(task);
    return { status: "created", task };
  }

  async createCommand(
    principal: AgentPrincipal,
    taskId: string,
    request: CommandRequest,
    idempotencyKey: string,
  ): Promise<CreateCommandResult> {
    const idempotencyKeyHash = hash(idempotencyKey);
    const requestFingerprint = fingerprint({ principal, taskId, request });
    const replay = await this.repository.commandByIdempotency(
      principal.organizationId,
      taskId,
      idempotencyKeyHash,
    );
    if (replay) {
      return replay.requestFingerprint === requestFingerprint
        ? { status: "replayed", command: replay.command }
        : { status: "denied", code: "idempotency_conflict" };
    }
    const task = await this.repository.task(principal.organizationId, taskId);
    if (!task) return { status: "denied", code: "task_not_found" };
    if (task.agentId !== principal.agentId) {
      return { status: "denied", code: "task_agent_denied" };
    }
    const machine = await this.repository.machineAuthority(
      principal.organizationId,
      task.machineId,
    );
    if (!machine) return { status: "denied", code: "task_not_found" };
    const decision = commandDecision(task, request, machine.localPolicy, this.now());
    if (!decision.allowed) return { status: "denied", code: decision.code };
    if (
      await this.repository.countActiveCommands(principal.organizationId, task.id) >=
      task.maxConcurrentCommands
    ) {
      return { status: "denied", code: "command_concurrency_denied" };
    }

    const now = this.now();
    const command: Command = {
      id: randomUUID(),
      taskId: task.id,
      organizationId: task.organizationId,
      agentId: task.agentId,
      machineId: task.machineId,
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
      taskId: command.taskId,
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

  async superviseTask(
    principal: TaskSupervisorPrincipal,
    taskId: string,
    decision: "approve" | "deny",
  ): Promise<
    | { status: "approved" | "denied"; task: Task; delivery: "sent" | "pending" }
    | { status: "denied_request"; code: "task_not_found" | "task_already_decided" }
  > {
    const result = await this.repository.decideTask({
      organizationId: principal.organizationId,
      taskId,
      decision,
    });
    if (!("task" in result)) {
      return {
        status: "denied_request",
        code: result.status === "not_found" ? "task_not_found" : "task_already_decided",
      };
    }
    if (result.changed) {
      await this.audit.append({
        organizationId: result.task.organizationId,
        agentId: result.task.agentId,
        taskId: result.task.id,
        type: decision === "approve" ? "task.approved" : "task.denied",
        metadata: { humanId: principal.humanId, role: principal.role },
      });
    }
    if (result.status === "denied") {
      return { status: "denied", task: result.task, delivery: "sent" };
    }
    try {
      await this.client.openTask(result.task);
      return { status: "approved", task: result.task, delivery: "sent" };
    } catch (error) {
      if (!(error instanceof TaskClientUnavailableError)) throw error;
      return { status: "approved", task: result.task, delivery: "pending" };
    }
  }

  async finishTask(
    principal: AgentPrincipal,
    taskId: string,
    outcome: "complete" | "cancel",
  ): Promise<
    | { status: "completed" | "cancellation_requested"; task: Task }
    | { status: "denied"; code: "task_not_found" | "commands_active" }
  > {
    const result = await this.repository.finishTask({
      ...principal,
      taskId,
      outcome,
    });
    if (result.status === "not_found" || result.status === "commands_active") {
      return {
        status: "denied",
        code: result.status === "not_found" ? "task_not_found" : "commands_active",
      };
    }
    if (outcome === "cancel") {
      for (const commandId of result.commandIds) {
        const command = await this.repository.command(principal.organizationId, commandId);
        if (command) await this.client.cancelCommand(command);
      }
    }
    await this.client.closeTask(result.task, outcome === "complete" ? "completed" : "cancelled");
    return {
      status: outcome === "complete" ? "completed" : "cancellation_requested",
      task: result.task,
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
