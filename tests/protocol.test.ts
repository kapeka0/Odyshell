import { describe, expect, it } from "vitest";
import type { Capability } from "../packages/protocol/src/index.js";
import {
  agentSessionRequestInputSchema,
  agentIdentitySchema,
  agentSessionSchema,
  agentTokenRequestSchema,
  clientConfigSchema,
  humanIdentitySchema,
  operationRequestSchema,
  normalizeRelativePath,
  sessionScopeSubsetDecision,
  organizationRequestSchema,
  sessionRequestSchema,
  workspaceRequestSchema,
} from "../packages/protocol/src/index.js";

describe("protocol validation", () => {
  it("rejects absolute and parent-traversing filesystem paths at the workspace boundary", () => {
    expect(
      operationRequestSchema.safeParse({ action: { kind: "fs.read", path: "/etc/passwd" } }).success,
    ).toBe(false);
    expect(
      operationRequestSchema.safeParse({ action: { kind: "fs.read", path: "C:\\Windows" } }).success,
    ).toBe(false);
    expect(
      operationRequestSchema.safeParse({ action: { kind: "fs.read", path: "../../etc/passwd" } })
        .success,
    ).toBe(false);
  });

  it("accepts a bounded structured process request", () => {
    expect(
      operationRequestSchema.safeParse({
        action: { kind: "process.exec", program: "printf", args: ["hello"], cwd: ".", env: {} },
      }).success,
    ).toBe(true);
    expect(
      operationRequestSchema.safeParse({
        action: {
          kind: "process.exec",
          program: "env",
          env: { "BAD-NAME": "value" },
        },
      }).success,
    ).toBe(false);
  });

  it("accepts structured filesystem search and Docker log operations", () => {
    expect(
      operationRequestSchema.safeParse({
        action: { kind: "fs.search", path: ".", query: "package", maxResults: 50 },
      }).success,
    ).toBe(true);
    expect(
      operationRequestSchema.safeParse({
        action: { kind: "docker.logs", container: "api", tail: 100, timestamps: true },
      }).success,
    ).toBe(true);
    expect(
      operationRequestSchema.safeParse({
        action: { kind: "docker.logs", container: "api; rm -rf /" },
      }).success,
    ).toBe(false);
  });

  it("rejects excessive session leases", () => {
    expect(
      sessionRequestSchema.safeParse({
        machineId: "2dc24de7-ec0e-45b3-88c1-acbb900e51f8",
        ttlSeconds: 7200,
        capabilities: ["process.exec"],
      }).success,
    ).toBe(false);
  });

  it("requires agent tokens to be explicitly scoped", () => {
    expect(
      agentTokenRequestSchema.safeParse({
        name: "reader",
        machineIds: [],
        capabilities: ["fs.read"],
        expiresInSeconds: 600,
      }).success,
    ).toBe(false);
    expect(
      agentTokenRequestSchema.safeParse({
        name: "reader",
        machineIds: ["2dc24de7-ec0e-45b3-88c1-acbb900e51f8"],
        capabilities: [],
        expiresInSeconds: 600,
      }).success,
    ).toBe(false);
  });

  it("allows long-lived access only within the explicit one-year ceiling", () => {
    const request = {
      name: "maintenance-agent",
      machineIds: ["2dc24de7-ec0e-45b3-88c1-acbb900e51f8"],
      capabilities: ["process.exec"],
    };

    expect(
      agentTokenRequestSchema.safeParse({
        ...request,
        expiresInSeconds: 365 * 24 * 60 * 60,
      }).success,
    ).toBe(true);
    expect(
      agentTokenRequestSchema.safeParse({
        ...request,
        expiresInSeconds: 366 * 24 * 60 * 60,
      }).success,
    ).toBe(false);
  });

  it("keeps Human and Agent identity separate from machine authority", () => {
    expect(
      humanIdentitySchema.safeParse({
        workspaceId: "workspace-a",
        id: "human-a",
        externalId: "clerk-user-a",
        status: "active",
      }).success,
    ).toBe(true);

    const agent = {
      workspaceId: "workspace-a",
      id: "agent-a",
      name: "Dependency updater",
      kind: "independent",
      parentAgentId: null,
      createdByHumanId: "human-a",
      status: "active",
    };
    expect(agentIdentitySchema.safeParse(agent).success).toBe(true);
    expect(
      agentIdentitySchema.safeParse({
        ...agent,
        machineIds: ["2dc24de7-ec0e-45b3-88c1-acbb900e51f8"],
        capabilities: ["fs.write"],
        token: "ods_agent_secret",
      }).success,
    ).toBe(false);
  });

  it("requires managed Agents to have one distinct parent", () => {
    const agent = {
      workspaceId: "workspace-a",
      id: "managed-a",
      name: "Dependency updater",
      kind: "managed",
      createdByHumanId: "human-a",
      status: "active",
    };

    expect(
      agentIdentitySchema.safeParse({ ...agent, parentAgentId: "agent-a" })
        .success,
    ).toBe(true);
    expect(
      agentIdentitySchema.safeParse({ ...agent, parentAgentId: null }).success,
    ).toBe(false);
    expect(
      agentIdentitySchema.safeParse({
        ...agent,
        parentAgentId: "managed-a",
      }).success,
    ).toBe(false);
  });

  it("models Session as temporary authority for one Agent without exposing credentials", () => {
    const session = {
      workspaceId: "workspace-a",
      id: "session-a",
      agentId: "agent-a",
      purpose: "Inspect dependency versions",
      status: "active",
      createdAt: "2026-07-30T10:00:00.000Z",
      expiresAt: "2026-07-30T11:00:00.000Z",
      predecessorSessionId: null,
    };

    expect(agentSessionSchema.safeParse(session).success).toBe(true);
    expect(
      agentSessionSchema.safeParse({
        ...session,
        expiresAt: "2026-07-31T10:00:01.000Z",
      }).success,
    ).toBe(false);
    expect(
      agentSessionSchema.safeParse({
        ...session,
        sessionCredential: "ods_session_secret",
      }).success,
    ).toBe(false);
  });

  it("accepts bounded typed Session scopes with canonical paths", () => {
    const request = {
      agentId: "df64d093-b6f6-4d91-8132-38b8038ca7c5",
      agentName: "Claude desktop",
      purpose: "Read the application configuration",
      scopes: [
        {
          machineId: "2dc24de7-ec0e-45b3-88c1-acbb900e51f8",
          capabilities: ["fs.read"],
          restrictions: {
            filesystem: {
              paths: [
                {
                  path: "config\\./app.json",
                  includeDescendants: false,
                },
              ],
            },
          },
        },
      ],
      durationSeconds: 3_600,
    };

    const parsed = agentSessionRequestInputSchema.parse(request);
    expect(parsed.scopes[0]?.restrictions.filesystem?.paths[0]?.path).toBe(
      "config/app.json",
    );
    expect(normalizeRelativePath("config//./app.json")).toBe(
      "config/app.json",
    );
    expect(
      agentSessionRequestInputSchema.safeParse({
        ...request,
        scopes: [
          {
            ...request.scopes[0],
            restrictions: {
              filesystem: {
                paths: [
                  {
                    path: "../secrets.txt",
                    includeDescendants: false,
                  },
                ],
              },
            },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      agentSessionRequestInputSchema.safeParse({
        ...request,
        scopes: [
          {
            ...request.scopes[0],
            restrictions: {
              filesystem: request.scopes[0]!.restrictions.filesystem,
              unknownAuthority: { paths: ["."] },
            },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      agentSessionRequestInputSchema.safeParse({
        ...request,
        scopes: [
          {
            ...request.scopes[0],
            capabilities: ["fs.read"],
            restrictions: {},
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      agentSessionRequestInputSchema.safeParse({
        ...request,
        scopes: [request.scopes[0], request.scopes[0]],
      }).success,
    ).toBe(false);
    expect(
      agentSessionRequestInputSchema.safeParse({
        ...request,
        durationSeconds: 24 * 60 * 60 + 1,
      }).success,
    ).toBe(false);
    expect(
      agentSessionRequestInputSchema.safeParse({
        ...request,
        scopes: [
          {
            ...request.scopes[0],
            capabilities: ["process.shell"],
            restrictions: {},
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("fails closed when a Session scope exceeds local typed restrictions", () => {
    const ceiling = {
      machineId: "2dc24de7-ec0e-45b3-88c1-acbb900e51f8",
      profile: "workspace",
      capabilities: ["fs.read", "process.exec"] as Capability[],
      restrictions: {
        filesystem: {
          paths: [{ path: "config", includeDescendants: true }],
        },
        process: {
          programs: [
            {
              program: "git",
              args: ["status"],
              cwd: { path: "repo", includeDescendants: true },
            },
          ],
        },
      },
    };
    expect(
      sessionScopeSubsetDecision(
        {
          ...ceiling,
          capabilities: ["fs.read"],
          restrictions: {
            filesystem: {
              paths: [
                { path: "config/app.json", includeDescendants: false },
              ],
            },
          },
        },
        ceiling,
      ),
    ).toEqual({ allowed: true });
    expect(
      sessionScopeSubsetDecision(
        {
          ...ceiling,
          capabilities: ["fs.read"],
          restrictions: {
            filesystem: {
              paths: [{ path: ".", includeDescendants: true }],
            },
          },
        },
        ceiling,
      ),
    ).toEqual({ allowed: false, code: "restriction_widening" });
  });

  it("accepts canonical tenant slugs and rejects ambiguous identifiers", () => {
    expect(
      organizationRequestSchema.safeParse({
        slug: "acme-platform",
        name: "Acme Platform",
      }).success,
    ).toBe(true);
    for (const slug of ["ACME", "acme/platform", "../acme", "acme--platform"]) {
      expect(
        workspaceRequestSchema.safeParse({ slug, name: "Production" }).success,
      ).toBe(false);
    }
  });

  it("fails closed when a client profile enables network access", () => {
    const config = {
      serverUrl: "http://127.0.0.1:4100",
      machineId: "2dc24de7-ec0e-45b3-88c1-acbb900e51f8",
      machineName: "test-machine",
      privateKeyPem: "private-key",
      stateDirectory: "/tmp/odyshell",
      profiles: {
        workspace: {
          runner: "docker",
          workspaceRoot: "/tmp/workspace",
          image: "alpine:3.22",
          network: "bridge",
          maxSessionTtlSeconds: 1800,
          maxConcurrentSessions: 2,
          maxOutputBytes: 1024 * 1024,
          capabilities: ["process.exec"],
        },
      },
    };

    expect(clientConfigSchema.safeParse(config).success).toBe(false);
    expect(
      clientConfigSchema.safeParse({
        ...config,
        profiles: {
          workspace: { ...config.profiles.workspace, network: "none" },
        },
      }).success,
    ).toBe(true);
  });

  it("accepts direct host execution as an explicit local profile", () => {
    expect(
      clientConfigSchema.safeParse({
        serverUrl: "https://api.odyshell.test",
        machineId: "2dc24de7-ec0e-45b3-88c1-acbb900e51f8",
        machineName: "linux-server",
        privateKeyPem: "private-key",
        stateDirectory: "/home/odyshell/.local/state/odyshell",
        profiles: {
          workspace: {
            runner: "host",
            workspaceRoot: "/srv/app",
            maxSessionTtlSeconds: 1800,
            maxConcurrentSessions: 2,
            maxOutputBytes: 1024 * 1024,
            capabilities: ["process.exec", "fs.read", "fs.write"],
          },
        },
      }).success,
    ).toBe(true);
  });
});
