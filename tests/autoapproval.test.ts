import { describe, expect, it } from "vitest";
import type { SessionMachineScope } from "@odyshell/protocol";
import { autoapprovalDecision } from "../apps/server/src/autoapproval.js";

const readScope: SessionMachineScope = {
  machineId: "11111111-1111-4111-8111-111111111111",
  profile: "host",
  capabilities: ["fs.read"],
  restrictions: {
    filesystem: {
      paths: [{ path: "projects", includeDescendants: true }],
    },
  },
};

describe("autoapprovalDecision", () => {
  it("approves only a request within every active policy ceiling", () => {
    expect(
      autoapprovalDecision({
        requestedScopes: [
          {
            ...readScope,
            restrictions: {
              filesystem: {
                paths: [
                  { path: "projects/odyshell", includeDescendants: false },
                ],
              },
            },
          },
        ],
        requestedDurationSeconds: 300,
        policy: {
          status: "active",
          scopes: [readScope],
          maxSessionSeconds: 600,
          expiresAt: 10_000,
        },
        now: 1_000,
      }),
    ).toEqual({ approved: true });
  });

  it.each([
    {
      name: "capability widening",
      scopes: [{ ...readScope, capabilities: ["fs.read", "fs.write"] }],
      duration: 300,
    },
    {
      name: "machine widening",
      scopes: [
        readScope,
        {
          ...readScope,
          machineId: "22222222-2222-4222-8222-222222222222",
        },
      ],
      duration: 300,
    },
    {
      name: "duration widening",
      scopes: [readScope],
      duration: 601,
    },
  ])("keeps $name pending", ({ scopes, duration }) => {
    expect(
      autoapprovalDecision({
        requestedScopes: scopes as SessionMachineScope[],
        requestedDurationSeconds: duration,
        policy: {
          status: "active",
          scopes: [readScope],
          maxSessionSeconds: 600,
          expiresAt: 10_000,
        },
        now: 1_000,
      }),
    ).toEqual({ approved: false, reason: expect.any(String) });
  });

  it("fails closed for inactive, expired, or structurally unknown policies", () => {
    for (const policy of [
      {
        status: "paused",
        scopes: [readScope],
        maxSessionSeconds: 600,
        expiresAt: 10_000,
      },
      {
        status: "active",
        scopes: [readScope],
        maxSessionSeconds: 600,
        expiresAt: 999,
      },
      {
        status: "active",
        scopes: [
          {
            ...readScope,
            restrictions: { network: { hosts: ["example.com"] } },
          },
        ],
        maxSessionSeconds: 600,
        expiresAt: 10_000,
      },
    ]) {
      expect(
        autoapprovalDecision({
          requestedScopes: [readScope],
          requestedDurationSeconds: 300,
          policy: policy as never,
          now: 1_000,
        }).approved,
      ).toBe(false);
    }
  });

  it("never autoapproves an unrestricted shell capability", () => {
    const shellScope: SessionMachineScope = {
      ...readScope,
      capabilities: ["process.shell"],
      restrictions: {},
    };
    expect(
      autoapprovalDecision({
        requestedScopes: [shellScope],
        requestedDurationSeconds: 300,
        policy: {
          status: "active",
          scopes: [shellScope],
          maxSessionSeconds: 600,
          expiresAt: 10_000,
        },
        now: 1_000,
      }),
    ).toEqual({ approved: false, reason: "unsafe_capability" });
  });
});
