import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import type { Task } from "@odyshell/protocol";
import { describe, expect, it, vi } from "vitest";
import { registerTaskSupervisionHttp } from "../apps/server/src/task-supervision-http.js";

const taskId = randomUUID();
const identity = {
  userId: "human-a",
  userName: "Supervisor",
  role: "supervisor" as const,
  organization: { externalId: "org-a", slug: "org-a", name: "Organization A" },
};

describe("Task human supervision HTTP boundary", () => {
  it("requires the trusted Web boundary before reading human identity", async () => {
    const superviseTask = vi.fn();
    const app = supervisionApp({ superviseTask });
    const response = await app.inject({
      method: "POST",
      url: `/v1/internal/tasks/${taskId}/approve`,
      payload: identity,
    });
    expect(response.statusCode).toBe(401);
    expect(superviseTask).not.toHaveBeenCalled();
  });

  it("binds a Supervisor decision to the Organization in the trusted identity", async () => {
    const superviseTask = vi.fn(async () => ({
      status: "approved" as const,
      task: task({ status: "opening" }),
      delivery: "pending" as const,
    }));
    const app = supervisionApp({ superviseTask });
    const response = await app.inject({
      method: "POST",
      url: `/v1/internal/tasks/${taskId}/approve`,
      headers: { "x-test-web-key": "valid" },
      payload: identity,
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ delivery: "pending", task: { status: "opening" } });
    expect(superviseTask).toHaveBeenCalledWith(
      { organizationId: "org-a", humanId: "human-a", role: "supervisor" },
      taskId,
      "approve",
    );
  });

  it("lists only Tasks from the trusted Organization", async () => {
    const listTasks = vi.fn(async () => [task()]);
    const app = supervisionApp({ superviseTask: vi.fn(), listTasks });
    const response = await app.inject({
      method: "POST",
      url: "/v1/internal/tasks/query",
      headers: { "x-test-web-key": "valid" },
      payload: identity,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ data: [{ id: taskId }] });
    expect(listTasks).toHaveBeenCalledWith("org-a", 100);
  });

  it("rejects missing or unrecognized roles and cross-Organization misses", async () => {
    const superviseTask = vi.fn(async () => ({
      status: "denied_request" as const,
      code: "task_not_found" as const,
    }));
    const app = supervisionApp({ superviseTask });
    for (const role of [undefined, "member"]) {
      const response = await app.inject({
        method: "POST",
        url: `/v1/internal/tasks/${taskId}/approve`,
        headers: { "x-test-web-key": "valid" },
        payload: { ...identity, role },
      });
      expect(response.statusCode).toBe(400);
    }
    const notFound = await app.inject({
      method: "POST",
      url: `/v1/internal/tasks/${taskId}/approve`,
      headers: { "x-test-web-key": "valid" },
      payload: identity,
    });
    expect(notFound.statusCode).toBe(404);
  });
});

function supervisionApp(overrides: {
  superviseTask: ReturnType<typeof vi.fn>;
  listTasks?: ReturnType<typeof vi.fn>;
}) {
  const app = Fastify();
  registerTaskSupervisionHttp(app, {
    preHandler: async (request, reply) => {
      if (request.headers["x-test-web-key"] !== "valid") {
        await reply.code(401).send({ error: "invalid_web_key" });
      }
    },
    database: { listTasks: overrides.listTasks ?? vi.fn(async () => []) },
    service: { superviseTask: overrides.superviseTask },
  });
  return app;
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: taskId,
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
