import { z } from "zod";

export const PROTOCOL_VERSION = 1;
export const DEFAULT_CLOUD_SERVER_URL =
  "https://server-production-30ab.up.railway.app";
export const MAX_AGENT_ACCESS_SECONDS = 365 * 24 * 60 * 60;
export const MAX_AGENT_SESSION_SECONDS = 24 * 60 * 60;
export const MAX_CLIENT_CLOCK_SKEW_MILLISECONDS = 30_000;

const identityIdSchema = z.string().trim().min(1).max(256);
const identityStatusSchema = z.enum(["active", "disabled"]);

export const humanIdentitySchema = z
  .object({
    workspaceId: identityIdSchema,
    id: identityIdSchema,
    externalId: identityIdSchema,
    status: identityStatusSchema,
  })
  .strict();
export type HumanIdentity = z.infer<typeof humanIdentitySchema>;

export const agentIdentitySchema = z
  .object({
    workspaceId: identityIdSchema,
    id: identityIdSchema,
    name: z.string().trim().min(1).max(128),
    kind: z.enum(["independent", "managed"]),
    parentAgentId: identityIdSchema.nullable(),
    createdByHumanId: identityIdSchema.nullable(),
    status: identityStatusSchema,
  })
  .strict()
  .superRefine((agent, context) => {
    if (agent.kind === "independent" && agent.parentAgentId !== null) {
      context.addIssue({
        code: "custom",
        message: "Independent Agents cannot have a parent",
        path: ["parentAgentId"],
      });
    }
    if (agent.kind === "managed" && agent.parentAgentId === null) {
      context.addIssue({
        code: "custom",
        message: "Managed Agents require a parent",
        path: ["parentAgentId"],
      });
    }
    if (agent.parentAgentId === agent.id) {
      context.addIssue({
        code: "custom",
        message: "An Agent cannot be its own parent",
        path: ["parentAgentId"],
      });
    }
  });
export type AgentIdentity = z.infer<typeof agentIdentitySchema>;

export const agentSessionSchema = z
  .object({
    workspaceId: identityIdSchema,
    id: identityIdSchema,
    agentId: identityIdSchema,
    purpose: z.string().trim().min(1).max(280),
    status: z.enum(["active", "completed", "cancelled", "revoked", "expired"]),
    createdAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    predecessorSessionId: identityIdSchema.nullable(),
  })
  .strict()
  .superRefine((session, context) => {
    const createdAt = Date.parse(session.createdAt);
    const expiresAt = Date.parse(session.expiresAt);
    if (
      expiresAt <= createdAt ||
      expiresAt - createdAt > MAX_AGENT_SESSION_SECONDS * 1_000
    ) {
      context.addIssue({
        code: "custom",
        message: "Session expiry must be after creation and within 24 hours",
        path: ["expiresAt"],
      });
    }
    if (session.predecessorSessionId === session.id) {
      context.addIssue({
        code: "custom",
        message: "A Session cannot be its own predecessor",
        path: ["predecessorSessionId"],
      });
    }
  });
export type AgentSession = z.infer<typeof agentSessionSchema>;

export const capabilitySchema = z.enum([
  "process.exec",
  "process.shell",
  "fs.stat",
  "fs.list",
  "fs.search",
  "fs.read",
  "fs.write",
  "fs.mkdir",
  "fs.remove",
  "docker.logs",
]);
export type Capability = z.infer<typeof capabilitySchema>;

export const allCapabilities: Capability[] = [
  "process.exec",
  "process.shell",
  "fs.stat",
  "fs.list",
  "fs.search",
  "fs.read",
  "fs.write",
  "fs.mkdir",
  "fs.remove",
  "docker.logs",
];

export const resourceSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(63)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "Slug must contain lowercase letters, numbers, and single hyphens",
  );

export const organizationRequestSchema = z.object({
  slug: resourceSlugSchema,
  name: z.string().trim().min(1).max(128),
});
export type OrganizationRequest = z.infer<typeof organizationRequestSchema>;

export const workspaceRequestSchema = z.object({
  slug: resourceSlugSchema,
  name: z.string().trim().min(1).max(128),
});
export type WorkspaceRequest = z.infer<typeof workspaceRequestSchema>;

