import { describe, expect, it, vi } from "vitest";
import type { AgentSessionPrincipal } from "../apps/server/src/agent-sessions.js";
import { createOperationAdmission } from "../apps/server/src/operation-admission.js";

const now = Date.parse("2026-08-05T09:00:00.000Z");
const principal: AgentSessionPrincipal = {
  workspaceId: "workspace-a",
  agentId: "agent-a",
  sessionId: "session-a",
  scopes: [
    {
      machineId: "machine-a",
      profile: "workspace",
      capabilities: ["fs.read"],
      restrictions: {
        filesystem: {
          paths: [{ path: "repo", includeDescendants: true }],
        },
      },
    },
  ],
  expiresAt: now,
};

describe("Operation admission", () => {
  it("denies and records an Operation after its Session expires", async () => {
    const audit = vi.fn(async () => {});
    const admission = createOperationAdmission({
      database: { audit } as never,
      gateway: {} as never,
    });

    await expect(
      admission.admit({
        principal,
        sessionId: principal.sessionId,
        machineId: "machine-a",
        action: { kind: "fs.read", path: "repo/package.json" },
        timeoutSeconds: 30,
        maxOutputBytes: 1024,
        idempotencyKey: "operation-a",
        now,
      }),
    ).resolves.toEqual({
      kind: "denied",
      code: "session_expired",
      machineId: "machine-a",
      requiredCapability: "fs.read",
    });
    expect(audit).toHaveBeenCalledWith(
      "workspace-a",
      "agent-a",
      "operation.denied",
      "session",
      "session-a",
      { reason: "session_expired", kind: "fs.read" },
    );
  });

  it("does not deliver when the approved Session has no selected machine target", async () => {
    const getAgentSessionTargetRuntime = vi.fn(async () => null);
    const admission = createOperationAdmission({
      database: {
        audit: vi.fn(async () => {}),
        getAgentSessionTargetRuntime,
      } as never,
      gateway: {} as never,
    });

    await expect(
      admission.admit({
        principal: { ...principal, expiresAt: now + 60_000 },
        sessionId: principal.sessionId,
        machineId: "machine-a",
        action: { kind: "fs.read", path: "repo/package.json" },
        timeoutSeconds: 30,
        maxOutputBytes: 1024,
        idempotencyKey: "operation-a",
        now,
      }),
    ).resolves.toEqual({ kind: "session_target_not_found" });
    expect(getAgentSessionTargetRuntime).toHaveBeenCalledWith(
      "workspace-a",
      "session-a",
      "agent-a",
      "machine-a",
    );
  });

  it("delivers and records an admitted Operation through one interface", async () => {
    let created = false;
    const audit = vi.fn(async () => {});
    const send = vi.fn(() => true);
    const notifyWorkspace = vi.fn();
    const admission = createOperationAdmission({
      database: {
        audit,
        getAgentSessionTargetRuntime: vi.fn(async () => ({
          canonicalSessionId: "session-a",
          runtimeSessionId: "runtime-a",
          machineId: "machine-a",
          machineName: "Machine A",
          profile: "workspace",
          capabilities: ["fs.read"],
          restrictions: principal.scopes[0]!.restrictions,
          status: "ready",
          expiresAt: now + 60_000,
          canonicalReady: true,
        })),
        createOperation: vi.fn(async () => {
          created = true;
          return true;
        }),
        replayOperationByIdempotency: vi.fn(async (input, dispatch) => {
          if (!created) return { kind: "missing" as const };
          dispatch({
            id: input.freshOperationId!,
            sessionId: "runtime-a",
            action: { kind: "fs.read", path: "repo/package.json" },
            timeoutSeconds: 30,
            maxOutputBytes: 1024,
          });
          return {
            kind: "dispatched" as const,
            id: input.freshOperationId!,
            status: "delivered",
          };
        }),
        markOperationCompleted: vi.fn(),
      } as never,
      gateway: {
        isOnline: vi.fn(() => true),
        runMachineLifecycle: vi.fn(async (_machineId, operation) => operation()),
        send,
        notifyWorkspace,
        events: { emit: vi.fn() },
      } as never,
    });

    const result = await admission.admit({
      principal: { ...principal, expiresAt: now + 60_000 },
      sessionId: principal.sessionId,
      machineId: "machine-a",
      action: { kind: "fs.read", path: "repo/package.json" },
      timeoutSeconds: 30,
      maxOutputBytes: 1024,
      idempotencyKey: "operation-a",
      now,
    });

    expect(result).toMatchObject({ kind: "delivered", status: "delivered" });
    expect(send).toHaveBeenCalledWith(
      "machine-a",
      expect.objectContaining({
        type: "operation.start",
        sessionId: "runtime-a",
        action: { kind: "fs.read", path: "repo/package.json" },
      }),
    );
    expect(audit).toHaveBeenCalledWith(
      "workspace-a",
      "agent-a",
      "operation.created",
      "operation",
      expect.any(String),
      {
        sessionId: "session-a",
        kind: "fs.read",
        machineId: "machine-a",
        operation: { kind: "fs.read" },
      },
    );
    expect(notifyWorkspace).toHaveBeenCalledWith("workspace-a");
  });

  it("keeps development authority policy and delivery behind the same boundary", async () => {
    const audit = vi.fn(async () => {});
    const sessionForOperation = vi.fn();
    const admission = createOperationAdmission({
      database: { audit, sessionForOperation } as never,
      gateway: {} as never,
    });

    await expect(admission.admitDevelopment({
      workspaceId: "workspace-a",
      principalId: "agent-a",
      sessionId: "development-session-a",
      action: { kind: "host.shell", command: "whoami", cwd: ".", env: {} },
      timeoutSeconds: 30,
      maxOutputBytes: 1024,
      idempotencyKey: "operation-development-a",
      now,
    })).resolves.toEqual({
      kind: "denied",
      code: "manual_approval_required",
      requiredCapability: "host.shell",
    });
    expect(sessionForOperation).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      "workspace-a",
      "agent-a",
      "operation.denied",
      "session",
      "development-session-a",
      { reason: "manual_approval_required", kind: "host.shell" },
    );
  });
});
