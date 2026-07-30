import { z } from "zod";

export const PROTOCOL_VERSION = 1;
export const DEFAULT_CLOUD_SERVER_URL =
  "https://server-production-30ab.up.railway.app";
export const MAX_AGENT_ACCESS_SECONDS = 365 * 24 * 60 * 60;

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

export const operationEnvironmentSchema = z.record(
  z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Invalid environment variable name"),
  z.string().max(65_536),
);

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
  | { type: "ping"; pingId: string }
  | {
      type: "session.open";
      sessionId: string;
      profile: string;
      capabilities: Capability[];
      expiresAt: string;
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

export function parseClientMessage(raw: string): ClientToServerMessage {
  return JSON.parse(raw) as ClientToServerMessage;
}

export function parseServerMessage(raw: string): ServerToClientMessage {
  return JSON.parse(raw) as ServerToClientMessage;
}