export const sessionRequestSchema = z.object({
  machineId: z.string().uuid(),
  profile: z.string().min(1).max(64).default("workspace"),
  ttlSeconds: z.number().int().min(10).max(3600).default(600),
  capabilities: z.array(capabilitySchema).min(1),
});
export type SessionRequest = z.infer<typeof sessionRequestSchema>;

export const agentTokenRequestSchema = z.object({
  name: z.string().trim().min(1).max(64),
  machineIds: z.array(z.string().uuid()).min(1).max(100),
  capabilities: z.array(capabilitySchema).min(1),
  expiresInSeconds: z.number().int().min(60).max(MAX_AGENT_ACCESS_SECONDS).default(60 * 60),
});
export type AgentTokenRequest = z.infer<typeof agentTokenRequestSchema>;

export const relativePathSchema = z
  .string()
  .max(4096)
  .refine((value) => !value.includes("\0"), "Path cannot contain NUL bytes")
  .refine((value) => !value.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(value), "Path must be relative")
  .refine(
    (value) => !value.replaceAll("\\", "/").split("/").includes(".."),
    "Parent traversal is not allowed",
  );

export function normalizeRelativePath(value: string): string {
  const segments = value
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");
  return segments.join("/") || ".";
}

export const sessionPathRestrictionSchema = z
  .object({
    path: relativePathSchema.transform(normalizeRelativePath),
    includeDescendants: z.boolean().default(false),
  })
  .strict();
export type SessionPathRestriction = z.infer<
  typeof sessionPathRestrictionSchema
>;

export const sessionProcessRuleSchema = z
  .object({
    program: z.string().trim().min(1).max(1024),
    args: z.array(z.string().max(16_384)).max(256),
    cwd: sessionPathRestrictionSchema,
  })
  .strict();
export type SessionProcessRule = z.infer<typeof sessionProcessRuleSchema>;

export const sessionRestrictionsSchema = z
  .object({
    filesystem: z
      .object({
        paths: z.array(sessionPathRestrictionSchema).min(1).max(100),
      })
      .strict()
      .optional(),
    process: z
      .object({
        programs: z.array(sessionProcessRuleSchema).min(1).max(100),
      })
      .strict()
      .optional(),
    docker: z
      .object({
        containers: z
          .array(
            z
              .string()
              .min(1)
              .max(128)
              .regex(
                /^[A-Za-z0-9][A-Za-z0-9_.-]*$/,
                "Invalid container name or ID",
              ),
          )
          .min(1)
          .max(100),
      })
      .strict()
      .optional(),
  })
  .strict();
export type SessionRestrictions = z.infer<typeof sessionRestrictionsSchema>;

const filesystemCapabilities = new Set<Capability>([
  "fs.stat",
  "fs.list",
  "fs.search",
  "fs.read",
  "fs.write",
  "fs.mkdir",
  "fs.remove",
]);

export const sessionMachineScopeSchema = z
  .object({
    machineId: z.string().uuid(),
    profile: z.string().min(1).max(64).default("workspace"),
    capabilities: z.array(capabilitySchema).min(1),
    restrictions: sessionRestrictionsSchema,
  })
  .strict()
  .superRefine((scope, context) => {
    if (
      scope.capabilities.some((capability) =>
        filesystemCapabilities.has(capability),
      ) &&
      scope.restrictions.filesystem === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Filesystem capabilities require path restrictions",
        path: ["restrictions", "filesystem"],
      });
    }
    if (
      scope.capabilities.includes("process.exec") &&
      scope.restrictions.process === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "process.exec requires structured program restrictions",
        path: ["restrictions", "process"],
      });
    }
    if (scope.capabilities.includes("process.shell")) {
      context.addIssue({
        code: "custom",
        message:
          "process.shell cannot be granted by a restricted Agent Session; use process.exec",
        path: ["capabilities"],
      });
    }
    if (
      scope.capabilities.includes("docker.logs") &&
      scope.restrictions.docker === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "docker.logs requires container restrictions",
        path: ["restrictions", "docker"],
      });
    }
  });
export type SessionMachineScope = z.infer<typeof sessionMachineScopeSchema>;

export const agentSessionRequestInputSchema = z
  .object({
    agentId: z.string().uuid(),
    agentName: z.string().trim().min(1).max(128),
    purpose: z.string().trim().min(1).max(280),
    scopes: z.array(sessionMachineScopeSchema).min(1).max(16),
    durationSeconds: z
      .number()
      .int()
      .min(60)
      .max(MAX_AGENT_SESSION_SECONDS),
  })
  .strict()
  .superRefine((request, context) => {
    const machineIds = request.scopes.map((scope) => scope.machineId);
    if (new Set(machineIds).size !== machineIds.length) {
      context.addIssue({
        code: "custom",
        message: "A Session can contain only one scope per machine",
        path: ["scopes"],
      });
    }
  });
