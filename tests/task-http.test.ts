import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { Command, Task } from "@odyshell/protocol";
import type { TaskRepository } from "../apps/server/src/tasks.js";
import { registerTaskHttp } from "../apps/server/src/task-http.js";

const organizationId = "org-a";
const agentId = "agent-a";
const machineId = "7a354999-6a6c-42db-9467-e1416da255f1";

function task(): Task {
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

function command(taskId: string): Command {
  return {
    id: randomUUID(),
    taskId,
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

function appHarness(options: { token?: boolean; storedTask?: Task | null } = {}) {
  const app = Fastify();
  const storedTask = options.storedTask === undefined ? task() : options.storedTask;
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
              maxTaskDurationSeconds: 600,
              maxConcurrentTasks: 1,
              maxConcurrentCommands: 1,
              maxCommandTimeoutSeconds: 60,
              maxCommandOutputBytes: 1024,
              allowRemoteApproval: true,
            },
          }]
        : [];
    },
    async task(org: string, id: string) {
      return storedTask?.organizationId === org && storedTask.id === id ? storedTask : null;
    },
    async command() { return null; },
    async commandOutput() { return []; },
  } satisfies Pick<TaskRepository, "task" | "command" | "commandOutput"> & {
    listMachineAuthorities: (
      organizationId: string,
    ) => Promise<unknown[]>;
  };
  const calls: Array<{ kind: "task" | "command"; input: unknown }> = [];
  registerTaskHttp(app, {
    authenticate: async (authorization) =>
      authorization === "Bearer valid" && options.token !== false
        ? { subject: "subject", clientId: "client-a", organizationId, scopes: ["odyshell:agent"], token: "valid" }
        : null,
    principal: async (identity) => identity.organizationId === organizationId
      ? { organizationId, agentId }
      : null,
    repository,
    service: {
      async requestTask(_principal, input) {
        calls.push({ kind: "task", input });
        return { status: "created", task: storedTask ?? task() };
      },
      async createCommand(_principal, taskId, input) {
        calls.push({ kind: "command", input });
        return {
          status: "created",
          command: { ...command(taskId), ...input, cwd: input.cwd ?? null },
        };
      },
      async finishTask() {
        return { status: "completed", task: storedTask ?? task() };
      },
      async cancelCommand(_principal, commandId) {
        return { status: "cancellation_requested", command: command(commandId) };
      },
    },
  });
  return { app, calls, storedTask };
}

describe("canonical Task HTTP API", () => {
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
      url: "/v1/tasks",
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
      url: "/v1/tasks",
      headers: { authorization: "Bearer valid" },
      payload: { machineId, title: "Repair API", durationSeconds: 600 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "idempotency_key_required" });
    expect(calls).toEqual([]);
  });

  it("accepts the minimal one-Machine Task contract", async () => {
    const { app, calls } = appHarness();
    const response = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: { authorization: "Bearer valid", "idempotency-key": "task-1" },
      payload: { machineId, title: "Repair API", durationSeconds: 600 },
    });
    expect(response.statusCode).toBe(201);
    expect(calls).toEqual([{ kind: "task", input: { machineId, title: "Repair API", durationSeconds: 600 } }]);
  });

  it("rejects env and stdin at the HTTP boundary", async () => {
    const current = task();
    const { app, calls } = appHarness({ storedTask: current });
    for (const extra of [{ env: { TOKEN: "secret" } }, { stdinBase64: "YQ==" }]) {
      const response = await app.inject({
        method: "POST",
        url: `/v1/tasks/${current.id}/commands`,
        headers: { authorization: "Bearer valid", "idempotency-key": randomUUID() },
        payload: { command: "cat", timeoutSeconds: 30, ...extra },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("invalid_command");
    }
    expect(calls).toEqual([]);
  });

  it("hides a Task owned by another Organization or Agent", async () => {
    const foreign = { ...task(), organizationId: "org-b", agentId: "agent-b" };
    const { app } = appHarness({ storedTask: foreign });
    const response = await app.inject({
      method: "GET",
      url: `/v1/tasks/${foreign.id}`,
      headers: { authorization: "Bearer valid" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "task_not_found" });
  });
});
