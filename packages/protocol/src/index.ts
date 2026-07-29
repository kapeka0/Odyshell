import { z } from "zod";

export const PROTOCOL_VERSION = 1;

export const capabilitySchema = z.enum([
  "process.exec",
  "process.shell",
  "fs.stat",
  "fs.list",
  "fs.read",
  "fs.write",
  "fs.mkdir",
  "fs.remove",
]);
export type Capability = z.infer<typeof capabilitySchema>;

export const allCapabilities: Capability[] = [
  "process.exec",
  "process.shell",
  "fs.stat",
  "fs.list",
  "fs.read",
  "fs.write",
  "fs.mkdir",
  "fs.remove",
];

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
  expiresInSeconds: z.number().int().min(60).max(30 * 24 * 60 * 60).default(24 * 60 * 60),
});
export type AgentTokenRequest = z.infer<typeof agentTokenRequestSchema>;

const relativePathSchema = z
  .string()
  .max(4096)
  .refine((value) => !value.includes("\0"), "Path cannot contain NUL bytes")
  .refine((value) => !value.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(value), "Path must be relative")
  .refine(
    (value) => !value.replaceAll("\\", "/").split("/").includes(".."),
    "Parent traversal is not allowed",
  );

export const operationActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("process.exec"),
    program: z.string().min(1).max(1024),
    args: z.array(z.string().max(16_384)).max(256).default([]),
    cwd: relativePathSchema.default("."),
    env: z.record(z.string(), z.string().max(65_536)).default({}),
  }),
  z.object({
    kind: z.literal("process.shell"),
    command: z.string().min(1).max(65_536),
    cwd: relativePathSchema.default("."),
    env: z.record(z.string(), z.string().max(65_536)).default({}),
  }),
  z.object({ kind: z.literal("fs.stat"), path: relativePathSchema }),
  z.object({ kind: z.literal("fs.list"), path: relativePathSchema.default(".") }),
  z.object({ kind: z.literal("fs.read"), path: relativePathSchema }),
  z.object({
    kind: z.literal("fs.write"),
    path: relativePathSchema,
    contentBase64: z.string(),
    createParents: z.boolean().default(false),
  }),
  z.object({ kind: z.literal("fs.mkdir"), path: relativePathSchema, recursive: z.boolean().default(true) }),
  z.object({ kind: z.literal("fs.remove"), path: relativePathSchema, recursive: z.boolean().default(false) }),
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
  containerEngine: "docker";
  containerOs: "linux";
  containerArchitecture: string;
  containerEngineVersion: string;
};

export type ClientProfile = {
  runner: "docker";
  workspaceRoot: string;
  image: string;
  network: "none" | "bridge";
  maxSessionTtlSeconds: number;
  maxConcurrentSessions: number;
  maxOutputBytes: number;
  capabilities: Capability[];
};

export type ClientConfig = {
  serverUrl: string;
  machineId: string;
  machineName: string;
  privateKeyPem: string;
  stateDirectory: string;
  profiles: Record<string, ClientProfile>;
};

export type ServerToClientMessage =
  | { type: "challenge"; connectionId: string; nonce: string }
  | { type: "authenticated"; machineId: string }
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
  | { type: "session.opened"; sessionId: string; containerId: string }
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