export type AgentSessionRequestInput = z.infer<
  typeof agentSessionRequestInputSchema
>;

export type SessionScopeDecision =
  | { allowed: true }
  | {
      allowed: false;
      code:
        | "machine_scope_denied"
        | "capability_denied"
        | "path_scope_denied"
        | "program_scope_denied"
        | "container_scope_denied";
    };

export type SessionScopeSubsetDecision =
  | { allowed: true }
  | {
      allowed: false;
      code: "capability_widening" | "restriction_widening";
    };

function pathMatchesRestriction(
  value: string,
  restriction: SessionPathRestriction,
): boolean {
  const normalized = normalizeRelativePath(value);
  const root = normalizeRelativePath(restriction.path);
  if (normalized === root) return true;
  return (
    restriction.includeDescendants &&
    (root === "." || normalized.startsWith(`${root}/`))
  );
}

function pathRestrictionIsSubset(
  requested: SessionPathRestriction,
  ceiling: SessionPathRestriction,
): boolean {
  const requestedPath = normalizeRelativePath(requested.path);
  const ceilingPath = normalizeRelativePath(ceiling.path);
  if (requestedPath === ceilingPath) {
    return !requested.includeDescendants || ceiling.includeDescendants;
  }
  return (
    ceiling.includeDescendants &&
    (ceilingPath === "." || requestedPath.startsWith(`${ceilingPath}/`))
  );
}

export function sessionScopeSubsetDecision(
  requested: SessionMachineScope,
  ceiling: SessionMachineScope,
): SessionScopeSubsetDecision {
  if (
    requested.machineId !== ceiling.machineId ||
    requested.capabilities.some(
      (capability) => !ceiling.capabilities.includes(capability),
    )
  ) {
    return { allowed: false, code: "capability_widening" };
  }
  for (const path of requested.restrictions.filesystem?.paths ?? []) {
    if (
      !ceiling.restrictions.filesystem?.paths.some((allowed) =>
        pathRestrictionIsSubset(path, allowed),
      )
    ) {
      return { allowed: false, code: "restriction_widening" };
    }
  }
  for (const rule of requested.restrictions.process?.programs ?? []) {
    if (
      !ceiling.restrictions.process?.programs.some(
        (allowed) =>
          allowed.program === rule.program &&
          allowed.args.length === rule.args.length &&
          allowed.args.every(
            (argument, index) => argument === rule.args[index],
          ) &&
          pathRestrictionIsSubset(rule.cwd, allowed.cwd),
      )
    ) {
      return { allowed: false, code: "restriction_widening" };
    }
  }
  for (const container of requested.restrictions.docker?.containers ?? []) {
    if (!ceiling.restrictions.docker?.containers.includes(container)) {
      return { allowed: false, code: "restriction_widening" };
    }
  }
  return { allowed: true };
}

export function sessionScopeDecision(
  scope: SessionMachineScope,
  machineId: string,
  action: OperationAction,
): SessionScopeDecision {
  if (scope.machineId !== machineId) {
    return { allowed: false, code: "machine_scope_denied" };
  }
  if (!scope.capabilities.includes(capabilityForAction(action))) {
    return { allowed: false, code: "capability_denied" };
  }
  if ("path" in action && action.kind.startsWith("fs.")) {
    const allowed = scope.restrictions.filesystem?.paths.some((restriction) =>
      pathMatchesRestriction(action.path, restriction),
    );
    return allowed
      ? { allowed: true }
      : { allowed: false, code: "path_scope_denied" };
  }
  if (action.kind === "process.exec") {
    const allowed = scope.restrictions.process?.programs.some(
      (rule) =>
        rule.program === action.program &&
        rule.args.length === action.args.length &&
        rule.args.every((argument, index) => argument === action.args[index]) &&
        pathMatchesRestriction(action.cwd, rule.cwd),
    );
    return allowed
      ? { allowed: true }
      : { allowed: false, code: "program_scope_denied" };
  }
  if (action.kind === "docker.logs") {
    const allowed =
      scope.restrictions.docker?.containers.includes(action.container) ??
      false;
    return allowed
      ? { allowed: true }
      : { allowed: false, code: "container_scope_denied" };
  }
  return { allowed: false, code: "capability_denied" };
}

