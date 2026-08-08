import { z } from "zod";
import {
  clientTaskProfileSchema,
  localPolicySchema,
  taskClientToServerMessageSchema,
} from "./task.js";
import type {
  TaskClientToServerMessage,
  TaskServerToClientMessage,
} from "./task.js";

export * from "./task.js";

export const PROTOCOL_VERSION = 4;
export const DEFAULT_CLOUD_SERVER_URL =
  "https://server.odyshell.com";
export const MAX_AGENT_ACCESS_SECONDS = 365 * 24 * 60 * 60;
export const MAX_AGENT_SESSION_SECONDS = 24 * 60 * 60;
export const MAX_CLIENT_CLOCK_SKEW_MILLISECONDS = 30_000;
export const DEFAULT_OPERATION_TIMEOUT_SECONDS = 600;
export const MAX_OPERATION_TIMEOUT_SECONDS = 24 * 60 * 60;
export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
export const MAX_HOST_SHELL_STDIN_BYTES = 1024 * 1024;
export const MAX_FILESYSTEM_WRITE_BYTES = 1024 * 1024;

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
    title: z.string().trim().min(1).max(96),
    purpose: z.string().trim().min(1).max(280).nullable().optional(),
    status: z.enum(["active", "completed", "cancelled", "revoked", "expired"]),
    createdAt: z.string().datetime({ offset: true }),
    readyAt: z.string().datetime({ offset: true }).nullable().optional(),
    expiresAt: z.string().datetime({ offset: true }),
    predecessorSessionId: identityIdSchema.nullable(),
  })
  .strict()
  .superRefine((session, context) => {
    const createdAt = Date.parse(session.createdAt);
    const readyAt = session.readyAt ? Date.parse(session.readyAt) : undefined;
    const expiresAt = Date.parse(session.expiresAt);
    const authorityStartedAt = readyAt ?? createdAt;
    if (
      (readyAt !== undefined && readyAt < createdAt) ||
      expiresAt <= authorityStartedAt ||
      expiresAt - authorityStartedAt > MAX_AGENT_SESSION_SECONDS * 1_000
    ) {
      context.addIssue({
        code: "custom",
        message: "Session expiry must be after authority starts and within 24 hours",
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
  "host.shell",
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
  "host.shell",
  "fs.stat",
  "fs.list",
  "fs.search",
  "fs.read",
  "fs.write",
  "fs.mkdir",
  "fs.remove",
  "docker.logs",
];

export const manualSessionReadOnlyCapabilities: readonly Capability[] = [
  "fs.stat",
  "fs.list",
  "fs.search",
  "fs.read",
];

export const manualSessionHostShellCapabilities: readonly Capability[] = [
  "host.shell",
];

export const manualSessionSelectableCapabilities: readonly Capability[] = [
  ...manualSessionReadOnlyCapabilities,
  ...manualSessionHostShellCapabilities,
  "fs.write",
  "fs.mkdir",
  "fs.remove",
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

const scopedPathSchema = z
  .string()
  .max(4096)
  .refine((value) => !value.includes("\0"), "Path cannot contain NUL bytes")
  .refine(
    (value) => !value.replaceAll("\\", "/").split("/").includes(".."),
    "Parent traversal is not allowed",
  );

export const filesystemPathSchema = scopedPathSchema
  .refine(
    (value) => !value.replaceAll("\\", "/").startsWith("//"),
    "Network paths are not allowed",
  )
  .describe(
    "Exact filesystem path. Relative paths resolve from the Client Home; local absolute paths require an exact approved Session scope.",
  );

export const hostShellWorkingDirectorySchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes("\0"), "Path cannot contain NUL bytes")
  .describe(
    "Working directory under broad Host Shell authority. Relative paths resolve from the Client Home; parent, absolute and network paths are allowed when accessible to the Client user. This value does not narrow Host Shell authority.",
  );

export const relativePathSchema = scopedPathSchema
  .refine(
    (value) =>
      !value.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(value),
    "Path must be relative",
  )
  .describe(
    "Path relative to the Client Home. Absolute paths and parent traversal are not allowed.",
  );

export function normalizeRelativePath(value: string): string {
  const segments = value
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");
  return segments.join("/") || ".";
}

export function normalizeOperationPath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  const drive = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (drive) {
    const path = normalizeRelativePath(drive[2] ?? "");
    return `${drive[1]!.toUpperCase()}:/${path === "." ? "" : path}`;
  }
  if (normalized.startsWith("/")) {
    const path = normalizeRelativePath(normalized.slice(1));
    return `/${path === "." ? "" : path}`;
  }
  return normalizeRelativePath(normalized);
}

function isAbsoluteOperationPath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:\//.test(value);
}

function pathIsInside(root: string, value: string): boolean {
  if (root === "/" || /^[A-Za-z]:\/$/.test(root)) {
    return value.startsWith(root);
  }
  return value.startsWith(`${root}/`);
}

export const sessionPathRestrictionSchema = z
  .object({
    path: filesystemPathSchema.transform(normalizeOperationPath),
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
    cwd: z
      .object({
        path: filesystemPathSchema.transform(normalizeOperationPath),
        includeDescendants: z.boolean().default(false),
      })
      .strict(),
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
      scope.capabilities.includes("process.exec") &&
      scope.restrictions.process === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "process.exec requires structured program restrictions",
        path: ["restrictions", "process"],
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
    title: z.string().trim().min(1).max(96),
    purpose: z.string().trim().min(1).max(280).optional(),
    predecessorSessionId: z.string().uuid().optional(),
    runId: z.string().trim().min(1).max(128).optional(),
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
    const requestsHostShell = request.scopes.some((scope) =>
      scope.capabilities.includes("host.shell")
    );
    if (requestsHostShell && request.runId === undefined) {
      context.addIssue({
        code: "custom",
        message: "Programmatic Host Shell Sessions require a Task Run identifier",
        path: ["runId"],
      });
    }
    if (requestsHostShell && request.durationSeconds > 3_600 && !request.purpose) {
      context.addIssue({
        code: "custom",
        message: "Host Shell tasks longer than one hour require a purpose",
        path: ["purpose"],
      });
    }
  });
export type AgentSessionRequestInput = z.infer<
  typeof agentSessionRequestInputSchema
>;

export type HostShellTaskRunAccessDecision =
  | { allowed: true }
  | {
      allowed: false;
      code: "task_run_id_required" | "task_run_id_mismatch";
    };

export function hostShellTaskRunAccessDecision(
  scopes: SessionMachineScope[],
  expectedRunId: string | undefined,
  providedRunId: string | undefined,
): HostShellTaskRunAccessDecision {
  if (
    !scopes.some((scope) => scope.capabilities.includes("host.shell")) ||
    expectedRunId === undefined
  ) {
    return { allowed: true };
  }
  if (!providedRunId?.trim()) {
    return { allowed: false, code: "task_run_id_required" };
  }
  return providedRunId.trim() === expectedRunId
    ? { allowed: true }
    : { allowed: false, code: "task_run_id_mismatch" };
}

export function hostShellTaskRunRenewalDecision(
  scopes: SessionMachineScope[],
  expectedRunId: string | undefined,
  providedRunId: string | undefined,
): HostShellTaskRunAccessDecision {
  if (!scopes.some((scope) => scope.capabilities.includes("host.shell"))) {
    return { allowed: true };
  }
  if (expectedRunId === undefined) {
    return { allowed: false, code: "task_run_id_required" };
  }
  return hostShellTaskRunAccessDecision(scopes, expectedRunId, providedRunId);
}

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
      code:
        | "profile_mismatch"
        | "capability_widening"
        | "restriction_widening";
    };

function pathMatchesRestriction(
  value: string,
  restriction: SessionPathRestriction,
): boolean {
  const normalized = normalizeOperationPath(value);
  const root = normalizeOperationPath(restriction.path);
  if (normalized === root) return true;
  if (isAbsoluteOperationPath(normalized) !== isAbsoluteOperationPath(root)) {
    return false;
  }
  return (
    restriction.includeDescendants &&
    (root === "." || pathIsInside(root, normalized))
  );
}

function pathRestrictionIsSubset(
  requested: SessionPathRestriction,
  ceiling: SessionPathRestriction,
): boolean {
  const requestedPath = normalizeOperationPath(requested.path);
  const ceilingPath = normalizeOperationPath(ceiling.path);
  if (requestedPath === ceilingPath) {
    return !requested.includeDescendants || ceiling.includeDescendants;
  }
  if (
    isAbsoluteOperationPath(requestedPath) !==
    isAbsoluteOperationPath(ceilingPath)
  ) {
    return false;
  }
  return (
    ceiling.includeDescendants &&
    (ceilingPath === "." || pathIsInside(ceilingPath, requestedPath))
  );
}

export function sessionScopeSubsetDecision(
  requested: SessionMachineScope,
  ceiling: SessionMachineScope,
): SessionScopeSubsetDecision {
  if (requested.profile !== ceiling.profile) {
    return { allowed: false, code: "profile_mismatch" };
  }
  if (
    requested.machineId !== ceiling.machineId ||
    requested.capabilities.some(
      (capability) => !ceiling.capabilities.includes(capability),
    )
  ) {
    return { allowed: false, code: "capability_widening" };
  }
  const requestedFilesystem = requested.restrictions.filesystem;
  const ceilingFilesystem = ceiling.restrictions.filesystem;
  if (
    requested.capabilities.some((capability) =>
      filesystemCapabilities.has(capability),
    ) &&
    requestedFilesystem === undefined &&
    ceilingFilesystem !== undefined
  ) {
    return { allowed: false, code: "restriction_widening" };
  }
  if (requestedFilesystem && ceilingFilesystem) {
    for (const path of requestedFilesystem.paths) {
      if (
        !ceilingFilesystem.paths.some((allowed) =>
          pathRestrictionIsSubset(path, allowed),
        )
      ) {
        return { allowed: false, code: "restriction_widening" };
      }
    }
  }
  const requestedProcess = requested.restrictions.process;
  const ceilingProcess = ceiling.restrictions.process;
  if (
    requested.capabilities.includes("process.exec") &&
    requestedProcess === undefined &&
    ceilingProcess !== undefined
  ) {
    return { allowed: false, code: "restriction_widening" };
  }
  if (requestedProcess && ceilingProcess) {
    for (const rule of requestedProcess.programs) {
      if (
        !ceilingProcess.programs.some(
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
  }
  const requestedDocker = requested.restrictions.docker;
  const ceilingDocker = ceiling.restrictions.docker;
  if (
    requested.capabilities.includes("docker.logs") &&
    requestedDocker === undefined &&
    ceilingDocker !== undefined
  ) {
    return { allowed: false, code: "restriction_widening" };
  }
  if (requestedDocker && ceilingDocker) {
    for (const container of requestedDocker.containers) {
      if (!ceilingDocker.containers.includes(container)) {
        return { allowed: false, code: "restriction_widening" };
      }
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
    if (scope.restrictions.filesystem === undefined) {
      return { allowed: true };
    }
    const allowed = scope.restrictions.filesystem.paths.some((restriction) =>
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
  if (action.kind === "host.shell") {
    return { allowed: true };
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

const hostShellEnvironmentSchema = z.record(
  z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Invalid environment variable name"),
  z.string().max(65_536),
);

const maximumHostShellStdinBase64Length =
  4 * Math.ceil(MAX_HOST_SHELL_STDIN_BYTES / 3);
const standardBase64Pattern =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const hostShellStdinBase64Schema = z
  .string()
  .max(maximumHostShellStdinBase64Length)
  .superRefine((value, context) => {
    if (!standardBase64Pattern.test(value)) {
      context.addIssue({
        code: "custom",
        message: "stdinBase64 must be valid standard base64",
      });
      return;
    }
    const paddingBytes = value.endsWith("==")
      ? 2
      : value.endsWith("=")
        ? 1
        : 0;
    const decodedBytes = (value.length / 4) * 3 - paddingBytes;
    if (decodedBytes > MAX_HOST_SHELL_STDIN_BYTES) {
      context.addIssue({
        code: "too_big",
        maximum: MAX_HOST_SHELL_STDIN_BYTES,
        origin: "string",
        inclusive: true,
        message: "Decoded stdinBase64 exceeds 1 MiB",
      });
    }
  });

const maximumFilesystemWriteBase64Length =
  4 * Math.ceil(MAX_FILESYSTEM_WRITE_BYTES / 3);
const filesystemWriteContentBase64Schema = z
  .string()
  .max(maximumFilesystemWriteBase64Length)
  .superRefine((value, context) => {
    if (!standardBase64Pattern.test(value)) {
      context.addIssue({
        code: "custom",
        message: "contentBase64 must be valid standard base64",
      });
      return;
    }
    const paddingBytes = value.endsWith("==")
      ? 2
      : value.endsWith("=")
        ? 1
        : 0;
    const decodedBytes = (value.length / 4) * 3 - paddingBytes;
    if (decodedBytes > MAX_FILESYSTEM_WRITE_BYTES) {
      context.addIssue({
        code: "too_big",
        maximum: MAX_FILESYSTEM_WRITE_BYTES,
        origin: "string",
        inclusive: true,
        message: "Decoded contentBase64 exceeds 1 MiB",
      });
    }
  });

const processExecOperationActionSchema = z
  .object({
    kind: z.literal("process.exec"),
    program: z
      .string()
      .min(1)
      .max(1024)
      .describe("Exact executable to authorize and run."),
    args: z
      .array(z.string().max(16_384))
      .max(256)
      .default([])
      .describe("Exact argument array to authorize and run."),
    cwd: filesystemPathSchema.transform(normalizeOperationPath).default("."),
  })
  .strict()
  .describe(
    "Run one exact executable. Use this for an explicitly approved host path outside the Client Home; do not use a shell command.",
  );

const hostShellOperationActionSchema = z.object({
  kind: z.literal("host.shell"),
  command: z.string().min(1).max(65_536),
  cwd: hostShellWorkingDirectorySchema.default("."),
  env: hostShellEnvironmentSchema.default({}),
  stdinBase64: hostShellStdinBase64Schema.optional(),
});

const scopedOperationActionSchemas = [
  processExecOperationActionSchema,
  z.object({ kind: z.literal("fs.stat"), path: filesystemPathSchema }),
  z.object({ kind: z.literal("fs.list"), path: filesystemPathSchema.default(".") }),
  z.object({
    kind: z.literal("fs.search"),
    path: filesystemPathSchema.default("."),
    query: z.string().min(1).max(256),
    maxResults: z.number().int().min(1).max(1_000).default(100),
  }),
  z.object({ kind: z.literal("fs.read"), path: filesystemPathSchema }),
  z.object({
    kind: z.literal("fs.write"),
    path: filesystemPathSchema,
    contentBase64: filesystemWriteContentBase64Schema,
    createParents: z.boolean().default(false),
  }),
  z.object({ kind: z.literal("fs.mkdir"), path: filesystemPathSchema, recursive: z.boolean().default(true) }),
  z.object({
    kind: z.literal("fs.remove"),
    path: filesystemPathSchema,
    recursive: z.literal(false).default(false),
  }),
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
] as const;

export const scopedOperationActionSchema = z.discriminatedUnion(
  "kind",
  scopedOperationActionSchemas,
);
export type ScopedOperationAction = z.infer<
  typeof scopedOperationActionSchema
>;

const sessionOperationActionSchemas = [
  ...scopedOperationActionSchemas,
  hostShellOperationActionSchema,
] as const;

export const sessionOperationActionSchema = z.discriminatedUnion(
  "kind",
  sessionOperationActionSchemas,
);
export type SessionOperationAction = z.infer<
  typeof sessionOperationActionSchema
>;

export const operationActionSchema = z.discriminatedUnion("kind", [
  ...sessionOperationActionSchemas,
]);
export type OperationAction = z.infer<typeof operationActionSchema>;

export const operationRequestSchema = z.object({
  action: operationActionSchema,
  timeoutSeconds: z
    .number()
    .int()
    .min(1)
    .max(MAX_OPERATION_TIMEOUT_SECONDS)
    .default(DEFAULT_OPERATION_TIMEOUT_SECONDS),
  maxOutputBytes: z
    .number()
    .int()
    .min(1024)
    .max(16 * 1024 * 1024)
    .default(DEFAULT_MAX_OUTPUT_BYTES),
});
export type OperationRequest = z.infer<typeof operationRequestSchema>;

export type OperationStatus =
  | "queued"
  | "delivered"
  | "running"
  | "cancellation_requested"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "execution_unknown";

export type HostPlatform = "linux" | "macos" | "windows";

export type ClientRuntimeInfo = {
  hostPlatform: HostPlatform;
  architecture: string;
  defaultShell: string;
  privilegeEscalation?: "none" | "sudo";
  nodeVersion: string;
  /** Additive runtime metadata used for compatibility diagnostics. */
  protocolVersion?: number;
  clientVersion?: string;
};

export const clientConfigSchema = z.object({
  serverUrl: z.string().url(),
  profileName: z.string().min(1).max(40).optional(),
  machineId: z.string().uuid(),
  machineName: z.string().min(1).max(128),
  privateKeyPem: z.string().min(1),
  stateDirectory: z.string().min(1).max(4096),
  taskProfile: z
    .object({
      id: z.string().trim().min(1).max(256),
      localPolicy: localPolicySchema,
    })
    .strict(),
}).strict();
export type ClientConfig = z.infer<typeof clientConfigSchema>;

export type ServerToClientMessage =
  | TaskServerToClientMessage
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
  | {
      type: "session.expires";
      sessionId: string;
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
  | { type: "operation.acknowledged"; operationId: string }
  | { type: "operation.cancel"; operationId: string };

export type ClientToServerMessage =
  | TaskClientToServerMessage
  | {
      type: "authenticate";
      machineId: string;
      protocolVersion: number;
      signature: string;
      runtime?: ClientRuntimeInfo;
      taskProfile?: {
        id: string;
        operatingSystemUser: string;
        localPolicy: import("./task.js").LocalPolicy;
      };
    }
  | { type: "heartbeat"; machineId: string; at: string }
  | { type: "pong"; machineId: string; pingId: string }
  | {
      type: "session.opened";
      sessionId: string;
      runner: "host";
      runtimeId: string;
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
      status: Exclude<
        OperationStatus,
        "queued" | "delivered" | "running" | "cancellation_requested"
      >;
      exitCode: number | null;
      error?: string;
      outputTruncated: boolean;
      at: string;
    };

export function capabilityForAction(action: OperationAction): Capability {
  return action.kind;
}

/**
 * Builds the narrowest Agent Session scope capable of executing one
 * structured operation. Host Shell authority must be requested explicitly
 * without anticipating command text.
 */
export function operationSessionScope(
  machineId: string,
  action: ScopedOperationAction,
  profile = "workspace",
): SessionMachineScope {
  if ((action as OperationAction).kind === "host.shell") {
    throw new Error(
      "Request Host Shell authority explicitly instead of deriving it from command text.",
    );
  }
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
                path: normalizeOperationPath(action.cwd),
                includeDescendants: false,
              },
            }],
          },
        },
      };
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
              path: normalizeOperationPath(action.path),
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

/**
 * Builds one least-privilege scope per machine for a group of typed
 * operations. This lets an agent request a coherent task (for example search
 * then read) without broadening any individual path, process, or container
 * restriction.
 */
export function operationSessionScopes(
  operations: Array<{
    machineId: string;
    action: ScopedOperationAction;
    profile?: string;
  }>,
): SessionMachineScope[] {
  return mergeSessionMachineScopes(
    operations.map((operation) =>
      operationSessionScope(
        operation.machineId,
        operation.action,
        operation.profile ?? "workspace",
      ),
    ),
  );
}

/**
 * Combines already-valid Session scopes while rejecting any merge that would
 * create new capability/restriction combinations. This is useful when linked
 * escalation inherits a predecessor Session and adds one explicit capability.
 */
export function mergeSessionMachineScopes(
  scopes: SessionMachineScope[],
): SessionMachineScope[] {
  const grouped = new Map<string, SessionMachineScope[]>();
  for (const input of scopes) {
    const scope = sessionMachineScopeSchema.parse(input);
    const existing = grouped.get(scope.machineId) ?? [];
    if (
      existing.length > 0 &&
      existing.some((candidate) => candidate.profile !== scope.profile)
    ) {
      throw new Error("A machine cannot use multiple profiles in one Session");
    }
    existing.push(scope);
    grouped.set(scope.machineId, existing);
  }

  return [...grouped.values()].map((machineScopes) => {
    const first = machineScopes[0]!;
    const capabilities = unique(
      machineScopes.flatMap((scope) => scope.capabilities),
    );
    const mergedFilesystemCapabilities = capabilities.filter((capability) =>
      filesystemCapabilities.has(capability),
    );
    const filesystemScopes = machineScopes.filter((scope) =>
      scope.capabilities.some((capability) =>
        filesystemCapabilities.has(capability),
      ),
    );
    const filesystemIsUnrestricted = filesystemScopes.some(
      (scope) => scope.restrictions.filesystem === undefined,
    );
    const filesystemPaths = filesystemIsUnrestricted
      ? []
      : uniqueObjects(
          filesystemScopes.flatMap(
            (scope) => scope.restrictions.filesystem?.paths ?? [],
          ),
        );

    for (const capability of mergedFilesystemCapabilities) {
      if (filesystemIsUnrestricted) {
        const capabilityWasUnrestricted = filesystemScopes.some(
          (scope) =>
            scope.capabilities.includes(capability) &&
            scope.restrictions.filesystem === undefined,
        );
        if (!capabilityWasUnrestricted) {
          throwFilesystemMergeWidening();
        }
        continue;
      }
      for (const path of filesystemPaths) {
        const combinationWasAuthorized = filesystemScopes.some(
          (scope) =>
            scope.capabilities.includes(capability) &&
            (scope.restrictions.filesystem === undefined ||
              scope.restrictions.filesystem.paths.some((allowed) =>
                pathRestrictionIsSubset(path, allowed),
              )),
        );
        if (!combinationWasAuthorized) {
          throwFilesystemMergeWidening();
        }
      }
    }

    const processPrograms = uniqueObjects(
      machineScopes
        .filter((scope) => scope.capabilities.includes("process.exec"))
        .flatMap((scope) => scope.restrictions.process?.programs ?? []),
    );
    const dockerContainers = unique(
      machineScopes
        .filter((scope) => scope.capabilities.includes("docker.logs"))
        .flatMap((scope) => scope.restrictions.docker?.containers ?? []),
    );

    return sessionMachineScopeSchema.parse({
      machineId: first.machineId,
      profile: first.profile,
      capabilities,
      restrictions: {
        ...(!filesystemIsUnrestricted && filesystemPaths.length > 0
          ? { filesystem: { paths: filesystemPaths } }
          : {}),
        ...(processPrograms.length > 0
          ? { process: { programs: processPrograms } }
          : {}),
        ...(dockerContainers.length > 0
          ? { docker: { containers: dockerContainers } }
          : {}),
      },
    });
  });
}

function throwFilesystemMergeWidening(): never {
  throw new Error(
    "Different filesystem capabilities cannot be merged when that would widen filesystem authority",
  );
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function uniqueObjects<T>(values: T[]): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = JSON.stringify(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function parseClientMessage(raw: string): ClientToServerMessage {
  const message = JSON.parse(raw) as { type?: unknown };
  if (
    typeof message.type === "string" &&
    (message.type.startsWith("task.") || message.type.startsWith("command."))
  ) {
    return taskClientToServerMessageSchema.parse(message) as TaskClientToServerMessage;
  }
  if (message.type === "authenticate" && "taskProfile" in message) {
    clientTaskProfileSchema.parse(message.taskProfile);
  }
  return message as ClientToServerMessage;
}

export function parseServerMessage(raw: string): ServerToClientMessage {
  return JSON.parse(raw) as ServerToClientMessage;
}
