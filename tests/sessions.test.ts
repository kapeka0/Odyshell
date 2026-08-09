import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Command, LocalPolicy, Session } from "@odyshell/protocol";
import {
  SessionService,
  SessionClientUnavailableError,
  type MachineAuthority,
  type SessionAudit,
  type SessionClient,
  type SessionRepository,
} from "../apps/server/src/sessions.js";

const organizationId = "org-a";
const agentId = "agent-a";
const machineId = "7a354999-6a6c-42db-9467-e1416da255f1";
const now = Date.parse("2026-08-08T10:00:00.000Z");

class MemoryRepository implements SessionRepository {
  sessions = new Map<string, Session>();
  commands = new Map<string, Command>();
  sessionKeys = new Map<string, { fingerprint: string; session: Session }>();
  commandKeys = new Map<string, { fingerprint: string; command: Command }>();
  activeSessionCount = 0;
  activeCommandCount = 0;
  machine: MachineAuthority | null;

  constructor(overrides: {
    localPolicy?: Partial<LocalPolicy>;
  } = {}) {
    this.machine = {
      organizationId,
      machineId,
      clientProfileId: "profile-a",
      operatingSystemUser: "odyshell",
      online: true,
      localPolicy: {
        organizationId,
        maxSessionDurationSeconds: 3_600,
        maxConcurrentSessions: 1,
        maxConcurrentCommands: 2,
        maxCommandTimeoutSeconds: 600,
        maxCommandOutputBytes: 1024 * 1024,
        allowRemoteApproval: true,
        ...overrides.localPolicy,
      },
    };
  }