export const operationEnvironmentSchema = z.record(
  z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Invalid environment variable name"),
  z.string().max(65_536),
).superRefine((environment, context) => {
  const key = Object.keys(environment)[0];
  if (key !== undefined) {
    context.addIssue({
      code: "custom",
      path: [key],
      message:
        "Caller-supplied environment variables require an explicit Session policy and are not supported",
    });
  }
});

export const operationActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("process.exec"),
    program: z.string().min(1).max(1024),
    args: z.array(z.string().max(16_384)).max(256).default([]),
    cwd: relativePathSchema.default("."),
    env: operationEnvironmentSchema.default({}),
  }),
  z.object({
    kind: z.literal("process.shell"),
    command: z.string().min(1).max(65_536),
    cwd: relativePathSchema.default("."),
    env: operationEnvironmentSchema.default({}),
  }),
  z.object({ kind: z.literal("fs.stat"), path: relativePathSchema }),
  z.object({ kind: z.literal("fs.list"), path: relativePathSchema.default(".") }),
  z.object({
    kind: z.literal("fs.search"),
    path: relativePathSchema.default("."),
    query: z.string().min(1).max(256),
    maxResults: z.number().int().min(1).max(1_000).default(100),
  }),
  z.object({ kind: z.literal("fs.read"), path: relativePathSchema }),
  z.object({
    kind: z.literal("fs.write"),
    path: relativePathSchema,
    contentBase64: z.string(),
    createParents: z.boolean().default(false),
  }),
  z.object({ kind: z.literal("fs.mkdir"), path: relativePathSchema, recursive: z.boolean().default(true) }),
  z.object({ kind: z.literal("fs.remove"), path: relativePathSchema, recursive: z.boolean().default(false) }),
  z.object({
    kind: z.literal("docker.logs"),
    container: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, "Invalid container name or ID"),
    tail: z.number().int().min(1).max(10_000).default(200),
    timestamps: z.boolean().default(false),
  }),
]);
export type OperationAction = z.infer<typeof operationActionSchema>;

export const operationRequestSchema = z.object({
  action: operationActionSchema,
  timeoutSeconds: z.number().int().min(1).max(1800).default(120),
  maxOutputBytes: z.number().int().min(1024).max(16 * 1024 * 1024).default(1024 * 1024),
});
export type OperationRequest = z.infer<typeof operationRequestSchema>;

export type OperationStatus =
  | "queued"
  | "delivered"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "execution_unknown";

export type HostPlatform = "linux" | "macos" | "windows";

export type ClientRuntimeInfo = {
  hostPlatform: HostPlatform;
  architecture: string;
  nodeVersion: string;
  /** Additive runtime metadata used for compatibility diagnostics. */
  protocolVersion?: number;
  clientVersion?: string;
  supportedCapabilities?: Capability[];
  executionRunners?: Array<"host" | "docker">;
  containerEngine?: "docker";
  containerOs?: "linux";
  containerArchitecture?: string;
  containerEngineVersion?: string;
};

const profilePolicySchema = z.object({
  workspaceRoot: z.string().min(1).max(4096),
  maxSessionTtlSeconds: z.number().int().min(10).max(3600),
  maxConcurrentSessions: z.number().int().min(1).max(32),
  maxOutputBytes: z.number().int().min(1024).max(16 * 1024 * 1024),
  capabilities: z.array(capabilitySchema).min(1),
  restrictions: sessionRestrictionsSchema.optional(),
});

export const hostClientProfileSchema = profilePolicySchema.extend({
  runner: z.literal("host"),
});

export const dockerClientProfileSchema = profilePolicySchema.extend({
  runner: z.literal("docker"),
  image: z.string().min(1).max(512),
  network: z.literal("none"),
});

export const clientProfileSchema = z
  .discriminatedUnion("runner", [hostClientProfileSchema, dockerClientProfileSchema])
  .refine(
    (profile) =>
      profile.runner !== "docker" || !profile.capabilities.includes("docker.logs"),
    "docker.logs is only available through the host runner",
  );
export type ClientProfile = z.infer<typeof clientProfileSchema>;
export type HostClientProfile = z.infer<typeof hostClientProfileSchema>;
export type DockerClientProfile = z.infer<typeof dockerClientProfileSchema>;

