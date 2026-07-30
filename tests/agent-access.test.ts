import { describe, expect, it, vi } from "vitest";
import {
  createAgentAccess,
  deleteAgentAccess,
  revokeAgentAccess,
  type AgentAccessDependencies,
} from "../apps/server/src/agent-access.js";
import type { AgentTokenRecord } from "../apps/server/src/database.js";

function dependencies(
  overrides: Partial<AgentAccessDependencies> = {},
): AgentAccessDependencies {
  return {
    activeMachinesExist: vi.fn(async () => true),
    createAgentToken: vi.fn(async () => ({ created: true as const })),
    revokeAgentToken: vi.fn(async () => null),
    deleteAgentToken: vi.fn(async () => null),
    expireAgentSessions: vi.fn(async () => 0),
    audit: vi.fn(async () => undefined),
    createId: () => "access-id",
    createToken: () => "ods_agent_plaintext",
    hashToken: (token) => `hash:${token}`,
    now: () => Date.parse("2026-07-30T10:00:00.000Z"),
    ...overrides,
  };
}

describe("Agent Access service boundaries", () => {
  it("binds creation to the workspace and returns plaintext only once", async () => {
    const createAgentToken = vi.fn(async () => ({ created: true as const }));
    const audit = vi.fn<AgentAccessDependencies["audit"]>(
      async () => undefined,
    );
    const service = dependencies({ createAgentToken, audit });

    const result = await createAgentAccess(
      service,
      "workspace-a",
      "user-a",
      {
        name: "release-agent",
        machineIds: [
          "2dc24de7-ec0e-45b3-88c1-acbb900e51f8",
          "2dc24de7-ec0e-45b3-88c1-acbb900e51f8",
        ],
        capabilities: ["process.exec", "process.exec"],
        expiresInSeconds: 3_600,
      },
    );

    expect(result.status).toBe("created");
    if (result.status !== "created") throw new Error("Expected Agent Access");
    expect(result.access).toMatchObject({
      token: "ods_agent_plaintext",
      machineIds: ["2dc24de7-ec0e-45b3-88c1-acbb900e51f8"],
      capabilities: ["process.exec"],
      expiresAt: "2026-07-30T11:00:00.000Z",
    });
    expect("tokenHash" in result.access).toBe(false);
    expect(createAgentToken).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-a",
        tokenHash: "hash:ods_agent_plaintext",
      }),
    );
    expect(audit).toHaveBeenCalledOnce();
    expect(audit.mock.calls[0]?.slice(0, 2)).toEqual([
      "workspace-a",
      "user-a",
    ]);
  });

  it("denies cross-workspace machines before issuing or auditing a credential", async () => {
    const createAgentToken = vi.fn(async () => ({ created: true as const }));
    const audit = vi.fn<AgentAccessDependencies["audit"]>(
      async () => undefined,
    );
    const service = dependencies({
      activeMachinesExist: vi.fn(async (workspaceId) => workspaceId === "owner"),
      createAgentToken,
      audit,
    });

    await expect(
      createAgentAccess(service, "attacker", "user-a", {
        name: "cross-workspace",
        machineIds: ["2dc24de7-ec0e-45b3-88c1-acbb900e51f8"],
        capabilities: ["fs.read"],
        expiresInSeconds: 60,
      }),
    ).resolves.toEqual({ status: "unknown_machine" });
    expect(createAgentToken).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("closes sessions and records only the first successful revocation", async () => {
    const token: AgentTokenRecord = {
      workspaceId: "workspace-a",
      id: "access-id",
      name: "release-agent",
      tokenHash: "hash",
      machineIds: ["2dc24de7-ec0e-45b3-88c1-acbb900e51f8"],
      capabilities: ["process.exec"],
      expiresAt: Date.parse("2026-07-30T11:00:00.000Z"),
      revokedAt: Date.parse("2026-07-30T10:15:00.000Z"),
      createdAt: Date.parse("2026-07-30T10:00:00.000Z"),
    };
    const revokeAgentToken = vi
      .fn<AgentAccessDependencies["revokeAgentToken"]>()
      .mockResolvedValueOnce(token)
      .mockResolvedValueOnce(null);
    const expireAgentSessions = vi.fn(async () => 2);
    const audit = vi.fn<AgentAccessDependencies["audit"]>(
      async () => undefined,
    );
    const service = dependencies({
      revokeAgentToken,
      expireAgentSessions,
      audit,
    });

    await expect(
      revokeAgentAccess(service, "workspace-a", "user-a", "access-id"),
    ).resolves.toMatchObject({ status: "revoked", closedSessions: 2 });
    await expect(
      revokeAgentAccess(service, "workspace-a", "user-a", "access-id"),
    ).resolves.toBeNull();

    expect(expireAgentSessions).toHaveBeenCalledOnce();
    expect(expireAgentSessions).toHaveBeenCalledWith(
      "workspace-a",
      "access-id",
      "agent_token_revoked",
    );
    expect(audit).toHaveBeenCalledOnce();
  });

  it("deletes only a workspace-scoped agent once and records the closed sessions", async () => {
    const token: AgentTokenRecord = {
      workspaceId: "workspace-a",
      id: "access-id",
      name: "release-agent",
      tokenHash: "hash",
      machineIds: ["2dc24de7-ec0e-45b3-88c1-acbb900e51f8"],
      capabilities: ["process.exec"],
      expiresAt: Date.parse("2026-07-30T11:00:00.000Z"),
      revokedAt: Date.parse("2026-07-30T10:15:00.000Z"),
      deletedAt: Date.parse("2026-07-30T10:15:00.000Z"),
      createdAt: Date.parse("2026-07-30T10:00:00.000Z"),
    };
    let deleted = false;
    const deleteAgentToken = vi
      .fn<AgentAccessDependencies["deleteAgentToken"]>()
      .mockImplementation(async (workspaceId) => {
        if (workspaceId !== "workspace-a" || deleted) return null;
        deleted = true;
        return { token, closedSessions: 2 };
      });
    const audit = vi.fn<AgentAccessDependencies["audit"]>(
      async () => undefined,
    );
    const service = dependencies({ deleteAgentToken, audit });

    await expect(
      deleteAgentAccess(service, "workspace-b", "user-b", "access-id"),
    ).resolves.toBeNull();
    const result = await deleteAgentAccess(
      service,
      "workspace-a",
      "user-a",
      "access-id",
    );
    expect(result).toEqual({
      id: "access-id",
      name: "release-agent",
      status: "deleted",
      closedSessions: 2,
    });
    expect(result).not.toHaveProperty("tokenHash");
    await expect(
      deleteAgentAccess(service, "workspace-a", "user-a", "access-id"),
    ).resolves.toBeNull();

    expect(audit).toHaveBeenCalledOnce();
    expect(audit).toHaveBeenCalledWith(
      "workspace-a",
      "user-a",
      "agent_token.deleted",
      "agent_token",
      "access-id",
      {
        name: "release-agent",
        closedSessions: 2,
      },
    );
    expect(audit.mock.calls[0]?.[5]).not.toHaveProperty("tokenHash");
  });
});
