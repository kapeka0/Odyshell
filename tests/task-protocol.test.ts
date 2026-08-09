import { describe, expect, it } from "vitest";
import {
  commandDecision,
  commandRequestSchema,
  localPolicySchema,
  localTaskDecision,
  taskRequestSchema,
  type Task,
} from "../packages/protocol/src/task.js";
import {
  clientConfigSchema,
  parseClientMessage,
  parseServerMessage,
} from "../packages/protocol/src/index.js";

const policy = localPolicySchema.parse({
  organizationId: "org-a",
  agentIds: ["agent-a"],
  maxTaskDurationSeconds: 3_600,
  maxConcurrentTasks: 1,
  maxConcurrentCommands: 2,
  maxCommandTimeoutSeconds: 600,
  maxCommandOutputBytes: 1024 * 1024,
  allowRemoteApproval: true,
});

describe("agent-native Task protocol", () => {
  it("keeps a Machine with no allowed Agents connected but default-denied", () => {
    const unassignedPolicy = localPolicySchema.parse({ ...policy, agentIds: [] });
    expect(localTaskDecision(unassignedPolicy, {
      organizationId: "org-a",
      agentId: "agent-a",
      durationSeconds: 600,
      activeTasks: 0,
      maxConcurrentCommands: 1,
    })).toEqual({ allowed: false, code: "agent_denied" });
  });

  it("accepts only one Machine per Task and only shell-native Command input", () => {
    expect(taskRequestSchema.parse({
      machineId: "7a354999-6a6c-42db-9467-e1416da255f1",
      title: "Repair the API",
      durationSeconds: 600,
    })).toEqual({
      machineId: "7a354999-6a6c-42db-9467-e1416da255f1",
      title: "Repair the API",
      durationSeconds: 600,
    });

    expect(commandRequestSchema.parse({ command: "systemctl status api" })).toEqual({
      command: "systemctl status api",
      timeoutSeconds: 600,
    });
    expect(commandRequestSchema.safeParse({
      command: "cat",
      env: { TOKEN: "secret" },
    }).success).toBe(false);
    expect(commandRequestSchema.safeParse({
      command: "cat",
      stdinBase64: "YQ==",
    }).success).toBe(false);
    expect(commandRequestSchema.safeParse({
      command: "pwd",
      cwd: "relative/path",
    }).success).toBe(false);
  });

  it.each([
    [{ organizationId: "org-b" }, "organization_denied"],
    [{ agentId: "agent-b" }, "agent_denied"],
    [{ durationSeconds: 3_601 }, "duration_denied"],
    [{ activeTasks: 1 }, "task_concurrency_denied"],
    [{ maxConcurrentCommands: 3 }, "command_concurrency_denied"],
  ] as const)("enforces the Local Policy ceiling for %j", (override, code) => {
    expect(localTaskDecision(policy, {
      organizationId: "org-a",
      agentId: "agent-a",
      durationSeconds: 600,
      activeTasks: 0,
      maxConcurrentCommands: 2,
      ...override,
    })).toEqual({ allowed: false, code });
  });

  it("does not clamp a caller timeout into authority the caller did not request", () => {
    const task = {
      status: "active",
      expiresAt: "2026-08-08T10:10:00.000Z",
    } as Task;
    const now = Date.parse("2026-08-08T10:09:30.000Z");

    expect(commandDecision(task, { timeoutSeconds: 30 }, policy, now)).toEqual({
      allowed: true,
      timeoutSeconds: 30,
    });
    expect(commandDecision(task, { timeoutSeconds: 31 }, policy, now)).toEqual({
      allowed: false,
      code: "timeout_exceeds_task",
    });
    expect(commandDecision(task, { timeoutSeconds: 601 }, policy, now)).toEqual({
      allowed: false,
      code: "timeout_exceeds_local_policy",
    });
  });

  it("runtime-validates untrusted Task transport messages", () => {
    expect(() => parseClientMessage(JSON.stringify({
      type: "command.output",
      commandId: "7a354999-6a6c-42db-9467-e1416da255f1",
      sequence: -1,
      stream: "secret",
      dataBase64: "not base64",
    }))).toThrow();
    expect(() => parseClientMessage(JSON.stringify({
      type: "command.completed",
      commandId: "7a354999-6a6c-42db-9467-e1416da255f1",
      status: "running",
      exitCode: null,
      outputTruncated: false,
      at: new Date().toISOString(),
    }))).toThrow();
  });

  it("rejects legacy, incomplete, and widened wire messages", () => {
    expect(() => parseClientMessage(JSON.stringify({
      type: "session.opened",
      sessionId: "7a354999-6a6c-42db-9467-e1416da255f1",
      runner: "host",
      runtimeId: "legacy",
    }))).toThrow();
    expect(() => parseServerMessage(JSON.stringify({
      type: "operation.start",
      operationId: "7a354999-6a6c-42db-9467-e1416da255f1",
    }))).toThrow();
    expect(() => parseClientMessage(JSON.stringify({
      type: "authenticate",
      machineId: "7a354999-6a6c-42db-9467-e1416da255f1",
      protocolVersion: 4,
      signature: "valid_base64url",
    }))).toThrow();
    expect(() => parseServerMessage(JSON.stringify({
      type: "ping",
      pingId: "7a354999-6a6c-42db-9467-e1416da255f1",
      unexpectedAuthority: true,
    }))).toThrow();
  });

  it("accepts only Task-native Client configuration", () => {
    const config = {
      serverUrl: "https://api.odyshell.test",
      machineId: "2dc24de7-ec0e-45b3-88c1-acbb900e51f8",
      machineName: "linux-server",
      privateKeyPem: "private-key",
      stateDirectory: "/tmp/odyshell",
      taskProfile: {
        id: "default",
        localPolicy: policy,
      },
    };

    expect(clientConfigSchema.safeParse(config).success).toBe(true);
    for (const legacy of [
      { workspaceId: "workspace-a" },
      { allowPrivilegeEscalation: true },
      { profiles: { workspace: { runner: "host" } } },
    ]) {
      expect(clientConfigSchema.safeParse({ ...config, ...legacy }).success).toBe(false);
    }
    expect(clientConfigSchema.safeParse({
      ...config,
      taskProfile: { ...config.taskProfile, executorProfile: "workspace" },
    }).success).toBe(false);
    expect(clientConfigSchema.safeParse({
      ...config,
      taskProfile: {
        ...config.taskProfile,
        localPolicy: {
          ...config.taskProfile.localPolicy,
          maxTaskDurationSeconds: 24 * 60 * 60 + 1,
        },
      },
    }).success).toBe(false);
  });
});
