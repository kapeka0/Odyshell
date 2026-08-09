import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { Command, Session } from "@odyshell/protocol";
import type { SessionRepository } from "../apps/server/src/sessions.js";
import { registerSessionHttp } from "../apps/server/src/session-http.js";

const organizationId = "org-a";
const agentId = "agent-a";
const machineId = "7a354999-6a6c-42db-9467-e1416da255f1";

function session(): Session {
  return {
    id: randomUUID(),
    organizationId,
    agentId,
    machineId,
    clientProfileId: "profile-a",
    operatingSystemUser: "odyshell",
    title: "Repair API",
    purpose: null,
    status: "active",
    maxConcurrentCommands: 1,
    createdAt: "2026-08-08T10:00:00.000Z",
    readyAt: "2026-08-08T10:00:01.000Z",
    expiresAt: "2026-08-08T10:10:00.000Z",
    finishedAt: null,
  };
}

function command(sessionId: string): Command {
  return {
    id: randomUUID(),
    sessionId,
    organizationId,
    agentId,
    machineId,
    command: "whoami",
    cwd: null,
    timeoutSeconds: 30,
    status: "queued",
    createdAt: "2026-08-08T10:00:02.000Z",
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    outputTruncated: false,
    stdoutBytes: 0,
    stderrBytes: 0,
    error: null,
  };
}

function appHarness(options: { token?: boolean; storedSession?: Session | null } = {}) {
  const app = Fastify();
  const storedSession = options.storedSession === undefined ? session() : options.storedSession;
  const repository = {
    async listMachineAuthorities(org: string) {
      return org === organizationId
        ? [{
            organizationId,
            machineId,
            clientProfileId: "profile-a",
            operatingSystemUser: "odyshell",
            online: true,
            localPolicy: {
              organizationId,
              maxSessionDurationSeconds: 600,
              maxConcurrentSessions: 1,
              maxConcurrentCommands: 1,
              maxCommandTimeoutSeconds: 60,
              maxCommandOutputBytes: 1024,
              allowRemoteApproval: true,
            },
          }]
        : [];
    },
    async session(org: string, id: string) {
      return storedSession?.organizationId === org && storedSession.id === id ? storedSession : null;
    },
    async command() { return null; },
    async commandOutput() { return []; },
  } satisfies Pick<SessionRepository, "session" | "command" | "commandOutput"> & {
    listMachineAuthorities: (
      organizationId: string,
    ) => Promise<unknown[]>;
  };
  const calls: Array<{ kind: "session" | "command"; input: unknown }> = [];
  registerSessionHttp(app, {
    authenticate: async (authorization) =>
      authorization === "Bearer valid" && options.token !== false
        ? { subject: "subject", clientId: "client-a", organizationId, scopes: ["odyshell:agent"], token: "valid" }
        : null,
    principal: async (identity) => identity.organizationId === organizationId
      ? { organizationId, agentId, agentRole: "standard" }
      : null,
    repository,
    service: {
      async requestSession(_principal, input) {
        calls.push({ kind: "session", input });
        return { status: "created", session: storedSession ?? session() };
      },
      async createCommand(_principal, sessionId, input) {
        calls.push({ kind: "command", input });
        return {
          status: "created",
          command: { ...command(sessionId), ...input, cwd: input.cwd ?? null },
        };
      },
      async finishSession() {
        return { status: "completed", session: storedSession ?? session() };
      },
      async cancelCommand(_principal, commandId) {
        return { status: "cancellation_requested", command: command(commandId) };
      },
    },
  });
  return { app, calls, storedSession };
}

describe("canonical Session HTTP API", () => {
  it("lists Organization Machines without requiring an enrollment-time Agent assignment", async () => {
    const { app } = appHarness();
    const response = await app.inject({
      method: "GET",
      url: "/v1/machines",
      headers: { authorization: "Bearer valid" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: [{
        id: machineId,
        clientProfileId: "profile-a",
        operatingSystemUser: "odyshell",
        online: true,
      }],
    });
  });

  it("requires an OAuth Agent token before parsing a mutation", async () => {
    const { app, calls } = appHarness({ token: false });
    const response = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: {},
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "oauth_token_required" });
    expect(calls).toEqual([]);
  });

  it("requires explicit idempotency for every mutation", async () => {
    const { app, calls } = appHarness();
    const response = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { authorization: "Bearer valid" },
      payload: { machineId, title: "Repair API", durationSeconds: 900 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "idempotency_key_required" });
    expect(calls).toEqual([]);
  });

  it("accepts the minimal one-Machine Session contract", async () => {
    const { app, calls } = appHarness();
    const response = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { authorization: "Bearer valid", "idempotency-key": "session-1" },
      payload: { machineId, title: "Repair API", durationSeconds: 900 },
    });
    expect(response.statusCode).toBe(201);
    expect(calls).toEqual([{ kind: "session", input: { machineId, title: "Repair API", durationSeconds: 900 } }]);
  });

  it("rejects env and stdin at the HTTP boundary", async () => {
    const current = session();
    const { app, calls } = appHarness({ storedSession: current });
    for (const extra of [{ env: { TOKEN: "secret" } }, { stdinBase64: "YQ==" }]) {
      const response = await app.inject({
        method: "POST",
        url: `/v1/sessions/${current.id}/commands`,
        headers: { authorization: "Bearer valid", "idempotency-key": randomUUID() },
        payload: { command: "cat", timeoutSeconds: 30, ...extra },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("invalid_command");
    }
    expect(calls).toEqual([]);
  });

  it("hides a Session owned by another Organization or Agent", async () => {
    const foreign = { ...session(), organizationId: "org-b", agentId: "agent-b" };
    const { app } = appHarness({ storedSession: foreign });
    const response = await app.inject({
      method: "GET",
      url: `/v1/sessions/${foreign.id}`,
      headers: { authorization: "Bearer valid" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "session_not_found" });
  });
});
