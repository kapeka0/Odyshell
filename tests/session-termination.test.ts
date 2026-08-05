import { describe, expect, it, vi } from "vitest";
import { createSessionTermination } from "../apps/server/src/session-termination.js";

describe("Session termination", () => {
  it("persists cancellation before cancelling Operations and closing runtime Sessions", async () => {
    const events: unknown[] = [];
    const termination = createSessionTermination({
      database: {
        cancelAgentSession: vi.fn(async () => {
          events.push("persisted");
          return {
            id: "session-a",
            status: "cancelled" as const,
            transitioned: true,
            operations: [
              { id: "operation-a", machineId: "machine-a" },
              { id: "operation-b", machineId: "machine-b" },
            ],
            targets: [
              { machineId: "machine-a", runtimeSessionId: "runtime-a" },
              { machineId: "machine-b", runtimeSessionId: "runtime-b" },
            ],
          };
        }),
        completeAgentSession: vi.fn(),
      },
      gateway: {
        send(machineId, message) {
          events.push({ machineId, message });
          return true;
        },
        notifyWorkspace(workspaceId) {
          events.push({ workspaceId });
        },
      },
    });

    const result = await termination.cancel(
      {
        workspaceId: "workspace-a",
        sessionId: "session-a",
        agentId: "agent-a",
        reason: "cancelled",
      },
      { closeReason: "agent_request", notifyWorkspace: true },
    );

    expect(result).toMatchObject({
      id: "session-a",
      status: "cancelled",
      transitioned: true,
    });
    expect(events).toEqual([
      "persisted",
      {
        machineId: "machine-a",
        message: { type: "operation.cancel", operationId: "operation-a" },
      },
      {
        machineId: "machine-b",
        message: { type: "operation.cancel", operationId: "operation-b" },
      },
      {
        machineId: "machine-a",
        message: {
          type: "session.close",
          sessionId: "runtime-a",
          reason: "agent_request",
        },
      },
      {
        machineId: "machine-b",
        message: {
          type: "session.close",
          sessionId: "runtime-b",
          reason: "agent_request",
        },
      },
      { workspaceId: "workspace-a" },
    ]);
  });

  it("closes completed runtime Sessions only after completion is accepted", async () => {
    const events: unknown[] = [];
    const termination = createSessionTermination({
      database: {
        cancelAgentSession: vi.fn(),
        completeAgentSession: vi.fn(async () => {
          events.push("completed");
          return {
            id: "session-a",
            status: "completed" as const,
            transitioned: true,
            targets: [
              { machineId: "machine-a", runtimeSessionId: "runtime-a" },
            ],
          };
        }),
      },
      gateway: {
        send(machineId, message) {
          events.push({ machineId, message });
          return true;
        },
        notifyWorkspace(workspaceId) {
          events.push({ workspaceId });
        },
      },
    });

    const result = await termination.complete(
      {
        workspaceId: "workspace-a",
        sessionId: "session-a",
        agentId: "agent-a",
        outcome: "succeeded",
      },
      { closeReason: "completed", notifyWorkspace: true },
    );

    expect(result).toMatchObject({ status: "completed", transitioned: true });
    expect(events).toEqual([
      "completed",
      {
        machineId: "machine-a",
        message: {
          type: "session.close",
          sessionId: "runtime-a",
          reason: "completed",
        },
      },
      { workspaceId: "workspace-a" },
    ]);
  });
});
