import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresSessionDatabase } from "../src/session-database.js";
import { SessionService } from "../src/sessions.js";

const connectionString = process.env.DATABASE_URL;
const suite = connectionString ? describe : describe.skip;

suite("PostgreSQL Session/Command vertical", () => {
  const organizationId = `test-${randomUUID()}`;
  const agentId = `agent-${randomUUID()}`;
  const machineId = randomUUID();
  let database: PostgresSessionDatabase;

  beforeAll(async () => {
    database = new PostgresSessionDatabase(connectionString!);
    await database.initialize();
    await database.putMachineAuthority({
      organizationId,
      machineId,
      clientProfileId: "profile-a",
      operatingSystemUser: "odyshell",
      online: true,
      localPolicy: {
        organizationId,
        maxSessionDurationSeconds: 900,
        maxConcurrentSessions: 1,
        maxConcurrentCommands: 1,
        maxCommandTimeoutSeconds: 60,
        maxCommandOutputBytes: 1024 * 1024,
        allowRemoteApproval: false,
      },
    });
  });

  afterAll(async () => {
    const pool = new pg.Pool({ connectionString });
    await pool.query("delete from odyshell.sessions where organization_id = $1", [organizationId]);
    await pool.query("delete from odyshell.machine_authorities where organization_id = $1", [organizationId]);
    await pool.end();
    await database.close();
  });

  it("persists an idempotent resumable execution without cross-Organization visibility", async () => {
    const service = new SessionService(
      database,
      {
        async openSession() {},
        async startCommand() {},
        async closeSession() {},
        async cancelCommand() {},
      },
      database,
    );
    const created = await service.requestSession(
      { organizationId, agentId, agentRole: "operator" },
      { machineId, title: "Repair API", durationSeconds: 900 },
      "session-key",
    );
    expect(created.status).toBe("created");
    if (created.status !== "created") return;
    expect(await database.session("another-org", created.session.id)).toBeNull();
    expect(await database.markSessionOpened({
      organizationId,
      machineId,
      sessionId: created.session.id,
      clientProfileId: "profile-a",
      operatingSystemUser: "odyshell",
    })).toMatchObject({ status: "active" });

    const command = await service.createCommand(
      { organizationId, agentId, agentRole: "operator" },
      created.session.id,
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
      sessions: [{ id: created.session.id, status: "active" }],
      commands: [{ id: command.command.id, status: "running" }],
    });
    expect(await database.reconnectState("another-org", machineId)).toEqual({
      sessions: [],
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
    expect(await service.finishSession(
      { organizationId, agentId, agentRole: "operator" },
      created.session.id,
      "complete",
    )).toMatchObject({ status: "completed" });
    const audit = await database.listAuditEvents(organizationId);
    expect(audit).toEqual(expect.arrayContaining([
      expect.objectContaining({
        agentId,
        sessionId: created.session.id,
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
    const service = new SessionService(
      database,
      {
        async openSession() {},
        async startCommand() {},
        async closeSession() {},
        async cancelCommand() {},
      },
      database,
      () => Date.parse("2026-08-08T20:00:00.000Z"),
    );
    const created = await service.requestSession(
      { organizationId, agentId, agentRole: "operator" },
      { machineId, title: "Expire safely", durationSeconds: 900 },
      "expiry-session-key",
    );
    expect(created.status).toBe("created");
    if (created.status !== "created") return;
    await database.markSessionOpened({
      organizationId,
      machineId,
      sessionId: created.session.id,
      clientProfileId: "profile-a",
      operatingSystemUser: "odyshell",
    });
    const command = await service.createCommand(
      { organizationId, agentId, agentRole: "operator" },
      created.session.id,
      { command: "sleep 30", timeoutSeconds: 30 },
      "expiry-command-key",
    );
    expect(command.status).toBe("created");
    if (command.status !== "created") return;

    const expired = await database.expireSessions(Date.parse("2026-08-08T20:15:01.000Z"));
    expect(expired).toMatchObject([{
      session: { id: created.session.id, status: "cancellation_requested" },
      commandIds: [command.command.id],
    }]);
    expect(await database.reconnectState(organizationId, machineId)).toMatchObject({
      sessions: [{ id: created.session.id, status: "cancellation_requested" }],
      commands: [{ id: command.command.id, status: "cancellation_requested" }],
    });
    expect(await database.markSessionClosed(
      organizationId,
      machineId,
      created.session.id,
      "expired",
    )).toBe(true);
    expect(await database.session(organizationId, created.session.id)).toMatchObject({
      status: "expired",
    });
  });

  it("atomically binds human approval and denial to one Organization", async () => {
    const opened: string[] = [];
    let supervisionNow = Date.now();
    await database.putMachineAuthority({
      organizationId,
      machineId,
      clientProfileId: "profile-a",
      operatingSystemUser: "odyshell",
      online: true,
      localPolicy: {
        organizationId,
        maxSessionDurationSeconds: 900,
        maxConcurrentSessions: 1,
        maxConcurrentCommands: 1,
        maxCommandTimeoutSeconds: 60,
        maxCommandOutputBytes: 1024 * 1024,
        allowRemoteApproval: true,
      },
    });
    const service = new SessionService(
      database,
      {
        async openSession(session) { opened.push(session.id); },
        async startCommand() {},
        async closeSession() {},
        async cancelCommand() {},
      },
      database,
      () => supervisionNow,
    );
    const requested = await service.requestSession(
      { organizationId, agentId, agentRole: "standard" },
      { machineId, title: "Approve safely", durationSeconds: 900 },
      "supervision-session-key",
    );
    expect(requested).toMatchObject({
      status: "created",
      session: { status: "pending_approval" },
    });
    if (requested.status !== "created") return;
    supervisionNow += 30_000;
    expect(await service.superviseSession(
      { organizationId: "another-org", humanId: "human-b", role: "owner" },
      requested.session.id,
      "approve",
    )).toEqual({ status: "denied_request", code: "session_not_found" });
    const approved = await service.superviseSession(
      { organizationId, humanId: "human-a", role: "supervisor" },
      requested.session.id,
      "approve",
    );
    expect(approved).toMatchObject({ status: "approved", delivery: "sent", session: { status: "opening" } });
    if (approved.status === "approved") {
      expect(Date.parse(approved.session.expiresAt)).toBe(supervisionNow + 900_000);
    }
    expect(opened).toEqual([requested.session.id]);
    await database.markSessionOpened({
      organizationId,
      machineId,
      sessionId: requested.session.id,
      clientProfileId: "profile-a",
      operatingSystemUser: "odyshell",
    });
    await service.finishSession({ organizationId, agentId, agentRole: "operator" }, requested.session.id, "complete");

    const deniedSession = await service.requestSession(
      { organizationId, agentId, agentRole: "standard" },
      { machineId, title: "Deny safely", durationSeconds: 900 },
      "denial-session-key",
    );
    if (deniedSession.status !== "created") throw new Error("Session was not created");
    expect(await service.superviseSession(
      { organizationId, humanId: "human-a", role: "admin" },
      deniedSession.session.id,
      "deny",
    )).toMatchObject({ status: "denied", session: { status: "cancelled" } });
    expect(await database.listSessions(organizationId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: requested.session.id, status: "completed" }),
        expect.objectContaining({ id: deniedSession.session.id, status: "cancelled" }),
      ]),
    );

    const abandoned = await service.requestSession(
      { organizationId, agentId, agentRole: "standard" },
      { machineId, title: "Expire pending approval", durationSeconds: 900 },
      "abandoned-session-key",
    );
    if (abandoned.status !== "created") throw new Error("Session was not created");
    expect(abandoned.session.status).toBe("pending_approval");
    expect(await database.expireSessions(supervisionNow + 901_000)).toEqual([]);
    expect(await database.session(organizationId, abandoned.session.id)).toMatchObject({
      status: "expired",
    });
  });

  it("revokes Agent Sessions and Commands without crossing Organization boundaries", async () => {
    const service = new SessionService(
      database,
      {
        async openSession() {},
        async startCommand() {},
        async closeSession() {},
        async cancelCommand() {},
      },
      database,
    );
    const created = await service.requestSession(
      { organizationId, agentId, agentRole: "operator" },
      { machineId, title: "Revoke compromised Agent", durationSeconds: 900 },
      "revocation-session-key",
    );
    if (created.status !== "created") throw new Error("Session was not created");
    await database.markSessionOpened({
      organizationId,
      machineId,
      sessionId: created.session.id,
      clientProfileId: "profile-a",
      operatingSystemUser: "odyshell",
    });
    const command = await service.createCommand(
      { organizationId, agentId, agentRole: "operator" },
      created.session.id,
      { command: "sleep 30", timeoutSeconds: 30 },
      "revocation-command-key",
    );
    if (command.status !== "created") throw new Error("Command was not created");

    await expect(database.revokeSessions({
      organizationId,
    })).rejects.toThrow("requires an Agent or Machine scope");
    expect(await database.revokeSessions({
      organizationId: "another-org",
      agentId,
    })).toEqual([]);
    expect(await database.session(organizationId, created.session.id)).toMatchObject({
      status: "active",
    });

    expect(await database.revokeSessions({ organizationId, agentId })).toMatchObject([{
      session: { id: created.session.id, status: "revoked" },
      commandIds: [command.command.id],
    }]);
    expect(await database.command(organizationId, command.command.id)).toMatchObject({
      status: "cancellation_requested",
    });
    expect(await database.machineAuthority(organizationId, machineId)).not.toBeNull();
  });
});
