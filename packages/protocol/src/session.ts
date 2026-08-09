import { z } from "zod";

export const MAX_SESSION_DURATION_SECONDS = 24 * 60 * 60;
export const SESSION_DURATION_SECONDS = [
  15 * 60,
  60 * 60,
  2 * 60 * 60,
  6 * 60 * 60,
  8 * 60 * 60,
  24 * 60 * 60,
] as const;
export const DEFAULT_COMMAND_TIMEOUT_SECONDS = 10 * 60;
export const MAX_COMMAND_TIMEOUT_SECONDS = MAX_SESSION_DURATION_SECONDS;
export const DEFAULT_COMMAND_OUTPUT_BYTES = 1024 * 1024;
export const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024 * 1024;

const idSchema = z.string().trim().min(1).max(256);
const uuidSchema = z.string().uuid();

export const sessionStatusSchema = z.enum([
  "pending_approval",
  "opening",
  "active",
  "completed",
  "cancellation_requested",
  "cancelled",
  "revoked",
  "expired",
  "failed",
]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const commandStatusSchema = z.enum([
  "queued",
  "delivered",
  "running",
  "cancellation_requested",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "execution_unknown",
]);
export type CommandStatus = z.infer<typeof commandStatusSchema>;

export const sessionRequestSchema = z
  .object({
    machineId: uuidSchema,
    title: z.string().trim().min(1).max(96),
    purpose: z.string().trim().min(1).max(280).optional(),
    durationSeconds: z.union([
      z.literal(SESSION_DURATION_SECONDS[0]),
      z.literal(SESSION_DURATION_SECONDS[1]),
      z.literal(SESSION_DURATION_SECONDS[2]),
      z.literal(SESSION_DURATION_SECONDS[3]),
      z.literal(SESSION_DURATION_SECONDS[4]),
      z.literal(SESSION_DURATION_SECONDS[5]),
    ]),
  })
  .strict();
export type SessionRequest = z.infer<typeof sessionRequestSchema>;

export const sessionSchema = z
  .object({
    id: uuidSchema,
    organizationId: idSchema,
    agentId: idSchema,
    machineId: uuidSchema,
    clientProfileId: idSchema,
    operatingSystemUser: z.string().trim().min(1).max(256),
    title: z.string().trim().min(1).max(96),
    purpose: z.string().trim().min(1).max(280).nullable(),
    status: sessionStatusSchema,
    maxConcurrentCommands: z.number().int().min(1).max(16),
    createdAt: z.string().datetime({ offset: true }),
    readyAt: z.string().datetime({ offset: true }).nullable(),
    expiresAt: z.string().datetime({ offset: true }),
    finishedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict()
  .superRefine((session, context) => {
    const createdAt = Date.parse(session.createdAt);
    const readyAt = session.readyAt === null ? createdAt : Date.parse(session.readyAt);
    const expiresAt = Date.parse(session.expiresAt);
    if (
      readyAt < createdAt ||
      expiresAt <= readyAt ||
      expiresAt - readyAt > MAX_SESSION_DURATION_SECONDS * 1_000
    ) {
      context.addIssue({
        code: "custom",
        message: "Session expiry must be after authority starts and within 24 hours",
        path: ["expiresAt"],
      });
    }
  });
export type Session = z.infer<typeof sessionSchema>;

const absoluteHostPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes("\0"), "Working directory cannot contain NUL bytes")
  .refine(
    (value) => value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\[^\\]+\\[^\\]+/u.test(value),
    "Working directory must be an absolute host path",
  );

export const commandRequestSchema = z
  .object({
    command: z.string().min(1).max(65_536).refine(
      (value) => !value.includes("\0"),
      "Command cannot contain NUL bytes",
    ),
    cwd: absoluteHostPathSchema.optional(),
    timeoutSeconds: z
      .number()
      .int()
      .min(1)
      .max(MAX_COMMAND_TIMEOUT_SECONDS)
      .default(DEFAULT_COMMAND_TIMEOUT_SECONDS),
  })
  .strict();
export type CommandRequest = z.infer<typeof commandRequestSchema>;

export const commandSchema = z
  .object({
    id: uuidSchema,
    sessionId: uuidSchema,
    organizationId: idSchema,
    agentId: idSchema,
    machineId: uuidSchema,
    command: z.string().min(1).max(65_536),
    cwd: absoluteHostPathSchema.nullable(),
    timeoutSeconds: z.number().int().min(1).max(MAX_COMMAND_TIMEOUT_SECONDS),
    status: commandStatusSchema,
    createdAt: z.string().datetime({ offset: true }),
    startedAt: z.string().datetime({ offset: true }).nullable(),
    finishedAt: z.string().datetime({ offset: true }).nullable(),
    exitCode: z.number().int().nullable(),
    outputTruncated: z.boolean(),
    stdoutBytes: z.number().int().nonnegative(),
    stderrBytes: z.number().int().nonnegative(),
    error: z.string().max(2048).nullable(),
  })
  .strict();
export type Command = z.infer<typeof commandSchema>;

export const localPolicySchema = z
  .object({
    organizationId: idSchema,
    maxSessionDurationSeconds: z
      .number()
      .int()
      .min(60)
      .max(MAX_SESSION_DURATION_SECONDS),
    maxConcurrentSessions: z.number().int().min(1).max(32),
    maxConcurrentCommands: z.number().int().min(1).max(16),
    maxCommandTimeoutSeconds: z
      .number()
      .int()
      .min(1)
      .max(MAX_COMMAND_TIMEOUT_SECONDS),
    maxCommandOutputBytes: z
      .number()
      .int()
      .min(1024)
      .max(MAX_COMMAND_OUTPUT_BYTES),
    allowRemoteApproval: z.boolean(),
  })
  .strict();
export type LocalPolicy = z.infer<typeof localPolicySchema>;

export const clientSessionProfileSchema = z
  .object({
    id: idSchema,
    operatingSystemUser: z.string().trim().min(1).max(256),
    localPolicy: localPolicySchema,
  })
  .strict();

export type LocalSessionDecision =
  | { allowed: true }
  | {
      allowed: false;
      code:
        | "organization_denied"
        | "duration_denied"
        | "session_concurrency_denied"
        | "command_concurrency_denied";
    };

export function localSessionDecision(
  policy: LocalPolicy,
  input: {
    organizationId: string;
    durationSeconds: number;
    activeSessions: number;
    maxConcurrentCommands: number;
  },
): LocalSessionDecision {
  if (input.organizationId !== policy.organizationId) {
    return { allowed: false, code: "organization_denied" };
  }
  if (input.durationSeconds > policy.maxSessionDurationSeconds) {
    return { allowed: false, code: "duration_denied" };
  }
  if (input.activeSessions >= policy.maxConcurrentSessions) {
    return { allowed: false, code: "session_concurrency_denied" };
  }
  if (input.maxConcurrentCommands > policy.maxConcurrentCommands) {
    return { allowed: false, code: "command_concurrency_denied" };
  }
  return { allowed: true };
}

export type CommandDecision =
  | { allowed: true; timeoutSeconds: number }
  | {
      allowed: false;
      code:
        | "session_not_active"
        | "session_expired"
        | "timeout_exceeds_session"
        | "timeout_exceeds_local_policy";
    };

export function commandDecision(
  session: Pick<Session, "status" | "expiresAt">,
  command: Pick<CommandRequest, "timeoutSeconds">,
  policy: Pick<LocalPolicy, "maxCommandTimeoutSeconds">,
  now = Date.now(),
): CommandDecision {
  if (session.status !== "active") {
    return { allowed: false, code: "session_not_active" };
  }
  const remainingSeconds = Math.floor((Date.parse(session.expiresAt) - now) / 1_000);
  if (remainingSeconds <= 0) {
    return { allowed: false, code: "session_expired" };
  }
  if (command.timeoutSeconds > policy.maxCommandTimeoutSeconds) {
    return { allowed: false, code: "timeout_exceeds_local_policy" };
  }
  if (command.timeoutSeconds > remainingSeconds) {
    return { allowed: false, code: "timeout_exceeds_session" };
  }
  return { allowed: true, timeoutSeconds: command.timeoutSeconds };
}

export type SessionServerToClientMessage =
  | {
      type: "session.open";
      sessionId: string;
      organizationId: string;
      agentId: string;
      clientProfileId: string;
      expiresAt: string;
      maxConcurrentCommands: number;
      serverTime: string;
  }
  | { type: "session.close"; sessionId: string; reason: string }
  | {
      type: "command.start";
      commandId: string;
      sessionId: string;
      command: string;
      cwd?: string;
      timeoutSeconds: number;
      maxOutputBytes: number;
    }
  | { type: "command.cancel"; commandId: string }
  | { type: "command.acknowledged"; commandId: string };

export const sessionServerToClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session.open"),
    sessionId: uuidSchema,
    organizationId: idSchema,
    agentId: idSchema,
    clientProfileId: idSchema,
    expiresAt: z.string().datetime({ offset: true }),
    maxConcurrentCommands: z.number().int().min(1).max(16),
    serverTime: z.string().datetime({ offset: true }),
  }).strict(),
  z.object({
    type: z.literal("session.close"),
    sessionId: uuidSchema,
    reason: z.string().trim().min(1).max(256),
  }).strict(),
  z.object({
    type: z.literal("command.start"),
    commandId: uuidSchema,
    sessionId: uuidSchema,
    command: z.string().min(1).max(65_536).refine(
      (value) => !value.includes("\0"),
      "Command cannot contain NUL bytes",
    ),
    cwd: absoluteHostPathSchema.optional(),
    timeoutSeconds: z.number().int().min(1).max(MAX_COMMAND_TIMEOUT_SECONDS),
    maxOutputBytes: z.number().int().min(1024).max(MAX_COMMAND_OUTPUT_BYTES),
  }).strict(),
  z.object({
    type: z.literal("command.cancel"),
    commandId: uuidSchema,
  }).strict(),
  z.object({
    type: z.literal("command.acknowledged"),
    commandId: uuidSchema,
  }).strict(),
]);

