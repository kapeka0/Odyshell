import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Command, LocalPolicy, Task } from "@odyshell/protocol";
import {
  TaskService,
  TaskClientUnavailableError,
  type AutonomyPolicy,
  type MachineAuthority,
  type TaskAudit,
  type TaskClient,
  type TaskRepository,
} from "../apps/server/src/tasks.js";

const organizationId = "org-a";
const agentId = "agent-a";
const machineId = "7a354999-6a6c-42db-9467-e1416da255f1";
const now = Date.parse("2026-08-08T10:00:00.000Z");

class MemoryRepository implements TaskRepository {
  tasks = new Map<string, Task>();
  commands = new Map<string, Command>();
  taskKeys = new Map<string, { fingerprint: string; task: Task }>();
  commandKeys = new Map<string, { fingerprint: string; command: Command }>();
  activeTaskCount = 0;
  activeCommandCount = 0;
  machine: MachineAuthority | null;
  policy: AutonomyPolicy | null;

  constructor(overrides: {
    localPolicy?: Partial<LocalPolicy>;
    policy?: AutonomyPolicy | null;
  } = {}) {
    this.machine = {
      organizationId,
      machineId,
      clientProfileId: "profile-a",
      operatingSystemUser: "odyshell",
      online: true,
      localPolicy: {
        organizationId,
        maxTaskDurationSeconds: 3_600,
        maxConcurrentTasks: 1,
        maxConcurrentCommands: 2,
        maxCommandTimeoutSeconds: 600,
        maxCommandOutputBytes: 1024 * 1024,
        allowRemoteApproval: true,
        ...overrides.localPolicy,
      },
    };
    this.policy = overrides.policy === undefined ? {
      organizationId,
      agentId,
      machineId,
      maxTaskDurationSeconds: 3_600,
      maxConcurrentTasks: 1,
      maxConcurrentCommands: 2,
      expiresAt: now + 60_000,
    } : overrides.policy;
  }

  async machineAuthority(org: string, id: string) {
    return org === organizationId && id === machineId ? this.machine : null;
  }
  async autonomyPolicy() { return this.policy; }
  async countActiveTasks() { return this.activeTaskCount; }
  async countActiveCommands() { return this.activeCommandCount; }
  async taskByIdempotency(org: string, agent: string, key: string) {
    const existing = this.taskKeys.get(key);
    return existing && existing.task.organizationId === org && existing.task.agentId === agent
      ? { task: existing.task, requestFingerprint: existing.fingerprint }
      : null;
  }
  async commandByIdempotency(org: string, taskId: string, key: string) {
    const existing = this.commandKeys.get(`${taskId}:${key}`);
    return existing && existing.command.organizationId === org
      ? { command: existing.command, requestFingerprint: existing.fingerprint }
      : null;
  }
  async task(org: string, id: string) {
    const task = this.tasks.get(id);
    return task?.organizationId === org ? task : null;
  }
  async command(org: string, id: string) {
    const command = this.commands.get(id);
    return command?.organizationId === org ? command : null;
  }
  async commandOutput() { return []; }
  async decideTask(input: Parameters<TaskRepository["decideTask"]>[0]) {
    const task = this.tasks.get(input.taskId);
    if (!task || task.organizationId !== input.organizationId) {
      return { status: "not_found" as const };
    }
    if (
      input.decision === "approve" &&
      (task.status === "opening" || task.status === "active")
    ) {
      return { status: "approved" as const, task, changed: false };
    }
    if (task.status !== "pending_approval") return { status: "conflict" as const };
    if (Date.parse(task.expiresAt) <= now) {
      this.tasks.set(task.id, {
        ...task,
        status: "expired",
        finishedAt: new Date(now).toISOString(),
      });
      return { status: "conflict" as const };
    }
    const updated: Task = {
      ...task,
      status: input.decision === "approve" ? "opening" : "cancelled",
      finishedAt: input.decision === "deny" ? new Date(now).toISOString() : null,
    };
    this.tasks.set(task.id, updated);
    return {
      status: input.decision === "approve" ? "approved" as const : "denied" as const,
      task: updated,
      changed: true,
    };
  }
  async finishTask(input: Parameters<TaskRepository["finishTask"]>[0]) {
    const task = this.tasks.get(input.taskId);
    if (!task || task.organizationId !== input.organizationId || task.agentId !== input.agentId) {
      return { status: "not_found" as const };
    }
    const commandIds = [...this.commands.values()]
      .filter((command) => command.taskId === task.id && ["queued", "delivered", "running", "cancellation_requested"].includes(command.status))
      .map((command) => command.id);
    if (input.outcome === "complete" && commandIds.length > 0) {
      return { status: "commands_active" as const };
    }
    const updated = {
      ...task,
      status: input.outcome === "complete" ? "completed" as const : "cancellation_requested" as const,
    };
    this.tasks.set(task.id, updated);
    return { status: "finished" as const, task: updated, commandIds };
  }
  async requestCommandCancellation(input: Parameters<TaskRepository["requestCommandCancellation"]>[0]) {
    const command = this.commands.get(input.commandId);
    if (!command || command.organizationId !== input.organizationId || command.agentId !== input.agentId) {
      return null;
    }
    const updated = { ...command, status: "cancellation_requested" as const };
    this.commands.set(command.id, updated);
    return updated;
  }
  async createTask(input: Parameters<TaskRepository["createTask"]>[0]) {
    const existing = this.taskKeys.get(input.idempotencyKeyHash);
    if (existing) return existing.fingerprint === input.requestFingerprint
      ? { status: "replayed" as const, task: existing.task }
      : { status: "idempotency_conflict" as const };
    this.tasks.set(input.task.id, input.task);
    this.taskKeys.set(input.idempotencyKeyHash, {
      fingerprint: input.requestFingerprint,
      task: input.task,
    });
    return { status: "created" as const, task: input.task };
  }
  async createCommand(input: Parameters<TaskRepository["createCommand"]>[0]) {
    const key = `${input.command.taskId}:${input.idempotencyKeyHash}`;
    const existing = this.commandKeys.get(key);
    if (existing) return existing.fingerprint === input.requestFingerprint
      ? { status: "replayed" as const, command: existing.command }
      : { status: "idempotency_conflict" as const };
    this.commands.set(input.command.id, input.command);
    this.commandKeys.set(key, {
      fingerprint: input.requestFingerprint,
      command: input.command,
    });
    return { status: "created" as const, command: input.command };
  }
}

