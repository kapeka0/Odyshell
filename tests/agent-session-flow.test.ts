import { describe, expect, it } from "vitest";
import type { OperationAction } from "@odyshell/protocol";
import {
  sessionOperationDecision,
  type AgentSessionPrincipal,
} from "../apps/server/src/agent-sessions.js";

const principal: AgentSessionPrincipal = {
  workspaceId: "workspace-a",
  agentId: "agent-a",
  sessionId: "session-a",
  scopes: [
    {
      machineId: "machine-a",
      profile: "workspace",
      capabilities: ["fs.read", "process.exec"],
      restrictions: {
        filesystem: {
          paths: [
            {
              path: "config",
              includeDescendants: true,
            },
          ],
        },
        process: {
          programs: [
            {
              program: "git",
              args: ["status", "--short"],
              cwd: { path: "repo", includeDescendants: false },
            },
          ],
        },
      },
    },
    {
      machineId: "machine-b",
      profile: "workspace",
      capabilities: ["docker.logs"],
      restrictions: {
        docker: { containers: ["api"] },
      },
    },
  ],
  expiresAt: Date.parse("2026-07-31T10:30:00.000Z"),
};

describe("typed multi-machine Agent Session authorization", () => {
  it("allows only an operation inside the selected machine scope", () => {
    expect(
      sessionOperationDecision(
        principal,
        "session-a",
        "machine-a",
        { kind: "fs.read", path: "config/app.json" },
        60,
        Date.parse("2026-07-31T10:00:00.000Z"),
      ),
    ).toMatchObject({ allowed: true });
    expect(
      sessionOperationDecision(
        principal,
        "session-a",
        "machine-b",
        {
          kind: "docker.logs",
          container: "api",
          tail: 20,
          timestamps: false,
        },
        60,
        Date.parse("2026-07-31T10:00:00.000Z"),
      ),
    ).toMatchObject({ allowed: true });
  });

  it.each([
    {
      name: "another Session",
      sessionId: "session-b",
      machineId: "machine-a",
      action: { kind: "fs.read", path: "config/app.json" } as const,
      timeoutSeconds: 60,
      now: Date.parse("2026-07-31T10:00:00.000Z"),
      code: "session_scope_denied",
    },
    {
      name: "another machine",
      sessionId: "session-a",
      machineId: "machine-c",
      action: { kind: "fs.read", path: "config/app.json" } as const,
      timeoutSeconds: 60,
      now: Date.parse("2026-07-31T10:00:00.000Z"),
      code: "machine_scope_denied",
    },
    {
      name: "a sibling path",
      sessionId: "session-a",
      machineId: "machine-a",
      action: { kind: "fs.read", path: "secrets/app.json" } as const,
      timeoutSeconds: 60,
      now: Date.parse("2026-07-31T10:00:00.000Z"),
      code: "path_scope_denied",
    },
    {
      name: "command argument injection",
      sessionId: "session-a",
      machineId: "machine-a",
      action: {
        kind: "process.exec",
        program: "git",
        args: ["status", "--short", "; rm -rf ."],
        cwd: "repo",
        env: {},
      } as OperationAction,
      timeoutSeconds: 60,
      now: Date.parse("2026-07-31T10:00:00.000Z"),
      code: "program_scope_denied",
    },
    {
      name: "another container",
      sessionId: "session-a",
      machineId: "machine-b",
      action: {
        kind: "docker.logs",
        container: "database",
        tail: 20,
        timestamps: false,
      } as OperationAction,
      timeoutSeconds: 60,
      now: Date.parse("2026-07-31T10:00:00.000Z"),
      code: "container_scope_denied",
    },
    {
      name: "an expired Session",
      sessionId: "session-a",
      machineId: "machine-a",
      action: { kind: "fs.read", path: "config/app.json" } as const,
      timeoutSeconds: 60,
      now: Date.parse("2026-07-31T10:30:00.000Z"),
      code: "session_expired",
    },
    {
      name: "a timeout beyond Session expiry",
      sessionId: "session-a",
      machineId: "machine-a",
      action: { kind: "fs.read", path: "config/app.json" } as const,
      timeoutSeconds: 61,
      now: Date.parse("2026-07-31T10:29:00.000Z"),
      code: "timeout_exceeds_session",
    },
  ])(
    "denies $name",
    ({ sessionId, machineId, action, timeoutSeconds, now, code }) => {
      expect(
        sessionOperationDecision(
          principal,
          sessionId,
          machineId,
          action,
          timeoutSeconds,
          now,
        ),
      ).toMatchObject({ allowed: false, code });
    },
  );
});