export type SessionClientToServerMessage =
  | {
      type: "session.opened";
      sessionId: string;
      clientProfileId: string;
      operatingSystemUser: string;
    }
  | { type: "session.open_failed"; sessionId: string; error: string }
  | { type: "session.closed"; sessionId: string; reason: string }
  | { type: "command.started"; commandId: string; at: string }
  | {
      type: "command.output";
      commandId: string;
      sequence: number;
      stream: "stdout" | "stderr";
      dataBase64: string;
    }
  | {
      type: "command.completed";
      commandId: string;
      status: Exclude<
        CommandStatus,
        "queued" | "delivered" | "running" | "cancellation_requested"
      >;
      exitCode: number | null;
      error?: string;
      outputTruncated: boolean;
      at: string;
    };

export const sessionClientToServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session.opened"),
    sessionId: uuidSchema,
    clientProfileId: idSchema,
    operatingSystemUser: z.string().trim().min(1).max(256),
  }).strict(),
  z.object({
    type: z.literal("session.open_failed"),
    sessionId: uuidSchema,
    error: z.string().min(1).max(2048),
  }).strict(),
  z.object({
    type: z.literal("session.closed"),
    sessionId: uuidSchema,
    reason: z.string().trim().min(1).max(256),
  }).strict(),
  z.object({
    type: z.literal("command.started"),
    commandId: uuidSchema,
    at: z.string().datetime({ offset: true }),
  }).strict(),
  z.object({
    type: z.literal("command.output"),
    commandId: uuidSchema,
    sequence: z.number().int().min(0).max(1_000_000),
    stream: z.enum(["stdout", "stderr"]),
    dataBase64: z.string().max(4 * Math.ceil((256 * 1024) / 3)),
  }).strict(),
  z.object({
    type: z.literal("command.completed"),
    commandId: uuidSchema,
    status: commandStatusSchema.exclude([
      "queued",
      "delivered",
      "running",
      "cancellation_requested",
    ]),
    exitCode: z.number().int().nullable(),
    error: z.string().max(2048).optional(),
    outputTruncated: z.boolean(),
    at: z.string().datetime({ offset: true }),
  }).strict(),
]);