export const clientConfigSchema = z.object({
  serverUrl: z.string().url(),
  workspaceId: z.string().min(1).max(128).optional(),
  profileName: z.string().min(1).max(40).optional(),
  machineId: z.string().uuid(),
  machineName: z.string().min(1).max(128),
  privateKeyPem: z.string().min(1),
  stateDirectory: z.string().min(1).max(4096),
  profiles: z
    .record(z.string().min(1).max(64), clientProfileSchema)
    .refine((profiles) => Object.keys(profiles).length > 0, "At least one profile is required"),
});
export type ClientConfig = z.infer<typeof clientConfigSchema>;

export type ServerToClientMessage =
  | { type: "challenge"; connectionId: string; nonce: string }
  | { type: "authenticated"; machineId: string }
  | {
      type: "error";
      code: "client_upgrade_required";
      message: string;
    }
  | { type: "ping"; pingId: string }
  | {
      type: "session.open";
      sessionId: string;
      profile: string;
      capabilities: Capability[];
      /** Required for canonical Agent Sessions; omitted only by legacy authority. */
      restrictions?: SessionRestrictions;
      expiresAt: string;
      serverTime?: string;
    }
  | { type: "session.close"; sessionId: string; reason: string }
  | {
      type: "operation.start";
      operationId: string;
      sessionId: string;
      action: OperationAction;
      timeoutSeconds: number;
      maxOutputBytes: number;
    }
  | { type: "operation.cancel"; operationId: string };

export type ClientToServerMessage =
  | {
      type: "authenticate";
      machineId: string;
      protocolVersion: number;
      signature: string;
      runtime?: ClientRuntimeInfo;
    }
  | { type: "heartbeat"; machineId: string; at: string }
  | { type: "pong"; machineId: string; pingId: string }
  | {
      type: "session.opened";
      sessionId: string;
      runner?: "host" | "docker";
      runtimeId?: string;
      /** @deprecated Kept for protocol v1 Docker clients. */
      containerId?: string;
    }
  | { type: "session.open_failed"; sessionId: string; error: string }
  | { type: "session.closed"; sessionId: string; reason: string }
  | { type: "operation.started"; operationId: string; at: string }
  | {
      type: "operation.event";
      operationId: string;
      sequence: number;
      stream: "stdout" | "stderr" | "result";
      dataBase64: string;
    }
  | {
      type: "operation.completed";
      operationId: string;
      status: Exclude<OperationStatus, "queued" | "delivered" | "running">;
      exitCode: number | null;
      error?: string;
      outputTruncated: boolean;
      at: string;
    };

export function capabilityForAction(action: OperationAction): Capability {
  return action.kind;
}

/**
 * Builds the narrowest Agent Session scope capable of executing one typed
 * operation. Free-form shell text is intentionally not translatable because
 * it cannot be bounded with structured program restrictions.
 */
export function operationSessionScope(
  machineId: string,
  action: OperationAction,
  profile = "workspace",
): SessionMachineScope {
  const capability = capabilityForAction(action);
  switch (action.kind) {
    case "process.exec":
      return {
        machineId,
        profile,
        capabilities: [capability],
        restrictions: {
          process: {
            programs: [{
              program: action.program,
              args: action.args,
              cwd: {
                path: normalizeRelativePath(action.cwd),
                includeDescendants: false,
              },
            }],
          },
        },
      };
    case "process.shell":
      throw new Error(
        "process.shell cannot be scoped safely; use process.exec with an explicit program and arguments",
      );
    case "fs.stat":
    case "fs.list":
    case "fs.search":
    case "fs.read":
    case "fs.write":
    case "fs.mkdir":
    case "fs.remove":
      return {
        machineId,
        profile,
        capabilities: [capability],
        restrictions: {
          filesystem: {
            paths: [{
              path: normalizeRelativePath(action.path),
              includeDescendants: false,
            }],
          },
        },
      };
    case "docker.logs":
      return {
        machineId,
        profile,
        capabilities: [capability],
        restrictions: {
          docker: { containers: [action.container] },
        },
      };
  }
}

export function parseClientMessage(raw: string): ClientToServerMessage {
  return JSON.parse(raw) as ClientToServerMessage;
}

export function parseServerMessage(raw: string): ServerToClientMessage {
  return JSON.parse(raw) as ServerToClientMessage;
}