function harness(
  repository = new MemoryRepository(),
  options: { taskDeliveryUnavailable?: boolean } = {},
) {
  const opened: Task[] = [];
  const started: Command[] = [];
  const events: Parameters<TaskAudit["append"]>[0][] = [];
  const closed: Task[] = [];
  const cancelled: Command[] = [];
  const client: TaskClient = {
    async openTask(task) {
      if (options.taskDeliveryUnavailable) throw new TaskClientUnavailableError();
      opened.push(task);
    },
    async startCommand(command) { started.push(command); },
    async closeTask(task) { closed.push(task); },
    async cancelCommand(command) { cancelled.push(command); },
  };
  const audit: TaskAudit = { async append(event) { events.push(event); } };
  return {
    repository,
    opened,
    started,
    events,
    closed,
    cancelled,
    service: new TaskService(repository, client, audit, () => now),
  };
}

const request = {
  machineId,
  title: "Repair API",
  durationSeconds: 600,
};

describe("TaskService", () => {
  it("opens an autonomous one-Machine Task and audits its complete authority binding", async () => {
    const { service, opened, events } = harness();
    const result = await service.requestTask({ organizationId, agentId }, request, "task-key");

    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    expect(result.task).toMatchObject({
      organizationId,
      agentId,
      machineId,
      clientProfileId: "profile-a",
      operatingSystemUser: "odyshell",
      status: "opening",
    });
    expect(opened).toEqual([result.task]);
    expect(events[0]).toMatchObject({
      type: "task.requested",
      metadata: { machineId, operatingSystemUser: "odyshell", autonomous: true },
    });
  });

  it("creates a pending approval without contacting the Client", async () => {
    const { service, opened } = harness(new MemoryRepository({ policy: null }));
    const result = await service.requestTask({ organizationId, agentId }, request, "task-key");
    expect(result.status === "created" && result.task.status).toBe("pending_approval");
    expect(opened).toEqual([]);
  });

  it("binds an Agent to a Machine only in the requested Task", async () => {
    const { service } = harness(new MemoryRepository({ policy: null }));
    const result = await service.requestTask(
      { organizationId, agentId: "agent-b" },
      request,
      "agent-b-task-key",
    );

    expect(result).toMatchObject({
      status: "created",
      task: { organizationId, agentId: "agent-b", machineId, status: "pending_approval" },
    });
  });

  it("fails closed when neither autonomous nor Human supervision is allowed", async () => {
    const repository = new MemoryRepository({
      policy: null,
      localPolicy: { allowRemoteApproval: false },
    });
    expect(await harness(repository).service.requestTask(
      { organizationId, agentId },
      request,
      "task-key",
    )).toEqual({ status: "denied", code: "supervision_denied" });
  });

  it("lets a Supervisor approve pending authority and audits the human decision", async () => {
    const context = harness(new MemoryRepository({ policy: null }));
    const requested = await context.service.requestTask(
      { organizationId, agentId },
      request,
      "task-key",
    );
    if (requested.status !== "created") throw new Error("Task was not created");

    expect(await context.service.superviseTask(
      { organizationId, humanId: "human-a", role: "supervisor" },
      requested.task.id,
      "approve",
    )).toMatchObject({
      status: "approved",
      task: { id: requested.task.id, status: "opening" },
      delivery: "sent",
    });
    expect(context.opened).toEqual([
      expect.objectContaining({ id: requested.task.id, status: "opening" }),
    ]);
    expect(context.events.at(-1)).toMatchObject({
      type: "task.approved",
      metadata: { humanId: "human-a", role: "supervisor" },
    });
  });

  it("keeps an approved Task resumable when its Client disconnects during delivery", async () => {
    const context = harness(
      new MemoryRepository({ policy: null }),
      { taskDeliveryUnavailable: true },
    );
    const requested = await context.service.requestTask(
      { organizationId, agentId },
      request,
      "task-key",
    );
    if (requested.status !== "created") throw new Error("Task was not created");
    expect(await context.service.superviseTask(
      { organizationId, humanId: "human-a", role: "supervisor" },
      requested.task.id,
      "approve",
    )).toMatchObject({
      status: "approved",
      delivery: "pending",
      task: { status: "opening" },
    });
  });

  it("binds supervision to the Organization and denial never contacts the Client", async () => {
    const context = harness(new MemoryRepository({ policy: null }));
    const requested = await context.service.requestTask(
      { organizationId, agentId },
      request,
      "task-key",
    );
    if (requested.status !== "created") throw new Error("Task was not created");

    expect(await context.service.superviseTask(
      { organizationId: "org-b", humanId: "human-b", role: "owner" },
      requested.task.id,
      "approve",
    )).toEqual({ status: "denied_request", code: "task_not_found" });
    expect(await context.service.superviseTask(
      { organizationId, humanId: "human-a", role: "admin" },
      requested.task.id,
      "deny",
    )).toMatchObject({ status: "denied", task: { status: "cancelled" } });
    expect(context.opened).toEqual([]);
    expect(context.events.at(-1)).toMatchObject({
      type: "task.denied",
      metadata: { humanId: "human-a", role: "admin" },
    });
  });

  it("fails closed when human approval arrives after Task expiry", async () => {
    const context = harness(new MemoryRepository({ policy: null }));
    const requested = await context.service.requestTask(
      { organizationId, agentId },
      request,
      "task-key",
    );
    if (requested.status !== "created") throw new Error("Task was not created");
    context.repository.tasks.set(requested.task.id, {
      ...requested.task,
      expiresAt: new Date(now - 1).toISOString(),
    });
    expect(await context.service.superviseTask(
      { organizationId, humanId: "human-a", role: "supervisor" },
      requested.task.id,
      "approve",
    )).toEqual({ status: "denied_request", code: "task_already_decided" });
    expect(context.repository.tasks.get(requested.task.id)).toMatchObject({
      status: "expired",
    });
    expect(context.opened).toEqual([]);
  });

  it.each([
    [new MemoryRepository({ localPolicy: { organizationId: "org-b" } }), "organization_denied"],
    [new MemoryRepository({ localPolicy: { maxTaskDurationSeconds: 300 } }), "duration_denied"],
  ] as const)("fails closed at the Local Policy ceiling", async (repository, code) => {
    const result = await harness(repository).service.requestTask(
      { organizationId, agentId },
      request,
      "task-key",
    );
    expect(result).toEqual({ status: "denied", code });
  });

  it("replays the same Task mutation and rejects a changed payload", async () => {
    const { service, repository } = harness();
    const first = await service.requestTask({ organizationId, agentId }, request, "task-key");
    repository.activeTaskCount = 1;
    const replay = await service.requestTask({ organizationId, agentId }, request, "task-key");
    const conflict = await service.requestTask(
      { organizationId, agentId },
      { ...request, title: "Different" },
      "task-key",
    );
    expect(replay.status).toBe("replayed");
    expect(replay.status === "replayed" && first.status === "created" && replay.task.id)
      .toBe(first.status === "created" && first.task.id);
    expect(conflict).toEqual({ status: "denied", code: "idempotency_conflict" });
  });

  it("dispatches an exact Command without env or stdin and records exact command audit", async () => {
    const context = harness();
    const taskResult = await context.service.requestTask(
      { organizationId, agentId },
      request,
      "task-key",
    );
    if (taskResult.status !== "created") throw new Error("Task was not created");
    context.repository.tasks.set(taskResult.task.id, {
      ...taskResult.task,
      status: "active",
    });
    const result = await context.service.createCommand(
      { organizationId, agentId },
      taskResult.task.id,
      { command: "systemctl restart api", cwd: "/srv/api", timeoutSeconds: 30 },
      "command-key",
    );

    expect(result.status).toBe("created");
    expect(context.started[0]).toMatchObject({
      command: "systemctl restart api",
      cwd: "/srv/api",
      timeoutSeconds: 30,
    });
    expect(context.events.at(-1)).toMatchObject({
      type: "command.created",
      metadata: { command: "systemctl restart api", cwd: "/srv/api" },
    });
  });

  it("denies another Agent and an expired Task before dispatch", async () => {
    const context = harness();
    const taskResult = await context.service.requestTask(
      { organizationId, agentId }, request, "task-key",
    );
    if (taskResult.status !== "created") throw new Error("Task was not created");
    context.repository.tasks.set(taskResult.task.id, { ...taskResult.task, status: "active" });

    expect(await context.service.createCommand(
      { organizationId, agentId: "agent-b" },
      taskResult.task.id,
      { command: "whoami", timeoutSeconds: 30 },
      "command-key-a",
    )).toEqual({ status: "denied", code: "task_agent_denied" });
    context.repository.tasks.set(taskResult.task.id, {
      ...taskResult.task,
      status: "active",
      expiresAt: new Date(now - 1).toISOString(),
    });
    expect(await context.service.createCommand(
      { organizationId, agentId },
      taskResult.task.id,
      { command: "whoami", timeoutSeconds: 30 },
      "command-key-b",
    )).toEqual({ status: "denied", code: "task_expired" });
    expect(context.started).toEqual([]);
  });

  it("cancels active Commands before closing their Task authority", async () => {
    const context = harness();
    const taskResult = await context.service.requestTask(
      { organizationId, agentId }, request, "task-key",
    );
    if (taskResult.status !== "created") throw new Error("Task was not created");
    context.repository.tasks.set(taskResult.task.id, { ...taskResult.task, status: "active" });
    const commandResult = await context.service.createCommand(
      { organizationId, agentId },
      taskResult.task.id,
      { command: "sleep 60", timeoutSeconds: 60 },
      "command-key",
    );
    if (commandResult.status !== "created") throw new Error("Command was not created");

    expect(await context.service.finishTask(
      { organizationId, agentId },
      taskResult.task.id,
      "complete",
    )).toEqual({ status: "denied", code: "commands_active" });
    expect(await context.service.finishTask(
      { organizationId, agentId },
      taskResult.task.id,
      "cancel",
    )).toMatchObject({ status: "cancellation_requested" });
    expect(context.cancelled).toEqual([
      expect.objectContaining({ id: commandResult.command.id }),
    ]);
    expect(context.closed).toEqual([
      expect.objectContaining({ id: taskResult.task.id }),
    ]);
  });

  it("hides Command cancellation from another Agent", async () => {
    const context = harness();
    expect(await context.service.cancelCommand(
      { organizationId, agentId: "agent-b" },
      randomUUID(),
    )).toEqual({ status: "denied", code: "command_not_found" });
    expect(context.cancelled).toEqual([]);
  });
});
