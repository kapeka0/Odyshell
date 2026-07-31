import { describe, expect, it } from "vitest";
import { sessionOperationDecision } from "../apps/server/src/agent-sessions.js";

const principal = {
  workspaceId: "workspace-a",
  agentId: "agent-a",
  sessionId: "session-a",
  machineId: "machine-a",
  readPath: "config/app.json",
  expiresAt: Date.parse("2026-07-31T10:30:00.000Z"),
};

describe("approved Agent Session authorization", () => {
  it("allows only the exact approved read before Session expiry", () => {
    expect(
      sessionOperationDecision(
        principal,
        "session-a",
        { kind: "fs.read", path: "config\\./app.json" },
        60,
        Date.parse("2026-07-31T10:00:00.000Z"),
      ),
    ).toEqual({ allowed: true });
  });

  it.each([
    {
      name: "another Session",
      sessionId: "session-b",
      action: { kind: "fs.read", path: "config/app.json" } as const,
      timeoutSeconds: 60,
      now: Date.parse("2026-07-31T10:00:00.000Z"),
      code: "session_scope_denied",
    },
    {
      name: "another path",
      sessionId: "session-a",
      action: { kind: "fs.read", path: "config/secrets.json" } as const,
      timeoutSeconds: 60,
      now: Date.parse("2026-07-31T10:00:00.000Z"),
      code: "path_scope_denied",
    },
    {
      name: "another capability",
      sessionId: "session-a",
      action: { kind: "fs.stat", path: "config/app.json" } as const,
      timeoutSeconds: 60,
      now: Date.parse("2026-07-31T10:00:00.000Z"),
      code: "capability_denied",
    },
    {
      name: "an expired Session",
      sessionId: "session-a",
      action: { kind: "fs.read", path: "config/app.json" } as const,
      timeoutSeconds: 60,
      now: Date.parse("2026-07-31T10:30:00.000Z"),
      code: "session_expired",
    },
    {
      name: "a timeout beyond Session expiry",
      sessionId: "session-a",
      action: { kind: "fs.read", path: "config/app.json" } as const,
      timeoutSeconds: 61,
      now: Date.parse("2026-07-31T10:29:00.000Z"),
      code: "timeout_exceeds_session",
    },
  ])("denies $name", ({ sessionId, action, timeoutSeconds, now, code }) => {
    expect(
      sessionOperationDecision(
        principal,
        sessionId,
        action,
        timeoutSeconds,
        now,
      ),
    ).toEqual({ allowed: false, code });
  });
});