  async machineAuthority(org: string, id: string) {
    return org === organizationId && id === machineId ? this.machine : null;
  }
  async countActiveSessions() { return this.activeSessionCount; }
  async countActiveCommands() { return this.activeCommandCount; }
  async sessionByIdempotency(org: string, agent: string, key: string) {
    const existing = this.sessionKeys.get(key);
    return existing && existing.session.organizationId === org && existing.session.agentId === agent
      ? { session: existing.session, requestFingerprint: existing.fingerprint }
      : null;
  }
  async commandByIdempotency(org: string, sessionId: string, key: string) {
    const existing = this.commandKeys.get(`${sessionId}:${key}`);
    return existing && existing.command.organizationId === org
      ? { command: existing.command, requestFingerprint: existing.fingerprint }
      : null;
  }
  async session(org: string, id: string) {
    const session = this.sessions.get(id);
    return session?.organizationId === org ? session : null;
  }
  async command(org: string, id: string) {
    const command = this.commands.get(id);
    return command?.organizationId === org ? command : null;
  }
  async commandOutput() { return []; }
  async decideSession(input: Parameters<SessionRepository["decideSession"]>[0]) {
    const session = this.sessions.get(input.sessionId);
    if (!session || session.organizationId !== input.organizationId) {
      return { status: "not_found" as const };
    }
    if (
      input.decision === "approve" &&
      (session.status === "opening" || session.status === "active")
    ) {
      return { status: "approved" as const, session, changed: false };
    }
    if (session.status !== "pending_approval") return { status: "conflict" as const };
    if (Date.parse(session.expiresAt) <= now) {
      this.sessions.set(session.id, {
        ...session,
        status: "expired",
        finishedAt: new Date(now).toISOString(),
      });
      return { status: "conflict" as const };
    }
    const updated: Session = {
      ...session,
      status: input.decision === "approve" ? "opening" : "cancelled",
      finishedAt: input.decision === "deny" ? new Date(now).toISOString() : null,
    };
    this.sessions.set(session.id, updated);
    return {
      status: input.decision === "approve" ? "approved" as const : "denied" as const,
      session: updated,
      changed: true,
    };
  }
  async finishSession(input: Parameters<SessionRepository["finishSession"]>[0]) {
    const session = this.sessions.get(input.sessionId);
    if (!session || session.organizationId !== input.organizationId || session.agentId !== input.agentId) {
      return { status: "not_found" as const };
    }
    const commandIds = [...this.commands.values()]
      .filter((command) => command.sessionId === session.id && ["queued", "delivered", "running", "cancellation_requested"].includes(command.status))
      .map((command) => command.id);
    if (input.outcome === "complete" && commandIds.length > 0) {
      return { status: "commands_active" as const };
    }
    const updated = {
      ...session,
      status: input.outcome === "complete" ? "completed" as const : "cancellation_requested" as const,
    };
    this.sessions.set(session.id, updated);
    return { status: "finished" as const, session: updated, commandIds };
  }
  async requestCommandCancellation(input: Parameters<SessionRepository["requestCommandCancellation"]>[0]) {
    const command = this.commands.get(input.commandId);
    if (!command || command.organizationId !== input.organizationId || command.agentId !== input.agentId) {
      return null;
    }
    const updated = { ...command, status: "cancellation_requested" as const };
    this.commands.set(command.id, updated);
    return updated;
  }
  async createSession(input: Parameters<SessionRepository["createSession"]>[0]) {
    const existing = this.sessionKeys.get(input.idempotencyKeyHash);
    if (existing) return existing.fingerprint === input.requestFingerprint
      ? { status: "replayed" as const, session: existing.session }
      : { status: "idempotency_conflict" as const };
    this.sessions.set(input.session.id, input.session);
    this.sessionKeys.set(input.idempotencyKeyHash, {
      fingerprint: input.requestFingerprint,
      session: input.session,
    });
    return { status: "created" as const, session: input.session };
  }
  async createCommand(input: Parameters<SessionRepository["createCommand"]>[0]) {
    const key = `${input.command.sessionId}:${input.idempotencyKeyHash}`;
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
  options: { sessionDeliveryUnavailable?: boolean } = {},
) {
  const opened: Session[] = [];
  const started: Command[] = [];
  const events: Parameters<SessionAudit["append"]>[0][] = [];
  const closed: Session[] = [];
  const cancelled: Command[] = [];
  const client: SessionClient = {
    async openSession(session) {
      if (options.sessionDeliveryUnavailable) throw new SessionClientUnavailableError();
      opened.push(session);
    },
    async startCommand(command) { started.push(command); },
    async closeSession(session) { closed.push(session); },
    async cancelCommand(command) { cancelled.push(command); },
  };
  const audit: SessionAudit = { async append(event) { events.push(event); } };
  return {
    repository,
    opened,
    started,
    events,
    closed,
    cancelled,
    service: new SessionService(repository, client, audit, () => now),
  };
}

const request = {
  machineId,
  title: "Repair API",
  durationSeconds: 900,
};

describe("SessionService", () => {
  it("lets an Operator open a one-Machine Session and audits its complete authority binding", async () => {
    const { service, opened, events } = harness();
    const result = await service.requestSession({ organizationId, agentId, agentRole: "operator" }, request, "session-key");

    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    expect(result.session).toMatchObject({
      organizationId,
      agentId,
      machineId,
      clientProfileId: "profile-a",
      operatingSystemUser: "odyshell",
      status: "opening",
    });
    expect(opened).toEqual([result.session]);
    expect(events[0]).toMatchObject({
      type: "session.requested",
      metadata: {
        machineId,
        operatingSystemUser: "odyshell",
        agentRole: "operator",
        approval: "operator",
      },
    });
  });

  it("creates a pending approval without contacting the Client", async () => {
    const { service, opened } = harness();
    const result = await service.requestSession({ organizationId, agentId, agentRole: "standard" }, request, "session-key");
    expect(result.status === "created" && result.session.status).toBe("pending_approval");
    expect(opened).toEqual([]);
  });

  it("binds an Agent to a Machine only in the requested Session", async () => {
    const { service } = harness();
    const result = await service.requestSession(
      { organizationId, agentId: "agent-b", agentRole: "standard" },
      request,
      "agent-b-session-key",
    );

    expect(result).toMatchObject({
      status: "created",
      session: { organizationId, agentId: "agent-b", machineId, status: "pending_approval" },
    });
  });

  it("fails closed when a Standard Agent cannot reach Human supervision", async () => {
    const repository = new MemoryRepository({
      localPolicy: { allowRemoteApproval: false },
    });
    expect(await harness(repository).service.requestSession(
      { organizationId, agentId, agentRole: "standard" },
      request,
      "session-key",
    )).toEqual({ status: "denied", code: "supervision_denied" });
  });

  it("lets a Supervisor approve pending authority and audits the human decision", async () => {
    const context = harness();
    const requested = await context.service.requestSession(
      { organizationId, agentId, agentRole: "standard" },
      request,
      "session-key",
    );
    if (requested.status !== "created") throw new Error("Session was not created");

    expect(await context.service.superviseSession(
      { organizationId, humanId: "human-a", role: "supervisor" },
      requested.session.id,
      "approve",
    )).toMatchObject({
      status: "approved",
      session: { id: requested.session.id, status: "opening" },
      delivery: "sent",
    });
    expect(context.opened).toEqual([
      expect.objectContaining({ id: requested.session.id, status: "opening" }),
    ]);
    expect(context.events.at(-1)).toMatchObject({
      type: "session.approved",
      metadata: { humanId: "human-a", role: "supervisor" },
    });
  });

  it("keeps an approved Session resumable when its Client disconnects during delivery", async () => {
    const context = harness(
      new MemoryRepository(),
      { sessionDeliveryUnavailable: true },
    );
    const requested = await context.service.requestSession(
      { organizationId, agentId, agentRole: "standard" },
      request,
      "session-key",
    );
    if (requested.status !== "created") throw new Error("Session was not created");
    expect(await context.service.superviseSession(
      { organizationId, humanId: "human-a", role: "supervisor" },
      requested.session.id,
      "approve",
    )).toMatchObject({
      status: "approved",
      delivery: "pending",
      session: { status: "opening" },
    });
  });

  it("binds supervision to the Organization and denial never contacts the Client", async () => {
    const context = harness();
    const requested = await context.service.requestSession(
      { organizationId, agentId, agentRole: "standard" },
      request,
      "session-key",
    );
    if (requested.status !== "created") throw new Error("Session was not created");

    expect(await context.service.superviseSession(
      { organizationId: "org-b", humanId: "human-b", role: "owner" },
      requested.session.id,
      "approve",
    )).toEqual({ status: "denied_request", code: "session_not_found" });
    expect(await context.service.superviseSession(
      { organizationId, humanId: "human-a", role: "admin" },
      requested.session.id,
      "deny",
    )).toMatchObject({ status: "denied", session: { status: "cancelled" } });
    expect(context.opened).toEqual([]);
    expect(context.events.at(-1)).toMatchObject({
      type: "session.denied",
      metadata: { humanId: "human-a", role: "admin" },
    });
  });

  it("fails closed when human approval arrives after Session expiry", async () => {
    const context = harness();
    const requested = await context.service.requestSession(
      { organizationId, agentId, agentRole: "standard" },
      request,
      "session-key",
    );
    if (requested.status !== "created") throw new Error("Session was not created");
    context.repository.sessions.set(requested.session.id, {
      ...requested.session,
      expiresAt: new Date(now - 1).toISOString(),
    });
    expect(await context.service.superviseSession(
      { organizationId, humanId: "human-a", role: "supervisor" },
      requested.session.id,
      "approve",
    )).toEqual({ status: "denied_request", code: "session_already_decided" });
    expect(context.repository.sessions.get(requested.session.id)).toMatchObject({
      status: "expired",
    });
    expect(context.opened).toEqual([]);
  });

  it.each([
    [new MemoryRepository({ localPolicy: { organizationId: "org-b" } }), "organization_denied"],
    [new MemoryRepository({ localPolicy: { maxSessionDurationSeconds: 300 } }), "duration_denied"],
  ] as const)("fails closed at the Local Policy ceiling", async (repository, code) => {
    const result = await harness(repository).service.requestSession(
      { organizationId, agentId, agentRole: "operator" },
      request,
      "session-key",
    );
    expect(result).toEqual({ status: "denied", code });
  });

  it("replays the same Session mutation and rejects a changed payload", async () => {
    const { service, repository } = harness();
    const first = await service.requestSession({ organizationId, agentId, agentRole: "operator" }, request, "session-key");
    repository.activeSessionCount = 1;
    const replay = await service.requestSession({ organizationId, agentId, agentRole: "operator" }, request, "session-key");
    const conflict = await service.requestSession(
      { organizationId, agentId, agentRole: "operator" },
      { ...request, title: "Different" },
      "session-key",
    );
    expect(replay.status).toBe("replayed");
    expect(replay.status === "replayed" && first.status === "created" && replay.session.id)
      .toBe(first.status === "created" && first.session.id);
    expect(conflict).toEqual({ status: "denied", code: "idempotency_conflict" });
  });

  it("dispatches an exact Command without env or stdin and records exact command audit", async () => {
    const context = harness();
    const sessionResult = await context.service.requestSession(
      { organizationId, agentId, agentRole: "operator" },
      request,
      "session-key",
    );
    if (sessionResult.status !== "created") throw new Error("Session was not created");
    context.repository.sessions.set(sessionResult.session.id, {
      ...sessionResult.session,
      status: "active",
    });
    const result = await context.service.createCommand(
      { organizationId, agentId, agentRole: "operator" },
      sessionResult.session.id,
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

  it("denies another Agent and an expired Session before dispatch", async () => {
    const context = harness();
    const sessionResult = await context.service.requestSession(
      { organizationId, agentId, agentRole: "operator" }, request, "session-key",
    );
    if (sessionResult.status !== "created") throw new Error("Session was not created");
    context.repository.sessions.set(sessionResult.session.id, { ...sessionResult.session, status: "active" });

    expect(await context.service.createCommand(
      { organizationId, agentId: "agent-b", agentRole: "standard" },
      sessionResult.session.id,
      { command: "whoami", timeoutSeconds: 30 },
      "command-key-a",
    )).toEqual({ status: "denied", code: "session_agent_denied" });
    context.repository.sessions.set(sessionResult.session.id, {
      ...sessionResult.session,
      status: "active",
      expiresAt: new Date(now - 1).toISOString(),
    });
    expect(await context.service.createCommand(
      { organizationId, agentId, agentRole: "operator" },
      sessionResult.session.id,
      { command: "whoami", timeoutSeconds: 30 },
      "command-key-b",
    )).toEqual({ status: "denied", code: "session_expired" });
    expect(context.started).toEqual([]);
  });

  it("cancels active Commands before closing their Session authority", async () => {
    const context = harness();
    const sessionResult = await context.service.requestSession(
      { organizationId, agentId, agentRole: "operator" }, request, "session-key",
    );
    if (sessionResult.status !== "created") throw new Error("Session was not created");
    context.repository.sessions.set(sessionResult.session.id, { ...sessionResult.session, status: "active" });
    const commandResult = await context.service.createCommand(
      { organizationId, agentId, agentRole: "operator" },
      sessionResult.session.id,
      { command: "sleep 60", timeoutSeconds: 60 },
      "command-key",
    );
    if (commandResult.status !== "created") throw new Error("Command was not created");

    expect(await context.service.finishSession(
      { organizationId, agentId, agentRole: "operator" },
      sessionResult.session.id,
      "complete",
    )).toEqual({ status: "denied", code: "commands_active" });
    expect(await context.service.finishSession(
      { organizationId, agentId, agentRole: "operator" },
      sessionResult.session.id,
      "cancel",
    )).toMatchObject({ status: "cancellation_requested" });
    expect(context.cancelled).toEqual([
      expect.objectContaining({ id: commandResult.command.id }),
    ]);
    expect(context.closed).toEqual([
      expect.objectContaining({ id: sessionResult.session.id }),
    ]);
  });

  it("hides Command cancellation from another Agent", async () => {
    const context = harness();
    expect(await context.service.cancelCommand(
      { organizationId, agentId: "agent-b", agentRole: "standard" },
      randomUUID(),
    )).toEqual({ status: "denied", code: "command_not_found" });
    expect(context.cancelled).toEqual([]);
  });
});
