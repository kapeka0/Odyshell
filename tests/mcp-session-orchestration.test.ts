import { describe, expect, it, vi } from "vitest";
import {
  findReusableMcpAuthority,
  mcpClaimDecision,
  planMcpHostShellRequest,
  planMcpOperationRequest,
} from "../packages/mcp/src/session-orchestration.js";
import type { McpBoundAuthority } from "../packages/mcp/src/session-orchestration.js";

const now = Date.parse("2026-08-05T10:00:00.000Z");
const machineA = "8c7b76e6-a7f5-4e7a-b315-46e9dfd4f3c1";
const machineB = "7bf39e9f-f7ea-489c-9e44-c67a57c52a99";

describe("MCP Session orchestration", () => {
  it("plans least-privilege operation and linked Host Shell requests", () => {
    expect(planMcpOperationRequest([{
      machineId: machineA,
      action: { kind: "fs.read", path: "repo/package.json" },
    }])).toEqual({
      allowed: true,
      scopes: [{
        machineId: machineA,
        profile: "workspace",
        capabilities: ["fs.read"],
        restrictions: {
          filesystem: {
            paths: [{ path: "repo/package.json", includeDescendants: false }],
          },
        },
      }],
      kinds: ["fs.read"],
      reuse: {
        kind: "operations",
        operations: [{
          machineId: machineA,
          action: { kind: "fs.read", path: "repo/package.json" },
        }],
      },
    });

    expect(planMcpHostShellRequest(machineA, [{
      machineId: machineA,
      profile: "restricted",
      capabilities: ["fs.read"],
      restrictions: {
        filesystem: {
          paths: [{ path: "repo", includeDescendants: true }],
        },
      },
    }])).toMatchObject({
      allowed: true,
      scopes: [
        expect.objectContaining({
          machineId: machineA,
          profile: "restricted",
          capabilities: ["fs.read", "host.shell"],
        }),
      ],
      reuse: null,
    });
  });

  it("fails closed for anticipated Host Shell commands and invalid predecessors", () => {
    expect(planMcpOperationRequest([{
      machineId: machineA,
      action: { kind: "host.shell", command: "whoami", cwd: ".", env: {} } as never,
    }])).toEqual({
      allowed: false,
      code: "host_shell_request_required",
    });
    expect(planMcpHostShellRequest(machineA, null)).toEqual({
      allowed: false,
      code: "predecessor_session_unavailable",
    });
    expect(planMcpHostShellRequest(machineB, [{
      machineId: machineA,
      profile: "workspace",
      capabilities: ["fs.read"],
      restrictions: {},
    }])).toEqual({
      allowed: false,
      code: "predecessor_machine_denied",
    });
  });

  it("reuses only ready, live authority bound by the calling adapter", async () => {
    const authorityForSession: (sessionId: string) => Promise<McpBoundAuthority | null> =
      vi.fn(async (sessionId: string): Promise<McpBoundAuthority | null> =>
      sessionId === "session-bound"
        ? {
            sessionId,
            expiresAt: now + 60_000,
            scopes: [{
              machineId: machineA,
              profile: "workspace",
              capabilities: ["fs.read"],
              restrictions: {
                filesystem: {
                  paths: [{ path: "repo", includeDescendants: true }],
                },
              },
            }],
          }
        : null,
      );

    await expect(findReusableMcpAuthority({
      sessions: [
        {
          sessionId: "session-unbound",
          active: true,
          expiresAt: now + 60_000,
          targets: [{ machineId: machineA, ready: true }],
        },
        {
          sessionId: "session-bound",
          active: true,
          expiresAt: now + 60_000,
          targets: [{ machineId: machineA, ready: true }],
        },
      ],
      request: {
        kind: "operations",
        operations: [{
          machineId: machineA,
          action: { kind: "fs.read", path: "repo/package.json" },
        }],
      },
      authorityForSession,
      now,
    })).resolves.toMatchObject({ sessionId: "session-bound" });
    expect(authorityForSession).toHaveBeenCalledWith("session-unbound");
    expect(authorityForSession).toHaveBeenCalledWith("session-bound");
  });

  it("shares the same bound/review/claim/unavailable state transitions", () => {
    expect(mcpClaimDecision({ hasBoundAuthority: true, status: "approved" }))
      .toBe("return_bound");
    expect(mcpClaimDecision({ hasBoundAuthority: false, status: "approved" }))
      .toBe("claim");
    expect(mcpClaimDecision({ hasBoundAuthority: false, status: "claimed" }))
      .toBe("unavailable");
    expect(mcpClaimDecision({ hasBoundAuthority: false, status: "pending" }))
      .toBe("return_status");
  });
});
