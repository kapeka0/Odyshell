import type { Command, Session } from "@odyshell/protocol";
import { describe, expect, it } from "vitest";
import { sessionReconnectMessages } from "../apps/server/src/session-reconciliation.js";

const now = new Date("2026-08-08T20:00:00.000Z");

describe("Session reconnect reconciliation", () => {
  it("reopens authority before replaying an asynchronous Command", () => {
    const session = sessionRecord({ status: "active" });
    const command = commandRecord({ sessionId: session.id, status: "running" });

    expect(sessionReconnectMessages({ sessions: [session], commands: [command] }, now)).toEqual([
      expect.objectContaining({ type: "session.open", sessionId: session.id }),
      {
        type: "command.start",
        commandId: command.id,
        sessionId: session.id,
        command: "systemctl restart api",
        cwd: "/srv/api",
        timeoutSeconds: 30,
        maxOutputBytes: 1024 * 1024,
      },
    ]);
  });

  it("cancels Commands before closing expired local authority", () => {
    const session = sessionRecord({
      status: "cancellation_requested",
      expiresAt: "2026-08-08T19:59:00.000Z",
    });
    const command = commandRecord({
      sessionId: session.id,
      status: "cancellation_requested",
    });

    expect(sessionReconnectMessages({ sessions: [session], commands: [command] }, now)).toEqual([
      { type: "command.cancel", commandId: command.id },
      { type: "session.close", sessionId: session.id, reason: "expired" },
    ]);
  });

  it("never restarts a Command after cancellation was requested", () => {
    const session = sessionRecord({ status: "active" });
    const command = commandRecord({
      sessionId: session.id,
      status: "cancellation_requested",
    });

    const messages = sessionReconnectMessages({ sessions: [session], commands: [command] }, now);
    expect(messages).toEqual([
      expect.objectContaining({ type: "session.open", sessionId: session.id }),
      { type: "command.cancel", commandId: command.id },
    ]);
    expect(messages).not.toContainEqual(expect.objectContaining({ type: "command.start" }));
  });
});

function sessionRecord(overrides: Partial<Session>): Session {
  return {
    id: "7a354999-6a6c-42db-9467-e1416da255f1",
    organizationId: "organization-a",
    agentId: "agent-a",
    machineId: "927ea000-a060-4c2b-af0a-22571fc6c002",
    clientProfileId: "profile-a",
    operatingSystemUser: "odyshell",
    title: "Repair API",
    purpose: null,
    status: "active",
    maxConcurrentCommands: 1,
    createdAt: "2026-08-08T19:50:00.000Z",
    readyAt: "2026-08-08T19:50:01.000Z",
    expiresAt: "2026-08-08T20:10:00.000Z",
    finishedAt: null,
    ...overrides,
  };
}

function commandRecord(overrides: Partial<Command>): Command {
  return {
    id: "550e8400-e29b-41d4-a716-446655440000",
    sessionId: "7a354999-6a6c-42db-9467-e1416da255f1",
    organizationId: "organization-a",
    agentId: "agent-a",
    machineId: "927ea000-a060-4c2b-af0a-22571fc6c002",
    command: "systemctl restart api",
    cwd: "/srv/api",
    timeoutSeconds: 30,
    status: "running",
    createdAt: "2026-08-08T19:51:00.000Z",
    startedAt: "2026-08-08T19:51:01.000Z",
    finishedAt: null,
    exitCode: null,
    outputTruncated: false,
    stdoutBytes: 0,
    stderrBytes: 0,
    error: null,
    ...overrides,
  };
}
