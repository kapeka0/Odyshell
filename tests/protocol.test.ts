import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  Capability,
  OperationAction,
} from "../packages/protocol/src/index.js";
import {
  agentSessionRequestInputSchema,
  hostShellTaskRunAccessDecision,
  hostShellTaskRunRenewalDecision,
  agentIdentitySchema,
  agentSessionSchema,
  agentTokenRequestSchema,
  clientConfigSchema,
  humanIdentitySchema,
  operationRequestSchema,
  mergeSessionMachineScopes,
  normalizeOperationPath,
  normalizeRelativePath,
  operationSessionScope,
  operationSessionScopes,
  sessionMachineScopeSchema,
  sessionScopeDecision,
  sessionScopeSubsetDecision,
  organizationRequestSchema,
  sessionRequestSchema,
  workspaceRequestSchema,
} from "../packages/protocol/src/index.js";

describe("protocol validation", () => {
  it("binds attributed Host Shell lifecycle calls to their Task Run", () => {
    const hostShellScope = [{
      machineId: "7a354999-6a6c-42db-9467-e1416da255f1",
      profile: "workspace",
      capabilities: ["host.shell" as const],
      restrictions: {},
    }];

    expect(
      hostShellTaskRunAccessDecision(hostShellScope, "task-run-a", undefined),
    ).toEqual({ allowed: false, code: "task_run_id_required" });
    expect(
      hostShellTaskRunAccessDecision(hostShellScope, "task-run-a", "task-run-b"),
    ).toEqual({ allowed: false, code: "task_run_id_mismatch" });
    expect(
      hostShellTaskRunAccessDecision(hostShellScope, "task-run-a", "task-run-a"),
    ).toEqual({ allowed: true });
    expect(
      hostShellTaskRunAccessDecision(hostShellScope, undefined, undefined),
    ).toEqual({ allowed: true });
    expect(
      hostShellTaskRunRenewalDecision(hostShellScope, undefined, undefined),
    ).toEqual({ allowed: false, code: "task_run_id_required" });
    expect(
      hostShellTaskRunRenewalDecision(hostShellScope, "task-run-a", "task-run-b"),
    ).toEqual({ allowed: false, code: "task_run_id_mismatch" });
    expect(
      hostShellTaskRunRenewalDecision(hostShellScope, "task-run-a", "task-run-a"),
    ).toEqual({ allowed: true });
  });

  it.each([
    [
      { kind: "process.exec", program: "git", args: ["status"], cwd: "." },
      "process.exec",
      "process",
    ],
    [{ kind: "fs.read", path: "config/app.json" }, "fs.read", "filesystem"],
    [
      { kind: "docker.logs", container: "api", tail: 20, timestamps: false },
      "docker.logs",
      "docker",
    ],
  ] satisfies Array<[OperationAction, string, string]>)(
    "derives the minimum Session scope for an operation",
    (action, capability, restriction) => {
      const scope = operationSessionScope(
        "7a354999-6a6c-42db-9467-e1416da255f1",
        action,
      );

      expect(scope.capabilities).toEqual([capability]);
      expect(scope.restrictions).toHaveProperty(restriction);
    },
  );

  it("keeps Host Shell execution separate from structured scope derivation", () => {
    const request = operationRequestSchema.parse({
      action: {
        kind: "host.shell",
        command: "git status",
        env: { CI: "true" },
        stdinBase64: Buffer.from("confirm\n").toString("base64"),
      },
    });

    expect(request).toEqual({
      action: {
        kind: "host.shell",
        command: "git status",
        cwd: ".",
        env: { CI: "true" },
        stdinBase64: Buffer.from("confirm\n").toString("base64"),
      },
      timeoutSeconds: 600,
      maxOutputBytes: 1024 * 1024,
    });
    type ScopedAction = Parameters<typeof operationSessionScope>[1];
    expectTypeOf<
      Extract<ScopedAction, { kind: "host.shell" }>
    >().toEqualTypeOf<never>();
    expect(() =>
      operationSessionScope(
        "7a354999-6a6c-42db-9467-e1416da255f1",
        request.action as ScopedAction,
      ),
    ).toThrow(/request Host Shell authority/i);
    expect(() =>
      operationSessionScopes([
        {
          machineId: "7a354999-6a6c-42db-9467-e1416da255f1",
          action: request.action as ScopedAction,
        },
      ]),
    ).toThrow(/request Host Shell authority/i);
    expect(
      operationRequestSchema.safeParse({
        action: { kind: "process.shell", command: "git status" },
      }).success,
    ).toBe(false);
  });

  it("treats Host Shell cwd as execution context instead of a path boundary", () => {
    const parent = operationRequestSchema.parse({
      action: { kind: "host.shell", command: "pwd", cwd: ".." },
    });
    const networkPath = String.raw`\\server\share\project`;
    const unc = operationRequestSchema.parse({
      action: { kind: "host.shell", command: "cd", cwd: networkPath },
    });

    expect(parent.action).toMatchObject({ cwd: ".." });
    expect(unc.action).toMatchObject({ cwd: networkPath });
    expect(
      operationRequestSchema.safeParse({
        action: { kind: "host.shell", command: "pwd", cwd: "bad\0path" },
      }).success,
    ).toBe(false);
    expect(
      operationRequestSchema.safeParse({
        action: {
          kind: "process.exec",
          program: "pwd",
          args: [],
          cwd: "..",
        },
      }).success,
    ).toBe(false);
  });

  it("bounds host shell stdin and operation timeouts", () => {
    const maximumStdin = Buffer.alloc(1024 * 1024).toString("base64");
    const excessiveStdin = Buffer.alloc(1024 * 1024 + 1).toString("base64");

    expect(
      operationRequestSchema.safeParse({
        action: {
          kind: "host.shell",
          command: "cat",
          stdinBase64: maximumStdin,
        },
        timeoutSeconds: 86_400,
      }).success,
    ).toBe(true);
    expect(
      operationRequestSchema.safeParse({
        action: {
          kind: "host.shell",
          command: "cat",
          stdinBase64: excessiveStdin,
        },
      }).success,
    ).toBe(false);
    expect(
      operationRequestSchema.safeParse({
        action: {
          kind: "host.shell",
          command: "cat",
          stdinBase64: "not base64!",
        },
      }).success,
    ).toBe(false);
    expect(
      operationRequestSchema.safeParse({
        action: { kind: "host.shell", command: "sleep forever" },
        timeoutSeconds: 86_401,
      }).success,
    ).toBe(false);
  });

  it("models an unrestricted filesystem capability without a path selector", () => {
    const machineId = "7a354999-6a6c-42db-9467-e1416da255f1";
    const scope = sessionMachineScopeSchema.parse({
      machineId,
      profile: "default",
      capabilities: ["fs.read"],
      restrictions: {},
    });

    expect(
      sessionScopeDecision(scope, machineId, {
        kind: "fs.read",
        path: process.platform === "win32" ? "C:/Windows/win.ini" : "/etc/hosts",
      }),
    ).toEqual({ allowed: true });
    expect(
      sessionScopeDecision(
        { ...scope, capabilities: ["fs.stat"] },
        machineId,
        { kind: "fs.read", path: "README.md" },
      ),
    ).toEqual({ allowed: false, code: "capability_denied" });
  });

  it("accepts an absolute working directory for an exact process operation", () => {
    const cwd = process.platform === "win32" ? "C:\\Windows" : "/tmp";
    const parsed = operationRequestSchema.parse({
      action: {
        kind: "process.exec",
        program: process.execPath,
        args: ["--version"],
        cwd,
      },
    });

    expect(parsed.action).toMatchObject({
      kind: "process.exec",
      cwd: cwd.replaceAll("\\", "/"),
    });
  });

  it("merges several exact operations into one scope per machine", () => {
    const scopes = operationSessionScopes([
      {
        machineId: "7a354999-6a6c-42db-9467-e1416da255f1",
        action: { kind: "fs.read", path: "config/default.json" },
      },
      {
        machineId: "7a354999-6a6c-42db-9467-e1416da255f1",
        action: { kind: "fs.read", path: "config/app.json" },
      },
    ]);

    expect(scopes).toHaveLength(1);
    expect(scopes[0]).toMatchObject({
      capabilities: ["fs.read"],
      restrictions: {
        filesystem: {
          paths: [
            { path: "config/default.json", includeDescendants: false },
            { path: "config/app.json", includeDescendants: false },
          ],
        },
      },
    });
  });

  it("merges predecessor authority with host shell without widening typed restrictions", () => {
    const machineId = "7a354999-6a6c-42db-9467-e1416da255f1";
    expect(
      mergeSessionMachineScopes([
        {
          machineId,
          profile: "workspace",
          capabilities: ["fs.read"],
          restrictions: {
            filesystem: {
              paths: [{ path: "config/app.json", includeDescendants: false }],
            },
          },
        },
        {
          machineId,
          profile: "workspace",
          capabilities: ["host.shell"],
          restrictions: {},
        },
      ]),
    ).toEqual([
      {
        machineId,
        profile: "workspace",
        capabilities: ["fs.read", "host.shell"],
        restrictions: {
          filesystem: {
            paths: [{ path: "config/app.json", includeDescendants: false }],
          },
        },
      },
    ]);

    expect(() =>
      mergeSessionMachineScopes([
        {
          machineId,
          profile: "workspace",
          capabilities: ["fs.read"],
          restrictions: {
            filesystem: {
              paths: [{ path: "public.txt", includeDescendants: false }],
            },
          },
        },
        {
          machineId,
          profile: "workspace",
          capabilities: ["fs.write"],
          restrictions: {
            filesystem: {
              paths: [{ path: "output.txt", includeDescendants: false }],
            },
          },
        },
      ]),
    ).toThrow(/widen filesystem authority/i);
  });

  it("rejects filesystem scope merges that create capability-path cross products", () => {
    expect(() =>
      operationSessionScopes([
        {
          machineId: "7a354999-6a6c-42db-9467-e1416da255f1",
          action: { kind: "fs.read", path: "public.txt" },
        },
        {
          machineId: "7a354999-6a6c-42db-9467-e1416da255f1",
          action: {
            kind: "fs.write",
            path: "output.txt",
            contentBase64: "",
            createParents: false,
          },
        },
      ]),
    ).toThrow(/different filesystem capabilities/i);
  });

  it("accepts local absolute paths but rejects traversal and network paths", () => {
    expect(
      operationRequestSchema.safeParse({ action: { kind: "fs.read", path: "/etc/passwd" } }).success,
    ).toBe(true);
    expect(
      operationRequestSchema.safeParse({ action: { kind: "fs.read", path: "C:\\Windows" } }).success,
    ).toBe(true);
    expect(
      operationRequestSchema.safeParse({ action: { kind: "fs.read", path: "../../etc/passwd" } })
        .success,
    ).toBe(false);
    expect(
      operationRequestSchema.safeParse({ action: { kind: "fs.read", path: "//server/share" } })
        .success,
    ).toBe(false);
  });

  it("accepts a bounded process request without an environment surface", () => {
    const request = operationRequestSchema.parse({
      action: {
        kind: "process.exec",
        program: "printf",
        args: ["hello"],
        cwd: ".",
      },
    });

    expect(request.action).toEqual({
      kind: "process.exec",
      program: "printf",
      args: ["hello"],
      cwd: ".",
    });
    expect(
      operationRequestSchema.safeParse({
        action: {
          kind: "process.exec",
          program: "printf",
          env: {},
        },
      }).success,
    ).toBe(false);
    expect(
      operationRequestSchema.safeParse({
        action: {
          kind: "process.exec",
          program: "env",
          env: { CI: "true" },
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
      title: "Inspect dependencies",
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
        readyAt: "2026-07-30T12:00:00.000Z",
        expiresAt: "2026-07-31T12:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      agentSessionSchema.safeParse({
        ...session,
        readyAt: "2026-07-30T12:00:00.000Z",
        expiresAt: "2026-07-31T12:00:00.001Z",
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
      title: "Read application configuration",
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
    expect(
      agentSessionRequestInputSchema.safeParse({
        ...request,
        purpose: undefined,
      }).success,
    ).toBe(true);
    expect(
      agentSessionRequestInputSchema.safeParse({
        ...request,
        title: undefined,
      }).success,
    ).toBe(false);
    expect(normalizeRelativePath("config//./app.json")).toBe(
      "config/app.json",
    );
    expect(normalizeOperationPath("/etc//network/./interfaces")).toBe(
      "/etc/network/interfaces",
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
                    path: "/etc/network/interfaces",
                    includeDescendants: false,
                  },
                ],
              },
            },
          },
        ],
      }).success,
    ).toBe(true);
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
    ).toBe(true);
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
            capabilities: ["host.shell"],
            restrictions: {},
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      agentSessionRequestInputSchema.safeParse({
        ...request,
        runId: "   ",
        scopes: [
          {
            ...request.scopes[0],
            capabilities: ["host.shell"],
            restrictions: {},
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      agentSessionRequestInputSchema.safeParse({
        ...request,
        runId: "task-run-2026-08-05",
        scopes: [
          {
            ...request.scopes[0],
            capabilities: ["host.shell"],
            restrictions: {},
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      agentSessionRequestInputSchema.safeParse({
        ...request,
        purpose: undefined,
        durationSeconds: 3_601,
        runId: "long-task-run",
        scopes: [{
          ...request.scopes[0],
          capabilities: ["host.shell"],
          restrictions: {},
        }],
      }).success,
    ).toBe(false);
    expect(
      agentSessionRequestInputSchema.safeParse({
        ...request,
        purpose: "The full repository verification exceeds one hour",
        durationSeconds: 3_601,
        runId: "long-task-run",
        scopes: [{
          ...request.scopes[0],
          capabilities: ["host.shell"],
          restrictions: {},
        }],
      }).success,
    ).toBe(true);
    expect(
      agentSessionRequestInputSchema.parse({
        ...request,
        predecessorSessionId: "e8f54e08-651b-47d9-8c61-801c420d11df",
      }).predecessorSessionId,
    ).toBe("e8f54e08-651b-47d9-8c61-801c420d11df");
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
    expect(
      sessionScopeSubsetDecision(
        {
          ...ceiling,
          capabilities: ["fs.read"],
          restrictions: {},
        },
        ceiling,
      ),
    ).toEqual({ allowed: false, code: "restriction_widening" });
    expect(
      sessionScopeSubsetDecision(
        { ...ceiling, profile: "sandbox" },
        ceiling,
      ),
    ).toEqual({ allowed: false, code: "profile_mismatch" });
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
          mountSource: "/tmp/workspace",
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
        workspaceId: "workspace-a",
        profiles: {
          workspace: { ...config.profiles.workspace, network: "none" },
        },
      }).success,
    ).toBe(true);
  });

  it("accepts direct host execution as an explicit local profile", () => {
    const parsed = clientConfigSchema.safeParse({
        serverUrl: "https://api.odyshell.test",
        workspaceId: "workspace-a",
        machineId: "2dc24de7-ec0e-45b3-88c1-acbb900e51f8",
        machineName: "linux-server",
        privateKeyPem: "private-key",
        stateDirectory: "/home/odyshell/.local/state/odyshell",
        profiles: {
          workspace: {
            runner: "host",
            maxSessionTtlSeconds: 1800,
            maxConcurrentSessions: 2,
            maxOutputBytes: 1024 * 1024,
            capabilities: ["process.exec", "host.shell", "fs.read", "fs.write"],
          },
        },
      });
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("Client config should parse");
    expect(parsed.data.allowPrivilegeEscalation).toBe(false);
    expect(parsed.data.profiles.workspace).toMatchObject({
      maxConcurrentOperations: 4,
      maxOperationTimeoutSeconds: 3_600,
    });
    expect(
      clientConfigSchema.safeParse({
        ...parsed.data,
        profiles: {
          workspace: {
            ...parsed.data.profiles.workspace,
            workspaceRoot: "/obsolete/root",
          },
        },
      }).success,
    ).toBe(false);
    expect(
      clientConfigSchema.safeParse({
        ...parsed.data,
        allowPrivilegeEscalation: true,
      }).success,
    ).toBe(true);
    expect(
      clientConfigSchema.safeParse({
        ...parsed.data,
        profiles: {
          workspace: {
            ...parsed.data.profiles.workspace,
            runner: "docker",
            image: "alpine:3.22",
            mountSource: "/srv/app",
            network: "none",
          },
        },
      }).success,
    ).toBe(false);
  });

  it("keeps Client policy compatible with the 24-hour Session boundary", () => {
    const profile = {
      runner: "host" as const,
      maxConcurrentSessions: 2,
      maxOutputBytes: 1024 * 1024,
      capabilities: ["process.exec" as const],
    };
    const config = {
      serverUrl: "https://api.odyshell.test",
      workspaceId: "workspace-a",
      machineId: "2dc24de7-ec0e-45b3-88c1-acbb900e51f8",
      machineName: "linux-server",
      privateKeyPem: "private-key",
      stateDirectory: "/tmp/odyshell",
      profiles: {
        workspace: { ...profile, maxSessionTtlSeconds: 24 * 60 * 60 },
      },
    };

    expect(clientConfigSchema.safeParse(config).success).toBe(true);
    expect(
      clientConfigSchema.safeParse({
        ...config,
        profiles: {
          workspace: { ...profile, maxSessionTtlSeconds: 24 * 60 * 60 + 1 },
        },
      }).success,
    ).toBe(false);
  });
});
