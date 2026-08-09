import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresTaskDatabase } from "../src/task-database.js";
import { TaskService } from "../src/tasks.js";

const connectionString = process.env.DATABASE_URL;
const suite = connectionString ? describe : describe.skip;

suite("PostgreSQL Task/Command vertical", () => {
  const organizationId = `test-${randomUUID()}`;
  const agentId = `agent-${randomUUID()}`;
  const machineId = randomUUID();
  let database: PostgresTaskDatabase;

  beforeAll(async () => {
    database = new PostgresTaskDatabase(connectionString!);
    await database.initialize();
    await database.putMachineAuthority({
      organizationId,
      machineId,
      clientProfileId: "profile-a",
      operatingSystemUser: "odyshell",
      online: true,
      localPolicy: {
        organizationId,
        maxTaskDurationSeconds: 600,
        maxConcurrentTasks: 1,
        maxConcurrentCommands: 1,
        maxCommandTimeoutSeconds: 60,
        maxCommandOutputBytes: 1024 * 1024,
        allowRemoteApproval: false,
      },
    });
    await database.putAutonomyPolicy({
      organizationId,
      agentId,
      machineId,
      maxTaskDurationSeconds: 600,
      maxConcurrentTasks: 1,
      maxConcurrentCommands: 1,
      expiresAt: Date.now() + 60_000,
    });
  });

  afterAll(async () => {
    const pool = new pg.Pool({ connectionString });
    await pool.query("delete from odyshell.tasks where organization_id = $1", [organizationId]);
    await pool.query("delete from odyshell.autonomy_policies where organization_id = $1", [organizationId]);
    await pool.query("delete from odyshell.machine_authorities where organization_id = $1", [organizationId]);
    await pool.end();
    await database.close();
  });

  it("persists an idempotent resumable execution without cross-Organization visibility", async () => {
    const service = new TaskService(
      database,
      {
        async openTask() {},
        async startCommand() {},
        async closeTask() {},
        async cancelCommand() {},
      },
      database,
    );
    const created = await service.requestTask(
      { organizationId, agentId },
      { machineId, title: "Repair API", durationSeconds: 300 },
      "task-key",
    );
    expect(created.status).toBe("created");
    if (created.status !== "created") return;
    expect(await database.task("another-org", created.task.id)).toBeNull();
    expect(await database.markTaskOpened({
      organizationId,
      machineId,
      taskId: created.task.id,
      clientProfileId: "profile-a",
      operatingSystemUser: "odyshell",
    })).toMatchObject({ status: "active" });

    const command = await service.createCommand(
      { organizationId, agentId },
      created.task.id,
      { command: "whoami", timeoutSeconds: 30 },
      "command-key",
    );
    expect(command.status).toBe("created");
    if (command.status !== "created") return;
    await database.markCommandStarted(
      organizationId,
      machineId,
      command.command.id,
      new Date().toISOString(),
    );
    expect(await database.reconnectState(organizationId, machineId)).toMatchObject({
      tasks: [{ id: created.task.id, status: "active" }],
      commands: [{ id: command.command.id, status: "running" }],
    });
    expect(await database.reconnectState("another-org", machineId)).toEqual({
      tasks: [],
      commands: [],
    });
    const chunk = Buffer.from("odyshell\n");
    for (let replay = 0; replay < 2; replay += 1) {
      expect(await database.addCommandOutput({
        organizationId,
        machineId,
        commandId: command.command.id,
        sequence: 0,
        stream: "stdout",
        data: chunk,
      })).toBe(true);
    }
    const completed = await database.markCommandCompleted({
      organizationId,
      machineId,
      commandId: command.command.id,
      status: "succeeded",
      exitCode: 0,
      outputTruncated: false,
      finishedAt: new Date().toISOString(),
    });
    expect(completed).toMatchObject({ stdoutBytes: chunk.length, status: "succeeded" });
    expect(await database.commandOutput(organizationId, command.command.id, -1)).toEqual([{
      sequence: 0,
      stream: "stdout",
      dataBase64: chunk.toString("base64"),
    }]);
    expect(await database.command("another-org", command.command.id)).toBeNull();
    expect(await service.finishTask(
      { organizationId, agentId },
      created.task.id,
      "complete",
    )).toMatchObject({ status: "completed" });
    const audit = await database.listAuditEvents(organizationId);
    expect(audit).toEqual(expect.arrayContaining([
      expect.objectContaining({
        agentId,
        taskId: created.task.id,
        commandId: command.command.id,
        type: "command.created",
        metadata: expect.objectContaining({ command: "whoami", timeoutSeconds: 30 }),
      }),
      expect.objectContaining({
        commandId: command.command.id,
        type: "command.completed",
        metadata: expect.objectContaining({ outcome: "succeeded", exitCode: 0 }),
      }),
    ]));
    expect(JSON.stringify(audit)).not.toContain(chunk.toString("base64"));
    expect(await database.listAuditEvents("another-org")).toEqual([]);
  });

  it("keeps expired authority pending until the Client confirms local closure", async () => {
    const service = new TaskService(
      database,
      {
        async openTask() {},
        async startCommand() {},
        async closeTask() {},
        async cancelCommand() {},
      },
      database,
      () => Date.parse("2026-08-08T20:00:00.000Z"),
    );
    await database.putAutonomyPolicy({
      organizationId,
      agentId,
      machineId,
      maxTaskDurationSeconds: 600,
      maxConcurrentTasks: 1,
      maxConcurrentCommands: 1,
      expiresAt: Date.parse("2026-08-08T20:05:00.000Z"),
    });
    const created = await service.requestTask(
      { organizationId, agentId },
      { machineId, title: "Expire safely", durationSeconds: 60 },
      "expiry-task-key",
    );
    expect(created.status).toBe("created");
    if (created.status !== "created") return;
    await database.markTaskOpened({
      organizationId,
      machineId,
      taskId: created.task.id,
      clientProfileId: "profile-a",
      operatingSystemUser: "odyshell",
    });
    const command = await service.createCommand(
      { organizationId, agentId },
      created.task.id,
      { command: "sleep 30", timeoutSeconds: 30 },
      "expiry-command-key",
    );
    expect(command.status).toBe("created");
    if (command.status !== "created") return;

    const expired = await database.expireTasks(Date.parse("2026-08-08T20:01:01.000Z"));
    expect(expired).toMatchObject([{
      task: { id: created.task.id, status: "cancellation_requested" },
      commandIds: [command.command.id],
    }]);
    expect(await database.reconnectState(organizationId, machineId)).toMatchObject({
      tasks: [{ id: created.task.id, status: "cancellation_requested" }],
      commands: [{ id: command.command.id, status: "cancellation_requested" }],
    });
    expect(await database.markTaskClosed(
      organizationId,
      machineId,
      created.task.id,
      "expired",
    )).toBe(true);
    expect(await database.task(organizationId, created.task.id)).toMatchObject({
      status: "expired",
    });
  });

  it("atomically binds human approval and denial to one Organization", async () => {
    const opened: string[] = [];
    const supervisionNow = Date.now();
    await database.putMachineAuthority({
      organizationId,
      machineId,
      clientProfileId: "profile-a",
      operatingSystemUser: "odyshell",
      online: true,
      localPolicy: {
        organizationId,
        maxTaskDurationSeconds: 600,
        maxConcurrentTasks: 1,
        maxConcurrentCommands: 1,
        maxCommandTimeoutSeconds: 60,
        maxCommandOutputBytes: 1024 * 1024,
        allowRemoteApproval: true,
      },
    });
    const service = new TaskService(
      database,
      {
        async openTask(task) { opened.push(task.id); },
        async startCommand() {},
        async closeTask() {},
        async cancelCommand() {},
      },
      database,
      () => supervisionNow,
    );
    const requested = await service.requestTask(
      { organizationId, agentId },
      { machineId, title: "Approve safely", durationSeconds: 60 },
      "supervision-task-key",
    );
    expect(requested).toMatchObject({
      status: "created",
      task: { status: "pending_approval" },
    });
    if (requested.status !== "created") return;
    expect(await service.superviseTask(
      { organizationId: "another-org", humanId: "human-b", role: "owner" },
      requested.task.id,
      "approve",
    )).toEqual({ status: "denied_request", code: "task_not_found" });
    expect(await service.superviseTask(
      { organizationId, humanId: "human-a", role: "supervisor" },
      requested.task.id,
      "approve",
    )).toMatchObject({ status: "approved", delivery: "sent", task: { status: "opening" } });
    expect(opened).toEqual([requested.task.id]);
    await database.markTaskOpened({
      organizationId,
      machineId,
      taskId: requested.task.id,
      clientProfileId: "profile-a",
      operatingSystemUser: "odyshell",
    });
    await service.finishTask({ organizationId, agentId }, requested.task.id, "complete");

    const deniedTask = await service.requestTask(
      { organizationId, agentId },
      { machineId, title: "Deny safely", durationSeconds: 60 },
      "denial-task-key",
    );
    if (deniedTask.status !== "created") throw new Error("Task was not created");
    expect(await service.superviseTask(
      { organizationId, humanId: "human-a", role: "admin" },
      deniedTask.task.id,
      "deny",
    )).toMatchObject({ status: "denied", task: { status: "cancelled" } });
    expect(await database.listTasks(organizationId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: requested.task.id, status: "completed" }),
        expect.objectContaining({ id: deniedTask.task.id, status: "cancelled" }),
      ]),
    );

    const abandoned = await service.requestTask(
      { organizationId, agentId },
      { machineId, title: "Expire pending approval", durationSeconds: 60 },
      "abandoned-task-key",
    );
    if (abandoned.status !== "created") throw new Error("Task was not created");
    expect(abandoned.task.status).toBe("pending_approval");
    expect(await database.expireTasks(supervisionNow + 61_000)).toEqual([]);
    expect(await database.task(organizationId, abandoned.task.id)).toMatchObject({
      status: "expired",
    });
  });

  it("revokes Agent Tasks and Commands without crossing Organization boundaries", async () => {
    await database.putAutonomyPolicy({
      organizationId,
      agentId,
      machineId,
      maxTaskDurationSeconds: 600,
      maxConcurrentTasks: 1,
      maxConcurrentCommands: 1,
      expiresAt: Date.now() + 60_000,
    });
    const service = new TaskService(
      database,
      {
        async openTask() {},
        async startCommand() {},
        async closeTask() {},
        async cancelCommand() {},
      },
      database,
    );
    const created = await service.requestTask(
      { organizationId, agentId },
      { machineId, title: "Revoke compromised Agent", durationSeconds: 300 },
      "revocation-task-key",
    );
    if (created.status !== "created") throw new Error("Task was not created");
    await database.markTaskOpened({
      organizationId,
      machineId,
      taskId: created.task.id,
      clientProfileId: "profile-a",
      operatingSystemUser: "odyshell",
    });
    const command = await service.createCommand(
      { organizationId, agentId },
      created.task.id,
      { command: "sleep 30", timeoutSeconds: 30 },
      "revocation-command-key",
    );
    if (command.status !== "created") throw new Error("Command was not created");

    await expect(database.revokeTasks({
      organizationId,
    })).rejects.toThrow("requires an Agent or Machine scope");
    expect(await database.revokeTasks({
      organizationId: "another-org",
      agentId,
    })).toEqual([]);
    expect(await database.task(organizationId, created.task.id)).toMatchObject({
      status: "active",
    });

    expect(await database.revokeTasks({ organizationId, agentId })).toMatchObject([{
      task: { id: created.task.id, status: "revoked" },
      commandIds: [command.command.id],
    }]);
    expect(await database.command(organizationId, command.command.id)).toMatchObject({
      status: "cancellation_requested",
    });
    expect(await database.autonomyPolicy(organizationId, agentId, machineId)).toBeNull();
    expect(await database.machineAuthority(organizationId, machineId)).not.toBeNull();
  });
});
