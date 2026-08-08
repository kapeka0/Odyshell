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
        agentIds: [agentId],
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
  });
});
