import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import type { Session } from "@odyshell/protocol";
import { describe, expect, it, vi } from "vitest";
import { registerSessionSupervisionHttp } from "../apps/server/src/session-supervision-http.js";

const sessionId = randomUUID();
const identity = {
  userId: "human-a",
  role: "supervisor" as const,
  organization: { externalId: "org-a", slug: "org-a", name: "Organization A" },
};

describe("Session human supervision HTTP boundary", () => {
  it("requires the trusted Web boundary before reading human identity", async () => {
    const superviseSession = vi.fn();
    const app = supervisionApp({ superviseSession });
    const response = await app.inject({
      method: "POST",
      url: `/v1/internal/sessions/${sessionId}/approve`,
      payload: identity,
    });
    expect(response.statusCode).toBe(401);
    expect(superviseSession).not.toHaveBeenCalled();
  });

  it("binds a Supervisor decision to the Organization in the trusted identity", async () => {
    const superviseSession = vi.fn(async () => ({
      status: "approved" as const,
      session: session({ status: "opening" }),
      delivery: "pending" as const,
    }));
    const app = supervisionApp({ superviseSession });
    const response = await app.inject({
      method: "POST",
      url: `/v1/internal/sessions/${sessionId}/approve`,
      headers: { "x-test-web-key": "valid" },
      payload: identity,
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ delivery: "pending", session: { status: "opening" } });
    expect(superviseSession).toHaveBeenCalledWith(
      { organizationId: "org-a", humanId: "human-a", role: "supervisor" },
      sessionId,
      "approve",
    );
  });

  it("lists only Sessions from the trusted Organization", async () => {
    const listSessions = vi.fn(async () => [session()]);
    const app = supervisionApp({ superviseSession: vi.fn(), listSessions });
    const response = await app.inject({
      method: "POST",
      url: "/v1/internal/sessions/query",
      headers: { "x-test-web-key": "valid" },
      payload: identity,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ data: [{ id: sessionId }] });
    expect(listSessions).toHaveBeenCalledWith("org-a", 100);
  });

  it("rejects missing or unrecognized roles and cross-Organization misses", async () => {
    const superviseSession = vi.fn(async () => ({
      status: "denied_request" as const,
      code: "session_not_found" as const,
    }));
    const app = supervisionApp({ superviseSession });
    for (const role of [undefined, "member"]) {
      const response = await app.inject({
        method: "POST",
        url: `/v1/internal/sessions/${sessionId}/approve`,
        headers: { "x-test-web-key": "valid" },
        payload: { ...identity, role },
      });
      expect(response.statusCode).toBe(400);
    }
    const notFound = await app.inject({
      method: "POST",
      url: `/v1/internal/sessions/${sessionId}/approve`,
      headers: { "x-test-web-key": "valid" },
      payload: identity,
    });
    expect(notFound.statusCode).toBe(404);
  });
});

function supervisionApp(overrides: {
  superviseSession: ReturnType<typeof vi.fn>;
  listSessions?: ReturnType<typeof vi.fn>;
  sessionTimeline?: ReturnType<typeof vi.fn>;
}) {
  const app = Fastify();
  registerSessionSupervisionHttp(app, {
    preHandler: async (request, reply) => {
      if (request.headers["x-test-web-key"] !== "valid") {
        await reply.code(401).send({ error: "invalid_web_key" });
      }
    },
    database: {
      listSessions: overrides.listSessions ?? vi.fn(async () => []),
      sessionTimeline: overrides.sessionTimeline ?? vi.fn(async () => null),
    },
    service: { superviseSession: overrides.superviseSession },
  });
  return app;
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: sessionId,
    organizationId: "org-a",
    agentId: "agent-a",
    machineId: randomUUID(),
    clientProfileId: "profile-a",
    operatingSystemUser: "odyshell",
    title: "Repair API",
    purpose: null,
    status: "pending_approval",
    maxConcurrentCommands: 1,
    createdAt: "2026-08-08T20:00:00.000Z",
    readyAt: null,
    expiresAt: "2026-08-08T20:10:00.000Z",
    finishedAt: null,
    ...overrides,
  };
}
