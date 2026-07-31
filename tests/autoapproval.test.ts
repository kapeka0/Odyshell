import { describe, expect, it } from "vitest";
import type { SessionMachineScope } from "@odyshell/protocol";
import {
  autoapprovalDecision,
  managedDelegationDecision,
} from "../apps/server/src/autoapproval.js";

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

describe("managedDelegationDecision", () => {
  it("allows one-level child authority inside every delegation ceiling", () => {
    expect(
      managedDelegationDecision({
        childScopes: [readScope],
        childMaxSessionSeconds: 300,
        childExpiresAt: 9_000,
        activeManagedAgents: 1,
        delegation: {
          status: "active",
          scopes: [readScope],
          maxSessionSeconds: 600,
          maxManagedAgents: 2,
          expiresAt: 10_000,
        },
        now: 1_000,
      }),
    ).toEqual({ allowed: true });
  });

  it.each([
    {
      name: "managed count",
      input: { activeManagedAgents: 2 },
      reason: "managed_agent_limit",
    },
    {
      name: "child validity",
      input: { childExpiresAt: 10_001 },
      reason: "validity_widening",
    },
    {
      name: "child scope",
      input: {
        childScopes: [{ ...readScope, capabilities: ["fs.read", "fs.write"] }],
      },
      reason: "scope_widening",
    },
  ])("rejects $name escalation", ({ input, reason }) => {
    expect(
      managedDelegationDecision({
        childScopes: [readScope],
        childMaxSessionSeconds: 300,
        childExpiresAt: 9_000,
        activeManagedAgents: 1,
        delegation: {
          status: "active",
          scopes: [readScope],
          maxSessionSeconds: 600,
          maxManagedAgents: 2,
          expiresAt: 10_000,
        },
        now: 1_000,
        ...(input as Partial<{
          childScopes: SessionMachineScope[];
          activeManagedAgents: number;
          childExpiresAt: number;
        }>),
      }),
    ).toEqual({ allowed: false, reason });
  });
});
