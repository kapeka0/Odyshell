import { z } from "zod";

export const MAX_TASK_DURATION_SECONDS = 24 * 60 * 60;
export const DEFAULT_COMMAND_TIMEOUT_SECONDS = 10 * 60;
export const MAX_COMMAND_TIMEOUT_SECONDS = MAX_TASK_DURATION_SECONDS;
export const DEFAULT_COMMAND_OUTPUT_BYTES = 1024 * 1024;
export const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024 * 1024;

const idSchema = z.string().trim().min(1).max(256);
const uuidSchema = z.string().uuid();

export const taskStatusSchema = z.enum([
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
export type TaskStatus = z.infer<typeof taskStatusSchema>;

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

export const taskRequestSchema = z
  .object({
    machineId: uuidSchema,
    title: z.string().trim().min(1).max(96),
    purpose: z.string().trim().min(1).max(280).optional(),
    durationSeconds: z
      .number()
      .int()
      .min(60)
      .max(MAX_TASK_DURATION_SECONDS),
  })
  .strict();
export type TaskRequest = z.infer<typeof taskRequestSchema>;

export const taskSchema = z
  .object({
    id: uuidSchema,
    organizationId: idSchema,
    agentId: idSchema,
    machineId: uuidSchema,
    clientProfileId: idSchema,
    operatingSystemUser: z.string().trim().min(1).max(256),
    title: z.string().trim().min(1).max(96),
    purpose: z.string().trim().min(1).max(280).nullable(),
    status: taskStatusSchema,
    maxConcurrentCommands: z.number().int().min(1).max(16),
    createdAt: z.string().datetime({ offset: true }),
    readyAt: z.string().datetime({ offset: true }).nullable(),
    expiresAt: z.string().datetime({ offset: true }),
    finishedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict()
  .superRefine((task, context) => {
    const createdAt = Date.parse(task.createdAt);
    const readyAt = task.readyAt === null ? createdAt : Date.parse(task.readyAt);
    const expiresAt = Date.parse(task.expiresAt);
    if (
      readyAt < createdAt ||
      expiresAt <= readyAt ||
      expiresAt - readyAt > MAX_TASK_DURATION_SECONDS * 1_000
    ) {
      context.addIssue({
        code: "custom",
        message: "Task expiry must be after authority starts and within 24 hours",
        path: ["expiresAt"],
      });
    }
  });
export type Task = z.infer<typeof taskSchema>;

const absoluteLinuxPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes("\0"), "Working directory cannot contain NUL bytes")
  .refine((value) => value.startsWith("/"), "Working directory must be an absolute Linux path");

export const commandRequestSchema = z
  .object({
    command: z.string().min(1).max(65_536).refine(
      (value) => !value.includes("\0"),
      "Command cannot contain NUL bytes",
    ),
    cwd: absoluteLinuxPathSchema.optional(),
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
    taskId: uuidSchema,
    organizationId: idSchema,
    agentId: idSchema,
    machineId: uuidSchema,
    command: z.string().min(1).max(65_536),
    cwd: absoluteLinuxPathSchema.nullable(),
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
    agentIds: z.array(idSchema).max(256),
    maxTaskDurationSeconds: z
      .number()
      .int()
      .min(60)
      .max(MAX_TASK_DURATION_SECONDS),
    maxConcurrentTasks: z.number().int().min(1).max(32),
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

export const clientTaskProfileSchema = z
  .object({
    id: idSchema,
    operatingSystemUser: z.string().trim().min(1).max(256),
    localPolicy: localPolicySchema,
  })
  .strict();

export type LocalTaskDecision =
  | { allowed: true }
  | {
      allowed: false;
      code:
        | "organization_denied"
        | "agent_denied"
        | "duration_denied"
        | "task_concurrency_denied"
        | "command_concurrency_denied";
    };

export function localTaskDecision(
  policy: LocalPolicy,
  input: {
    organizationId: string;
    agentId: string;
    durationSeconds: number;
    activeTasks: number;
    maxConcurrentCommands: number;
  },
): LocalTaskDecision {
  if (input.organizationId !== policy.organizationId) {
    return { allowed: false, code: "organization_denied" };
  }
  if (!policy.agentIds.includes(input.agentId)) {
    return { allowed: false, code: "agent_denied" };
  }
  if (input.durationSeconds > policy.maxTaskDurationSeconds) {
    return { allowed: false, code: "duration_denied" };
  }
  if (input.activeTasks >= policy.maxConcurrentTasks) {
    return { allowed: false, code: "task_concurrency_denied" };
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
        | "task_not_active"
        | "task_expired"
        | "timeout_exceeds_task"
        | "timeout_exceeds_local_policy";
    };

export function commandDecision(
  task: Pick<Task, "status" | "expiresAt">,
  command: Pick<CommandRequest, "timeoutSeconds">,
  policy: Pick<LocalPolicy, "maxCommandTimeoutSeconds">,
  now = Date.now(),
): CommandDecision {
  if (task.status !== "active") {
    return { allowed: false, code: "task_not_active" };
  }
  const remainingSeconds = Math.floor((Date.parse(task.expiresAt) - now) / 1_000);
  if (remainingSeconds <= 0) {
    return { allowed: false, code: "task_expired" };
  }
  if (command.timeoutSeconds > policy.maxCommandTimeoutSeconds) {
    return { allowed: false, code: "timeout_exceeds_local_policy" };
  }
  if (command.timeoutSeconds > remainingSeconds) {
    return { allowed: false, code: "timeout_exceeds_task" };
  }
  return { allowed: true, timeoutSeconds: command.timeoutSeconds };
}

export type TaskServerToClientMessage =
  | {
      type: "task.open";
      taskId: string;
      organizationId: string;
      agentId: string;
      clientProfileId: string;
      expiresAt: string;
      maxConcurrentCommands: number;
      serverTime: string;
  }
  | { type: "task.close"; taskId: string; reason: string }
  | {
      type: "command.start";
      commandId: string;
      taskId: string;
      command: string;
      cwd?: string;
      timeoutSeconds: number;
      maxOutputBytes: number;
    }
  | { type: "command.cancel"; commandId: string }
  | { type: "command.acknowledged"; commandId: string };

export const taskServerToClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("task.open"),
    taskId: uuidSchema,
    organizationId: idSchema,
    agentId: idSchema,
    clientProfileId: idSchema,
    expiresAt: z.string().datetime({ offset: true }),
    maxConcurrentCommands: z.number().int().min(1).max(16),
    serverTime: z.string().datetime({ offset: true }),
  }).strict(),
  z.object({
    type: z.literal("task.close"),
    taskId: uuidSchema,
    reason: z.string().trim().min(1).max(256),
  }).strict(),
  z.object({
    type: z.literal("command.start"),
    commandId: uuidSchema,
    taskId: uuidSchema,
    command: z.string().min(1).max(65_536).refine(
      (value) => !value.includes("\0"),
      "Command cannot contain NUL bytes",
    ),
    cwd: absoluteLinuxPathSchema.optional(),
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

export type TaskClientToServerMessage =
  | {
      type: "task.opened";
      taskId: string;
      clientProfileId: string;
      operatingSystemUser: string;
    }
  | { type: "task.open_failed"; taskId: string; error: string }
  | { type: "task.closed"; taskId: string; reason: string }
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

export const taskClientToServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("task.opened"),
    taskId: uuidSchema,
    clientProfileId: idSchema,
    operatingSystemUser: z.string().trim().min(1).max(256),
  }).strict(),
  z.object({
    type: z.literal("task.open_failed"),
    taskId: uuidSchema,
    error: z.string().min(1).max(2048),
  }).strict(),
  z.object({
    type: z.literal("task.closed"),
    taskId: uuidSchema,
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
